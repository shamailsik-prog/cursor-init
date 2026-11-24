import { randomUUID } from "node:crypto"
import type { Classification } from "@/platform/p1/types"
import { classificationRank, isClassification } from "@/platform/p1/types"
import { readDocumentRecord } from "@/platform/d1/documentRecord"
import { canReadDocument } from "@/platform/p5/documentAccess"
import { MATTER_TOMBSTONES, isTombstoneFor } from "@/platform/retention/tombstone"
import { newStore, type Matter, type User } from "@/platform/spine/store"
import { type DocumentReference, type DocumentSnapshot, type Query, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { isSafeDocId } from "../../p5/common"
import { isKnownClassification } from "../../p5/classification"
import { requireD1Evidence } from "./flag"
import {
  CUSTODY_EVENTS,
  EVIDENCE_ITEMS,
  GENESIS_PREV_HASH,
  EvidenceError,
  atLeastClassification,
  custodyEventHash,
  genesisEventHash,
  inspectCustodyChain,
  parseCustodyEvent,
  parseGenesisEvent,
  type AddCustodyInput,
  type ChainVerification,
  type CustodyEvent,
  type CustodyKind,
  type CustodyTrail,
  type EvidenceActor,
  type EvidenceClock,
  type EvidenceItem,
  type GenesisEvent,
  type LinkEvidenceInput,
  type LogEvidenceInput,
  type MalformedCustody,
} from "./types"

/**
 * Evidence register and the append-only custody chain.
 *
 * Custody rows are written with `tx.create` and never updated or deleted.
 * The evidence row holds the current custodian, the optional document link,
 * `eventCount`, and `lastHash`. Those fields move only inside the same
 * transaction that appends the event. `headerHash` is the genesis digest and
 * does not change. The next seq is the verified length plus one. A broken
 * chain, including a missing tail, is not extended and a seq is not reused.
 * Two transactions contend on the evidence document and on the event query, so
 * concurrent appends take distinct dense seqs.
 *
 * `register.ts` re-exports the register operations. They live here so the matter
 * gate and the chain writer are one copy and nothing unguarded is exported.
 */

const READERS = ["partner", "associate", "clerk", "intern"] as const
const AUTHORS = ["partner", "associate", "clerk"] as const
const PUBLIC_KINDS = ["receipt", "transfer", "handling", "condition", "annotation"] as const
const TEXT_MAX = 500
const NOTE_MAX = 4000
const EVIDENCE_KEYS = [
  "classification",
  "createdAt",
  "createdBy",
  "custodian",
  "documentId",
  "eventCount",
  "firmId",
  "headerHash",
  "item",
  "lastHash",
  "matterId",
  "receiptDate",
  "source",
] as const

type Mode = "read" | "write"
type Gate = { matterId: string; classification: Classification }
type Draft = {
  kind: CustodyKind
  note: string
  at: string
  custodian?: string
  documentId?: string | null
  classification?: Classification
}

function assertRole(caller: EvidenceActor, mode: Mode): void {
  const allowed: readonly string[] = mode === "write" ? AUTHORS : READERS
  if (!allowed.includes(caller.role)) throw new EvidenceError(mode === "write" ? "not_author" : "not_staff")
}

function assertActor(caller: EvidenceActor): void {
  if (!isSafeDocId(caller.uid) || !isSafeDocId(caller.firmId)) throw new EvidenceError("invalid_input")
}

/** A missing or mistyped caller is invalid_input, before a role refusal and before any read. */
function assertCaller(caller: EvidenceActor, mode: Mode): void {
  if (!isPlain(caller) || typeof caller.role !== "string" || typeof caller.uid !== "string" || typeof caller.firmId !== "string") {
    throw new EvidenceError("invalid_input")
  }
  if (!isClassification(caller.clearanceLevel)) throw new EvidenceError("invalid_input")
  assertRole(caller, mode)
  assertActor(caller)
}

function parseId(value: unknown): string {
  if (!isSafeDocId(value)) throw new EvidenceError("invalid_input")
  return value
}

function parseText(value: unknown, max: number): string {
  if (typeof value !== "string") throw new EvidenceError("invalid_input")
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > max || /[\u0000-\u001f]/.test(trimmed)) throw new EvidenceError("invalid_input")
  return trimmed
}

function parseReceiptDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new EvidenceError("invalid_input")
  const [year, month, day] = value.split("-").map(Number)
  const utc = new Date(Date.UTC(year!, month! - 1, day!))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month! - 1 || utc.getUTCDate() !== day) {
    throw new EvidenceError("invalid_input")
  }
  return value
}

function stamp(clock?: EvidenceClock): string {
  if (clock !== undefined && !isPlain(clock)) throw new EvidenceError("invalid_input")
  if (clock?.now !== undefined && typeof clock.now !== "function") throw new EvidenceError("invalid_input")
  let now: unknown
  try {
    now = clock?.now ? clock.now() : Date.now()
  } catch (err) {
    if (err instanceof EvidenceError) throw err
    throw new EvidenceError("invalid_input")
  }
  if (typeof now !== "number" || !Number.isFinite(now)) throw new EvidenceError("invalid_input")
  try {
    return new Date(now).toISOString()
  } catch (err) {
    if (err instanceof EvidenceError) throw err
    throw new EvidenceError("invalid_input")
  }
}

function isContention(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false
  const code = (err as { code: unknown }).code
  return code === "aborted" || code === "already-exists" || code === 6 || code === 10
}

/** gRPC ALREADY_EXISTS (6), including the string form a lost create commit surfaces as. */
function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const record = err as { code?: unknown; errorInfo?: { code?: unknown } }
  return [record.code, record.errorInfo?.code].some((code) => code === 6 || code === "already-exists" || code === "ALREADY_EXISTS")
}

function sameStored(expected: Record<string, unknown>, actual: unknown): boolean {
  if (!isPlain(actual)) return false
  const keys = Object.keys(expected)
  if (Object.keys(actual).length !== keys.length) return false
  return keys.every((key) => Object.is(actual[key], expected[key]))
}

async function commit<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof EvidenceError || !isContention(err) || attempt === 7) throw err
      last = err
    }
  }
  throw last
}

function evidenceRef(id: string): DocumentReference {
  return adminDb().collection(EVIDENCE_ITEMS).doc(id)
}

function custodyRef(id: string): DocumentReference {
  return adminDb().collection(CUSTODY_EVENTS).doc(id)
}

function chainQuery(evidenceId: string): Query {
  return adminDb().collection(CUSTODY_EVENTS).where("evidenceId", "==", evidenceId)
}

