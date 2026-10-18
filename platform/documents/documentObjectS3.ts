import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3"
import {
  DocumentObjectConfigurationError,
  DocumentObjectStoreError,
  type DocumentObjectStoreOperation,
} from "@/platform/documents/documentObjectStoreTypes"
import { DEFAULT_MAX_UPLOAD_BYTES, maxUploadBytes } from "@/platform/http/validation"

/*
 * S3-compatible document vault (Cloudflare R2 in production, MinIO in CI). Audit F03, FA-D16-001.
 *
 * Time budget. Every call below carries its own abort deadline (the request timeout), and the
 * settle reads after an ambiguous PUT share one total budget measured with performance.now(). One
 * ingest through app/api/d1/documents makes at most DOCUMENT_OBJECT_S3_MAX_CALLS_PER_INGEST calls
 * plus the settle reads: a GET of an existing copy, the PUT, the verify GET, the rollback DELETE in
 * the store and the route's DELETE when persisting the row fails. So a hanging endpoint holds an
 * upload for at most DOCUMENT_OBJECT_S3_WORST_CASE_MS, and the route's maxDuration is set above it.
 */
export const DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_DEFAULT_MS = 5_000
export const DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_MIN_MS = 50
export const DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_MAX_MS = 8_000
export const DOCUMENT_OBJECT_S3_SETTLE_BUDGET_DEFAULT_MS = 10_000
export const DOCUMENT_OBJECT_S3_SETTLE_BUDGET_MAX_MS = 12_000
export const DOCUMENT_OBJECT_S3_SETTLE_POLL_MS = 250
export const DOCUMENT_OBJECT_S3_MAX_CALLS_PER_INGEST = 5
export const DOCUMENT_OBJECT_S3_WORST_CASE_MS =
  DOCUMENT_OBJECT_S3_MAX_CALLS_PER_INGEST * DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_MAX_MS +
  DOCUMENT_OBJECT_S3_SETTLE_BUDGET_MAX_MS

/** Version byte, nonce and GCM tag wrap every stored object (documentObjectStore.ts). */
const PAYLOAD_OVERHEAD_BYTES = 1 + 12 + 16

/** Printable ASCII without spaces: no CR/LF or other byte can reach a signed header. */
const PRINTABLE_SETTING = /^[\x21-\x7e]+$/
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const REGION_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
/** Only a code of this shape from the endpoint is echoed; anything else is dropped. */
const WELL_FORMED_S3_CODE = /^[A-Z][A-Za-z]{2,63}$/
/** Node's own socket error codes (ECONNREFUSED, ECONNRESET, ...). */
const NODE_ERROR_CODE = /^E[A-Z0-9_]{2,31}$/

const ENDPOINT_ENV = "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT"
const BUCKET_ENV = "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET"
const ACCESS_KEY_ENV = "SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID"
const SECRET_KEY_ENV = "SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY"
const REGION_ENV = "SIKANDER_DOCUMENT_OBJECT_S3_REGION"
const TIMEOUT_ENV = "SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS"
const SETTLE_ENV = "SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS"

let cachedClient: S3Client | undefined
let cachedSseMode: "none" | "AES256" | undefined

export function resetDocumentObjectS3ClientForTests(): void {
  cachedClient?.destroy()
  cachedClient = undefined
  cachedSseMode = undefined
}

export type DocumentObjectS3SseMode = "none" | "AES256"

/** Resolved PutObject SSE mode; R2 backend always uses `none`. */
export function resolveDocumentObjectS3SseMode(): DocumentObjectS3SseMode {
  if (cachedSseMode !== undefined) return cachedSseMode
  const backend = process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND?.trim().toLowerCase()
  if (backend === "r2") {
    cachedSseMode = "none"
    return cachedSseMode
  }
  const raw = process.env.SIKANDER_DOCUMENT_OBJECT_S3_SSE?.trim()
  if (!raw) {
    cachedSseMode = "none"
    return cachedSseMode
  }
  if (raw === "none") {
    cachedSseMode = "none"
    return cachedSseMode
  }
  if (raw === "AES256") {
    cachedSseMode = "AES256"
    return cachedSseMode
  }
  throw new DocumentObjectConfigurationError(
    "unsupported SIKANDER_DOCUMENT_OBJECT_S3_SSE value (expected none or AES256)"
  )
}

