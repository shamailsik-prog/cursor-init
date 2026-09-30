import { HttpsError, type FunctionsErrorCode } from "firebase-functions/v2/https"

/** An error that maps directly onto an HTTP response: `status` + machine-readable `code`. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.name = "HttpError"
    this.status = status
    this.code = code
  }
}

/** 429 rate_limited; `retryAfter` is the whole seconds until the limit window ends. */
export class RateLimitedError extends HttpError {
  constructor(readonly retryAfter: number) {
    super(429, "rate_limited")
    this.name = "RateLimitedError"
  }
}

const CALLABLE_CODES: Record<number, FunctionsErrorCode> = {
  400: "invalid-argument",
  401: "unauthenticated",
  403: "permission-denied",
  404: "not-found",
  429: "resource-exhausted",
  503: "unavailable",
}

/**
 * Maps an HttpError onto the callable protocol's HttpsError, carrying the
 * machine-readable code in `details.code`. 409 maps to `already-exists` for
 * code "already_exists" and to `failed-precondition` otherwise. 429 maps to
 * `resource-exhausted` with `details.retryAfter` (seconds). Anything
 * that is not an HttpError becomes a bare `internal` (no message leak).
 */
export function toHttpsError(err: unknown): HttpsError {
  if (err instanceof HttpsError) return err
  if (!(err instanceof HttpError)) return new HttpsError("internal", "internal", { code: "internal" })
  const code =
    err.status === 409
      ? err.code === "already_exists"
        ? "already-exists"
        : "failed-precondition"
      : (CALLABLE_CODES[err.status] ?? "internal")
  const details = err instanceof RateLimitedError ? { code: err.code, retryAfter: err.retryAfter } : { code: err.code }
  return new HttpsError(code, err.code, details)
}
