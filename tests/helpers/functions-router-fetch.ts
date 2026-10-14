import { randomUUID } from "node:crypto"
import { createRouter, ROUTES } from "../../functions/src/http/router"
import { mockRes } from "../../functions/test/emu"

let ipCounter = 0
const nextIp = () => {
  ipCounter += 1
  return `198.51.${(ipCounter >> 8) & 255}.${ipCounter & 255}`
}

/**
 * In-process Functions HTTP `api` router (Auth/Firestore emulators). Used by console
 * Functions client e2e tests without starting the Functions emulator port.
 */
export async function functionsRouterFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  const url = new URL(input, "http://127.0.0.1")
  const router = createRouter(ROUTES)
  const method = (init?.method ?? "GET").toUpperCase()
  const route = ROUTES.find((r) => r.path === url.pathname && r.method === method)
  if (!route) {
    return new Response(JSON.stringify({ error: { code: "route_not_found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  }
  const headers: Record<string, string> = {
    "x-forwarded-for": nextIp(),
  }
  if (init?.headers) {
    const raw = init.headers
    if (raw instanceof Headers) {
      raw.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
    } else if (Array.isArray(raw)) {
      for (const [key, value] of raw) headers[key.toLowerCase()] = value
    } else {
      for (const [key, value] of Object.entries(raw)) headers[key.toLowerCase()] = value
    }
  }
  if (method !== "GET" && !headers["content-type"]) {
    headers["content-type"] = "application/json"
  }
  if (method !== "GET" && !headers["idempotency-key"]) {
    headers["idempotency-key"] = randomUUID()
  }
  const rawBody = init?.body ? Buffer.from(String(init.body)) : Buffer.alloc(0)
  let body: Record<string, unknown> = {}
  if (rawBody.length > 0) {
    body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>
  }
  const isGet = method === "GET"
  const query = isGet
    ? Object.fromEntries(url.searchParams.entries())
    : undefined
  const { res, out } = mockRes()
  const req = isGet
    ? { method, path: route.path, headers, body: {}, query, ip: "127.0.0.1" }
    : { method, path: route.path, headers, body, rawBody, ip: "127.0.0.1" }
  await router(req as never, res as never)
  return new Response(JSON.stringify(out.body ?? null), {
    status: out.status || 500,
    headers: { "content-type": "application/json", ...out.headers },
  })
}
