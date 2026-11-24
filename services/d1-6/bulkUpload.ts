import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import { uploadSessionRecord } from "@/platform/documents/uploadSessionRecord"
import * as staging from "@/platform/documents/uploadStagingStore"
import {
  deleteRuntimeDocument,
  readRuntimeDocument,
  resolvePersistenceMode,
  writeRuntimeDocument,
} from "@/platform/persistence/runtimeRepositories"
import {
  uploadSessionsOf,
  type BulkUploadFileRow,
  type BulkUploadFileState,
  type BulkUploadSessionRow,
} from "@/platform/spine/bulkUploadSession"
import type { DocumentRecord, SpineStore } from "@/platform/spine/store"
import * as documentUpload from "@/services/d1-6/uploadDocument"

/**
 * L9.1 high-speed bulk upload. Off unless SIKANDER_FLAG_D1_BULK_UPLOAD is
 * exactly "true" (trimmed, case-insensitive). Unset means off. The flag is
 * env-only; it is not registered in platform/flags.
 */
export const D1_BULK_UPLOAD_FLAG = "D1_BULK_UPLOAD"

/** One session holds at most this many files. */
export const BULK_UPLOAD_MAX_FILES = 500

/** One session holds at most this many declared bytes (8 GiB). */
export const BULK_UPLOAD_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024

/**
 * Fixed chunk size. Every chunk except the last is exactly this long. The last
 * chunk is the remainder, and is shorter unless the file size divides evenly.
 */
export const BULK_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

/**
 * Staging chunks expire this long after they are written. The bucket lifecycle
 * in infra/backup/upload-staging-lifecycle.json is the same one day and does not
 * need this process. `sweepExpiredBulkUploads` lists the objects themselves.
 */
export const BULK_UPLOAD_STAGING_TTL_MS = staging.UPLOAD_STAGING_LIFECYCLE_DAYS * 24 * 60 * 60 * 1000

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const MIME = /^[\x21-\x7e]{1,127}$/

export type BulkUploadCaller = { userId: string; firmId: string }

export type BulkUploadFileInput = {
  name: string
  size: number
  sha256: string
  mimeType?: string
  classification: string
}

export function isBulkUploadEnabled(): boolean {
  return process.env[`SIKANDER_FLAG_${D1_BULK_UPLOAD_FLAG}`]?.trim().toLowerCase() === "true"
}

/**
 * Vault content hash the session declares as `sha256`: sha256 of the firm id
 * concatenated with the bytes, the same value `DocumentRecord.contentHash`
 * stores. A bare file digest does not match an existing document.
 */
export function bulkDeclaredHash(store: SpineStore, firmId: string, bytes: Buffer): string {
  return store.hashKey(firmId, bytes)
}

function assertEnabled(): void {
  if (!isBulkUploadEnabled()) throw new PublicError("bulk upload is disabled", "bulk_upload_disabled")
}

function chunkCountFor(size: number): number {
  return Math.ceil(size / BULK_UPLOAD_CHUNK_BYTES)
}

function expectedChunkLength(size: number, chunkIdx: number, chunkCount: number): number {
  if (chunkIdx < chunkCount) return BULK_UPLOAD_CHUNK_BYTES
  return size - (chunkCount - 1) * BULK_UPLOAD_CHUNK_BYTES
}

function sameHeld(doc: DocumentRecord, firmId: string, matterId: string | null, sha256: string): boolean {
  return doc.firmId === firmId && doc.contentHash === sha256 && (doc.matterId ?? null) === matterId
}

function heldDocument(
  store: SpineStore,
  firmId: string,
  matterId: string | null,
  sha256: string
): DocumentRecord | undefined {
  const dedupKey = `${sha256}|${matterId ?? "loose-vault"}`
  const direct = store.documents.get(store.docsByHash.get(dedupKey) ?? "")
  if (direct && sameHeld(direct, firmId, matterId, sha256)) return direct
  for (const doc of store.documents.values()) {
    if (sameHeld(doc, firmId, matterId, sha256)) return doc
  }
  return undefined
}

function sessionPayload(session: BulkUploadSessionRow): Record<string, unknown> {
  return uploadSessionRecord(session)
}

const FILE_STATES = new Set<BulkUploadFileState>(["pending", "uploading", "deduped", "finalised", "failed"])

