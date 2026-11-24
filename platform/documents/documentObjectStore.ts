import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SpineStore } from "@/platform/spine/store"
import {
  assertDocumentObjectS3Configuration,
  deleteS3Payload,
  isDocumentObjectS3Configured,
  listS3Keys,
  readS3Payload,
  resetDocumentObjectS3ClientForTests,
  writeS3Payload,
} from "@/platform/documents/documentObjectS3"
import {
  DocumentObjectConfigurationError,
  DocumentObjectStoreError,
} from "@/platform/documents/documentObjectStoreTypes"

export { DocumentObjectConfigurationError, DocumentObjectStoreError }

const OBJECT_FORMAT_VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16
const FS_STORAGE_SCHEME = "fs://"
const S3_STORAGE_SCHEME = "s3://"
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/

export type DocumentObjectPutInput = {
  store: SpineStore
  firmId: string
  docId: string
  bytes: Buffer
  contentHash: string
  mimeType: string
}

export type DocumentObjectPutResult = {
  storagePath: string
  objectVersion: number
  byteSize: number
  mimeType: string
}

export type DocumentObjectBackendKind = "memory" | "fs" | "s3"

function explicitBackendFromEnv(): DocumentObjectBackendKind | null {
  const raw = process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND?.trim().toLowerCase()
  if (!raw) return null
  if (raw === "s3" || raw === "r2") return "s3"
  if (raw === "fs") return "fs"
  if (raw === "memory") return "memory"
  throw new DocumentObjectConfigurationError(
    `unsupported SIKANDER_DOCUMENT_OBJECT_BACKEND value: ${raw}`
  )
}

/**
 * The vault backend for this call. Every object-store operation starts here, and in production it
 * returns "s3" (with the four S3 settings present) or throws: fs and memory never run in production.
 */
export function resolveDocumentObjectBackendKind(): DocumentObjectBackendKind {
  const explicit = explicitBackendFromEnv()
  if (process.env.NODE_ENV === "production") {
    if (explicit === "fs" || explicit === "memory") {
      throw new DocumentObjectConfigurationError(
        "production requires S3-compatible document object storage (R2); fs and memory backends are forbidden"
      )
    }
    if (!isDocumentObjectS3Configured()) {
      throw new DocumentObjectConfigurationError(
        "production requires S3-compatible document object storage (configure Cloudflare R2 / S3 env vars)"
      )
    }
    return "s3"
  }
  if (explicit) return explicit
  if (process.env.SIKANDER_DOCUMENT_OBJECT_ROOT?.trim()) return "fs"
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") return "memory"
  if (isDocumentObjectS3Configured()) return "s3"
  return "memory"
}

function activeStorageScheme(): string {
  return resolveDocumentObjectBackendKind() === "s3" ? S3_STORAGE_SCHEME : FS_STORAGE_SCHEME
}

/** Exactly 64 hex characters. Buffer.from(hex) stops at the first bad pair, so it cannot be the check. */
const ENCRYPTION_KEY_HEX = /^[0-9a-fA-F]{64}$/

function encryptionKey(): Buffer {
  const raw = process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY?.trim()
  if (!raw) {
    throw new DocumentObjectConfigurationError("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY is not set")
  }
  if (!ENCRYPTION_KEY_HEX.test(raw)) {
    throw new DocumentObjectConfigurationError(
      "SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"
    )
  }
  const key = Buffer.from(raw, "hex")
  if (key.every((byte) => byte === key[0])) {
    throw new DocumentObjectConfigurationError(
      "SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY must not be one byte repeated (all-zero, all-ff and the like)"
    )
  }
  return key
}

export function assertDocumentObjectIngestAllowed(): void {
  if (!process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY?.trim()) {
    throw new DocumentObjectConfigurationError(
      "document object encryption key is required before ingest is accepted"
    )
  }
  // A malformed key refuses the upload here (503), before anything is written.
  encryptionKey()
  const kind = resolveDocumentObjectBackendKind()
  if (kind === "fs" && !process.env.SIKANDER_DOCUMENT_OBJECT_ROOT?.trim()) {
    throw new DocumentObjectConfigurationError(
      "SIKANDER_DOCUMENT_OBJECT_ROOT is required before ingest is accepted"
    )
  }
  // Every S3 setting, not only their presence: a bad one is a 503 here, before the upload is read.
  if (kind === "s3") assertDocumentObjectS3Configuration()
}

