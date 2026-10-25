import { logger } from "firebase-functions"

/**
 * A manifest-registered ERROR line for log-based alert policies (F32/F43). Uses structured logging (`event` on
 * `jsonPayload`) because `firebase-functions` 6.6+ rewrites string-first ERROR logs so `jsonPayload.message` is a
 * stack trace (`Error: name\n at …`), which equality filters on `message` never match.
 */
export function logRegisteredError(event: string, fields: Record<string, unknown> = {}): void {
  logger.write({ severity: "ERROR", event, ...fields })
}

/**
 * A loggable error code: the SDK's `code` string, or a gRPC numeric code as `grpc_<n>` (Firestore's
 * Admin SDK raises those, e.g. `grpc_3` for INVALID_ARGUMENT), never the message (which may carry an email).
 */
export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === "string") return code
  if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 16) return `grpc_${code}`
  return "unknown"
}

/** Logs a failure with a generic message, its code and (optionally) a uid; no raw error text. */
export function logFailure(message: string, err: unknown, uid?: string): void {
  logger.error(message, uid === undefined ? { code: errorCode(err) } : { uid, code: errorCode(err) })
}
