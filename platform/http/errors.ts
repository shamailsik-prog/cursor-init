/**
 * Client-facing error bodies. Never echo arbitrary exception text: unexpected
 * failures (SDK / Firestore / runtime errors) return a generic message with a
 * stable `code`, and the details are logged server-side only.
 */
import { NextResponse } from "next/server"

export const INTERNAL_ERROR_CODE = "INTERNAL_ERROR"
export const REQUEST_FAILED_CODE = "REQUEST_FAILED"

const MAX_PUBLIC_MESSAGE_LENGTH = 300

/**
 * True for a deliberate domain rejection — a plain `Error` thrown by our own
 * route/platform code with a short single-line message (e.g. "unknown actor").
 * Subclasses (TypeError, FirebaseError, ...) and errors carrying system
 * metadata (`code`, `errno`, `cause`) are treated as internal.
 */
function isDomainRejection(err: unknown): err is Error {
  if (!(err instanceof Error)) return false
  if (Object.getPrototypeOf(err) !== Error.prototype) return false
  const meta = err as Error & { code?: unknown; errno?: unknown }
  if (meta.code !== undefined || meta.errno !== undefined || err.cause !== undefined) return false
  const message = err.message
  return (
    message.length > 0 && message.length <= MAX_PUBLIC_MESSAGE_LENGTH && !/[\r\n]/.test(message)
  )
}

/** Message safe to return to a client; anything else is logged and replaced by `fallback`. */
export function publicErrorMessage(err: unknown, fallback: string): string {
  if (isDomainRejection(err)) return err.message
  console.error(`[api] ${fallback}:`, err)
  return fallback
}

export function errorResponse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status })
}

export function internalErrorResponse(err: unknown, where: string): NextResponse {
  console.error(`[api] unhandled error in ${where}:`, err)
  return errorResponse(500, INTERNAL_ERROR_CODE, "internal error")
}
