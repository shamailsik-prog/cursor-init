import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const OBJECT_FORMAT_VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16

export type DocumentObjectPutInput = {
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

function encryptionKey(): Buffer {
  const raw = process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY?.trim()
  if (!raw) {
    throw new Error("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY is not set")
  }
  const key = Buffer.from(raw, "hex")
  if (key.length !== 32) {
    throw new Error("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY must be 64 hex characters (32 bytes)")
  }
  return key
}

export function buildDocumentStoragePath(firmId: string, docId: string, objectVersion: number): string {
  return `r2://${firmId}/documents/${docId}/v${objectVersion}`
}

function encryptPlaintext(plaintext: Buffer): Buffer {
  const key = encryptionKey()
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([
    Buffer.from([OBJECT_FORMAT_VERSION]),
    nonce,
    ciphertext,
    tag,
  ])
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

function digestFor(firmId: string, bytes: Buffer): string {
  return createHash("sha256").update(firmId).update(bytes).digest("hex")
}

function assertExpectedHash(firmId: string, bytes: Buffer, expectedContentHash: string): void {
  const actual = digestFor(firmId, bytes)
  if (actual !== expectedContentHash) {
    throw new Error("document object integrity check failed: content hash mismatch")
  }
}

const memoryObjects = new Map<string, Buffer>()

function useMemoryBackend(): boolean {
  if (process.env.SIKANDER_DOCUMENT_OBJECT_ROOT?.trim()) return false
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test"
}

function objectRoot(): string {
  const root = process.env.SIKANDER_DOCUMENT_OBJECT_ROOT?.trim()
  if (!root) {
    throw new Error("SIKANDER_DOCUMENT_OBJECT_ROOT is not set")
  }
  return root
}

function filesystemPathFor(storagePath: string): string {
  const withoutScheme = storagePath.replace(/^r2:\/\//, "")
  return path.join(objectRoot(), withoutScheme + ".enc")
}

async function writePayload(storagePath: string, payload: Buffer): Promise<void> {
  if (useMemoryBackend()) {
    memoryObjects.set(storagePath, payload)
    return
  }
  const filePath = filesystemPathFor(storagePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, payload)
}

async function readPayload(storagePath: string): Promise<Buffer> {
  if (useMemoryBackend()) {
    const payload = memoryObjects.get(storagePath)
    if (!payload) throw new Error(`document object not found: ${storagePath}`)
    return payload
  }
  return readFile(filesystemPathFor(storagePath))
}

export async function putImmutableDocumentObject(
  input: DocumentObjectPutInput
): Promise<DocumentObjectPutResult> {
  const objectVersion = 1
  const storagePath = buildDocumentStoragePath(input.firmId, input.docId, objectVersion)
  assertExpectedHash(input.firmId, input.bytes, input.contentHash)
  const payload = encryptPlaintext(input.bytes)
  await writePayload(storagePath, payload)
  const roundTrip = decryptPayload(await readPayload(storagePath))
  assertExpectedHash(input.firmId, roundTrip, input.contentHash)
  if (!roundTrip.equals(input.bytes)) {
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
  firmId: string,
  storagePath: string,
  expectedContentHash: string
): Promise<Buffer> {
  const plaintext = decryptPayload(await readPayload(storagePath))
  assertExpectedHash(firmId, plaintext, expectedContentHash)
  return plaintext
}

export function resetDocumentObjectStoreForTests(): void {
  memoryObjects.clear()
}
