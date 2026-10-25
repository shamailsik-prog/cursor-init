import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import { MATTER_TOMBSTONES, isTombstoneFor } from "@/platform/retention/tombstone"
import { adminDb } from "../admin"
import { inventory, storeKey, type InventoryStore, type TraceSource } from "./config"
import { DELETION_ACKS_COLLECTION, DELETION_EXTERNAL_REQUESTS_COLLECTION, LEGAL_HOLDS_COLLECTION, ackDocId, requestsRef, type Treatment } from "./model"

/**
 * Audit F42 (FA-F42-R1-007, spec R27; was RES-2): the trace of a P1 call in flight at the approval is not lost.
 *
 * The prepare job records every exported trace id of the matter before any purge job exists. A call that settles later
 * writes its usage row and decision record after that read, so:
 * - (a) when its rows land before their store is acknowledged, the purge finds them, and the anonymise (or purge) chunk
 *   records every exported id not yet in the processor request in a new part, in the chunk's own transaction, before the
 *   rows lose the matter (`readLateIds` / `stageLateIds`);
 * - (b) when they land after (the call, or the lease reconciler, settles once the store or the whole request is done),
 *   the P1 write seam reads the tombstone (`readLateWrite`), writes the rows without the matter and records the trace the
 *   same way (`stageLateWrite`).
 *
 * A processor request is a summary `{requestId}_{processor}` (counts, `status`) and parts `{requestId}_{processor}_p{n}`
 * of ids. Parts are written once and never rewritten, so a reader may cache them; the summary's `parts` says how many
 * there are. `idsSha256` hashes the ids prepare recorded; `lateIds` counts those recorded since.
 */

const externalCol = () => adminDb().collection(DELETION_EXTERNAL_REQUESTS_COLLECTION)
const summaryRef = (requestId: string, processor: string): DocumentReference => externalCol().doc(`${requestId}_${processor}`)
const partRef = (requestId: string, processor: string, n: number): DocumentReference => externalCol().doc(`${requestId}_${processor}_p${n}`)

/** The value at a dotted path of a plain object or a snapshot (`trace.id`, `export.state`). */
function at(row: DocumentData | { get(path: string): unknown }, path: string): unknown {
  if (typeof (row as { get?: unknown }).get === "function" && !(row instanceof Map)) return (row as { get(path: string): unknown }).get(path)
  let v: unknown = row
  for (const part of path.split(".")) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[part] : undefined
  return v
}

/** A processor the plan requests (`external`), with the sources of `sourceId` it reads ids from. */
export type Capture = { processor: string; key: string; specs: TraceSource[] }

/** The processors whose request takes ids from rows of `sourceId` (an inventory store id), under `plan`. */
export function capturesFor(sourceId: string, plan: Record<string, Treatment>, inv = inventory()): Capture[] {
  const out: Capture[] = []
  for (const s of inv.stores) {
    if (s.key.kind !== "traceExport") continue
    const key = storeKey(s.id)
    if (plan[key] !== "external") continue
    const specs = s.key.sources.filter((src) => src.source === sourceId)
    if (specs.length > 0) out.push({ processor: s.name, key, specs })
  }
  return out
}

/** The exported (or still exportable) ids `rows` hold for a processor, sorted and distinct. */
export function exportedIds(rows: ReadonlyArray<DocumentData | { get(path: string): unknown }>, specs: readonly TraceSource[]): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    for (const src of specs) {
      const id = at(row, src.idField)
      if (typeof id === "string" && id !== "" && src.exportedValues.includes(at(row, src.statusField) as string)) ids.add(id)
    }
  }
  return [...ids].sort()
}

/** Parts already read, by document id (immutable once written, so a cache never goes stale). Bounded. */
const partCache = new Map<string, string[]>()
const PART_CACHE_MAX = 64

/** What a transaction read of one processor request: whether its summary exists, its part count and every id in it. */
export type LateRead = { processor: string; exists: boolean; parts: number; recorded: ReadonlySet<string> }

/** Reads the processor request in `tx` (the summary, and every part not cached). A read: call before the writes. */
export async function readLateIds(tx: Transaction, requestId: string, processor: string): Promise<LateRead> {
  const summary = await tx.get(summaryRef(requestId, processor))
  const parts = summary.exists && typeof summary.get("parts") === "number" ? (summary.get("parts") as number) : 0
  const missing = Array.from({ length: parts }, (_, n) => n).filter((n) => !partCache.has(partRef(requestId, processor, n).id))
  if (missing.length > 0) {
    const snaps = await tx.getAll(...missing.map((n) => partRef(requestId, processor, n)))
    snaps.forEach((s) => {
      if (partCache.size >= PART_CACHE_MAX) partCache.delete(partCache.keys().next().value as string)
      partCache.set(s.id, Array.isArray(s.get("traceIds")) ? (s.get("traceIds") as string[]) : [])
    })
  }
  const recorded = new Set<string>()
  for (let n = 0; n < parts; n += 1) for (const id of partCache.get(partRef(requestId, processor, n).id) ?? []) recorded.add(id)
  return { processor, exists: summary.exists, parts, recorded }
}

/** Ids per new late part: a chunk's ids (at most 200 rows, a few ids each) fit far under one part's bounds. */
const LATE_IDS_PER_PART = 5_000

/**
 * Stages, in `tx`, the ids of `ids` not yet recorded in the processor request (`read`): a new part per 5,000, and the
 * summary's `parts`, `count` and `lateIds` (created `pending_operator` when prepare found none; a `held` request stays
 * held). Returns how many ids it added.
 */
