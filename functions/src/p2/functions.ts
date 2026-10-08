import type { DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { onTaskDispatched } from "firebase-functions/v2/tasks"
import { REGION } from "../health"
import { logFailure } from "../log"
import { isSafeDocId } from "../p5/common"
import { JOB_ENGINE, JOB_WORKER_TIMEOUT_SECONDS } from "./constants"
import { runtimeDeps, type JobDeps, type JobTask } from "./dispatch"
import { sweep } from "./sweeper"
import { runJobTask } from "./worker"

/**
 * The job runtime's deployed functions (spec P3-5, P3-8): the creation trigger that dispatches a
 * new job, the Cloud Tasks worker, and the per-minute sweeper. Each takes its deps from
 * `runtimeDeps()`; the cores (`onJobCreatedCore`, `parseJobTask`, `runJobTask`, `sweep`) are what
 * the tests drive.
 */

/**
 * A new job row → dispatch `{ jobId, seq: 0 }`. Rows without `engine: "p2"` (the legacy Next.js
 * `jobs` writer) are ignored. A repeated trigger reuses task `${jobId}-0`, which Cloud Tasks
 * dedupes. A dispatch failure is logged by code and swallowed: the sweeper re-dispatches the due
 * row after `DISPATCH_GRACE_MS`.
 */
export async function onJobCreatedCore(jobId: string, data: DocumentData | undefined, deps: JobDeps): Promise<void> {
  if (data?.engine !== JOB_ENGINE) return
  try {
    await deps.dispatcher.dispatch({ jobId, seq: 0 })
  } catch (err) {
    logFailure("job dispatch failed", err)
  }
}

/** A task body is exactly `{ jobId, seq }`: a safe doc id and a non-negative safe integer, nothing else. */
export function parseJobTask(data: unknown): JobTask | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null
  const keys = Object.keys(data)
  if (keys.length !== 2 || !keys.includes("jobId") || !keys.includes("seq")) return null
  const { jobId, seq } = data as Record<string, unknown>
  if (!isSafeDocId(jobId)) return null
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null
  return { jobId, seq }
}

// O-33: a Firestore trigger must run in the database's region. This assumes the default database
// is in asia-south1; if it is not, deploy this trigger in the database's region or drop it, and
// the sweeper's query A alone dispatches new jobs (within about 90 s).
export const onJobCreated = onDocumentCreated({ document: "jobs/{jobId}", region: REGION }, (event) =>
  onJobCreatedCore(event.params.jobId, event.data?.data(), runtimeDeps())
)

/**
 * The worker queue (P3-5). Every job-level outcome answers 2xx; `runJobTask` throws only when it
 * cannot read, claim or commit (the store is unavailable), so Cloud Tasks' own retry covers
 * infrastructure faults and never schedules job retries. Cloud Tasks invokes it with OIDC; it
 * acts only on the job id it is given.
 */
export const jobWorker = onTaskDispatched(
  {
    region: REGION,
    timeoutSeconds: JOB_WORKER_TIMEOUT_SECONDS,
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 10, maxBackoffSeconds: 60 },
    rateLimits: { maxConcurrentDispatches: 10, maxDispatchesPerSecond: 5 },
  },
  async (req) => {
    const task = parseJobTask(req.data)
    if (!task) {
      // The body is not echoed: only the fact that it was invalid.
      logger.warn("job.task_invalid")
      return
    }
    await runJobTask(task, runtimeDeps())
  }
)

/** The safety net (P3-8): re-dispatches lost dispatches and expired leases every minute. */
export const jobSweeper = onSchedule({ schedule: "every 1 minutes", region: REGION }, async () => {
  await sweep(runtimeDeps())
})
