/**
 * Route boundary for every app/api handler.
 *
 *   // in app/api/<area>/<name>/route.ts, for each exported HTTP method:
 *   //   return withSession(request, handleGet)
 *   // (the original handler body is renamed to `handleGet` / `handlePost`)
 *
 * 1. Resolves the caller via P5 `resolveSession` (401/403/503 on failure) and
 *    passes it to the handler as `handler(request, session)`. The handler runs
 *    inside `runWithSession`, so `store.users.get(callerId)` (and therefore P5
 *    checkPermission) sees clearance = min(record, token claim).
 * 2. Binds the request to that caller so the (unchanged) handler cannot be
 *    driven as someone else:
 *      - every `actorId` / `userId` in the query string or top-level JSON body
 *        must equal the session user, and every `firmId` the session firm,
 *        otherwise 403 IDENTITY_MISMATCH;
 *      - when absent they are injected (query: actorId + userId; body: actorId),
 *        so handlers that read the identity from the request see the session.
 *      - only TOP-LEVEL `actorId` / `userId` / `firmId` keys are bound. Handlers
 *        must not read the caller's identity from nested or differently named
 *        keys; subject ids (targetUserId, secondApproverId, …) are business
 *        fields that the handler must authorise itself.
 * 3. Catches anything the handler throws and returns a generic 500 body with a
 *    stable code; details are logged server-side only.
 *
 * In `insecure-dev` mode (local/tests only) step 2 is skipped: the request's own
 * identity is trusted, exactly as before authentication existed.
 *
 * Public (unauthenticated) routes — keep this list short and reviewed:
 *   - GET /api/g0/monitor  (health / system-status snapshot; no tenant data)
 * Every other app/api route requires a session (enforced by
 * tests/auth.route-coverage.test.ts).
 */
import { assertInsecureDevAuthContext } from "@/platform/p5/insecureDevAuth"
import { AuthError, loadUserRecord, resolveSession, type Session } from "@/platform/p5/session"
import { runWithSession } from "@/platform/p5/requestSession"
import { errorResponse, internalErrorResponse } from "@/platform/http/errors"
import { attachParsedBody, DEFAULT_JSON_BODY_BYTES, readBodyLimited } from "@/platform/http/validation"
import { undeclaredQueryParam, unknownParamResponse, type RouteSurface } from "@/platform/http/surface"
import { runWithRequestAudit } from "@/platform/audit/requestAudit"
import { flushRequestAudit } from "@/platform/persistence/requestAuditFlush"
import { runWithIdempotencyScope, type IdempotencyScope } from "@/platform/http/idempotency"

/**
 * The caller as seen by a handler. `null` only for public routes and for
 * insecure-dev requests whose claimed identity is absent or unknown.
 * `clearance` is already min(record, claim); `role` is the record's.
 */
export type HandlerSession = {
  userId: string
  firmId: string
  role: Session["role"]
  clearance: Session["clearance"]
  mode: "firebase" | "insecure-dev"
}

export type RouteHandler = (
  request: Request,
  session: HandlerSession | null
) => Promise<Response> | Response

export type SessionRouteOptions = {
  /** No authentication at all. Reserved for health/status endpoints. */
  public?: boolean
  /**
   * Identity-named query params that, for this particular request, name a
   * subject/filter rather than the caller (e.g. tenancy `view=session_refs&userId=`).
   * They are neither enforced nor injected; the handler's own permission checks
   * (against the now-authenticated actorId) govern them.
   */
  subjectQueryParams?: (url: URL) => readonly string[]
  /**
   * Byte cap on the request body. The boundary reads the body exactly once, from
   * the network stream, under this cap (413 payload_too_large above it) before
   * binding identity; the parsed value is handed to the handler's
   * `readJsonLimited`, which re-checks its own cap. Defaults to 1 MB
   * (DEFAULT_JSON_BODY_BYTES; SEC-1): only routes that genuinely need more opt
   * in — document upload (the upload ceiling) and drafts (2 MB).
   */
  maxBodyBytes?: number
  /** Limit named in the 413 message (e.g. the decoded upload size). Defaults to `maxBodyBytes`. */
  reportedBodyLimit?: number
  /**
   * The route's declared request surface (platform/http/surface.ts). After the
   * caller is resolved, a query param it does not declare is refused with 400
   * `unknown_param`, and the handler's Request carries only the declared
   * headers (the cookie only if declared).
   */
  surface?: RouteSurface
}

function refuseUndeclaredQuery(request: Request, options: SessionRouteOptions): Response | null {
  if (!options.surface) return null
  const key = undeclaredQueryParam(options.surface, new URL(request.url))
  return key === undefined ? null : unknownParamResponse("query", key)
}

/** Idempotency scope of requests with no resolved caller (public routes, unknown dev identity). */
const PUBLIC_SCOPE: IdempotencyScope = { firmId: "_", userId: "_" }

const IDENTITY_KEYS = ["actorId", "userId"] as const
const FIRM_KEY = "firmId"