export function stageLateIds(
  tx: Transaction,
  read: LateRead,
  ids: readonly string[],
  base: { firmId: string; requestId: string; matterId: string },
  nowMs: number
): number {
  const fresh = ids.filter((id) => !read.recorded.has(id))
  if (fresh.length === 0) return 0
  const when = Timestamp.fromMillis(nowMs)
  const chunks: string[][] = []
  for (let i = 0; i < fresh.length; i += LATE_IDS_PER_PART) chunks.push(fresh.slice(i, i + LATE_IDS_PER_PART))
  chunks.forEach((traceIds, i) => {
    const n = read.parts + i
    tx.set(partRef(base.requestId, read.processor, n), { ...base, processor: read.processor, part: n, late: true, traceIds, at: when })
  })
  const parts = read.parts + chunks.length
  if (read.exists) {
    tx.update(summaryRef(base.requestId, read.processor), { parts, count: FieldValue.increment(fresh.length), lateIds: FieldValue.increment(fresh.length), updatedAt: when })
  } else {
    tx.set(summaryRef(base.requestId, read.processor), {
      ...base,
      processor: read.processor,
      count: fresh.length,
      parts,
      idsSha256: null,
      lateIds: fresh.length,
      status: "pending_operator",
      at: when,
    })
  }
  return fresh.length
}

/** A row the P1 write seam is about to write: its inventory store and its data (the usage row, the decision record). */
export type SeamRow = { storeId: string; data: DocumentData }

/** What the seam found: the rows to write without the matter, and the processor requests to record their traces in. */
export type LateWrite = {
  requestId: string
  matterId: string
  firmId: string
  /** Store ids whose row is written anonymised, with the anonymise fields of that store. */
  anonymise: Map<string, Record<string, unknown>>
  reads: Array<{ read: LateRead; specs: TraceSource[] }>
}

const LIVE_REQUEST: ReadonlySet<unknown> = new Set(["in_progress", "completed"])

/**
 * The P1 write seam's reads (spec R27b), in `tx`, before its writes: the matter's tombstone; when it is the firm's, the
 * hold (an active hold leaves the rows as they are: preserve), the deletion request, the acknowledgements of the rows'
 * stores and, for the rows whose store is already acknowledged as purged or anonymised, the processor requests their
 * traces go to. Null when nothing is to change (no tombstone, a hold, or no row's store acknowledged yet: the purge
 * will find those rows).
 */
export async function readLateWrite(tx: Transaction, firmId: string, matterId: string, rows: readonly SeamRow[]): Promise<LateWrite | null> {
  if (typeof matterId !== "string" || matterId === "" || matterId.includes("/")) return null
  const db = adminDb()
  const [tombSnap, holdSnap] = await tx.getAll(db.collection(MATTER_TOMBSTONES).doc(matterId), db.collection(LEGAL_HOLDS_COLLECTION).doc(matterId))
  const tomb = tombSnap.data()
  if (!isTombstoneFor(tomb, firmId, matterId) || typeof tomb?.requestId !== "string" || tomb.requestId === "") return null
  const hold = holdSnap.data()
  if (hold && hold.firmId === firmId && hold.active === true) return null
  const requestId = tomb.requestId as string
  const req = (await tx.get(requestsRef().doc(requestId))).data()
  if (!req || req.firmId !== firmId || !LIVE_REQUEST.has(req.status) || typeof req.plan !== "object" || req.plan === null) return null
  const plan = req.plan as Record<string, Treatment>
  const inv = inventory()
  const candidates = rows
    .map((row) => ({ row, store: inv.stores.find((s) => s.id === row.storeId) }))
    .filter((c): c is { row: SeamRow; store: InventoryStore } => c.store !== undefined && (plan[storeKey(c.store.id)] === "anonymise" || plan[storeKey(c.store.id)] === "purge"))
  if (candidates.length === 0) return null
  const acks = await tx.getAll(...candidates.map((c) => db.collection(DELETION_ACKS_COLLECTION).doc(ackDocId(requestId, storeKey(c.store.id)))))
  const anonymise = new Map<string, Record<string, unknown>>()
  candidates.forEach((c, i) => {
    if (acks[i].get("acknowledged") === true) anonymise.set(c.store.id, { ...(c.store.anonymise ?? {}), ...(c.store.key.kind === "field" ? { [c.store.key.field]: null } : {}) })
  })
  if (anonymise.size === 0) return null
  const reads: LateWrite["reads"] = []
  const processors = new Map<string, TraceSource[]>()
  for (const storeId of anonymise.keys()) {
    for (const cap of capturesFor(storeId, plan, inv)) processors.set(cap.processor, [...(processors.get(cap.processor) ?? []), ...cap.specs])
  }
  for (const [processor, specs] of processors) reads.push({ read: await readLateIds(tx, requestId, processor), specs })
  return { requestId, matterId, firmId, anonymise, reads }
}

/**
 * The seam's writes for `late`: each row of an acknowledged store as it will be written (without the matter,
 * `anonymisedBy` the request), and the traces of those rows recorded in their processor requests. Returns the rows' data
 * in the order given.
 */
export function stageLateWrite(tx: Transaction, late: LateWrite, rows: readonly SeamRow[], nowMs: number): DocumentData[] {
  const out = rows.map((row) => {
    const fields = late.anonymise.get(row.storeId)
    return fields === undefined ? row.data : { ...row.data, ...fields, anonymisedBy: late.requestId }
  })
  const changed = rows.filter((row) => late.anonymise.has(row.storeId)).map((row) => row.data)
  for (const { read, specs } of late.reads) {
    stageLateIds(tx, read, exportedIds(changed, specs), { firmId: late.firmId, requestId: late.requestId, matterId: late.matterId }, nowMs)
  }
  return out
}