export function validateDocumentObjectIdentity(firmId: string, docId: string): void {
  if (!SAFE_SEGMENT.test(firmId) || !SAFE_SEGMENT.test(docId)) {
    throw new Error("document object identity failed path safety validation")
  }
}

export function buildDocumentStoragePath(firmId: string, docId: string, objectVersion: number): string {
  validateDocumentObjectIdentity(firmId, docId)
  return `${activeStorageScheme()}${firmId}/documents/${docId}/v${objectVersion}`
}

function encryptPlaintext(plaintext: Buffer): Buffer {
  const key = encryptionKey()
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([OBJECT_FORMAT_VERSION]), nonce, ciphertext, tag])
}

export function decryptDocumentObjectPayload(payload: Buffer): Buffer {
  if (payload.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new Error("document object payload is truncated")
  }
  const version = payload[0]
  if (version !== OBJECT_FORMAT_VERSION) {
    throw new Error(`unsupported document object format version ${version}`)
  }
  const nonce = payload.subarray(1, 1 + NONCE_BYTES)
  const tag = payload.subarray(payload.length - TAG_BYTES)
  const ciphertext = payload.subarray(1 + NONCE_BYTES, payload.length - TAG_BYTES)
  const key = encryptionKey()
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function assertExpectedHash(
  store: SpineStore,
  firmId: string,
  bytes: Buffer,
  expectedContentHash: string
): void {
  const actual = store.hashKey(firmId, bytes)
  if (actual !== expectedContentHash) {
    throw new Error("document object integrity check failed: content hash mismatch")
  }
}

const memoryObjects = new Map<string, Buffer>()

let testHookFailNextRead = false
let testHookFailNextDelete = false

function assertDocumentObjectTestHooksAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new DocumentObjectConfigurationError(
      "document object test hooks are not available when NODE_ENV=production"
    )
  }
}

/** Test-only: force the next readPayload call to fail (FA-D16-003 verification). */
export function __testHookFailNextDocumentObjectRead(): void {
  assertDocumentObjectTestHooksAllowed()
  testHookFailNextRead = true
}

/** Test-only: force the next strict delete to fail (FA-D16-003 rollback logging). */
export function __testHookFailNextDocumentObjectDelete(): void {
  assertDocumentObjectTestHooksAllowed()
  testHookFailNextDelete = true
}

function objectRoot(): string {
  const root = process.env.SIKANDER_DOCUMENT_OBJECT_ROOT?.trim()
  if (!root) {
    throw new DocumentObjectConfigurationError("SIKANDER_DOCUMENT_OBJECT_ROOT is not set")
  }
  return path.resolve(root)
}

export function filesystemPathForStoragePath(storagePath: string): string {
  if (!storagePath.startsWith(FS_STORAGE_SCHEME)) {
    throw new Error("document storagePath must use fs:// scheme")
  }
  const relative = storagePath.slice(FS_STORAGE_SCHEME.length)
  const segments = relative.split("/").filter(Boolean)
  for (const segment of segments) {
    // SAFE_SEGMENT already admits the "v1" version segment.
    if (!SAFE_SEGMENT.test(segment)) {
      throw new Error("document object path segment failed safety validation")
    }
  }
  const root = objectRoot()
  const filePath = path.resolve(root, ...segments) + ".enc"
  const relativeToRoot = path.relative(root, filePath)
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("document object path escapes storage root")
  }
  return filePath
}

async function writePayload(storagePath: string, payload: Buffer): Promise<void> {
  const kind = resolveDocumentObjectBackendKind()
  if (kind === "memory") {
    if (memoryObjects.has(storagePath)) {
      throw new Error("document object already exists (immutable)")
    }
    memoryObjects.set(storagePath, payload)
    return
  }
  if (kind === "s3") {
    await writeS3Payload(storagePath, payload)
    return
  }
  const filePath = filesystemPathForStoragePath(storagePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, payload, { flag: "wx" })
}

