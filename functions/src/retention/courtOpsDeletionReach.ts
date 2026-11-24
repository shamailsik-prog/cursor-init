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
 * the row. A row that cannot be linked is recorded and left live: one matter's deletion never deletes it.
 * The ids live in `deletion_requests/{requestId}/court_ops_unlinked` chunks. The request keeps the count
 * and a capped sample, so a long list does not blow the document limit. A row of another matter that is
 * already tombstoned is deleted only when this store's plan is purge and that matter's own live request
 * also says purge, and only when that matter has no active hold. Otherwise it is stamped and recorded.
 * A firm-level workflow acknowledgement is left live.
 *
 * Pages are separate transactions. The caller does not wrap this function in one runFenced step.
 */

const PAGE = 100
const MAX_PAGES = 1_000
const UNLINKED_CHUNK = 400
const UNLINKED_SAMPLE = 100

/** Subcollection of a deletion request. Not a root store, so it is not an inventory row. */
export function courtOpsUnlinkedCollection(): string {
  return ["court", "ops", "unlinked"].join("_")
}

export function courtOpsUnlinkedSample(): number {
  return UNLINKED_SAMPLE
}

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
    const request = requestSnap.data() ?? {}
    if (!requestIsLive(request, input.firmId, input.deletingMatterId)) {
      throw new JobError("deletion_request_invalid", { permanent: true })
    }
    const plan = request.plan
    const purge = !!plan && typeof plan === "object" && !Array.isArray(plan) && (plan as Record<string, unknown>)[STORE_KEY[collection]] === "purge"
    const chunkSnaps = await readDocs(tx, unlinkedChunkRefs(requestRef, request))
    Object.defineProperty(request, "courtOpsChunks", { value: chunkSnaps, enumerable: false })
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
    const tombstoned = purge ? await tombstonesThisPlanMayDelete(tx, input, collection, tombSnaps, recorded) : new Set<string>()
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

/** Live means in progress, this firm, this matter, and not halted. Completed and refused are an operator sweep (PURGE-264-R3-003). */
function requestIsLive(data: DocumentData, firmId: string, matterId: string): boolean {
  return data.firmId === firmId && data.matterId === matterId && data.status === "in_progress" && data.halted == null
}

function planPurges(data: DocumentData | undefined, key: string): boolean {
  const plan = data?.plan
  return !!plan && typeof plan === "object" && !Array.isArray(plan) && (plan as Record<string, unknown>)[key] === "purge"
}

function holdIsActive(data: DocumentData | undefined, firmId: string): boolean {
  return !!data && data.firmId === firmId && data.active === true
}

function chunkDocId(index: number): string {
  return `c${String(index).padStart(4, "0")}`
}

function unlinkedChunkRefs(requestRef: DocumentReference, request: DocumentData): DocumentReference[] {
  const count = typeof request.courtOpsUnlinkedChunks === "number" && request.courtOpsUnlinkedChunks > 0
    ? Math.floor(request.courtOpsUnlinkedChunks)
    : 0
  const col = requestRef.collection(courtOpsUnlinkedCollection())
  return Array.from({ length: count }, (_, index) => col.doc(chunkDocId(index)))
}

async function readDocs(tx: Transaction, refs: DocumentReference[]) {
  const snaps = []
  for (let start = 0; start < refs.length; start += 100) {
    const part = refs.slice(start, start + 100)
    if (part.length > 0) snaps.push(...await tx.getAll(...part))
  }
  return snaps
}

/** Delete only when Y's own live request purges this store and Y has no active hold. */
async function tombstonesThisPlanMayDelete(
  tx: Transaction,
  input: { db: Firestore; firmId: string },
  collection: ReachCollection,
  tombSnaps: ReadonlyArray<{ id: string; data: () => DocumentData | undefined }>,
  recorded: ReadonlySet<string>
): Promise<Set<string>> {
  const tombs = new Map(tombSnaps.map((snap) => [snap.id, snap.data()]))
  const requestIds = [...new Set([...recorded].flatMap((id) => {
    const requestId = tombs.get(id)?.requestId
    return typeof requestId === "string" && requestId !== "" ? [requestId] : []
  }))]
  const requestSnaps = await readDocs(tx, requestIds.map((id) => input.db.collection(DELETION_REQUESTS_COLLECTION).doc(id)))
  const requestById = new Map(requestSnaps.map((snap) => [snap.id, snap.data()]))
  const holdSnaps = await readDocs(tx, [...recorded].map((id) => input.db.collection(LEGAL_HOLDS_COLLECTION).doc(id)))
  const holdById = new Map(holdSnaps.map((snap) => [snap.id, snap.data()]))
  const key = STORE_KEY[collection]
  const deletable = new Set<string>()
  for (const id of recorded) {
    const requestId = tombs.get(id)?.requestId
    const request = typeof requestId === "string" ? requestById.get(requestId) : undefined
    if (!requestIsLive(request ?? {}, input.firmId, id)) continue
    if (!planPurges(request, key)) continue
    if (holdIsActive(holdById.get(id), input.firmId)) continue
    deletable.add(id)
  }
  return deletable
}

function recordUnlinked(
  tx: Transaction,
  requestRef: DocumentReference,
  request: DocumentData,
  items: readonly { id: string; reason: string }[]
): void {
  const snaps = (request.courtOpsChunks ?? []) as ReadonlyArray<{ data: () => DocumentData | undefined }>
  const chunks: string[][] = []
  const reasons = new Map<string, string>()
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const snap of snaps) {
    const data = snap.data() ?? {}
    const ids = Array.isArray(data.ids) ? data.ids.filter((id): id is string => typeof id === "string") : []
    chunks.push(ids)
    const stored = data.reasons
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      ordered.push(id)
      if (stored && typeof stored === "object" && !Array.isArray(stored) && typeof (stored as Record<string, unknown>)[id] === "string") {
        reasons.set(id, (stored as Record<string, string>)[id])
      }
    }
  }
  const fresh = items.filter((item) => !seen.has(item.id))
  if (fresh.length === 0) return
  let dirtyFrom = chunks.length
  if (chunks.length > 0 && chunks[chunks.length - 1].length < UNLINKED_CHUNK) dirtyFrom = chunks.length - 1
  else chunks.push([])
  for (const item of fresh) {
    seen.add(item.id)
    ordered.push(item.id)
    reasons.set(item.id, item.reason)
    if (chunks[chunks.length - 1].length >= UNLINKED_CHUNK) chunks.push([])
    chunks[chunks.length - 1].push(item.id)
  }
  const sample = ordered.slice(0, UNLINKED_SAMPLE)
  const sampleReasons: Record<string, string> = {}
  for (const id of sample) {
    const reason = reasons.get(id)
    if (reason !== undefined) sampleReasons[id] = reason
  }
  tx.set(requestRef, {
    courtOpsUnlinked: sample,
    courtOpsUnlinkedReasons: sampleReasons,
    courtOpsUnlinkedCount: ordered.length,
    courtOpsUnlinkedTruncated: ordered.length > sample.length,
    courtOpsUnlinkedChunks: chunks.length,
  }, { merge: true })
  const col = requestRef.collection(courtOpsUnlinkedCollection())
  for (let index = dirtyFrom; index < chunks.length; index += 1) {
    const ids = chunks[index]
    const chunkReasons: Record<string, string> = {}
    for (const id of ids) {
      const reason = reasons.get(id)
      if (reason !== undefined) chunkReasons[id] = reason
    }
    tx.set(col.doc(chunkDocId(index)), { firmId: request.firmId, requestId: requestRef.id, ids, reasons: chunkReasons })
  }
}
