import { describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { enqueueJob, jobIdFor, jobsRef } from "../src/p2/enqueue"
import type { DiagnosticPayload } from "../src/p2/diagnostic"
import { EMULATORS } from "./emu"
import { T0, diagSpec, enqueueAt, newFirm } from "./jobs"

/**
 * The gate-named P2 job-engine invariants (spec §7, gate G-4 Phase 3a step [3]). Task 2 adds
 * invariant 4; later tasks add 1, 2, 3 and 5 to this suite.
 */

describe.skipIf(!EMULATORS)("P2 job engine invariants (P3-4, P3-6..P3-8)", () => {
  it("P2 invariant: enqueue is idempotent and a job exists iff its transaction committed", async () => {
    const firm = await newFirm()
    const p: DiagnosticPayload = { behaviour: "succeed" }
    const spec = diagSpec(firm, p)
    // Three transactions, one key: exactly one creates the row.
    const results = await Promise.all([1, 2, 3].map(() => enqueueAt(spec, T0)))
    expect(results.filter((r) => !r.reused)).toHaveLength(1)
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1)
    const rows = await jobsRef().where("firmId", "==", firm).where("idempotencyKey", "==", spec.idempotencyKey).get()
    expect(rows.size).toBe(1)

    // A transaction that enqueues a fresh key then throws: no doc with that id.
    const fresh = diagSpec(firm, p)
    await expect(
      adminDb().runTransaction(async (tx) => {
        await enqueueJob(tx, fresh, { now: T0 })
        throw new Error("rolled back")
      })
    ).rejects.toThrow("rolled back")
    expect((await jobsRef().doc(jobIdFor(firm, fresh.jobType, fresh.idempotencyKey)).get()).exists).toBe(false)

    // One key in two firms makes two jobs.
    const [firmA, firmB] = [await newFirm(), await newFirm()]
    const [a, b] = [await enqueueAt(diagSpec(firmA, p, { idempotencyKey: "same" }), T0), await enqueueAt(diagSpec(firmB, p, { idempotencyKey: "same" }), T0)]
    expect(a.jobId).not.toBe(b.jobId)
    expect(a.reused || b.reused).toBe(false)
  })
})
