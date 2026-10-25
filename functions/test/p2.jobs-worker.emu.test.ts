import { FieldValue, Timestamp } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DiagnosticPayload } from "../src/p2/diagnostic"
import { jobsRef } from "../src/p2/enqueue"
import { adminDb } from "../src/admin"
import { LeaseLostError } from "../src/p2/errors"
import { logDeadLetterAlert } from "../src/p2/jobEvents"
import { jobTestSeam, type JobHandler } from "../src/p2/registry"
import { jobWorkerTestSeam } from "../src/p2/worker"
import { EMULATORS, uniq } from "./emu"
import { spyRegisteredErrors } from "./registeredErrorLog"
import {
  FakeClock,
  T0,
  diagCount,
  diagSpec,
  enqueueAt,
  fencedCounterRef,
  installTestHandlers,
  jobAuditRows,
  jobEvents,
  newFirm,
  readJob,
  removeTestHandlers,
  testDeps,
} from "./jobs"

/** The P2 worker (spec P3-3, P3-6, P3-7, P3-9, P3-18): claim, lease fence, run, retries, dead-letter. */

type Deps = ReturnType<typeof testDeps>

type MisbehaveMode = "rawParse" | "throwApply" | "badRefs" | "refs" | "leaseLost" | "createExisting"

const misbehaveMarkerRef = (jobId: string) => adminDb().collection("counters").doc(`misbehave_${jobId}`)
/** A doc the `createExisting` test pre-creates, so the handler's `tx.create` fails only at commit (ALREADY_EXISTS). */
const misbehaveExistingRef = (jobId: string) => adminDb().collection("counters").doc(`misbehave_existing_${jobId}`)

/** A test-only handler that breaks the handler contract on purpose, to pin the worker's guards. */
const misbehavingHandler: JobHandler<{ mode: MisbehaveMode }> = {
  jobType: "test.misbehave",
  saga: false,
  errorCodes: {},
  parse: (payload) => {
    const mode = (payload as { mode?: MisbehaveMode }).mode
    if (mode === "rawParse") throw new Error("raw parse failure quoting the payload")
    return { mode: mode ?? "refs" }
  },
  run: async (ctx) => {
    const marker = misbehaveMarkerRef(ctx.job.id)
    switch (ctx.payload.mode) {
      case "throwApply":
        return {
          apply: (tx) => {
            tx.set(marker, { count: 1 })
            throw new Error("apply failure")
          },
        }
      case "badRefs":
        return { apply: (tx) => void tx.set(marker, { count: 1 }), outputRefs: ["not a ref"] }
      case "leaseLost":
        throw new LeaseLostError()
      case "createExisting":
        return {
          apply: (tx) => {
            tx.set(marker, { count: 1 })
            tx.create(misbehaveExistingRef(ctx.job.id), { by: "handler" })
          },
        }
      default:
        return { apply: (tx) => void tx.set(marker, { count: 1 }), outputRefs: ["matters/m1", "documents/d2"] }
    }
  },
}

