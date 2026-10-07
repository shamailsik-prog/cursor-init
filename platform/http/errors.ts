/**
 * Client-facing error bodies. Never echo arbitrary exception text: only
 * `PublicError` messages reach the client; unexpected failures (SDK /
 * Firestore / runtime errors) return a generic message with a stable `code`,
 * and the details are logged server-side only.
 */
import { NextResponse } from "next/server"
import { PublicError } from "@/platform/http/publicError"

export { PublicError }

export const INTERNAL_ERROR_CODE = "INTERNAL_ERROR"
export const REQUEST_FAILED_CODE = "REQUEST_FAILED"

/** Message safe to return to a client; anything else is logged and replaced by `fallback`. */
export function publicErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof PublicError) return err.message
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
