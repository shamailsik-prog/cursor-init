import { readFileSync } from "node:fs"
import path from "node:path"
import type { Transaction } from "firebase-admin/firestore"
import { describe, expect, it } from "vitest"
import { FIRM_LEVEL_REF_COLLECTIONS, areValidRefs, enqueueJobs, isFirmLevelRef, type JobSpec } from "../src/p2/enqueue"

/**
 * Audit F14 re-audit R1-D3 / R2-D3: a firm-level job (`matterId` null) is judged against no matter, so a reference it
 * carries is never checked against a matter's current label or membership. Its refs may therefore name only rows of
 * firm-level collections, an allowlist (a denylist of matter-bound collections missed some: evidence_items,
 * custody_events, the reporting snapshots, conflict_checks, jobs, ...). Enqueue refuses any other inputRef and the
 * worker any other outputRef. A matter job keeps the shape rule only (its reads are judged against its matter). Pure: no
 * emulator.
 */

const ROOT = path.resolve(__dirname, "../..")
const RULES = readFileSync(path.join(ROOT, "firestore.rules"), "utf8")

/** A transaction that fails the test if enqueue gets past validation (validation runs before any read). */
const REACHED_TX = new Error("validation passed: enqueue reached the transaction")
const tx = {
  getAll: async () => {
    throw REACHED_TX
  },
} as unknown as Transaction

const spec = (matterId: string | null, inputRefs: string[]): JobSpec => ({
  firmId: "firm-r",
  jobType: "platform.diagnostic",
  classification: "internal",
  matterId,
  payload: { behaviour: "succeed" },
  inputRefs,
  idempotencyKey: "k-1",
  createdBy: "system",
})

/** Collections whose rows belong to one matter, or are read under a matter's membership (the re-audit's lists, A4). */
const MATTER_SCOPED = [
  "matters",
  "matter_members",
  "matter_parties",
  "matter_events",
  "documents",
  "document_versions",
  "document_workflow",
  "workflow_events",
  "drafts",
  "draft_versions",
  "draft_gate_results",
  "draft_gate_overrides",
  "committee_outputs",
  "follow_ups",
  "propositions",
  "intimation_register",
  "filing_packet_artifacts",
  "evidence_items",
  "custody_events",
  "matter_client_search_index",
  "matter_report_relevance_snapshots",
  "workflow_ops_activity",
  "conflict_checks",
  "jobs",
]

describe("firm-level job refs: an allowlist of firm-level collections (audit F14 R1-D3, R2-D3)", () => {
  it("allows exactly the firm-level collections today's producers and the registry use, each a collection the rules name", () => {
    expect([...FIRM_LEVEL_REF_COLLECTIONS].sort()).toEqual(["clients", "counters", "entities", "entity_aliases", "entity_links", "events", "merge_events"])
    for (const c of FIRM_LEVEL_REF_COLLECTIONS) expect([c, RULES.includes(`match /${c}/{`)]).toEqual([c, true])
    for (const c of MATTER_SCOPED) expect([c, FIRM_LEVEL_REF_COLLECTIONS.has(c)]).toEqual([c, false])
  })

  it("a firm-level job may reference only an allowlisted collection; a matter job may reference any safe ref", () => {
    for (const c of MATTER_SCOPED) {
      const ref = `${c}/row-1`
      expect([ref, isFirmLevelRef(ref)]).toEqual([ref, false])
      expect([ref, "firm-level", areValidRefs([ref], null)]).toEqual([ref, "firm-level", false])
      expect([ref, "mixed", areValidRefs(["events/e1", ref], null)]).toEqual([ref, "mixed", false])
      expect([ref, "matter", areValidRefs([ref], "m1")]).toEqual([ref, "matter", true])
    }
    // A collection nobody listed is refused too: the rule fails closed.
    expect(areValidRefs(["some_new_collection/x1"], null)).toBe(false)
    expect(areValidRefs(["some_new_collection/x1"], "m1")).toBe(true)
    // Today's producers: fan-out (events/<id>), un-merge (merge_events/<id>), and the registry rows.
    for (const c of FIRM_LEVEL_REF_COLLECTIONS) {
      const ref = `${c}/row-1`
      expect([ref, isFirmLevelRef(ref), areValidRefs([ref], null), areValidRefs([ref], "m1")]).toEqual([ref, true, true, true])
    }
    // The shape rules still apply to both.
    for (const matterId of [null, "m1"]) {
      expect(areValidRefs(["a/b/c"], matterId)).toBe(false)
      expect(areValidRefs("events/e1", matterId)).toBe(false)
      expect(areValidRefs([], matterId)).toBe(true)
    }
  })

  it("enqueue refuses a firm-level job whose inputRefs name a matter-scoped row, and accepts the same refs on a matter job", async () => {
    for (const ref of ["documents/d1", "evidence_items/e1", "jobs/j1", "conflict_checks/c1", "workflow_ops_activity/a1"]) {
      await expect(enqueueJobs(tx, [spec(null, [ref])], { now: 0 })).rejects.toThrow("enqueue: invalid inputRefs")
      await expect(enqueueJobs(tx, [spec("m1", [ref])], { now: 0 })).rejects.toBe(REACHED_TX)
    }
    await expect(enqueueJobs(tx, [spec(null, ["events/e1", "draft_versions/v1"])], { now: 0 })).rejects.toThrow("enqueue: invalid inputRefs")
    await expect(enqueueJobs(tx, [spec(null, ["events/e1", "clients/c1"])], { now: 0 })).rejects.toBe(REACHED_TX)
  })
})
