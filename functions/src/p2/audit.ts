import type { Transaction } from "firebase-admin/firestore"
import { appendAudit } from "../p5/audit"
import { isKnownClassification } from "../p5/classification"

/**
 * The system audit path (spec P3-18): one `audit_log` row per effective job transition, with
 * `actorId: "system"` and `onBehalfOf` the job's creator, staged in the transition's own
 * transaction. `reason` is a code (`ok`, `lease_expired_reclaim` or a sanitised error code), never text.
 */

export type JobAuditAction = "job.enqueue" | "job.start" | "job.done" | "job.fail" | "job.dead_letter"

export type JobAuditSubject = { id: string; firmId: string; classification: unknown; createdBy: string }

export async function stageJobAudit(tx: Transaction, job: JobAuditSubject, action: JobAuditAction, reason: string): Promise<void> {
  await appendAudit(
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