async function readPayload(storagePath: string): Promise<Buffer> {
  if (testHookFailNextRead) {
    testHookFailNextRead = false
    throw new Error("forced round-trip failure")
  }
  const kind = resolveDocumentObjectBackendKind()
  if (storagePath.startsWith(S3_STORAGE_SCHEME)) {
    if (kind !== "s3") {
      throw new DocumentObjectConfigurationError(
        "document storage path uses s3:// but the active backend is not S3-compatible"
      )
    }
    return readS3Payload(storagePath)
  }
  if (process.env.NODE_ENV === "production") {
    throw new DocumentObjectConfigurationError(
      "production document object reads require s3:// storage paths"
    )
  }
  if (kind === "memory") {
    const payload = memoryObjects.get(storagePath)
    if (!payload) throw new Error(`document object not found: ${storagePath}`)
    return payload
  }
  return readFile(filesystemPathForStoragePath(storagePath))
}

async function deleteDocumentObjectStrict(storagePath: string): Promise<void> {
  const kind = resolveDocumentObjectBackendKind()
  if (storagePath.startsWith(S3_STORAGE_SCHEME)) {
    await deleteS3Payload(storagePath, { strict: true })
    return
  }
  if (process.env.NODE_ENV === "production") {
    throw new DocumentObjectConfigurationError(
      "production document object deletes require s3:// storage paths"
    )
  }
  if (kind === "memory") {
    memoryObjects.delete(storagePath)
    return
  }
  if (testHookFailNextDelete) {
    testHookFailNextDelete = false
    throw new Error("delete blocked for test")
  }
  await unlink(filesystemPathForStoragePath(storagePath))
}

export async function deleteDocumentObject(storagePath: string): Promise<void> {
  const kind = resolveDocumentObjectBackendKind()
  if (storagePath.startsWith(S3_STORAGE_SCHEME)) {
    await deleteS3Payload(storagePath)
    return
  }
  if (process.env.NODE_ENV === "production") {
    throw new DocumentObjectConfigurationError(
      "production document object deletes require s3:// storage paths"
    )
  }
  if (kind === "memory") {
    memoryObjects.delete(storagePath)
    return
  }
  try {
    await unlink(filesystemPathForStoragePath(storagePath))
  } catch {
    // best-effort rollback
  }
}

export async function putImmutableDocumentObject(
  input: DocumentObjectPutInput
): Promise<DocumentObjectPutResult> {
  const objectVersion = 1
  // buildDocumentStoragePath validates the identity (path safety) first.
  const storagePath = buildDocumentStoragePath(input.firmId, input.docId, objectVersion)
  assertExpectedHash(input.store, input.firmId, input.bytes, input.contentHash)
  const payload = encryptPlaintext(input.bytes)
  await writePayload(storagePath, payload)
  try {
    const roundTrip = decryptDocumentObjectPayload(await readPayload(storagePath))
    assertExpectedHash(input.store, input.firmId, roundTrip, input.contentHash)
    if (!roundTrip.equals(input.bytes)) {
      throw new Error("document object round-trip verification failed")
    }
  } catch (err) {
    try {
      await deleteDocumentObjectStrict(storagePath)
    } catch (deleteErr) {
      console.error("[documentObjectStore] rollback delete failed:", deleteErr)
    }
    throw err
  }
  return {
    storagePath,
    objectVersion,
    byteSize: input.bytes.length,
    mimeType: input.mimeType,
  }
}

export async function getImmutableDocumentObject(
  store: SpineStore,
  firmId: string,
  storagePath: string,
  expectedContentHash: string
): Promise<Buffer> {
  const plaintext = decryptDocumentObjectPayload(await readPayload(storagePath))
  assertExpectedHash(store, firmId, plaintext, expectedContentHash)
  return plaintext
}

export async function backupDocumentObjectFile(storagePath: string, backupFilePath: string): Promise<void> {
  const payload = await readPayload(storagePath)
  await mkdir(path.dirname(path.resolve(backupFilePath)), { recursive: true })
  await writeFile(path.resolve(backupFilePath), payload)
}

export async function restoreDocumentObjectFile(
  storagePath: string,
  backupFilePath: string
): Promise<void> {
  const kind = resolveDocumentObjectBackendKind()
  // The path rules of readPayload and the deletes, checked before the backup is read or anything is
  // written: an s3:// path needs the S3 backend; any other path is refused in production and under the
  // S3 backend, so a restore never writes ciphertext to local disk that the next read would refuse.
  if (storagePath.startsWith(S3_STORAGE_SCHEME)) {
    if (kind !== "s3") {
      throw new DocumentObjectConfigurationError(
        "document storage path uses s3:// but the active backend is not S3-compatible"
      )
    }
  } else if (process.env.NODE_ENV === "production") {
    throw new DocumentObjectConfigurationError(
      "production document object restores require s3:// storage paths"
    )
  } else if (kind === "s3") {
    throw new DocumentObjectConfigurationError(
      "document object restores under the S3 backend require s3:// storage paths"
    )
  }
  const payload = await readFile(path.resolve(backupFilePath))
  if (kind === "s3") {
    await writeS3Payload(storagePath, payload)
    return
  }
  if (kind === "memory") {
    if (memoryObjects.has(storagePath)) {
      throw new Error("document object already exists (immutable)")
    }
    memoryObjects.set(storagePath, payload)
    return
  }
  const filePath = filesystemPathForStoragePath(storagePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, payload, { flag: "wx" })
}

