import { logger } from "firebase-functions"

/** A loggable error code: the SDK's `code` string if any, never the message (which may carry an email). */
export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "unknown"
}

/** Logs a failure with a generic message, its code and (optionally) a uid; no raw error text. */
export function logFailure(message: string, err: unknown, uid?: string): void {
  logger.error(message, uid === undefined ? { code: errorCode(err) } : { uid, code: errorCode(err) })
}
