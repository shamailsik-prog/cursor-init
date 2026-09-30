import { NextResponse } from "next/server"
import { z } from "zod"
import { CLASSIFICATION_RANKS, type Classification } from "@/platform/p1/types"

/** Stable machine-readable error codes for request validation failures. */
export const INVALID_REQUEST = "invalid_request"
export const PAYLOAD_TOO_LARGE = "payload_too_large"

export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024

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
 * bytes: base64 inflation (4/3) plus a fixed allowance for the other JSON fields.
 */
export function maxUploadRequestBytes(): number {
  return Math.ceil((maxUploadBytes() * 4) / 3) + 64 * 1024
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
/** Standard or URL-safe base64, no whitespace. */
export const base64Field = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, "must be base64")
