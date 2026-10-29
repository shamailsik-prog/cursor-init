import { FieldPath, type DocumentSnapshot, type Firestore } from "firebase-admin/firestore"
import {
  applyLegacyPartnerIndependenceBackfill,
  planLegacyPartnerIndependenceBackfill,
  type BootstrapMarker,
  type LegacyPartnerIndependenceBackfillStore,
} from "@/platform/persistence/legacyPartnerIndependenceBackfill"
import { adminDb } from "../admin"

export type LegacyPartnerIndependenceBackfillPage = {
  scanned: number
  applied: number
  skipped: number
  failed: number
  last?: DocumentSnapshot
  complete?: boolean
}

/** Test-only: counts Firestore query pages issued by the backfill (not incremented when the cursor is complete). */
export const legacyPartnerIndependenceBackfillTestSeam: { queryPages?: number } = {}

type BackfillCursor = { after?: string | null; complete?: boolean }

const CURSOR_ID = "partnerIndependenceBackfill"
const PAGE_LIMIT = 200

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

async function readBootstrap(db: Firestore): Promise<BootstrapMarker> {
  const snap = await db.collection("platform").doc("bootstrap").get()
  return snap.exists ? (snap.data() as BootstrapMarker) : {}
}

function firestoreBackfillStore(): LegacyPartnerIndependenceBackfillStore {
  return {
    async stamp(id: string, patch: { independentPartner: boolean }) {
      const ref = adminDb().collection("users").doc(id)
      return adminDb().runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        if (!snap.exists) return { status: "skipped" as const }
        const data = snap.data() ?? {}
        if (data.role !== "partner" || data.active === false) return { status: "skipped" as const }
        if (Object.hasOwn(data, "independentPartner")) return { status: "skipped" as const }
        tx.update(ref, patch)
        return { status: "written" as const }
      })
    },
  }
}

/** One paginated scan of active partners; stamps explicit `independentPartner` where still absent. */
export async function backfillLegacyPartnerIndependencePage(
  db: Firestore,
  opts: { limit: number; after?: DocumentSnapshot; bootstrap?: BootstrapMarker }
): Promise<LegacyPartnerIndependenceBackfillPage> {
  if (backfillSeamAllows()) {
    legacyPartnerIndependenceBackfillTestSeam.queryPages =
      (legacyPartnerIndependenceBackfillTestSeam.queryPages ?? 0) + 1
  }
  const bootstrap = opts.bootstrap ?? (await readBootstrap(db))
  const base = db
    .collection("users")
    .where("role", "==", "partner")
    .orderBy(FieldPath.documentId())
    .limit(opts.limit)
  const snap = await (opts.after === undefined ? base : base.startAfter(opts.after)).get()
  const plan = planLegacyPartnerIndependenceBackfill(
    snap.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
    bootstrap
  )
  const result = await applyLegacyPartnerIndependenceBackfill(firestoreBackfillStore(), plan)
  return {
    scanned: snap.size,
    applied: result.applied.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
    last: snap.docs.at(-1),
    complete: snap.size < opts.limit,
  }
}

/** Idempotent backfill; resumes from `system/partnerIndependenceBackfill`. */
export async function backfillLegacyPartnerIndependence(limit = PAGE_LIMIT): Promise<LegacyPartnerIndependenceBackfillPage> {
  const db = adminDb()
  const cursor = await readCursor()
  if (cursor.complete) {
    return { scanned: 0, applied: 0, skipped: 0, failed: 0, complete: true }
  }
  const afterId = cursor.after
  let after: DocumentSnapshot | undefined
  if (afterId !== undefined && afterId !== null) {
    const snap = await db.collection("users").doc(afterId).get()
    after = snap.exists ? snap : undefined
  }
  const result = await backfillLegacyPartnerIndependencePage(db, { limit, after })
  if (result.complete) await writeCursor({ complete: true })
  else if (result.last) await writeCursor({ after: result.last.id, complete: false })
  return result
}
