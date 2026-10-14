export type ConsoleAuthContext = {
  idToken: string | null
  firmId: string
}

export function consoleAuthHeaders(
  auth: ConsoleAuthContext,
  options: { idempotencyKey?: string; json?: boolean } = {}
): Headers {
  const headers = new Headers()
  if (options.json ?? true) {
    headers.set("Content-Type", "application/json")
  }
  if (auth.idToken) {
    headers.set("Authorization", `Bearer ${auth.idToken}`)
  }
  if (auth.firmId.trim()) {
    headers.set("X-Firm-Id", auth.firmId.trim())
  }
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey)
  }
  return headers
}
