import type { CallableRequest } from "firebase-functions/v2/https"
import { isClassification, type Classification } from "@/platform/p1/types"
import { adminAuth } from "../admin"
import { HttpError } from "../http/errors"

/**
 * Mirrors `Role` in platform/spine/store.ts (guarded by test/p5.role.test.ts).
 * Defined here rather than imported because pulling that file into the
 * functions typecheck surfaces its own unrelated type errors.
 */
export const ROLES = ["partner", "associate", "clerk", "intern", "accounts", "client"] as const
export type Role = (typeof ROLES)[number]

/** Verified identity. Custom claims `firmId`, `role`, `clearanceLevel` are authoritative. */
export type Caller = { uid: string; firmId: string; role: Role; clearanceLevel: Classification }

const ROLE_SET: ReadonlySet<string> = new Set<string>(ROLES)

function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLE_SET.has(value)
}

function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return v
  }
  return undefined
}

/**
 * Builds a Caller from verified token claims and binds it to the requested firm.
 * Missing or malformed claims → 403 no_claims; firm header ≠ claims.firmId → 403 firm_mismatch.
 */
function callerFromClaims(uid: string, claims: Record<string, unknown>, firmIdHeader: string | undefined): Caller {
  const { firmId, role, clearanceLevel } = claims
  if (typeof firmId !== "string" || firmId === "" || !isRole(role) || !isClassification(clearanceLevel)) {
    throw new HttpError(403, "no_claims")
  }
  if (firmIdHeader !== firmId) throw new HttpError(403, "firm_mismatch")
  return { uid, firmId, role, clearanceLevel }
}

/** HTTP (onRequest) identity: verified, revocation-checked Bearer token + X-Firm-Id binding. */
export async function requireAuth(req: { headers: Record<string, string | undefined> }): Promise<Caller> {
  const match = /^Bearer\s+(\S+)\s*$/.exec(header(req.headers, "authorization") ?? "")
  if (!match) throw new HttpError(401, "missing_token")

  let decoded: Awaited<ReturnType<ReturnType<typeof adminAuth>["verifyIdToken"]>>
  try {
    decoded = await adminAuth().verifyIdToken(match[1], true)
  } catch (err) {
    const code = (err as { code?: unknown })?.code
    if (code === "auth/id-token-revoked") throw new HttpError(401, "token_revoked")
    if (code === "auth/user-disabled") throw new HttpError(401, "user_disabled")
    throw new HttpError(401, "invalid_token")
  }
  return callerFromClaims(decoded.uid, decoded, header(req.headers, "x-firm-id"))
}

/**
 * Callable (onCall) identity. The callable runtime verifies the token but does
 * not check revocation, so this re-checks the user record: revoked sessions
 * → 401 token_revoked, disabled users → 401 user_disabled. Callables must pass
 * an explicit firm (`request.data.firmId`): missing → 400 firm_required,
 * ≠ claims.firmId → 403 firm_mismatch.
 */
export async function callerFromCallable(auth: CallableRequest["auth"], firmIdHeader: string): Promise<Caller> {
  if (!auth) throw new HttpError(401, "missing_token")
  if (typeof firmIdHeader !== "string" || firmIdHeader === "") throw new HttpError(400, "firm_required")

  const claims = auth.token as unknown as Record<string, unknown>
  const authTime = claims.auth_time
  if (typeof authTime !== "number") throw new HttpError(401, "invalid_token")

  let user: Awaited<ReturnType<ReturnType<typeof adminAuth>["getUser"]>>
  try {
    user = await adminAuth().getUser(auth.uid)
  } catch {
    throw new HttpError(401, "invalid_token")
  }
  if (user.disabled) throw new HttpError(401, "user_disabled")
  const validAfter = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : NaN
  if (!Number.isNaN(validAfter) && authTime * 1000 < validAfter) throw new HttpError(401, "token_revoked")

  return callerFromClaims(auth.uid, claims, firmIdHeader)
}
