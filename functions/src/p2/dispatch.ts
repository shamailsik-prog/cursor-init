import { getFunctions } from "firebase-admin/functions"
import { adminApp } from "../admin"
import { REGION } from "../health"
import { JOB_HANDLER_BUDGET_MS } from "./constants"
import { logDeadLetterAlert, type DeadLetterAlert } from "./jobEvents"

/**
 * The worker's dependencies (spec P3-5, P3-6, §7). A task body is `{ jobId, seq }` and nothing
 * else: no payload value leaves the job row. Cloud Tasks names a task `${jobId}-${seq}`, so a
 * repeated dispatch of the same seq is deduplicated.
 */

export type JobTask = { jobId: string; seq: number }

export interface JobDispatcher {
  /** Enqueues delivery of `task`, no earlier than `opts.scheduleAt` (epoch ms) when given. */
  dispatch(task: JobTask, opts?: { scheduleAt?: number }): Promise<void>
}

export type JobDeps = {
  dispatcher: JobDispatcher
  /** The acting function's clock (epoch ms); every job time field is written from it. */
  clock: () => number
  alert: DeadLetterAlert
  /** The handler's time budget (`JOB_HANDLER_BUDGET_MS` in production). */
  handlerBudgetMs: number
}

/** The slice of the Admin SDK's `TaskQueue` the dispatcher uses (a fake in tests). */
export type TaskQueueLike = { enqueue(data: JobTask, opts: { id: string; scheduleTime?: Date }): Promise<void> }

/** The `jobWorker` queue (P3-5). */
export const JOB_WORKER_QUEUE = `locations/${REGION}/functions/jobWorker`

function workerQueue(): TaskQueueLike {
  const queue = getFunctions(adminApp()).taskQueue<JobTask>(JOB_WORKER_QUEUE)
  return { enqueue: (data, opts) => queue.enqueue(data, opts) }
}

/** Cloud Tasks reports a repeated task id with this code: the task is already queued, so the dispatch succeeded. */
const TASK_EXISTS = "functions/task-already-exists"

/**
 * The production dispatcher (P3-5): enqueues `{ jobId, seq }` on the `jobWorker` queue as task
 * `${jobId}-${seq}`, at `scheduleAt` when given. The queue is resolved on the first dispatch, so
 * constructing one does no work (no Admin app, no network).
 */
export class CloudTasksDispatcher implements JobDispatcher {
  private queue: TaskQueueLike | undefined

  constructor(private readonly resolveQueue: () => TaskQueueLike = workerQueue) {}

  async dispatch(task: JobTask, opts: { scheduleAt?: number } = {}): Promise<void> {
    this.queue ??= this.resolveQueue()
    const options: { id: string; scheduleTime?: Date } = { id: `${task.jobId}-${task.seq}` }
    if (opts.scheduleAt !== undefined) options.scheduleTime = new Date(opts.scheduleAt)
    try {
      await this.queue.enqueue({ jobId: task.jobId, seq: task.seq }, options)
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === TASK_EXISTS) return
      throw err
    }
  }
}

/** The production deps: Cloud Tasks, the wall clock, the log-based alert and the pinned budget. */
export function defaultDeps(): JobDeps {
  return { dispatcher: new CloudTasksDispatcher(), clock: Date.now, alert: logDeadLetterAlert, handlerBudgetMs: JOB_HANDLER_BUDGET_MS }
}

/** Test seam: deps the routes and function wrappers use instead of the defaults, set in a test and deleted after. */
export const jobRuntime: { deps?: JobDeps } = {}

/** The deps for a route or function wrapper: the `jobRuntime` override, else `defaultDeps()`. */
export function runtimeDeps(): JobDeps {
  return jobRuntime.deps ?? defaultDeps()
}
