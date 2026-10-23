import type { z } from "zod"
import { errorResponse } from "@/platform/http/errors"

/**
 * A route's declared request surface: everything a caller can use to select
 * what the route reads or does. Routes in Gate G-2 scope keep it in a sibling
 * `surface.ts` (route modules may export only Next.js route names) and read
 * their selectors only through the helpers below, which refuse undeclared
 * keys:
 *
 * - `views`: values of the `view` query param (`defaultView` when absent);
 * - `actions`: values of the body's `action`, each with the body fields it
 *   reads (`bodyFields`, derived from the zod schema where the route has one);
 * - `queryParams`: every query key the route reads, including the identity
 *   keys withSession binds (actorId, userId, firmId);
 * - `headers`: the request headers the handler may read (the platform reads
 *   auth and firm binding before it; the handler reads idempotency-key and
 *   content-type); all others are stripped;
 * - `commands`: the WhatsApp commands an action dispatches, when it has any.
 *
 * withSession refuses a request carrying an undeclared query param with 400
 * `unknown_param`; `refuseUndeclaredBody` does the same for body fields.
 * Undeclared headers are not refused (proxies and browsers add their own) but
 * are removed: the handler's Request carries only the declared headers, and
 * no cookie unless `cookie` is declared.
 * Gate G-2 inventories these objects, and a static guard
 * (tests/g2.surface-guard.test.ts) fails any direct `searchParams` /
 * `headers.get` / `.action` / bracket / destructuring / switch selector read
 * in the routes that have one.
 */
export type RouteSurface = {
  readonly views: readonly string[]
  readonly defaultView?: string
  readonly actions: readonly string[]
  readonly bodyFields: Readonly<Record<string, readonly string[]>>
  readonly queryParams: readonly string[]
  readonly headers: readonly string[]
  readonly commands?: readonly string[]
}

/** The headers every withSession route depends on. */
export const SESSION_HEADERS = ["authorization", "x-firm-id", "idempotency-key", "content-type"] as const

/** True when the request carries a Bearer token the Functions router can verify. */
export function presentingBearer(request: Request): boolean {
  const value = request.headers.get("authorization")
  return typeof value === "string" && /^Bearer\s+\S+/i.test(value)
}

/** The query keys withSession binds to the caller (and injects when absent). */
export const IDENTITY_PARAMS = ["actorId", "userId", "firmId"] as const

/** A declared-key violation in route code (a programming error, not a client error). */
export class SurfaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SurfaceError"
  }
}

/** Checks a surface is self-consistent: every action has its body fields, the default view is a view. */
export function defineSurface<S extends RouteSurface>(surface: S): S {
  const fieldActions = Object.keys(surface.bodyFields).sort()
  if (JSON.stringify(fieldActions) !== JSON.stringify([...surface.actions].sort())) {
    throw new SurfaceError(`bodyFields must list exactly the declared actions`)
  }
  if (surface.defaultView !== undefined && !surface.views.includes(surface.defaultView)) {
    throw new SurfaceError(`defaultView ${surface.defaultView} is not a declared view`)
  }
  if (surface.views.length > 0 && !surface.queryParams.includes("view")) {
    throw new SurfaceError(`views need the "view" query param declared`)
  }
  return surface
}

type ZodObjectLike = { shape: Record<string, unknown> }
type UnionLike = { options: readonly ZodObjectLike[] }

/** Body fields per action from a `z.discriminatedUnion("action", [...])` schema. */
export function bodyFieldsOf(schema: z.ZodType): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {}
  for (const option of (schema as unknown as UnionLike).options) {
    const action = (option.shape.action as { value?: unknown; def?: { values?: unknown[] } })
    const values = action.def?.values ?? [action.value]
    for (const value of values) out[String(value)] = Object.keys(option.shape).sort()
  }
  return out
}

/** A declared query param's value (null when absent). Throws SurfaceError for an undeclared key. */
export function getQuery(surface: RouteSurface, url: URL, key: string): string | null {
  if (!surface.queryParams.includes(key)) throw new SurfaceError(`query param "${key}" is not declared`)
  return url.searchParams.get(key)
}

/**
 * The requested view: `defaultView` when absent, the value when declared,
 * `undefined` when present but not declared (the route answers it as it did an
 * unknown view).
 */
export function selectView(surface: RouteSurface, url: URL): string | undefined {
  const raw = getQuery(surface, url, "view")
  if (raw === null || raw === "") return surface.defaultView
  return surface.views.includes(raw) ? raw : undefined
}

function rawAction(body: unknown): unknown {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).action
    : undefined
}

/** The body's action: the value when declared, `null` when absent or empty, `undefined` when not declared. */
export function actionOf(surface: RouteSurface, body: unknown): string | null | undefined {
  const raw = rawAction(body)
  if (raw === undefined || raw === null || raw === "") return null
  return typeof raw === "string" && surface.actions.includes(raw) ? raw : undefined
}

/**
 * True when the body's action is `action`, narrowing the body to that variant.
 * Throws SurfaceError when `action` is not declared (route code may only
 * dispatch on declared actions).
 */
export function isAction<B, A extends string>(
  surface: RouteSurface,
  body: B,
  action: A
): body is Extract<B, { action: A }> {
  if (!surface.actions.includes(action)) throw new SurfaceError(`action "${action}" is not declared`)
  return rawAction(body) === action
}

/** The first query key of `url` that `surface` does not declare. */
export function undeclaredQueryParam(surface: RouteSurface, url: URL): string | undefined {
  return [...url.searchParams.keys()].find((key) => !surface.queryParams.includes(key))
}

export function unknownParamResponse(where: string, key: string) {
  return errorResponse(400, "unknown_param", `unknown ${where} parameter: ${key}`)
}

/**
 * 400 `unknown_param` when the body carries a field its (declared) action does
 * not read; null otherwise. An absent or undeclared action is left to the
 * route's own answer.
 */
export function refuseUndeclaredBody(surface: RouteSurface, body: unknown) {
  const action = actionOf(surface, body)
  if (!action) return null
  const fields = surface.bodyFields[action]
  const extra = Object.keys(body as Record<string, unknown>).find((key) => !fields.includes(key))
  return extra === undefined ? null : unknownParamResponse("body", extra)
}
