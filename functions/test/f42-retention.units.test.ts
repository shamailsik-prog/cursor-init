import { spawnSync } from "node:child_process"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import shippedPolicy from "@/infra/retention/policy.json"
import { decide } from "@/platform/p5/permissionDecision"
import { isTombstoneFor, matterKeyOfRow } from "@/platform/retention/tombstone"
import { isComplete } from "../src/retention/acks"
import {
  RetentionConfigError,
  holdRefusal,
  inventory,
  planDeletion,
  policyHolds,
  retentionTestSeam,
  storeKey,
  treatmentOf,
  validatePolicy,
  type InventoryStore,
  type RetentionPolicy,
} from "../src/retention/config"
import type { Transaction } from "firebase-admin/firestore"
import { JobError } from "../src/p2/errors"
import { capturesFor, exportedIds, readLateIds, stageLateIds } from "../src/retention/lateTraces"
import { purgeGroups, sagaInternals } from "../src/retention/saga"

/** Audit F42: the pure parts of the retention mechanism (no emulator). */

const shipped = () => structuredClone(shippedPolicy) as unknown as RetentionPolicy

function purgePolicy(): RetentionPolicy {
  const p = shipped()
  for (const c of Object.values(p.classes)) c.legalHold = false
  for (const name of ["matter_content", "derived_index", "job_record", "legacy_matter_ops", "matter_access"]) p.classes[name].onMatterDeletion = "purge"
  p.classes.matter_record.onMatterDeletion = "anonymise"
  p.classes.ai_record.onMatterDeletion = "anonymise"
  p.classes.vault_object.onMatterDeletion = "lock"
  p.classes.third_party_trace.onMatterDeletion = "external"
  return p
}

const store = (key: InventoryStore["key"], extra: Partial<InventoryStore> = {}): InventoryStore => ({ id: "firestore:x", kind: "firestore", name: "x", profile: "matter_content", key, ...extra })

