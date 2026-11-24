import { FieldPath, Timestamp, type DocumentData, type DocumentReference, type Query, type QueryDocumentSnapshot, type Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { DraftCharsetError, requireSupportedDraftBody } from "@/services/d4-2/draftCharset"
import { adminDb } from "../admin"
import { isContentionAbort } from "../d1/contention"
import { decodeCursor, encodeCursor, type Page } from "../d1/pagination"
import { HttpError } from "../http/errors"
import type { Caller } from "../p5/auth"
import { isKnownClassification, rankOf } from "../p5/classification"
import type { CallAudit } from "../p5/common"
import { loadDraftForCaller, MAX_BODY_BYTES, raisedLabel, requireStillPermitted, sha256Hex, storeVersion, type DraftView } from "./drafts"

/**
 * L5.1 live draft autosave (spec lines 3759–3792). Rolling recovery points in `draft_autosave_points`,
 * separate from the immutable `draft_versions`. Off unless `SIKANDER_FLAG_D4_AUTOSAVE` is exactly `true`
 * (trim, then lower case), the same rule as `services/d2-1/grammar.ts`. Unset means off.
 *
 * Not mounted on the HTTP router. Wave 2 wires the routes. Callers pass the same `draft.edit` guard the
 * save path uses (`loadDraftForCaller` and, inside the write, `requireStillPermitted`).
 */

export const D4_AUTOSAVE_FLAG = "D4_AUTOSAVE"

/** Newest points kept per draft. Older points of that draft are removed unless a restore referenced them. */
export const AUTOSAVE_POINT_CAP = 200

const POINT_SEQ_WIDTH = 10

export function isD4AutosaveEnabled(): boolean {
  return process.env[`SIKANDER_FLAG_${D4_AUTOSAVE_FLAG}`]?.trim().toLowerCase() === "true"
}

export type AutosavePointMeta = {
  pointSeq: number
  clientSeq: number
  bodyHash: string
  createdAt: string | null
  classification: Classification
}

export type AutosaveResult =
  | { written: false; reason: "disabled" | "stale_seq" | "duplicate_body" }
  | { written: true; pointSeq: number; clientSeq: number; bodyHash: string; classification: Classification }

export type RestorePointResult = { restored: false; reason: "disabled" } | { restored: true; saved: boolean; draft: DraftView; pointSeq: number }

const autosavePoints = () => adminDb().collection("draft_autosave_points")

const notFound = () => new HttpError(404, "not_found")

const iso = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null)

function cleared(raw: unknown, clearance: Classification): boolean {
  return isKnownClassification(raw) && rankOf(raw) <= rankOf(clearance)
}

/** A cross-firm draft and a non-member are both 404, the same answer as a missing draft. */
async function loadEditableDraft(caller: Caller, draftId: string): Promise<{ ref: DocumentReference; draft: DocumentData }> {
  try {
    return await loadDraftForCaller(caller, draftId, "draft.edit")
  } catch (err) {
    if (err instanceof HttpError && err.status === 403 && err.code === "not_member") throw notFound()
    throw err
  }
}

async function stillPermitted(tx: Transaction, caller: Caller, matterId: string): Promise<DocumentData> {
  try {
    return await requireStillPermitted(tx, caller, "draft.edit", matterId)
  } catch (err) {
    if (err instanceof HttpError && err.status === 403 && err.code === "not_member") throw notFound()
    throw err
  }
}

function parseClientSeq(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, "invalid_client_seq")
  return value
}

function parseBaseVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, "invalid_version")
  return value
}

function parsePointSeq(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 9_999_999_999) throw new HttpError(400, "invalid_point")
  return value
}

function parseLimit(value: number | undefined): number {
  if (value === undefined) return 20
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100) throw new HttpError(400, "invalid_limit")
  return value
}

