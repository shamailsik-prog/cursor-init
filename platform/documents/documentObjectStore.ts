import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SpineStore } from "@/platform/spine/store"

const OBJECT_FORMAT_VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16
const STORAGE_SCHEME = "fs://"
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

export class DocumentObjectConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DocumentObjectConfigurationError"
  }
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
  if (process.env.NODE_ENV !== "production") return
  if (!process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY?.trim()) {
    throw new DocumentObjectConfigurationError(
      "document object encryption key is required in production before ingest is accepted"
    )
  }
  if (!process.env.SIKANDER_DOCUMENT_OBJECT_ROOT?.trim()) {
    throw new DocumentObjectConfigurationError(
      "SIKANDER_DOCUMENT_OBJECT_ROOT is required in production before ingest is accepted"
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
  return `${STORAGE_SCHEME}${firmId}/documents/${docId}/v${objectVersion}`
}

function encryptPlaintext(plaintext: Buffer): Buffer {
  const key = encryptionKey()
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([OBJECT_FORMAT_VERSION]), nonce, ciphertext, tag])
}

function decryptPayload(payload: Buffer): Buffer {
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

function useMemoryBackend(): boolean {
  if (process.env.SIKANDER_DOCUMENT_OBJECT_ROOT?.trim()) return false
  if (process.env.NODE_ENV === "production") return false
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test"
}

function objectRoot(): string {
  const root = process.env.SIKANDER_DOCUMENT_OBJECT_ROOT?.trim()
  if (!root) {
    throw new DocumentObjectConfigurationError("SIKANDER_DOCUMENT_OBJECT_ROOT is not set")
  }
  return path.resolve(root)
}

export function filesystemPathForStoragePath(storagePath: string): string {
  if (!storagePath.startsWith(STORAGE_SCHEME)) {
    throw new Error("document storagePath must use fs:// scheme")
  }
  const relative = storagePath.slice(STORAGE_SCHEME.length)
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
  if (useMemoryBackend()) {
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

async function readPayload(storagePath: string): Promise<Buffer> {
  if (useMemoryBackend()) {
    const payload = memoryObjects.get(storagePath)
    if (!payload) throw new Error(`document object not found: ${storagePath}`)
    return payload
  }
  return readFile(filesystemPathForStoragePath(storagePath))
}

export async function deleteDocumentObject(storagePath: string): Promise<void> {
  if (useMemoryBackend()) {
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
  const roundTrip = decryptPayload(await readPayload(storagePath))
  assertExpectedHash(input.store, input.firmId, roundTrip, input.contentHash)
  if (!roundTrip.equals(input.bytes)) {
    await deleteDocumentObject(storagePath)
    throw new Error("document object round-trip verification failed")
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
  const plaintext = decryptPayload(await readPayload(storagePath))
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
  const payload = await readFile(path.resolve(backupFilePath))
  if (useMemoryBackend()) {
    memoryObjects.set(storagePath, payload)
    return
  }
  const filePath = filesystemPathForStoragePath(storagePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, payload, { flag: "wx" })
}

export function resetDocumentObjectStoreForTests(): void {
  memoryObjects.clear()
}
