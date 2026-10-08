import { describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { enqueueJob, jobIdFor, jobsRef } from "../src/p2/enqueue"
import type { DiagnosticPayload } from "../src/p2/diagnostic"
import { EMULATORS } from "./emu"
import { FakeClock, T0, diagCount, diagSpec, enqueueAt, jobAuditRows, jobEvents, newFirm, readJob, testDeps } from "./jobs"

/**
 * The gate-named P2 job-engine invariants (spec §7, gate G-4 Phase 3a step [3]). Task 2 added
 * invariant 4, Task 3 adds 1 and 3; later tasks add 2 and 5 to this suite.
 */

describe.skipIf(!EMULATORS)("P2 job engine invariants (P3-4, P3-6..P3-8)", () => {
  it("P2 invariant: duplicate delivery commits the effect exactly once", async () => {
    const firm = await newFirm()
    const { jobId } = await enqueueAt(diagSpec(firm, { behaviour: "succeed" }), T0)
    const d = testDeps(new FakeClock(T0))
    const t = { jobId, seq: 0 }
    // The trigger and a redelivery both dispatch task j…-0: Cloud Tasks dedupes by task id.
    await d.dispatcher.dispatch(t)
    await d.dispatcher.dispatch(t)
    expect(d.dispatcher.tasks).toHaveLength(1)
    // Two instances receive the same task at the same moment: one claim wins.
    expect((await Promise.all([d.dispatcher.deliver(t, T0), d.dispatcher.deliver(t, T0)])).sort()).toEqual(["done", "dropped"])
    // A third delivery after done is dropped.
    expect(await d.dispatcher.deliver(t, T0 + 10)).toBe("dropped")
    const row = await readJob(jobId)
    expect([await diagCount(firm, jobId), row.attempts, row.totalAttempts]).toEqual([1, 1, 1])
    expect(row.status).toBe("done")
    expect((await jobAuditRows(jobId)).filter((r) => r.action === "job.done")).toHaveLength(1)
    expect((await jobAuditRows(jobId)).filter((r) => r.action === "job.start")).toHaveLength(1)
  })

  it("P2 invariant: a failing job retries at 1s, 5s and 25s, then dead-letters with job.deadLettered", async () => {
    const firm = await newFirm()
    const { jobId } = await enqueueAt(diagSpec(firm, { behaviour: "fail_times", failTimes: 4 }), T0)
    const d = testDeps(new FakeClock(T0))
    const outcomes = [await d.dispatcher.deliver({ jobId, seq: 0 }, T0)]
    let failedAt = T0
    const gaps: number[] = []
    // Deliver each recorded task at its scheduleAt.
    while (outcomes.at(-1) === "failed") {
      const task = d.dispatcher.tasks.at(-1)!
      expect(task.scheduleAt).not.toBeNull()
      gaps.push(task.scheduleAt! - failedAt)
      failedAt = task.scheduleAt!
      outcomes.push(await d.dispatcher.deliver(task, task.scheduleAt!))
    }
    expect(outcomes).toEqual(["failed", "failed", "failed", "dead_lettered"])
    expect(gaps).toEqual([1000, 5000, 25000])
    expect(d.dispatcher.tasks.map((t) => t.seq)).toEqual([1, 2, 3])

    const row = await readJob(jobId)
    expect(row).toMatchObject({ status: "dead_lettered", attempts: 4, totalAttempts: 4, nextAttemptAt: null, lease: null, lastError: { code: "diag_failure" } })
    expect(await diagCount(firm, jobId)).toBe(0)
    const events = await jobEvents(jobId)
    const eventIds = Object.keys(events)
    expect(eventIds.sort()).toEqual([1, 2, 3, 4].map((n) => `${jobId}_failed_${n}`).concat(`${jobId}_deadLettered_0`).sort())
    expect(events[`${jobId}_deadLettered_0`]).toMatchObject({
      name: "job.deadLettered",
      firmId: firm,
      classification: "internal",
      idempotencyKey: `${jobId}_deadLettered_0`,
      payload: { jobId, jobType: "platform.diagnostic", attempts: 4, error: "diag_failure" },
    })
    expect(d.alerts).toEqual([{ jobId, jobType: "platform.diagnostic", firmId: firm, attempts: 4, code: "diag_failure" }])
    expect((await jobAuditRows(jobId)).map((r) => r.action)).toEqual([
      "job.enqueue",
      ...Array(3).fill(["job.start", "job.fail"]).flat(),
      "job.start",
      "job.dead_letter",
    ])
  })

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