/**
 * Firestore collection for L9.1 session rows (`firestore:upload_sessions`).
 * Every row carries `firmId`. The path field the inventory reads is `storagePath`.
 */
export const UPLOAD_SESSIONS_COLLECTION = "upload_sessions"

/**
 * Object key prefix. A bucket lifecycle rule matches this prefix. The firm and
 * the matter are the next two segments: `upload-staging/${firmId}/${matterId}/`.
 * A loose session uses the segment `loose`, which is not a matter id.
 * One day, matching infra/backup/upload-staging-lifecycle.json. Not applied live.
 */
export const UPLOAD_STAGING_OBJECT_PREFIX = "upload-staging/"
export const UPLOAD_STAGING_LIFECYCLE_DAYS = 1
export const LOOSE_MATTER_SEGMENT = "loose"

// L9.1 upload-staging. Chunks are ciphertext in the same AES-GCM format as
// originals. The key is upload-staging/${firmId}/${matterSegment}/${sessionId}/${fileIdx}/${chunkIdx}.
// A document path is ${firmId}/documents/${docId}/vN and is never passed to these helpers.
type StagingRecord = { payload: Buffer; writtenAtMs: number }
const stagingMemory = new Map<string, StagingRecord>()

export function matterSegmentForStaging(matterId: string | null): string {
  if (matterId === null) return LOOSE_MATTER_SEGMENT
  if (!SAFE_SEGMENT.test(matterId) || matterId === LOOSE_MATTER_SEGMENT) {
    throw new Error("staging identity failed path safety validation")
  }
  return matterId
}

/** Key prefix for one matter. Loose sessions are not under a matter id. */
export function stagingMatterPrefix(firmId: string, matterId: string): string {
  if (!SAFE_SEGMENT.test(firmId)) throw new Error("staging identity failed path safety validation")
  const matter = matterSegmentForStaging(matterId)
  return `upload-staging/${firmId}/${matter}/`
}

function assertStagingPath(storagePath: string): void {
  const scheme = activeStorageScheme()
  if (!storagePath.startsWith(scheme)) {
    throw new Error("staging path failed scheme validation")
  }
  const segments = storagePath.slice(scheme.length).split("/")
  // Originals are firmId/documents/docId/vN (four segments). Staging is six,
  // and the first segment is the literal prefix, so a document path cannot match.
  if (segments.length !== 6 || segments[0] !== "upload-staging") {
    throw new Error("staging path is not under upload-staging/")
  }
  if (segments.some((segment) => !SAFE_SEGMENT.test(segment))) {
    throw new Error("staging path segment failed safety validation")
  }
}

function stagingChunkPath(
  firmId: string,
  matterId: string | null,
  sessionId: string,
  fileIdx: number,
  chunkIdx: number
): string {
  if (!SAFE_SEGMENT.test(firmId) || !SAFE_SEGMENT.test(sessionId)) {
    throw new Error("staging identity failed path safety validation")
  }
  const matter = matterSegmentForStaging(matterId)
  if (!Number.isSafeInteger(fileIdx) || fileIdx < 0 || !Number.isSafeInteger(chunkIdx) || chunkIdx < 1) {
    throw new Error("staging chunk index failed validation")
  }
  const storagePath = `${activeStorageScheme()}upload-staging/${firmId}/${matter}/${sessionId}/${fileIdx}/${chunkIdx}`
  assertStagingPath(storagePath)
  return storagePath
}

/** Session prefix stored on the upload_sessions row (`storagePath`). Not a chunk and not a document. */
export function stagingSessionStoragePath(firmId: string, matterId: string | null, sessionId: string): string {
  if (!SAFE_SEGMENT.test(firmId) || !SAFE_SEGMENT.test(sessionId)) {
    throw new Error("staging identity failed path safety validation")
  }
  const matter = matterSegmentForStaging(matterId)
  return `${activeStorageScheme()}upload-staging/${firmId}/${matter}/${sessionId}`
}

