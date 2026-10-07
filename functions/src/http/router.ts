import { onRequest, type Request } from "firebase-functions/v2/https"
import type { Response } from "express"
import { INGRESS_SETTINGS } from "../deployConfig"
import { FUNCTION_TIMEOUT_SECONDS, REGION } from "../health"
import { TokenRejectedError, bindHttpSession, firmlessFromToken, verifyBearer } from "../p5/auth"
import { CallAudit, runAudited, type Data, type FirmlessIdentity, type Operation, type Session } from "../p5/common"
import { header, type Headers } from "./headers"
import {
  approveMfaDisableOp,
  disableMfaOp,
  enforceMfaForRoleOp,
  generateRecoveryCodesOp,
  syncMfaStatusOp,
} from "../p5/mfa"
import { createFirmUserOp, deactivateUserOp, onboardFirmOp, setUserClaimsOp } from "../p5/identity"
import { recordGatePassOp } from "../p5/gates"
import { setFirmNumberingOp } from "../d1/client/numberingOp"
import { getClientOp, listClientsOp, registerClientOp } from "../d1/client/ops"
import { getConflictResultOp, runConflictCheckOp } from "../d1/conflict/ops"
import { HttpError } from "./errors"
import { withIdempotency, type HttpResult } from "./idempotency"
import { logFailure } from "../log"
import { RateLimitedError, clientIp, rateLimit, rateLimitAnonymous, type RateKind } from "./rateLimit"

/**
 * The HTTP entry `api` (L18 §4.1): GET/POST/PUT under /api/{domain}/{service}/{function},
 * with `Authorization: Bearer <ID token>` and `X-Firm-Id`. It is the only entry point to
 * the P5 operations (U-1: there are no onCall callables); the firm comes from X-Firm-Id,
 * never the body, and every POST needs an Idempotency-Key.
 *
 * Per request: route (404 route_not_found / 405 method_not_allowed) → body
 * checks for POST/PUT (413 payload_too_large over 1 MB, 415
 * unsupported_media_type unless JSON, 400 invalid_body unless an object) →
 * auth (401/403; a failure is audited as a deny unless the client IP is over
 * its per-minute limit, then 429) → per-user rate limit (429 + Retry-After) →
 * idempotency for POST/PUT (400 / 409 / 422, each audited as a deny; a replay
 * is not audited) → handler.
 *
 * Responses: 2xx → the operation's JSON result; errors → `{ error: { code } }`.
 * GET data is the parsed query (string values only; 400 invalid_query otherwise); list GETs
 * paginate with d1/pagination.ts (§4.3).
 */

export type Method = "GET" | "POST" | "PUT"

export type Route = {
  method: Method
  path: string
  handler: Operation
  kind: RateKind
  /** Replays of a 2xx response return `{ redacted: true }`: the body carries secrets that are never stored. */
  redactReplay?: boolean
}

export const MAX_BODY_BYTES = 1024 * 1024

const IDENTITY = "/api/platform/identity"
const GATES = "/api/platform/gates"
const D1_CLIENT = "/api/d1/client"
const D1_CONFLICT = "/api/d1/conflict"

/** A POST route whose rate-limit kind is the operation's own. */
const post = (path: string, handler: Operation, extra: Pick<Route, "redactReplay"> = {}): Route => ({
  method: "POST",
  path,
  handler,
  kind: handler.kind,
  ...extra,
})

/** A GET route; its data is the query string. */
const get = (path: string, handler: Operation): Route => ({ method: "GET", path, handler, kind: handler.kind })

export const ROUTES: readonly Route[] = [
  post(`${IDENTITY}/onboardFirm`, onboardFirmOp),
  post(`${IDENTITY}/createFirmUser`, createFirmUserOp),
  post(`${IDENTITY}/setUserClaims`, setUserClaimsOp),
  post(`${IDENTITY}/deactivateUser`, deactivateUserOp),
  post(`${IDENTITY}/enforceMfaForRole`, enforceMfaForRoleOp),
  post(`${IDENTITY}/approveMfaDisable`, approveMfaDisableOp),
  post(`${IDENTITY}/disableMfa`, disableMfaOp),
  post(`${IDENTITY}/generateRecoveryCodes`, generateRecoveryCodesOp, { redactReplay: true }),
  post(`${IDENTITY}/syncMfaStatus`, syncMfaStatusOp),
  // firmless (platformAdmin): R-5 gate passes; no X-Firm-Id, like onboardFirm (E-26 exception)
  post(`${GATES}/recordGatePass`, recordGatePassOp),
  post(`${D1_CLIENT}/setFirmNumbering`, setFirmNumberingOp),
  post(`${D1_CLIENT}/registerClient`, registerClientOp),
  get(`${D1_CLIENT}/getClient`, getClientOp),
  get(`${D1_CLIENT}/listClients`, listClientsOp),
  post(`${D1_CONFLICT}/runConflictCheck`, runConflictCheckOp),
  get(`${D1_CONFLICT}/getConflictResult`, getConflictResultOp),
]

