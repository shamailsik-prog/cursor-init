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

/**
 * 429 with a Retry-After: `rate_limited` (per-user minute window) by default, or another
 * limit's code (`daily_limit`, spec P2-17); `retryAfter` is the whole seconds until it resets.
 */
export class RateLimitedError extends HttpError {
  constructor(
    readonly retryAfter: number,
    code = "rate_limited"
  ) {
    super(429, code)
    this.name = "RateLimitedError"
  }
}
