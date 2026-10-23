import { parsedBodyForRequest } from "@/platform/http/validation"
import { runWithF02Pending, type F02Session } from "@/platform/authority/f02Registry"
import {
  F02_AUTHORITY_HEADER,
  F02_AUTHORITY_VALUE,
  type F02Method,
  type F02RoutePath,
} from "@/platform/authority/f02Routes"

type Collected = { status: number; headers: Record<string, string>; body: unknown }

function collect(): { res: { status: (n: number) => unknown; set: (name: string, value: string) => unknown; json: (body: unknown) => unknown }; out: Collected } {
  const out: Collected = { status: 0, headers: {}, body: undefined }
  const res = {
    status(n: number) {
      out.status = n
      return res
    },
    set(name: string, value: string) {
      out.headers[name.toLowerCase()] = value
      return res
    },
    json(body: unknown) {
      out.body = body
      return res
    },
  }
  return { res, out }
}

type RouterFn = (req: unknown, res: unknown) => Promise<void>
let routerPromise: Promise<RouterFn> | null = null

function functionsRouter(): Promise<RouterFn> {
  if (!routerPromise) {
    routerPromise = import("../../functions/src/http/f02RouterBoundary").then(
      (mod) => mod.createF02Router() as unknown as RouterFn
    )
  }
  return routerPromise
}

/** Test hook: the next dispatch loads the router again (a route table change). */
export function resetF02RouterForTests(): void {
  routerPromise = null
}

/**
 * Dispatches one F02 authority route through the bounded Functions router
 * (`functions/src/http/f02RouterBoundary`, not the deployed `api` ROUTES table).
 * The boundary mounts only `F02_NEXT_AUTHORITY_ROUTES` so this process never loads
 * `p1/ops` or the paid transport (FA-F18-013/014). The caller is re-authenticated
 * from Authorization and X-Firm-Id; the core runs only after that router's
 * permission checks. A direct call on the deployed function, where no Next core
 * is registered, is 503 authority_core_unconfigured.
 */
export async function dispatchF02(
  request: Request,
  path: F02RoutePath,
  method: F02Method,
  session: F02Session
): Promise<Response> {
  return runWithF02Pending(request, session, async () => {
    const router = await functionsRouter()
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    if (!headers["x-forwarded-for"]) headers["x-forwarded-for"] = "127.0.0.1"
    const isGet = method === "GET"
    let body: Record<string, unknown> = {}
    if (!isGet) {
      const parsed = parsedBodyForRequest(request)
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
      if (!headers["content-type"]) headers["content-type"] = "application/json"
    }
    const rawBody = Buffer.from(JSON.stringify(body))
    const url = new URL(request.url)
    const { res, out } = collect()
    await router(
      {
        method,
        path,
        headers,
        body: isGet ? {} : body,
        rawBody: isGet ? undefined : rawBody,
        query: isGet ? Object.fromEntries(url.searchParams.entries()) : undefined,
        ip: "127.0.0.1",
      },
      res
    )
    const responseHeaders = new Headers()
    for (const [name, value] of Object.entries(out.headers)) responseHeaders.set(name, value)
    responseHeaders.set("content-type", "application/json")
    responseHeaders.set(F02_AUTHORITY_HEADER, F02_AUTHORITY_VALUE)
    return new Response(JSON.stringify(out.body ?? null), {
      status: out.status || 500,
      headers: responseHeaders,
    })
  })
}
