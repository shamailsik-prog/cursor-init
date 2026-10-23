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
 * Next F10 ruling 15. The value is the operation id. A client that saw a refusal
 * without this signal will resubmit under a new Idempotency-Key and duplicate a
 * write that already committed. Same spelling as platform/http/idempotency.ts.
 */
export const EFFECT_COMMITTED_HEADER = "Idempotency-Effect-Committed"

/** Header-safe operation id: no whitespace, no injection, bounded length. UUIDs match. */
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function asOperationId(value: unknown): string | undefined {
  return typeof value === "string" && OPERATION_ID.test(value) ? value : undefined
}

/** `effectCommitted.operationId` when it is a header-safe id. */
export function effectCommittedOperationId(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const effect = (body as { effectCommitted?: unknown }).effectCommitted
  if (!effect || typeof effect !== "object" || Array.isArray(effect)) return undefined
  return asOperationId((effect as { operationId?: unknown }).operationId)
}

/**
 * A non-2xx whose effect already committed. The router must answer with the
 * status and code plus both F10 signals (the header and `effectCommitted`).
 * A bare `{ error: { code } }` is the defect FA-F02-001.
 */
export class CommittedEffectError extends HttpError {
  readonly operationId: string

  constructor(status: number, code: string, operationId: string) {
    super(status, code)
    this.name = "CommittedEffectError"
    this.operationId = operationId
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