export type DocumentObjectS3Config = {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  forcePathStyle: boolean
}

/** A setting's trimmed value, or null when unset. The value never appears in an error message. */
function setting(name: string): string | null {
  const value = process.env[name]?.trim()
  if (!value) return null
  if (!PRINTABLE_SETTING.test(value)) {
    throw new DocumentObjectConfigurationError(
      `${name} must be printable ASCII without spaces or line breaks`
    )
  }
  return value
}

function validatedEndpoint(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DocumentObjectConfigurationError(`${ENDPOINT_ENV} must be an absolute http(s) URL`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DocumentObjectConfigurationError(`${ENDPOINT_ENV} must be an absolute http(s) URL`)
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new DocumentObjectConfigurationError(
      `${ENDPOINT_ENV} must be a bare origin (no credentials, path, query or fragment)`
    )
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new DocumentObjectConfigurationError(`${ENDPOINT_ENV} must use https in production`)
  }
  return url.origin
}

export function s3ConfigFromEnv(): DocumentObjectS3Config {
  const endpoint = setting(ENDPOINT_ENV)
  const bucket = setting(BUCKET_ENV)
  const accessKeyId = setting(ACCESS_KEY_ENV)
  const secretAccessKey = setting(SECRET_KEY_ENV)
  const region = setting(REGION_ENV) ?? "auto"
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new DocumentObjectConfigurationError(
      `S3-compatible document storage requires ${ENDPOINT_ENV}, ${BUCKET_ENV}, ${ACCESS_KEY_ENV} and ${SECRET_KEY_ENV}`
    )
  }
  if (!BUCKET_NAME.test(bucket)) {
    throw new DocumentObjectConfigurationError(`${BUCKET_ENV} is not a valid bucket name`)
  }
  if (!REGION_NAME.test(region)) {
    throw new DocumentObjectConfigurationError(`${REGION_ENV} is not a valid region name`)
  }
  const pathStyle = process.env.SIKANDER_DOCUMENT_OBJECT_S3_FORCE_PATH_STYLE?.trim().toLowerCase()
  return {
    endpoint: validatedEndpoint(endpoint),
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
    forcePathStyle: pathStyle === "1" || pathStyle === "true",
  }
}

export function isDocumentObjectS3Configured(): boolean {
  return Boolean(
    process.env[ENDPOINT_ENV]?.trim() &&
      process.env[BUCKET_ENV]?.trim() &&
      process.env[ACCESS_KEY_ENV]?.trim() &&
      process.env[SECRET_KEY_ENV]?.trim()
  )
}

function boundedIntegerSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = /^[0-9]{1,6}$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DocumentObjectConfigurationError(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

export function documentObjectS3RequestTimeoutMs(): number {
  return boundedIntegerSetting(
    TIMEOUT_ENV,
    DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_DEFAULT_MS,
    DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_MIN_MS,
    DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_MAX_MS
  )
}

export function documentObjectS3SettleBudgetMs(): number {
  return boundedIntegerSetting(
    SETTLE_ENV,
    DOCUMENT_OBJECT_S3_SETTLE_BUDGET_DEFAULT_MS,
    0,
    DOCUMENT_OBJECT_S3_SETTLE_BUDGET_MAX_MS
  )
}

/** Validates every S3 setting (the route answers 503 before reading the upload when one is bad). */
export function assertDocumentObjectS3Configuration(): void {
  s3ConfigFromEnv()
  resolveDocumentObjectS3SseMode()
  documentObjectS3RequestTimeoutMs()
  documentObjectS3SettleBudgetMs()
}

export function documentObjectS3UsesServerSideEncryptionHeader(): boolean {
  return resolveDocumentObjectS3SseMode() === "AES256"
}

/** Callers validate the settings they use (s3ConfigFromEnv and the timeouts) before asking for it. */
function documentObjectS3Client(): S3Client {
  if (cachedClient) return cachedClient
  const cfg = s3ConfigFromEnv()
  cachedClient = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // One attempt per call. An SDK retry of a PUT that already landed would meet its own object
    // and answer 412; writeS3Payload settles an ambiguous PUT itself instead. Deadlines are not set
    // here: withDeadline aborts every call, the body read included.
    maxAttempts: 1,
  })
  return cachedClient
}

