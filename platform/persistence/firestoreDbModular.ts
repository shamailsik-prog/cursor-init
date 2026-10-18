import type { Firestore as AdminFirestore } from "firebase-admin/firestore"
import {
  collection as clientCollection,
  doc as clientDoc,
  getDoc as clientGetDoc,
  getDocs as clientGetDocs,
  query as clientQuery,
  startAfter as clientStartAfter,
  runTransaction as clientRunTransaction,
  setDoc as clientSetDoc,
  updateDoc as clientUpdateDoc,
  deleteDoc as clientDeleteDoc,
  where as clientWhere,
  limit as clientLimit,
  type Firestore as ClientFirestore,
} from "firebase/firestore"

/** Default cap for firm-scoped list queries (admin SDK must not scan whole collections). */
export const FIRM_SCOPED_LIST_LIMIT = 500

/** Cursor document missing or not owned by the requested firm (do not silently restart at page 1). */
export class FirmScopedCursorError extends Error {
  readonly code = "FIRM_SCOPED_CURSOR_INVALID"

  constructor(message: string) {
    super(message)
    this.name = "FirmScopedCursorError"
  }
}

export type Firestore = ClientFirestore | AdminFirestore

function isAdminFirestore(db: unknown): db is AdminFirestore {
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as AdminFirestore).collection === "function"
  )
}

function isClientFirestore(db: unknown): db is ClientFirestore {
  return typeof db === "object" && db !== null && !isAdminFirestore(db)
}

export function collection(db: ClientFirestore | AdminFirestore, path: string) {
  if (isAdminFirestore(db)) return db.collection(path)
  return clientCollection(db, path)
}

export function doc(
  db: ClientFirestore | AdminFirestore,
  collectionPath: string,
  documentId?: string
) {
  if (isAdminFirestore(db)) {
    if (documentId !== undefined) return db.collection(collectionPath).doc(documentId)
    return db.doc(collectionPath)
  }
  return clientDoc(db, collectionPath, documentId!)
}

export async function getDoc(ref: ReturnType<typeof doc>) {
  if ("get" in ref && typeof ref.get === "function") {
    const snap = await ref.get()
    return {
      exists: () => snap.exists,
      data: () => snap.data(),
      id: snap.id,
    }
  }
  return clientGetDoc(ref as never)
}

export type FirmIdQuery = ReturnType<typeof collection> | ReturnType<typeof clientQuery>

export function queryByFirmId(
  db: ClientFirestore | AdminFirestore,
  collectionPath: string,
  firmId: string,
  maxResults: number = FIRM_SCOPED_LIST_LIMIT
): FirmIdQuery {
  if (isAdminFirestore(db)) {
    return db
      .collection(collectionPath)
      .where("firmId", "==", firmId)
      .limit(maxResults) as FirmIdQuery
  }
  return clientQuery(
    clientCollection(db, collectionPath),
    clientWhere("firmId", "==", firmId),
    clientLimit(maxResults)
  )
}

export function queryByFirmIdAndField(
  db: ClientFirestore | AdminFirestore,
  collectionPath: string,
  firmId: string,
  field: string,
  value: string,
  maxResults: number = FIRM_SCOPED_LIST_LIMIT
): FirmIdQuery {
  if (isAdminFirestore(db)) {
    return db
      .collection(collectionPath)
      .where("firmId", "==", firmId)
      .where(field, "==", value)
      .limit(maxResults) as FirmIdQuery
  }
  return clientQuery(
    clientCollection(db, collectionPath),
    clientWhere("firmId", "==", firmId),
    clientWhere(field, "==", value),
    clientLimit(maxResults)
  )
}

export async function validateFirmListCursor(
  db: Firestore,
  collectionPath: string,
  firmId: string,
  startAfterId: string
): Promise<unknown> {
  const ref = doc(db, collectionPath, startAfterId)
  if (isAdminFirestore(db)) {
    const snap = await (ref as { get: () => Promise<{ exists: boolean; data: () => unknown }> }).get()
    if (!snap.exists) {
      throw new FirmScopedCursorError("invalid cursor")
    }
    const data = snap.data() as { firmId?: string }
    if (data.firmId !== firmId) {
      throw new FirmScopedCursorError("cross-firm cursor")
    }
    return snap
  }
  const snap = await clientGetDoc(ref as never)
  if (!snap.exists()) {
    throw new FirmScopedCursorError("invalid cursor")
  }
  const data = snap.data() as { firmId?: string }
  if (data.firmId !== firmId) {
    throw new FirmScopedCursorError("cross-firm cursor")
  }
  return snap
}

export function withFirmQueryStartAfter(
  db: Firestore,
  baseQuery: FirmIdQuery,
  cursorSnap: unknown
): FirmIdQuery {
  if (isAdminFirestore(db)) {
    const adminQuery = baseQuery as { startAfter?: (snap: unknown) => FirmIdQuery }
    if (typeof adminQuery.startAfter !== "function") {
      throw new Error("admin firm query does not support startAfter")
    }
    return adminQuery.startAfter(cursorSnap)
  }
  return clientQuery(baseQuery as never, clientStartAfter(cursorSnap as never)) as FirmIdQuery
}

export async function getDocs(query: FirmIdQuery | ReturnType<typeof collection>) {
  if ("get" in query && typeof query.get === "function") {
    const snap = await query.get()
    return {
      docs: snap.docs.map((row) => ({
        id: row.id,
        data: () => row.data(),
      })),
      empty: snap.empty,
    }
  }
  return clientGetDocs(query as never)
}