function mismatch(): Response {
  return errorResponse(403, "IDENTITY_MISMATCH", "request identity does not match the session")
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === ""
}

function hasBody(request: Request): boolean {
  const method = request.method.toUpperCase()
  return method !== "GET" && method !== "HEAD"
}

type ReadBody =
  | { ok: true; text: string | undefined; bytes: number; parsed: unknown; parsedOk: boolean }
  | { ok: false; response: Response }

/** Reads the body once, under the route's byte cap, and JSON-parses it if possible. */
async function readBoundedBody(request: Request, options: SessionRouteOptions): Promise<ReadBody> {
  if (!hasBody(request)) {
    return { ok: true, text: undefined, bytes: 0, parsed: undefined, parsedOk: false }
  }
  const limit = options.maxBodyBytes ?? DEFAULT_JSON_BODY_BYTES
  const read = await readBodyLimited(request, limit, options.reportedBodyLimit ?? limit)
  if (!read.ok) return read
  const base = { ok: true as const, text: read.text, bytes: read.bytes }
  if (read.text.length === 0) return { ...base, parsed: undefined, parsedOk: false }
  try {
    return { ...base, parsed: JSON.parse(read.text), parsedOk: true }
  } catch {
    // not JSON: the handler reports its own 400
    return { ...base, parsed: undefined, parsedOk: false }
  }
}

/**
 * The request the handler sees: same headers, `url`, the already-read body (re-serialised
 * only when `mutated`), with the parsed value cached for `readJsonLimited`.
 */
function rebuild(
  request: Request,
  url: URL,
  body: ReadBody & { ok: true },
  mutated = false,
  surface?: RouteSurface
): Request {
  const headers = new Headers(request.headers)
  headers.delete("content-length")
  if (surface) {
    // A declared surface is the whole of what the handler can read: undeclared
    // headers (and the cookie, unless declared) read as null in the route and in
    // anything it calls.
    const allowed = new Set(surface.headers.map((h) => h.toLowerCase()))
    for (const name of [...headers.keys()]) if (!allowed.has(name)) headers.delete(name)
  }
  const text = mutated ? JSON.stringify(body.parsed) : body.text
  const next = new Request(url, {
    method: request.method,
    headers,
    body: text,
    signal: request.signal,
  })
  if (body.parsedOk && text !== undefined) {
    // Caps are enforced against the raw wire size, never the re-serialised body
    // (filling in actorId must not push an at-cap request over its limit).
    attachParsedBody(next, body.parsed, body.bytes)
  }
  return next
}

/** Returns the request bound to `session`, or a 403 response. Exported for tests. */
export async function bindRequestToSession(
  request: Request,
  session: Session,
  options: SessionRouteOptions = {}
): Promise<Request | Response> {
  const url = new URL(request.url)
  const subject = new Set(options.subjectQueryParams?.(url) ?? [])
  const queryIdentityKeys = IDENTITY_KEYS.filter((key) => !subject.has(key))

  for (const key of queryIdentityKeys) {
    for (const value of url.searchParams.getAll(key)) {
      if (!isAbsent(value) && value !== session.userId) return mismatch()
    }
  }
  for (const value of url.searchParams.getAll(FIRM_KEY)) {
    if (!isAbsent(value) && value !== session.firmId) return mismatch()
  }
  for (const key of queryIdentityKeys) {
    if (url.searchParams.getAll(key).every(isAbsent)) url.searchParams.set(key, session.userId)
  }

  const body = await readBoundedBody(request, options)
  if (!body.ok) return body.response
  if (body.parsedOk && body.parsed && typeof body.parsed === "object" && !Array.isArray(body.parsed)) {
    const record = body.parsed as Record<string, unknown>
    for (const key of IDENTITY_KEYS) {
      if (!isAbsent(record[key]) && record[key] !== session.userId) return mismatch()
    }
    if (!isAbsent(record[FIRM_KEY]) && record[FIRM_KEY] !== session.firmId) return mismatch()
    if (isAbsent(record.actorId)) {
      record.actorId = session.userId
      return rebuild(request, url, body, true, options.surface)
    }
  }
  return rebuild(request, url, body, false, options.surface)
}

function describe(request: Request): string {
  try {
    return `${request.method} ${new URL(request.url).pathname}`
  } catch {
    return request.method
  }
}

/** insecure-dev only: the identity the request claims (actorId, else userId). */
function claimedIdentity(url: URL, parsed: unknown): string | null {
  const fromQuery = url.searchParams.get("actorId") || url.searchParams.get("userId")
  if (fromQuery) return fromQuery
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    const id = record.actorId ?? record.userId
    return typeof id === "string" && id ? id : null
  }
  return null
}

function claimedFirmIdForInsecureDev(url: URL, parsed: unknown): string | undefined {
  assertInsecureDevAuthContext("claimedFirmIdForInsecureDev")
  const fromQuery = url.searchParams.get("firmId")
  if (fromQuery) return fromQuery
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const firmId = (parsed as Record<string, unknown>).firmId
    return typeof firmId === "string" && firmId ? firmId : undefined
  }
  return undefined
}