function storedStagingPath(firmId: string, storagePath: string): boolean {
  const key = storagePath.startsWith("s3://")
    ? storagePath.slice("s3://".length)
    : storagePath.startsWith("fs://")
      ? storagePath.slice("fs://".length)
      : ""
  return key.startsWith(`upload-staging/${firmId}/`) && !key.includes("..")
}

function parseStoredFile(firmId: string, raw: unknown): BulkUploadFileRow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const file = raw as Record<string, unknown>
  if (file.firmId !== firmId) return undefined
  if (typeof file.name !== "string" || file.name.length < 1 || file.name.length > 240) return undefined
  if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 1) return undefined
  if (typeof file.sha256 !== "string" || !SHA256_HEX.test(file.sha256)) return undefined
  if (typeof file.classification !== "string" || !isClassification(file.classification)) return undefined
  if (typeof file.state !== "string" || !FILE_STATES.has(file.state as BulkUploadFileState)) return undefined
  if (typeof file.chunkCount !== "number" || !Number.isSafeInteger(file.chunkCount) || file.chunkCount < 1) return undefined
  if (!Array.isArray(file.receivedChunks) || file.receivedChunks.some((n) => typeof n !== "number" || !Number.isSafeInteger(n))) {
    return undefined
  }
  const row: BulkUploadFileRow = {
    firmId,
    name: file.name,
    size: file.size,
    sha256: file.sha256,
    classification: file.classification,
    state: file.state as BulkUploadFileState,
    chunkCount: file.chunkCount,
    receivedChunks: [...file.receivedChunks],
  }
  if (file.mimeType !== undefined) {
    if (typeof file.mimeType !== "string" || !MIME.test(file.mimeType)) return undefined
    row.mimeType = file.mimeType
  }
  if (file.docId !== undefined) {
    if (typeof file.docId !== "string" || file.docId.length < 1) return undefined
    row.docId = file.docId
  }
  return row
}

/** A stored `upload_sessions` row. Invalid shapes are refused, not coerced into a live session. */
export function parseStoredUploadSession(id: string, data: Record<string, unknown>): BulkUploadSessionRow | undefined {
  if (typeof data.firmId !== "string" || !SAFE_SEGMENT.test(data.firmId)) return undefined
  if (data.matterId !== null && (typeof data.matterId !== "string" || !SAFE_SEGMENT.test(data.matterId) || data.matterId === "loose")) {
    return undefined
  }
  if (typeof data.callerId !== "string" || !SAFE_SEGMENT.test(data.callerId)) return undefined
  if (typeof data.storagePath !== "string" || !storedStagingPath(data.firmId, data.storagePath)) return undefined
  if (typeof data.createdAtMs !== "number" || !Number.isFinite(data.createdAtMs)) return undefined
  if (typeof data.expiresAtMs !== "number" || !Number.isFinite(data.expiresAtMs) || data.expiresAtMs < data.createdAtMs) {
    return undefined
  }
  if (!Array.isArray(data.files) || data.files.length < 1 || data.files.length > BULK_UPLOAD_MAX_FILES) return undefined
  const files: BulkUploadFileRow[] = []
  for (const raw of data.files) {
    const file = parseStoredFile(data.firmId, raw)
    if (!file) return undefined
    files.push(file)
  }
  return {
    id,
    firmId: data.firmId,
    matterId: data.matterId,
    callerId: data.callerId,
    storagePath: data.storagePath,
    createdAtMs: data.createdAtMs,
    expiresAtMs: data.expiresAtMs,
    files,
  }
}

async function remember(store: SpineStore, session: BulkUploadSessionRow): Promise<void> {
  uploadSessionsOf(store).set(session.id, session)
  if (resolvePersistenceMode() !== "firestore") return
  await writeRuntimeDocument(staging.UPLOAD_SESSIONS_COLLECTION, session.id, sessionPayload(session))
}

async function forget(store: SpineStore, session: BulkUploadSessionRow): Promise<void> {
  uploadSessionsOf(store).delete(session.id)
  if (resolvePersistenceMode() !== "firestore") return
  await deleteRuntimeDocument(staging.UPLOAD_SESSIONS_COLLECTION, session.id)
}

async function recall(store: SpineStore, sessionId: string): Promise<BulkUploadSessionRow | undefined> {
  if (resolvePersistenceMode() === "firestore") {
    const data = await readRuntimeDocument(staging.UPLOAD_SESSIONS_COLLECTION, sessionId)
    if (!data) {
      uploadSessionsOf(store).delete(sessionId)
      return undefined
    }
    const row = parseStoredUploadSession(sessionId, data)
    if (!row) {
      uploadSessionsOf(store).delete(sessionId)
      return undefined
    }
    uploadSessionsOf(store).set(sessionId, row)
    return row
  }
  return uploadSessionsOf(store).get(sessionId)
}

