import { logger } from "firebase-functions"
import { afterEach, describe, expect, it, vi } from "vitest"
import { adminDb } from "../src/admin"
import { JOB_LEASE_MS } from "../src/p2/constants"
import { enqueueJob, jobIdFor, jobsRef } from "../src/p2/enqueue"
import type { DiagnosticPayload } from "../src/p2/diagnostic"
import { sweep } from "../src/p2/sweeper"
import { jobWorkerTestSeam, type TaskOutcome } from "../src/p2/worker"
import { EMULATORS } from "./emu"
import { FakeClock, T0, diagCount, diagSpec, enqueueAt, jobAuditRows, jobEvents, newFirm, readJob, sweepOrigins, testDeps } from "./jobs"

/**
 * The gate-named P2 job-engine invariants (spec §7, gate G-4 Phase 3a step [3]). Task 2 added
 * invariant 4, Task 3 added 1 and 3, Task 4 adds 2 and 5. The tests that sweep run at their own
 * origin far before `T0` (`sweepOrigins`), so rows other suites left are not in the sweep.
 */

const nextOrigin = sweepOrigins(200)

describe.skipIf(!EMULATORS)("P2 job engine invariants (P3-4, P3-6..P3-8)", () => {
  afterEach(() => {
    delete jobWorkerTestSeam.afterClaim
    delete jobWorkerTestSeam.afterHandler
    vi.restoreAllMocks()
  })

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

  it("P2 invariant: a lease that expires mid-handler is reclaimed and the stale commit is discarded", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const O = nextOrigin()
    const firm = await newFirm()
    const { jobId } = await enqueueAt(diagSpec(firm, { behaviour: "succeed" }), O)
    const clock = new FakeClock(O)
    const d = testDeps(clock)
    const owners: string[] = []
    let worker2: TaskOutcome | undefined
    let interposed = false
    jobWorkerTestSeam.afterClaim = async ({ jobId: id, owner }) => {
      if (id === jobId) owners.push(owner)
    }
    jobWorkerTestSeam.afterHandler = async ({ jobId: id }) => {
      if (id !== jobId || interposed) return
      interposed = true
      // Worker 1 is frozen past its lease: the sweeper (query B) re-dispatches, worker 2 reclaims and finishes.
      clock.advance(JOB_LEASE_MS)
      expect((await sweep(d)).dispatched).toContain(jobId)
      const task = d.dispatcher.tasks.filter((t) => t.jobId === jobId).at(-1)!
      expect(task).toEqual({ jobId, seq: 1, scheduleAt: null })
      worker2 = await d.dispatcher.deliver(task)
    }
    // Worker 1 resumes and reaches its commit.
    const outcomeOfWorker1 = await d.dispatcher.deliver({ jobId, seq: 0 }, O)
    expect(worker2).toBe("done")
    expect(outcomeOfWorker1).toBe("lease_lost")
    expect(owners).toHaveLength(2)
    expect(new Set(owners).size).toBe(2)
    const row = await readJob(jobId)
    const count = await diagCount(firm, jobId)
    expect(row).toMatchObject({ status: "done", attempts: 2, totalAttempts: 2, lease: null })
    expect(count).toBe(1)
    expect(row.logs.filter((l) => l.event === "done")).toEqual([expect.objectContaining({ attempt: 2 })])
    expect(row.logs.map((l) => l.event)).toEqual(["enqueued", "claimed", "reclaimed", "done"])
    expect(warn.mock.calls.filter(([m]) => m === "job.lease_lost")).toHaveLength(1)
    expect((await jobAuditRows(jobId)).map((r) => [r.action, r.reason])).toEqual([
      ["job.enqueue", "ok"],
      ["job.start", "ok"],
      ["job.start", "lease_expired_reclaim"],
      ["job.done", "ok"],
    ])
  })

  it("P2 invariant: skewed clocks never dispatch a job twice in one sweep or run a fifth attempt", async () => {
    const O = nextOrigin()
    const firm = await newFirm()
    const { jobId } = await enqueueAt(diagSpec(firm, { behaviour: "fail_times", failTimes: 4 }), O)
    const clock = new FakeClock(O)
    const d = testDeps(clock)
    const sweepResults: Array<{ dispatched: string[]; deadLettered: string[] }> = []
    const sweepAt = async (ms: number) => {
      clock.set(ms)
      const r = await sweep(d)
      sweepResults.push(r)
      return r.dispatched.filter((id) => id === jobId).length
    }
    const attempts = async () => (await readJob(jobId)).attempts
    const twentyInARow: Array<{ dispatched: string[]; deadLettered: string[] }> = []

    for (let k = 1; k <= 4; k++) {
      const before = await readJob(jobId)
      const due = before.nextAttemptAt!.toMillis()
      const seq = before.dispatchSeq
      const tasks = d.dispatcher.tasks.length
      // More than 2 s early: the current task and the oldest one (seq 0) are dropped, and the worker dispatches nothing.
      expect(await d.dispatcher.deliver({ jobId, seq }, due - 3000)).toBe("dropped")
      expect(await d.dispatcher.deliver({ jobId, seq: 0 }, due - 3000)).toBe("dropped")
      expect(d.dispatcher.tasks).toHaveLength(tasks)
      expect(await attempts()).toBe(k - 1)
      // 1.5 s early: inside the tolerance, and the oldest task, superseded by every later dispatch, still runs it (I-1).
      expect(await d.dispatcher.deliver({ jobId, seq: 0 }, due - 1500)).toBe(k < 4 ? "failed" : "dead_lettered")
      expect(await attempts()).toBe(k)
      if (k < 4) {
        // Every task dispatched so far, delivered again before the next attempt is due: all dropped.
        const nextDue = (await readJob(jobId)).nextAttemptAt!.toMillis()
        for (const t of d.dispatcher.tasks.filter((x) => x.jobId === jobId)) expect(await d.dispatcher.deliver(t, nextDue - 3000)).toBe("dropped")
        expect(await d.dispatcher.deliver({ jobId, seq: 0 }, nextDue - 3000)).toBe("dropped")
        expect(await attempts()).toBe(k)
      }
      if (k === 4) break

      const T = due - 1500
      const delay = [1000, 5000, 25000][k - 1]
      // A sweeper clock 10 min behind: not due, nothing dispatched.
      expect(await sweepAt(T - 600_000)).toBe(0)
      // 10 min ahead: due, one dispatch, and dispatchedAt is stamped 10 min ahead.
      expect(await sweepAt(T + 600_000)).toBe(1)
      expect((await readJob(jobId)).dispatchedAt.toMillis()).toBe(T + 600_000)
      // Back to T + 40 s: the future stamp (more than 300 s ahead) is not trusted and is reset by
      // one dispatch, when the row is due by then (after the 1 s and 5 s delays, not the 25 s one).
      const dueAt40 = T + delay <= T + 40_000 - 30_000
      expect(await sweepAt(T + 40_000)).toBe(dueAt40 ? 1 : 0)
      expect((await readJob(jobId)).dispatchedAt.toMillis()).toBe(dueAt40 ? T + 40_000 : T + 600_000)
      expect(await attempts()).toBeLessThanOrEqual(4)
      if (k === 1) {
        // Twenty sweeps at one clock, 40 s after that reset: the first may dispatch, the rest must not.
        for (let i = 0; i < 20; i++) {
          clock.set(T + 80_000)
          twentyInARow.push(await sweep(d))
        }
        sweepResults.push(...twentyInARow)
        expect(twentyInARow.flatMap((r) => r.dispatched).filter((id) => id === jobId)).toHaveLength(1)
        expect(twentyInARow[0].dispatched).toContain(jobId)
      }
    }

    for (const r of sweepResults) expect(r.dispatched.filter((id) => id === jobId).length).toBeLessThanOrEqual(1)
    expect(twentyInARow).toHaveLength(20)
    expect(twentyInARow.flatMap((r) => r.dispatched).filter((id) => id === jobId).length).toBeLessThanOrEqual(1)
    // Every dispatch the sweeps made is still dropped once the round has dead-lettered.
    for (const t of d.dispatcher.tasks.filter((x) => x.jobId === jobId)) expect(await d.dispatcher.deliver(t, t.scheduleAt ?? clock.now())).toBe("dropped")
    expect(await sweepAt(clock.now() + 3_600_000)).toBe(0)
    const row = await readJob(jobId)
    expect(row).toMatchObject({ status: "dead_lettered", totalAttempts: 4, attempts: 4 })
    expect(d.alerts).toEqual([expect.objectContaining({ jobId, attempts: 4, code: "diag_failure" })])
  })
})
