import type { DeadLetterAlert } from "./jobEvents"

/**
 * The worker's dependencies (spec P3-5, P3-6, §7). A task body is `{ jobId, seq }` and nothing
 * else: no payload value leaves the job row. Cloud Tasks names a task `${jobId}-${seq}`, so a
 * repeated dispatch of the same seq is deduplicated. Task 4 adds `CloudTasksDispatcher`,
 * `defaultDeps()` and the `jobRuntime` seam.
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
