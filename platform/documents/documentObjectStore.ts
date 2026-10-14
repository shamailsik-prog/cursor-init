import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SpineStore } from "@/platform/spine/store"
import {
  createFilesystemDocumentObjectBackend,
  createMemoryDocumentObjectBackend,
  filesystemObjectFile,
  resetMemoryDocumentObjects,
} from "@/platform/documents/localObjectBackends"
import {
  DocumentObjectConfigurationError,
  type DocumentObjectBackend,
  type DocumentObjectBackendKind,
  type DocumentObjectScheme,
} from "@/platform/documents/objectBackend"
import {
  createR2DocumentObjectBackend,
  type R2DocumentObjectBackendConfig,
} from "@/platform/documents/r2ObjectBackend"

export {
  DocumentObjectConfigurationError,
  DocumentObjectExistsError,
  DocumentObjectNotFoundError,
  type DocumentObjectBackend,
  type DocumentObjectBackendKind,
  type DocumentObjectScheme,
} from "@/platform/documents/objectBackend"
export {
  createFilesystemDocumentObjectBackend,
  createMemoryDocumentObjectBackend,
} from "@/platform/documents/localObjectBackends"
export {
  createR2DocumentObjectBackend,
  r2HoldBudget,
  type R2DocumentObjectBackendConfig,
  type R2HoldBudget,
} from "@/platform/documents/r2ObjectBackend"

/**
 * The encrypted document vault (F03, FA-D16-001/002/003). See README.md in this directory.
 *
 * Envelope (identical for every backend; objects are encrypted before they leave the process):
 *   [format version: 1 byte = 1][nonce: 12 bytes][AES-256-GCM ciphertext][GCM tag: 16 bytes]
 * Key: SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY, exactly 64 hex characters (32 bytes).
 *
 * storagePath: `<scheme><firmId>/documents/<docId>/v<n>`, scheme `fs://` (memory, fs) or `r2://`.
 * It never names a bucket or a directory, so a restored copy is read by repointing configuration.
 * Object key: `<firmId>/documents/<docId>/v<n>.enc`; docId is `doc_<random UUID>`, so keys are
 * firm-scoped and not guessable.
 */

const OBJECT_FORMAT_VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/
const STORAGE_PATH = /^(fs|r2):\/\/([A-Za-z0-9_-]+)\/documents\/([A-Za-z0-9_-]+)\/v([0-9]+)$/
const HEX_KEY = /^[0-9a-fA-F]{64}$/
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/
const KEY_ENV = "SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY"
const R2_REQUIRED = [
  "SIKANDER_R2_ENDPOINT",
  "SIKANDER_R2_BUCKET",
  "SIKANDER_R2_ACCESS_KEY_ID",
  "SIKANDER_R2_SECRET_ACCESS_KEY",
] as const

type Env = NodeJS.ProcessEnv

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

export type DocumentObjectStore = {
  readonly backend: DocumentObjectBackend
  /** Encrypts, writes once, reads the remote copy back and verifies it; never leaves an unverified object. */
  put(input: DocumentObjectPutInput): Promise<DocumentObjectPutResult>
  /** Reads, decrypts (GCM-authenticated) and checks the firm-scoped content hash. */
  get(store: SpineStore, firmId: string, storagePath: string, expectedContentHash: string): Promise<Buffer>
  delete(storagePath: string): Promise<void>
}

/**
 * A written object failed read-after-write verification. `objectRemoved` says whether the object
 * was deleted before this error was thrown; when it is false the caller must retry the delete
 * (uploadDocument does), because the object is still addressable at `storagePath`.
 */
export class DocumentObjectVerificationError extends Error {
  readonly storagePath: string
  readonly objectRemoved: boolean
  constructor(storagePath: string, objectRemoved: boolean, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      `document object round-trip verification failed: ${reason}` +
        (objectRemoved ? "" : "; the written object could not be removed"),
      { cause }
    )
    this.name = "DocumentObjectVerificationError"
    this.storagePath = storagePath
    this.objectRemoved = objectRemoved
  }
}

/** The storagePath of an object a failed put wrote but could not remove, if any. */
export function unremovedObjectPathOf(err: unknown): string | undefined {
  return err instanceof DocumentObjectVerificationError && !err.objectRemoved ? err.storagePath : undefined
}

// ---------------------------------------------------------------------------------------------
// Configuration (fails closed, like platform/persistence/runtimeRepositories.ts)
// ---------------------------------------------------------------------------------------------

function setting(env: Env, name: string): string {
  return env[name]?.trim() ?? ""
}

function isProduction(env: Env): boolean {
  return env.NODE_ENV === "production"
}

