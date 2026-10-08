/**
 * P2 Job Engine pinned values (spec P3-2..P3-8). Pure: no Firestore, no I/O.
 * The lease / timeout / budget relation is asserted at module load, as
 * `http/idempotency.ts` does for its own lease, so an inconsistent edit fails the first import.
 */

/** The six job statuses, in P3-3 order. */
export const JOB_STATUSES = ["queued", "running", "failed", "done", "dead_lettered", "cancelled"] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

/** Marks rows written by this engine (P3-2, P3-14). */
export const JOB_ENGINE = "p2"
export const JOB_SCHEMA_VERSION = 1

/** One attempt plus three automatic retries per round (P3-7). */
export const MAX_ATTEMPTS = 4
/** Manual requeues of a dead-lettered job (P3-12). */
export const MAX_MANUAL_RETRIES = 3
/** Delay before automatic retry n (after attempt n), P3-7. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 5000, 25000]
/** A claim's lease (P3-6). */
export const JOB_LEASE_MS = 600_000
/** The worker function's timeout (P3-5). */
export const JOB_WORKER_TIMEOUT_SECONDS = 300
/** The handler's time budget inside one attempt (P3-6). */
export const JOB_HANDLER_BUDGET_MS = 240_000
/** The sweeper re-dispatches only rows due, and last dispatched, this long ago (P3-8). */
export const DISPATCH_GRACE_MS = 30_000
/** A delivery up to this early still runs (P3-6, P3-8). */
export const CLOCK_SKEW_TOLERANCE_MS = 2_000
/** A `dispatchedAt` further than this in the future is not trusted (P3-8). */
export const MAX_CLOCK_SKEW_MS = 300_000
/** Rows per sweeper query (P3-8). */
export const SWEEP_LIMIT = 100
/** Serialised (canonical JSON) payload limit (P3-2). */
export const MAX_PAYLOAD_BYTES = 16_384
/** Log entries kept on a job row, oldest dropped first (P3-2). */
export const MAX_LOG_ENTRIES = 50
/** Input and output refs per job (P3-2). */
export const MAX_REFS = 20

/**
 * The lease must outlive the worker timeout by at least 60 s (so a live attempt is never
 * reclaimed), and the handler budget must end before the worker timeout (so a timeout is
 * recorded as `handler_timeout`, not lost with the instance).
 */
export function assertJobTimings(leaseMs: number, timeoutSeconds: number, budgetMs: number): void {
  if (!(leaseMs >= timeoutSeconds * 1000 + 60_000)) {
    throw new Error(`job lease (${leaseMs} ms) must exceed the worker timeout (${timeoutSeconds} s) by at least 60 s`)
  }
  if (!(budgetMs < timeoutSeconds * 1000)) {
    throw new Error(`job handler budget (${budgetMs} ms) must be less than the worker timeout (${timeoutSeconds} s)`)
  }
}

assertJobTimings(JOB_LEASE_MS, JOB_WORKER_TIMEOUT_SECONDS, JOB_HANDLER_BUDGET_MS)
