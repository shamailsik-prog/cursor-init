import { readFileSync } from "node:fs"
import path from "node:path"
import type { Transaction } from "firebase-admin/firestore"
import { describe, expect, it } from "vitest"
import { MATTER_BOUND_COLLECTIONS, areValidRefs, enqueueJobs, isMatterBoundRef, type JobSpec } from "../src/p2/enqueue"

/**
 * Audit F14 re-audit R1-D3: a firm-level job (`matterId` null) is judged against no matter, so a reference it carries
 * to a matter's row (a document, a draft, ...) would reach that row with no check of the matter's current label or
 * membership. Enqueue refuses such inputRefs and the worker refuses such outputRefs; a matter job may carry them (its
 * reads are judged against its matter). Pure: no emulator.
 */

const ROOT = path.resolve(__dirname, "../..")
const RULES = readFileSync(path.join(ROOT, "firestore.rules"), "utf8")
const SPINE = readFileSync(path.join(ROOT, "platform/persistence/firestoreSpineRepositories.ts"), "utf8")

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

describe("job refs into matter-bound collections (audit F14 R1-D3)", () => {
  it("names the matter-bound collections the audit lists, each a collection the codebase stores", () => {
    for (const c of ["documents", "document_versions", "drafts", "draft_versions"]) expect(MATTER_BOUND_COLLECTIONS.has(c)).toBe(true)
    for (const c of MATTER_BOUND_COLLECTIONS) {
      const known = RULES.includes(`match /${c}/{`) || SPINE.includes(`"${c}"`)
      expect([c, known]).toEqual([c, true])
    }
    // The firm-level collections today's producers reference stay allowed (fan-out: events; un-merge: merge_events).
    for (const c of ["events", "merge_events", "clients", "entities", "entity_links", "counters"]) expect(MATTER_BOUND_COLLECTIONS.has(c)).toBe(false)
  })

  it("a firm-level job may not reference a matter-bound row; a matter job may", () => {
    for (const c of MATTER_BOUND_COLLECTIONS) {
      const ref = `${c}/row-1`
      expect([ref, isMatterBoundRef(ref)]).toEqual([ref, true])
      expect([ref, "firm-level", areValidRefs([ref], null)]).toEqual([ref, "firm-level", false])
      expect([ref, "matter", areValidRefs([ref], "m1")]).toEqual([ref, "matter", true])
      expect([ref, "mixed", areValidRefs(["events/e1", ref], null)]).toEqual([ref, "mixed", false])
    }
    for (const ref of ["events/e1", "merge_events/me1", "clients/c1", "counters/k1"]) {
      expect([ref, areValidRefs([ref], null), areValidRefs([ref], "m1")]).toEqual([ref, true, true])
    }
    // The existing shape rules still apply to both.
    for (const matterId of [null, "m1"]) {
      expect(areValidRefs(["a/b/c"], matterId)).toBe(false)
      expect(areValidRefs("events/e1", matterId)).toBe(false)
      expect(areValidRefs([], matterId)).toBe(true)
    }
  })

  it("enqueue refuses a firm-level job whose inputRefs name a matter's document, and accepts the same refs on a matter job", async () => {
    await expect(enqueueJobs(tx, [spec(null, ["documents/d1"])], { now: 0 })).rejects.toThrow("enqueue: invalid inputRefs")
    await expect(enqueueJobs(tx, [spec(null, ["events/e1", "draft_versions/v1"])], { now: 0 })).rejects.toThrow("enqueue: invalid inputRefs")
    await expect(enqueueJobs(tx, [spec("m1", ["documents/d1"])], { now: 0 })).rejects.toBe(REACHED_TX)
    await expect(enqueueJobs(tx, [spec(null, ["events/e1"])], { now: 0 })).rejects.toBe(REACHED_TX)
  })
})
