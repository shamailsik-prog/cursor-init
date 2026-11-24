import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import * as objectStore from "@/platform/documents/documentObjectStore"
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
 * Staging chunks expire this long after the session starts. The matter-deletion
 * saga tombstones only `objects:documents`, so this prefix has no deletion reach
 * there. Expiry runs when the session is next touched and when
 * `sweepExpiredBulkUploads` runs. No scheduler is wired in this wave.
 */
export const BULK_UPLOAD_STAGING_TTL_MS = 24 * 60 * 60 * 1000

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

async function deleteSessionStaging(session: BulkUploadSessionRow): Promise<void> {
  await objectStore.deleteStagingSession({
    firmId: session.firmId,
    sessionId: session.id,
    files: session.files.map((file, fileIdx) => ({ fileIdx, chunkCount: file.chunkCount })),
  })
}

/**
 * Deletes staging for sessions whose `expiresAtMs` has passed, then drops the
 * rows. Does not read or delete original documents. The flag does not gate this:
 * turning the feature off must not keep expired chunks.
 */
export async function sweepExpiredBulkUploads(store: SpineStore, now: number = Date.now()): Promise<number> {
  let removed = 0
  for (const [id, session] of [...uploadSessionsOf(store).entries()]) {
    if (!session.firmId || session.expiresAtMs > now) continue
    await deleteSessionStaging(session)
    uploadSessionsOf(store).delete(id)
    removed += 1
  }
  return removed
}

async function requireSession(
  store: SpineStore,
  sessionId: string,
  caller: BulkUploadCaller
): Promise<BulkUploadSessionRow> {
  assertEnabled()
  const session = typeof sessionId === "string" ? uploadSessionsOf(store).get(sessionId) : undefined
  if (!caller || !session || session.firmId !== caller.firmId || session.callerId !== caller.userId) {
    throw new PublicError("upload session refused", "upload_session_refused")
  }
  if (!session.firmId || session.files.some((file) => file.firmId !== session.firmId)) {
    throw new PublicError("bulk upload refused", "bulk_upload_refused")
  }
  if (session.expiresAtMs <= Date.now()) {
    await deleteSessionStaging(session)
    uploadSessionsOf(store).delete(session.id)
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
    collection: objectStore.UPLOAD_SESSIONS_COLLECTION,
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
  // TODO(W1-L45): when isLooseUploadBlocked is on main, refuse a loose-vault
  // session (matterId === null) before any write when it returns true. It is
  // not on main at 7ae1a33f, so this module does not call it. The skipped test
  // is named isLooseUploadBlocked.
  if (!caller || typeof firmId !== "string" || caller.firmId !== firmId) {
    throw new PublicError("bulk upload refused", "bulk_upload_refused")
  }
  await sweepExpiredBulkUploads(store)
  if (!SAFE_SEGMENT.test(firmId) || !SAFE_SEGMENT.test(caller.userId)) {
    throw new PublicError("bulk upload refused", "bulk_upload_refused")
  }
  if (matterId !== null && (typeof matterId !== "string" || !SAFE_SEGMENT.test(matterId))) {
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
  uploadSessionsOf(store).set(id, {
    id,
    firmId,
    matterId,
    callerId: caller.userId,
    storagePath: objectStore.stagingSessionStoragePath(firmId, id),
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
  const [prior] = await objectStore.readStagingChunks({
    firmId: session.firmId,
    sessionId: session.id,
    fileIdx,
    chunkCount: 1,
    fromChunk: chunkIdx,
  })
  if (prior) {
    if (!prior.equals(bytes)) throw new PublicError("bulk upload chunk refused", "bulk_upload_chunk_refused")
    recordChunk(file, chunkIdx)
    return { state: file.state }
  }
  await objectStore.putStagingChunk({
    firmId: session.firmId,
    sessionId: session.id,
    fileIdx,
    chunkIdx,
    bytes,
  })
  recordChunk(file, chunkIdx)
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
  const parts = await objectStore.readStagingChunks({
    firmId: session.firmId,
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
    await objectStore.deleteStagingSession({
      firmId: session.firmId,
      sessionId: session.id,
      files: [{ fileIdx, chunkCount: file.chunkCount }],
    })
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
  try {
    await objectStore.deleteStagingSession({
      firmId: session.firmId,
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
