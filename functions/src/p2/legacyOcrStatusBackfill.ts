import { FieldPath, type DocumentSnapshot, type Firestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
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
  complete?: boolean
}

/** Test-only: counts Firestore query pages issued by the backfill (not incremented when the cursor is complete). */
export const legacyOcrStatusBackfillTestSeam: { queryPages?: number } = {}

type BackfillCursor = { after?: string | null; complete?: boolean }

const CURSOR_ID = "ocrStatusBackfill"

function backfillSeamAllows(): boolean {
  return process.env.NODE_ENV !== "production"
}

function cursorRef() {
  return adminDb().collection("system").doc(CURSOR_ID)
}

async function readCursor(): Promise<BackfillCursor> {
  const snap = await cursorRef().get()
  return snap.exists ? (snap.data() as BackfillCursor) : {}
}

async function writeCursor(cursor: BackfillCursor): Promise<void> {
  await cursorRef().set(cursor, { merge: true })
}

async function afterSnapshot(afterId: string | null | undefined): Promise<DocumentSnapshot | undefined> {
  if (afterId === undefined || afterId === null) return undefined
  const snap = await jobsRef().doc(afterId).get()
  return snap.exists ? snap : undefined
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
  if (backfillSeamAllows()) legacyOcrStatusBackfillTestSeam.queryPages = (legacyOcrStatusBackfillTestSeam.queryPages ?? 0) + 1
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

/** Idempotent backfill used before the OCR sweep; resumes from `system/ocrStatusBackfill`. */
export async function backfillLegacyOcrStatusForSweep(limit = SWEEP_LIMIT): Promise<LegacyOcrStatusBackfillPage> {
  const cursor = await readCursor()
  if (cursor.complete === true) {
    logger.debug("ocr.ocrStatusBackfill", { complete: true, scanned: 0 })
    return { scanned: 0, applied: 0, skipped: 0, failed: 0, complete: true }
  }

  let after = await afterSnapshot(cursor.after)
  let scanned = 0
  let applied = 0
  let skipped = 0
  let failed = 0
  let last: DocumentSnapshot | undefined
  let finished = false
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const result = await backfillLegacyOcrStatusPage(adminDb(), { limit, after })
    scanned += result.scanned
    applied += result.applied
    skipped += result.skipped
    failed += result.failed
    last = result.last
    if (result.scanned < limit) {
      finished = true
      break
    }
    after = result.last
  }
  const nextCursor: BackfillCursor = finished
    ? { after: null, complete: true }
    : { after: last?.id ?? cursor.after ?? null, complete: false }
  await writeCursor(nextCursor)
  logger.info("ocr.ocrStatusBackfill", { scanned, applied, skipped, failed, complete: finished })
  if (failed > 0) {
    logger.warn("ocr.ocrStatusBackfill_failed_rows", { failed })
  }
  return { scanned, applied, skipped, failed, last, complete: finished }
}
