import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SpineStore } from "@/platform/spine/store"
import {
  deleteS3Payload,
  isDocumentObjectS3Configured,
  readS3Payload,
  resetDocumentObjectS3ClientForTests,
  writeS3Payload,
} from "@/platform/documents/documentObjectS3"
import { DocumentObjectConfigurationError } from "@/platform/documents/documentObjectStoreTypes"

export { DocumentObjectConfigurationError }

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

function assertProductionObjectBackend(kind: DocumentObjectBackendKind): void {
  if (process.env.NODE_ENV !== "production") return
  if (kind !== "s3") {
    throw new DocumentObjectConfigurationError(
      "production requires S3-compatible document object storage (R2); fs and memory backends are forbidden"
    )
  }
  if (!isDocumentObjectS3Configured()) {
    throw new DocumentObjectConfigurationError(
      "production requires S3-compatible document object storage (configure Cloudflare R2 / S3 env vars)"
    )
  }
}

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

function encryptionKey(): Buffer {
  const raw = process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY?.trim()
  if (!raw) {
    throw new DocumentObjectConfigurationError("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY is not set")
  }
  const key = Buffer.from(raw, "hex")
  if (key.length !== 32) {
    throw new DocumentObjectConfigurationError(
      "SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"
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
  const kind = resolveDocumentObjectBackendKind()
  if (process.env.NODE_ENV === "production" && kind !== "s3") {
    throw new DocumentObjectConfigurationError(
      "production requires S3-compatible document object storage (R2); local filesystem backend is not allowed"
    )
  }
  if (kind === "fs" && !process.env.SIKANDER_DOCUMENT_OBJECT_ROOT?.trim()) {
    throw new DocumentObjectConfigurationError(
      "SIKANDER_DOCUMENT_OBJECT_ROOT is required before ingest is accepted"
    )
  }
  if (kind === "s3" && !isDocumentObjectS3Configured()) {
    throw new DocumentObjectConfigurationError(
      "S3-compatible document storage is not fully configured"
    )
  }
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

/** Test-only: force the next readPayload call to fail (FA-D16-003 verification). */
export function __testHookFailNextDocumentObjectRead(): void {
  testHookFailNextRead = true
}

/** Test-only: force the next strict delete to fail (FA-D16-003 rollback logging). */
export function __testHookFailNextDocumentObjectDelete(): void {
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
    if (!SAFE_SEGMENT.test(segment) && !/^v[0-9]+$/.test(segment)) {
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
  assertProductionObjectBackend(kind)
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
  assertProductionObjectBackend(kind)
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
  assertProductionObjectBackend(kind)
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
  assertProductionObjectBackend(kind)
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
  validateDocumentObjectIdentity(input.firmId, input.docId)
  const objectVersion = 1
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
  resolveDocumentObjectBackendKind()
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
  assertProductionObjectBackend(kind)
  const payload = await readFile(path.resolve(backupFilePath))
  if (kind === "memory") {
    if (memoryObjects.has(storagePath)) {
      throw new Error("document object already exists (immutable)")
    }
    memoryObjects.set(storagePath, payload)
    return
  }
  if (storagePath.startsWith(S3_STORAGE_SCHEME)) {
    await writeS3Payload(storagePath, payload)
    return
  }
  const filePath = filesystemPathForStoragePath(storagePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, payload, { flag: "wx" })
}

export function resetDocumentObjectStoreForTests(): void {
  memoryObjects.clear()
  testHookFailNextRead = false
  testHookFailNextDelete = false
  resetDocumentObjectS3ClientForTests()
}