function isMissingStaging(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (code === "ENOENT") return true
  return err instanceof Error && /not found/.test(err.message)
}

async function writeStagingPayload(storagePath: string, payload: Buffer): Promise<void> {
  assertStagingPath(storagePath)
  const kind = resolveDocumentObjectBackendKind()
  if (kind === "memory") {
    if (stagingMemory.has(storagePath)) throw new Error("staging chunk already exists")
    stagingMemory.set(storagePath, { payload, writtenAtMs: Date.now() })
    return
  }
  if (kind === "s3") {
    await writeS3Payload(storagePath, payload)
    return
  }
  const filePath = filesystemPathForStoragePath(storagePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, payload, { flag: "wx" })
}

async function readStagingPayload(storagePath: string): Promise<Buffer> {
  assertStagingPath(storagePath)
  const kind = resolveDocumentObjectBackendKind()
  if (kind === "memory") {
    const record = stagingMemory.get(storagePath)
    if (!record) throw new Error(`staging chunk not found: ${storagePath}`)
    return record.payload
  }
  if (kind === "s3") return readS3Payload(storagePath)
  return readFile(filesystemPathForStoragePath(storagePath))
}

async function removeStagingPayload(storagePath: string): Promise<void> {
  assertStagingPath(storagePath)
  const kind = resolveDocumentObjectBackendKind()
  if (kind === "memory") {
    stagingMemory.delete(storagePath)
    return
  }
  if (kind === "s3") {
    await deleteS3Payload(storagePath)
    return
  }
  try {
    await unlink(filesystemPathForStoragePath(storagePath))
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err
  }
}

export async function putStagingChunk(input: {
  firmId: string
  matterId: string | null
  sessionId: string
  fileIdx: number
  chunkIdx: number
  bytes: Buffer
}): Promise<void> {
  if (!Buffer.isBuffer(input.bytes)) throw new Error("staging chunk bytes must be a buffer")
  const storagePath = stagingChunkPath(input.firmId, input.matterId, input.sessionId, input.fileIdx, input.chunkIdx)
  const payload = encryptPlaintext(input.bytes)
  await writeStagingPayload(storagePath, payload)
  try {
    const roundTrip = decryptDocumentObjectPayload(await readStagingPayload(storagePath))
    if (!roundTrip.equals(input.bytes)) throw new Error("staging chunk round-trip verification failed")
  } catch (err) {
    try {
      await removeStagingPayload(storagePath)
    } catch (deleteErr) {
      console.error("[documentObjectStore] staging rollback failed:", deleteErr)
    }
    throw err
  }
}

/** Reads `chunkCount` chunks beginning at `fromChunk` (default 1). A missing chunk is null. */
export async function readStagingChunks(input: {
  firmId: string
  matterId: string | null
  sessionId: string
  fileIdx: number
  chunkCount: number
  fromChunk?: number
}): Promise<Array<Buffer | null>> {
  const from = input.fromChunk ?? 1
  if (!Number.isSafeInteger(from) || from < 1) throw new Error("staging chunk index failed validation")
  if (!Number.isSafeInteger(input.chunkCount) || input.chunkCount < 1 || input.chunkCount > 100_000) {
    throw new Error("staging chunk count failed validation")
  }
  const out: Array<Buffer | null> = []
  for (let offset = 0; offset < input.chunkCount; offset++) {
    const storagePath = stagingChunkPath(input.firmId, input.matterId, input.sessionId, input.fileIdx, from + offset)
    try {
      out.push(decryptDocumentObjectPayload(await readStagingPayload(storagePath)))
    } catch (err) {
      if (!isMissingStaging(err)) throw err
      out.push(null)
    }
  }
  return out
}

/** Deletes the named files' staging chunks. Paths outside upload-staging are refused. */
export async function deleteStagingSession(input: {
  firmId: string
  matterId: string | null
  sessionId: string
  files: Array<{ fileIdx: number; chunkCount: number }>
}): Promise<void> {
  for (const file of input.files) {
    if (!Number.isSafeInteger(file.fileIdx) || file.fileIdx < 0) {
      throw new Error("staging chunk index failed validation")
    }
    if (!Number.isSafeInteger(file.chunkCount) || file.chunkCount < 0 || file.chunkCount > 100_000) {
      throw new Error("staging chunk count failed validation")
    }
    for (let chunkIdx = 1; chunkIdx <= file.chunkCount; chunkIdx++) {
      await removeStagingPayload(stagingChunkPath(input.firmId, input.matterId, input.sessionId, file.fileIdx, chunkIdx))
    }
  }
}