/** The stored body: the charset layer's NFC text, then the same 900,000-byte cap as a formal version. */
function normaliseBody(raw: unknown): string {
  if (typeof raw !== "string") throw new HttpError(400, "invalid_body")
  let body: string
  try {
    body = requireSupportedDraftBody(raw)
  } catch (err) {
    if (err instanceof DraftCharsetError) throw new HttpError(422, err.code)
    throw err
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new HttpError(422, "draft_too_large")
  return body
}

function pointDocId(draftId: string, pointSeq: number): string {
  return `${draftId}_${String(pointSeq).padStart(POINT_SEQ_WIDTH, "0")}`
}

function idPrefix(draftId: string): string {
  return `${draftId}_`
}

function idEnd(draftId: string): string {
  return `${idPrefix(draftId)}\uf8ff`
}

/**
 * One cursor document per draft, outside the point-id range (`draftId` + `~`, which sorts after `draftId_`).
 * Firestore refuses a descending document-id scan, and this wave cannot add a composite index, so the cursor
 * is how a new point learns the last seq, the last clientSeq and the last hash without reading every point.
 */
function headRef(draftId: string): DocumentReference {
  return autosavePoints().doc(`${draftId}~head`)
}

type Head = { lastPointSeq: number; lastClientSeq: number; lastBodyHash: string; classification?: unknown }

function readHead(data: DocumentData | undefined, caller: Caller, draftId: string): Head | undefined {
  if (!data) return undefined
  if (data.record !== "head" || data.firmId !== caller.firmId || data.draftId !== draftId) throw new HttpError(409, "draft_changed")
  if (typeof data.lastPointSeq !== "number" || typeof data.lastClientSeq !== "number" || typeof data.lastBodyHash !== "string") throw new HttpError(409, "draft_changed")
  return { lastPointSeq: data.lastPointSeq, lastClientSeq: data.lastClientSeq, lastBodyHash: data.lastBodyHash, classification: data.classification }
}

/**
 * The label stored on a point: the strictest of the draft's label and the matter's current label
 * (`raisedLabel`, the same rule a new formal version uses). It is never below the draft's own label.
 */
function pointClassification(caller: Caller, draft: DocumentData, matter: DocumentData): Classification {
  if (!isKnownClassification(draft.classification)) throw new HttpError(403, "clearance")
  const classification = raisedLabel(caller, draft, matter)
  if (rankOf(classification) < rankOf(draft.classification)) throw new HttpError(403, "clearance")
  return classification
}

function refuseApprovedOrLocked(draft: DocumentData): void {
  if (draft.status === "approved") throw new HttpError(409, "draft_approved")
  if (draft.locked === true) throw new HttpError(409, "draft_locked")
}

function nextPointSeq(last: DocumentData | undefined): number {
  if (!last) return 1
  const seq = last.pointSeq
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || seq >= 9_999_999_999) throw new HttpError(409, "draft_changed")
  return seq + 1
}

function alreadyExists(err: unknown): boolean {
  if (!(err instanceof Error) || err instanceof HttpError) return false
  const code = (err as { code?: unknown }).code
  return code === 6 || code === "already-exists"
}

async function eachPoint(tx: Transaction, draftId: string, visit: (doc: QueryDocumentSnapshot) => "stop" | void): Promise<void> {
  let after: string | undefined
  for (;;) {
    let q: Query = autosavePoints().where(FieldPath.documentId(), ">=", idPrefix(draftId)).where(FieldPath.documentId(), "<", idEnd(draftId)).orderBy(FieldPath.documentId(), "asc")
    if (after) q = q.startAfter(after)
    const snap = await tx.get(q.limit(50))
    if (snap.empty) return
    for (const doc of snap.docs) {
      if (visit(doc) === "stop") return
    }
    if (snap.size < 50) return
    after = snap.docs[snap.docs.length - 1].id
  }
}

/**
 * autosaveDraft(draftId, body, clientSeq, baseVersion). A point is written only when the flag is on,
 * `clientSeq` is greater than the last point's, and the body hash differs from that point's. A stale
 * or duplicate call commits nothing but its audit row. `baseVersion` above the current formal version
 * is 409 `draft_changed`; an older base is still stored, so a keystroke is not dropped because a
 * formal save landed first.
 */