function isTestRunner(env: Env): boolean {
  return !isProduction(env) && (env.VITEST === "true" || env.NODE_ENV === "test")
}

/**
 * Which backend serves the vault:
 * - `r2`: always allowed when its configuration is complete (readR2DocumentObjectConfig).
 * - `fs`: refused when NODE_ENV=production (per-instance, ephemeral disk; FA-D16-001).
 * - `memory`: only under the test runner.
 * - unset: refused in production; otherwise `fs` when SIKANDER_DOCUMENT_OBJECT_ROOT is set,
 *   `memory` under the test runner, refused elsewhere (no silent in-memory default).
 */
export function documentObjectBackendKind(env: Env = process.env): DocumentObjectBackendKind {
  const raw = setting(env, "SIKANDER_DOCUMENT_OBJECT_BACKEND")
  const requested = raw.toLowerCase()
  if (requested === "r2") return "r2"
  if (requested === "fs") {
    if (isProduction(env)) {
      throw new DocumentObjectConfigurationError(
        "SIKANDER_DOCUMENT_OBJECT_BACKEND=fs stores documents on the instance's local disk, which is " +
          "per-instance and ephemeral; it is refused when NODE_ENV=production. Use " +
          "SIKANDER_DOCUMENT_OBJECT_BACKEND=r2."
      )
    }
    return "fs"
  }
  if (requested === "memory") {
    if (!isTestRunner(env)) {
      throw new DocumentObjectConfigurationError(
        "SIKANDER_DOCUMENT_OBJECT_BACKEND=memory is non-durable and allowed only under the test runner"
      )
    }
    return "memory"
  }
  if (requested !== "") {
    throw new DocumentObjectConfigurationError(
      `Unknown SIKANDER_DOCUMENT_OBJECT_BACKEND "${raw}"; expected "r2", "fs" or "memory".`
    )
  }
  if (isProduction(env)) {
    throw new DocumentObjectConfigurationError(
      "No document object backend is configured. NODE_ENV=production requires " +
        "SIKANDER_DOCUMENT_OBJECT_BACKEND=r2 with the SIKANDER_R2_* credentials; the fs:// backend " +
        "(SIKANDER_DOCUMENT_OBJECT_ROOT) is per-instance, ephemeral disk and is refused in production."
    )
  }
  if (setting(env, "SIKANDER_DOCUMENT_OBJECT_ROOT")) return "fs"
  if (isTestRunner(env)) return "memory"
  throw new DocumentObjectConfigurationError(
    "SIKANDER_DOCUMENT_OBJECT_ROOT is required before ingest is accepted (or set " +
      "SIKANDER_DOCUMENT_OBJECT_BACKEND=r2); there is no silent in-memory document store " +
      "outside the test runner."
  )
}

const INVALID_ENDPOINT = "SIKANDER_R2_ENDPOINT must be an http(s) URL with no path, query or credentials"

function normalizedEndpoint(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DocumentObjectConfigurationError(INVALID_ENDPOINT)
  }
  const httpLike = url.protocol === "https:" || url.protocol === "http:"
  const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password
  if (!httpLike || !bare) throw new DocumentObjectConfigurationError(INVALID_ENDPOINT)
  return `${url.protocol}//${url.host}`
}

/** R2 settings from the environment; every missing variable is named, no value is echoed. */
export function readR2DocumentObjectConfig(env: Env = process.env): R2DocumentObjectBackendConfig {
  const missing = R2_REQUIRED.filter((name) => !setting(env, name))
  if (missing.length > 0) {
    throw new DocumentObjectConfigurationError(
      `SIKANDER_DOCUMENT_OBJECT_BACKEND=r2 requires ${missing.join(", ")}`
    )
  }
  // Re-audit R1-D1: every value ends up in a URL or a signed header. A CR/LF, space or control
  // character would make the signer fail with the Authorization header quoted in its error, so
  // refuse it here, naming the variable and never echoing the value.
  for (const name of [...R2_REQUIRED, "SIKANDER_R2_REGION"]) {
    const value = setting(env, name)
    if (value && !PRINTABLE_ASCII.test(value)) {
      throw new DocumentObjectConfigurationError(
        `${name} must be printable ASCII with no spaces or control characters`
      )
    }
  }
  const endpoint = normalizedEndpoint(setting(env, "SIKANDER_R2_ENDPOINT"))
  if (isProduction(env) && !endpoint.startsWith("https://")) {
    throw new DocumentObjectConfigurationError("SIKANDER_R2_ENDPOINT must use https when NODE_ENV=production")
  }
  const bucket = setting(env, "SIKANDER_R2_BUCKET")
  if (!BUCKET_NAME.test(bucket)) {
    throw new DocumentObjectConfigurationError("SIKANDER_R2_BUCKET is not a valid bucket name")
  }
  return {
    endpoint,
    bucket,
    accessKeyId: setting(env, "SIKANDER_R2_ACCESS_KEY_ID"),
    secretAccessKey: setting(env, "SIKANDER_R2_SECRET_ACCESS_KEY"),
    region: setting(env, "SIKANDER_R2_REGION") || "auto",
  }
}

