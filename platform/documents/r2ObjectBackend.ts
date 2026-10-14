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
}

type Method = "PUT" | "GET" | "DELETE"

const DEFAULT_TIMEOUT_MS = 30_000

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
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
   */
  async function request(
    method: Method,
    key: string,
    payload: Buffer | undefined,
    headers: Record<string, string>
  ): Promise<Response> {
    const body = payload ? new Uint8Array(payload) : undefined
    const signal = AbortSignal.timeout(timeoutMs)
    const signed = await client.sign(urlFor(key), {
      method,
      headers: { ...headers, "x-amz-content-sha256": sha256Hex(payload ?? Buffer.alloc(0)) },
      body,
    })
    try {
      return await send(signed.url, { method, headers: signed.headers, body, cache: "no-store", signal })
    } catch (err) {
      if (signal.aborted) throw new Error(`R2 ${method} ${key} timed out after ${timeoutMs} ms`)
      throw new Error(`R2 ${method} ${key} failed: ${(err as Error).message}`)
    }
  }

  /** Status and the S3 error code only: the body may echo request details, never credentials. */
  async function failure(method: Method, key: string, res: Response): Promise<Error> {
    const text = await res.text()
    const code = /<Code>([A-Za-z0-9.]+)<\/Code>/.exec(text)?.[1]
    return new Error(`R2 ${method} ${key} failed: HTTP ${res.status}${code ? ` ${code}` : ""}`)
  }

  async function get(key: string): Promise<Buffer> {
    const res = await request("GET", key, undefined, { "cache-control": "no-cache" })
    if (res.ok) return Buffer.from(await res.arrayBuffer())
    if (res.status === 404) {
      await res.arrayBuffer()
      throw new DocumentObjectNotFoundError(key)
    }
    throw await failure("GET", key, res)
  }

  /**
   * A PUT that got no response (connection reset, timeout) may have been refused (S3 servers can
   * answer a failed If-None-Match early and reset the connection before the client reads the
   * 412) or may have landed before the connection dropped. The stored bytes settle it: the
   * envelope's nonce is random, so identical bytes can only be this write. If the key cannot be
   * read, the original failure stands.
   */
  async function settleAmbiguousPut(key: string, payload: Buffer, transportError: unknown): Promise<void> {
    let stored: Buffer
    try {
      stored = await get(key)
    } catch {
      throw transportError
    }
    if (!stored.equals(payload)) throw new DocumentObjectExistsError(key)
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
        return settleAmbiguousPut(key, payload, err)
      }
      if (res.ok) {
        await res.arrayBuffer()
        return
      }
      // 412: the key exists. 409: a concurrent conditional write to the key is in flight.
      if (res.status === 412 || res.status === 409) {
        await res.arrayBuffer()
        throw new DocumentObjectExistsError(key)
      }
      throw await failure("PUT", key, res)
    },
    get,
    async delete(key) {
      const res = await request("DELETE", key, undefined, {})
      if (res.ok || res.status === 404) {
        await res.arrayBuffer()
        return
      }
      throw await failure("DELETE", key, res)
    },
  }
}