async function deleteSessionStaging(session: BulkUploadSessionRow): Promise<void> {
  await staging.deleteStagingSession({
    firmId: session.firmId,
    matterId: session.matterId,
    sessionId: session.id,
    files: session.files.map((file, fileIdx) => ({ fileIdx, chunkCount: file.chunkCount })),
  })
}

/**
 * Deletes staging for sessions whose `expiresAtMs` has passed, then drops the
 * rows. Does not read or delete original documents. The flag does not gate this:
 * turning the feature off must not keep expired chunks.
 */
export async function sweepExpiredBulkUploads(
  store: SpineStore,
  now: number = Date.now(),
  firmId?: string
): Promise<number> {
  if (firmId !== undefined && !SAFE_SEGMENT.test(firmId)) {
    throw new PublicError("bulk upload refused", "bulk_upload_refused")
  }
  const prefix = firmId === undefined ? staging.UPLOAD_STAGING_OBJECT_PREFIX : `upload-staging/${firmId}/`
  const removed = await staging.sweepExpiredStagingObjects(now, BULK_UPLOAD_STAGING_TTL_MS, prefix)
  for (const session of [...uploadSessionsOf(store).values()]) {
    if (!session.firmId || session.expiresAtMs > now) continue
    if (firmId !== undefined && session.firmId !== firmId) continue
    await forget(store, session)
  }
  return removed
}

async function requireSession(
  store: SpineStore,
  sessionId: string,
  caller: BulkUploadCaller
): Promise<BulkUploadSessionRow> {
  assertEnabled()
  const session = typeof sessionId === "string" ? await recall(store, sessionId) : undefined
  if (!caller || !session || session.firmId !== caller.firmId || session.callerId !== caller.userId) {
    throw new PublicError("upload session refused", "upload_session_refused")
  }
  if (!session.firmId || session.files.some((file) => file.firmId !== session.firmId)) {
    throw new PublicError("bulk upload refused", "bulk_upload_refused")
  }
  if (session.expiresAtMs <= Date.now()) {
    await deleteSessionStaging(session)
    await forget(store, session)
    throw new PublicError("bulk upload session expired", "bulk_upload_expired")
  }
  return session
}

/** The durable row shape. `collection` is the inventoried name; every row carries `firmId`. */
export function uploadSessionDocument(session: BulkUploadSessionRow): {
  collection: string
  firmId: string
  matterId: string | null
  callerId: string
  storagePath: string
  expiresAtMs: number
} {
  if (!session.firmId || session.files.some((file) => file.firmId !== session.firmId)) {
    throw new PublicError("bulk upload refused", "bulk_upload_refused")
  }
  return {
    collection: staging.UPLOAD_SESSIONS_COLLECTION,
    firmId: session.firmId,
    matterId: session.matterId,
    callerId: session.callerId,
    storagePath: session.storagePath,
    expiresAtMs: session.expiresAtMs,
  }
}

function recordChunk(file: BulkUploadFileRow, chunkIdx: number): void {
  if (!file.receivedChunks.includes(chunkIdx)) {
    file.receivedChunks.push(chunkIdx)
    file.receivedChunks.sort((left, right) => left - right)
  }
  if (file.state === "pending") file.state = "uploading"
}

function missingChunkIndexes(file: BulkUploadFileRow): number[] {
  if (file.state === "deduped" || file.state === "finalised" || file.state === "failed") return []
  const have = new Set(file.receivedChunks)
  const missing: number[] = []
  for (let index = 1; index <= file.chunkCount; index++) {
    if (!have.has(index)) missing.push(index)
  }
  return missing
}

function bytesReceived(file: BulkUploadFileRow): number {
  let total = 0
  for (const chunkIdx of file.receivedChunks) {
    total += expectedChunkLength(file.size, chunkIdx, file.chunkCount)
  }
  return total
}

function requireFile(session: BulkUploadSessionRow, fileIdx: number): BulkUploadFileRow {
  if (!Number.isSafeInteger(fileIdx) || fileIdx < 0 || fileIdx >= session.files.length) {
    throw new PublicError("bulk upload refused", "bulk_upload_refused")
  }
  const file = session.files[fileIdx]
  if (!file) throw new PublicError("bulk upload refused", "bulk_upload_refused")
  return file
}

