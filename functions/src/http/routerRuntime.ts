import type { Request } from "firebase-functions/v2/https"
import type { Response } from "express"
import { TokenRejectedError, bindHttpSession, firmlessFromToken, verifyBearer } from "../p5/auth"
import { CallAudit, runAudited, type Data, type FirmlessIdentity, type Operation, type Session } from "../p5/common"
import { header, type Headers } from "./headers"
import { CommittedEffectError, EFFECT_COMMITTED_HEADER, HttpError } from "./errors"
import { withIdempotency, type HttpResult, type IdempotencyMode, type IdempotentOperation } from "./idempotency"
import { logFailure } from "../log"
import { RateLimitedError, clientIp, rateLimit, rateLimitAnonymous, type RateKind } from "./rateLimit"

export type Method = "GET" | "POST" | "PUT"

export type Route = {
  method: Method
  path: string
  handler: Operation
  kind: RateKind
  /** Replays of a 2xx response return `{ redacted: true }`: the body carries secrets that are never stored. */
  redactReplay?: boolean
  /**
   * What a same-key request gets once the operation's effect committed without a stored answer (audit F09, spec §2.2):
   * `once` (the default) 409 idempotency_effect_committed; `resume` a takeover that resumes the operation from its
   * marker (committeeBrain); `rerun` no effect marker and a re-run, for an operation idempotent by construction whose
   * post-commit step a same-key retry is designed to heal (spec §4).
   */
  idempotency?: IdempotencyMode
  /**
   * POST/PUT body cap. The default is 1 MB. Document ingest and drafts match the Next route caps
   * (audit F02); a function is read per request so SIKANDER_MAX_UPLOAD_BYTES stays live.
   */
  maxBodyBytes?: number | (() => number)
}

export const MAX_BODY_BYTES = 1024 * 1024

function bodyLimitBytes(route: Route): number {
  const cap = route.maxBodyBytes
  if (typeof cap === "function") return cap()
  return cap ?? MAX_BODY_BYTES
}

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

function committedEffectResult(err: CommittedEffectError): HttpResult {
  return {
    status: err.status,
    body: { error: { code: err.code }, effectCommitted: { operationId: err.operationId } },
    headers: { [EFFECT_COMMITTED_HEADER]: err.operationId },
  }
}

function send(res: Response, result: HttpResult, headers: Record<string, string> = {}): void {
  res.status(result.status)
  for (const [name, value] of Object.entries({ ...result.headers, ...headers })) res.set(name, value)
  res.json(result.body)
}

function normalisePath(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path
  return trimmed.startsWith("/api/") ? trimmed : `/api${trimmed}`
}

function isJson(contentType: string | undefined): boolean {
  return /^application\/json\s*(;|$)/i.test(contentType ?? "")
}

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

async function authenticate(op: Operation, headers: Headers, body: Data): Promise<Authenticated> {
  const decoded = await verifyBearer(headers).catch((err: unknown) => {
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

async function authFailed(op: Operation, req: ApiRequest, failure: AuthFailure, now: number): Promise<never> {
  if (!(failure.cause instanceof HttpError)) throw failure.cause
  await rateLimitAnonymous(clientIp(req), now)
  await new CallAudit(op.action, failure.actorId, op.target).deny(failure.cause.code)
  throw failure.cause
}

const IDEMPOTENCY_REFUSALS: ReadonlySet<string> = new Set([
  "idempotency_key_required",
  "idempotency_in_progress",
  "idempotency_key_reused",
  // Audit F42 (FA-F42-R1-001, spec R21): a stored answer refused because its matter was deleted (or its matter list was
  // cut short). Only the claim throws out of withIdempotency (execute turns a handler's error into a result), so a fresh
  // call's own matter_deleted is audited once, by its handler, and never here.
  "matter_deleted",
  "idempotency_replay_unavailable",
])

async function auditRefusal(op: Operation, uid: string, firmId: string, err: unknown): Promise<never> {
  if (err instanceof HttpError && IDEMPOTENCY_REFUSALS.has(err.code)) {
    const audit = new CallAudit(op.action, uid, op.target)
    audit.firmId = firmId
    await audit.deny(err.code)
  }
  throw err
}

/**
 * Runs one operation after auth and rate limits. `startedAtMs` (the real clock when the router received the request) is
 * passed on as `session.startedAtMs`. `operation` (POST/PUT) is the request's idempotent operation record when
 * idempotency applies.
 */
async function execute(
  op: Operation,
  auth: Authenticated,
  body: Data,
  now: number,
  idempotencyKey?: string,
  routeName?: string,
  startedAtMs?: number,
  operation?: IdempotentOperation
): Promise<HttpResult> {
  const uid = auth.kind === "firm" ? auth.session.caller.uid : auth.who.uid
  const audit = new CallAudit(op.action, uid, op.target)
  if (operation !== undefined && operation.mode !== "rerun") audit.effects = operation
  const started = startedAtMs === undefined ? {} : { startedAtMs }
  const bound = operation === undefined ? {} : { operation }
  const session = (s: Session): Session =>
    idempotencyKey === undefined || routeName === undefined
      ? { ...s, now, ...started }
      : { ...s, now, idempotencyKey, route: routeName, ...started, ...bound }
  try {
    const result = await runAudited(audit, () =>
      op.auth === "firm" && auth.kind === "firm" ? op.run(session(auth.session), body, audit) : runFirmless(op, auth, body, audit)
    )
    return { status: 200, body: isObject(result) ? result : { result } }
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return { status: err.status, body: errorBody(err.code), headers: { "Retry-After": String(err.retryAfter) } }
    }
    if (err instanceof CommittedEffectError) return committedEffectResult(err)
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
    // The real clock, never the injectable one: an operation bounds its pre-work against it (re-audit R3-D2).
    const startedAtMs = Date.now()
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
        const limit = bodyLimitBytes(route)
        if (declared > limit || size > limit) {
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

      const idempotencyKey = hasBody ? header(headers, "idempotency-key") : undefined
      const routeName = `${route.method} ${route.path}`
      const run = (operation?: IdempotentOperation) =>
        execute(op, auth, body, now, idempotencyKey, hasBody ? routeName : undefined, startedAtMs, operation)
      const firmId = auth.kind === "firm" ? auth.session.caller.firmId : ""
      const result = hasBody
        ? await withIdempotency(
            { firmId, uid, route: routeName, key: idempotencyKey, body, now, redact: route.redactReplay, mode: route.idempotency ?? "once" },
            run
          ).catch((err: unknown) => auditRefusal(op, uid, firmId, err))
        : await run()
      send(res, result)
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return send(res, { status: 429, body: errorBody(err.code) }, { "Retry-After": String(err.retryAfter) })
      }
      if (err instanceof CommittedEffectError) return send(res, committedEffectResult(err))
      if (err instanceof HttpError) return send(res, { status: err.status, body: errorBody(err.code) })
      logFailure("api request failed", err)
      send(res, { status: 500, body: errorBody("internal") })
    }
  }
}
