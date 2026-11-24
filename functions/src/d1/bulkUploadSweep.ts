import { onSchedule } from "firebase-functions/v2/scheduler"
import { UPLOAD_SESSIONS_COLLECTION, sweepExpiredStagingObjects } from "@/platform/documents/uploadStagingStore"
import { BULK_UPLOAD_STAGING_TTL_MS, isBulkUploadEnabled } from "@/services/d1-6/bulkUpload"
import { adminDb } from "../admin"
import { INTERNAL_ONLY, RUNTIME_DEFAULTS } from "../runtimeOptions"

/**
 * Lists `upload-staging/` from the object store and deletes objects whose own age
 * is at least one day, then deletes `upload_sessions` rows past `expiresAtMs`.
 * The schedule is registered. It returns without listing unless
 * SIKANDER_FLAG_D1_BULK_UPLOAD is exactly "true". The bucket lifecycle in
 * infra/backup/upload-staging-lifecycle.json is the bound that does not need this process.
 */
export async function runBulkUploadStagingSweep(now: number = Date.now()): Promise<{ objects: number; sessions: number; skipped: boolean }> {
  if (!isBulkUploadEnabled()) return { objects: 0, sessions: 0, skipped: true }
  const objects = await sweepExpiredStagingObjects(now, BULK_UPLOAD_STAGING_TTL_MS)
  const snap = await adminDb().collection(UPLOAD_SESSIONS_COLLECTION).where("expiresAtMs", "<=", now).get()
  if (snap.size > 0) {
    const batch = adminDb().batch()
    snap.docs.forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
  }
  return { objects, sessions: snap.size, skipped: false }
}

export const bulkUploadStagingSweep = onSchedule(
  {
    ...RUNTIME_DEFAULTS,
    schedule: "every 24 hours",
    maxInstances: 1,
    timeoutSeconds: 120,
    ingressSettings: INTERNAL_ONLY,
  },
  async () => {
    await runBulkUploadStagingSweep(Date.now())
  }
)