export async function startBulkUpload(
  store: SpineStore,
  firmId: string,
  matterId: string | null,
  files: BulkUploadFileInput[],
  caller: BulkUploadCaller
): Promise<{ sessionId: string; files: Array<{ fileIdx: number; state: BulkUploadFileState; docId?: string }> }> {
  assertEnabled()
  // TODO(W1-L45): isLooseUploadBlocked is on main and this module does not call
  // it. Wiring is a follow-up. When it is wired, catch only (404, feature_disabled)
  // and rethrow every other error. Matter authorization stays in the route.
  // The skipped test is named isLooseUploadBlocked.
  if (!caller || typeof firmId !== "string" || caller.firmId !== firmId) {
    throw new PublicError("bulk upload refused", "bulk_upload_refused")
  }
  if (!SAFE_SEGMENT.test(firmId) || !SAFE_SEGMENT.test(caller.userId)) {
    throw new PublicError("bulk upload refused", "bulk_upload_refused")
  }
  await sweepExpiredBulkUploads(store, Date.now(), firmId)
  if (matterId !== null && (typeof matterId !== "string" || !SAFE_SEGMENT.test(matterId) || matterId === "loose")) {
    throw new PublicError("bulk upload refused", "bulk_upload_refused")
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new PublicError("bulk upload refused", "bulk_upload_refused")
  }
  if (files.length > BULK_UPLOAD_MAX_FILES) {
    throw new PublicError("bulk upload exceeds the file count cap", "bulk_upload_file_cap")
  }
  let total = 0
  const rows: BulkUploadFileRow[] = []
  for (const file of files) {
    if (!file || typeof file.name !== "string" || file.name.length < 1 || file.name.length > 240) {
      throw new PublicError("bulk upload refused", "bulk_upload_refused")
    }
    if (/[\u0000-\u001f]/.test(file.name)) throw new PublicError("bulk upload refused", "bulk_upload_refused")
    if (typeof file.sha256 !== "string" || !SHA256_HEX.test(file.sha256)) {
      throw new PublicError("bulk upload refused", "bulk_upload_refused")
    }
    if (!Number.isSafeInteger(file.size) || file.size < 1) {
      throw new PublicError("bulk upload refused", "bulk_upload_refused")
    }
    if (file.size > BULK_UPLOAD_MAX_TOTAL_BYTES || total > BULK_UPLOAD_MAX_TOTAL_BYTES - file.size) {
      throw new PublicError("bulk upload exceeds the total byte cap", "bulk_upload_byte_cap")
    }
    total += file.size
    if (!isClassification(file.classification)) {
      throw new PublicError("unknown classification", "unknown_classification")
    }
    if (file.mimeType !== undefined && (typeof file.mimeType !== "string" || !MIME.test(file.mimeType))) {
      throw new PublicError("bulk upload refused", "bulk_upload_refused")
    }
    const held = heldDocument(store, firmId, matterId, file.sha256)
    const classification: Classification = file.classification
    rows.push({
      firmId,
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      classification,
      state: held ? "deduped" : "pending",
      chunkCount: chunkCountFor(file.size),
      receivedChunks: [],
      ...(held ? { docId: held.id } : {}),
    })
  }
  const id = store.id("ups")
  const now = Date.now()
  await remember(store, {
    id,
    firmId,
    matterId,
    callerId: caller.userId,
    storagePath: staging.stagingSessionStoragePath(firmId, matterId, id),
    createdAtMs: now,
    expiresAtMs: now + BULK_UPLOAD_STAGING_TTL_MS,
    files: rows,
  })
  return {
    sessionId: id,
    files: rows.map((file, fileIdx) => ({
      fileIdx,
      state: file.state,
      ...(file.docId ? { docId: file.docId } : {}),
    })),
  }
}

