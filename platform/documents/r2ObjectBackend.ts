import { createHash } from "node:crypto"
import { AwsClient } from "aws4fetch"
import {
  DocumentObjectExistsError,
  DocumentObjectNotFoundError,
  type DocumentObjectBackend,
} from "@/platform/documents/objectBackend"

/**
 * Cloudflare R2 backend for the document vault (FA-D16-001; architecture v6 §3 and Layer 18
 * §5: "Original files and derived artefacts — Cloudflare R2, immutable paths"). It speaks the
 * S3 API with AWS Signature Version 4 (aws4fetch, pinned), path-style:
 *
 *   PUT    {endpoint}/{bucket}/{key}   If-None-Match: *  (conditional create; never overwrites)
 *   GET    {endpoint}/{bucket}/{key}   (read-after-write and reads; no local cache)
 *   DELETE {endpoint}/{bucket}/{key}   (only to discard an object whose write did not verify)
 *
 * Every request carries x-amz-content-sha256 with the real payload hash, so the server rejects a
 * body altered in transit. The payload is always the encrypted envelope built by
 * documentObjectStore.ts: R2 never receives plaintext. Requests are not retried here; a failed
 * upload fails closed and the caller retries with the same idempotency key. A PUT that got no
 * response at all is settled by reading the key (settleAmbiguousPut).
 *
 * The live-bucket test against real R2 (architecture open item O-2) is
 * tests/fa-d16-001.r2-live.o2.test.ts and runs only when R2_LIVE_* credentials are provided.
 */
export type R2DocumentObjectBackendConfig = {
  /** e.g. https://<ACCOUNT_ID>.r2.cloudflarestorage.com (no path). */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** SigV4 region; R2 uses "auto". */
  region: string
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  /** Per-request timeout; defaults to 30 s. */
  timeoutMs?: number
  /** How long an ambiguous PUT is settled by re-reading the key; defaults to 2 × timeoutMs. */
  settleWindowMs?: number
  /** First pause between settling reads (doubles each time); defaults to 250 ms. */
  settleInitialDelayMs?: number
}

type Method = "PUT" | "GET" | "DELETE"

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_SETTLE_INITIAL_DELAY_MS = 250

/**
 * No HTTP response arrived (reset, DNS, timeout): a write's outcome is unknown. Like every error
 * this backend throws, its message is built from fixed text, the method, the object key and an
 * error code only, and it carries no `cause`: the underlying error can quote the request.
 */
class R2TransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "R2TransportError"
  }
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

