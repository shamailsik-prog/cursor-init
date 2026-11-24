import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  deleteS3Payload,
  listS3Keys,
  readS3Payload,
  writeS3Payload,
} from "@/platform/documents/documentObjectS3"
import {
  FS_STORAGE_SCHEME,
  S3_STORAGE_SCHEME,
  activeStorageScheme,
  assertDocumentObjectTestHooksAllowed,
  decryptDocumentObjectPayload,
  encryptPlaintext,
  filesystemPathForStoragePath,
  objectRoot,
  resolveDocumentObjectBackendKind,
} from "@/platform/documents/documentObjectStore"
import { DocumentObjectStoreError } from "@/platform/documents/documentObjectStoreTypes"

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/

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

/**
 * Firestore allows 500 writes in one batch or transaction. Session deletes stay under that.
 */
export const STAGING_FIRESTORE_WRITE_LIMIT = 450

/** A DeleteObject is gone only on 204 (deleted) or 404 (already absent). 403 is not gone. */
export function stagingDeleteCountsAsGone(status: number | null): boolean {
  return status === 204 || status === 404
}

export function chunkFirestoreWrites<T>(items: readonly T[], size = STAGING_FIRESTORE_WRITE_LIMIT): T[][] {
  if (!Number.isSafeInteger(size) || size < 1 || size > 500) {
    throw new Error("firestore batch failed validation")
  }
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}

type DeleteStatusProbe = (storagePath: string) => Promise<number>
let deleteStatusProbe: DeleteStatusProbe | null = null

/** Test-only: the HTTP status the next staging delete observes, in place of a live bucket. */
export function setStagingDeleteStatusForTests(probe: DeleteStatusProbe | null): void {
  assertDocumentObjectTestHooksAllowed()
  deleteStatusProbe = probe
}

/**
 * Staging chunks use the document-object bucket. In production that bucket is the vault,
 * and `applyVaultProtection` sets COMPLIANCE retention on the whole bucket. The one-day
 * staging lifecycle is not applied, so an S3 backend cannot honestly ack a purge.
 */
export function stagingSharesLockedVaultBucket(): boolean {
  return resolveDocumentObjectBackendKind() === "s3"
}

/**
 * What a matter deletion may do to staging while the live backend is known.
 * On S3 the chunks share the locked vault bucket, so neither the bytes nor the
 * `upload_sessions` rows are deleted, and the acknowledgement is `retained`.
 */
export function liveStagingMatterDeletion(): {
  sharesLock: boolean
  deleteBytes: boolean
  deleteSessionRows: boolean
  ack: ReturnType<typeof stagingDeletionAck>
} {
  const sharesLock = stagingSharesLockedVaultBucket()
  return {
    sharesLock,
    deleteBytes: !sharesLock,
    deleteSessionRows: !sharesLock,
    ack: stagingDeletionAck(sharesLock),
  }
}

export function stagingDeletionAck(sharesLockedVault: boolean): {
  outcome: "retained" | "purged"
  detail: { reason: string; locked: boolean; prefix: string; matterScoped: true }
} {
  if (sharesLockedVault) {
    return {
      outcome: "retained",
      detail: { reason: "locked_vault_bucket", locked: true, prefix: UPLOAD_STAGING_OBJECT_PREFIX, matterScoped: true },
    }
  }
  return {
    outcome: "purged",
    detail: { reason: "prefix_empty", locked: false, prefix: UPLOAD_STAGING_OBJECT_PREFIX, matterScoped: true },
  }
}

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
  if (deleteStatusProbe) {
    const status = await deleteStatusProbe(storagePath)
    if (!stagingDeleteCountsAsGone(status)) {
      throw new DocumentObjectStoreError("delete", "http", status, null, `staging delete refused: HTTP ${status}`)
    }
    stagingMemory.delete(storagePath)
    return
  }
  const kind = resolveDocumentObjectBackendKind()
  if (kind === "memory") {
    stagingMemory.delete(storagePath)
    return
  }
  if (kind === "s3") {
    // A completed strict DeleteObject is HTTP 204. A thrown 404 is already gone.
    // Every other status, including 403 from the vault lock, is still there.
    try {
      await deleteS3Payload(storagePath, { strict: true })
    } catch (err) {
      if (err instanceof DocumentObjectStoreError && stagingDeleteCountsAsGone(err.httpStatus)) return
      throw err
    }
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
      if (!key.startsWith(keyPrefix)) continue
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
      if (!key.startsWith(keyPrefix)) continue
      out.push({ storagePath, key, writtenAtMs: record.writtenAtMs })
    }
    return out
  }
  if (kind === "s3") {
    const listed = await listS3Keys(keyPrefix)
    return listed
      .filter((item) => item.key.startsWith(keyPrefix))
      .map((item) => ({ storagePath: `${S3_STORAGE_SCHEME}${item.key}`, key: item.key, writtenAtMs: item.lastModifiedMs }))
  }
  return listFsStaging(keyPrefix)
}

/**
 * Deletes every staging object under `keyPrefix`. A delete counts only when the
 * object is gone (204 or 404). The prefix is listed again and must be empty.
 */
export async function deleteStagingObjectsByPrefix(keyPrefix: string): Promise<number> {
  const listed = await listStagingObjects(keyPrefix)
  for (const item of listed) await removeStagingPayload(item.storagePath)
  const left = await listStagingObjects(keyPrefix)
  if (left.length > 0) throw new Error("staging prefix is not empty")
  return listed.length
}

/**
 * Deletes staging objects whose own age is at least `ttlMs`. Listing is the object
 * store, not a session index. Original document paths are not listed.
 */
export async function sweepExpiredStagingObjects(
  now: number,
  ttlMs: number,
  keyPrefix: string = UPLOAD_STAGING_OBJECT_PREFIX
): Promise<{ removed: number; failures: string[] }> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("staging expiry failed validation")
  const listed = await listStagingObjects(keyPrefix)
  let removed = 0
  const failures: string[] = []
  for (const item of listed) {
    if (now - item.writtenAtMs < ttlMs) continue
    try {
      await removeStagingPayload(item.storagePath)
      removed += 1
    } catch (err) {
      failures.push(err instanceof Error ? err.message : "staging delete failed")
    }
  }
  return { removed, failures }
}

export function resetUploadStagingForTests(): void {
  stagingMemory.clear()
  deleteStatusProbe = null
}
