import { consoleAuthHeaders, type ConsoleAuthContext } from "@/lib/console/auth-headers"
import { tryDispatchConsoleCallToFunctions, type ConsoleApiCallOptions } from "@/lib/console/console-functions-dispatch"
import { functionsApiBaseUrl } from "@/lib/console/functions-emulator-url"
import { idempotencyKeyForUserAction, type IdempotentUserAction } from "@/lib/console/idempotency"
import type { FunctionsFetch } from "@/lib/console/functions-client"

export type ConsoleApiCallResult = {
  ok: boolean
  status: number
  body: unknown
  /** Resolved URL (Functions base or relative Next path). */
  url: string
  transport: "functions" | "next"
}

export type ConsoleApiCallRequest = ConsoleApiCallOptions & {
  /** When set, POST idempotency keys are stable across retries of this action. */
  idempotentAction?: IdempotentUserAction
}

export async function executeConsoleApiCall(
  auth: ConsoleAuthContext,
  options: ConsoleApiCallRequest,
  deps: {
    fetchImpl?: typeof fetch
    functionsFetchImpl?: FunctionsFetch
  } = {}
): Promise<ConsoleApiCallResult> {
  let idempotencyKey = options.idempotencyKey
  if (options.method === "POST") {
    idempotencyKey = await idempotencyKeyForUserAction(
      options.idempotentAction ?? { idempotencyKey: options.idempotencyKey }
    )
  }

  const withKey = { ...options, idempotencyKey }
  const functionsResult = await tryDispatchConsoleCallToFunctions(
    auth,
    withKey,
    deps.functionsFetchImpl
  )
  if (functionsResult !== null) {
    const base = functionsApiBaseUrl()
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === "") continue
      qs.set(key, String(value))
    }
    const path =
      options.path === "/api/p1/committee-brain"
        ? "/api/platform/brain/committeeBrain"
        : options.path
    const url = `${base}${path}${qs.toString() ? `?${qs.toString()}` : ""}`
    return {
      ok: functionsResult.ok,
      status: functionsResult.status,
      body: functionsResult.body,
      url,
      transport: "functions",
    }
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === "") continue
    params.set(key, String(value))
  }
  const query = params.toString()
  const url = query ? `${options.path}?${query}` : options.path
  const headers = consoleAuthHeaders(auth, {
    idempotencyKey: options.method === "POST" ? idempotencyKey : undefined,
  })
  const requestInit: RequestInit = {
    method: options.method,
    headers,
  }
  if (options.body !== undefined) {
    requestInit.body = JSON.stringify(options.body)
  }
  const fetchFn = deps.fetchImpl ?? fetch
  const response = await fetchFn(url, requestInit)
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text ? (JSON.parse(text) as unknown) : null
  } catch {
    parsed = text
  }
  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
    url,
    transport: "next",
  }
}
