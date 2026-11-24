import { FieldPath, type DocumentData, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore"
import {
  courtOpsParentRef,
  decideCourtOpsReach,
  isCourtOpsDeletionRow,
  type CourtOpsReach,
} from "@/platform/persistence/courtOpsMatterBinding"
import { MATTER_TOMBSTONES, isTombstoneFor } from "@/platform/retention/tombstone"
import { JobError } from "../p2/errors"
import { retentionTestSeam, storeKey } from "./config"
import { DELETION_REQUESTS_COLLECTION, LEGAL_HOLDS_COLLECTION } from "./model"

/**
 * FA-D4-001-FU1-001: before purge jobs run, bind legacy follow-up and court-ops acknowledgement rows
 * whose matter id is null, missing, or empty. A parent that names a matter is stamped with it, so the
 * existing firmId + matterId purge (when the approved plan says purge) and the tombstone filter reach
 * the row. A row that cannot be linked is recorded on the deletion request and left live: one matter's
 * deletion never deletes it. A row of another matter that is already tombstoned is deleted only when
 * that store's planned treatment is purge; otherwise it is stamped and recorded. A firm-level workflow
 * acknowledgement is left live.
 *
 * Pages are separate transactions. The caller does not wrap this function in one runFenced step.
 */

const PAGE = 100
const MAX_PAGES = 1_000

const COLLECTIONS = ["follow_ups", "workflow_ops_activity"] as const
type ReachCollection = (typeof COLLECTIONS)[number]
type MatterMode = "null" | "empty" | "absent"

const STORE_KEY: Record<ReachCollection, string> = {
  follow_ups: storeKey("firestore:follow_ups"),
  workflow_ops_activity: storeKey("firestore:workflow_ops_activity"),
}

export type CourtOpsDeletionReachResult = { stamped: number; removed: number; reported: number }

export async function reachCourtOpsDeletion(input: {
  db: Firestore
  firmId: string
  deletingMatterId: string
  requestId: string
}): Promise<CourtOpsDeletionReachResult> {
  if (process.env.NODE_ENV !== "production" && retentionTestSeam.failCourtOpsReach) {
    throw new JobError("court_ops_reach_failed", { permanent: true })
  }
  const maxPages = process.env.NODE_ENV === "production" ? MAX_PAGES : (retentionTestSeam.courtOpsReachMaxPages ?? MAX_PAGES)
  const totals: CourtOpsDeletionReachResult = { stamped: 0, removed: 0, reported: 0 }
  for (const collection of COLLECTIONS) {
    let used = 0
    for (const mode of ["null", "empty", "absent"] as const) {
      let after: string | null = null
      for (;;) {
        const snap = await loadCourtOpsPage(input.db, collection, input.firmId, mode, after)
        if (snap.empty) break
        const last = snap.docs[snap.docs.length - 1].id
        if (last === after) break
        const candidates = mode === "absent"
          ? snap.docs.filter((doc) => !Object.prototype.hasOwnProperty.call(doc.data() ?? {}, "matterId"))
          : snap.docs
        if (candidates.length > 0) {
          if (used >= maxPages) throw new JobError("court_ops_reach_capped", { permanent: true })
          used += 1
          const outcome = await applyCourtOpsPage(input, collection, candidates.map((doc) => doc.ref))
          totals.stamped += outcome.stamped
          totals.removed += outcome.removed
          totals.reported += outcome.reported
          if (process.env.NODE_ENV !== "production") await retentionTestSeam.afterCourtOpsReachPage?.(used)
        }
        after = last
        if (snap.size < PAGE) break
      }
    }
  }
  return totals
}

async function loadCourtOpsPage(
  db: Firestore,
  collection: ReachCollection,
  firmId: string,
  mode: MatterMode,
  after: string | null
) {
  let query = db.collection(collection).where("firmId", "==", firmId)
  if (mode === "null") query = query.where("matterId", "==", null)
  if (mode === "empty") query = query.where("matterId", "==", "")
  query = query.orderBy(FieldPath.documentId()).limit(PAGE)
  if (after !== null) query = query.startAfter(after)
  return query.get()
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
    const request = requestSnap.data() ?? {}
    const plan = request.plan
    const purge = !!plan && typeof plan === "object" && !Array.isArray(plan) && (plan as Record<string, unknown>)[STORE_KEY[collection]] === "purge"
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
    const recorded = new Set(tombSnaps.filter((snap) => isTombstoneFor(snap.data(), input.firmId, snap.id)).map((snap) => snap.id))
    const tombstoned = purge ? recorded : new Set<string>()
    return writeCourtOpsPage(tx, requestRef, request, planned, tombstoned, recorded)
  })
}

function writeCourtOpsPage(
  tx: Transaction,
  requestRef: DocumentReference,
  request: DocumentData,
  planned: Array<{ ref: DocumentReference; id: string; reach: CourtOpsReach }>,
  tombstoned: ReadonlySet<string>,
  recorded: ReadonlySet<string>
): CourtOpsDeletionReachResult {
  const report: Array<{ id: string; reason: string }> = []
  let stamped = 0
  let removed = 0
  for (const item of planned) {
    if (item.reach.action === "leave") continue
    if (item.reach.action === "stamp" && !tombstoned.has(item.reach.matterId)) {
      tx.update(item.ref, { matterId: item.reach.matterId })
      stamped += 1
      if (recorded.has(item.reach.matterId)) report.push({ id: item.id, reason: "tombstoned" })
      continue
    }
    if (item.reach.action === "stamp") {
      tx.delete(item.ref)
      removed += 1
      report.push({ id: item.id, reason: "tombstoned" })
      continue
    }
    report.push({ id: item.id, reason: item.reach.reason })
  }
  if (report.length > 0) recordUnlinked(tx, requestRef, request, report)
  return { stamped, removed, reported: report.length }
}

function recordUnlinked(
  tx: Transaction,
  requestRef: DocumentReference,
  request: DocumentData,
  items: readonly { id: string; reason: string }[]
): void {
  const existing = Array.isArray(request.courtOpsUnlinked) ? request.courtOpsUnlinked.filter((id): id is string => typeof id === "string") : []
  const reasons: Record<string, string> = {}
  const storedReasons = request.courtOpsUnlinkedReasons
  if (storedReasons && typeof storedReasons === "object" && !Array.isArray(storedReasons)) {
    for (const [id, reason] of Object.entries(storedReasons as Record<string, unknown>)) {
      if (typeof reason === "string") reasons[id] = reason
    }
  }
  const seen = new Set(existing)
  const fresh = items.filter((item) => !seen.has(item.id))
  if (fresh.length === 0) return
  const ids = existing.concat(fresh.map((item) => item.id))
  for (const item of fresh) reasons[item.id] = item.reason
  tx.set(requestRef, {
    courtOpsUnlinked: ids,
    courtOpsUnlinkedReasons: reasons,
    courtOpsUnlinkedCount: ids.length,
    courtOpsUnlinkedTruncated: false,
  }, { merge: true })
}