let backendForTests: DocumentObjectBackend | null = null

/** Test seam (like setFirestorePersistenceForTests): route every vault call to `backend`. */
export function setDocumentObjectBackendForTests(backend: DocumentObjectBackend | null): void {
  backendForTests = backend
}

/** The backend this process is configured for; throws DocumentObjectConfigurationError otherwise. */
export function configuredDocumentObjectBackend(env: Env = process.env): DocumentObjectBackend {
  if (backendForTests) return backendForTests
  const kind = documentObjectBackendKind(env)
  if (kind === "r2") return createR2DocumentObjectBackend(readR2DocumentObjectConfig(env))
  if (kind === "memory") return createMemoryDocumentObjectBackend()
  const root = setting(env, "SIKANDER_DOCUMENT_OBJECT_ROOT")
  if (!root) {
    throw new DocumentObjectConfigurationError(
      "SIKANDER_DOCUMENT_OBJECT_BACKEND=fs requires SIKANDER_DOCUMENT_OBJECT_ROOT"
    )
  }
  return createFilesystemDocumentObjectBackend(root)
}

function encryptionKey(env: Env = process.env): Buffer {
  const raw = setting(env, KEY_ENV)
  if (!raw) throw new DocumentObjectConfigurationError(`${KEY_ENV} is not set`)
  if (!HEX_KEY.test(raw)) {
    throw new DocumentObjectConfigurationError(`${KEY_ENV} must be 64 hex characters (32 bytes)`)
  }
  const key = Buffer.from(raw, "hex")
  // Re-audit INFO 8: an all-zero (or any single repeated byte) key is a placeholder, not a secret.
  if (key.every((byte) => byte === key[0])) {
    throw new DocumentObjectConfigurationError(
      `${KEY_ENV} is one byte repeated (for example all zeros), not a random key; generate one with: openssl rand -hex 32`
    )
  }
  return key
}

/** Called before an upload is accepted: a valid key and a usable backend, or 503. */
export function assertDocumentObjectIngestAllowed(env: Env = process.env): void {
  if (!setting(env, KEY_ENV)) {
    throw new DocumentObjectConfigurationError(
      "document object encryption key is required before ingest is accepted"
    )
  }
  encryptionKey(env)
  configuredDocumentObjectBackend(env)
}

// ---------------------------------------------------------------------------------------------
// Paths and keys
// ---------------------------------------------------------------------------------------------

export function validateDocumentObjectIdentity(firmId: string, docId: string): void {
  if (!SAFE_SEGMENT.test(firmId) || !SAFE_SEGMENT.test(docId)) {
    throw new Error("document object identity failed path safety validation")
  }
}

function objectKey(firmId: string, docId: string, objectVersion: number): string {
  return `${firmId}/documents/${docId}/v${objectVersion}.enc`
}

export function buildDocumentStoragePath(
  firmId: string,
  docId: string,
  objectVersion: number,
  scheme: DocumentObjectScheme = configuredDocumentObjectBackend().scheme
): string {
  validateDocumentObjectIdentity(firmId, docId)
  return `${scheme}${firmId}/documents/${docId}/v${objectVersion}`
}

export type ParsedDocumentStoragePath = {
  scheme: DocumentObjectScheme
  firmId: string
  docId: string
  objectVersion: number
  key: string
}

export function parseDocumentStoragePath(storagePath: string): ParsedDocumentStoragePath {
  const match = STORAGE_PATH.exec(storagePath)
  if (!match) throw new Error("document storagePath is malformed")
  const [, scheme, firmId, docId, version] = match
  const objectVersion = Number(version)
  return {
    scheme: `${scheme}://` as DocumentObjectScheme,
    firmId,
    docId,
    objectVersion,
    key: objectKey(firmId, docId, objectVersion),
  }
}

function keyOn(backend: DocumentObjectBackend, storagePath: string): ParsedDocumentStoragePath {
  const parsed = parseDocumentStoragePath(storagePath)
  if (parsed.scheme !== backend.scheme) {
    throw new DocumentObjectConfigurationError(
      `document storagePath scheme ${parsed.scheme} does not match the configured document object ` +
        `backend (${backend.scheme})`
    )
  }
  return parsed
}