export function objectKeyForS3StoragePath(storagePath: string): string {
  const prefix = "s3://"
  if (!storagePath.startsWith(prefix)) {
    throw new Error("document storagePath must use s3:// scheme")
  }
  const key = storagePath.slice(prefix.length)
  if (!key || key.includes("..")) {
    throw new Error("document object path failed safety validation")
  }
  return key
}

function httpStatusOf(err: unknown): number | null {
  const status = (err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
    ?.httpStatusCode
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null
}

function describeFailure(
  failure: DocumentObjectStoreError["failure"],
  status: number | null,
  code: string | null,
  timeoutMs: number
): string {
  if (failure === "timeout") return `no response within ${timeoutMs} ms`
  if (failure === "network") return code ? `network error ${code}` : "network error"
  if (failure === "integrity") return "transport checksum mismatch"
  return code ? `HTTP ${status} ${code}` : `HTTP ${status}`
}

/** The SDK's own response-checksum check (x-amz-checksum-*) failed while the body was read. */
function isTransportChecksumMismatch(err: unknown): boolean {
  return err instanceof Error && /^Checksum mismatch/.test(err.message)
}

/**
 * Reduce any SDK or socket error to a DocumentObjectStoreError that carries no foreign text.
 * Exported for its unit tests only.
 */
export function toDocumentObjectStoreError(
  operation: DocumentObjectStoreOperation,
  err: unknown,
  timedOut: boolean,
  timeoutMs: number
): DocumentObjectStoreError {
  if (err instanceof DocumentObjectStoreError) return err
  if (err instanceof DocumentObjectConfigurationError) throw err
  const status = httpStatusOf(err)
  let failure: DocumentObjectStoreError["failure"]
  let code: string | null = null
  if (timedOut) {
    failure = "timeout"
  } else if (isTransportChecksumMismatch(err)) {
    failure = "integrity"
  } else if (status !== null) {
    failure = "http"
    const name = err instanceof Error ? err.name : null
    code = name && WELL_FORMED_S3_CODE.test(name) ? name : null
  } else {
    failure = "network"
    const nodeCode = (err as { code?: unknown } | null)?.code
    code = typeof nodeCode === "string" && NODE_ERROR_CODE.test(nodeCode) ? nodeCode : null
  }
  return new DocumentObjectStoreError(
    operation,
    failure,
    failure === "http" ? status : null,
    failure === "http" ? code : null,
    `document object store ${operation} failed: ${describeFailure(failure, status, code, timeoutMs)}`
  )
}

/** Run one S3 call under its own abort deadline; every failure leaves as a DocumentObjectStoreError. */
async function withDeadline<T>(
  operation: DocumentObjectStoreOperation,
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await call(controller.signal)
  } catch (err) {
    throw toDocumentObjectStoreError(operation, err, controller.signal.aborted, timeoutMs)
  } finally {
    clearTimeout(timer)
  }
}

function maxPayloadBytes(): number {
  return Math.max(maxUploadBytes(), DEFAULT_MAX_UPLOAD_BYTES) + PAYLOAD_OVERHEAD_BYTES
}

type ReadableBody = AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void }

async function getObjectBytes(bucket: string, key: string, timeoutMs: number): Promise<Buffer> {
  return withDeadline("get", timeoutMs, async (signal) => {
    const out = await documentObjectS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: signal,
    })
    const body = out.Body as ReadableBody | undefined
    if (!body) {
      throw new DocumentObjectStoreError("get", "http", 200, null, "document object store get failed: empty body")
    }
    const cap = maxPayloadBytes()
    if (typeof out.ContentLength === "number" && out.ContentLength > cap) {
      body.destroy?.()
      throw new DocumentObjectStoreError("get", "http", 200, null, "document object store get failed: object exceeds the size cap")
    }
    // The deadline also covers the body: a stalled stream is destroyed when the signal fires.
    const onAbort = () => body.destroy?.(new Error("document object read deadline"))
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of body) {
        total += chunk.byteLength
        if (total > cap) {
          body.destroy?.()
          throw new DocumentObjectStoreError("get", "http", 200, null, "document object store get failed: object exceeds the size cap")
        }
        chunks.push(Buffer.from(chunk))
      }
      if (signal.aborted) throw new Error("document object read deadline")
      return Buffer.concat(chunks)
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  })
}

