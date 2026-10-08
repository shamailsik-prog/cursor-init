import type { JobHandler } from "./registry"

/**
 * Job error sanitising (spec P3-9). `lastError`, event `error`, audit `reason`, alert and log
 * fields come only from `sanitizeError`: a code and a fixed message from a table in code.
 * `err.message`, `err.stack` and payload values are never kept.
 */

/** A job failure with a machine code. Its `message` is the code, never free text. */
export class JobError extends Error {
  readonly code: string
  readonly permanent: boolean

  constructor(code: string, opts: { permanent?: boolean } = {}) {
    super(code)
    this.name = "JobError"
    this.code = code
    this.permanent = opts.permanent === true
  }
}

/** Thrown by `runFenced` when the claim's fence no longer holds (Task 3). */
export class LeaseLostError extends Error {
  constructor() {
    super("lease_lost")
    this.name = "LeaseLostError"
  }
}

export const ENGINE_CODES = [
  "invalid_payload",
  "unknown_job_type",
  "handler_timeout",
  "lease_expired",
  "store_unavailable",
  "internal",
  "invalid_fenced_step",
  "fenced_step_limit",
] as const
export type EngineCode = (typeof ENGINE_CODES)[number]

export const JOB_ERROR_MESSAGES: Readonly<Record<EngineCode, string>> = {
  invalid_payload: "The job's payload is invalid.",
  unknown_job_type: "The job type is not registered.",
  handler_timeout: "The job exceeded its time budget.",
  lease_expired: "The job's worker stopped before finishing.",
  store_unavailable: "The data store was unavailable.",
  internal: "The job failed with an internal error.",
  invalid_fenced_step: "The job used an invalid step id.",
  fenced_step_limit: "The job exceeded its step limit.",
}

export type SanitizedError = { code: string; message: string; permanent: boolean }

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
/** Engine codes that never benefit from an automatic retry. */
const ALWAYS_PERMANENT: ReadonlySet<string> = new Set(["invalid_payload", "unknown_job_type", "invalid_fenced_step", "fenced_step_limit"])

function isEngineCode(code: string): code is EngineCode {
  return (ENGINE_CODES as readonly string[]).includes(code)
}

const engine = (code: EngineCode, permanent: boolean): SanitizedError => ({ code, message: JOB_ERROR_MESSAGES[code], permanent })

/**
 * Maps any thrown value onto a declared code and its fixed message:
 * - a `JobError` whose code matches `^[a-z][a-z0-9_]{0,63}$` and is an engine code or one of the
 *   handler's `errorCodes` keeps it (`invalid_payload`, `unknown_job_type`, `invalid_fenced_step`
 *   and `fenced_step_limit` always permanent,
 *   others as the error says);
 * - an error with a numeric gRPC status `code` (1..16), i.e. a Firestore failure → `store_unavailable`, retryable;
 * - anything else → `internal`, retryable.
 */
export function sanitizeError(err: unknown, handler?: Pick<JobHandler, "errorCodes">): SanitizedError {
  if (err instanceof JobError && CODE_PATTERN.test(err.code)) {
    const { code } = err
    if (isEngineCode(code)) return engine(code, ALWAYS_PERMANENT.has(code) || err.permanent)
    const declared = handler && Object.hasOwn(handler.errorCodes, code) ? handler.errorCodes[code] : undefined
    if (typeof declared === "string") return { code, message: declared, permanent: err.permanent }
  }
  if (!(err instanceof JobError)) {
    const status = (err as { code?: unknown } | null)?.code
    if (typeof status === "number" && Number.isInteger(status) && status >= 1 && status <= 16) return engine("store_unavailable", false)
  }
  return engine("internal", false)
}