export type ListedStagingObject = { storagePath: string; key: string; writtenAtMs: number }

function keyOfStoragePath(storagePath: string): string {
  const scheme = storagePath.startsWith(S3_STORAGE_SCHEME) ? S3_STORAGE_SCHEME : FS_STORAGE_SCHEME
  return storagePath.slice(scheme.length)
}

/** Test-only: the memory backend's write time, so a sweep can see an old orphan. */
export function setStagingWrittenAtForTests(storagePath: string, writtenAtMs: number): void {
  assertDocumentObjectTestHooksAllowed()
  const record = stagingMemory.get(storagePath)
  if (!record) throw new Error("staging chunk not found")
  record.writtenAtMs = writtenAtMs
}

async function listFsStaging(keyPrefix: string): Promise<ListedStagingObject[]> {
  const root = objectRoot()
  const start = path.resolve(root, ...keyPrefix.split("/").filter(Boolean))
  const relativeToRoot = path.relative(root, start)
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("staging path is not under upload-staging/")
  }
  const out: ListedStagingObject[] = []
  const walk = async (abs: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return
      throw err
    }
    for (const entry of entries) {
      const child = path.join(abs, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".enc")) continue
      const key = path.relative(root, child).replace(/\.enc$/, "").split(path.sep).join("/")
      if (!key.startsWith(keyPrefix) || key.split("/").includes("documents")) continue
      const info = await stat(child)
      out.push({ storagePath: `${FS_STORAGE_SCHEME}${key}`, key, writtenAtMs: info.mtimeMs })
    }
  }
  await walk(start)
  return out
}

/**
 * Objects whose key starts with `keyPrefix`. The prefix must be under `upload-staging/`.
 * Age comes from the object itself (memory write time, file mtime, or S3 LastModified).
 */
export async function listStagingObjects(keyPrefix: string): Promise<ListedStagingObject[]> {
  if (!keyPrefix.startsWith(UPLOAD_STAGING_OBJECT_PREFIX) || keyPrefix.includes("..")) {
    throw new Error("staging path is not under upload-staging/")
  }
  const kind = resolveDocumentObjectBackendKind()
  if (kind === "memory") {
    const out: ListedStagingObject[] = []
    for (const [storagePath, record] of stagingMemory) {
      const key = keyOfStoragePath(storagePath)
      if (!key.startsWith(keyPrefix) || key.split("/").includes("documents")) continue
      out.push({ storagePath, key, writtenAtMs: record.writtenAtMs })
    }
    return out
  }
  if (kind === "s3") {
    const listed = await listS3Keys(keyPrefix)
    return listed
      .filter((item) => item.key.startsWith(keyPrefix) && !item.key.split("/").includes("documents"))
      .map((item) => ({ storagePath: `${S3_STORAGE_SCHEME}${item.key}`, key: item.key, writtenAtMs: item.lastModifiedMs }))
  }
  return listFsStaging(keyPrefix)
}

/** Deletes every staging object under `keyPrefix`. Refuses a prefix outside upload-staging/. */
export async function deleteStagingObjectsByPrefix(keyPrefix: string): Promise<number> {
  const listed = await listStagingObjects(keyPrefix)
  for (const item of listed) await removeStagingPayload(item.storagePath)
  return listed.length
}

/**
 * Deletes staging objects whose own age is at least `ttlMs`. Listing is the object
 * store, not a session index. Original document paths are not listed.
 */
export async function sweepExpiredStagingObjects(now: number, ttlMs: number): Promise<number> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("staging expiry failed validation")
  const listed = await listStagingObjects(UPLOAD_STAGING_OBJECT_PREFIX)
  let removed = 0
  for (const item of listed) {
    if (now - item.writtenAtMs < ttlMs) continue
    await removeStagingPayload(item.storagePath)
    removed += 1
  }
  return removed
}

export function resetDocumentObjectStoreForTests(): void {
  memoryObjects.clear()
  stagingMemory.clear()
  testHookFailNextRead = false
  testHookFailNextDelete = false
  resetDocumentObjectS3ClientForTests()
}
