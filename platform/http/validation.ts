import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { z } from "zod"
import { CLASSIFICATION_RANKS, type Classification } from "@/platform/p1/types"

/** Stable machine-readable error codes for request validation failures. */
export const INVALID_REQUEST = "invalid_request"
export const PAYLOAD_TOO_LARGE = "payload_too_large"

export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
/** Default cap on a non-upload JSON request body. */
export const DEFAULT_JSON_BODY_BYTES = 1024 * 1024

/** Maximum decoded upload size; `SIKANDER_MAX_UPLOAD_BYTES` overrides the 25 MB default. */
export function maxUploadBytes(): number {
  const raw = process.env.SIKANDER_MAX_UPLOAD_BYTES
  if (!raw) return DEFAULT_MAX_UPLOAD_BYTES
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES
}

/** Decoded byte length of a base64 string, computed without allocating the buffer. */
export function base64DecodedLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor((value.length * 3) / 4) - padding
}

/**
 * Upper bound on a JSON request carrying a base64 upload of `maxUploadBytes()` decoded
 * bytes: base64 inflation (4/3), 6% for line-wrapped base64 (JSON-escaped CRLF every 76 chars
 * is ~5.3%), plus a fixed
 * allowance for the other JSON fields. The decoded-size check is the authoritative cap.
 */
export function maxUploadRequestBytes(): number {
  return Math.ceil(((maxUploadBytes() * 4) / 3) * 1.06) + 64 * 1024
}

export function invalidRequest(error: string, issues?: { path: string; message: string }[]) {
  return NextResponse.json({ error, code: INVALID_REQUEST, ...(issues ? { issues } : {}) }, { status: 400 })
}

export function payloadTooLarge(limit: number) {
  return NextResponse.json(
    { error: `upload exceeds the maximum size of ${limit} bytes`, code: PAYLOAD_TOO_LARGE },
    { status: 413 }
  )
}

/**
 * Bodies already read (under a byte cap) and JSON-parsed by the route boundary
 * (`withSession`), keyed by the Request object handed to the handler. The stream is read
 * from the network exactly once; `readJsonLimited` on the handed-over Request reuses the
 * parsed value instead of re-reading and re-parsing, but still enforces its own cap
 * against the recorded byte length.
 */
const preparsedBodies = new WeakMap<Request, { data: unknown; bytes: number }>()

/** Record that `request`'s body was already read (`bytes` long) and parsed to `data`. */
export function attachParsedBody(request: Request, data: unknown, bytes: number): void {
  preparsedBodies.set(request, { data, bytes })
}

/**
 * Read a request body as UTF-8 text without ever buffering more than `limitBytes`.
 * Rejects early on a declared Content-Length above the limit, and counts streamed bytes
 * so chunked bodies (no Content-Length) are cut off too: 413 payload_too_large.
 * A stream error mid-read: 400 invalid_request.
 */
export async function readBodyLimited(
  request: Request,
  limitBytes: number = DEFAULT_JSON_BODY_BYTES,
  reportedLimit: number = limitBytes
): Promise<{ ok: true; text: string; bytes: number } | { ok: false; response: NextResponse }> {
  const declared = Number(request.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > limitBytes) {
    return { ok: false, response: payloadTooLarge(reportedLimit) }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  if (request.body) {
    const reader = request.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > limitBytes) {
          await reader.cancel().catch(() => undefined)
          return { ok: false, response: payloadTooLarge(reportedLimit) }
        }
        chunks.push(value)
      }
    } catch {
      // Client aborted or the body stream errored mid-read.
      return { ok: false, response: invalidRequest("request body could not be read") }
    }
  }
  // Decode once over the concatenated bytes (multi-byte chars may span chunks); drop a BOM
  // as Request.json() does.
  const text = Buffer.concat(chunks, total).toString("utf8").replace(/^\uFEFF/, "")
  return { ok: true, text, bytes: total }
}

/**
 * Read and JSON-parse a request body without ever buffering more than `limitBytes`
 * (see `readBodyLimited`): 413 payload_too_large over the cap, 400 invalid_request on
 * malformed JSON. A body already read and parsed by `withSession` is reused, with the
 * cap checked against its recorded length.
 */
export async function readJsonLimited(
  request: Request,
  limitBytes: number = DEFAULT_JSON_BODY_BYTES,
  reportedLimit: number = limitBytes
): Promise<{ ok: true; data: unknown } | { ok: false; response: NextResponse }> {
  const preparsed = preparsedBodies.get(request)
  if (preparsed) {
    if (preparsed.bytes > limitBytes) return { ok: false, response: payloadTooLarge(reportedLimit) }
    return { ok: true, data: preparsed.data }
  }
  const read = await readBodyLimited(request, limitBytes, reportedLimit)
  if (!read.ok) return read
  try {
    return { ok: true, data: JSON.parse(read.text) }
  } catch {
    return { ok: false, response: invalidRequest("invalid JSON body") }
  }
}

/** Fixed-size idempotency fingerprint, so replay caches never retain request payloads. */
export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function parseBody<S extends z.ZodType>(
  schema: S,
  raw: unknown
): { ok: true; data: z.infer<S> } | { ok: false; response: NextResponse } {
  const result = schema.safeParse(raw)
  if (result.success) return { ok: true, data: result.data }
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }))
  return { ok: false, response: invalidRequest("invalid request body", issues) }
}

// Shared field schemas. Identifiers are bounded opaque strings; free text is length-capped.
export const idField = z.string().min(1).max(200)
export const textField = (max: number) => z.string().min(1).max(max)
export const classificationField = z.enum(
  Object.keys(CLASSIFICATION_RANKS) as [Classification, ...Classification[]]
)
/** Standard or URL-safe base64; whitespace/newlines (MIME wrapping) are stripped first. */
export const base64Field = z.preprocess(
  (value) => (typeof value === "string" ? value.replace(/\s+/g, "") : value),
  z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, "must be base64")
    .refine((value) => value.length % 4 !== 1, "must be base64")
)
