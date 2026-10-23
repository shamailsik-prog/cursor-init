import { FieldPath, type DocumentSnapshot, type Firestore } from "firebase-admin/firestore"
import {
  applyLegacyOcrStatusBackfill,
  planLegacyOcrStatusBackfill,
  type LegacyOcrStatusBackfillStore,
} from "@/platform/persistence/legacyOcrStatusBackfill"
import { adminDb } from "../admin"
import { JOB_ENGINE, SWEEP_LIMIT, SWEEP_MAX_PAGES } from "./constants"
import { jobsRef } from "./enqueue"

export type LegacyOcrStatusBackfillPage = {
  scanned: number
  applied: number
  skipped: number
  failed: number
  last?: DocumentSnapshot
}

function firestoreBackfillStore(): LegacyOcrStatusBackfillStore {
  return {
    async stamp(id: string) {
      const ref = jobsRef().doc(id)
      return adminDb().runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        if (!snap.exists) return { status: "skipped" as const }
        const data = snap.data() ?? {}
        if (data.jobType !== "ocr" || data.engine === JOB_ENGINE) return { status: "skipped" as const }
        if (Object.hasOwn(data, "ocrStatus")) return { status: "skipped" as const }
        tx.update(ref, { ocrStatus: "queued" })
        return { status: "written" as const }
      })
    },
  }
}

/** One paginated scan of `jobType == "ocr"` rows; stamps `ocrStatus: "queued"` where still absent. */
export async function backfillLegacyOcrStatusPage(
  db: Firestore,
  opts: { limit: number; after?: DocumentSnapshot }
): Promise<LegacyOcrStatusBackfillPage> {
  const base = db.collection("jobs").where("jobType", "==", "ocr").orderBy(FieldPath.documentId()).limit(opts.limit)
  const snap = await (opts.after === undefined ? base : base.startAfter(opts.after)).get()
  const plan = planLegacyOcrStatusBackfill(snap.docs.map((doc) => ({ id: doc.id, data: doc.data() })))
  const result = await applyLegacyOcrStatusBackfill(firestoreBackfillStore(), plan)
  return {
    scanned: snap.size,
    applied: result.applied.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
    last: snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : opts.after,
  }
}

/** Idempotent backfill used before the OCR sweep; walks up to `SWEEP_MAX_PAGES` per call. */
export async function backfillLegacyOcrStatusForSweep(limit = SWEEP_LIMIT): Promise<LegacyOcrStatusBackfillPage> {
  let after: DocumentSnapshot | undefined
  let scanned = 0
  let applied = 0
  let skipped = 0
  let failed = 0
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const result = await backfillLegacyOcrStatusPage(adminDb(), { limit, after })
    scanned += result.scanned
    applied += result.applied
    skipped += result.skipped
    failed += result.failed
    if (result.scanned < limit) return { scanned, applied, skipped, failed, last: result.last }
    after = result.last
  }
  return { scanned, applied, skipped, failed, last: after }
}