/** The local file behind an fs:// storagePath (fs backend; tests and operator tooling). */
export function filesystemPathForStoragePath(storagePath: string): string {
  const parsed = parseDocumentStoragePath(storagePath)
  if (parsed.scheme !== "fs://") throw new Error("document storagePath must use fs:// scheme")
  const root = setting(process.env, "SIKANDER_DOCUMENT_OBJECT_ROOT")
  if (!root) throw new DocumentObjectConfigurationError("SIKANDER_DOCUMENT_OBJECT_ROOT is not set")
  return filesystemObjectFile(root, parsed.key)
}

// ---------------------------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------------------------

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
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function assertExpectedHash(
  store: SpineStore,
  firmId: string,
  bytes: Buffer,
  expectedContentHash: string
): void {
  if (store.hashKey(firmId, bytes) !== expectedContentHash) {
    throw new Error("document object integrity check failed: content hash mismatch")
  }
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

async function discardUnverified(
  backend: DocumentObjectBackend,
  key: string,
  storagePath: string,
  cause: unknown
): Promise<DocumentObjectVerificationError> {
  try {
    await backend.delete(key)
    return new DocumentObjectVerificationError(storagePath, true, cause)
  } catch (deleteError) {
    console.error(`[documents] could not remove unverified object ${storagePath}:`, deleteError)
    return new DocumentObjectVerificationError(storagePath, false, cause)
  }
}

export function createDocumentObjectStore(backend: DocumentObjectBackend): DocumentObjectStore {
  return {
    backend,
    async put(input) {
      const objectVersion = 1
      // Validates firmId and docId (path-safe segments) before anything else happens.
      const storagePath = buildDocumentStoragePath(input.firmId, input.docId, objectVersion, backend.scheme)
      const key = objectKey(input.firmId, input.docId, objectVersion)
      assertExpectedHash(input.store, input.firmId, input.bytes, input.contentHash)
      await backend.putIfAbsent(key, encryptPlaintext(input.bytes))
      // FA-D16-003: from here on the object exists; any verification failure removes it before
      // the error propagates (or reports that it could not, so the caller can retry).
      try {
        const roundTrip = decryptPayload(await backend.get(key))
        assertExpectedHash(input.store, input.firmId, roundTrip, input.contentHash)
        if (!roundTrip.equals(input.bytes)) throw new Error("document object round-trip bytes differ")
      } catch (cause) {
        throw await discardUnverified(backend, key, storagePath, cause)
      }
      return {
        storagePath,
        objectVersion,
        byteSize: input.bytes.length,
        mimeType: input.mimeType,
      }
    },
    async get(store, firmId, storagePath, expectedContentHash) {
      const parsed = keyOn(backend, storagePath)
      if (parsed.firmId !== firmId) {
        throw new Error(`document storagePath does not belong to firm ${firmId}`)
      }
      const plaintext = decryptPayload(await backend.get(parsed.key))
      assertExpectedHash(store, firmId, plaintext, expectedContentHash)
      return plaintext
    },
    async delete(storagePath) {
      await backend.delete(keyOn(backend, storagePath).key)
    },
  }
}

function configuredStore(): DocumentObjectStore {
  return createDocumentObjectStore(configuredDocumentObjectBackend())
}

export async function putImmutableDocumentObject(
  input: DocumentObjectPutInput
): Promise<DocumentObjectPutResult> {
  return configuredStore().put(input)
}

export async function getImmutableDocumentObject(
  store: SpineStore,
  firmId: string,
  storagePath: string,
  expectedContentHash: string
): Promise<Buffer> {
  return configuredStore().get(store, firmId, storagePath, expectedContentHash)
}

/** Best-effort removal used by ingest rollback; a failure is logged, not thrown. */
export async function deleteDocumentObject(storagePath: string): Promise<void> {
  try {
    await configuredStore().delete(storagePath)
  } catch (err) {
    console.error(`[documents] best-effort delete of ${storagePath} failed:`, err)
  }
}

/** Copies the stored (encrypted) object to a local file. */
export async function backupDocumentObjectFile(storagePath: string, backupFilePath: string): Promise<void> {
  const backend = configuredDocumentObjectBackend()
  const payload = await backend.get(keyOn(backend, storagePath).key)
  const target = path.resolve(backupFilePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, payload)
}

/** Puts a backed-up (encrypted) object back; refuses if the key already exists. */
export async function restoreDocumentObjectFile(storagePath: string, backupFilePath: string): Promise<void> {
  const backend = configuredDocumentObjectBackend()
  const payload = await readFile(path.resolve(backupFilePath))
  await backend.putIfAbsent(keyOn(backend, storagePath).key, payload)
}

export function resetDocumentObjectStoreForTests(): void {
  resetMemoryDocumentObjects()
}
