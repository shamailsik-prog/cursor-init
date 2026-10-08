import { Timestamp } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { adminDb } from "../src/admin"
import { SWEEP_LIMIT } from "../src/p2/constants"
import { enqueueJobs, jobsRef } from "../src/p2/enqueue"
import { sweep, sweepTestSeam } from "../src/p2/sweeper"
import { EMULATORS } from "./emu"
import { FakeClock, diagCount, diagSpec, enqueueAt, jobAuditRows, jobEvents, newFirm, readJob, sweepOrigins, testDeps } from "./jobs"

/**
 * The sweeper (spec P3-8): query A re-dispatches a due row whose dispatch was lost, query B
 * recovers an expired lease. Every job is seeded at the test's origin `T0` and no trigger runs;
 * the in-process dispatcher records what the sweep dispatches.
 */

const nextOrigin = sweepOrigins(100)

describe.skipIf(!EMULATORS)("P2 sweeper (P3-8)", () => {
  let T0: number
  let clock: FakeClock
  let d: ReturnType<typeof testDeps>
  let firmId: string

  const sweepAt = (ms: number) => {
    clock.set(ms)
    return sweep(d)
  }
  const tasksFor = (jobId: string) => d.dispatcher.tasks.filter((t) => t.jobId === jobId)
  const seed = async (behaviour: "succeed" = "succeed") => (await enqueueAt(diagSpec(firmId, { behaviour }), T0)).jobId

  beforeEach(async () => {
    T0 = nextOrigin()
    clock = new FakeClock(T0)
    d = testDeps(clock)
    firmId = await newFirm()
  })

  afterEach(() => {
    delete sweepTestSeam.beforeQuery
    vi.restoreAllMocks()
  })

  it("query A: a due row whose trigger was lost is re-dispatched once, 30 s after its last dispatch", async () => {
    const jobId = await seed()
    expect((await sweepAt(T0 + 29_999)).dispatched).not.toContain(jobId)
    expect((await sweepAt(T0 + 30_000)).dispatched).toContain(jobId)
    const row = await readJob(jobId)
    expect(row).toMatchObject({ status: "queued", dispatchSeq: 1 })
    expect(row.dispatchedAt.toMillis()).toBe(T0 + 30_000)
    expect(row.updatedAt.toMillis()).toBe(T0 + 30_000)
    expect(tasksFor(jobId)).toEqual([{ jobId, seq: 1, scheduleAt: null }])
    expect((await sweepAt(T0 + 59_999)).dispatched).not.toContain(jobId)
    expect((await sweepAt(T0 + 60_000)).dispatched).toContain(jobId)
    expect(tasksFor(jobId).map((t) => t.seq)).toEqual([1, 2])
    expect((await readJob(jobId)).dispatchSeq).toBe(2)
    // A re-dispatch writes no audit row.
    expect((await jobAuditRows(jobId)).map((r) => r.action)).toEqual(["job.enqueue"])
    // The re-dispatched task runs.
    expect(await d.dispatcher.deliver({ jobId, seq: 2 }, T0 + 60_000)).toBe("done")
  })

  it("query B: an expired lease is re-dispatched and the worker reclaims with attempts + 1", async () => {
    const jobId = await seed()
    await jobsRef()
      .doc(jobId)
      .update({ status: "running", attempts: 1, totalAttempts: 1, lease: { owner: "dead", expiresAt: Timestamp.fromMillis(T0 + 600_000) } })
    expect((await sweepAt(T0 + 599_999)).dispatched).not.toContain(jobId)
    expect(tasksFor(jobId)).toEqual([])
    expect((await sweepAt(T0 + 600_000)).dispatched).toContain(jobId)
    expect(tasksFor(jobId)).toEqual([{ jobId, seq: 1, scheduleAt: null }])
    expect(await readJob(jobId)).toMatchObject({ status: "running", dispatchSeq: 1, lease: { owner: "dead" } })
    expect(await d.dispatcher.deliver({ jobId, seq: 1 }, T0 + 600_000)).toBe("done")
    const row = await readJob(jobId)
    expect(row).toMatchObject({ status: "done", attempts: 2, totalAttempts: 2, lease: null })
    expect((await jobAuditRows(jobId)).find((r) => r.action === "job.start")!.reason).toBe("lease_expired_reclaim")
  })

  it("query B: an expired lease at attempt 4 dead-letters with lease_expired", async () => {
    const jobId = await seed()
    await jobsRef()
      .doc(jobId)
      .update({ status: "running", attempts: 4, totalAttempts: 4, lease: { owner: "dead", expiresAt: Timestamp.fromMillis(T0 + 600_000) } })
    const r = await sweepAt(T0 + 600_000)
    expect(r.deadLettered).toEqual([jobId])
    expect(r.dispatched).not.toContain(jobId)
    const row = await readJob(jobId)
    expect(row).toMatchObject({
      status: "dead_lettered",
      lease: null,
      nextAttemptAt: null,
      lastError: { code: "lease_expired", message: "The job's worker stopped before finishing." },
    })
    expect(row.finishedAt?.toMillis()).toBe(T0 + 600_000)
    expect(tasksFor(jobId)).toEqual([])
    expect(d.alerts).toEqual([expect.objectContaining({ jobId, code: "lease_expired", attempts: 4 })])
    expect(Object.keys(await jobEvents(jobId)).sort()).toEqual([`${jobId}_deadLettered_0`, `${jobId}_failed_4`])
    expect((await jobAuditRows(jobId)).at(-1)).toMatchObject({ action: "job.dead_letter", reason: "lease_expired" })
    // A second sweep finds nothing to do.
    const again = await sweepAt(T0 + 700_000)
    expect([again.dispatched.includes(jobId), again.deadLettered.includes(jobId)]).toEqual([false, false])
    expect(d.alerts).toHaveLength(1)
  })

  it("three concurrent sweeps dispatch a job once", async () => {
    const jobId = await seed()
    clock.set(T0 + 30_000)
    const r = await Promise.all([1, 2, 3].map(() => sweep(d)))
    expect(r.flatMap((x) => x.dispatched).filter((id) => id === jobId)).toHaveLength(1)
    expect((await readJob(jobId)).dispatchSeq).toBe(1)
    expect(tasksFor(jobId)).toEqual([{ jobId, seq: 1, scheduleAt: null }])
  })

  it("three concurrent sweeps re-dispatch an expired lease once", async () => {
    const jobId = await seed()
    await jobsRef()
      .doc(jobId)
      .update({ status: "running", attempts: 1, totalAttempts: 1, lease: { owner: "dead", expiresAt: Timestamp.fromMillis(T0 + 600_000) } })
    clock.set(T0 + 600_000)
    const r = await Promise.all([1, 2, 3].map(() => sweep(d)))
    expect(r.flatMap((x) => x.dispatched).filter((id) => id === jobId)).toHaveLength(1)
    expect((await readJob(jobId)).dispatchSeq).toBe(1)
  })

  it("a dispatchedAt more than 300 s ahead is reset; 299 s ahead is trusted", async () => {
    const [reset, trusted] = [await seed(), await seed()]
    const now = T0 + 30_000
    await jobsRef().doc(reset).update({ dispatchedAt: Timestamp.fromMillis(now + 300_001) })
    await jobsRef().doc(trusted).update({ dispatchedAt: Timestamp.fromMillis(now + 299_000) })
    const r = await sweepAt(now)
    expect(r.dispatched).toContain(reset)
    expect(r.dispatched).not.toContain(trusted)
    const resetRow = await readJob(reset)
    expect(resetRow.dispatchSeq).toBe(1)
    expect(resetRow.dispatchedAt.toMillis()).toBe(now)
    const trustedRow = await readJob(trusted)
    expect(trustedRow.dispatchSeq).toBe(0)
    expect(trustedRow.dispatchedAt.toMillis()).toBe(now + 299_000)
    expect(tasksFor(trusted)).toEqual([])
  })

  it("a finished row and a row without engine p2 are never re-dispatched", async () => {
    const [done, foreign] = [await seed(), await seed()]
    expect(await d.dispatcher.deliver({ jobId: done, seq: 0 }, T0)).toBe("done")
    await jobsRef().doc(foreign).update({ engine: "legacy" })
    const before = await readJob(foreign)
    const r = await sweepAt(T0 + 30_000)
    expect(r.dispatched).not.toContain(done)
    expect(r.dispatched).not.toContain(foreign)
    expect((await readJob(foreign)).updateTime.isEqual(before.updateTime)).toBe(true)
    expect([...tasksFor(done), ...tasksFor(foreign)]).toEqual([])
  })

  it("an older task arriving after a newer dispatch still claims a queued due row, and the newer task then no-ops", async () => {
    const jobId = await seed()
    // The trigger's task j…-0 is stuck in a backed-up queue; the sweeper re-dispatches j…-1.
    expect((await sweepAt(T0 + 30_000)).dispatched).toContain(jobId)
    expect((await readJob(jobId)).dispatchSeq).toBe(1)
    // j…-0 arrives first: it claims and runs the job.
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0 + 31_000)).toBe("done")
    // j…-1 arrives after: the job is finished, so it no-ops.
    const before = await readJob(jobId)
    expect(await d.dispatcher.deliver({ jobId, seq: 1 }, T0 + 32_000)).toBe("dropped")
    expect((await readJob(jobId)).updateTime.isEqual(before.updateTime)).toBe(true)
    // A seq the row never dispatched is dropped.
    expect(await d.dispatcher.deliver({ jobId, seq: 2 }, T0 + 32_000)).toBe("dropped")
    expect(await diagCount(firmId, jobId)).toBe(1)
    expect(await readJob(jobId)).toMatchObject({ status: "done", attempts: 1, totalAttempts: 1 })
    expect((await jobAuditRows(jobId)).map((r) => r.action)).toEqual(["job.enqueue", "job.start", "job.done"])
  })

  it("an older and a newer task delivered together run the job once", async () => {
    const jobId = await seed()
    expect((await sweepAt(T0 + 30_000)).dispatched).toContain(jobId)
    const outcomes = await Promise.all([d.dispatcher.deliver({ jobId, seq: 0 }), d.dispatcher.deliver({ jobId, seq: 1 })])
    expect(outcomes.sort()).toEqual(["done", "dropped"])
    expect(await diagCount(firmId, jobId)).toBe(1)
    expect(await readJob(jobId)).toMatchObject({ status: "done", attempts: 1, totalAttempts: 1 })
  })

  it("a failed query A is logged and query B still runs in the same sweep", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined)
    const [due, leased] = [await seed(), await seed()]
    await jobsRef()
      .doc(leased)
      .update({ status: "running", attempts: 1, totalAttempts: 1, lease: { owner: "dead", expiresAt: Timestamp.fromMillis(T0 + 600_000) } })
    sweepTestSeam.beforeQuery = async (name) => {
      if (name === "A") throw Object.assign(new Error("index building"), { code: 9 })
    }
    const r = await sweepAt(T0 + 600_000)
    expect(r.dispatched).not.toContain(due)
    expect(r.dispatched).toContain(leased)
    expect((await readJob(due)).dispatchSeq).toBe(0)
    expect(error).toHaveBeenCalledWith("job sweep failed", { code: "grpc_9" })
  })

  it("SWEEP_LIMIT bounds the rows one sweep dispatches; the oldest due rows go first", async () => {
    const n = SWEEP_LIMIT + 1
    const specs = Array.from({ length: n }, () => diagSpec(firmId, { behaviour: "succeed" }))
    const ids = (await adminDb().runTransaction((tx) => enqueueJobs(tx, specs, { now: T0 }))).map((x) => x.jobId)
    // Due one millisecond apart, so the order is fixed: ids[0] is the oldest.
    const batch = adminDb().batch()
    ids.forEach((id, i) => batch.update(jobsRef().doc(id), { nextAttemptAt: Timestamp.fromMillis(T0 + i) }))
    await batch.commit()
    const now = T0 + 30_000 + n
    const first = await sweepAt(now)
    expect(first.dispatched).toHaveLength(SWEEP_LIMIT)
    expect(first.dispatched).toEqual(ids.slice(0, SWEEP_LIMIT))
    expect(d.dispatcher.tasks).toHaveLength(SWEEP_LIMIT)
    // The newest due row is outside this sweep's window and is left unwritten.
    expect((await readJob(ids[SWEEP_LIMIT])).dispatchSeq).toBe(0)
  })
})
