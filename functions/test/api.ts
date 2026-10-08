import { randomUUID } from "node:crypto"
import { expect } from "vitest"
import { HttpError } from "../src/http/errors"
import { ROUTES, createRouter } from "../src/http/router"
import { bindHttpSession, firmlessFromToken, verifyBearer } from "../src/p5/auth"
import { CallAudit, runAudited } from "../src/p5/common"
import { mockRes } from "./emu"

/**
 * Drives a P5 operation through the HTTP `api` router — the only entry point (U-1) — the
 * way a client would: `Authorization: Bearer <token>`, `X-Firm-Id` from `data.firmId`
 * (removed from the body: the firm never comes from the body), a fresh Idempotency-Key (POST only; a GET route sends the rest of `data` as its query), and
 * a unique client IP (so one test's auth failures never spend another's per-IP limit).
 * A 2xx answer resolves with the JSON body; anything else rejects with an ApiError.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number
  ) {
    super(`${status} ${code}`)
    this.name = "ApiError"
  }
}

/** One call: the caller's ID token (null = none) and the operation's data, `firmId` included. */
export type ApiCall = { token: string | null; data: Record<string, unknown>; headers?: Record<string, string> }

export function apiCall(token: string | null, data: Record<string, unknown>): never {
  return { token, data } as never
}

const ROUTE_BY_NAME = new Map(ROUTES.map((route) => [route.path.split("/").pop()!, route]))

let ipCounter = 0
const nextIp = () => {
  ipCounter += 1
  return `198.51.${(ipCounter >> 8) & 255}.${ipCounter & 255}`
}

/** The operation `name` (e.g. "createFirmUser") as a function of one ApiCall. */
export function viaApi<T = Record<string, unknown>>(name: string, opts: { now?: () => number } = {}): (call: never) => Promise<T> {
  const route = ROUTE_BY_NAME.get(name)
  if (!route) throw new Error(`no HTTP route for ${name}`)
  const router = createRouter(ROUTES, opts)
  return async (raw: never) => {
    const call = raw as ApiCall
    const { firmId, ...body } = call.data ?? {}
    const isGet = route.method === "GET"
    const headers: Record<string, string> = {
      "x-forwarded-for": nextIp(),
      ...(isGet ? {} : { "content-type": "application/json", "idempotency-key": randomUUID() }),
      ...call.headers,
    }
    if (call.token) headers.authorization = `Bearer ${call.token}`
    if (typeof firmId === "string") headers["x-firm-id"] = firmId
    const { res, out } = mockRes()
    // GET routes carry the remaining data as the query string (string values, as express parses them).
    const query = isGet ? Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) : undefined
    const req = isGet
      ? { method: route.method, path: route.path, headers, body: {}, query, ip: "127.0.0.1" }
      : { method: route.method, path: route.path, headers, body, rawBody: Buffer.from(JSON.stringify(body)), ip: "127.0.0.1" }
    await router(req as never, res as never)
    if (out.status >= 200 && out.status < 300) return out.body as T
    const code = (out.body as { error?: { code?: string } } | undefined)?.error?.code ?? "unknown"
    const retryAfter = out.headers["retry-after"] !== undefined ? Number(out.headers["retry-after"]) : undefined
    throw new ApiError(out.status, code, retryAfter)
  }
}

/**
 * The operation core `name`, run the way the router runs it after authentication (same
 * verifyBearer / bindHttpSession binding, one CallAudit row through runAudited) but without
 * the router's rate limiting and idempotency. For failure-injection tests that stub a Firestore
 * primitive (e.g. runTransaction) the router itself also uses. Errors become ApiErrors as the
 * router would answer them (a non-HttpError is 500 internal).
 */
export function viaCore<T = Record<string, unknown>>(name: string): (call: never) => Promise<T> {
  const route = ROUTE_BY_NAME.get(name)
  if (!route) throw new Error(`no HTTP route for ${name}`)
  const op = route.handler
  return async (raw: never) => {
    const call = raw as ApiCall
    const { firmId, ...body } = call.data ?? {}
    const headers: Record<string, string> = { ...call.headers }
    if (call.token) headers.authorization = `Bearer ${call.token}`
    if (typeof firmId === "string") headers["x-firm-id"] = firmId
    try {
      const decoded = await verifyBearer(headers)
      if (op.auth === "firmless") {
        const who = await firmlessFromToken(decoded)
        const audit = new CallAudit(op.action, who.uid, op.target)
        return (await runAudited(audit, () => op.run(who, body, audit))) as T
      }
      const mfaExempt = op.mfaExempt?.(decoded.uid, body) === true
      const { caller, secondFactor } = await bindHttpSession(decoded, headers, { mfaExempt })
      const audit = new CallAudit(op.action, caller.uid, op.target)
      return (await runAudited(audit, () => op.run({ caller, secondFactor }, body, audit))) as T
    } catch (err) {
      throw err instanceof HttpError ? new ApiError(err.status, err.code) : new ApiError(500, "internal")
    }
  }
}

/** The rejection of `p` (an ApiError), or a failure when it resolves. */
export async function apiErrorOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    if (!(e instanceof ApiError)) throw e
    return e
  }
  throw new Error("expected an ApiError, the call succeeded")
}

/**
 * The HTTP status the api answers for each error kind the former callables reported
 * (functions-error-code → status), so a test can state the kind of refusal it expects.
 */
export const STATUS_OF_KIND: Readonly<Record<string, number>> = {
  "invalid-argument": 400,
  unauthenticated: 401,
  "permission-denied": 403,
  "not-found": 404,
  "already-exists": 409,
  "failed-precondition": 409,
  "resource-exhausted": 429,
  internal: 500,
  unavailable: 503,
}

/** `err` is the api's answer for an error of `kind` (e.g. "permission-denied") with code `code`. */
export function expectKind(err: ApiError, kind: string, code: string): void {
  expect({ status: err.status, code: err.code }).toEqual({ status: STATUS_OF_KIND[kind], code })
}
