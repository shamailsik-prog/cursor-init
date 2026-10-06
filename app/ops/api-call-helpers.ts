export type ApiCallResult = {
  ok: boolean
  status: number
  body: unknown
}

type StatusTolerantApiCallOptions = {
  step: string
  allowedStatuses: readonly number[]
  execute: () => Promise<ApiCallResult>
}

function extractErrorMessage(body: unknown): string | null {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error
  }
  return null
}

export function formatApiErrorMessage(step: string, status: number, body: unknown): string {
  return extractErrorMessage(body) ?? `${step} failed with ${status}`
}

/**
 * A call into a layer frozen behind a feature flag (404 `{ error: "feature_disabled", flag }`,
 * Erratum E-24). The console reports the step as disabled instead of failed.
 */
export class FeatureDisabledError extends Error {
  readonly flag: string

  constructor(step: string, flag: string) {
    super(`${step}: disabled (${flag} is off)`)
    this.name = "FeatureDisabledError"
    this.flag = flag
  }
}

function disabledFlag(status: number, body: unknown): string | null {
  if (status !== 404 || typeof body !== "object" || body === null) return null
  const record = body as Record<string, unknown>
  if (record.error !== "feature_disabled") return null
  return typeof record.flag === "string" ? record.flag : "feature flag"
}

/** The error to throw for a failed call: FeatureDisabledError for a frozen layer. */
export function apiCallError(step: string, status: number, body: unknown): Error {
  const flag = disabledFlag(status, body)
  if (flag) return new FeatureDisabledError(step, flag)
  return new Error(formatApiErrorMessage(step, status, body))
}

/** How the /ops console reports a failed step: a frozen layer is a disabled notice, not an error. */
export function stepFailureOutcome(
  step: string,
  err: unknown
): { kind: "notice" | "error"; message: string } {
  if (err instanceof FeatureDisabledError) return { kind: "notice", message: err.message }
  return { kind: "error", message: err instanceof Error ? err.message : `${step} failed` }
}

export async function runApiCallAllowingStatuses(
  options: StatusTolerantApiCallOptions
): Promise<ApiCallResult> {
  const result = await options.execute()
  // An allowed 404 must not hide a frozen layer: later steps would read an empty body.
  if (disabledFlag(result.status, result.body)) {
    throw apiCallError(options.step, result.status, result.body)
  }
  if (result.ok || options.allowedStatuses.includes(result.status)) return result
  throw apiCallError(options.step, result.status, result.body)
}