/**
 * Runs the handler with a request-scoped audit collector and persists every audit row it
 * created (checkPermission decisions included) before the response leaves — GET and POST
 * alike (review round 1, finding 4). If persisting fails the caller gets 503
 * AUDIT_UNAVAILABLE instead of the response: a read never returns data whose access was not
 * durably audited. For a POST whose effect has already been committed the 503 is still
 * returned and the failure is logged.
 *
 * Final audit F6: the 503 is replay-safe. The route stored its success payload on its
 * idempotency claim before returning, and claims are settled after this flush whatever its
 * outcome (runAudited below), so a same-key retry replays the committed result instead of
 * running the effect again. The failed rows stay on the audit log's retry queue.
 *
 * FOLLOW-UP (outbox): the effect and its audit rows are still not atomic. The durable fix is to
 * stage each effect's audit rows in the same Firestore batch/transaction as the effect (an
 * audit outbox drained to audit_log), as the Cloud Functions identity/MFA paths already do, so
 * a committed effect can never lack its audit row (and a crash between effect and flush cannot
 * lose it). Until then the retry queue + dead-letter path is the safety net.
 */
async function runAudited(
  request: Request,
  scope: IdempotencyScope,
  run: () => Promise<Response> | Response
): Promise<Response> {
  // Idempotency claims taken by the handler are settled after the audit flush, whatever its
  // outcome (platform/http/idempotency.ts).
  return runWithIdempotencyScope(scope, () => runAuditedInner(request, run))
}

async function runAuditedInner(request: Request, run: () => Promise<Response> | Response): Promise<Response> {
  const outcome = await runWithRequestAudit(run)
  try {
    await flushRequestAudit(outcome.rows)
  } catch (err) {
    const committed = hasBody(request) && !("error" in outcome)
    console.error(
      `[audit] could not persist ${outcome.rows.length} audit row(s) for ${describe(request)}` +
        (committed ? " — the request's effect may already be committed (async P5 is the fix)" : ""),
      err
    )
    return errorResponse(503, "AUDIT_UNAVAILABLE", "audit log unavailable")
  }
  if ("error" in outcome) throw outcome.error
  return outcome.value
}

export async function withSession(
  request: Request,
  handler: RouteHandler,
  options: SessionRouteOptions = {}
): Promise<Response> {
  try {
    if (options.public) return await runAudited(request, PUBLIC_SCOPE, () => handler(request, null))

    let session: Awaited<ReturnType<typeof resolveSession>>
    try {
      session = await resolveSession(request)
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.status >= 500) console.error("[auth]", err.message)
        const publicMessage =
          err.code === "IDENTITY_UNAVAILABLE"
            ? "identity service unavailable"
            : err.status >= 500
              ? "auth not configured"
              : err.message
        return errorResponse(err.status, err.code, publicMessage)
      }
      throw err
    }

    if (session.mode === "insecure-dev") {
      // Trust the request's identity (local/tests only), but still hydrate the
      // record from the repository layer so handlers do not see "unknown actor"
      // for a user that exists only in Firestore.
      // The body is still read once, under the same cap as in firebase mode.
      const body = await readBoundedBody(request, options)
      if (!body.ok) return body.response
      const url = new URL(request.url)
      const devRequest = rebuild(request, url, body, false, options.surface)
      const devRefused = refuseUndeclaredQuery(devRequest, options)
      if (devRefused) return devRefused
      const claimed = claimedIdentity(url, body.parsed)
      const record = claimed
        ? await loadUserRecord(claimed, {
            firmId: claimedFirmIdForInsecureDev(url, body.parsed),
          })
        : null
      const devSession: HandlerSession | null = record
        ? {
            userId: record.id,
            firmId: record.firmId,
            role: record.role,
            clearance: record.clearanceLevel,
            mode: "insecure-dev",
          }
        : null
      const devScope = devSession ? { firmId: devSession.firmId, userId: devSession.userId } : PUBLIC_SCOPE
      return await runAudited(request, devScope, () => handler(devRequest, devSession))
    }

    const bound = await bindRequestToSession(request, session, options)
    if (bound instanceof Response) return bound
    const refused = refuseUndeclaredQuery(bound, options)
    if (refused) return refused
    const handlerSession: HandlerSession = {
      userId: session.userId,
      firmId: session.firmId,
      role: session.role,
      clearance: session.clearance,
      mode: "firebase",
    }
    // Code that looks the caller up by id sees clearance = min(record, claim)
    // for this request only.
    return await runWithSession(
      { userId: session.userId, firmId: session.firmId, clearance: session.clearance },
      () =>
        runAudited(request, { firmId: session.firmId, userId: session.userId }, () =>
          handler(bound, handlerSession)
        )
    )
  } catch (err) {
    return internalErrorResponse(err, describe(request))
  }
}
