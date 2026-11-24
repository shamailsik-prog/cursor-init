import { Timestamp, type DocumentData, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import type { DocumentRecord } from "@/platform/spine/store"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import type { Caller } from "../../p5/auth"
import { isSafeDocId } from "../../p5/common"
import { isKnownClassification } from "../../p5/classification"
import { assertLooseVaultActor, assertLooseVaultEnabled, auditLoose, canReadBoundRow, canonicalLoose, clearanceCovers, looseFirmDocs, looseNotFound, looseReader, looseUploaderDocs } from "./flag"

/** Thirty 24-hour days. Not a calendar month. Due at this age, and not one millisecond before. */
export const LOOSE_VAULT_HOLD_MS = 30 * 24 * 60 * 60 * 1000

export type LooseEscalation = {
  docId: string
  holderId: string
  /** Null when the row has no readable `createdAt`. The row is still escalated. */
  ageMs: number | null
  acknowledged: boolean
  /** True when the stored row is not a canonical document. It still counts as overdue. */
  malformed: boolean
}

export function instantMillis(value: unknown): number | null {
  if (value instanceof Timestamp) {
    const ms = value.toMillis()
    return Number.isFinite(ms) ? ms : null
  }
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === "number" && Number.isFinite(value)) return value
  return null
}

export function looseAgeMs(createdAt: unknown, now: Date): number | null {
  const ms = instantMillis(createdAt)
  if (ms === null) return null
  return now.getTime() - ms
}

/** Undated loose rows are overdue. A readable age is overdue at exactly 30 days. */
export function looseHoldOverdue(createdAt: unknown, now: Date): boolean {
  const age = looseAgeMs(createdAt, now)
  if (age === null) return true
  return age >= LOOSE_VAULT_HOLD_MS
}

export function partnerAcknowledged(data: DocumentData): boolean {
  const ack = data.loosePartnerAck
  if (!ack || typeof ack !== "object" || Array.isArray(ack)) return false
  const partnerId = (ack as { partnerId?: unknown }).partnerId
  const at = (ack as { acknowledgedAt?: unknown }).acknowledgedAt
  return typeof partnerId === "string" && partnerId.trim() !== "" && instantMillis(at) !== null
}

function validNow(now: Date): void {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new HttpError(400, "invalid_query")
}

/** The loose query already constrained firm and matterId. A row that fails that shape is not this firm's loose file. */
function isQueriedLoose(data: DocumentData | undefined, firmId: string): data is DocumentData {
  return !!data && data.firmId === firmId && data.matterId === null
}

function rawHolder(data: DocumentData): string {
  return typeof data.uploadedBy === "string" ? data.uploadedBy : ""
}

/**
 * Loose rows in the firm older than 30 days, with holder and age. Acknowledged rows stay in the
 * list (the hold is still visible) and are marked. This function writes nothing.
 */
export async function looseVaultEscalations(actor: Caller, firmId: string, now: Date): Promise<{ items: LooseEscalation[] }> {
  assertLooseVaultActor(actor)
  if (!isSafeDocId(firmId) || actor.firmId !== firmId) throw looseNotFound()
  validNow(now)
  const readable = looseReader(actor)
  const items: LooseEscalation[] = []
  for (const doc of await looseFirmDocs(firmId)) {
    const data = doc.data()
    if (!isQueriedLoose(data, firmId)) continue
    const record = canonicalLoose(doc.id, data)
    if (!record) {
      // A clerk can spoil sourceChannel or a size field and make the row unreadable. That must not hide it.
      if (!clearanceCovers(actor, data.classification)) continue
      items.push({
        docId: doc.id,
        holderId: rawHolder(data),
        ageMs: looseAgeMs(data.createdAt, now),
        acknowledged: partnerAcknowledged(data),
        malformed: true,
      })
      continue
    }
    if (record.matterId !== null || record.firmId !== firmId) continue
    if (!readable(record)) continue
    if (!looseHoldOverdue(data.createdAt, now)) continue
    items.push({
      docId: doc.id,
      holderId: record.uploadedBy,
      ageMs: looseAgeMs(data.createdAt, now),
      acknowledged: partnerAcknowledged(data),
      malformed: false,
    })
  }
  items.sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0))
  return { items }
}

