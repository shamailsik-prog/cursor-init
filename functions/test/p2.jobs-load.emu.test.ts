import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { DISPATCH_GRACE_MS, redispatchBackoffMs } from "../src/p2/constants"
import type { JobDeps, JobDispatcher, JobTask } from "../src/p2/dispatch"
import { enqueueJobs, type JobSpec } from "../src/p2/enqueue"
import { JobError } from "../src/p2/errors"
import { jobTestSeam, type JobHandler } from "../src/p2/registry"
import { sweep, sweepTestSeam } from "../src/p2/sweeper"
import { runJobTask, type TaskOutcome } from "../src/p2/worker"
import { EMULATORS, uniq } from "./emu"
import { FakeClock, newFirm, readJob, sweepOrigins } from "./jobs"

/**
 * The long-handler load test (spec P3-37, O-36). The store, `sweep()` and the worker
 * (`runJobTask`) are real; the clock is virtual and the queue is a model:
 *
 * - `JOBS` jobs of the test type `test.long` are enqueued at the origin, and the trigger's task
 *   (seq 0) for each is dispatched at once, in enqueue order.
 * - The queue has `SLOTS` concurrent slots and delivers strictly FIFO. A delivery the worker drops
 *   frees its slot at once; a delivery that claims holds its slot while the handler runs, which is
 *   `HOLD_MS` of virtual time (the handler awaits a gate the model opens when the clock gets there).
 * - A sweep runs every `SWEEP_EVERY_MS`. At one instant the model first finishes the handlers due,
 *   then sweeps, then fills free slots from the head of the queue.
 * - The run ends when every job is `done` or after `HORIZON_MS`.
 *
 * The model is deliberately pessimistic (P3-37): all slots stay busy and every re-dispatched task
 * joins the tail, behind every task already queued.
 */

const JOBS = 250
const SLOTS = 10
const HOLD_MS = 240_000
const SWEEP_EVERY_MS = 60_000
const HORIZON_MS = 6 * 3_600_000
/** The fixed run's total tasks must be at most the control's divided by this (P3-37). */
const CONTROL_RATIO = 5
const JOB_TYPE = "test.long"

const nextOrigin = sweepOrigins(400)

/**
 * The P3-35 re-send schedule for one waiting row, in ms after its enqueue, derived from
 * `redispatchBackoffMs` on the sweep grid: re-send i + 1 is the first sweep at least
 * `redispatchBackoffMs(i)` after re-send i (re-send 0 is the trigger's dispatch at enqueue). With the
 * pinned constants: 60, 120, 240, 480, 960, 1560, 2160, 2760, 3360 s, then every 600 s.
 */
function resendSchedule(untilMs: number): number[] {
  const points: number[] = []
  let last = 0
  for (let i = 0; ; i++) {
    const next = Math.ceil((last + redispatchBackoffMs(i)) / SWEEP_EVERY_MS) * SWEEP_EVERY_MS
    if (next > untilMs) return points
    points.push(next)
    last = next
  }
}

const SCHEDULE = resendSchedule(HORIZON_MS)

/** The re-sends P3-35 allows a row that has waited `waitMs`: the schedule points at or before it. */
const allowedResends = (waitMs: number): number => SCHEDULE.filter((p) => p <= waitMs).length

/** P3-37's per-job bound: the trigger's task, the allowed re-sends, and one sweep of slack. */
const taskBound = (waitMs: number): number => 1 + allowedResends(waitMs) + 1

type Metrics = {
  tasksPerJob: Map<string, number>
  /** Jobs whose tasks exceed `taskBound` of their wait (enqueue to claim, or to the end of the run). */
  overBound: number
  /** The sum over jobs of `taskBound` of each job's wait. */
  budget: number
  maxTasks: number
  meanTasks: number
  totalTasks: number
  /** Virtual ms from the origin until the last job was done, or null if the horizon came first. */
  completedAfterMs: number | null
  done: number
  outcomes: Record<string, number>
  /** For each job, the longest wait past eligibility without a dispatch or claim, minus that period's backoff (must be <= 0). */
  worstOverrun: number
  realMs: number
}

/** Cloud Tasks stand-in: dedupes by `${jobId}-${seq}`, records each task's dispatch time, delivers FIFO. */
class FifoQueue implements JobDispatcher {
  readonly pending: JobTask[] = []
  readonly log: Array<JobTask & { at: number }> = []
  private readonly ids = new Set<string>()

  constructor(private readonly clock: FakeClock) {}

