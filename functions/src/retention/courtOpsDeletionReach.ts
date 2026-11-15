import { FieldPath, type DocumentData, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore"
import {
  courtOpsParentRef,
  decideCourtOpsReach,
  isCourtOpsDeletionRow,
  type CourtOpsReach,
} from "@/platform/persistence/courtOpsMatterBinding"
import { MATTER_TOMBSTONES, isTombstoneFor } from "@/platform/retention/tombstone"
import { JobError } from "../p2/errors"
import { DELETION_REQUESTS_COLLECTION, LEGAL_HOLDS_COLLECTION } from "./model"

/**
 * FA-D4-001-FU1-001: before purge jobs run, bind legacy follow-up and court-ops acknowledgement rows
 * whose `matterId` is null. A parent that names a matter is stamped with it, so the existing
 * `firmId` + `matterId` purge (and the tombstone filter) reaches the row. A row that cannot be
 * linked is deleted and its id is recorded on the deletion request. A firm-level workflow
 * acknowledgement is left live. A row of another matter that is already tombstoned is deleted and
 * reported, so it is not left behind after that matter's purge.
 */

const PAGE = 100
const MAX_PAGES = 1_000
const MAX_REPORTED_IDS = 400

const COLLECTIONS = ["follow_ups", "workflow_ops_activity"] as const
type ReachCollection = (typeof COLLECTIONS)[number]

export type CourtOpsDeletionReachResult = { stamped: number; removed: number; reported: number }

export async function reachCourtOpsDeletion(input: {
  db: Firestore
  firmId: string
  deletingMatterId: string
  requestId: string
}): Promise<CourtOpsDeletionReachResult> {
  const totals: CourtOpsDeletionReachResult = { stamped: 0, removed: 0, reported: 0 }
  for (const collection of COLLECTIONS) {
    let after: string | null = null
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let query = input.db.collection(collection).where("firmId", "==", input.firmId).where("matterId", "==", null).orderBy(FieldPath.documentId()).limit(PAGE)
      if (after !== null) query = query.startAfter(after)
      const snap = await query.get()
      if (snap.empty) break
      const last = snap.docs[snap.docs.length - 1].id
      if (last === after) break
      after = last
      const outcome = await applyCourtOpsPage(input, collection, snap.docs.map((doc) => doc.ref))
      totals.stamped += outcome.stamped
      totals.removed += outcome.removed
      totals.reported += outcome.reported
      if (snap.size < PAGE) break
    }
  }
  return totals
}

async function applyCourtOpsPage(
  input: { db: Firestore; firmId: string; deletingMatterId: string; requestId: string },
  collection: ReachCollection,
  refs: DocumentReference[]
): Promise<CourtOpsDeletionReachResult> {
  if (refs.length === 0) return { stamped: 0, removed: 0, reported: 0 }
  return input.db.runTransaction(async (tx) => {
    const hold = await tx.get(input.db.collection(LEGAL_HOLDS_COLLECTION).doc(input.deletingMatterId))
    const holdData = hold.data()
    if (holdData && holdData.firmId === input.firmId && holdData.active === true) {
      throw new JobError("legal_hold_active", { permanent: true })
    }
    const requestRef = input.db.collection(DELETION_REQUESTS_COLLECTION).doc(input.requestId)
    const requestSnap = await tx.get(requestRef)
    if (!requestSnap.exists) throw new JobError("deletion_request_invalid", { permanent: true })
    const rowSnaps = await tx.getAll(...refs)
    const parentRefs: DocumentReference[] = []
    const parentAt = new Map<string, number>()
    for (const snap of rowSnaps) {
      if (!snap.exists) continue
      const data = snap.data() ?? {}
      if (data.firmId !== input.firmId || !isCourtOpsDeletionRow(collection, snap.id, data)) continue
      const key = courtOpsParentRef(snap.id, data)
      if (!key || parentAt.has(`${key.collection}/${key.id}`)) continue
      parentAt.set(`${key.collection}/${key.id}`, parentRefs.length)
      parentRefs.push(input.db.collection(key.collection).doc(key.id))
    }
    const parentSnaps = parentRefs.length > 0 ? await tx.getAll(...parentRefs) : []
    const parentByPath = new Map(parentSnaps.map((snap) => [snap.ref.path, snap.exists ? (snap.data() ?? null) : null]))
    const planned: Array<{ ref: DocumentReference; id: string; reach: CourtOpsReach }> = []
    for (const snap of rowSnaps) {
      if (!snap.exists) continue
      const data = snap.data() ?? {}
      if (data.firmId !== input.firmId) continue
      const key = courtOpsParentRef(snap.id, data)
      const parent = key ? parentByPath.get(`${key.collection}/${key.id}`) ?? null : null
      planned.push({
        ref: snap.ref,
        id: snap.id,
        reach: decideCourtOpsReach({ collection, id: snap.id, row: data, parent }),
      })
    }
    const otherMatters = [...new Set(planned.flatMap((item) => item.reach.action === "stamp" && item.reach.matterId !== input.deletingMatterId ? [item.reach.matterId] : []))]
    const tombSnaps = otherMatters.length > 0 ? await tx.getAll(...otherMatters.map((id) => input.db.collection(MATTER_TOMBSTONES).doc(id))) : []
    const tombstoned = new Set(tombSnaps.filter((snap) => isTombstoneFor(snap.data(), input.firmId, snap.id)).map((snap) => snap.id))
    return writeCourtOpsPage(tx, requestRef, requestSnap.data() ?? {}, planned, tombstoned)
  })
}

function writeCourtOpsPage(
  tx: Transaction,
  requestRef: DocumentReference,
  request: DocumentData,
  planned: Array<{ ref: DocumentReference; id: string; reach: CourtOpsReach }>,
  tombstoned: ReadonlySet<string>
): CourtOpsDeletionReachResult {
  const report: string[] = []
  let stamped = 0
  let removed = 0
  for (const item of planned) {
    if (item.reach.action === "leave") continue
    if (item.reach.action === "stamp" && !tombstoned.has(item.reach.matterId)) {
      tx.update(item.ref, { matterId: item.reach.matterId })
      stamped += 1
      continue
    }
    tx.delete(item.ref)
    removed += 1
    report.push(item.id)
  }
  if (report.length > 0) recordUnlinked(tx, requestRef, request, report)
  return { stamped, removed, reported: report.length }
}

function recordUnlinked(tx: Transaction, requestRef: DocumentReference, request: DocumentData, ids: readonly string[]): void {
  const existing = Array.isArray(request.courtOpsUnlinked) ? request.courtOpsUnlinked.filter((id): id is string => typeof id === "string") : []
  const seen = new Set(existing)
  const fresh = ids.filter((id) => !seen.has(id))
  if (fresh.length === 0) return
  const room = Math.max(0, MAX_REPORTED_IDS - existing.length)
  const stored = existing.concat(fresh.slice(0, room))
  const truncated = fresh.length > room || request.courtOpsUnlinkedTruncated === true
  const prior = typeof request.courtOpsUnlinkedCount === "number" ? request.courtOpsUnlinkedCount : existing.length
  tx.set(requestRef, {
    courtOpsUnlinked: stored,
    courtOpsUnlinkedCount: prior + fresh.length,
    ...(truncated ? { courtOpsUnlinkedTruncated: true } : {}),
  }, { merge: true })
}
