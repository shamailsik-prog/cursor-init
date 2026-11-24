import type { Classification } from "@/platform/p1/types"
import type { DocumentData } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import type { Caller } from "../../p5/auth"
import { isKnownClassification } from "../../p5/classification"
import { isSafeDocId } from "../../p5/common"
import {
  auditLoose,
  assertLooseVaultActor,
  canReadBoundRow,
  canonicalLoose,
  clearanceCovers,
  looseNotFound,
  looseReader,
} from "./flag"

export type ConvertResult = {
  docId: string
  matterId: string
  alreadyConverted: boolean
  classification: Classification
}

function matterView(data: DocumentData | undefined, id: string): { id: string; firmId: string; classification: Classification } | null {
  if (!data || typeof data.firmId !== "string") return null
  const classification: Classification = isKnownClassification(data.classification) ? data.classification : "privileged-restricted"
  return { id, firmId: data.firmId, classification }
}

function memberMatches(data: DocumentData | undefined, actor: Caller, matterId: string): boolean {
  if (!data) return false
  return data.firmId === actor.firmId && data.userId === actor.uid && data.matterId === matterId
}

/**
 * Attach a loose file to one matter. The only document field written is `matterId`, so the
 * classification cannot move down (and is not raised either). The same target is idempotent.
 * A different matter is refused. There is no path that clears `matterId`.
 */
export async function convertToMatter(actor: Caller, docId: string, matterId: string): Promise<ConvertResult> {
  assertLooseVaultActor(actor)
  if (!isSafeDocId(docId) || !isSafeDocId(matterId)) throw new HttpError(400, "invalid_query")
  return adminDb().runTransaction(async (tx) => {
    const ref = adminDb().collection("documents").doc(docId)
    const snap = await tx.get(ref)
    const data = snap.data()
    const record = snap.exists ? canonicalLoose(snap.id, data) : null
    if (!record || record.firmId !== actor.firmId) throw looseNotFound()

    const current = record.matterId
    if (current !== null && current !== matterId) {
      const matterSnap = await tx.get(adminDb().collection("matters").doc(current))
      const memberSnap = await tx.get(adminDb().collection("matter_members").doc(`${current}_${actor.uid}`))
      const readable = canReadBoundRow(actor, record, matterView(matterSnap.data(), current), memberMatches(memberSnap.data(), actor, current))
      if (!readable) throw looseNotFound()
      throw new HttpError(409, "convert_target_conflict")
    }

    const targetSnap = await tx.get(adminDb().collection("matters").doc(matterId))
    const targetMember = await tx.get(adminDb().collection("matter_members").doc(`${matterId}_${actor.uid}`))
    const target = matterView(targetSnap.data(), matterId)

    if (current === matterId) {
      const readable = canReadBoundRow(actor, record, target, memberMatches(targetMember.data(), actor, matterId))
      if (!readable) throw looseNotFound()
      auditLoose(tx, {
        firmId: actor.firmId,
        actorId: actor.uid,
        action: "loose_vault.convert",
        docId,
        classification: record.classification,
        reason: "already_converted",
      })
      return { docId, matterId, alreadyConverted: true, classification: record.classification }
    }

    if (!looseReader(actor)(record)) throw looseNotFound()
    if (!target || target.firmId !== actor.firmId) throw looseNotFound()
    if (!memberMatches(targetMember.data(), actor, matterId)) throw new HttpError(403, "not_a_member")
    if (!clearanceCovers(actor, targetSnap.data()?.classification)) throw new HttpError(403, "exceeds_own_clearance")
    const projected = { ...record, matterId }
    if (!canReadBoundRow(actor, projected, target, true)) throw looseNotFound()

    tx.update(ref, { matterId })
    auditLoose(tx, {
      firmId: actor.firmId,
      actorId: actor.uid,
      action: "loose_vault.convert",
      docId,
      classification: record.classification,
      reason: "ok",
    })
    return { docId, matterId, alreadyConverted: false, classification: record.classification }
  })
}
