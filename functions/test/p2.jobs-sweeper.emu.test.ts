import { Timestamp } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { jobsRef } from "../src/p2/enqueue"
import { sweep } from "../src/p2/sweeper"
import { EMULATORS } from "./emu"
import { FakeClock, diagSpec, enqueueAt, jobAuditRows, jobEvents, newFirm, readJob, sweepOrigins, testDeps } from "./jobs"

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
})
