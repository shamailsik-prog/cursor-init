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

export async function runApiCallAllowingStatuses(
  options: StatusTolerantApiCallOptions
): Promise<ApiCallResult> {
  const result = await options.execute()
  if (result.ok || options.allowedStatuses.includes(result.status)) return result
  throw new Error(formatApiErrorMessage(options.step, result.status, result.body))
}