  async dispatch(task: JobTask): Promise<void> {
    const id = `${task.jobId}-${task.seq}`
    if (this.ids.has(id)) return
    this.ids.add(id)
    this.pending.push({ jobId: task.jobId, seq: task.seq })
    this.log.push({ jobId: task.jobId, seq: task.seq, at: this.clock.now() })
  }
}

/** Gates the `test.long` handler: `started` is told when a handler begins, `release` ends it. */
const gates = new Map<string, () => void>()
const starters = new Map<string, () => void>()

const longHandler: JobHandler<Record<string, unknown>> = {
  jobType: JOB_TYPE,
  saga: false,
  errorCodes: {},
  parse: (payload) => {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new JobError("invalid_payload", { permanent: true })
    return payload as Record<string, unknown>
  },
  run: async (ctx) => {
    const gate = new Promise<void>((resolve) => gates.set(ctx.job.id, resolve))
    starters.get(ctx.job.id)?.()
    await gate
    return {}
  },
}

async function scenario(firmId: string, origin: number, backoff: (n: number) => number): Promise<Metrics> {
  const started = Date.now()
  const clock = new FakeClock(origin)
  const queue = new FifoQueue(clock)
  const deps: JobDeps = { dispatcher: queue, clock: () => clock.now(), alert: { deadLettered: () => undefined }, handlerBudgetMs: 3_600_000 }

  // Enqueue at the origin, 100 per transaction, then the trigger's seq-0 tasks in enqueue order.
  const ids: string[] = []
  for (let i = 0; i < JOBS; i += 100) {
    const specs: JobSpec[] = Array.from({ length: Math.min(100, JOBS - i) }, () => ({
      firmId,
      jobType: JOB_TYPE,
      classification: "internal",
      matterId: null,
      payload: {},
      idempotencyKey: uniq("k"),
      createdBy: "system",
    }))
    ids.push(...(await adminDb().runTransaction((tx) => enqueueJobs(tx, specs, { now: origin }))).map((r) => r.jobId))
  }
  for (const jobId of ids) await queue.dispatch({ jobId, seq: 0 })

  const running = new Map<string, { until: number; run: Promise<TaskOutcome> }>()
  const claimedAt = new Map<string, number>()
  const outcomes: Record<string, number> = {}
  let done = 0
  const count = (o: TaskOutcome) => (outcomes[o] = (outcomes[o] ?? 0) + 1)

  /** Delivers queued tasks from the head while a slot is free. */
  const fill = async (t: number) => {
    while (running.size < SLOTS && queue.pending.length > 0) {
      const task = queue.pending.shift()!
      clock.set(t)
      let onStart!: () => void
      const startedP = new Promise<"started">((resolve) => (onStart = () => resolve("started")))
      starters.set(task.jobId, onStart)
      const run = runJobTask(task, deps)
      const first = await Promise.race([run, startedP])
      starters.delete(task.jobId)
      if (first === "started") {
        claimedAt.set(task.jobId, t)
        running.set(task.jobId, { until: t + HOLD_MS, run })
      } else count(first)
    }
  }

  const end = origin + HORIZON_MS
  let nextSweep = origin + SWEEP_EVERY_MS
  let t = origin
  let completedAt: number | null = null
  await fill(t)
  while (done < JOBS) {
    const nextDone = Math.min(...[...running.values()].map((r) => r.until))
    t = Math.min(nextDone, nextSweep)
    if (t > end) break
    for (const [jobId, r] of [...running.entries()].filter(([, r]) => r.until === t)) {
      clock.set(t)
      gates.get(jobId)!()
      gates.delete(jobId)
      const outcome = await r.run
      count(outcome)
      running.delete(jobId)
      if (outcome === "done") done++
    }
    if (done === JOBS) {
      completedAt = t
      break
    }
    if (t === nextSweep) {
      clock.set(t)
      await sweep(deps)
      nextSweep += SWEEP_EVERY_MS
    }
    await fill(t)
  }
  // A run cut off by the horizon leaves handlers waiting: release them so nothing dangles.
  for (const [jobId, r] of running) {
    gates.get(jobId)?.()
    await r.run.catch(() => undefined)
  }

  // Tasks per job and starvation: between one dispatch of a job and its next dispatch or claim, the
  // wait past eligibility (last dispatch + backoff(redispatches so far)) is at most that backoff.
  const byJob = new Map<string, number[]>(ids.map((id) => [id, []]))
  for (const task of queue.log) byJob.get(task.jobId)!.push(task.at)
  let worstOverrun = -Infinity
  for (const [jobId, times] of byJob) {
    const claim = claimedAt.get(jobId)
    times.forEach((at, i) => {
      const next = times[i + 1] ?? claim ?? clock.now()
      const eligible = at + backoff(i)
      worstOverrun = Math.max(worstOverrun, next - eligible - backoff(i))
    })
  }
  const tasksPerJob = new Map([...byJob].map(([id, times]) => [id, times.length]))
  const boundOf = (id: string) => taskBound((claimedAt.get(id) ?? clock.now()) - origin)
  const overBound = [...byJob].filter(([id, times]) => times.length > boundOf(id)).length
  const budget = ids.reduce((sum, id) => sum + boundOf(id), 0)
  const counts = [...tasksPerJob.values()]
  return {
    tasksPerJob,
    overBound,
    budget,
    maxTasks: Math.max(...counts),
    meanTasks: counts.reduce((a, b) => a + b, 0) / counts.length,
    totalTasks: queue.log.length,
    completedAfterMs: completedAt === null ? null : completedAt - origin,
    done,
    outcomes,
    worstOverrun,
    realMs: Date.now() - started,
  }
}

