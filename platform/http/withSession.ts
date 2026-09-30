/**
 * Route boundary for every app/api handler.
 *
 *   // in app/api/<area>/<name>/route.ts, for each exported HTTP method:
 *   //   return withSession(request, handleGet)
 *   // (the original handler body is renamed to `handleGet` / `handlePost`)
 *
 * 1. Resolves the caller via P5 `resolveSession` (401/403/503 on failure).
 * 2. Binds the request to that caller so the (unchanged) handler cannot be
 *    driven as someone else:
 *      - every `actorId` / `userId` in the query string or top-level JSON body
 *        must equal the session user, and every `firmId` the session firm,
 *        otherwise 403 IDENTITY_MISMATCH;
 *      - when absent they are injected (query: actorId + userId; body: actorId),
 *        so handlers that read the identity from the request see the session.
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
import { AuthError, resolveSession, type Session } from "@/platform/p5/session"
import { errorResponse, internalErrorResponse } from "@/platform/http/errors"

export type RouteHandler = (request: Request) => Promise<Response> | Response

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
}

const IDENTITY_KEYS = ["actorId", "userId"] as const
const FIRM_KEY = "firmId"

function mismatch(): Response {
  return errorResponse(403, "IDENTITY_MISMATCH", "request identity does not match the session")
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === ""
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

  const method = request.method.toUpperCase()
  let body: string | undefined
  if (method !== "GET" && method !== "HEAD") {
    body = await request.text()
    let parsed: unknown
    try {
      parsed = body.length > 0 ? JSON.parse(body) : undefined
    } catch {
      parsed = undefined // not JSON: the handler reports its own 400
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      for (const key of IDENTITY_KEYS) {
        if (!isAbsent(record[key]) && record[key] !== session.userId) return mismatch()
      }
      if (!isAbsent(record[FIRM_KEY]) && record[FIRM_KEY] !== session.firmId) return mismatch()
      if (isAbsent(record.actorId)) {
        record.actorId = session.userId
        body = JSON.stringify(record)
      }
    }
  }

  const headers = new Headers(request.headers)
  headers.delete("content-length")
  return new Request(url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  })
}

function describe(request: Request): string {
  try {
    return `${request.method} ${new URL(request.url).pathname}`
  } catch {
    return request.method
  }
}

export async function withSession(
  request: Request,
  handler: RouteHandler,
  options: SessionRouteOptions = {}
): Promise<Response> {
  try {
    if (options.public) return await handler(request)

    let session: Awaited<ReturnType<typeof resolveSession>>
    try {
      session = await resolveSession(request)
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.status >= 500) console.error("[auth]", err.message)
        return errorResponse(err.status, err.code, err.status >= 500 ? "auth not configured" : err.message)
      }
      throw err
    }
    if (session.mode === "insecure-dev") return await handler(request)

    const bound = await bindRequestToSession(request, session, options)
    if (bound instanceof Response) return bound
    return await handler(bound)
  } catch (err) {
    return internalErrorResponse(err, describe(request))
  }
}
