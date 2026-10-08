import type { Transaction } from "firebase-admin/firestore"
import { stageAudit } from "../p5/audit"
import { isKnownClassification } from "../p5/classification"

/**
 * The system audit path (spec P3-18): one `audit_log` row per effective job transition, with
 * `actorId: "system"` and `onBehalfOf` the job's creator, staged in the transition's own
 * transaction. `reason` is a code (`ok`, `lease_expired_reclaim` or a sanitised error code), never text.
 */

export type JobAuditAction = "job.enqueue" | "job.start" | "job.done" | "job.fail" | "job.dead_letter"

export type JobAuditSubject = { id: string; firmId: string; classification: unknown; createdBy: string }

export async function stageJobAudit(tx: Transaction, job: JobAuditSubject, action: JobAuditAction, reason: string): Promise<void> {
  stageJobAuditSync(tx, job, action, reason)
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== ""

/**
 * `stageJobAudit`, synchronously: validates the subject, then stages the row. It throws on any
 * failure, so a synchronous caller (`stageFailure`) aborts its transaction rather than committing
 * a transition without its audit row.
 */
export function stageJobAuditSync(tx: Transaction, job: JobAuditSubject, action: JobAuditAction, reason: string): void {
  if (!isNonEmptyString(job.id) || !isNonEmptyString(job.firmId) || !isNonEmptyString(job.createdBy) || !isNonEmptyString(reason)) {
    throw new Error("job audit: invalid subject")
  }
  stageAudit(
    {
      firmId: job.firmId,
      actorId: "system",
      onBehalfOf: job.createdBy,
      action,
      target: `jobs/${job.id}`,
      // An unknown label counts as the highest (fail closed).
      classification: isKnownClassification(job.classification) ? job.classification : "privileged-restricted",
      decision: "allow",
      reason,
    },
    tx
  )
}
