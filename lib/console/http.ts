import { consoleAuthHeaders, type ConsoleAuthContext } from "@/lib/console/auth-headers"
import { idempotencyKeyForUserAction, type IdempotentUserAction } from "@/lib/console/idempotency"

export type ConsoleHttpResult = {
  ok: boolean
  status: number
  body: unknown
}

export async function consoleHttpRequest(
  auth: ConsoleAuthContext,
  options: {
    method: "GET" | "POST"
    url: string
    body?: unknown
    idempotentAction?: IdempotentUserAction
  }
): Promise<ConsoleHttpResult> {
  const init: RequestInit = { method: options.method }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
  }
  const idempotencyKey =
    options.method === "POST"
      ? await idempotencyKeyForUserAction(options.idempotentAction ?? {})
      : undefined
  const headers = consoleAuthHeaders(auth, { idempotencyKey })
  init.headers = headers
  const response = await fetch(options.url, init)
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text ? (JSON.parse(text) as unknown) : null
  } catch {
    parsed = text
  }
  return { ok: response.ok, status: response.status, body: parsed }
}
