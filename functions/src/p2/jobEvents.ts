import { Timestamp, type Transaction } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminDb } from "../admin"
import type { JobRow } from "./enqueue"

/**
 * Job events and the dead-letter alert (spec P3-7). `job.failed` (doc `${jobId}_failed_${totalAttempts}`)
 * and `job.deadLettered` (doc `${jobId}_deadLettered_${manualRetries}`) follow the events envelope
 * (L8148): `name`, `firmId`, `classification` (the job's), `occurredAt`, `idempotencyKey` (= the doc
 * id) and the payload `{ jobId, jobType, attempts: totalAttempts, error: code }` (L8202). Codes only.
 */

export type DeadLetterInfo = { jobId: string; jobType: string; firmId: string; attempts: number; code: string }

export interface DeadLetterAlert {
  deadLettered(info: DeadLetterInfo): void | Promise<void>
}

/** The default alert: a fixed log line that a log-based alert policy matches (L4.10 item is O-30). */
export const logDeadLetterAlert: DeadLetterAlert = {
  deadLettered({ jobId, jobType, firmId, attempts, code }) {
    logger.error("job.deadLettered", { jobId, jobType, firmId, attempts, code })
  },
}

function stageEvent(tx: Transaction, name: "job.failed" | "job.deadLettered", docId: string, jobId: string, row: JobRow, code: string, now: number): void {
  tx.set(adminDb().collection("events").doc(docId), {
    name,
    firmId: row.firmId,
    payload: { jobId, jobType: row.jobType, attempts: row.totalAttempts, error: code },
    classification: row.classification,
    occurredAt: Timestamp.fromMillis(now),
    idempotencyKey: docId,
  })
}

/** Stages `job.failed` for the attempt that just ended; `row` is the post-transition row. */
export function stageJobFailedEvent(tx: Transaction, jobId: string, row: JobRow, code: string, now: number): void {
  stageEvent(tx, "job.failed", `${jobId}_failed_${row.totalAttempts}`, jobId, row, code, now)
}

/** Stages `job.deadLettered`, one per manual-retry round; `row` is the post-transition row. */
export function stageJobDeadLetteredEvent(tx: Transaction, jobId: string, row: JobRow, code: string, now: number): void {
  stageEvent(tx, "job.deadLettered", `${jobId}_deadLettered_${row.manualRetries}`, jobId, row, code, now)
}