function report(label: string, m: Metrics): void {
  const line = {
    label,
    jobs: JOBS,
    done: m.done,
    maxTasks: m.maxTasks,
    overBound: m.overBound,
    budget: m.budget,
    meanTasks: Number(m.meanTasks.toFixed(2)),
    totalTasks: m.totalTasks,
    completedAfterMin: m.completedAfterMs === null ? null : m.completedAfterMs / 60_000,
    worstOverrunMs: m.worstOverrun,
    outcomes: m.outcomes,
    realS: Number((m.realMs / 1000).toFixed(1)),
  }
  process.stdout.write(`P3-37 ${JSON.stringify(line)}\n`)
}

describe.skipIf(!EMULATORS)("P2 long-handler load test (P3-37, O-36)", () => {
  let firmId: string

  beforeEach(async () => {
    firmId = await newFirm()
    jobTestSeam.handlers.set(JOB_TYPE, longHandler as JobHandler)
  })

  afterEach(() => {
    jobTestSeam.handlers.delete(JOB_TYPE)
    delete sweepTestSeam.backoffMs
    gates.clear()
    starters.clear()
  })

  it(`${JOBS} jobs, 240 s handlers, 10 FIFO slots: every job done, none starved, tasks within the P3-35 schedule and at most 1/${CONTROL_RATIO} of the fixed-grace control's`, async () => {
    expect(SCHEDULE.slice(0, 11).map((p) => p / 1000)).toEqual([60, 120, 240, 480, 960, 1560, 2160, 2760, 3360, 3960, 4560])

    const fixed = await scenario(firmId, nextOrigin(), redispatchBackoffMs)
    report("fixed", fixed)
    expect(fixed.done).toBe(JOBS)
    expect(fixed.completedAfterMs).not.toBeNull()
    expect(fixed.worstOverrun).toBeLessThanOrEqual(0)
    expect(fixed.overBound).toBe(0)
    const sample = await readJob([...fixed.tasksPerJob.keys()].at(-1)!)
    expect([sample.status, sample.attempts]).toEqual(["done", 1])

    // Control: the same scenario with the backoff forced to the fixed grace (the pre-P3-35 sweeper).
    const fixedGrace = () => DISPATCH_GRACE_MS
    sweepTestSeam.backoffMs = fixedGrace
    let control: Metrics
    try {
      control = await scenario(firmId, nextOrigin(), fixedGrace)
    } finally {
      delete sweepTestSeam.backoffMs
    }
    report("control", control)
    expect(control.done).toBe(JOBS)
    expect(control.worstOverrun).toBeLessThanOrEqual(0)

    // Total tasks: the fix is at most a fifth of the control.
    expect(fixed.totalTasks * CONTROL_RATIO).toBeLessThanOrEqual(control.totalTasks)
    // The bounds bite: the control breaks the per-job schedule bound for some job, and the ratio
    // holds strictly from its side (the control sends more than CONTROL_RATIO times the fix's tasks).
    expect(control.overBound).toBeGreaterThan(0)
    expect(control.totalTasks).toBeGreaterThan(CONTROL_RATIO * fixed.totalTasks)
    // And its total exceeds the sum of the per-job bounds for its own waits.
    expect(control.totalTasks).toBeGreaterThan(control.budget)
  }, 600_000)
})
