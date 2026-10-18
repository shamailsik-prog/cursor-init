import { FieldPath, FieldValue, type Query, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { bumpRegistryVersion, bumpResettingNameIndex, readRegistryState, readRegistryStateTx, type NameIndexPatch, type NameIndexState, type RegistryState } from "../registryVersion"

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
 * The screen also refuses an index it cannot read whole (PR #80 review): a state missing a field its writers always
 * write (`registryStateOf`), a pointer the placement cannot produce (`nameIndexStateCorrupt`), or any chunk from 0 to
 * the pointer missing or malformed (`readIndexedNames`). A missing chunk is never read as empty while the index
 * reads current: a current index always has its chunks (an index with no name has an empty chunk 0). The
 * reconciliation rebuilds a damaged index from the registry.
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
/**
 * Reconciliation rounds before it gives up retryably: a round restarts when a non-maintaining write raced its scan,
 * and resetting a damaged index takes one round before the rebuild.
 */
export const RECONCILE_ROUNDS = 4
/** Chunk documents one reset deletes at most (the cap on a sound index, with room for strays). */
const RESET_CHUNKS = NAME_INDEX_MAX_CHUNKS + 50
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

/**
 * The state cannot describe a placement: malformed or partial (`valid` false), a pointer past the cap, or an open
 * chunk past 0 with no bytes counted in it (the placement opens a chunk only to put a name in it).
 */
export function nameIndexStateCorrupt(ix: NameIndexState): boolean {
  return !ix.valid || ix.chunk >= NAME_INDEX_MAX_CHUNKS || (ix.chunk > 0 && ix.bytes === 0)
}

/** Why the index cannot serve a screen at `state`, or null when it is current (schema matches, mirror equals the version). */
export function nameIndexProblem(state: RegistryState): NameIndexProblem | null {
  const ix = state.nameIndex
  if (nameIndexStateCorrupt(ix)) return "corrupt"
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
  const place = nameIndexStateCorrupt(ix) ? { byChunk: new Map<number, string[]>(), chunk: ix.chunk, bytes: ix.bytes } : placeNames(ix, names)
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
 * Every name in the index at `state` (chunks 0..state.nameIndex.chunk, one getAll), read whole or not at all
 * (PR #80 review). The index is corrupt when the state is (`nameIndexStateCorrupt`) or when any chunk from 0 to the
 * pointer is missing, belongs to another firm, carries another chunk number, holds anything but strings, or
 * contradicts the bytes counted into it: a closed chunk holds the names placed in it, and the open one holds names
 * exactly when bytes were counted into it. The one chunk that may be absent is chunk 0 of an index never placed
 * (no schema, nothing counted), which only the reconciliation reads: a screen reads only a current index.
 */
export async function readIndexedNames(firmId: string, state: RegistryState): Promise<Set<string>> {
  const ix = state.nameIndex
  if (nameIndexStateCorrupt(ix)) throw new NameIndexUnavailable("corrupt")
  const unplaced = ix.schema === null && ix.chunk === 0 && ix.bytes === 0
  const db = adminDb()
  const snaps = await db.getAll(...Array.from({ length: ix.chunk + 1 }, (_, n) => nameIndexChunkRef(firmId, n)))
  const names = new Set<string>()
  snaps.forEach((snap, n) => {
    const data = snap.data()
    if (data === undefined) {
      if (unplaced) return
      throw new NameIndexUnavailable("corrupt")
    }
    const list: unknown = data.names
    if (data.firmId !== firmId || data.chunk !== n || !Array.isArray(list) || !list.every((x) => typeof x === "string")) throw new NameIndexUnavailable("corrupt")
    const holdsNames = list.length > 0
    if (n < ix.chunk ? !holdsNames : holdsNames !== ix.bytes > 0) throw new NameIndexUnavailable("corrupt")
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

/** A reconciliation that cannot finish: registry writes that do not maintain the index kept racing it (retryable). */
export class ReconcileError extends Error {
  readonly code: "reconcile_contended"
  constructor(code: "reconcile_contended") {
    super(code)
    this.name = "ReconcileError"
    this.code = code
  }
}

export type ReconcileResult = { names: number; added: number; marked: boolean; rebuilt: boolean; rounds: number }

/** True when `id` is one of the firm's chunk document ids (`{firmId}_{n}`), not a longer firm id's. */
const isChunkIdOf = (firmId: string, id: string): boolean => id.startsWith(`${firmId}_`) && /^\d+$/.test(id.slice(firmId.length + 1))

/**
 * Drops a damaged index (PR #80 review): in one transaction, every chunk document of the firm is deleted and the
 * state is reset to an unplaced, schema-less index (it reads `missing`) with a bump, so in-flight openings re-screen.
 * Nothing is done when the registry moved since `start` was read: the caller's next round reads it again.
 */
async function resetNameIndex(firmId: string, start: RegistryState): Promise<void> {
  const db = adminDb()
  const chunks = db
    .collection(NAME_INDEX_COLLECTION)
    .orderBy(FieldPath.documentId())
    .startAt(`${firmId}_`)
    .endAt(`${firmId}_\uf8ff`)
    .select()
    .limit(RESET_CHUNKS)
  await db.runTransaction(async (tx) => {
    const state = await readRegistryStateTx(tx, firmId)
    if (state.version !== start.version) return
    const found = await tx.get(chunks)
    for (const d of found.docs) if (isChunkIdOf(firmId, d.id)) tx.delete(d.ref)
    bumpResettingNameIndex(tx, firmId, state.version)
  })
}

/**
 * Brings the firm's name index in line with its registry (spec ruling 7), off the request path:
 *
 * 1. read the state (version v0, mirror n0) and the indexed names; a damaged index (a partial or impossible state,
 *    a missing or malformed chunk) is reset (`resetNameIndex`) and the round starts over on the empty index;
 * 2. scan the registry's names;
 * 3. append the missing ones, each transaction through `stageRegistryWrite` (so it bumps the version);
 * 4. unless the index is current already, mark it current in one transaction, provided every registry write
 *    since step 1 kept the mirror (version - v0 === mirror - n0). Otherwise a write that did not maintain the
 *    index (an old instance) raced the scan, and the round starts over. An index with no name gets an empty
 *    chunk 0 when it is marked, so a current index always has its chunks.
 *
 * Idempotent and append-only apart from the reset: at-least-once delivery and a stale job lease are harmless. A
 * current index with nothing missing costs reads only.
 */
export async function reconcileNameIndex(firmId: string): Promise<ReconcileResult> {
  const db = adminDb()
  let rebuilt = false
  rounds: for (let round = 1; round <= RECONCILE_ROUNDS; round++) {
    const start = await readRegistryState(firmId)
    let indexed: Set<string>
    try {
      indexed = await readIndexedNames(firmId, start)
    } catch (err) {
      if (!(err instanceof NameIndexUnavailable)) throw err
      await resetNameIndex(firmId, start)
      rebuilt = true
      continue
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
      const appended = await db.runTransaction(async (tx) => {
        const state = await readRegistryStateTx(tx, firmId)
        // Damaged since step 1 (an out-of-band edit): start over, which resets it.
        if (nameIndexStateCorrupt(state.nameIndex)) return false
        stageRegistryWrite(tx, firmId, state, batch)
        return true
      })
      if (!appended) continue rounds
    }

    const marked = await db.runTransaction(async (tx): Promise<boolean | null> => {
      const state = await readRegistryStateTx(tx, firmId)
      if (nameIndexStateCorrupt(state.nameIndex)) return null
      if (nameIndexProblem(state) === null) return false
      const writes = state.version - start.version
      const mirrored = (state.nameIndex.version ?? 0) - (start.nameIndex.version ?? 0)
      if (writes !== mirrored) return null
      if (state.nameIndex.bytes === 0) {
        // Nothing counted in the open chunk: an index with no name. Marked current, it gets its (empty) chunk 0.
        const open = nameIndexChunkRef(firmId, state.nameIndex.chunk)
        if (!(await tx.get(open)).exists) {
          tx.set(open, { firmId, chunk: state.nameIndex.chunk, kind: NAME_INDEX_COLLECTION, classification: "privileged-restricted", names: [] })
        }
      }
      stageRegistryWrite(tx, firmId, state, [], { schema: NAME_INDEX_SCHEMA, version: state.version + 1 })
      return true
    })
    if (marked !== null) return { names: names.size, added: missing.length, marked, rebuilt, rounds: round }
  }
  throw new ReconcileError("reconcile_contended")
}
