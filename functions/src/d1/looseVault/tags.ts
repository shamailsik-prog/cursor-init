import type { DocumentData, DocumentReference, Transaction } from "firebase-admin/firestore"
import { normalisePhone } from "../conflict/normalise"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import type { Caller } from "../../p5/auth"
import { isSafeDocId } from "../../p5/common"
import { isKnownClassification } from "../../p5/classification"
import {
  auditLoose,
  assertLooseVaultActor,
  canReadBoundRow,
  canonicalLoose,
  looseNotFound,
  looseReader,
} from "./flag"

/** Recall tags stored on the existing `documents` row. There is no separate vault collection. */
export type LooseTags = {
  clientName: string | null
  reference: string | null
  phone: string | null
  keys: string[]
}

export type LooseTagInput = {
  clientName?: string | null
  reference?: string | null
  phone?: string | null
  keys?: readonly string[] | null
}

const MAX_NAME = 200
const MAX_REF = 120
const MAX_KEY = 80
const MAX_KEYS = 20

export function emptyLooseTags(): LooseTags {
  return { clientName: null, reference: null, phone: null, keys: [] }
}

export function readLooseTags(raw: unknown): LooseTags {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyLooseTags()
  const row = raw as Record<string, unknown>
  const keys = Array.isArray(row.keys) ? row.keys.filter((key): key is string => typeof key === "string") : []
  return {
    clientName: typeof row.clientName === "string" ? row.clientName : null,
    reference: typeof row.reference === "string" ? row.reference : null,
    phone: typeof row.phone === "string" ? row.phone : null,
    keys,
  }
}

function foldText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== "string") throw new HttpError(400, "invalid_query")
  const folded = value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
  if (folded.length === 0) return null
  if (folded.length > max) throw new HttpError(400, "invalid_query")
  return folded
}

function foldPhone(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== "string") throw new HttpError(400, "invalid_query")
  if (value.trim() === "") return null
  const phone = normalisePhone(value)
  if (!phone) throw new HttpError(400, "invalid_phone")
  return phone
}

function foldKeys(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (value === null) return []
  if (!Array.isArray(value) || value.length > MAX_KEYS) throw new HttpError(400, "invalid_query")
  const keys: string[] = []
  for (const item of value) {
    const folded = foldText(item, MAX_KEY)
    if (typeof folded !== "string") throw new HttpError(400, "invalid_query")
    if (!keys.includes(folded)) keys.push(folded)
  }
  keys.sort()
  return keys
}

/** Merge a tag write onto the stored tags. Omitted fields stay. Null clears. */
export function applyLooseTags(current: LooseTags, input: LooseTagInput): LooseTags {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "invalid_query")
  const clientName = foldText(input.clientName, MAX_NAME)
  const reference = foldText(input.reference, MAX_REF)
  const phone = foldPhone(input.phone)
  const keys = foldKeys(input.keys)
  if (clientName === undefined && reference === undefined && phone === undefined && keys === undefined) {
    throw new HttpError(400, "invalid_query")
  }
  return {
    clientName: clientName === undefined ? current.clientName : clientName,
    reference: reference === undefined ? current.reference : reference,
    phone: phone === undefined ? current.phone : phone,
    keys: keys === undefined ? current.keys : keys,
  }
}

/** True when the query hits any stored tag. Phone uses the conflict-engine E.164 form. */
export function looseTagMatches(tags: LooseTags, query: string): boolean {
  const phone = normalisePhone(query)
  if (phone && tags.phone === phone) return true
  const digits = query.replace(/\D/g, "")
  if (digits.length >= 7 && tags.phone && tags.phone.replace(/\D/g, "").includes(digits)) return true
  const folded = query.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
  if (folded.length === 0) return false
  const haystack = [tags.clientName, tags.reference, ...tags.keys]
  return haystack.some((value) => value !== null && value.includes(folded))
}

function matterView(snap: DocumentData | undefined, id: string): { id: string; firmId: string; classification: DocumentRecordClassification } | null {
  if (!snap || typeof snap.firmId !== "string") return null
  const classification = isKnownClassification(snap.classification) ? snap.classification : "privileged-restricted"
  return { id, firmId: snap.firmId, classification }
}

type DocumentRecordClassification = import("@/platform/p1/types").Classification

function memberMatches(data: DocumentData | undefined, actor: Caller, matterId: string): boolean {
  if (!data) return false
  return data.firmId === actor.firmId && data.userId === actor.uid && data.matterId === matterId
}

/**
 * Tag a loose row (`matterId === null`) in place. A matter-bound row the actor can read is
 * `not_loose`; anything they cannot read is `not_found`, with no field from the row in the error.
 */
export async function tagLooseFile(actor: Caller, docId: string, tags: LooseTagInput): Promise<{ docId: string; looseTags: LooseTags }> {
  assertLooseVaultActor(actor)
  if (!isSafeDocId(docId)) throw new HttpError(400, "invalid_query")
  const looseTags = await adminDb().runTransaction(async (tx) => {
    const ref = adminDb().collection("documents").doc(docId)
    const snap = await tx.get(ref)
    const data = snap.data()
    const record = snap.exists ? canonicalLoose(snap.id, data) : null
    if (!record || record.firmId !== actor.firmId) throw looseNotFound()
    if (record.matterId !== null) {
      const matterId = record.matterId
      const matterSnap = await tx.get(adminDb().collection("matters").doc(matterId))
      const memberSnap = await tx.get(adminDb().collection("matter_members").doc(`${matterId}_${actor.uid}`))
      const readable = canReadBoundRow(actor, record, matterView(matterSnap.data(), matterId), memberMatches(memberSnap.data(), actor, matterId))
      if (!readable) throw looseNotFound()
      throw new HttpError(409, "not_loose")
    }
    if (!looseReader(actor)(record)) throw looseNotFound()
    const next = applyLooseTags(readLooseTags(data?.looseTags), tags)
    writeTags(tx, ref, actor, record, next)
    return next
  })
  return { docId, looseTags }
}

function writeTags(
  tx: Transaction,
  ref: DocumentReference,
  actor: Caller,
  record: { classification: DocumentRecordClassification; id: string; firmId: string },
  looseTags: LooseTags
): void {
  tx.update(ref, { looseTags })
  auditLoose(tx, {
    firmId: actor.firmId,
    actorId: actor.uid,
    action: "loose_vault.tag",
    docId: record.id,
    classification: record.classification,
    reason: "ok",
  })
}
