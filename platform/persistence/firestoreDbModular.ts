import { FieldValue as AdminFieldValue, type DocumentData as AdminDocumentData, type Firestore as AdminFirestore } from "firebase-admin/firestore"
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
  serverTimestamp as clientServerTimestamp,
  type Firestore as ClientFirestore,
} from "firebase/firestore"
import { AUDIT_OUTBOX_COLLECTION, EXTERNAL_EFFECT_PREFIX, isEffectPath } from "@/platform/persistence/auditOutboxContract"

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

/** The server-timestamp sentinel of `db`'s SDK (audit F13: canonical `createdAt`, as Cloud Functions writes it). */
export function serverTimestampFor(db: ClientFirestore | AdminFirestore): unknown {
  return isAdminFirestore(db) ? AdminFieldValue.serverTimestamp() : clientServerTimestamp()
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

/** One row of an Admin SDK query result. `cursor` is the SDK's own snapshot, so a firm-scoped listing can
 * `startAfter` it without reading the document again (F12 paging); test doubles may leave it out. */
export type AdminQueryRow = { id: string; data: () => AdminDocumentData; cursor?: unknown }

/**
 * Rows whose `fieldPath` (a nested path such as `row.firmId` too) equals `value`: for stored shapes that keep the firm
 * elsewhere than top-level `firmId` (F11: dead letters stored before the fix carry only `row.firmId`).
 */
export function queryByFieldEquals(
  db: ClientFirestore | AdminFirestore,
  collectionPath: string,
  fieldPath: string,
  value: string,
  maxResults: number = FIRM_SCOPED_LIST_LIMIT
): FirmIdQuery {
  if (isAdminFirestore(db)) {
    return db.collection(collectionPath).where(fieldPath, "==", value).limit(maxResults) as FirmIdQuery
  }
  return clientQuery(clientCollection(db, collectionPath), clientWhere(fieldPath, "==", value), clientLimit(maxResults))
}

export async function getDocs(query: FirmIdQuery | ReturnType<typeof collection>) {
  if ("get" in query && typeof query.get === "function") {
    const snap = await query.get()
    return {
      docs: snap.docs.map(
        (row): AdminQueryRow => ({
          id: row.id,
          data: () => row.data(),
          cursor: row,
        })
      ),
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
  /** The F10 operation of the claim (audit F11 records it on the outbox entry). */
  readonly operationId?: string
}

let writeFence: () => WriteFence | null = () => null

/** Installs the provider of the current request's write fence (platform/http/idempotency.ts). */
export function installWriteFence(provider: () => WriteFence | null): void {
  writeFence = provider
}

/**
 * Audit F11: the audit outbox of the current request, installed by platform/persistence/auditOutbox.ts. While a request
 * runs inside withSession, each write through setDoc / updateDoc / deleteDoc / runTransaction that touches an effect
 * path also writes one `audit_outbox` entry IN THE SAME COMMIT: inside the fence's transaction when the request holds
 * a durable claim, in one batch with the write otherwise, at the end of a repository's own transaction. The entry carries
 * the request's audit rows not yet staged, so a committed effect always has its audit in the database, even if the
 * process dies before the end-of-request flush; the reconciler (functions/src/p5/auditOutbox.ts) publishes it.
 * Spec: docs/superpowers/specs/2026-10-18-f11-atomic-request-audit-design.md.
 */
export type OutboxSession = {
  /**
   * The entry to stage with a write of `paths` to `db`, in this attempt (the same id on every attempt), or null when
   * none of the paths is an effect.
   */
  entry(db: unknown, paths: readonly string[], operationId: string | undefined): { id: string; data: Record<string, unknown> } | null
  /** The write committed: what the last `entry` staged is durable. */
  committed(): void
}

/** An outbox entry staged in a transaction the helpers do not own (F10's marker transaction for an external effect). */
export type OutboxStage = { stage(tx: FenceTransaction, db: unknown): void; committed(): void }

let auditOutbox: () => OutboxSession | null = () => null

/** Installs the provider of the current request's audit outbox (platform/persistence/auditOutbox.ts). */
export function installAuditOutbox(provider: () => OutboxSession | null): void {
  auditOutbox = provider
}

/**
 * Audit F11: the outbox entry of an effect that is not a Firestore write (a provider dispatch, `external:<kind>`), to
 * stage in the transaction that creates its F10 marker before the dispatch. Null outside a request.
 */
export function outboxForExternalEffect(kind: string, operationId: string | undefined): OutboxStage | null {
  const outbox = auditOutbox()
  if (outbox === null) return null
  return {
    stage: (tx, db) => stageOutbox(tx, db, outbox, [`${EXTERNAL_EFFECT_PREFIX}${kind}`], operationId),
    committed: () => outbox.committed(),
  }
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

/**
 * Audit F11 (ruling 11): nor can a request with an audit outbox write an effect through it: there is no admin-style
 * transaction or batch to stage the outbox entry in, and an effect must never commit without its entry.
 */
function refuseUnstagedClientWrite(path: unknown): void {
  if (auditOutbox() !== null && (typeof path !== "string" || isEffectPath(path))) {
    throw new Error("audit F11: an effect write inside a request needs an admin-style Firestore to stage its audit outbox")
  }
}

/** One write staged on an admin-style batch (or a transaction): the shape both share. */
type StagedWrites = {
  set(ref: unknown, data: Record<string, unknown>): unknown
  update(ref: unknown, data: Record<string, unknown>): unknown
  delete(ref: unknown): unknown
}

export async function setDoc(ref: ReturnType<typeof doc>, data: unknown) {
  if ("set" in ref && typeof ref.set === "function") {
    const outbox = auditOutbox()
    const fence = fenceFor(ref)
    if (fence) {
      await fence.transact((ref as unknown as AdminStyleRef).firestore, async (tx, note) => {
        note(ref.path)
        tx.set(ref, data as Record<string, unknown>)
        stageOutbox(tx, (ref as unknown as AdminStyleRef).firestore, outbox, [ref.path], fence.operationId)
      })
      outbox?.committed()
      return
    }
    if (await commitWithOutbox(ref, outbox, (batch) => batch.set(ref, data as Record<string, unknown>))) return
    await ref.set(data as Record<string, unknown>)
    return
  }
  refuseUnfencedClientWrite()
  refuseUnstagedClientWrite((ref as { path?: unknown }).path)
  await clientSetDoc(ref as never, data as never)
}

/** Audit F11: sets the request's outbox entry for a write of `paths` in `tx` (nothing when none of them is an effect). */
function stageOutbox(
  tx: Pick<StagedWrites, "set">,
  db: unknown,
  outbox: OutboxSession | null,
  paths: readonly string[],
  operationId: string | undefined
): void {
  if (outbox === null) return
  const entry = outbox.entry(db, paths, operationId)
  if (entry === null) return
  tx.set((db as AdminFirestore).collection(AUDIT_OUTBOX_COLLECTION).doc(entry.id), entry.data)
}

/**
 * Audit F11: an unfenced write inside a request commits in one batch with its outbox entry. False when there is nothing
 * to stage (no request, or not an effect path): the caller then writes alone, as before.
 */
async function commitWithOutbox(ref: unknown, outbox: OutboxSession | null, write: (batch: StagedWrites) => void): Promise<boolean> {
  if (outbox === null) return false
  const { path, firestore } = ref as AdminStyleRef
  const entry = outbox.entry(firestore, [path], undefined)
  if (entry === null) return false
  const db = firestore as { batch(): StagedWrites & { commit(): Promise<unknown> } } & Pick<AdminFirestore, "collection">
  const batch = db.batch()
  write(batch)
  batch.set(db.collection(AUDIT_OUTBOX_COLLECTION).doc(entry.id), entry.data)
  await batch.commit()
  outbox.committed()
  return true
}

export async function updateDoc(ref: ReturnType<typeof doc>, data: unknown) {
  if ("update" in ref && typeof ref.update === "function") {
    const outbox = auditOutbox()
    const fence = fenceFor(ref)
    if (fence) {
      await fence.transact((ref as unknown as AdminStyleRef).firestore, async (tx, note) => {
        note(ref.path)
        tx.update(ref, data as Record<string, unknown>)
        stageOutbox(tx, (ref as unknown as AdminStyleRef).firestore, outbox, [ref.path], fence.operationId)
      })
      outbox?.committed()
      return
    }
    if (await commitWithOutbox(ref, outbox, (batch) => batch.update(ref, data as Record<string, unknown>))) return
    await ref.update(data as Record<string, unknown>)
    return
  }
  refuseUnfencedClientWrite()
  refuseUnstagedClientWrite((ref as { path?: unknown }).path)
  await clientUpdateDoc(ref as never, data as never)
}

export async function deleteDoc(ref: ReturnType<typeof doc>) {
  if ("delete" in ref && typeof ref.delete === "function") {
    const outbox = auditOutbox()
    const fence = fenceFor(ref)
    if (fence) {
      await fence.transact((ref as unknown as AdminStyleRef).firestore, async (tx, note) => {
        note(ref.path)
        tx.delete(ref)
        stageOutbox(tx, (ref as unknown as AdminStyleRef).firestore, outbox, [ref.path], fence.operationId)
      })
      outbox?.committed()
      return
    }
    if (await commitWithOutbox(ref, outbox, (batch) => batch.delete(ref))) return
    await ref.delete()
    return
  }
  refuseUnfencedClientWrite()
  refuseUnstagedClientWrite((ref as { path?: unknown }).path)
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

/**
 * Audit F11: runs a repository's transaction function, then stages the request's outbox entry for every path it wrote,
 * in the same transaction (a write after the function's reads, as the Admin SDK requires).
 */
async function stagedRun<T>(
  tx: FenceTransaction,
  db: unknown,
  fn: (tx: TransactionWrap) => Promise<T>,
  outbox: OutboxSession,
  note?: (path: string) => void,
  operationId?: string
): Promise<T> {
  const paths: string[] = []
  const out = await fn(
    wrapTransaction(tx, (path) => {
      note?.(path)
      paths.push(path)
    })
  )
  stageOutbox(tx, db, outbox, paths, operationId)
  return out
}

/** After the commit: the outbox entry staged in it is durable. */
function committedWith<T>(outbox: OutboxSession | null): (out: T) => T {
  return (out) => {
    outbox?.committed()
    return out
  }
}

export async function runTransaction<T>(
  db: ClientFirestore | AdminFirestore,
  fn: (tx: TransactionWrap) => Promise<T>
): Promise<T> {
  if (isAdminFirestore(db)) {
    const outbox = auditOutbox()
    const fence = writeFence()
    if (fence) return fence.transact(db, async (tx, note) =>
      outbox ? stagedRun(tx, db, fn, outbox, note, fence.operationId) : fn(wrapTransaction(tx, note))
    ).then(committedWith<T>(outbox))
    if (outbox) {
      return db
        .runTransaction(async (tx) => stagedRun(tx as unknown as FenceTransaction, db, fn, outbox))
        .then(committedWith<T>(outbox))
    }
    return db.runTransaction(async (tx) => fn(wrapTransaction(tx as unknown as FenceTransaction)))
  }
  refuseUnfencedClientWrite()
  refuseUnstagedClientWrite(undefined)
  return clientRunTransaction(db, fn as never)
}

export function assertKnownFirestore(db: unknown): ClientFirestore | AdminFirestore {
  if (isAdminFirestore(db) || isClientFirestore(db)) return db
  throw new Error("unsupported Firestore database instance")
}
