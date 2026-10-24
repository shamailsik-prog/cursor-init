import { Timestamp } from "firebase-admin/firestore"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { adminDb } from "../admin"
import { logFailure } from "../log"
import { INTERNAL_ONLY, RUNTIME_DEFAULTS } from "../runtimeOptions"
import { raiseRetentionAlert } from "./alert"
import { requestsRef } from "./model"

/**
 * Audit F42 (spec R10): the unacknowledged-deletion watch. Every 15 minutes it finds the `in_progress` deletion
 * requests whose acknowledgement deadline has passed and raises `retention.deletion_unacknowledged` once per request
 * (ids and counts: expected stores, acknowledged stores, missing stores), then stamps `alertedAt`. A crash between the
 * raise and the stamp raises it again on the next run: a duplicate alert is preferred to a lost one. No caller, no
 * tenant input; each alert names its own request's firm.
 */

const PAGE = 200
export const WATCH_TIMEOUT_SECONDS = 120

export async function runRetentionWatch(nowMs: number): Promise<{ scanned: number; alerted: number }> {
  const snap = await requestsRef().where("status", "==", "in_progress").where("ackDeadlineAt", "<=", Timestamp.fromMillis(nowMs)).limit(PAGE).get()
  let alerted = 0
  for (const doc of snap.docs) {
    const r = doc.data()
    if (r.alertedAt instanceof Timestamp) continue
    const expected = Array.isArray(r.expected) ? r.expected.length : 0
    const acked = r.acked && typeof r.acked === "object" ? Object.keys(r.acked).length : 0
    raiseRetentionAlert("retention.deletion_unacknowledged", {
      firmId: String(r.firmId),
      requestId: doc.id,
      matterId: String(r.matterId),
      expected,
      acked,
      missing: Math.max(0, expected - acked),
    })
    try {
      await adminDb().runTransaction(async (tx) => {
        const now = (await tx.get(doc.ref)).data()
        if (now && !(now.alertedAt instanceof Timestamp)) tx.update(doc.ref, { alertedAt: Timestamp.fromMillis(nowMs) })
      })
      alerted += 1
    } catch (err) {
      logFailure(`retention watch could not stamp request=${doc.id}`, err)
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