describe("F42 units: store keys", () => {
  it("keeps a short id readable and hashes a long one to at most 80 characters, deterministically", () => {
    expect(storeKey("firestore:matters")).toBe("firestore_matters")
    expect(storeKey("objects:documents")).toBe("objects_documents")
    const long = `firestore:${"a_very_long_legacy_collection_name_".repeat(40)}`
    const key = storeKey(long)
    expect(key.length).toBeLessThanOrEqual(80)
    expect(key).toMatch(/^[A-Za-z0-9_]+_h[0-9a-f]{24}$/)
    expect(storeKey(long)).toBe(key)
    expect(storeKey(`${long}b`)).not.toBe(key)
    // The same key ci_gates/check_data_inventory.py store_key computes (its collision check relies on it).
    expect(key).toBe("firestore_a_very_long_legacy_collection_name_a_v_hc50e0e6fda8a20890ca1122e")
  })

  it("FA-F42-R1-013 (spec R32): the saga's production sizes are pinned; the test seam lowers them only outside production", () => {
    const { limits } = sagaInternals
    const production = { chunk: 200, chunkStepBudget: 45, traceIdsPerPart: 5_000, maxTraceParts: 24 }
    expect(limits()).toEqual(production)
    try {
      retentionTestSeam.limits = { chunk: 10, chunkStepBudget: 5 }
      expect(limits()).toEqual({ ...production, chunk: 10, chunkStepBudget: 5 })
      vi.stubEnv("NODE_ENV", "production")
      expect(limits()).toEqual(production)
    } finally {
      vi.unstubAllEnvs()
      delete retentionTestSeam.limits
    }
  })

  it("FA-F42-R1-012 (R21): the TypeScript and Python store keys agree on every inventoried id and on long and odd ids", () => {
    const odd = [
      `firestore:${"a".repeat(71)}`, // 81 characters: one past the limit, so hashed
      `firestore:${"x".repeat(1500)}`,
      `firestore:${"b".repeat(60)}-${"c".repeat(9)}`, // 80 exactly: kept
      "postgres:client_private.judgment",
      "firestore:ünïcode_ñame",
      "objects:documents",
    ]
    const ids = [...inventory().stores.map((s) => s.id), ...odd]
    const script = [
      "import json, sys",
      "sys.path.insert(0, 'ci_gates')",
      "import check_data_inventory as g",
      "print(json.dumps([g.store_key(i) for i in json.load(sys.stdin)]))",
    ].join("\n")
    const out = spawnSync("python3", ["-c", script], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8", input: JSON.stringify(ids) })
    expect(out.status, out.stderr).toBe(0)
    expect(JSON.parse(out.stdout) as string[]).toEqual(ids.map(storeKey))
    // Both forms are exercised: the long ids are hashed, the 80-character one is kept as it is.
    expect(storeKey(odd[0])).toMatch(/_h[0-9a-f]{24}$/)
    expect(storeKey(odd[2])).toBe(odd[2].replace(/[^A-Za-z0-9]/g, "_"))
  })

  it("every inventoried store has a distinct key of at most 80 characters", () => {
    const keys = inventory().stores.map((s) => storeKey(s.id))
    expect(new Set(keys).size).toBe(keys.length)
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(80)
  })
})

describe("F42 units: acknowledgement completeness", () => {
  it("is complete only when every expected store has a string outcome", () => {
    expect(isComplete(["a", "b"], { a: "purged", b: "retained" })).toBe(true)
    expect(isComplete(["a", "b"], { a: "purged", b: "retained", c: "extra" })).toBe(true)
    expect(isComplete(["a", "b"], { a: "purged" })).toBe(false)
    expect(isComplete(["a", "b"], { a: "purged", b: 1 } as never)).toBe(false)
    expect(isComplete([], {})).toBe(false)
    expect(isComplete(["a"], undefined)).toBe(false)
    expect(isComplete("a" as never, { a: "purged" })).toBe(false)
  })
})

describe("F42 units: treatments, plan and holds", () => {
  it("maps each key kind and action to a treatment, never destroying on a misfit action", () => {
    expect(treatmentOf(store({ kind: "none" }), "purge")).toBe("not_applicable")
    expect(treatmentOf(store({ kind: "ttl", windowHours: 48 }), "retain")).toBe("expiry")
    expect(treatmentOf(store({ kind: "backup", windowDays: 98, config: "x" }), "purge")).toBe("expiry")
    expect(treatmentOf(store({ kind: "objects", via: "firestore:documents", pathField: "storagePath" }), "lock")).toBe("lock")
    expect(treatmentOf(store({ kind: "objects", via: "firestore:documents", pathField: "storagePath" }), "retain")).toBe("retained")
    const trace = { kind: "traceExport" as const, sources: [{ source: "s", idField: "i", statusField: "s", exportedValues: ["e"] }] }
    expect(treatmentOf(store(trace), "external")).toBe("external")
    expect(treatmentOf(store(trace), "retain")).toBe("retained")
    expect(treatmentOf(store({ kind: "field", field: "matterId" }), "purge")).toBe("purge")
    expect(treatmentOf(store({ kind: "field", field: "matterId" }), "anonymise")).toBe("anonymise")
    for (const misfit of ["retain", "expiry", "external", "lock"] as const) expect(treatmentOf(store({ kind: "docId" }), misfit)).toBe("retained")
  })

  it("the shipped policy plans no purge, no anonymisation and no lock: it deletes nothing", () => {
    const plan = planDeletion(shipped())
    expect(plan).toHaveLength(inventory().stores.length)
    expect(plan.filter((p) => ["purge", "anonymise", "lock", "external"].includes(p.treatment))).toEqual([])
  })

  it("the shipped policy holds; a policy with every hold off does not; a hold on a class with no matter key does not", () => {
    expect(policyHolds(shipped(), planDeletion(shipped()))).toBe(true)
    const p = purgePolicy()
    expect(policyHolds(p, planDeletion(p))).toBe(false)
    p.classes.identity_platform.legalHold = true // firm, user and platform rows: no matter key
    expect(policyHolds(p, planDeletion(p))).toBe(false)
    p.classes.matter_access.legalHold = true
    expect(policyHolds(p, planDeletion(p))).toBe(true)
  })

  it("FA-F42-R1-012 (R16): a class hold on the vault or on the processor's traces alone holds the deletion", () => {
    for (const name of ["vault_object", "third_party_trace"]) {
      const p = purgePolicy()
      p.classes[name].legalHold = true
      expect(policyHolds(p, planDeletion(p)), name).toBe(true)
      expect(holdRefusal(p, planDeletion(p), undefined, "f1"), name).toBe("legal_hold_policy")
    }
  })

  it("a matter hold of the firm refuses first; another firm's or an inactive hold does not", () => {
    const p = purgePolicy()
    const plan = planDeletion(p)
    expect(holdRefusal(p, plan, { active: true, firmId: "f1" }, "f1")).toBe("legal_hold_matter")
    expect(holdRefusal(p, plan, { active: true, firmId: "f2" }, "f1")).toBeNull()
    expect(holdRefusal(p, plan, { active: false, firmId: "f1" }, "f1")).toBeNull()
    expect(holdRefusal(p, plan, { active: "true", firmId: "f1" }, "f1")).toBeNull()
    expect(holdRefusal(p, plan, undefined, "f1")).toBeNull()
    expect(holdRefusal(shipped(), planDeletion(shipped()), undefined, "f1")).toBe("legal_hold_policy")
    expect(holdRefusal(shipped(), planDeletion(shipped()), { active: true, firmId: "f1" }, "f1")).toBe("legal_hold_matter")
  })

  it("validation refuses a bad action, a class that may anonymise a store with no fields, and an anonymisation that keeps the key", () => {
    const inv = inventory()
    expect(() => validatePolicy(purgePolicy(), inv)).not.toThrow()
    const bad = purgePolicy()
    bad.classes.matter_content.onMatterDeletion = "shred" as never
    expect(() => validatePolicy(bad, inv)).toThrow(RetentionConfigError)
    const anon = purgePolicy()
    anon.classes.matter_content.onMatterDeletion = "anonymise"
    expect(() => validatePolicy(anon, inv)).toThrow(/anonymise/)
    const keyKept = { ...inv, stores: inv.stores.map((s) => (s.id === "firestore:ai_usage_logs" ? { ...s, anonymise: { matterId: "x" } } : s)) }
    expect(() => validatePolicy(purgePolicy(), keyKept)).toThrow(/anonymise key/)
    const period = purgePolicy()
    period.classes.matter_content.periodDays = 0
    expect(() => validatePolicy(period, inv)).toThrow(RetentionConfigError)
  })

  it("FA-F42-R1-005: validation refuses a reason-code list that is missing, empty, not code-shaped or repeated", () => {
    const inv = inventory()
    const cases: Array<[string, (p: RetentionPolicy) => void]> = [
      ["deletion.reasonCodes", (p) => delete (p.deletion as { reasonCodes?: unknown }).reasonCodes],
      ["deletion.reasonCodes", (p) => (p.deletion.reasonCodes = [])],
      ["deletion.reasonCodes", (p) => (p.deletion.reasonCodes = ["client_instruction", "Client Ayesha"])],
      ["deletion.reasonCodes", (p) => (p.deletion.reasonCodes = ["court_order", "court_order"])],
      ["legalHold.reasonCodes", (p) => delete (p as { legalHold?: unknown }).legalHold],
      ["legalHold.reasonCodes", (p) => (p.legalHold.reasonCodes = ["ok_code", "x"])],
    ]
    for (const [field, mutate] of cases) {
      const p = purgePolicy()
      mutate(p)
      expect(() => validatePolicy(p, inv), field).toThrow(new RetentionConfigError(field))
    }
  })

  it("FA-F42-R1-011: a deleting period is adoptable only aged by row, on a class whose every store retention.apply can age", () => {
    const inv = inventory()
    // The shipped policy names a basis for every class and has no period: it validates and deletes nothing.
    const p0 = shipped()
    for (const [name, c] of Object.entries(p0.classes)) expect(["row_age", "matter_closure"], name).toContain(c.periodBasis)
    expect(() => validatePolicy(p0, inv)).not.toThrow()
    const refused: Array<[string, (p: RetentionPolicy) => void]> = [
      // No basis, or an unknown one.
      ["class matter_content periodBasis", (p) => delete (p.classes.matter_content as { periodBasis?: unknown }).periodBasis],
      ["class ai_record periodBasis", (p) => ((p.classes.ai_record as { periodBasis: unknown }).periodBasis = "created")],
      // Aged from matter closure: not built (FU-8), so not adoptable, held or not.
      ["class matter_content periodBasis matter_closure (FU-8)", (p) => Object.assign(p.classes.matter_content, { periodDays: 30, periodicAction: "purge" })],
      ["class matter_content periodBasis matter_closure (FU-8)", (p) => Object.assign(p.classes.matter_content, { periodDays: 30, periodicAction: "purge", legalHold: true })],
      // Aged by row on a class with a store retention.apply cannot age: a Firestore store with no ageField, the vault.
      ["store firestore:custody_events period not applicable", (p) => Object.assign(p.classes.matter_content, { periodDays: 30, periodicAction: "purge", periodBasis: "row_age" })],
      ["store objects:documents period not applicable", (p) => Object.assign(p.classes.vault_object, { periodDays: 30, periodicAction: "purge" })],
      ["store firestore:audit_dead_letter period not applicable", (p) => Object.assign(p.classes.audit_trail, { periodDays: 3650, periodicAction: "purge" })],
    ]
    for (const [field, mutate] of refused) {
      const p = shipped()
      mutate(p)
      expect(() => validatePolicy(p, inv), field).toThrow(new RetentionConfigError(field))
    }
    // A row-aged period on the AI records (every store with an ageField) validates; so does a period that only retains.
    const ok = shipped()
    Object.assign(ok.classes.ai_record, { periodDays: 30, periodicAction: "anonymise" })
    Object.assign(ok.classes.matter_content, { periodDays: 30, periodicAction: "retain" })
    expect(() => validatePolicy(ok, inv)).not.toThrow()
  })

  it("FA-F42-R1-006-003-001: attestation links and the independent-partner register refuse puppet approval paths", async () => {
    const { isIndependentPartner, refusePartnerAttestationLinks, requireIndependentPartnerRegistration } = await import(
      "../src/retention/partnerIndependence"
    )
    expect(isIndependentPartner({ role: "partner", active: true, independentPartner: true })).toBe(true)
    expect(isIndependentPartner({ role: "partner", active: true, independentPartner: false, createdBy: "F" })).toBe(false)
    expect(isIndependentPartner({ role: "partner", active: true, createdBy: "F" })).toBe(false)
    expect(isIndependentPartner({ role: "partner", active: true })).toBe(true)
    expect(() => refusePartnerAttestationLinks({ approver: "Q", requester: "F" }, { partnerAttestedBy: "F" }, {})).toThrow(
      expect.objectContaining({ code: "approver_attested_by_requester" })
    )
    expect(() => requireIndependentPartnerRegistration({ role: "partner", independentPartner: false }, "approver")).toThrow(
      expect.objectContaining({ code: "approver_not_independent" })
    )
  })

  it("FA-F42-R1-006-001: transitive createdBy / partnerGrantedBy refuses when either partner ancestors the other", async () => {
    const { partnerLineageAncestors, refusePartnerLineage } = await import("../src/retention/partnerLineage")
    type Row = { createdBy?: string; partnerGrantedBy?: string }
    const users: Record<string, Row> = {
      P: {},
      Q: { createdBy: "P" },
      R: { createdBy: "Q" },
      side: { createdBy: "other" },
      grant: { partnerGrantedBy: "P" },
      deep: { createdBy: "d1" },
      d1: { createdBy: "d2" },
      d2: { partnerGrantedBy: "P" },
    }
    const load = async (uid: string) => users[uid]
    expect(await partnerLineageAncestors("R", load)).toEqual(new Set(["Q", "P"]))
    expect(await partnerLineageAncestors("Q", load)).toEqual(new Set(["P"]))
    expect(await partnerLineageAncestors("deep", load)).toEqual(new Set(["d1", "d2", "P"]))
    await expect(refusePartnerLineage({ approver: "R", requester: "P" }, load)).rejects.toMatchObject({ status: 403, code: "approver_lineage_of_requester" })
    await expect(refusePartnerLineage({ approver: "P", requester: "R" }, load)).rejects.toMatchObject({ status: 403, code: "requester_lineage_of_approver" })
    await expect(refusePartnerLineage({ approver: "side", requester: "P" }, load)).resolves.toBeUndefined()
    await expect(refusePartnerLineage({ approver: "grant", requester: "P" }, load)).rejects.toMatchObject({ code: "approver_lineage_of_requester" })
    users.cycle = { createdBy: "cycleB" }
    users.cycleB = { createdBy: "cycle" }
    expect(await partnerLineageAncestors("cycle", load)).toBeNull()
  })

  it("FA-F42-R1-006: the shipped approver tenure is the PROPOSED 30 days, and validation refuses one missing, zero or fractional", () => {
    const inv = inventory()
    expect(purgePolicy().deletion.approverMinTenureDays).toBe(30)
    const cases: Array<(p: RetentionPolicy) => void> = [
      (p) => delete (p.deletion as { approverMinTenureDays?: unknown }).approverMinTenureDays,
      (p) => (p.deletion.approverMinTenureDays = 0),
      (p) => (p.deletion.approverMinTenureDays = 1.5),
      (p) => ((p.deletion as { approverMinTenureDays: unknown }).approverMinTenureDays = "30"),
    ]
    for (const mutate of cases) {
      const p = purgePolicy()
      mutate(p)
      expect(() => validatePolicy(p, inv)).toThrow(new RetentionConfigError("deletion.approverMinTenureDays"))
    }
  })

  it("FA-F42-R1-005: a vault path is kept only in the vault's own shape for its row's firm and document", () => {
    const { vaultPathOf } = sagaInternals
    expect(vaultPathOf("fs://firmA/documents/doc1/v1", "firmA", "doc1")).toBe("fs://firmA/documents/doc1/v1")
    expect(vaultPathOf("s3://firmA/documents/doc1/v12", "firmA", "doc1")).toBe("s3://firmA/documents/doc1/v12")
    for (const [path, firm, doc] of [
      ["fs://firmA/documents/Ayesha Siddiqui v Khan/v1", "firmA", "doc1"],
      ["fs://firmA/documents/doc1/v1", "firmB", "doc1"],
      ["fs://firmA/documents/doc1/v1", "firmA", "doc2"],
      ["fs://firmA/documents/doc1/v1", "firmA", null],
      ["fs://firmA/documents/doc1/v1-Ayesha", "firmA", "doc1"],
      ["fs://firmA/documents/doc1/v0", "firmA", "doc1"],
      ["gs://firmA/documents/doc1/v1", "firmA", "doc1"],
      ["fs://firmA/exports/doc1/v1", "firmA", "doc1"],
      ["fs://firmA/documents/doc1/v1/extra", "firmA", "doc1"],
    ] as const) {
      expect(vaultPathOf(path, firm, doc), path).toBeNull()
    }
  })

  it("FA-F42-R1-002-001-003-001: committee output trail ids keep only id-shaped documentIds entries", () => {
    const { documentIdsFromCommitteeOutputRow } = sagaInternals
    expect(documentIdsFromCommitteeOutputRow({ documentIds: ["a", "", 1, "bad space", "doc-1"] })).toEqual(["a", "doc-1"])
    expect(documentIdsFromCommitteeOutputRow({})).toEqual([])
  })

  it("groups the documents stores, the committee outputs and the vault into the first purge job, the rest by the group size", () => {
    const p = purgePolicy()
    const plan = Object.fromEntries(planDeletion(p).map((x) => [x.key, x.treatment]))
    const order = planDeletion(p).map((x) => x.key)
    const groups = purgeGroups(plan, order, 12)
    // FA-F42-R1-002: committee outputs ride with the documents, after them, so their legacy rows (found through the
    // documents) are purged before the store is acknowledged, whatever order the other groups run in.
    expect(groups[0]).toEqual(["firestore_documents", "firestore_document_versions", "firestore_committee_outputs", "objects_documents"])
    expect(groups.slice(1).every((g) => g.length <= 12 && g.length > 0)).toBe(true)
    const purged = order.filter((k) => ["purge", "anonymise", "lock"].includes(plan[k]))
    expect(groups.flat().sort()).toEqual([...purged].sort())
    expect(purgeGroups(Object.fromEntries(order.map((k) => [k, "retained"])), order, 12)).toEqual([])
  })

  it("names each continuation of a purge job anew: a counter, never a saturating suffix, always a valid part", () => {
    const { nextPart } = sagaInternals
    expect(nextPart("g0")).toBe("g0c1")
    expect(nextPart("g0c1")).toBe("g0c2")
    expect(nextPart("g12c9")).toBe("g12c10")
    const seen = new Set<string>()
    let part = "g19"
    for (let i = 0; i < 2_000; i++) {
      part = nextPart(part)
      expect(part).toMatch(/^[a-z0-9]{1,20}$/)
      expect(seen.has(part)).toBe(false)
      seen.add(part)
    }
  })

  it("splits trace ids into bounded parts, in order, losing none; an id set past the bound is refused, never cut", () => {
    const { traceIdParts } = sagaInternals
    expect(traceIdParts([])).toEqual([])
    const ids = Array.from({ length: 10_001 }, (_, i) => `t-${String(i).padStart(5, "0")}`)
    const parts = traceIdParts(ids)
    expect(parts.map((p) => p.length)).toEqual([5_000, 5_000, 1])
    expect(parts.flat()).toEqual(ids)
    // The byte bound: 5,000 ids of 100 bytes pass 256 KiB, so they split by size first.
    const long = Array.from({ length: 5_000 }, (_, i) => `${String(i).padStart(5, "0")}${"x".repeat(95)}`)
    const byBytes = traceIdParts(long)
    expect(byBytes.length).toBe(2)
    expect(byBytes.flat()).toEqual(long)
    expect(byBytes.every((p) => p.reduce((n, id) => n + Buffer.byteLength(id) + 1, 0) <= 256 * 1024)).toBe(true)
    const refused = (f: () => unknown) => {
      try {
        f()
      } catch (err) {
        return err instanceof JobError ? `${err.code} ${err.permanent}` : String(err)
      }
      return "accepted"
    }
    expect(refused(() => traceIdParts(["y".repeat(256 * 1024)]))).toBe("external_ids_over_limit true")
    expect(refused(() => traceIdParts(Array.from({ length: 24 * 5_000 + 1 }, (_, i) => `t-${i}`)))).toBe("external_ids_over_limit true")
    expect(traceIdParts(Array.from({ length: 24 * 5_000 }, (_, i) => `t-${i}`))).toHaveLength(24)
  })
})

describe("FA-F42-R1-007: late trace ids are captured for Opik before rows lose the matter", () => {
  const plan = () => Object.fromEntries(planDeletion(purgePolicy()).map((x) => [x.key, x.treatment]))

  it("capturesFor maps ai_usage_logs and p1_decisions to the opik processor when the plan is external", () => {
    const p = plan()
    const usage = capturesFor("firestore:ai_usage_logs", p)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ processor: "opik", key: "external_opik" })
    expect(usage[0]!.specs.map((s) => s.source)).toEqual(["firestore:ai_usage_logs"])
    const decisions = capturesFor("firestore:p1_decisions", p)
    expect(decisions[0]!.specs.map((s) => s.source)).toEqual(["firestore:p1_decisions"])
  })

  it("exportedIds keeps only exported traces from usage rows and pending/exported from decision rows", () => {
    const usageSpecs = capturesFor("firestore:ai_usage_logs", plan())[0]!.specs
    expect(
      exportedIds(
        [
          { trace: { id: "t-exported", status: "exported" } },
          { trace: { id: "t-disabled", status: "disabled" } },
          { trace: { id: "t-pending", status: "pending" } },
        ],
        usageSpecs
      )
    ).toEqual(["t-exported"])
    const decisionSpecs = capturesFor("firestore:p1_decisions", plan())[0]!.specs
    expect(
      exportedIds(
        [{ traceId: "d-pending", export: { state: "pending" } }, { traceId: "d-failed", export: { state: "failed" } }],
        decisionSpecs
      )
    ).toEqual(["d-pending"])
  })

  it("stageLateIds appends only fresh ids to a new late part in the same transaction", () => {
    const sets: Array<{ id: string; data: Record<string, unknown> }> = []
    const updates: Record<string, unknown>[] = []
    const tx = {
      set: (ref: { id: string }, data: Record<string, unknown>) => {
        sets.push({ id: ref.id, data })
      },
      update: (_ref: unknown, data: Record<string, unknown>) => {
        updates.push(data)
      },
    } as unknown as Transaction
    const read = { processor: "opik", exists: true, parts: 1, recorded: new Set(["trace-before"]) }
    expect(stageLateIds(tx, read, ["trace-before", "trace-inflight"], { firmId: "f", requestId: "req", matterId: "m" }, 42)).toBe(1)
    expect(sets).toHaveLength(1)
    expect(sets[0]).toMatchObject({ id: "req_opik_p1", data: { traceIds: ["trace-inflight"], late: true, part: 1 } })
    expect(updates[0]?.parts).toBe(2)
    expect((updates[0]?.lateIds as { operand: number }).operand).toBe(1)
  })
})

