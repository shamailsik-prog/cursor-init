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
 * rewritten previous digest cannot be hidden by sorting keys. Seq 0 is the
 * genesis event: it hashes the evidence header and its digest is seq 1's
 * `prevHash`. Later seqs chain from the previous event. The document id is
 * `${evidenceId}_${seq}` and is not part of the hashed body.
 */

export const EVIDENCE_ITEMS = "evidence_items"
export const CUSTODY_EVENTS = "custody_events"
export const GENESIS_PREV_HASH = ""

export const CUSTODY_KINDS = ["receipt", "transfer", "handling", "condition", "annotation", "link"] as const
export type CustodyKind = (typeof CUSTODY_KINDS)[number]

export class EvidenceError extends Error {
  readonly code: string
  readonly verdict?: ChainVerification

  constructor(code: string, verdict?: ChainVerification) {
    super(code)
    this.name = "EvidenceError"
    this.code = code
    if (verdict) this.verdict = verdict
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
  /** sha256 of the genesis event. Set once, when the evidence row is created. */
  headerHash: string
  /** Hash of the genesis event when `eventCount` is 0, otherwise the hash of event `eventCount`. */
  lastHash: string
}

/** Seq 0. Binds the evidence header into the chain. Not a public custody kind. */
export type GenesisEvent = {
  id: string
  evidenceId: string
  firmId: string
  matterId: string
  seq: 0
  kind: "genesis"
  actorId: string
  at: string
  note: string
  custodian: string
  documentId: null
  classification: Classification
  item: string
  source: string
  receiptDate: string
  prevHash: string
  hash: string
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
  | {
      ok: false
      brokenSeq: number
      reason: "gap" | "duplicate" | "hash" | "prev" | "identity" | "malformed" | "header" | "count"
    }

export type MalformedCustody = { id: string; seq: number }

/** One consistent read of the evidence header and its custody documents. */
export type CustodyTrail = {
  item: EvidenceItem
  events: CustodyEvent[]
  genesis: GenesisEvent | null
  malformed: MalformedCustody[]
  verdict: ChainVerification
}

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

/** Same construction as a custody hash. The body includes the evidence header fields. */
export function genesisEventHash(event: Omit<GenesisEvent, "id" | "hash">): string {
  const body = {
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
    item: event.item,
    source: event.source,
    receiptDate: event.receiptDate,
    prevHash: event.prevHash,
  }
  return createHash("sha256").update(canonicalJson(body) + body.prevHash, "utf8").digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && (value === GENESIS_PREV_HASH || /^[0-9a-f]{64}$/.test(value))
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

const GENESIS_KEYS = [
  "actorId",
  "at",
  "classification",
  "custodian",
  "documentId",
  "evidenceId",
  "firmId",
  "hash",
  "item",
  "kind",
  "matterId",
  "note",
  "prevHash",
  "receiptDate",
  "seq",
  "source",
] as const

/** A stored genesis document, or null when the shape is not the one this module writes. */
export function parseGenesisEvent(id: string, data: unknown): GenesisEvent | null {
  if (!isRecord(data)) return null
  const keys = Object.keys(data)
  if (keys.length !== GENESIS_KEYS.length || GENESIS_KEYS.some((key) => !Object.hasOwn(data, key))) return null
  if (data.seq !== 0 || data.kind !== "genesis" || data.documentId !== null) return null
  if (data.prevHash !== GENESIS_PREV_HASH || !isDigest(data.hash)) return null
  if (typeof data.evidenceId !== "string" || typeof data.firmId !== "string" || typeof data.matterId !== "string") return null
  if (typeof data.actorId !== "string" || typeof data.at !== "string" || typeof data.note !== "string") return null
  if (typeof data.custodian !== "string" || !isClassification(data.classification)) return null
  if (typeof data.item !== "string" || typeof data.source !== "string" || typeof data.receiptDate !== "string") return null
  if (data.item.length < 1 || data.source.length < 1 || data.receiptDate.length < 1) return null
  return {
    id,
    evidenceId: data.evidenceId,
    firmId: data.firmId,
    matterId: data.matterId,
    seq: 0,
    kind: "genesis",
    actorId: data.actorId,
    at: data.at,
    note: data.note,
    custodian: data.custodian,
    documentId: null,
    classification: data.classification,
    item: data.item,
    source: data.source,
    receiptDate: data.receiptDate,
    prevHash: data.prevHash,
    hash: data.hash,
  }
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
  if (!isHash(data.prevHash) || !isDigest(data.hash)) return null
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
 * Recomputes the chain against the evidence header. The first broken seq wins.
 * Seq 0 is the genesis event. A missing seq at or below `header.eventCount` is
 * a gap. An event past `header.eventCount` is a count mismatch. `lastHash` must
 * be the genesis hash when there are no custody events, and the hash of event
 * `eventCount` otherwise. The header fields bound into genesis (`item`,
 * `source`, `receiptDate`, `firmId`, `matterId`, `createdBy`, `createdAt`)
 * must still match it. `documentId` must match the last link event, or be
 * null when the chain has no link.
 */
export function inspectCustodyChain(
  header: Pick<
    EvidenceItem,
    | "id"
    | "firmId"
    | "matterId"
    | "item"
    | "source"
    | "receiptDate"
    | "classification"
    | "custodian"
    | "documentId"
    | "createdBy"
    | "createdAt"
    | "eventCount"
    | "lastHash"
    | "headerHash"
  >,
  genesis: GenesisEvent | null,
  events: readonly CustodyEvent[]
): ChainVerification {
  if (!genesis) return { ok: false, brokenSeq: 0, reason: "gap" }
  if (genesis.seq !== 0 || genesis.id !== `${header.id}_0`) return { ok: false, brokenSeq: 0, reason: "identity" }
  if (genesis.evidenceId !== header.id || genesis.firmId !== header.firmId || genesis.matterId !== header.matterId) {
    return { ok: false, brokenSeq: 0, reason: "identity" }
  }
  if (genesis.prevHash !== GENESIS_PREV_HASH) return { ok: false, brokenSeq: 0, reason: "prev" }
  const { id: _genesisId, hash: genesisHash, ...genesisBody } = genesis
  if (genesisEventHash(genesisBody) !== genesisHash) return { ok: false, brokenSeq: 0, reason: "hash" }
  if (
    header.headerHash !== genesisHash ||
    header.item !== genesis.item ||
    header.source !== genesis.source ||
    header.receiptDate !== genesis.receiptDate ||
    header.firmId !== genesis.firmId ||
    header.matterId !== genesis.matterId ||
    header.createdBy !== genesis.actorId ||
    header.createdAt !== genesis.at
  ) {
    return { ok: false, brokenSeq: 0, reason: "header" }
  }
  if (!Number.isInteger(header.eventCount) || header.eventCount < 0) return { ok: false, brokenSeq: 0, reason: "malformed" }
  const bySeq = new Map<number, CustodyEvent>()
  for (const event of events) {
    if (!Number.isInteger(event.seq) || event.seq < 1) return { ok: false, brokenSeq: event.seq, reason: "malformed" }
    if (bySeq.has(event.seq)) return { ok: false, brokenSeq: event.seq, reason: "duplicate" }
    bySeq.set(event.seq, event)
  }
  const present = [...bySeq.keys()]
  const high = Math.max(header.eventCount, ...present, 0)
  let prevHash = genesisHash
  for (let seq = 1; seq <= high; seq++) {
    const event = bySeq.get(seq)
    if (!event) return { ok: false, brokenSeq: seq, reason: "gap" }
    if (seq > header.eventCount) return { ok: false, brokenSeq: seq, reason: "count" }
    if (event.id !== `${header.id}_${seq}`) return { ok: false, brokenSeq: seq, reason: "identity" }
    if (event.evidenceId !== header.id || event.firmId !== header.firmId || event.matterId !== header.matterId) {
      return { ok: false, brokenSeq: seq, reason: "identity" }
    }
    if (event.prevHash !== prevHash) return { ok: false, brokenSeq: seq, reason: "prev" }
    const { id: _id, hash, ...body } = event
    if (custodyEventHash(body) !== hash) return { ok: false, brokenSeq: seq, reason: "hash" }
    prevHash = hash
  }
  const tip = header.eventCount === 0 ? undefined : bySeq.get(header.eventCount)
  const tipHash = header.eventCount === 0 ? genesisHash : tip?.hash
  if (tipHash === undefined || header.lastHash !== tipHash) {
    return { ok: false, brokenSeq: header.eventCount, reason: "hash" }
  }
  const tipClassification = header.eventCount === 0 ? genesis.classification : tip?.classification
  const tipCustodian = header.eventCount === 0 ? genesis.custodian : tip?.custodian
  if (header.classification !== tipClassification || header.custodian !== tipCustodian) {
    return { ok: false, brokenSeq: 0, reason: "header" }
  }
  let linked: CustodyEvent | undefined
  for (const event of bySeq.values()) {
    if (event.kind === "link" && (linked === undefined || event.seq > linked.seq)) linked = event
  }
  if (header.documentId !== (linked?.documentId ?? null)) {
    return { ok: false, brokenSeq: linked?.seq ?? 0, reason: "header" }
  }
  return { ok: true, eventCount: header.eventCount }
}
