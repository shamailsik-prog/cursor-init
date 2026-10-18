import { Firestore, Query, Transaction, DocumentReference, type QuerySnapshot } from "firebase-admin/firestore"

/**
 * Document-read counter for the F37 cost tests: a counting wrapper around the Firestore Admin client,
 * installed at test time only (nothing in functions/src imports it).
 *
 * It counts reads the way Firestore bills them: a query costs the documents it returns, and at least one
 * read when it returns none; a document get costs one read, found or not; `getAll` costs one per
 * reference. Patched entry points, chosen so that nothing is counted twice:
 *
 * - `Query.get` (every query outside a transaction; it calls the internal `_get`);
 * - `Firestore.getAll` (every `getAll`, and `DocumentReference.get`, which the SDK implements as `getAll(this)`);
 * - `Transaction.get` and `Transaction.getAll` (reads inside a transaction; the SDK serves them through its
 *   internal document reader and `Query._get`, not through the public methods above).
 *
 * Per-collection counts are kept as well, so a test can say where the reads went.
 */

type Counts = { total: number; byCollection: Map<string, number> }

const STATE_KEY = Symbol.for("sikander.f37.readCounter")
type Global = typeof globalThis & { [STATE_KEY]?: { sinks: Set<Counts>; patched: boolean } }
const g = globalThis as Global
const state = (g[STATE_KEY] ??= { sinks: new Set<Counts>(), patched: false })

function note(collection: string, n: number): void {
  for (const sink of state.sinks) {
    sink.total += n
    sink.byCollection.set(collection, (sink.byCollection.get(collection) ?? 0) + n)
  }
}

const queryCollection = (q: unknown): string => (q as { _queryOptions?: { collectionId?: string } })._queryOptions?.collectionId ?? "<query>"
const queryCost = (snap: QuerySnapshot): number => Math.max(1, snap.size)

type Method = (this: unknown, ...args: unknown[]) => unknown

function install(): void {
  if (state.patched) return
  state.patched = true

  const qProto = Query.prototype as unknown as { get: Method }
  const qGet = qProto.get
  qProto.get = async function countedQueryGet(this: unknown, ...args: unknown[]) {
    const snap = (await qGet.apply(this, args)) as QuerySnapshot
    note(queryCollection(this), queryCost(snap))
    return snap
  }

  const fProto = Firestore.prototype as unknown as { getAll: Method }
  const fGetAll = fProto.getAll
  fProto.getAll = async function countedGetAll(this: unknown, ...args: unknown[]) {
    const out = await fGetAll.apply(this, args)
    for (const a of args) if (a instanceof DocumentReference) note(a.parent.id, 1)
    return out
  }

  const tProto = Transaction.prototype as unknown as { get: Method; getAll: Method }
  const tGet = tProto.get
  tProto.get = async function countedTxGet(this: unknown, refOrQuery: unknown, ...rest: unknown[]) {
    const out = await tGet.call(this, refOrQuery, ...rest)
    if (refOrQuery instanceof DocumentReference) note(refOrQuery.parent.id, 1)
    else note(queryCollection(refOrQuery), queryCost(out as QuerySnapshot))
    return out
  }
  const tGetAll = tProto.getAll
  tProto.getAll = async function countedTxGetAll(this: unknown, ...args: unknown[]) {
    const out = await tGetAll.apply(this, args)
    for (const a of args) if (a instanceof DocumentReference) note(a.parent.id, 1)
    return out
  }
}

install()

export type ReadCount = { total: number; byCollection: Record<string, number> }

/** The Firestore document reads billed while `fn` runs (every read started in that window, by any caller). */
export async function countReads<T>(fn: () => Promise<T>): Promise<{ result: T; reads: ReadCount }> {
  const sink: Counts = { total: 0, byCollection: new Map() }
  state.sinks.add(sink)
  try {
    const result = await fn()
    return { result, reads: { total: sink.total, byCollection: Object.fromEntries([...sink.byCollection].sort()) } }
  } finally {
    state.sinks.delete(sink)
  }
}