describe("FA-F42-R2-002: lateTraces part cache cannot drop recorded ids", () => {
  it("readLateIds still sees every part after the FIFO cache evicts an earlier part", async () => {
    const partData = new Map<string, string[]>()
    for (let n = 0; n < 65; n += 1) partData.set(`req_opik_p${n}`, [`trace-${n}`])

    const makeTx = (parts: number): Transaction =>
      ({
        get: async (ref: { id: string }) =>
          ({
            exists: ref.id === "req_opik",
            id: ref.id,
            get: (field: string) => (field === "parts" ? parts : undefined),
          }) as never,
        getAll: async (...refs: { id: string }[]) =>
          refs.map((ref) => ({
            id: ref.id,
            get: (field: string) => (field === "traceIds" ? partData.get(ref.id) ?? [] : undefined),
          })) as never,
      }) as unknown as Transaction

    await readLateIds(makeTx(64), "req", "opik")
    const read = await readLateIds(makeTx(65), "req", "opik")
    expect(read.recorded.size).toBe(65)
    expect(read.recorded.has("trace-0")).toBe(true)
    expect(read.recorded.has("trace-64")).toBe(true)
  })

  it("stageLateIds does not re-count ids that are already recorded across more than 64 parts", async () => {
    const partData = new Map<string, string[]>()
    for (let n = 0; n < 65; n += 1) partData.set(`req_opik_p${n}`, [`trace-${n}`])
    const makeTx = (parts: number): Transaction =>
      ({
        get: async (ref: { id: string }) =>
          ({
            exists: ref.id === "req_opik",
            id: ref.id,
            get: (field: string) => (field === "parts" ? parts : field === "count" ? 65 : 0),
          }) as never,
        getAll: async (...refs: { id: string }[]) =>
          refs.map((ref) => ({
            id: ref.id,
            get: (field: string) => (field === "traceIds" ? partData.get(ref.id) ?? [] : undefined),
          })) as never,
      }) as unknown as Transaction

    await readLateIds(makeTx(64), "req", "opik")
    const read = await readLateIds(makeTx(65), "req", "opik")
    const updates: Record<string, unknown>[] = []
    const sets: Record<string, unknown>[] = []
    const tx = {
      get: makeTx(65).get,
      getAll: makeTx(65).getAll,
      update: (_ref: unknown, data: Record<string, unknown>) => {
        updates.push(data)
      },
      set: (_ref: unknown, data: Record<string, unknown>) => {
        sets.push(data)
      },
    } as unknown as Transaction
    expect(stageLateIds(tx, read, ["trace-0", "trace-64"], { firmId: "f", requestId: "req", matterId: "m" }, 1)).toBe(0)
    expect(updates).toHaveLength(0)
    expect(sets).toHaveLength(0)
  })
})

