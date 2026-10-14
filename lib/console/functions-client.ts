import { consoleAuthHeaders, type ConsoleAuthContext } from "@/lib/console/auth-headers"
import { functionsApiBaseUrl } from "@/lib/console/functions-emulator-url"
import {
  idempotencyKeyForUserAction,
  type IdempotentUserAction,
} from "@/lib/console/idempotency"

export type FunctionsCallResult<T = unknown> = {
  ok: boolean
  status: number
  body: T
}

export type FunctionsFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>

export async function callFunctionsApi<T = unknown>(
  auth: ConsoleAuthContext,
  options: {
    method: "GET" | "POST" | "PUT"
    path: string
    query?: Record<string, string | number | undefined>
    body?: Record<string, unknown>
    fetchImpl?: FunctionsFetch
    idempotencyKey?: string
    idempotentAction?: IdempotentUserAction
  }
): Promise<FunctionsCallResult<T>> {
  const base = functionsApiBaseUrl()
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === "") continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  const url = `${base}${options.path}${qs ? `?${qs}` : ""}`
  const fetchFn = options.fetchImpl ?? fetch
  const init: RequestInit = { method: options.method, headers: new Headers() }
  if (options.body !== undefined && options.method !== "GET") {
    init.body = JSON.stringify(options.body)
  }
  const idempotencyKey =
    options.method === "GET"
      ? undefined
      : options.idempotencyKey ??
        (await idempotencyKeyForUserAction(options.idempotentAction ?? {}))
  const headers = consoleAuthHeaders(auth, {
    idempotencyKey,
  })
  init.headers = headers
  const response = await fetchFn(url, init)
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
    body: parsed as T,
  }
}

export async function listMattersViaFunctions(
  auth: ConsoleAuthContext,
  query: { limit?: number; cursor?: string } = {},
  fetchImpl?: FunctionsFetch
) {
  return callFunctionsApi(auth, {
    method: "GET",
    path: "/api/d1/matter/listMatters",
    query: {
      firmId: auth.firmId,
      limit: query.limit ?? 10,
      ...(query.cursor !== undefined && query.cursor !== ""
        ? { cursor: query.cursor }
        : {}),
    },
    fetchImpl,
  })
}

export async function committeeBrainViaFunctions(
  auth: ConsoleAuthContext,
  body: {
    body: string
    classification: string
    purpose: string
    partyNames: string[]
  },
  fetchImpl?: FunctionsFetch,
  idempotency?: { idempotencyKey?: string; idempotentAction?: IdempotentUserAction }
) {
  return callFunctionsApi(auth, {
    method: "POST",
    path: "/api/platform/brain/committeeBrain",
    body: {
      firmId: auth.firmId,
      ...body,
    },
    fetchImpl,
    idempotencyKey: idempotency?.idempotencyKey,
    idempotentAction: idempotency?.idempotentAction,
  })
}
