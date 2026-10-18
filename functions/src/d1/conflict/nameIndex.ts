import { FieldPath, FieldValue, type Query, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { bumpRegistryVersion, readRegistryState, readRegistryStateTx, type NameIndexPatch, type RegistryState } from "../registryVersion"

/**
 * The firm's conflict name index (audit F37; spec 2026-10-18-f37 rulings 3 to 7): every distinct client
 * `canonicalName` and opposing `matter_parties.name` of the firm, packed into chunk documents
 * `conflict_name_index/{firmId}_{n}` (`names`, appended with arrayUnion), with its state on the registry
 * counter doc (`counters/{firmId}_registry.nameIndex = { schema, version, chunk, bytes }`).
 *
 * The name rule (token-set ratio ≥ 0.80) cannot be served by a selective deterministic key without losing
 * recall, so the screen evaluates it over these names and then fetches the rows carrying the matching names
 * by exact value (`candidates.ts`). Invariant (I): while `nameIndex.schema === NAME_INDEX_SCHEMA` and
 * `nameIndex.version === version`, the chunks hold the name of every client and opposing party written
 * through functions/src. It holds because:
 *
 * - `bumpRegistryVersion` (every registry write) moves `nameIndex.version` with `version`;
 * - the writers that add a name (registerClient, openMatter) stage it here with `stageRegistryWrite`;
 * - a firm with no counter doc and no client or opposing party row has an empty, complete index: its first
 *   registration creates the index current (`bornFreshPatch`), and a screen before that sees no candidate;
 * - anything else (an old instance during a deploy, an out-of-band counter bump) breaks the mirror, and the
 *   screen refuses (`nameIndexProblem`) until `reconcileNameIndex` (the `d1.conflict.reindex` job) repairs it.
 *
 * The chunks are server-only (firestore.rules) and carry the highest label: they aggregate names of every
 * classification and are never returned to a caller.
 */

/** Bumped when the index's content rules change: every index of another schema reads unavailable until reconciled. */
export const NAME_INDEX_SCHEMA = 1
export const NAME_INDEX_COLLECTION = "conflict_name_index"
/** Counted bytes after which a chunk is closed: half of Firestore's 1 MiB document limit (the count is an upper bound). */
export const NAME_INDEX_CHUNK_BYTES = 512 * 1024
/** More chunks than this (≈ 200 MiB of names) can only be a corrupt pointer: refused, never read. */
export const NAME_INDEX_MAX_CHUNKS = 400
/** Names appended per reconciliation transaction (bytes): at most one chunk boundary per transaction. */
const RECONCILE_APPEND_BYTES = 256 * 1024
/** Reconciliation rounds before it gives up retryably (a round restarts when a non-maintaining write raced its scan). */
export const RECONCILE_ROUNDS = 3
const SCAN_PAGE = 500

export const nameIndexChunkRef = (firmId: string, chunk: number) => adminDb().collection(NAME_INDEX_COLLECTION).doc(`${firmId}_${chunk}`)

/** Why a screen cannot use the index: never built, built under another schema, behind the registry, or unreadable. */
export type NameIndexProblem = "missing" | "schema" | "stale" | "corrupt"

/** The index cannot be trusted for a screen (spec ruling 5): screening refuses rather than pass silently. */
export class NameIndexUnavailable extends Error {
  readonly reason: NameIndexProblem
  constructor(reason: NameIndexProblem) {
    super(`conflict name index ${reason}`)
    this.name = "NameIndexUnavailable"
    this.reason = reason
  }
}

/** Why the index cannot serve a screen at `state`, or null when it is current (schema matches, mirror equals the version). */
export function nameIndexProblem(state: RegistryState): NameIndexProblem | null {
  const ix = state.nameIndex
  if (!ix.valid || ix.chunk >= NAME_INDEX_MAX_CHUNKS) return "corrupt"
  if (ix.schema === null) return "missing"
  if (ix.schema !== NAME_INDEX_SCHEMA) return "schema"
  if (ix.version !== state.version) return "stale"
  return null
}

/** Firestore's stored size of a string array element: its UTF-8 bytes plus one. */
export const nameBytes = (name: string): number => Buffer.byteLength(name, "utf8") + 1

export type Placement = { byChunk: Map<number, string[]>; chunk: number; bytes: number }

/**
 * Where `names` go (pure): into the open chunk while it stays within NAME_INDEX_CHUNK_BYTES, then the next.
 * Bytes are counted for every name placed, present or not, so the count bounds the chunk's real size.
 */
export function placeNames(open: { chunk: number; bytes: number }, names: readonly string[]): Placement {
  const byChunk = new Map<number, string[]>()
  let chunk = open.chunk
  let bytes = open.bytes
  for (const name of new Set(names)) {
    const size = nameBytes(name)
    if (bytes > 0 && bytes + size > NAME_INDEX_CHUNK_BYTES) {
      chunk += 1
      bytes = 0
    }
    const list = byChunk.get(chunk)
    if (list) list.push(name)
    else byChunk.set(chunk, [name])
    bytes += size
  }
  return { byChunk, chunk, bytes }
}

/**
 * Stages a registry write's name-index part and its version bump in `tx`, for a writer that adds names (and for
 * the reconciliation): `names` are appended to the chunks and the bump carries the chunk pointer (with `patch`).
 * `state` is the counter doc read in `tx`. With a malformed state nothing is appended (the index already reads
 * corrupt and only a rebuild repairs it); the bump still happens.
 */
export function stageRegistryWrite(tx: Transaction, firmId: string, state: RegistryState, names: readonly string[], patch: NameIndexPatch = {}): void {
  const ix = state.nameIndex
  const place = ix.valid ? placeNames(ix, names) : { byChunk: new Map<number, string[]>(), chunk: ix.chunk, bytes: ix.bytes }
  for (const [n, list] of place.byChunk) {
    tx.set(
      nameIndexChunkRef(firmId, n),
      { firmId, chunk: n, kind: NAME_INDEX_COLLECTION, classification: "privileged-restricted", names: FieldValue.arrayUnion(...list) },
      { merge: true }
    )
  }
  bumpRegistryVersion(tx, firmId, { chunk: place.chunk, bytes: place.bytes, ...patch })
}

/**
 * True when the firm has no client and no opposing party row at all (two limit-1 queries; in `tx` when given).
 * Used only for a firm whose counter doc does not exist: such a firm has had no registry write through
 * functions/src, and if it also has no candidate row its (empty) index is complete, so its first registration is
 * born with a current index and a screen before it runs on an empty index. Any row there was written out of band,
 * and the index stays missing until reconciled.
 */
export async function firmRegistryEmpty(firmId: string, tx?: Transaction): Promise<boolean> {
  const db = adminDb()
  const clientsQ = db.collection("clients").where("firmId", "==", firmId).limit(1)
  const partiesQ = db.collection("matter_parties").where("firmId", "==", firmId).where("role", "==", "opposing").limit(1)
  const [clientSnap, partySnap] = tx ? [await tx.get(clientsQ), await tx.get(partiesQ)] : await Promise.all([clientsQ.get(), partiesQ.get()])
  return clientSnap.empty && partySnap.empty
}

/**
 * The patch a writer that adds names (registerClient) gives `stageRegistryWrite`: on a firm with no counter doc
 * and no candidate row yet, the index is born current (schema set; the mirror and the version both become 1).
 * Reads in `tx` (call it before `tx`'s writes).
 */
export async function bornFreshPatch(tx: Transaction, firmId: string, state: RegistryState): Promise<NameIndexPatch> {
  if (state.exists) return {}
  return (await firmRegistryEmpty(firmId, tx)) ? { schema: NAME_INDEX_SCHEMA } : {}
}

/**
 * Every name in the index at `state` (chunks 0..state.nameIndex.chunk, one getAll). A chunk that is missing
 * (other than an empty open chunk), another firm's, or not an array of strings makes the index corrupt.
 */
export async function readIndexedNames(firmId: string, state: RegistryState): Promise<Set<string>> {
  const ix = state.nameIndex
  if (!ix.valid || ix.chunk >= NAME_INDEX_MAX_CHUNKS) throw new NameIndexUnavailable("corrupt")
  const db = adminDb()
  const snaps = await db.getAll(...Array.from({ length: ix.chunk + 1 }, (_, n) => nameIndexChunkRef(firmId, n)))
  const names = new Set<string>()
  snaps.forEach((snap, n) => {
    const data = snap.data()
    if (data === undefined) {
      if (n === ix.chunk && ix.bytes === 0) return
      throw new NameIndexUnavailable("corrupt")
    }
    const list: unknown = data.names
    if (data.firmId !== firmId || !Array.isArray(list) || !list.every((x) => typeof x === "string")) throw new NameIndexUnavailable("corrupt")
    for (const x of list as string[]) names.add(x)
  })
  return names
}

/** The names a screen can hit: every client `canonicalName` and opposing party `name` (strings) of the firm, paged by id. */
export async function scanRegistryNames(firmId: string): Promise<Set<string>> {
  const db = adminDb()
  const out = new Set<string>()
  const scan = async (base: Query, field: string) => {
    let last: string | undefined
    for (;;) {
      let q = base.orderBy(FieldPath.documentId()).select(field).limit(SCAN_PAGE)
      if (last !== undefined) q = q.startAfter(last)
      const page = await q.get()
      for (const d of page.docs) {
        const v: unknown = d.get(field)
        if (typeof v === "string") out.add(v)
      }
      if (page.size < SCAN_PAGE) return
      last = page.docs[page.size - 1].id
    }
  }
  await scan(db.collection("clients").where("firmId", "==", firmId), "canonicalName")
  await scan(db.collection("matter_parties").where("firmId", "==", firmId).where("role", "==", "opposing"), "name")
  return out
}

/** A reconciliation that cannot finish: the index is malformed (permanent), or writes kept racing its scan (retryable). */
export class ReconcileError extends Error {
  readonly code: "name_index_corrupt" | "reconcile_contended"
  constructor(code: "name_index_corrupt" | "reconcile_contended") {
    super(code)
    this.name = "ReconcileError"
    this.code = code
  }
}

export type ReconcileResult = { names: number; added: number; marked: boolean; rounds: number }

/**
 * Brings the firm's name index in line with its registry (spec ruling 7), off the request path:
 *
 * 1. read the state (version v0, mirror n0) and the indexed names;
 * 2. scan the registry's names;
 * 3. append the missing ones, each transaction through `stageRegistryWrite` (so it bumps the version);
 * 4. unless the index is current already, mark it current in one transaction, provided every registry write
 *    since step 1 kept the mirror (version - v0 === mirror - n0). Otherwise a write that did not maintain the
 *    index (an old instance) raced the scan, and the round starts over.
 *
 * Idempotent and append-only: at-least-once delivery and a stale job lease are harmless. A current index with
 * nothing missing costs reads only. A malformed index is refused (`name_index_corrupt`): an operator deletes the
 * firm's chunks and its `nameIndex` field and the next run rebuilds it.
 */
export async function reconcileNameIndex(firmId: string): Promise<ReconcileResult> {
  const db = adminDb()
  for (let round = 1; round <= RECONCILE_ROUNDS; round++) {
    const start = await readRegistryState(firmId)
    let indexed: Set<string>
    try {
      indexed = await readIndexedNames(firmId, start)
    } catch (err) {
      if (err instanceof NameIndexUnavailable) throw new ReconcileError("name_index_corrupt")
      throw err
    }
    const names = await scanRegistryNames(firmId)
    const missing = [...names].filter((n) => !indexed.has(n)).sort()

    for (let i = 0; i < missing.length; ) {
      const batch: string[] = []
      let size = 0
      while (i < missing.length && (batch.length === 0 || size + nameBytes(missing[i]) <= RECONCILE_APPEND_BYTES)) {
        size += nameBytes(missing[i])
        batch.push(missing[i])
        i += 1
      }
      await db.runTransaction(async (tx) => {
        const state = await readRegistryStateTx(tx, firmId)
        if (!state.nameIndex.valid) throw new ReconcileError("name_index_corrupt")
        stageRegistryWrite(tx, firmId, state, batch)
      })
    }

    const marked = await db.runTransaction(async (tx): Promise<boolean | null> => {
      const state = await readRegistryStateTx(tx, firmId)
      if (!state.nameIndex.valid) throw new ReconcileError("name_index_corrupt")
      if (nameIndexProblem(state) === null) return false
      const writes = state.version - start.version
      const mirrored = (state.nameIndex.version ?? 0) - (start.nameIndex.version ?? 0)
      if (writes !== mirrored) return null
      stageRegistryWrite(tx, firmId, state, [], { schema: NAME_INDEX_SCHEMA, version: state.version + 1 })
      return true
    })
    if (marked !== null) return { names: names.size, added: missing.length, marked, rounds: round }
  }
  throw new ReconcileError("reconcile_contended")
}