describe("F42 units: the tombstone in the shared table and the row key", () => {
  const caller = { role: "partner", firmId: "f1", clearanceLevel: "privileged-restricted" as const }

  it("a deleted matter of the firm is refused matter-deleted, after the cross-firm check and before membership", () => {
    expect(decide(caller, "matter.read", { firmId: "f1", classification: "internal", deleted: true }, true)).toEqual({ allow: false, reason: "matter-deleted" })
    expect(decide(caller, "matter.read", { firmId: "f1", classification: "internal", deleted: true }, false)).toEqual({ allow: false, reason: "matter-deleted" })
    expect(decide(caller, "matter.read", { firmId: "f2", classification: "internal", deleted: true }, true)).toEqual({ allow: false, reason: "cross-firm" })
    expect(decide(caller, "matter.read", { firmId: "f1", classification: "internal", deleted: false }, true)).toEqual({ allow: true, reason: "ok" })
    for (const action of ["draft.read", "ai.call", "job.read", "research"]) {
      expect(decide(caller, action, { firmId: "f1", classification: "internal", deleted: true }, true), action).toEqual({ allow: false, reason: "matter-deleted" })
    }
  })

  it("the retention actions are partner-only firm administration", () => {
    for (const action of ["retention.request_deletion", "retention.approve_deletion", "retention.read", "retention.hold.place", "retention.hold.release"]) {
      expect(decide(caller, action, undefined, false), action).toEqual({ allow: true, reason: "ok" })
      for (const role of ["associate", "clerk", "intern", "accounts", "client"]) {
        expect(decide({ ...caller, role }, action, undefined, false), `${role} ${action}`).toEqual({ allow: false, reason: "partner-only" })
      }
    }
  })

  it("a tombstone counts only for its own firm and matter; rows key to their matter", () => {
    expect(isTombstoneFor({ firmId: "f1", matterId: "m" }, "f1", "m")).toBe(true)
    expect(isTombstoneFor({ firmId: "f2", matterId: "m" }, "f1", "m")).toBe(false)
    expect(isTombstoneFor({ firmId: "f1", matterId: "other" }, "f1", "m")).toBe(false)
    expect(isTombstoneFor(undefined, "f1", "m")).toBe(false)
    expect(isTombstoneFor({ firmId: "f1", matterId: "m" }, "", "m")).toBe(false)
    expect(matterKeyOfRow("matters", "m1", { matterId: "other" })).toBe("m1")
    expect(matterKeyOfRow("documents", "d1", { matterId: "m1" })).toBe("m1")
    expect(matterKeyOfRow("matter_client_search_index", "i", { linkedMatterId: "m2" })).toBe("m2")
    expect(matterKeyOfRow("documents", "d1", { matterId: null })).toBeNull()
    expect(matterKeyOfRow("clients", "c1", {})).toBeNull()
  })
})