function isNotFound(err: unknown): boolean {
  return err instanceof DocumentObjectStoreError && err.httpStatus === 404
}

function putObjectInput(bucket: string, key: string, body: Buffer): PutObjectCommandInput {
  const input: PutObjectCommandInput = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: "application/octet-stream",
    // Create-only: R2 and MinIO answer 412 when the key exists (no read-then-write race).
    IfNoneMatch: "*",
  }
  if (documentObjectS3UsesServerSideEncryptionHeader()) {
    input.ServerSideEncryption = "AES256"
  }
  return input
}

export class DocumentObjectAlreadyExistsError extends Error {
  constructor() {
    super("document object already exists (immutable)")
    this.name = "DocumentObjectAlreadyExistsError"
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * A PUT that timed out, lost its connection or met a 5xx may still land. Read the key until the
 * settle budget runs out: our own bytes mean the write succeeded; other bytes mean another writer
 * owns the key; nothing means the outcome is unknown, which is logged with the key (a late write
 * would be an orphan, and under a bucket lock it cannot be deleted) and fails the upload.
 */
async function settleAmbiguousPut(
  bucket: string,
  key: string,
  payload: Buffer,
  cause: DocumentObjectStoreError
): Promise<void> {
  const budget = documentObjectS3SettleBudgetMs()
  const requestTimeout = documentObjectS3RequestTimeoutMs()
  const deadline = performance.now() + budget
  for (;;) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    try {
      const found = await getObjectBytes(bucket, key, Math.max(1, Math.min(requestTimeout, remaining)))
      if (found.equals(payload)) return
      throw new DocumentObjectAlreadyExistsError()
    } catch (err) {
      if (err instanceof DocumentObjectAlreadyExistsError) throw err
      // Not there yet, or the read failed too: try again while the budget lasts.
    }
    const left = deadline - performance.now()
    if (left <= 0) break
    await sleep(Math.min(DOCUMENT_OBJECT_S3_SETTLE_POLL_MS, left))
  }
  console.error(
    `[documentObjectStore] ambiguous PUT did not settle within ${budget} ms (${cause.message}); ` +
      `a late write would leave an orphan object: bucket=${bucket} key=${key}`
  )
  throw new DocumentObjectStoreError(
    "put",
    cause.failure,
    cause.httpStatus,
    cause.s3Code,
    `document object store put outcome unknown after ${budget} ms settle budget (${cause.message})`
  )
}

export async function writeS3Payload(storagePath: string, payload: Buffer): Promise<void> {
  const key = objectKeyForS3StoragePath(storagePath)
  const { bucket } = s3ConfigFromEnv()
  const timeout = documentObjectS3RequestTimeoutMs()
  try {
    await withDeadline("put", timeout, (signal) =>
      documentObjectS3Client().send(new PutObjectCommand(putObjectInput(bucket, key, payload)), {
        abortSignal: signal,
      })
    )
    return
  } catch (err) {
    const failure = err as DocumentObjectStoreError
    if (failure.httpStatus === 412) throw new DocumentObjectAlreadyExistsError()
    const ambiguous =
      failure.failure !== "http" || (failure.httpStatus !== null && failure.httpStatus >= 500)
    if (!ambiguous) throw failure
    await settleAmbiguousPut(bucket, key, payload, failure)
  }
}

export async function readS3Payload(storagePath: string): Promise<Buffer> {
  const key = objectKeyForS3StoragePath(storagePath)
  const { bucket } = s3ConfigFromEnv()
  try {
    return await getObjectBytes(bucket, key, documentObjectS3RequestTimeoutMs())
  } catch (err) {
    if (isNotFound(err)) throw new Error(`document object not found: ${storagePath}`)
    throw err
  }
}

export async function deleteS3Payload(storagePath: string, options?: { strict?: boolean }): Promise<void> {
  const key = objectKeyForS3StoragePath(storagePath)
  const { bucket } = s3ConfigFromEnv()
  try {
    await withDeadline("delete", documentObjectS3RequestTimeoutMs(), (signal) =>
      documentObjectS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: signal,
      })
    )
  } catch (err) {
    if (options?.strict) throw err
    console.error(`[documentObjectStore] best-effort delete failed (${(err as Error).message}): key=${key}`)
  }
}