export async function uploadChunk(
  store: SpineStore,
  sessionId: string,
  fileIdx: number,
  chunkIdx: number,
  bytes: Buffer,
  caller: BulkUploadCaller
): Promise<{ state: BulkUploadFileState }> {
  const session = await requireSession(store, sessionId, caller)
  const file = requireFile(session, fileIdx)
  if (file.state === "deduped" || file.state === "finalised" || file.state === "failed") {
    throw new PublicError("bulk upload chunk refused", "bulk_upload_chunk_refused")
  }
  if (!Number.isSafeInteger(chunkIdx) || chunkIdx < 1 || chunkIdx > file.chunkCount) {
    throw new PublicError("bulk upload chunk refused", "bulk_upload_chunk_refused")
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== expectedChunkLength(file.size, chunkIdx, file.chunkCount)) {
    throw new PublicError("bulk upload chunk refused", "bulk_upload_chunk_refused")
  }
  const [prior] = await staging.readStagingChunks({
    firmId: session.firmId,
    matterId: session.matterId,
    sessionId: session.id,
    fileIdx,
    chunkCount: 1,
    fromChunk: chunkIdx,
  })
  if (prior) {
    if (!prior.equals(bytes)) throw new PublicError("bulk upload chunk refused", "bulk_upload_chunk_refused")
    recordChunk(file, chunkIdx)
    await remember(store, session)
    return { state: file.state }
  }
  await staging.putStagingChunk({
    firmId: session.firmId,
    matterId: session.matterId,
    sessionId: session.id,
    fileIdx,
    chunkIdx,
    bytes,
  })
  recordChunk(file, chunkIdx)
  await remember(store, session)
  return { state: file.state }
}

export async function resumeUpload(
  store: SpineStore,
  sessionId: string,
  caller: BulkUploadCaller
): Promise<{ files: Array<{ fileIdx: number; missingChunks: number[] }> }> {
  const session = await requireSession(store, sessionId, caller)
  return {
    files: session.files.map((file, fileIdx) => ({
      fileIdx,
      missingChunks: missingChunkIndexes(file),
    })),
  }
}

export async function finaliseFile(
  store: SpineStore,
  sessionId: string,
  fileIdx: number,
  caller: BulkUploadCaller
): Promise<{ docId: string; reused: boolean }> {
  const session = await requireSession(store, sessionId, caller)
  const file = requireFile(session, fileIdx)
  if ((file.state === "finalised" || file.state === "deduped") && file.docId) {
    return { docId: file.docId, reused: true }
  }
  if (file.state === "failed") throw new PublicError("bulk upload hash mismatch", "bulk_upload_hash_mismatch")
  const have = new Set(file.receivedChunks)
  for (let index = 1; index <= file.chunkCount; index++) {
    if (!have.has(index)) throw new PublicError("bulk upload incomplete", "bulk_upload_incomplete")
  }
  const parts = await staging.readStagingChunks({
    firmId: session.firmId,
    matterId: session.matterId,
    sessionId: session.id,
    fileIdx,
    chunkCount: file.chunkCount,
  })
  if (parts.some((part) => part === null)) {
    throw new PublicError("bulk upload incomplete", "bulk_upload_incomplete")
  }
  const assembled = Buffer.concat(parts as Buffer[])
  const actual = bulkDeclaredHash(store, session.firmId, assembled)
  if (actual !== file.sha256 || assembled.length !== file.size) {
    file.state = "failed"
    await staging.deleteStagingSession({
      firmId: session.firmId,
      matterId: session.matterId,
      sessionId: session.id,
      files: [{ fileIdx, chunkCount: file.chunkCount }],
    })
    await remember(store, session)
    throw new PublicError("bulk upload hash mismatch", "bulk_upload_hash_mismatch")
  }
  const result = await documentUpload.uploadDocument(store, {
    firmId: session.firmId,
    matterId: session.matterId,
    bytes: assembled,
    sourceChannel: "bulk",
    classification: file.classification,
    idempotencyKey: `bulk-${session.id}-${fileIdx}`,
    uploadedBy: session.callerId,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
  })
  file.state = "finalised"
  file.docId = result.docId
  await remember(store, session)
  try {
    await staging.deleteStagingSession({
      firmId: session.firmId,
      matterId: session.matterId,
      sessionId: session.id,
      files: [{ fileIdx, chunkCount: file.chunkCount }],
    })
  } catch (_err) {
    // Staging is not the original. The document row and object are already committed.
  }
  return result
}

export async function getUploadProgress(
  store: SpineStore,
  sessionId: string,
  caller: BulkUploadCaller
): Promise<{
  sessionId: string
  files: Array<{
    fileIdx: number
    name: string
    state: BulkUploadFileState
    size: number
    bytesReceived: number
    docId?: string
  }>
}> {
  const session = await requireSession(store, sessionId, caller)
  return {
    sessionId: session.id,
    files: session.files.map((file, fileIdx) => ({
      fileIdx,
      name: file.name,
      state: file.state,
      size: file.size,
      bytesReceived: bytesReceived(file),
      ...(file.docId ? { docId: file.docId } : {}),
    })),
  }
}