/**
 * True while this uploader has a loose file in this firm aged at least 30 days that no partner
 * has acknowledged. Converted rows are not loose, so they do not count. A colleague's file does
 * not count. See README for why this is per uploader rather than firm-wide.
 * Flag off throws feature_disabled before any read. That is not a block; the vault is off.
 */
export async function isLooseUploadBlocked(firmId: string, uploaderId: string, now: Date): Promise<boolean> {
  assertLooseVaultEnabled()
  if (!isSafeDocId(firmId) || !isSafeDocId(uploaderId)) throw new HttpError(400, "invalid_query")
  validNow(now)
  for (const doc of await looseUploaderDocs(firmId, uploaderId)) {
    const data = doc.data()
    if (!isQueriedLoose(data, firmId)) continue
    const record = canonicalLoose(doc.id, data)
    if (!record) {
      if (!partnerAcknowledged(data)) return true
      continue
    }
    if (record.firmId !== firmId || record.matterId !== null) continue
    if (record.uploadedBy !== uploaderId) continue
    if (partnerAcknowledged(data)) continue
    if (looseHoldOverdue(data.createdAt, now)) return true
  }
  return false
}

/** A known stored label, or the fail-closed maximum when the row's label cannot be read. */
function auditLabel(label: unknown): DocumentRecord["classification"] {
  return isKnownClassification(label) ? label : "privileged-restricted"
}

/**
 * Partner acknowledgement of a loose hold. Lifts that row out of the upload block. Does not
 * change `matterId` or classification, and does not remove the row. Clerks are refused before any read.
 * A malformed loose row is acknowledged from the raw document: same firm, `matterId === null`, and
 * the caller's clearance covers the stored label (an unreadable label ranks as the maximum).
 */
export async function acknowledgeLooseHold(actor: Caller, docId: string, now: Date): Promise<{ docId: string }> {
  assertLooseVaultActor(actor)
  if (actor.role !== "partner") throw new HttpError(403, "partner_only")
  if (!isSafeDocId(docId)) throw new HttpError(400, "invalid_query")
  validNow(now)
  await adminDb().runTransaction(async (tx) => {
    const ref = adminDb().collection("documents").doc(docId)
    const snap = await tx.get(ref)
    const data = snap.data()
    if (!snap.exists || !data || data.firmId !== actor.firmId) throw looseNotFound()
    const record = canonicalLoose(snap.id, data)
    if (!record) {
      if (data.matterId !== null || !clearanceCovers(actor, data.classification)) throw looseNotFound()
      writeLooseAck(tx, ref, data, actor, docId, now, auditLabel(data.classification))
      return
    }
    if (record.firmId !== actor.firmId) throw looseNotFound()
    if (record.matterId !== null) {
      const matterId = record.matterId
      const matterSnap = await tx.get(adminDb().collection("matters").doc(matterId))
      const memberSnap = await tx.get(adminDb().collection("matter_members").doc(`${matterId}_${actor.uid}`))
      const matterData = matterSnap.data()
      const classification = isKnownClassification(matterData?.classification) ? matterData.classification : "privileged-restricted"
      const view = matterData && typeof matterData.firmId === "string" ? { id: matterId, firmId: matterData.firmId, classification } : null
      const member = memberSnap.data()
      const isMember = !!member && member.firmId === actor.firmId && member.userId === actor.uid && member.matterId === matterId
      if (!canReadBoundRow(actor, record, view, isMember)) throw looseNotFound()
      throw new HttpError(409, "not_loose")
    }
    if (!looseReader(actor)(record)) throw looseNotFound()
    writeLooseAck(tx, ref, data, actor, docId, now, record.classification)
  })
  return { docId }
}

function writeLooseAck(
  tx: Transaction,
  ref: DocumentReference,
  data: DocumentData,
  actor: Caller,
  docId: string,
  now: Date,
  classification: DocumentRecord["classification"]
): void {
  const reason = partnerAcknowledged(data) ? "already_acknowledged" : "ok"
  if (reason === "ok") {
    tx.update(ref, {
      loosePartnerAck: { partnerId: actor.uid, acknowledgedAt: Timestamp.fromDate(now) },
    })
  }
  auditLoose(tx, {
    firmId: actor.firmId,
    actorId: actor.uid,
    action: "loose_vault.acknowledge",
    docId,
    classification,
    reason,
  })
}