type RouteTable = Map<string, Map<Method, Route>>

/** Indexes routes by path then method. A repeated method + path throws (the duplicate-route guard). */
export function buildRouteTable(routes: readonly Route[]): RouteTable {
  const table: RouteTable = new Map()
  for (const route of routes) {
    const byMethod = table.get(route.path) ?? new Map<Method, Route>()
    if (byMethod.has(route.method)) throw new Error(`duplicate route ${route.method} ${route.path}`)
    byMethod.set(route.method, route)
    table.set(route.path, byMethod)
  }
  return table
}

type ApiRequest = Pick<Request, "method" | "path" | "headers" | "body" | "ip"> & { rawBody?: Buffer; query?: unknown }
type Authenticated =
  | { kind: "firm"; session: Session; firm: Record<string, unknown> | undefined }
  | { kind: "firmless"; who: FirmlessIdentity }

const errorBody = (code: string) => ({ error: { code } })

function send(res: Response, result: HttpResult, headers: Record<string, string> = {}): void {
  res.status(result.status)
  for (const [name, value] of Object.entries({ ...result.headers, ...headers })) res.set(name, value)
  res.json(result.body)
}

/** A direct function URL may arrive without the `/api` prefix; trailing slashes are ignored. */
function normalisePath(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path
  return trimmed.startsWith("/api/") ? trimmed : `/api${trimmed}`
}

function isJson(contentType: string | undefined): boolean {
  return /^application\/json\s*(;|$)/i.test(contentType ?? "")
}

/** GET data: the parsed query, string values only (a repeated or nested parameter is invalid_query). */
function queryData(query: unknown): Data {
  if (query === undefined || query === null) return {}
  if (!isObject(query)) throw new HttpError(400, "invalid_query")
  const data: Data = {}
  for (const [name, value] of Object.entries(query)) {
    if (typeof value !== "string") throw new HttpError(400, "invalid_query")
    data[name] = value
  }
  return data
}