export async function autosaveDraft(
  caller: Caller,
  audit: CallAudit,
  draftId: string,
  body: string,
  clientSeq: number,
  baseVersion: number
): Promise<AutosaveResult> {
  if (!isD4AutosaveEnabled()) return { written: false, reason: "disabled" }
  audit.firmId = caller.firmId
  audit.target = `drafts/${draftId}`
  const seq = parseClientSeq(clientSeq)
  const base = parseBaseVersion(baseVersion)
  const text = normaliseBody(body)
  const { ref } = await loadEditableDraft(caller, draftId)

  let out: AutosaveResult
  try {
    out = await adminDb().runTransaction(
      async (tx) => {
        const stamp = Timestamp.now()
        const draft = (await tx.get(ref)).data()
        if (!draft || draft.firmId !== caller.firmId || typeof draft.matterId !== "string" || !cleared(draft.classification, caller.clearanceLevel)) throw notFound()
        const matter = await stillPermitted(tx, caller, draft.matterId)
        if (typeof draft.currentVersion !== "number" || base > draft.currentVersion) throw new HttpError(409, "draft_changed")
        const classification = pointClassification(caller, draft, matter)
        const head = readHead((await tx.get(headRef(draftId))).data(), caller, draftId)
        if (head && seq <= head.lastClientSeq) {
          await audit.stage(tx, "allow", "ok")
          return { written: false, reason: "stale_seq" }
        }
        const bodyHash = sha256Hex(text)
        if (head && head.lastBodyHash === bodyHash) {
          await audit.stage(tx, "allow", "ok")
          return { written: false, reason: "duplicate_body" }
        }

        const pointSeq = head ? nextPointSeq({ pointSeq: head.lastPointSeq }) : 1
        const deletes: DocumentReference[] = []
        if (pointSeq > AUTOSAVE_POINT_CAP) {
          const cutoff = pointSeq - AUTOSAVE_POINT_CAP
          await eachPoint(tx, draftId, (doc) => {
            const row = doc.data()
            if (row.firmId !== caller.firmId || row.draftId !== draftId) return
            if (typeof row.pointSeq !== "number" || row.pointSeq > cutoff) return "stop"
            if (row.referencedByRestore === true) return
            deletes.push(doc.ref)
          })
        }
        const lastRank = head && isKnownClassification(head.classification) ? rankOf(head.classification) : null
        const lifts: DocumentReference[] = []
        if (head && (lastRank === null || lastRank < rankOf(classification))) {
          const deleting = new Set(deletes.map((item) => item.id))
          await eachPoint(tx, draftId, (doc) => {
            if (deleting.has(doc.id)) return
            const row = doc.data()
            if (row.firmId !== caller.firmId || row.draftId !== draftId) return
            if (!isKnownClassification(row.classification) || rankOf(row.classification) < rankOf(classification)) lifts.push(doc.ref)
          })
        }

        await audit.stage(tx, "allow", "ok")
        const headUpdate = {
          record: "head",
          firmId: caller.firmId,
          draftId,
          matterId: draft.matterId,
          lastPointSeq: pointSeq,
          lastClientSeq: seq,
          lastBodyHash: bodyHash,
          classification,
          updatedAt: stamp,
        }
        if (head) tx.update(headRef(draftId), headUpdate)
        else tx.create(headRef(draftId), headUpdate)
        tx.create(autosavePoints().doc(pointDocId(draftId, pointSeq)), {
          firmId: caller.firmId,
          matterId: draft.matterId,
          draftId,
          pointSeq,
          clientSeq: seq,
          bodyHash,
          body: text,
          createdAt: stamp,
          classification,
          referencedByRestore: false,
        })
        for (const item of deletes) tx.delete(item)
        for (const item of lifts) tx.update(item, { classification })
        return { written: true, pointSeq, clientSeq: seq, bodyHash, classification }
      },
      { maxAttempts: 10 }
    )
  } catch (err) {
    if (isContentionAbort(err) || alreadyExists(err)) throw new HttpError(409, "draft_changed")
    throw err
  }
  audit.committed()
  return out
}

function parseCursor(draftId: string, cursor: string | null): string | null {
  if (cursor === null || cursor === "") return null
  const decoded = decodeCursor(cursor)
  if (!/^[1-9]\d{0,15}$/.test(decoded.sortKey)) throw new HttpError(400, "invalid_cursor")
  const pointSeq = Number(decoded.sortKey)
  if (decoded.id !== pointDocId(draftId, pointSeq)) throw new HttpError(400, "invalid_cursor")
  return decoded.id
}