function matterRefs(matterId: string, uid: string): [DocumentReference, DocumentReference, DocumentReference] {
  const db = adminDb()
  return [
    db.collection("matters").doc(matterId),
    db.collection("matter_members").doc(`${matterId}_${uid}`),
    db.collection(MATTER_TOMBSTONES).doc(matterId),
  ]
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseEvidence(id: string, data: unknown): EvidenceItem | null {
  if (!isPlain(data)) return null
  const keys = Object.keys(data)
  if (keys.length !== EVIDENCE_KEYS.length || EVIDENCE_KEYS.some((key) => !Object.hasOwn(data, key))) return null
  const documentId = data.documentId
  const eventCount = data.eventCount
  if (!isSafeDocId(data.firmId) || !isSafeDocId(data.matterId)) return null
  if (typeof data.item !== "string" || typeof data.source !== "string" || typeof data.custodian !== "string") return null
  if (typeof data.receiptDate !== "string" || typeof data.createdBy !== "string" || typeof data.createdAt !== "string") return null
  if (!(documentId === null || (typeof documentId === "string" && isSafeDocId(documentId)))) return null
  if (!isKnownClassification(data.classification)) return null
  if (!Number.isInteger(eventCount) || (eventCount as number) < 0) return null
  if (typeof data.headerHash !== "string" || !/^[0-9a-f]{64}$/.test(data.headerHash)) return null
  if (typeof data.lastHash !== "string" || !/^[0-9a-f]{64}$/.test(data.lastHash)) return null
  return {
    id,
    firmId: data.firmId,
    matterId: data.matterId,
    item: data.item,
    source: data.source,
    receiptDate: data.receiptDate,
    custodian: data.custodian,
    classification: data.classification,
    documentId,
    createdBy: data.createdBy,
    createdAt: data.createdAt,
    eventCount: eventCount as number,
    headerHash: data.headerHash,
    lastHash: data.lastHash,
  }
}

function decideGate(
  caller: EvidenceActor,
  matterId: string,
  mode: Mode,
  matterSnap: DocumentSnapshot,
  memberSnap: DocumentSnapshot,
  tombSnap: DocumentSnapshot
): Gate {
  assertRole(caller, mode)
  if (isTombstoneFor(tombSnap.data(), caller.firmId, matterId)) throw new EvidenceError("matter_deleted")
  const data = matterSnap.data()
  if (!matterSnap.exists || !isPlain(data) || data.firmId !== caller.firmId) throw new EvidenceError("not_found")
  if (!memberSnap.exists) throw new EvidenceError("not_member")
  if (!isKnownClassification(data.classification)) throw new EvidenceError("not_found")
  if (classificationRank(caller.clearanceLevel) < classificationRank(data.classification)) throw new EvidenceError("clearance")
  return { matterId, classification: data.classification }
}

async function gateOf(caller: EvidenceActor, matterId: string, mode: Mode, tx?: Transaction): Promise<Gate> {
  const refs = matterRefs(matterId, caller.uid)
  const [matterSnap, memberSnap, tombSnap] = tx ? await tx.getAll(...refs) : await adminDb().getAll(...refs)
  return decideGate(caller, matterId, mode, matterSnap!, memberSnap!, tombSnap!)
}

async function readItem(caller: EvidenceActor, evidenceId: string, mode: Mode, tx?: Transaction): Promise<{ item: EvidenceItem; gate: Gate }> {
  const snap = tx ? await tx.get(evidenceRef(evidenceId)) : await evidenceRef(evidenceId).get()
  const item = snap.exists ? parseEvidence(snap.id, snap.data()) : null
  if (!item || item.firmId !== caller.firmId) throw new EvidenceError("not_found")
  const gate = await gateOf(caller, item.matterId, mode, tx)
  if (classificationRank(caller.clearanceLevel) < classificationRank(item.classification)) throw new EvidenceError("clearance")
  return { item, gate }
}

function seqHint(id: string, data: unknown): number {
  if (isPlain(data) && typeof data.seq === "number" && Number.isInteger(data.seq) && data.seq >= 0) return data.seq
  const match = /_(\d+)$/.exec(id)
  return match ? Number(match[1]) : 0
}

function earliestBreak(verdict: ChainVerification, malformed: readonly MalformedCustody[]): ChainVerification {
  const first = [...malformed].sort((a, b) => a.seq - b.seq)[0]
  if (!first) return verdict
  if (verdict.ok || first.seq < verdict.brokenSeq || (first.seq === verdict.brokenSeq && verdict.reason !== "malformed")) {
    return { ok: false, brokenSeq: first.seq, reason: "malformed" }
  }
  return verdict
}

async function readChain(
  item: EvidenceItem,
  tx?: Transaction
): Promise<{ events: CustodyEvent[]; genesis: GenesisEvent | null; malformed: MalformedCustody[]; verdict: ChainVerification }> {
  const snap = tx ? await tx.get(chainQuery(item.id)) : await chainQuery(item.id).get()
  const events: CustodyEvent[] = []
  const malformed: MalformedCustody[] = []
  let genesis: GenesisEvent | null = null
  let duplicateGenesis = false
  for (const doc of snap.docs) {
    const data = doc.data()
    if (isPlain(data) && data.kind === "genesis") {
      const parsed = parseGenesisEvent(doc.id, data)
      if (!parsed) {
        malformed.push({ id: doc.id, seq: 0 })
        continue
      }
      if (genesis) {
        duplicateGenesis = true
        continue
      }
      genesis = parsed
      continue
    }
    const event = parseCustodyEvent(doc.id, data)
    if (event) {
      events.push(event)
      continue
    }
    malformed.push({ id: doc.id, seq: seqHint(doc.id, data) })
  }
  const verdict = earliestBreak(
    duplicateGenesis ? { ok: false, brokenSeq: 0, reason: "duplicate" } : inspectCustodyChain(item, genesis, events),
    malformed
  )
  return { events, genesis, malformed, verdict }
}

async function appendEvent(tx: Transaction, caller: EvidenceActor, evidenceId: string, draft: Draft): Promise<CustodyEvent> {
  const { item } = await readItem(caller, evidenceId, "write", tx)
  const { verdict, events } = await readChain(item, tx)
  if (!verdict.ok || verdict.eventCount !== item.eventCount) throw new EvidenceError("chain_broken")
  const seq = item.eventCount + 1
  if (events.some((event) => event.seq === seq)) throw new EvidenceError("chain_broken")
  const prevHash = item.lastHash
  const classification = draft.classification ?? item.classification
  if (classificationRank(caller.clearanceLevel) < classificationRank(classification)) throw new EvidenceError("clearance")
  const custodian = draft.custodian ?? item.custodian
  const body = {
    evidenceId: item.id,
    firmId: item.firmId,
    matterId: item.matterId,
    seq,
    kind: draft.kind,
    actorId: caller.uid,
    at: draft.at,
    note: draft.note,
    custodian,
    documentId: draft.documentId === undefined ? null : draft.documentId,
    classification,
    prevHash,
  }
  const hash = custodyEventHash(body)
  const id = `${item.id}_${seq}`
  tx.create(custodyRef(id), { ...body, hash })
  const patch: Record<string, unknown> = { eventCount: seq, custodian, lastHash: hash }
  if (draft.classification !== undefined) patch.classification = classification
  if (draft.documentId !== undefined) patch.documentId = draft.documentId
  tx.update(evidenceRef(item.id), patch)
  return { id, ...body, hash }
}

function callerMayReadDocument(caller: EvidenceActor, gate: Gate, document: { firmId: string; matterId: string | null; classification: Classification }): boolean {
  const store = newStore()
  const matter: Matter = {
    id: gate.matterId,
    firmId: caller.firmId,
    clientId: "",
    title: "",
    courtId: null,
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "live",
    classification: gate.classification,
  }
  store.matters.set(matter.id, matter)
  store.members.set(store.memberKey(matter.id, caller.uid), {
    matterId: matter.id,
    userId: caller.uid,
    firmId: caller.firmId,
  })
  const user: User = { id: caller.uid, firmId: caller.firmId, role: caller.role, clearanceLevel: caller.clearanceLevel }
  return canReadDocument(store, user, document)
}

function parseLog(input: LogEvidenceInput): LogEvidenceInput {
  if (!isClassification(input?.classification)) throw new EvidenceError("invalid_input")
  return {
    matterId: parseId(input.matterId),
    item: parseText(input.item, TEXT_MAX),
    source: parseText(input.source, TEXT_MAX),
    receiptDate: parseReceiptDate(input.receiptDate),
    custodian: parseText(input.custodian, TEXT_MAX),
    classification: input.classification,
  }
}

function parseAdd(input: AddCustodyInput): { evidenceId: string; kind: Draft["kind"]; note: string; custodian?: string } {
  const kind = input?.kind
  if (typeof kind !== "string" || !(PUBLIC_KINDS as readonly string[]).includes(kind)) throw new EvidenceError("invalid_input")
  const note = parseText(input.note, NOTE_MAX)
  const custodian = input.custodian === undefined ? undefined : parseText(input.custodian, TEXT_MAX)
  if (kind === "transfer" && custodian === undefined) throw new EvidenceError("invalid_input")
  return { evidenceId: parseId(input.evidenceId), kind: kind as Draft["kind"], note, custodian }
}

async function readLoggedPair(id: string, tx?: Transaction): Promise<{ evidence: unknown; genesis: unknown; present: boolean }> {
  const evidenceSnap = tx ? await tx.get(evidenceRef(id)) : await evidenceRef(id).get()
  const genesisSnap = tx ? await tx.get(custodyRef(`${id}_0`)) : await custodyRef(`${id}_0`).get()
  return { evidence: evidenceSnap.data(), genesis: genesisSnap.data(), present: evidenceSnap.exists || genesisSnap.exists }
}

/** The stored pair is this attempt's body, or `conflict`. A miss does not create a second row. */
function replayLogged(
  id: string,
  evidence: unknown,
  genesis: unknown,
  stored: Record<string, unknown>,
  genesisStored: Record<string, unknown>
): EvidenceItem {
  const item = sameStored(stored, evidence) && sameStored(genesisStored, genesis) ? parseEvidence(id, evidence) : null
  if (!item) throw new EvidenceError("conflict")
  return item
}

export async function logEvidence(caller: EvidenceActor, input: LogEvidenceInput, clock?: EvidenceClock): Promise<EvidenceItem> {
  requireD1Evidence()
  assertCaller(caller, "write")
  const parsed = parseLog(input)
  const createdAt = stamp(clock)
  const id = `ev_${randomUUID().replace(/-/g, "")}`
  let stored: Record<string, unknown> | null = null
  let genesisStored: Record<string, unknown> | null = null
  try {
    return await commit(() =>
      adminDb().runTransaction(async (tx) => {
        const gate = await gateOf(caller, parsed.matterId, "write", tx)
        const classification = atLeastClassification(parsed.classification, gate.classification)
        if (classificationRank(caller.clearanceLevel) < classificationRank(classification)) throw new EvidenceError("clearance")
        const genesis = {
          evidenceId: id,
          firmId: caller.firmId,
          matterId: parsed.matterId,
          seq: 0 as const,
          kind: "genesis" as const,
          actorId: caller.uid,
          at: createdAt,
          note: "",
          custodian: parsed.custodian,
          documentId: null,
          classification,
          item: parsed.item,
          source: parsed.source,
          receiptDate: parsed.receiptDate,
          prevHash: GENESIS_PREV_HASH,
        }
        const headerHash = genesisEventHash(genesis)
        const item: EvidenceItem = {
          id,
          firmId: caller.firmId,
          matterId: parsed.matterId,
          item: parsed.item,
          source: parsed.source,
          receiptDate: parsed.receiptDate,
          custodian: parsed.custodian,
          classification,
          documentId: null,
          createdBy: caller.uid,
          createdAt,
          eventCount: 0,
          headerHash,
          lastHash: headerHash,
        }
        const { id: _id, ...body } = item
        const genesisBody = { ...genesis, hash: headerHash }
        stored = body
        genesisStored = genesisBody
        const found = await readLoggedPair(id, tx)
        if (found.present) return replayLogged(id, found.evidence, found.genesis, body, genesisBody)
        tx.create(evidenceRef(id), body)
        tx.create(custodyRef(`${id}_0`), genesisBody)
        return item
      }, { maxAttempts: 25 })
    )
  } catch (err) {
    const body = stored
    const genesisBody = genesisStored
    if (!isAlreadyExists(err) || body === null || genesisBody === null) throw err
    const found = await readLoggedPair(id)
    if (!found.present) throw new EvidenceError("conflict")
    return replayLogged(id, found.evidence, found.genesis, body, genesisBody)
  }
}

export async function getEvidenceItem(caller: EvidenceActor, evidenceId: string): Promise<EvidenceItem> {
  requireD1Evidence()
  assertCaller(caller, "read")
  const { item } = await readItem(caller, parseId(evidenceId), "read")
  return item
}

export async function getEvidenceRegister(caller: EvidenceActor, matterId: string): Promise<EvidenceItem[]> {
  requireD1Evidence()
  assertCaller(caller, "read")
  const id = parseId(matterId)
  await gateOf(caller, id, "read")
  const snap = await adminDb().collection(EVIDENCE_ITEMS).where("matterId", "==", id).get()
  const items: EvidenceItem[] = []
  for (const doc of snap.docs) {
    const item = parseEvidence(doc.id, doc.data())
    if (!item || item.firmId !== caller.firmId || item.matterId !== id) continue
    if (classificationRank(caller.clearanceLevel) < classificationRank(item.classification)) continue
    items.push(item)
  }
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return items
}

export async function linkEvidenceToDocument(caller: EvidenceActor, input: LinkEvidenceInput, clock?: EvidenceClock): Promise<EvidenceItem> {
  requireD1Evidence()
  assertCaller(caller, "write")
  const evidenceId = parseId(input?.evidenceId)
  const documentId = parseId(input?.documentId)
  const at = stamp(clock)
  return commit(() =>
    adminDb().runTransaction(async (tx) => {
      const { item, gate } = await readItem(caller, evidenceId, "write", tx)
      if (item.documentId === documentId) return item
      if (item.documentId !== null) throw new EvidenceError("already_linked")
      const docSnap = await tx.get(adminDb().collection("documents").doc(documentId))
      const record = docSnap.exists ? readDocumentRecord(docSnap.id, docSnap.data()) : null
      if (!record) throw new EvidenceError("not_found")
      if (record.firmId !== item.firmId) throw new EvidenceError("cross_firm")
      if (record.matterId !== item.matterId) throw new EvidenceError("cross_matter")
      if (!callerMayReadDocument(caller, gate, record)) throw new EvidenceError("not_permitted")
      if (record.contentHash.length === 0 || record.contentHash.length > 128 || /[\u0000-\u001f]/.test(record.contentHash)) {
        throw new EvidenceError("not_found")
      }
      const classification = atLeastClassification(atLeastClassification(item.classification, record.classification), gate.classification)
      if (classificationRank(caller.clearanceLevel) < classificationRank(classification)) throw new EvidenceError("clearance")
      const event = await appendEvent(tx, caller, evidenceId, {
        kind: "link",
        note: record.contentHash,
        at,
        documentId,
        classification,
      })
      return { ...item, documentId, classification, custodian: event.custodian, eventCount: event.seq, lastHash: event.hash }
    }, { maxAttempts: 25 })
  )
}

export async function addCustodyEvent(caller: EvidenceActor, input: AddCustodyInput, clock?: EvidenceClock): Promise<CustodyEvent> {
  requireD1Evidence()
  assertCaller(caller, "write")
  const parsed = parseAdd(input)
  const at = stamp(clock)
  return commit(() =>
    adminDb().runTransaction(
      (tx) => appendEvent(tx, caller, parsed.evidenceId, { kind: parsed.kind, note: parsed.note, custodian: parsed.custodian, at }),
      { maxAttempts: 25 }
    )
  )
}

/** Header and trail from one read-only transaction, so the two cannot tear. */
async function loadCustody(caller: EvidenceActor, evidenceId: string, mode: Mode): Promise<CustodyTrail> {
  const id = parseId(evidenceId)
  return adminDb().runTransaction(async (tx) => {
    const { item } = await readItem(caller, id, mode, tx)
    const chain = await readChain(item, tx)
    const events = [...chain.events].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    return { item, events, genesis: chain.genesis, malformed: chain.malformed, verdict: chain.verdict }
  })
}

export async function getCustodyTrail(caller: EvidenceActor, evidenceId: string): Promise<CustodyTrail> {
  requireD1Evidence()
  assertCaller(caller, "read")
  return loadCustody(caller, evidenceId, "read")
}

export async function verifyCustodyChain(caller: EvidenceActor, evidenceId: string): Promise<ChainVerification> {
  requireD1Evidence()
  assertCaller(caller, "read")
  return (await loadCustody(caller, evidenceId, "read")).verdict
}
