import type { CallableRequest } from "firebase-functions/v2/https"
import { isClassification, type Classification } from "@/platform/p1/types"
import { adminAuth } from "../admin"
import { HttpError } from "../http/errors"

/**
 * Mirrors `Role` in platform/spine/store.ts. Defined here rather than imported
 * because pulling that file into the functions typecheck surfaces its own
 * unrelated type errors.
 */
export type Role = "partner" | "associate" | "clerk" | "intern" | "accounts" | "client"

/** Verified identity. Custom claims `firmId`, `role`, `clearanceLevel` are authoritative. */
export type Caller = { uid: string; firmId: string; role: Role; clearanceLevel: Classification }

const ROLES: ReadonlySet<string> = new Set<Role>(["partner", "associate", "clerk", "intern", "accounts", "client"])

function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLES.has(value)
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
 * Callable (onCall) identity. The token was verified by the callable runtime
 * (without a revocation check). If `firmIdHeader` is supplied it must equal
 * claims.firmId; when omitted the caller is bound to its claimed firm.
 */
export function callerFromCallable(auth: CallableRequest["auth"], firmIdHeader?: string): Caller {
  if (!auth) throw new HttpError(401, "missing_token")
  const claims = auth.token as unknown as Record<string, unknown>
  const bound = firmIdHeader === undefined ? claims.firmId : firmIdHeader
  return callerFromClaims(auth.uid, claims, typeof bound === "string" ? bound : undefined)
}