/**
 * A transaction as the write fence drives it: the admin-style API (the Admin SDK's, which the compat client shares).
 */
export type FenceTransaction = {
  get(ref: unknown): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>
  set(ref: unknown, data: Record<string, unknown>): unknown
  update(ref: unknown, data: Record<string, unknown>): unknown
  delete(ref: unknown): unknown
}

/**
 * Audit F10: the effect fence of an idempotent Next request, installed by platform/http/idempotency.ts. While a request
 * holds a durable idempotency claim, every write through setDoc / updateDoc / deleteDoc / runTransaction below commits
 * inside `transact`, one transaction that first reads the claim and the operation's effect marker, then stages the write,
 * then (when the write touched a path the fence `covers`) refuses an attempt that no longer holds the claim and creates
 * the marker with the write. Outside such a request the provider returns null and the helpers write as before.
 */
export type WriteFence = {
  covers(path: string): boolean
  transact<T>(db: unknown, stage: (tx: FenceTransaction, note: (path: string) => void) => Promise<T>): Promise<T>
}

let writeFence: () => WriteFence | null = () => null

/** Installs the provider of the current request's write fence (platform/http/idempotency.ts). */
export function installWriteFence(provider: () => WriteFence | null): void {
  writeFence = provider
}

type AdminStyleRef = { path: string; firestore: unknown }

/** The active fence for a write to `ref`, or null (no fenced request, or a path the fence does not cover). */
function fenceFor(ref: unknown): WriteFence | null {
  const fence = writeFence()
  if (fence === null) return null
  const path = (ref as Partial<AdminStyleRef>).path
  return typeof path === "string" && fence.covers(path) ? fence : null
}

/** A fenced request cannot write through the modular client SDK: it has no admin-style transaction for the fence. */
function refuseUnfencedClientWrite(): void {
  if (writeFence() !== null) {
    throw new Error("audit F10: a write inside an idempotent request needs an admin-style Firestore for its fence")
  }
}

export async function setDoc(ref: ReturnType<typeof doc>, data: unknown) {
  if ("set" in ref && typeof ref.set === "function") {
    const fence = fenceFor(ref)
    if (fence) {
      await fence.transact((ref as unknown as AdminStyleRef).firestore, async (tx, note) => {
        note(ref.path)
        tx.set(ref, data as Record<string, unknown>)
      })
      return
    }
    await ref.set(data as Record<string, unknown>)
    return
  }
  refuseUnfencedClientWrite()
  await clientSetDoc(ref as never, data as never)
}

export async function updateDoc(ref: ReturnType<typeof doc>, data: unknown) {
  if ("update" in ref && typeof ref.update === "function") {
    const fence = fenceFor(ref)
    if (fence) {
      await fence.transact((ref as unknown as AdminStyleRef).firestore, async (tx, note) => {
        note(ref.path)
        tx.update(ref, data as Record<string, unknown>)
      })
      return
    }
    await ref.update(data as Record<string, unknown>)
    return
  }
  refuseUnfencedClientWrite()
  await clientUpdateDoc(ref as never, data as never)
}

export async function deleteDoc(ref: ReturnType<typeof doc>) {
  if ("delete" in ref && typeof ref.delete === "function") {
    const fence = fenceFor(ref)
    if (fence) {
      await fence.transact((ref as unknown as AdminStyleRef).firestore, async (tx, note) => {
        note(ref.path)
        tx.delete(ref)
      })
      return
    }
    await ref.delete()
    return
  }
  refuseUnfencedClientWrite()
  await clientDeleteDoc(ref as never)
}

type TransactionWrap = {
  get: (ref: ReturnType<typeof doc>) => Promise<{ exists: () => boolean; data: () => unknown }>
  set: (ref: ReturnType<typeof doc>, data: unknown) => void
  update: (ref: ReturnType<typeof doc>, data: unknown) => void
}

/** The repositories' view of an admin-style transaction; `note` sees the path of every staged write (the fence). */
function wrapTransaction(tx: FenceTransaction, note?: (path: string) => void): TransactionWrap {
  return {
    get: async (ref) => {
      const snap = await tx.get(ref)
      return { exists: () => snap.exists, data: () => snap.data() }
    },
    set: (ref, data) => {
      note?.((ref as unknown as AdminStyleRef).path)
      tx.set(ref, data as Record<string, unknown>)
    },
    update: (ref, data) => {
      note?.((ref as unknown as AdminStyleRef).path)
      tx.update(ref, data as Record<string, unknown>)
    },
  }
}

export async function runTransaction<T>(
  db: ClientFirestore | AdminFirestore,
  fn: (tx: TransactionWrap) => Promise<T>
): Promise<T> {
  if (isAdminFirestore(db)) {
    const fence = writeFence()
    if (fence) return fence.transact(db, async (tx, note) => fn(wrapTransaction(tx, note)))
    return db.runTransaction(async (tx) => fn(wrapTransaction(tx as unknown as FenceTransaction)))
  }
  refuseUnfencedClientWrite()
  return clientRunTransaction(db, fn as never)
}

export function assertKnownFirestore(db: unknown): ClientFirestore | AdminFirestore {
  if (isAdminFirestore(db) || isClientFirestore(db)) return db
  throw new Error("unsupported Firestore database instance")
}
