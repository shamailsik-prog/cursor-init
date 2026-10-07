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
