import { describe, expect, it } from "vitest"
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
  storeKey,
  treatmentOf,
  validatePolicy,
  type InventoryStore,
  type RetentionPolicy,
} from "../src/retention/config"
import { JobError } from "../src/p2/errors"
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

  it("groups the documents stores and the vault into the first purge job, the rest by the group size", () => {
    const p = purgePolicy()
    const plan = Object.fromEntries(planDeletion(p).map((x) => [x.key, x.treatment]))
    const order = planDeletion(p).map((x) => x.key)
    const groups = purgeGroups(plan, order, 12)
    expect(groups[0]).toEqual(["firestore_documents", "firestore_document_versions", "objects_documents"])
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
