import { createHash } from "node:crypto"
import type { Classification } from "@/platform/p1/types"
import { classificationRank, isClassification } from "@/platform/p1/types"
import type { Role } from "@/platform/spine/store"
import { canonicalJson } from "../../http/idempotency"

/**
 * Module 4 evidence register and custody chain (architecture lines 1189–1209).
 *
 * A custody event is immutable. Its hash is
 * `sha256(canonicalJson(event without hash) + prevHash)` over UTF-8, lowercase
 * hex. `prevHash` is a field of that JSON and is concatenated again, so a
 * rewritten previous digest cannot be hidden by sorting keys. Seq 1 uses the
 * empty genesis digest. The document id is `${evidenceId}_${seq}` and is not
 * part of the hashed body.
 */

export const EVIDENCE_ITEMS = "evidence_items"
export const CUSTODY_EVENTS = "custody_events"
export const GENESIS_PREV_HASH = ""

export const CUSTODY_KINDS = ["receipt", "transfer", "handling", "condition", "annotation", "link"] as const
export type CustodyKind = (typeof CUSTODY_KINDS)[number]

export class EvidenceError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = "EvidenceError"
    this.code = code
  }
}

export type EvidenceActor = {
  uid: string
  firmId: string
  role: Role
  clearanceLevel: Classification
}

export type EvidenceClock = { now?: () => number }

export type EvidenceItem = {
  id: string
  firmId: string
  matterId: string
  item: string
  source: string
  receiptDate: string
  custodian: string
  classification: Classification
  documentId: string | null
  createdBy: string
  createdAt: string
  eventCount: number
}

export type CustodyEvent = {
  id: string
  evidenceId: string
  firmId: string
  matterId: string
  seq: number
  kind: CustodyKind
  actorId: string
  at: string
  note: string
  custodian: string
  documentId: string | null
  classification: Classification
  prevHash: string
  hash: string
}

export type ChainVerification =
  | { ok: true; eventCount: number }
  | { ok: false; brokenSeq: number; reason: "gap" | "duplicate" | "hash" | "prev" | "identity" | "malformed" }

export type LogEvidenceInput = {
  matterId: string
  item: string
  source: string
  receiptDate: string
  custodian: string
  classification: Classification
}

export type AddCustodyInput = {
  evidenceId: string
  kind: "receipt" | "transfer" | "handling" | "condition" | "annotation"
  note: string
  custodian?: string
}

export type LinkEvidenceInput = {
  evidenceId: string
  documentId: string
}

const EVENT_KEYS = [
  "actorId",
  "at",
  "classification",
  "custodian",
  "documentId",
  "evidenceId",
  "firmId",
  "hash",
  "kind",
  "matterId",
  "note",
  "prevHash",
  "seq",
] as const

const KIND_SET: ReadonlySet<string> = new Set(CUSTODY_KINDS)

export function atLeastClassification(current: Classification, floor: Classification): Classification {
  return classificationRank(current) >= classificationRank(floor) ? current : floor
}

/** The hashed body. Key order here is not the canonical order; `canonicalJson` sorts. */
export function custodyBody(event: Omit<CustodyEvent, "id" | "hash">): Omit<CustodyEvent, "id" | "hash"> {
  return {
    evidenceId: event.evidenceId,
    firmId: event.firmId,
    matterId: event.matterId,
    seq: event.seq,
    kind: event.kind,
    actorId: event.actorId,
    at: event.at,
    note: event.note,
    custodian: event.custodian,
    documentId: event.documentId,
    classification: event.classification,
    prevHash: event.prevHash,
  }
}

export function custodyEventHash(event: Omit<CustodyEvent, "id" | "hash">): string {
  const body = custodyBody(event)
  return createHash("sha256").update(canonicalJson(body) + body.prevHash, "utf8").digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && (value === GENESIS_PREV_HASH || /^[0-9a-f]{64}$/.test(value))
}

/** A stored custody document, or null when the shape is not the one this module writes. */
export function parseCustodyEvent(id: string, data: unknown): CustodyEvent | null {
  if (!isRecord(data)) return null
  const keys = Object.keys(data)
  if (keys.length !== EVENT_KEYS.length || EVENT_KEYS.some((key) => !Object.hasOwn(data, key))) return null
  const seq = data.seq
  const documentId = data.documentId
  const kind = data.kind
  const classification = data.classification
  if (!Number.isInteger(seq) || (seq as number) < 1) return null
  if (typeof data.evidenceId !== "string" || typeof data.firmId !== "string" || typeof data.matterId !== "string") return null
  if (typeof data.actorId !== "string" || typeof data.at !== "string" || typeof data.note !== "string") return null
  if (typeof data.custodian !== "string") return null
  if (!(documentId === null || typeof documentId === "string")) return null
  if (typeof kind !== "string" || !KIND_SET.has(kind)) return null
  if (!isClassification(classification)) return null
  if (!isHash(data.prevHash) || !isHash(data.hash) || data.hash === "") return null
  return {
    id,
    evidenceId: data.evidenceId,
    firmId: data.firmId,
    matterId: data.matterId,
    seq: seq as number,
    kind: kind as CustodyKind,
    actorId: data.actorId,
    at: data.at,
    note: data.note,
    custodian: data.custodian,
    documentId,
    classification,
    prevHash: data.prevHash,
    hash: data.hash,
  }
}

/**
 * Recomputes the chain. The first broken seq wins: a hole is reported before a
 * later event's hash, and a hash mismatch is reported at the event that was
 * rewritten.
 */
export function inspectCustodyChain(
  subject: { id: string; firmId: string; matterId: string },
  events: readonly CustodyEvent[]
): ChainVerification {
  const bySeq = new Map<number, CustodyEvent>()
  for (const event of events) {
    if (!Number.isInteger(event.seq) || event.seq < 1) return { ok: false, brokenSeq: 1, reason: "malformed" }
    if (bySeq.has(event.seq)) return { ok: false, brokenSeq: event.seq, reason: "duplicate" }
    bySeq.set(event.seq, event)
  }
  if (bySeq.size === 0) return { ok: true, eventCount: 0 }
  const max = Math.max(...bySeq.keys())
  let prevHash: string = GENESIS_PREV_HASH
  for (let seq = 1; seq <= max; seq++) {
    const event = bySeq.get(seq)
    if (!event) return { ok: false, brokenSeq: seq, reason: "gap" }
    if (event.id !== `${subject.id}_${seq}`) return { ok: false, brokenSeq: seq, reason: "identity" }
    if (event.evidenceId !== subject.id || event.firmId !== subject.firmId || event.matterId !== subject.matterId) {
      return { ok: false, brokenSeq: seq, reason: "identity" }
    }
    if (event.prevHash !== prevHash) return { ok: false, brokenSeq: seq, reason: "prev" }
    const { id: _id, hash, ...body } = event
    if (custodyEventHash(body) !== hash) return { ok: false, brokenSeq: seq, reason: "hash" }
    prevHash = hash
  }
  return { ok: true, eventCount: max }
}
