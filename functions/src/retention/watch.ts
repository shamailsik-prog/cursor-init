import { Timestamp } from "firebase-admin/firestore"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { adminDb } from "../admin"
import { prepareAlert, stageAlert } from "../alerts/raise"
import { logFailure } from "../log"
import { INTERNAL_ONLY, RUNTIME_DEFAULTS } from "../runtimeOptions"
import { deletionUnacknowledgedSpec } from "./alert"
import { requestsRef } from "./model"

/**
 * Audit F42 (spec R10): the unacknowledged-deletion watch. Every 15 minutes it finds the `in_progress` deletion
 * requests whose acknowledgement deadline has passed and that are not yet alerted, and for each one, in one transaction,
 * re-reads the request, raises the F43 durable alert `retention.deletion_unacknowledged` (subject the request; detail
 * expected, acknowledged and missing store counts) and stamps `alertedAt`. The alert commits if and only if the stamp
 * does: never lost, never doubled. No caller, no tenant input; each alert names its own request's firm.
 */

const PAGE = 200

/**
 * Test seam (never set in production code, and ignored when NODE_ENV is production): `afterQuery` runs after the
 * query and before the transactions, so a test can make another run alert a request this run has already read.
 */
export const retentionWatchTestSeam: { afterQuery?: () => Promise<void> } = {}
export const WATCH_TIMEOUT_SECONDS = 120

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : value !== null && typeof value === "object" ? Object.keys(value).length : 0)

export async function runRetentionWatch(nowMs: number): Promise<{ scanned: number; alerted: number }> {
  // Only the requests not yet alerted (`alertedAt` is null from the approval): a request halted by a hold stays
  // in_progress for good, so filtering after the read would let a page of old, alerted ones hide a new overdue one.
  const snap = await requestsRef()
    .where("status", "==", "in_progress")
    .where("alertedAt", "==", null)
    .where("ackDeadlineAt", "<=", Timestamp.fromMillis(nowMs))
    .orderBy("ackDeadlineAt")
    .limit(PAGE)
    .get()
  if (process.env.NODE_ENV !== "production") await retentionWatchTestSeam.afterQuery?.()
  let alerted = 0
  for (const doc of snap.docs) {
    try {
      const raised = await adminDb().runTransaction(async (tx) => {
        const now = (await tx.get(doc.ref)).data()
        const deadline = now?.ackDeadlineAt
        if (!now || now.status !== "in_progress" || now.alertedAt instanceof Timestamp || !(deadline instanceof Timestamp) || deadline.toMillis() > nowMs) return false
        const prepared = await prepareAlert(tx, deletionUnacknowledgedSpec(String(now.firmId), doc.id, countOf(now.expected), countOf(now.acked)))
        stageAlert(tx, prepared, nowMs)
        tx.update(doc.ref, { alertedAt: Timestamp.fromMillis(nowMs) })
        return true
      })
      if (raised) alerted += 1
    } catch (err) {
      // The request keeps alertedAt null, so the next run raises it again.
      logFailure(`retention watch could not raise the alert for request=${doc.id}`, err)
    }
  }
  return { scanned: snap.size, alerted }
}

export const retentionDeletionWatch = onSchedule(
  { ...RUNTIME_DEFAULTS, schedule: "every 15 minutes", maxInstances: 1, timeoutSeconds: WATCH_TIMEOUT_SECONDS, ingressSettings: INTERNAL_ONLY },
  async () => {
    await runRetentionWatch(Date.now())
  }
)
