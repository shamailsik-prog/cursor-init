import { Timestamp } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { adminDb } from "../src/admin"
import { MAX_REDISPATCH_BACKOFF_MS, SWEEP_LIMIT, SWEEP_MAX_PAGES, redispatchBackoffMs } from "../src/p2/constants"
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
  /** Enqueues `n` succeed jobs at `now`, 100 per transaction, and returns their ids in enqueue order. */
  const seedMany = async (n: number, now: number): Promise<string[]> => {
    const ids: string[] = []
    for (let i = 0; i < n; i += 100) {
      const specs = Array.from({ length: Math.min(100, n - i) }, () => diagSpec(firmId, { behaviour: "succeed" }))
      ids.push(...(await adminDb().runTransaction((tx) => enqueueJobs(tx, specs, { now }))).map((x) => x.jobId))
    }
    return ids
  }

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
    // The second re-dispatch waits the backed-off 60 s (P3-35), not the fixed 30 s grace.
    expect((await sweepAt(T0 + 89_999)).dispatched).not.toContain(jobId)
    expect((await sweepAt(T0 + 90_000)).dispatched).toContain(jobId)
    expect(tasksFor(jobId).map((t) => t.seq)).toEqual([1, 2])
    expect((await readJob(jobId)).dispatchSeq).toBe(2)
    // A re-dispatch writes no audit row.
    expect((await jobAuditRows(jobId)).map((r) => r.action)).toEqual(["job.enqueue"])
    // The re-dispatched task runs.
    expect(await d.dispatcher.deliver({ jobId, seq: 2 }, T0 + 90_000)).toBe("done")
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

  it("rows are swept oldest sweepAt first, across pages of SWEEP_LIMIT (P3-34, P3-36)", async () => {
    const n = SWEEP_LIMIT + 1
    const ids = await seedMany(n, T0)
    // Due one millisecond apart, so the order is fixed: ids[0] is the oldest.
    const batch = adminDb().batch()
    ids.forEach((id, i) => batch.update(jobsRef().doc(id), { nextAttemptAt: Timestamp.fromMillis(T0 + i), sweepAt: Timestamp.fromMillis(T0 + 30_000 + i) }))
    await batch.commit()
    const now = T0 + 30_000 + n
    const first = await sweepAt(now)
    expect(first.dispatched).toEqual(ids)
    expect(d.dispatcher.tasks).toHaveLength(n)
  })

  it("each sweeper re-dispatch backs off: 60 s, 120 s, 240 s, 480 s, then capped at 600 s (P3-35)", async () => {
    const jobId = await seed()
    // [sweep time, redispatches after it, next sweepAt]
    const steps: Array<[number, number, number]> = [
      [T0 + 30_000, 1, T0 + 90_000],
      [T0 + 90_000, 2, T0 + 210_000],
      [T0 + 210_000, 3, T0 + 450_000],
      [T0 + 450_000, 4, T0 + 930_000],
      [T0 + 930_000, 5, T0 + 1_530_000],
      [T0 + 1_530_000, 6, T0 + 2_130_000],
    ]
    for (const [now, redispatches, next] of steps) {
      expect((await sweepAt(now - 1)).dispatched).not.toContain(jobId)
      expect((await sweepAt(now)).dispatched).toContain(jobId)
      const row = await readJob(jobId)
      expect([row.redispatches, row.sweepAt?.toMillis(), row.dispatchedAt.toMillis()]).toEqual([redispatches, next, now])
    }
    expect(tasksFor(jobId).map((t) => t.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect([MAX_REDISPATCH_BACKOFF_MS, redispatchBackoffMs(0), redispatchBackoffMs(1), redispatchBackoffMs(4), redispatchBackoffMs(5), redispatchBackoffMs(40)]).toEqual([
      600_000, 30_000, 60_000, 480_000, 600_000, 600_000,
    ])
  })

  it("query B: a re-dispatch of an expired lease backs off too; the claim resets redispatches", async () => {
    const jobId = await seed()
    const expiry = T0 + 600_000
    await jobsRef()
      .doc(jobId)
      .update({ status: "running", attempts: 1, totalAttempts: 1, lease: { owner: "dead", expiresAt: Timestamp.fromMillis(expiry) }, sweepAt: Timestamp.fromMillis(expiry) })
    expect((await sweepAt(expiry)).dispatched).toEqual([jobId])
    let row = await readJob(jobId)
    expect([row.status, row.redispatches, row.sweepAt?.toMillis()]).toEqual(["running", 1, expiry + 60_000])
    expect((await sweepAt(expiry + 59_999)).dispatched).not.toContain(jobId)
    expect((await sweepAt(expiry + 60_000)).dispatched).toEqual([jobId])
    row = await readJob(jobId)
    expect([row.redispatches, row.sweepAt?.toMillis()]).toEqual([2, expiry + 180_000])
    expect(await d.dispatcher.deliver({ jobId, seq: 2 }, expiry + 61_000)).toBe("done")
    row = await readJob(jobId)
    expect([row.status, row.sweepAt]).toEqual(["done", null])
  })

  it("query B: a row at attempt 4 whose sweepAt equals its lease expiry dead-letters at that instant, sweepAt null", async () => {
    const jobId = await seed()
    const expiry = T0 + 600_000
    await jobsRef()
      .doc(jobId)
      .update({ status: "running", attempts: 4, totalAttempts: 4, lease: { owner: "dead", expiresAt: Timestamp.fromMillis(expiry) }, sweepAt: Timestamp.fromMillis(expiry) })
    expect((await sweepAt(expiry - 1)).deadLettered).not.toContain(jobId)
    expect((await sweepAt(expiry)).deadLettered).toEqual([jobId])
    const row = await readJob(jobId)
    expect([row.status, row.sweepAt]).toEqual(["dead_lettered", null])
  })

  it("query A' (skew): a row stamped by a sweep 10 min ahead is reset by the next correct sweep; a stamp 250 s ahead is trusted", async () => {
    const [ahead, trusted] = [await seed(), await seed()]
    // A sweep on a clock 10 min ahead re-dispatches both, stamping sweepAt 11 min ahead of true time.
    expect((await sweepAt(T0 + 630_000)).dispatched.sort()).toEqual([ahead, trusted].sort())
    expect((await readJob(ahead)).sweepAt?.toMillis()).toBe(T0 + 690_000)
    const now = T0 + 60_000
    const stamp = Timestamp.fromMillis(now + 250_000)
    await jobsRef().doc(trusted).update({ dispatchedAt: stamp, redispatches: 5, sweepAt: Timestamp.fromMillis(now + 250_000 + 600_000) })
    const before = await readJob(trusted)
    const pages: string[] = []
    sweepTestSeam.beforeQuery = async (name) => void pages.push(name)
    const r = await sweepAt(now)
    expect(r.dispatched).toEqual([ahead])
    expect(pages).toContain("skew")
    const row = await readJob(ahead)
    expect([row.dispatchSeq, row.dispatchedAt.toMillis(), row.redispatches, row.sweepAt?.toMillis()]).toEqual([2, now, 2, now + 120_000])
    expect((await readJob(trusted)).updateTime.isEqual(before.updateTime)).toBe(true)
  })

  it("head-of-line (O-36): 120 rows dispatched 10 s ago do not hide the 30 eligible rows behind them", async () => {
    const ids = await seedMany(150, T0)
    const now = T0 + 60_000
    const recent = Timestamp.fromMillis(now - 10_000)
    const batch = adminDb().batch()
    ids.forEach((id, i) => {
      const due = { nextAttemptAt: Timestamp.fromMillis(T0 + i) }
      // The first 120 by nextAttemptAt were re-dispatched by a sweep 10 s ago; the other 30 never were.
      if (i < 120) batch.update(jobsRef().doc(id), { ...due, dispatchSeq: 1, dispatchedAt: recent, redispatches: 1, sweepAt: Timestamp.fromMillis(now - 10_000 + 60_000) })
      else batch.update(jobsRef().doc(id), { ...due, sweepAt: Timestamp.fromMillis(T0 + i + 30_000) })
    })
    await batch.commit()
    const r = await sweepAt(now)
    expect(r.dispatched).toEqual(ids.slice(120))
  }, 60_000)

  it("paging (P3-36): 260 eligible rows are all re-dispatched in one sweep, each once", async () => {
    const ids = await seedMany(260, T0)
    const r = await sweepAt(T0 + 30_000)
    expect(new Set(r.dispatched).size).toBe(260)
    expect([...r.dispatched].sort()).toEqual([...ids].sort())
    expect(d.dispatcher.tasks).toHaveLength(260)
  }, 120_000)

  it("paging (P3-36): 600 eligible rows give exactly SWEEP_LIMIT x SWEEP_MAX_PAGES = 500 re-dispatches in one sweep", async () => {
    await seedMany(600, T0)
    const pages: string[] = []
    sweepTestSeam.beforeQuery = async (name) => void pages.push(name)
    const r = await sweepAt(T0 + 30_000)
    expect(SWEEP_LIMIT * SWEEP_MAX_PAGES).toBe(500)
    expect(r.dispatched).toHaveLength(500)
    expect(new Set(r.dispatched).size).toBe(500)
    expect(pages.filter((p) => p === "A")).toHaveLength(SWEEP_MAX_PAGES)
    // The next sweep picks up the rest.
    expect((await sweepAt(T0 + 30_001)).dispatched).toHaveLength(100)
  }, 180_000)

  it("paging stops when a page acts on no row: a full page of rows that all lose the re-read is read once", async () => {
    const ids = await seedMany(SWEEP_LIMIT + 20, T0)
    const now = T0 + 30_000
    const batch = adminDb().batch()
    // The first page's rows are due by sweepAt but were dispatched 1 s ago (a lost race): the re-read declines each.
    ids.forEach((id, i) =>
      batch.update(
        jobsRef().doc(id),
        i < SWEEP_LIMIT ? { sweepAt: Timestamp.fromMillis(T0 + i), dispatchedAt: Timestamp.fromMillis(now - 1_000) } : { sweepAt: Timestamp.fromMillis(T0 + 10_000 + i) }
      )
    )
    await batch.commit()
    const pages: string[] = []
    sweepTestSeam.beforeQuery = async (name) => void pages.push(name)
    const r = await sweepAt(now)
    expect(r.dispatched).toEqual([])
    expect(pages.filter((p) => p === "A")).toEqual(["A"])
  }, 60_000)
})