describe.skipIf(!EMULATORS)("P2 worker (P3-3, P3-6, P3-7, P3-9)", () => {
  let firmId: string
  let uid: string
  let d: Deps

  const enqueue = async (payload: DiagnosticPayload | Record<string, never>, over: Parameters<typeof diagSpec>[2] = {}) =>
    (await enqueueAt(diagSpec(firmId, payload as DiagnosticPayload, { createdBy: uid, ...over }), T0)).jobId

  beforeEach(async () => {
    firmId = await newFirm()
    uid = uniq("uid")
    d = testDeps(new FakeClock(T0))
    installTestHandlers()
    jobTestSeam.handlers.set(misbehavingHandler.jobType, misbehavingHandler as JobHandler)
  })

  afterEach(() => {
    removeTestHandlers()
    jobTestSeam.handlers.delete(misbehavingHandler.jobType)
    vi.restoreAllMocks()
  })

  it("success: claim, run, commit; counter 1; audit job.start then job.done as system on behalf of the creator", async () => {
    const jobId = await enqueue({ behaviour: "succeed" })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("done")
    const row = await readJob(jobId)
    expect(row).toMatchObject({ status: "done", attempts: 1, totalAttempts: 1, lease: null, nextAttemptAt: null, lastError: null })
    expect(row.finishedAt?.toMillis()).toBe(T0)
    expect(row.startedAt?.toMillis()).toBe(T0)
    expect(await diagCount(firmId, jobId)).toBe(1)
    expect((await jobAuditRows(jobId)).map((r) => [r.action, r.reason, r.actorId, r.onBehalfOf])).toEqual([
      ["job.start", "ok", "system", uid],
      ["job.done", "ok", "system", uid],
    ])
    expect(row.logs.map((l) => l.event)).toEqual(["enqueued", "claimed", "done"])
    expect(await jobEvents(jobId)).toEqual({})
  })

  it("sweepAt per transition (P3-34): a claim sets the lease expiry, a scheduled retry nextAttemptAt + 30 s, done null; each resets redispatches", async () => {
    const jobId = await enqueue({ behaviour: "fail_times", failTimes: 1 })
    await jobsRef().doc(jobId).update({ redispatches: 3 })
    const running: Array<[unknown, number | undefined, number | undefined]> = []
    jobWorkerTestSeam.afterClaim = async () => {
      const row = await readJob(jobId)
      running.push([row.redispatches, row.sweepAt?.toMillis(), row.lease?.expiresAt.toMillis()])
      // A sweeper re-dispatch while running (query B) bumps the count; the attempt's end resets it.
      await jobsRef().doc(jobId).update({ redispatches: 2 })
    }
    try {
      expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
      let row = await readJob(jobId)
      expect([row.status, row.redispatches, row.sweepAt?.toMillis()]).toEqual(["failed", 0, T0 + 1_000 + 30_000])
      expect(await d.dispatcher.deliver({ jobId, seq: 1 }, T0 + 1_000)).toBe("done")
      row = await readJob(jobId)
      expect([row.status, row.sweepAt]).toEqual(["done", null])
    } finally {
      delete jobWorkerTestSeam.afterClaim
    }
    expect(running).toEqual([
      [0, T0 + 600_000, T0 + 600_000],
      [0, T0 + 1_000 + 600_000, T0 + 1_000 + 600_000],
    ])
  })

  it("sweepAt per transition (P3-34): a dead-letter, by the worker or by a reclaim at attempt 4, sets sweepAt null", async () => {
    const permanent = await enqueue({ behaviour: "permanent" })
    expect(await d.dispatcher.deliver({ jobId: permanent, seq: 0 }, T0)).toBe("dead_lettered")
    expect((await readJob(permanent)).sweepAt).toBeNull()
    const reclaimed = await enqueue({ behaviour: "succeed" })
    await jobsRef()
      .doc(reclaimed)
      .update({ status: "running", attempts: 4, totalAttempts: 4, lease: { owner: "w1", expiresAt: Timestamp.fromMillis(T0) }, sweepAt: Timestamp.fromMillis(T0) })
    expect(await d.dispatcher.deliver({ jobId: reclaimed, seq: 0 }, T0)).toBe("dead_lettered")
    expect((await readJob(reclaimed)).sweepAt).toBeNull()
  })

  it("retry schedule: fail_times 2 fails at attempts 1 and 2 (1 s, then 5 s later) and succeeds at 3", async () => {
    const jobId = await enqueue({ behaviour: "fail_times", failTimes: 2 })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
    let row = await readJob(jobId)
    expect(row).toMatchObject({
      status: "failed",
      attempts: 1,
      dispatchSeq: 1,
      lease: null,
      lastError: { code: "diag_failure", message: "Diagnostic failure (planned)." },
    })
    expect(row.nextAttemptAt?.toMillis()).toBe(T0 + 1000)
    expect(row.dispatchedAt.toMillis()).toBe(T0)
    expect(d.dispatcher.tasks.at(-1)).toEqual({ jobId, seq: 1, scheduleAt: T0 + 1000 })
    const events = await jobEvents(jobId)
    expect(events[`${jobId}_failed_1`]).toMatchObject({
      name: "job.failed",
      firmId,
      classification: "internal",
      idempotencyKey: `${jobId}_failed_1`,
      payload: { jobId, jobType: "platform.diagnostic", attempts: 1, error: "diag_failure" },
    })
    expect((events[`${jobId}_failed_1`].occurredAt as Timestamp).toMillis()).toBe(T0)

    expect(await d.dispatcher.deliver({ jobId, seq: 1 }, T0 + 1000)).toBe("failed")
    row = await readJob(jobId)
    expect(row).toMatchObject({ status: "failed", attempts: 2, dispatchSeq: 2 })
    expect(row.nextAttemptAt?.toMillis()).toBe(T0 + 6000)
    expect(d.dispatcher.tasks.at(-1)).toEqual({ jobId, seq: 2, scheduleAt: T0 + 6000 })

    expect(await d.dispatcher.deliver({ jobId, seq: 2 }, T0 + 6000)).toBe("done")
    expect(await diagCount(firmId, jobId)).toBe(1)
    row = await readJob(jobId)
    expect(row.totalAttempts).toBe(3)
    // A successful attempt clears the previous attempt's error.
    expect(row.lastError).toBeNull()
    expect(row.logs.map((l) => [l.event, l.attempt, l.code ?? null])).toEqual([
      ["enqueued", 0, null],
      ["claimed", 1, null],
      ["failed", 1, "diag_failure"],
      ["claimed", 2, null],
      ["failed", 2, "diag_failure"],
      ["claimed", 3, null],
      ["done", 3, null],
    ])
    expect((await jobAuditRows(jobId)).map((r) => [r.action, r.reason])).toEqual([
      ["job.start", "ok"],
      ["job.fail", "diag_failure"],
      ["job.start", "ok"],
      ["job.fail", "diag_failure"],
      ["job.start", "ok"],
      ["job.done", "ok"],
    ])
    expect(Object.keys(await jobEvents(jobId)).sort()).toEqual([`${jobId}_failed_1`, `${jobId}_failed_2`])
  })

  it("permanent, invalid payload and unknown type dead-letter at attempt 1 with job.failed and job.deadLettered", async () => {
    const cases: Array<{ code: string; jobType: string; setup: (jobId: string) => Promise<void> }> = [
      { code: "diag_permanent", jobType: "platform.diagnostic", setup: async () => undefined },
      {
        code: "invalid_payload",
        jobType: "platform.diagnostic",
        setup: (jobId) => jobsRef().doc(jobId).update({ payload: { behaviour: "nope" } }).then(() => undefined),
      },
      { code: "unknown_job_type", jobType: "gone.type", setup: (jobId) => jobsRef().doc(jobId).update({ jobType: "gone.type" }).then(() => undefined) },
    ]
    for (const c of cases) {
      d = testDeps(new FakeClock(T0))
      const jobId = await enqueue({ behaviour: c.code === "diag_permanent" ? "permanent" : "succeed" })
      await c.setup(jobId)
      expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("dead_lettered")
      const row = await readJob(jobId)
      expect(row).toMatchObject({ status: "dead_lettered", attempts: 1, nextAttemptAt: null, lease: null, lastError: { code: c.code } })
      expect(row.finishedAt?.toMillis()).toBe(T0)
      const events = await jobEvents(jobId)
      expect(Object.keys(events).sort()).toEqual([`${jobId}_deadLettered_0`, `${jobId}_failed_1`])
      expect(events[`${jobId}_deadLettered_0`]).toMatchObject({
        name: "job.deadLettered",
        firmId,
        classification: "internal",
        idempotencyKey: `${jobId}_deadLettered_0`,
        payload: { jobId, jobType: c.jobType, attempts: 1, error: c.code },
      })
      expect(d.alerts).toEqual([{ jobId, jobType: c.jobType, firmId, attempts: 1, code: c.code }])
      expect(d.dispatcher.tasks).toEqual([])
      expect((await jobAuditRows(jobId)).map((r) => [r.action, r.reason])).toEqual([
        ["job.start", "ok"],
        ["job.dead_letter", c.code],
      ])
      expect(row.logs.map((l) => l.event)).toEqual(["enqueued", "claimed", "dead_lettered"])
    }
  })

  it("hang overruns the handler budget: retryable handler_timeout", async () => {
    d = testDeps(new FakeClock(T0), { handlerBudgetMs: 50 })
    const jobId = await enqueue({ behaviour: "hang" })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
    const row = await readJob(jobId)
    expect(row).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: { code: "handler_timeout", message: "The job exceeded its time budget." },
    })
    expect(d.dispatcher.tasks).toEqual([{ jobId, seq: 1, scheduleAt: T0 + 1000 }])
  })

  it("a seq ahead of dispatchSeq, a not-yet-due delivery (> 2 s early), a cancelled, done or non-engine row is dropped; 1.5 s early runs", async () => {
    const unchanged = async (jobId: string, before: Awaited<ReturnType<typeof readJob>>, audits: number) => {
      const after = await readJob(jobId)
      expect(after.updateTime.isEqual(before.updateTime)).toBe(true)
      expect(await jobAuditRows(jobId)).toHaveLength(audits)
    }

    // A seq ahead of dispatchSeq (0): never dispatched for this row, dropped.
    const jobId = await enqueue({ behaviour: "fail_times", failTimes: 2 })
    let before = await readJob(jobId)
    expect(await d.dispatcher.deliver({ jobId, seq: 1 }, T0)).toBe("dropped")
    await unchanged(jobId, before, 0)

    // After one failure (N = T0 + 1000): 2.5 s early is dropped, 1.5 s early runs.
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
    const N = T0 + 1000
    before = await readJob(jobId)
    const tasks = d.dispatcher.tasks.length
    expect(await d.dispatcher.deliver({ jobId, seq: 1 }, N - 2500)).toBe("dropped")
    await unchanged(jobId, before, 2)
    expect(d.dispatcher.tasks).toHaveLength(tasks)
    expect(await d.dispatcher.deliver({ jobId, seq: 1 }, N - 1500)).toBe("failed")

    // Cancelled.
    const cancelled = await enqueue({ behaviour: "succeed" })
    await jobsRef().doc(cancelled).update({ status: "cancelled" })
    before = await readJob(cancelled)
    expect(await d.dispatcher.deliver({ jobId: cancelled, seq: 0 }, T0)).toBe("dropped")
    await unchanged(cancelled, before, 0)

    // Done, delivered again.
    const done = await enqueue({ behaviour: "succeed" })
    expect(await d.dispatcher.deliver({ jobId: done, seq: 0 }, T0)).toBe("done")
    before = await readJob(done)
    expect(await d.dispatcher.deliver({ jobId: done, seq: 0 }, T0 + 10)).toBe("dropped")
    await unchanged(done, before, 2)
    expect(await diagCount(firmId, done)).toBe(1)

    // A row without the engine marker (the transitional writer's rows, P3-14).
    const legacy = await enqueue({ behaviour: "succeed" })
    await jobsRef().doc(legacy).update({ engine: FieldValue.delete() })
    before = await readJob(legacy)
    expect(await d.dispatcher.deliver({ jobId: legacy, seq: 0 }, T0)).toBe("dropped")
    await unchanged(legacy, before, 0)

    // A missing row.
    expect(await d.dispatcher.deliver({ jobId: "j-missing-" + uniq("x"), seq: 0 }, T0)).toBe("dropped")
  })

  it("a running row whose lease has not expired is dropped; an expired lease is reclaimed", async () => {
    const jobId = await enqueue({ behaviour: "succeed" })
    await jobsRef()
      .doc(jobId)
      .update({ status: "running", attempts: 1, totalAttempts: 1, lease: { owner: "w1", expiresAt: Timestamp.fromMillis(T0 + 600_000) } })
    const before = await readJob(jobId)
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0 + 599_999)).toBe("dropped")
    expect((await readJob(jobId)).updateTime.isEqual(before.updateTime)).toBe(true)
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0 + 600_000)).toBe("done")
    const row = await readJob(jobId)
    expect(row).toMatchObject({ status: "done", attempts: 2, totalAttempts: 2 })
    expect(row.logs.map((l) => l.event)).toEqual(["enqueued", "reclaimed", "done"])
    expect((await jobAuditRows(jobId)).map((r) => [r.action, r.reason])).toEqual([
      ["job.start", "lease_expired_reclaim"],
      ["job.done", "ok"],
    ])
  })

  it("a reclaim at attempt 4 dead-letters with lease_expired and alerts", async () => {
    const jobId = await enqueue({ behaviour: "succeed" })
    await jobsRef()
      .doc(jobId)
      .update({ status: "running", attempts: 4, totalAttempts: 4, lease: { owner: "w1", expiresAt: Timestamp.fromMillis(T0) } })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("dead_lettered")
    const row = await readJob(jobId)
    expect(row).toMatchObject({
      status: "dead_lettered",
      attempts: 4,
      totalAttempts: 4,
      lease: null,
      nextAttemptAt: null,
      lastError: { code: "lease_expired", message: "The job's worker stopped before finishing." },
    })
    expect(await diagCount(firmId, jobId)).toBe(0)
    expect(Object.keys(await jobEvents(jobId)).sort()).toEqual([`${jobId}_deadLettered_0`, `${jobId}_failed_4`])
    expect(d.alerts).toEqual([{ jobId, jobType: "platform.diagnostic", firmId, attempts: 4, code: "lease_expired" }])
    expect((await jobAuditRows(jobId)).map((r) => [r.action, r.reason])).toEqual([["job.dead_letter", "lease_expired"]])
  })

  it("runFenced after the fence is lost writes nothing and the commit is skipped", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const jobId = await enqueue({}, { jobType: "test.fenced" })
    jobWorkerTestSeam.afterClaim = async ({ jobId: id }) => {
      await jobsRef().doc(id).update({ "lease.owner": "intruder" })
    }
    let outcome: string
    try {
      outcome = await d.dispatcher.deliver({ jobId, seq: 0 }, T0)
    } finally {
      delete jobWorkerTestSeam.afterClaim
    }
    expect(outcome).toBe("lease_lost")
    expect((await fencedCounterRef(firmId, jobId).get()).exists).toBe(false)
    const row = await readJob(jobId)
    expect(row).toMatchObject({ status: "running", attempts: 1, lease: { owner: "intruder" } })
    expect(warn).toHaveBeenCalledWith("job.lease_lost", { jobId, jobType: "test.fenced" })
    expect((await jobAuditRows(jobId)).map((r) => r.action)).toEqual(["job.start"])
  })

  it("runFenced with the fence held commits its write and the job is done", async () => {
    const jobId = await enqueue({}, { jobType: "test.fenced" })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("done")
    expect((await fencedCounterRef(firmId, jobId).get()).get("count")).toBe(1)
  })

  it("a fenced step committed before a crash is not re-applied when another worker reclaims the job (P3-6 exactly once)", async () => {
    const jobId = await enqueue({}, { jobType: "test.fenced" })
    // Worker A commits its fenced step, then "crashes" before the done commit.
    jobWorkerTestSeam.afterHandler = async () => {
      throw new Error("worker A crashed")
    }
    try {
      await expect(d.dispatcher.deliver({ jobId, seq: 0 }, T0)).rejects.toThrow("worker A crashed")
    } finally {
      delete jobWorkerTestSeam.afterHandler
    }
    expect((await fencedCounterRef(firmId, jobId).get()).get("count")).toBe(1)
    expect(await readJob(jobId)).toMatchObject({ status: "running", attempts: 1 })
    // Worker B reclaims after the lease; the step is already recorded, so it is skipped.
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0 + 600_000)).toBe("done")
    expect((await fencedCounterRef(firmId, jobId).get()).get("count")).toBe(1)
    const row = await readJob(jobId)
    expect(row).toMatchObject({ status: "done", attempts: 2 })
    expect(Object.keys((row as unknown as { fencedSteps: Record<string, unknown> }).fencedSteps)).toEqual(["increment"])
  })

  it("two distinct fenced step ids each apply once, across a crash and a reclaim", async () => {
    const jobId = await enqueue({ steps: ["step-a", "step_b"] } as never, { jobType: "test.fenced" })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("done")
    expect((await fencedCounterRef(firmId, jobId).get()).get("count")).toBe(2)

    const crashed = await enqueue({ steps: ["step-a", "step_b"] } as never, { jobType: "test.fenced", idempotencyKey: uniq("k") })
    jobWorkerTestSeam.afterHandler = async () => {
      throw new Error("crash")
    }
    try {
      await expect(d.dispatcher.deliver({ jobId: crashed, seq: 0 }, T0)).rejects.toThrow("crash")
    } finally {
      delete jobWorkerTestSeam.afterHandler
    }
    expect(await d.dispatcher.deliver({ jobId: crashed, seq: 0 }, T0 + 600_000)).toBe("done")
    expect((await fencedCounterRef(firmId, crashed).get()).get("count")).toBe(2)
  })

  it("an invalid fenced step id, or more than 50 step ids in one job, fails permanently", async () => {
    for (const [steps, code] of [
      [["a.b"], "invalid_fenced_step"],
      [[""], "invalid_fenced_step"],
      [["x".repeat(101)], "invalid_fenced_step"],
      [["__x__"], "invalid_fenced_step"],
      [Array.from({ length: 51 }, (_, i) => `s${i}`), "fenced_step_limit"],
    ] as const) {
      d = testDeps(new FakeClock(T0))
      const jobId = await enqueue({ steps } as never, { jobType: "test.fenced", idempotencyKey: uniq("k") })
      expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("dead_lettered")
      expect(await readJob(jobId)).toMatchObject({ status: "dead_lettered", attempts: 1, lastError: { code } })
      const count = (await fencedCounterRef(firmId, jobId).get()).get("count") ?? 0
      expect(count).toBe(code === "fenced_step_limit" ? 50 : 0)
    }
  })

  it("a commit whose fence was lost after the handler writes nothing", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const jobId = await enqueue({ behaviour: "succeed" })
    jobWorkerTestSeam.afterHandler = async ({ jobId: id }) => {
      await jobsRef().doc(id).update({ "lease.owner": "intruder" })
    }
    let outcome: string
    try {
      outcome = await d.dispatcher.deliver({ jobId, seq: 0 }, T0)
    } finally {
      delete jobWorkerTestSeam.afterHandler
    }
    expect(outcome).toBe("lease_lost")
    expect(await diagCount(firmId, jobId)).toBe(0)
    expect(await readJob(jobId)).toMatchObject({ status: "running", lease: { owner: "intruder" } })
    expect(warn).toHaveBeenCalledWith("job.lease_lost", { jobId, jobType: "platform.diagnostic" })
  })

  it("logs keep the last 50 entries", async () => {
    const jobId = await enqueue({ behaviour: "succeed" })
    const seeded = Array.from({ length: 50 }, (_, i) => ({ at: Timestamp.fromMillis(T0 - 50 + i), event: "enqueued", attempt: 0 }))
    await jobsRef().doc(jobId).update({ logs: seeded })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("done")
    const row = await readJob(jobId)
    expect(row.logs).toHaveLength(50)
    expect(row.logs.at(-2)?.event).toBe("claimed")
    expect(row.logs.at(-1)?.event).toBe("done")
    expect(row.logs[0].at.toMillis()).toBe(T0 - 48)
  })

  it("a failure whose audit row cannot be staged aborts its transaction and leaves the job unchanged", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined)
    const jobId = await enqueue({ behaviour: "fail_times", failTimes: 1 })
    // After the claim, the stored row loses createdBy, so the job.fail audit row cannot be built.
    jobWorkerTestSeam.afterClaim = async ({ jobId: id }) => {
      await jobsRef().doc(id).update({ createdBy: FieldValue.delete() })
    }
    let before: Awaited<ReturnType<typeof readJob>>
    try {
      jobWorkerTestSeam.afterHandler = async ({ jobId: id }) => {
        before = await readJob(id)
      }
      await expect(d.dispatcher.deliver({ jobId, seq: 0 }, T0)).rejects.toThrow("job audit: invalid subject")
    } finally {
      delete jobWorkerTestSeam.afterClaim
      delete jobWorkerTestSeam.afterHandler
    }
    const row = await readJob(jobId)
    expect(row.updateTime.isEqual(before!.updateTime)).toBe(true)
    expect(row).toMatchObject({ status: "running", attempts: 1, dispatchSeq: 0, lastError: null })
    expect(await jobEvents(jobId)).toEqual({})
    expect((await jobAuditRows(jobId)).map((r) => r.action)).toEqual(["job.start"])
    expect(d.dispatcher.tasks).toEqual([])
    expect(error).toHaveBeenCalledWith("job commit failed", { code: "unknown" })
  })

  it("a queued or failed row already at the attempt cap is never claimed", async () => {
    for (const status of ["queued", "failed"] as const) {
      const jobId = await enqueue({ behaviour: "succeed" })
      await jobsRef().doc(jobId).update({ status, attempts: 4, totalAttempts: 4 })
      const before = await readJob(jobId)
      expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("dropped")
      expect((await readJob(jobId)).updateTime.isEqual(before.updateTime)).toBe(true)
      expect(await diagCount(firmId, jobId)).toBe(0)
    }
  })

  it("an apply that throws commits nothing it staged and records a retryable internal failure", async () => {
    const jobId = await enqueue({ mode: "throwApply" } as never, { jobType: "test.misbehave" })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
    expect((await misbehaveMarkerRef(jobId).get()).exists).toBe(false)
    const row = await readJob(jobId)
    expect(row).toMatchObject({ status: "failed", attempts: 1, dispatchSeq: 1, lastError: { code: "internal" }, outputRefs: [] })
    expect((await jobAuditRows(jobId)).map((r) => [r.action, r.reason])).toEqual([
      ["job.start", "ok"],
      ["job.fail", "internal"],
    ])
    expect(d.dispatcher.tasks).toEqual([{ jobId, seq: 1, scheduleAt: T0 + 1000 }])
  })

  it("an apply whose write Firestore rejects at commit (ALREADY_EXISTS) records a retryable internal failure and applies nothing", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined)
    const jobId = await enqueue({ mode: "createExisting" } as never, { jobType: "test.misbehave" })
    await misbehaveExistingRef(jobId).set({ by: "test" })
    const existingBefore = await misbehaveExistingRef(jobId).get()
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
    // Nothing of the handler's result is written; the pre-existing doc is untouched.
    expect((await misbehaveMarkerRef(jobId).get()).exists).toBe(false)
    const existingAfter = await misbehaveExistingRef(jobId).get()
    expect(existingAfter.data()).toEqual({ by: "test" })
    expect(existingAfter.updateTime?.isEqual(existingBefore.updateTime!)).toBe(true)
    const row = await readJob(jobId)
    expect(row).toMatchObject({
      status: "failed",
      attempts: 1,
      dispatchSeq: 1,
      lease: null,
      lastError: { code: "internal", message: "The job failed with an internal error." },
      outputRefs: [],
    })
    expect(row.logs.map((l) => [l.event, l.code ?? null])).toEqual([
      ["enqueued", null],
      ["claimed", null],
      ["failed", "internal"],
    ])
    expect((await jobAuditRows(jobId)).map((r) => [r.action, r.reason])).toEqual([
      ["job.start", "ok"],
      ["job.fail", "internal"],
    ])
    expect(Object.keys(await jobEvents(jobId))).toEqual([`${jobId}_failed_1`])
    expect(d.dispatcher.tasks).toEqual([{ jobId, seq: 1, scheduleAt: T0 + 1000 }])
    // The rejection is logged by its gRPC code only.
    expect(error).toHaveBeenCalledWith("job commit rejected", { jobId, code: "already_exists" })
    expect(JSON.stringify(error.mock.calls)).not.toContain("misbehave_existing")
  })

  it("a rejected apply at the attempt cap dead-letters with the sanitised code and alerts", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined)
    const jobId = await enqueue({ mode: "createExisting" } as never, { jobType: "test.misbehave" })
    await jobsRef().doc(jobId).update({ attempts: 3, totalAttempts: 3 })
    await misbehaveExistingRef(jobId).set({ by: "test" })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("dead_lettered")
    expect((await misbehaveMarkerRef(jobId).get()).exists).toBe(false)
    expect((await misbehaveExistingRef(jobId).get()).data()).toEqual({ by: "test" })
    expect(await readJob(jobId)).toMatchObject({ status: "dead_lettered", attempts: 4, lease: null, nextAttemptAt: null, lastError: { code: "internal" } })
    expect(Object.keys(await jobEvents(jobId)).sort()).toEqual([`${jobId}_deadLettered_0`, `${jobId}_failed_4`])
    expect((await jobAuditRows(jobId)).map((r) => [r.action, r.reason])).toEqual([
      ["job.start", "ok"],
      ["job.dead_letter", "internal"],
    ])
    expect(d.alerts).toEqual([{ jobId, jobType: "test.misbehave", firmId, attempts: 4, code: "internal" }])
    expect(d.dispatcher.tasks).toEqual([])
  })

  it("a rejected apply whose fence is lost before the failure commit writes nothing", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined)
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const jobId = await enqueue({ mode: "createExisting" } as never, { jobType: "test.misbehave" })
    await misbehaveExistingRef(jobId).set({ by: "test" })
    jobWorkerTestSeam.beforeCommit = async ({ jobId: id, fallback }) => {
      if (fallback) await jobsRef().doc(id).update({ "lease.owner": "intruder" })
    }
    let outcome: string
    try {
      outcome = await d.dispatcher.deliver({ jobId, seq: 0 }, T0)
    } finally {
      delete jobWorkerTestSeam.beforeCommit
    }
    expect(outcome).toBe("lease_lost")
    expect((await misbehaveMarkerRef(jobId).get()).exists).toBe(false)
    expect(await readJob(jobId)).toMatchObject({ status: "running", attempts: 1, dispatchSeq: 0, lastError: null, lease: { owner: "intruder" } })
    expect((await jobAuditRows(jobId)).map((r) => r.action)).toEqual(["job.start"])
    expect(await jobEvents(jobId)).toEqual({})
    expect(d.dispatcher.tasks).toEqual([])
    expect(warn).toHaveBeenCalledWith("job.lease_lost", { jobId, jobType: "test.misbehave" })
  })

  it("a transient commit error leaves the job running for lease recovery and logs the code only", async () => {
    for (const [grpc, name] of [
      [10, "aborted"],
      [14, "unavailable"],
      [4, "deadline_exceeded"],
    ] as const) {
      vi.restoreAllMocks()
      const error = vi.spyOn(logger, "error").mockImplementation(() => undefined)
      d = testDeps(new FakeClock(T0))
      const jobId = await enqueue({ behaviour: "succeed" })
      const marker = uniq("transient")
      let calls = 0
      jobWorkerTestSeam.beforeCommit = async () => {
        calls++
        throw Object.assign(new Error(`store hiccup ${marker}`), { code: grpc })
      }
      try {
        await expect(d.dispatcher.deliver({ jobId, seq: 0 }, T0)).rejects.toMatchObject({ code: grpc })
      } finally {
        delete jobWorkerTestSeam.beforeCommit
      }
      expect(calls).toBe(1)
      expect(await diagCount(firmId, jobId)).toBe(0)
      expect(await readJob(jobId)).toMatchObject({ status: "running", attempts: 1, dispatchSeq: 0, lastError: null })
      expect((await jobAuditRows(jobId)).map((r) => r.action)).toEqual(["job.start"])
      expect(await jobEvents(jobId)).toEqual({})
      expect(d.dispatcher.tasks).toEqual([])
      expect(error).toHaveBeenCalledWith("job commit failed", { code: name })
      expect(JSON.stringify(error.mock.calls)).not.toContain(marker)
    }
  })

  it("invalid outputRefs apply nothing and record a retryable internal failure; valid ones are stored", async () => {
    const bad = await enqueue({ mode: "badRefs" } as never, { jobType: "test.misbehave" })
    expect(await d.dispatcher.deliver({ jobId: bad, seq: 0 }, T0)).toBe("failed")
    expect((await misbehaveMarkerRef(bad).get()).exists).toBe(false)
    expect(await readJob(bad)).toMatchObject({ status: "failed", lastError: { code: "internal" }, outputRefs: [] })

    // Refs into matter-bound collections (matters/m1, documents/d2) are valid on a matter job only (audit F14 R1-D3).
    const good = await enqueue({ mode: "refs" } as never, { jobType: "test.misbehave", matterId: uniq("matter") })
    expect(await d.dispatcher.deliver({ jobId: good, seq: 0 }, T0)).toBe("done")
    expect((await misbehaveMarkerRef(good).get()).get("count")).toBe(1)
    expect(await readJob(good)).toMatchObject({ status: "done", outputRefs: ["matters/m1", "documents/d2"] })

    // The same refs from a firm-level job (matterId null) are a handler bug: nothing applied, a retryable internal failure.
    const firmLevel = await enqueue({ mode: "refs" } as never, { jobType: "test.misbehave" })
    expect(await d.dispatcher.deliver({ jobId: firmLevel, seq: 0 }, T0)).toBe("failed")
    expect((await misbehaveMarkerRef(firmLevel).get()).exists).toBe(false)
    expect(await readJob(firmLevel)).toMatchObject({ status: "failed", matterId: null, lastError: { code: "internal" }, outputRefs: [] })
  })

  it("a parse that throws a plain Error is the permanent invalid_payload", async () => {
    const jobId = await enqueue({ mode: "rawParse" } as never, { jobType: "test.misbehave" })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("dead_lettered")
    expect(await readJob(jobId)).toMatchObject({
      status: "dead_lettered",
      attempts: 1,
      lastError: { code: "invalid_payload", message: "The job's payload is invalid." },
    })
    expect(d.alerts).toEqual([{ jobId, jobType: "test.misbehave", firmId, attempts: 1, code: "invalid_payload" }])
  })

  it("a LeaseLostError thrown while the fence still holds is recorded as a failure, not trusted", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const jobId = await enqueue({ mode: "leaseLost" } as never, { jobType: "test.misbehave" })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
    expect(await readJob(jobId)).toMatchObject({ status: "failed", lease: null, lastError: { code: "internal" } })
    expect(warn).not.toHaveBeenCalledWith("job.lease_lost", expect.anything())
  })

  it("the default alert logs job.deadLettered with codes only", async () => {
    const registered = spyRegisteredErrors()
    await logDeadLetterAlert.deadLettered({ jobId: "j1", jobType: "t", firmId: "f", attempts: 4, code: "internal" })
    expect(registered.fieldsOf("job.deadLettered")).toEqual([{ jobId: "j1", jobType: "t", firmId: "f", attempts: 4, code: "internal" }])
    registered.restore()
  })

  it("a raw error is sanitised to internal and its text is stored nowhere", async () => {
    const marker = uniq("poison")
    const jobId = await enqueue({ behaviour: "throw_raw", marker })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
    const row = await readJob(jobId)
    expect(row.lastError).toEqual({ code: "internal", message: "The job failed with an internal error." })
    expect(JSON.stringify({ ...row, payload: null })).not.toContain(marker)
    expect(JSON.stringify(await jobEvents(jobId))).not.toContain(marker)
    expect(JSON.stringify(await jobAuditRows(jobId))).not.toContain(marker)
  })

  it("a dispatch failure after a failed attempt is logged and swallowed", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined)
    const jobId = await enqueue({ behaviour: "fail_times", failTimes: 1 })
    d.dispatcher.dispatch = async () => {
      throw Object.assign(new Error("queue down"), { code: "unavailable" })
    }
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
    expect(error).toHaveBeenCalledWith("job dispatch failed", { code: "unavailable" })
    expect(await readJob(jobId)).toMatchObject({ status: "failed", dispatchSeq: 1 })
  })
})
