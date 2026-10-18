import http from "node:http"
import type { AddressInfo } from "node:net"

/**
 * Serves the real Cloud Functions `api` router (functions/src/http/router.ts `createRouter(ROUTES)`) on a loopback port,
 * the way the `onRequest` wrapper hands it an express request: lower-case headers, the parsed JSON body, the raw body,
 * the query as strings and the client IP. Used by the audit F18 e2e so the Next route's forward reaches the same router
 * code that is deployed, in this process, with the Functions P1 test transport standing in for the Gateway.
 *
 * Every request is recorded (method, path, the headers the forward is expected to carry), so a test can show what the
 * Functions side received.
 */

export type RouterLike = (req: never, res: never) => Promise<void>

export type ReceivedRequest = {
  method: string
  path: string
  authorization: string | undefined
  firmId: string | undefined
  idempotencyKey: string | undefined
  body: unknown
}

export type FunctionsRouterServer = {
  baseUrl: string
  received: ReceivedRequest[]
  close: () => Promise<void>
}

function headerOf(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

export async function startFunctionsRouterServer(router: RouterLike): Promise<FunctionsRouterServer> {
  const received: ReceivedRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks)
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      let body: unknown = {}
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString("utf8"))
        } catch {
          body = rawBody.toString("utf8")
        }
      }
      received.push({
        method: req.method ?? "",
        path: url.pathname,
        authorization: headerOf(req.headers, "authorization"),
        firmId: headerOf(req.headers, "x-firm-id"),
        idempotencyKey: headerOf(req.headers, "idempotency-key"),
        body,
      })
      let status = 200
      const outHeaders: Record<string, string> = {}
      const resLike = {
        status(n: number) {
          status = n
          return resLike
        },
        set(name: string, value: string) {
          outHeaders[name] = value
          return resLike
        },
        json(payload: unknown) {
          res.writeHead(status, { ...outHeaders, "content-type": "application/json" })
          res.end(JSON.stringify(payload))
          return resLike
        },
      }
      const reqLike = {
        method: req.method ?? "GET",
        path: url.pathname,
        headers: req.headers,
        body,
        rawBody,
        query: Object.fromEntries(url.searchParams.entries()),
        ip: "127.0.0.1",
      }
      router(reqLike as never, resLike as never).catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: { code: "test_server_error", message: String(err) } }))
        }
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A loopback port that nothing listens on (bound, then released). */
export async function closedLoopbackPort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