function isObject(value: unknown): value is Data {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Verifies the token, then binds it the way the route's operation needs (firm-bound or firmless). */
async function authenticate(op: Operation, headers: Headers, body: Data): Promise<Authenticated> {
  const decoded = await verifyBearer(headers).catch((err: unknown) => {
    // A revoked or disabled token names its (signature-verified) uid for the audit row; see verifyBearer.
    throw new AuthFailure(err, (err instanceof TokenRejectedError && err.uid) || "anonymous")
  })
  try {
    if (op.auth === "firmless") return { kind: "firmless", who: await firmlessFromToken(decoded) }
    const mfaExempt = op.mfaExempt?.(decoded.uid, body) === true
    const { caller, secondFactor, firm } = await bindHttpSession(decoded, headers, { mfaExempt })
    return { kind: "firm", session: { caller, secondFactor }, firm }
  } catch (err) {
    throw new AuthFailure(err, decoded.uid)
  }
}

class AuthFailure extends Error {
  constructor(
    readonly cause: unknown,
    readonly actorId: string
  ) {
    super("auth failure")
  }
}

/**
 * An authentication failure: counts against the client IP's per-minute limit
 * (over it → 429, with no audit row), then is audited as a deny under the
 * route's action, and answered with its own status.
 */
async function authFailed(op: Operation, req: ApiRequest, failure: AuthFailure, now: number): Promise<never> {
  if (!(failure.cause instanceof HttpError)) throw failure.cause
  await rateLimitAnonymous(clientIp(req), now)
  await new CallAudit(op.action, failure.actorId, op.target).deny(failure.cause.code)
  throw failure.cause
}

/** Idempotency refusals that are new decisions about the request, so each gets a deny row. */
const IDEMPOTENCY_REFUSALS: ReadonlySet<string> = new Set([
  "idempotency_key_required",
  "idempotency_in_progress",
  "idempotency_key_reused",
])

/**
 * Audits an idempotency refusal (400 / 409 / 422) as a deny under the route's
 * action, then rethrows it. A replay is deliberately *not* audited: it is not
 * a new decision, only the stored answer to one that already has its row.
 */
async function auditRefusal(op: Operation, uid: string, firmId: string, err: unknown): Promise<never> {
  if (err instanceof HttpError && IDEMPOTENCY_REFUSALS.has(err.code)) {
    const audit = new CallAudit(op.action, uid, op.target)
    audit.firmId = firmId
    await audit.deny(err.code)
  }
  throw err
}

/**
 * Runs the operation with its one audit row; errors become their HTTP result. A firm operation
 * gets the router's clock as `session.now`. An operation's RateLimitedError (e.g. 429
 * daily_limit) keeps its Retry-After header; a 429 is never stored for idempotent replay
 * (isStorableResult), so a same-key retry after the reset runs.
 */
async function execute(op: Operation, auth: Authenticated, body: Data, now: number): Promise<HttpResult> {
  const uid = auth.kind === "firm" ? auth.session.caller.uid : auth.who.uid
  const audit = new CallAudit(op.action, uid, op.target)
  try {
    const result = await runAudited(audit, () =>
      op.auth === "firm" && auth.kind === "firm" ? op.run({ ...auth.session, now }, body, audit) : runFirmless(op, auth, body, audit)
    )
    return { status: 200, body: isObject(result) ? result : { result } }
  } catch (err) {
    // runAudited has already logged a non-HttpError.
    if (err instanceof RateLimitedError) {
      return { status: err.status, body: errorBody(err.code), headers: { "Retry-After": String(err.retryAfter) } }
    }
    return err instanceof HttpError ? { status: err.status, body: errorBody(err.code) } : { status: 500, body: errorBody("internal") }
  }
}

function runFirmless(op: Operation, auth: Authenticated, body: Data, audit: CallAudit): Promise<unknown> {
  if (op.auth !== "firmless" || auth.kind !== "firmless") throw new Error("route auth mismatch")
  return op.run(auth.who, body, audit)
}

export function createRouter(routes: readonly Route[], opts: { now?: () => number } = {}) {
  const table = buildRouteTable(routes)
  const clock = opts.now ?? Date.now

  return async function router(req: ApiRequest, res: Response): Promise<void> {
    try {
      const path = normalisePath(req.path)
      const byMethod = table.get(path)
      if (!byMethod) return send(res, { status: 404, body: errorBody("route_not_found") })
      const route = byMethod.get(req.method.toUpperCase() as Method)
      if (!route) {
        return send(res, { status: 405, body: errorBody("method_not_allowed") }, { Allow: [...byMethod.keys()].join(", ") })
      }
      const headers = req.headers as Headers
      const hasBody = route.method !== "GET"
      let body: Data = {}
      if (hasBody) {
        const declared = Number(header(headers, "content-length") ?? 0)
        const size = req.rawBody?.length ?? Buffer.byteLength(JSON.stringify(req.body ?? {}))
        if (declared > MAX_BODY_BYTES || size > MAX_BODY_BYTES) {
          return send(res, { status: 413, body: errorBody("payload_too_large") })
        }
        if (!isJson(header(headers, "content-type"))) return send(res, { status: 415, body: errorBody("unsupported_media_type") })
        if (!isObject(req.body)) return send(res, { status: 400, body: errorBody("invalid_body") })
        body = req.body
      } else {
        body = queryData(req.query)
      }

      const now = clock()
      const op = route.handler
      const auth = await authenticate(op, headers, body).catch((err: unknown) =>
        err instanceof AuthFailure ? authFailed(op, req, err, now) : Promise.reject(err)
      )
      const uid = auth.kind === "firm" ? auth.session.caller.uid : auth.who.uid
      await rateLimit({ uid }, route.kind, { firm: auth.kind === "firm" ? auth.firm : undefined, now })

      const run = () => execute(op, auth, body, now)
      const firmId = auth.kind === "firm" ? auth.session.caller.firmId : ""
      const result = hasBody
        ? await withIdempotency(
            { firmId, uid, route: `${route.method} ${route.path}`, key: header(headers, "idempotency-key"), body, now, redact: route.redactReplay },
            run
          ).catch((err: unknown) => auditRefusal(op, uid, firmId, err))
        : await run()
      send(res, result)
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return send(res, { status: 429, body: errorBody(err.code) }, { "Retry-After": String(err.retryAfter) })
      }
      if (err instanceof HttpError) return send(res, { status: err.status, body: errorBody(err.code) })
      logFailure("api request failed", err)
      send(res, { status: 500, body: errorBody("internal") })
    }
  }
}

/** Built at module load, so a duplicate route fails the deploy bundle's first import. */
const router = createRouter(ROUTES)

export const api = onRequest(
  { region: REGION, timeoutSeconds: FUNCTION_TIMEOUT_SECONDS, ingressSettings: INGRESS_SETTINGS },
  router
)