/** Every point of one draft, oldest first. A descending document-id scan is refused, so the timeline reverses these. */
async function readDraftPoints(draftId: string): Promise<QueryDocumentSnapshot[]> {
  const out: QueryDocumentSnapshot[] = []
  let after: string | undefined
  for (;;) {
    let q: Query = autosavePoints().where(FieldPath.documentId(), ">=", idPrefix(draftId)).where(FieldPath.documentId(), "<", idEnd(draftId)).orderBy(FieldPath.documentId(), "asc")
    if (after) q = q.startAfter(after)
    const snap = await q.limit(100).get()
    if (snap.empty) return out
    out.push(...snap.docs)
    if (snap.size < 100) return out
    after = snap.docs[snap.docs.length - 1].id
  }
}

function toMeta(doc: QueryDocumentSnapshot): AutosavePointMeta | null {
  const row = doc.data()
  if (!isKnownClassification(row.classification) || typeof row.pointSeq !== "number" || typeof row.clientSeq !== "number" || typeof row.bodyHash !== "string") return null
  return { pointSeq: row.pointSeq, clientSeq: row.clientSeq, bodyHash: row.bodyHash, createdAt: iso(row.createdAt), classification: row.classification }
}

/**
 * getRecoveryTimeline(draftId, cursor). Newest point first, one draft, one firm. The page is metadata
 * only (no body). A cursor that does not name one of this draft's point ids is 400 `invalid_cursor`.
 */
export async function getRecoveryTimeline(caller: Caller, audit: CallAudit, draftId: string, cursor: string | null, limit?: number): Promise<Page<AutosavePointMeta>> {
  if (!isD4AutosaveEnabled()) return { items: [], nextCursor: null }
  audit.firmId = caller.firmId
  audit.target = `drafts/${draftId}`
  const pageLimit = parseLimit(limit)
  const after = parseCursor(draftId, cursor)
  await loadEditableDraft(caller, draftId)
  const afterSeq = after === null ? null : Number(decodeCursor(cursor ?? "").sortKey)
  const newestFirst = (await readDraftPoints(draftId)).reverse()
  const visible = newestFirst.flatMap((doc): AutosavePointMeta[] => {
    const row = doc.data()
    if (row.firmId !== caller.firmId || row.draftId !== draftId) return []
    if (afterSeq !== null && !(typeof row.pointSeq === "number" && row.pointSeq < afterSeq)) return []
    if (!cleared(row.classification, caller.clearanceLevel)) return []
    const meta = toMeta(doc)
    return meta ? [meta] : []
  })
  const more = visible.length > pageLimit
  const items = visible.slice(0, pageLimit)
  await audit.allow()
  const last = items[items.length - 1]
  return { items, nextCursor: more && last ? encodeCursor(String(last.pointSeq), pointDocId(draftId, last.pointSeq)) : null }
}

/**
 * restorePoint(draftId, pointSeq). Appends a formal version through `storeVersion` (kind `save`), so the
 * event, the audit row and the gate reset match an edit. Old versions are not rewritten. An approved or
 * locked draft is refused. The point is marked so a later prune of this draft leaves it in place.
 */
export async function restorePoint(caller: Caller, audit: CallAudit, draftId: string, pointSeq: number): Promise<RestorePointResult> {
  if (!isD4AutosaveEnabled()) return { restored: false, reason: "disabled" }
  audit.firmId = caller.firmId
  audit.target = `drafts/${draftId}`
  const seq = parsePointSeq(pointSeq)
  const { ref, draft } = await loadEditableDraft(caller, draftId)
  refuseApprovedOrLocked(draft)
  if (typeof draft.currentVersion !== "number") throw new HttpError(409, "draft_changed")
  const pointRef = autosavePoints().doc(pointDocId(draftId, seq))
  const saved = await storeVersion(
    caller,
    audit,
    ref,
    draft.currentVersion,
    "save",
    async (tx) => {
      const row = (await tx.get(pointRef)).data()
      if (!row || row.firmId !== caller.firmId || row.draftId !== draftId || row.pointSeq !== seq || typeof row.body !== "string") {
        throw new HttpError(404, "point_not_found")
      }
      const current = (await tx.get(ref)).data()
      if (!current || current.firmId !== caller.firmId || typeof current.title !== "string") throw notFound()
      tx.update(pointRef, { referencedByRestore: true })
      return { title: current.title, body: row.body }
    },
    refuseApprovedOrLocked
  )
  return { restored: true, saved: saved.saved, draft: saved.draft, pointSeq: seq }
}
