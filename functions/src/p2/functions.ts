import type { DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { onTaskDispatched } from "firebase-functions/v2/tasks"
import { INTERNAL_ONLY, RUNTIME_DEFAULTS } from "../runtimeOptions"
import { logFailure } from "../log"
import { isSafeDocId } from "../p5/common"
import { JOB_ENGINE, JOB_WORKER_TIMEOUT_SECONDS, SWEEP_BUDGET_MS } from "./constants"
import { runtimeDeps, type JobDeps, type JobTask } from "./dispatch"
import { fanOutEvent } from "./fanout"
import { reconcileEventFanout } from "./fanoutReconcile"
import { acceptLegacyOcrJob } from "./ocrDrain"
import { isCompleteLegacyOcrJob } from "./ocrJob"
import { sweepLegacyOcr } from "./ocrSweep"
import { AUTO_CONFIRM_SPEC } from "../d1/entity/autoConfirmJob"
import { NAME_REINDEX_SPEC } from "../d1/conflict/reindexJob"
import { scheduledJobFunction } from "./scheduled"
import { sweep } from "./sweeper"
import { runJobTask } from "./worker"

/**
 * The job runtime's deployed functions (spec P3-5, P3-8): the creation trigger that dispatches a
 * new job, the Cloud Tasks worker, and the per-minute sweeper. Each takes its deps from
 * `runtimeDeps()`; the cores (`onJobCreatedCore`, `parseJobTask`, `runJobTask`, `sweep`) are what
 * the tests drive.
 */

/**
 * A new job row → dispatch `{ jobId, seq: 0 }` when it is an engine row. A well-formed legacy OCR row
 * (audit F04: the upload writer, no `engine` field) is drained into a `d3.ocr` engine job. Any other
 * legacy row is ignored, with no store read. A repeated trigger reuses task `${jobId}-0`, which Cloud
 * Tasks dedupes. An engine-row dispatch failure is logged and swallowed: the sweeper re-dispatches a
 * due engine row after `DISPATCH_GRACE_MS`. A legacy OCR drain failure is logged and rethrown
 * (FA-F04-001) so the create trigger, which retries, runs the drain again. Permanent document
 * problems are recorded inside the drain and do not throw. Enqueue is idempotent, so a redelivery
 * reuses the same engine job.
 */
export async function onJobCreatedCore(jobId: string, data: DocumentData | undefined, deps: JobDeps): Promise<void> {
  if (data?.engine === JOB_ENGINE) {
    try {
      await deps.dispatcher.dispatch({ jobId, seq: 0 })
    } catch (err) {
      logFailure("job dispatch failed", err)
    }
    return
  }
  if (!isCompleteLegacyOcrJob(data)) return
  try {
    await acceptLegacyOcrJob(jobId, data, deps)
  } catch (err) {
    logFailure("ocr drain failed", err)
    throw err
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
export const onJobCreated = onDocumentCreated(
  { ...RUNTIME_DEFAULTS, document: "jobs/{jobId}", maxInstances: 10, timeoutSeconds: 60, ingressSettings: INTERNAL_ONLY, retry: true },
  (event) => onJobCreatedCore(event.params.jobId, event.data?.data(), runtimeDeps())
)

/**
 * A new event row → one job per registered subscriber (P3-15). `retry: true` makes the platform
 * redeliver after a thrown (transient store) error, for up to 7 days; `fanOutEvent` never throws
 * for a permanent cause, and the deterministic job ids make a redelivery safe. An event whose
 * retries run out is repaired by `eventFanoutReconciler` (audit F36, O-37).
 */
export const onEventCreated = onDocumentCreated(
  { ...RUNTIME_DEFAULTS, document: "events/{eventId}", maxInstances: 10, timeoutSeconds: 60, ingressSettings: INTERNAL_ONLY, retry: true },
  async (event) => {
    await fanOutEvent(event.params.eventId, event.data?.data(), runtimeDeps())
  }
)

/**
 * The worker queue (P3-5). Every job-level outcome answers 2xx; `runJobTask` throws only when it
 * cannot read, claim or commit (the store is unavailable), so Cloud Tasks' own retry covers
 * infrastructure faults and never schedules job retries. Cloud Tasks invokes it with OIDC; it
 * acts only on the job id it is given.
 */
export const jobWorker = onTaskDispatched(
  {
    ...RUNTIME_DEFAULTS,
    maxInstances: 10,
    timeoutSeconds: JOB_WORKER_TIMEOUT_SECONDS,
    ingressSettings: INTERNAL_ONLY,
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 10, maxBackoffSeconds: 60 },
    rateLimits: { maxConcurrentDispatches: 10, maxDispatchesPerSecond: 5 },
    invoker: ["sikander-functions@"],
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

/**
 * The sweeper's timeout, pinned (the platform default is 60 s). It stays below the one-minute
 * schedule so a slow sweep is cut off before the next one starts rather than overlapping it. The
 * sweep's own wall-clock budget (`SWEEP_BUDGET_MS`, 30 s) normally ends it first, between rows. A
 * sweep killed between a commit and its dispatch loses nothing: the commit stamped the row's
 * `sweepAt`, so the row is due again after its backoff and a later sweep re-dispatches it.
 */
const SWEEPER_TIMEOUT_SECONDS = 45

// The budget must leave the last row's transaction and dispatch room before the timeout.
if (!(SWEEP_BUDGET_MS + 10_000 <= SWEEPER_TIMEOUT_SECONDS * 1000)) {
  throw new Error(`sweep budget (${SWEEP_BUDGET_MS} ms) must end at least 10 s before the sweeper timeout (${SWEEPER_TIMEOUT_SECONDS} s)`)
}

/** The safety net (P3-8): re-dispatches lost dispatches and expired leases every minute. */
export const jobSweeper = onSchedule(
  { ...RUNTIME_DEFAULTS, schedule: "every 1 minutes", maxInstances: 1, timeoutSeconds: SWEEPER_TIMEOUT_SECONDS, ingressSettings: INTERNAL_ONLY },
  async () => {
    await sweep(runtimeDeps())
  }
)

/**
 * Legacy OCR safety net (FA-F04-007). The create trigger drains a row only when it is written.
 * This sweep picks up older rows that trigger never saw, and rows whose engine retries are
 * exhausted, so a missed handoff does not stay queued. No schedule retry: the next minute is the retry.
 */
export const ocrLegacySweep = onSchedule(
  { ...RUNTIME_DEFAULTS, schedule: "every 1 minutes", maxInstances: 1, timeoutSeconds: SWEEPER_TIMEOUT_SECONDS, ingressSettings: INTERNAL_ONLY },
  async () => {
    await sweepLegacyOcr(runtimeDeps())
  }
)

/** The daily auto-confirm tick (P3-43): enqueues `d1.autoconfirm` for every firm, once per PKT day. */
export const d1AutoConfirmTick = scheduledJobFunction(AUTO_CONFIRM_SPEC)

/** The daily conflict name index reconciliation tick (audit F37): enqueues `d1.conflict.reindex` for every firm, once per PKT day. */
export const d1ConflictReindexTick = scheduledJobFunction(NAME_REINDEX_SPEC)

/**
 * Event fan-out reconciliation (audit F36, O-37): every five minutes, scans `events` for rows that
 * lack a delivery ledger entry for a production subscriber and re-runs `fanOutEvent`.
 */
export const eventFanoutReconciler = onSchedule(
  { ...RUNTIME_DEFAULTS, schedule: "every 5 minutes", maxInstances: 1, timeoutSeconds: 45, ingressSettings: INTERNAL_ONLY },
  async () => {
    await reconcileEventFanout(runtimeDeps())
  }
)