/** A Node error code (ECONNRESET) or the error class (TypeError); never a message. */
function failureKind(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined
  for (const code of [e?.cause?.code, e?.code]) {
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code
  }
  return typeof e?.name === "string" && /^[A-Za-z]+$/.test(e.name) ? e.name : "Error"
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createR2DocumentObjectBackend(config: R2DocumentObjectBackendConfig): DocumentObjectBackend {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region,
    retries: 0,
  })
  const base = config.endpoint.trim().replace(/\/+$/, "")
  const bucket = encodeURIComponent(config.bucket)
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const settleWindowMs = config.settleWindowMs ?? 2 * timeoutMs
  const settleInitialDelayMs = config.settleInitialDelayMs ?? DEFAULT_SETTLE_INITIAL_DELAY_MS
  const send = config.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init))

  function urlFor(key: string): string {
    return `${base}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`
  }

  /**
   * Signs and sends; throws only when no HTTP response arrived (reset, DNS, timeout). fetch gets
   * the URL, the signed headers and the body as bytes, not a Request object: inside the Next.js
   * runtime a Request's body is re-streamed and sent chunked without Content-Length, which S3
   * servers refuse (411). `cache: "no-store"` keeps Next.js's fetch cache out of every call, so a
   * read is always the bucket's current copy.
   *
   * Re-audit R1-D1: signing happens inside the guard. A signing failure (for example a header
   * value the signer cannot set) quotes the Authorization header in its message, so it is replaced
   * by a fixed message naming the step; it is not a transport failure, since nothing was sent.
   */
  async function request(
    method: Method,
    key: string,
    payload: Buffer | undefined,
    headers: Record<string, string>
  ): Promise<Response> {
    const body = payload ? new Uint8Array(payload) : undefined
    const signal = AbortSignal.timeout(timeoutMs)
    let signed: Request
    try {
      signed = await client.sign(urlFor(key), {
        method,
        headers: { ...headers, "x-amz-content-sha256": sha256Hex(payload ?? Buffer.alloc(0)) },
        body,
      })
    } catch {
      throw new Error(`R2 ${method} ${key} failed: request signing failed`)
    }
    try {
      return await send(signed.url, { method, headers: signed.headers, body, cache: "no-store", signal })
    } catch (err) {
      if (signal.aborted) throw new R2TransportError(`R2 ${method} ${key} timed out after ${timeoutMs} ms`)
      throw new R2TransportError(`R2 ${method} ${key} failed: no response (${failureKind(err)})`)
    }
  }

  /** Consumes a body whose content does not matter; the status already decided the outcome. */
  async function drain(res: Response): Promise<void> {
    await res.arrayBuffer().catch(() => undefined)
  }

  /** Reads a response body; a failure mid-body is reported like a transport failure. */
  async function bodyOf(method: Method, key: string, res: Response): Promise<Buffer> {
    try {
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      throw new R2TransportError(`R2 ${method} ${key} failed: response body unreadable (${failureKind(err)})`)
    }
  }

  /** Status and the S3 error code only: the body may echo request details, never credentials. */
  async function failure(method: Method, key: string, res: Response): Promise<Error> {
    const text = await res.text().catch(() => "")
    const code = /<Code>([A-Za-z0-9.]+)<\/Code>/.exec(text)?.[1]
    return new Error(`R2 ${method} ${key} failed: HTTP ${res.status}${code ? ` ${code}` : ""}`)
  }

  async function get(key: string): Promise<Buffer> {
    const res = await request("GET", key, undefined, { "cache-control": "no-cache" })
    if (res.ok) return bodyOf("GET", key, res)
    if (res.status === 404) {
      await drain(res)
      throw new DocumentObjectNotFoundError(key)
    }
    throw await failure("GET", key, res)
  }

  /**
   * A PUT that got no response (connection reset, timeout) may have been refused (S3 servers can
   * answer a failed If-None-Match early and reset the connection before the client reads the
   * 412), may have landed before the connection dropped, or may still land later (re-audit
   * R1-D2). The stored bytes settle it: the envelope's nonce is random, so identical bytes can
   * only be this write, and other bytes are another writer's. The key is re-read with doubling
   * pauses for `settleWindowMs` (2 × the request timeout by default); a read that fails or finds
   * nothing is retried. If nothing appears, the original failure stands and the key is logged as
   * a possible orphan (it is not secret; the object is ciphertext no row references).
   */
  async function settleAmbiguousPut(key: string, payload: Buffer, transportError: R2TransportError): Promise<void> {
    const deadline = Date.now() + settleWindowMs
    let pause = settleInitialDelayMs
    for (;;) {
      const stored = await get(key).catch(() => undefined)
      if (stored) {
        if (stored.equals(payload)) return
        throw new DocumentObjectExistsError(key)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(pause, remaining))
      pause *= 2
    }
    console.error(`[documents] document object possible orphan: ${key}`)
    throw transportError
  }

  return {
    kind: "r2",
    scheme: "r2://",
    async putIfAbsent(key, payload) {
      let res: Response
      try {
        res = await request("PUT", key, payload, {
          "content-type": "application/octet-stream",
          "if-none-match": "*",
        })
      } catch (err) {
        if (err instanceof R2TransportError) return settleAmbiguousPut(key, payload, err)
        throw err
      }
      if (res.ok) {
        await drain(res)
        return
      }
      // 412: the key exists. 409: a concurrent conditional write to the key is in flight.
      if (res.status === 412 || res.status === 409) {
        await drain(res)
        throw new DocumentObjectExistsError(key)
      }
      throw await failure("PUT", key, res)
    },
    get,
    async delete(key) {
      const res = await request("DELETE", key, undefined, {})
      if (res.ok || res.status === 404) {
        await drain(res)
        return
      }
      throw await failure("DELETE", key, res)
    },
  }
}
