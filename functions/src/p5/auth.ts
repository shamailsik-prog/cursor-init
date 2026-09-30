import type { CallableRequest } from "firebase-functions/v2/https"
import type { Classification } from "@/platform/p1/types"
import { adminAuth, adminDb } from "../admin"
import { HttpError } from "../http/errors"
import { isKnownClassification, rankOf } from "./classification"

/**
 * Mirrors `Role` in platform/spine/store.ts (guarded by test/p5.role.test.ts).
 * Defined here rather than imported because pulling that file into the
 * functions typecheck surfaces its own unrelated type errors.
 */
export const ROLES = ["partner", "associate", "clerk", "intern", "accounts", "client"] as const
export type Role = (typeof ROLES)[number]

/**
 * Verified identity. `users/{uid}` is authoritative for role and clearance; the
 * token's custom claims can only restrict them (see `bindToUserDoc`).
 */
export type Caller = { uid: string; firmId: string; role: Role; clearanceLevel: Classification }

const ROLE_SET: ReadonlySet<string> = new Set<string>(ROLES)

export function isRole(value: unknown): value is Role {
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
  if (typeof firmId !== "string" || firmId === "" || !isRole(role) || !isKnownClassification(clearanceLevel)) {
    throw new HttpError(403, "no_claims")
  }
  if (firmIdHeader !== firmId) throw new HttpError(403, "firm_mismatch")
  return { uid, firmId, role, clearanceLevel }
}

/** HTTP (onRequest) identity: verified, revocation-checked Bearer token + X-Firm-Id binding. */
export async function requireAuth(req: { headers: Record<string, string | undefined> }): Promise<Caller> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header(req.headers, "authorization") ?? "")
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
  const caller = callerFromClaims(decoded.uid, decoded, header(req.headers, "x-firm-id"))
  return bindToUserDoc(caller, { secondFactor: hasSecondFactor(decoded), mfaExempt: false })
}

/** True when the verified token records a second-factor sign-in (`firebase.sign_in_second_factor`). */
export function hasSecondFactor(claims: object): boolean {
  const firebase = (claims as { firebase?: { sign_in_second_factor?: unknown } }).firebase
  return typeof firebase?.sign_in_second_factor === "string" && firebase.sign_in_second_factor !== ""
}

/** How a session relates to the firm's MFA policy (`firms/{firmId}.mfaEnforcedRoles`). */
type MfaContext = { secondFactor: boolean; mfaExempt: boolean }

/**
 * Applies the authoritative `users/{uid}` doc to a token-derived Caller:
 * missing doc or not `active: true` → 403 inactive_user; doc in another firm →
 * 403 firm_mismatch; malformed doc role/clearance → 403 no_claims; doc role ≠
 * token role → 401 claims_stale (refresh the token). Clearance is the lower of
 * the doc's and the token's, so a demotion takes effect before revocation does.
 * Then the firm's MFA policy (E-19): if the doc role is listed in
 * `firms/{firmId}.mfaEnforcedRoles` and the session has no second factor →
 * 403 mfa_required, unless the caller is an MFA-recovery callable (`mfaExempt`).
 * Unreadable users or firm doc → 503 store_unavailable.
 */
async function bindToUserDoc(caller: Caller, mfa: MfaContext): Promise<Caller> {
  let doc: Record<string, unknown> | undefined
  let firm: Record<string, unknown> | undefined
  try {
    const db = adminDb()
    const [userSnap, firmSnap] = await db.getAll(db.collection("users").doc(caller.uid), db.collection("firms").doc(caller.firmId))
    doc = userSnap.data()
    firm = firmSnap.data()
  } catch {
    throw new HttpError(503, "store_unavailable")
  }
  if (!doc || doc.active !== true) throw new HttpError(403, "inactive_user")
  if (doc.firmId !== caller.firmId) throw new HttpError(403, "firm_mismatch")
  if (!isRole(doc.role) || !isKnownClassification(doc.clearanceLevel)) throw new HttpError(403, "no_claims")
  if (doc.role !== caller.role) throw new HttpError(401, "claims_stale")
  if (!mfa.mfaExempt && !mfa.secondFactor && isMfaEnforced(firm, doc.role)) throw new HttpError(403, "mfa_required")
  const clearanceLevel =
    rankOf(doc.clearanceLevel) < rankOf(caller.clearanceLevel) ? doc.clearanceLevel : caller.clearanceLevel
  return { ...caller, clearanceLevel }
}

function isMfaEnforced(firm: Record<string, unknown> | undefined, role: Role): boolean {
  const enforced = firm?.mfaEnforcedRoles
  return Array.isArray(enforced) && enforced.includes(role)
}

/**
 * Re-checks a callable session against the user record. The callable runtime
 * verifies the token but does not check revocation, so: no auth → 401
 * missing_token, disabled user → 401 user_disabled, session older than
 * tokensValidAfterTime → 401 token_revoked, unreadable user → 401 invalid_token.
 */
async function verifyCallableSession(
  auth: CallableRequest["auth"]
): Promise<{ claims: Record<string, unknown>; customClaims: Record<string, unknown> }> {
  if (!auth) throw new HttpError(401, "missing_token")
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
  return { claims, customClaims: { ...(user.customClaims ?? {}) } }
}

/**
 * Callable (onCall) identity: a revocation/disabled-checked session bound to
 * an explicit firm (`request.data.firmId`): missing → 400 firm_required,
 * ≠ claims.firmId → 403 firm_mismatch. The firm's MFA policy applies
 * (403 mfa_required); `mfaExempt` is only for the MFA-recovery callables
 * (disableMfa, generateRecoveryCodes), which a user who lost their device
 * must reach with the first factor alone.
 */
export async function callerFromCallable(
  auth: CallableRequest["auth"],
  firmIdHeader: string,
  opts: { mfaExempt?: boolean } = {}
): Promise<Caller> {
  if (!auth) throw new HttpError(401, "missing_token")
  if (typeof firmIdHeader !== "string" || firmIdHeader === "") throw new HttpError(400, "firm_required")
  const { claims } = await verifyCallableSession(auth)
  const caller = callerFromClaims(auth.uid, claims, firmIdHeader)
  return bindToUserDoc(caller, { secondFactor: hasSecondFactor(claims), mfaExempt: opts.mfaExempt === true })
}

/**
 * Callable identity for callers that have no firm yet (firm onboarding):
 * the same revocation/disabled checks, returning the uid, the user's
 * *current* custom claims from the user record (not the possibly stale token)
 * and the token's email when it is verified.
 */
export async function callerWithoutFirm(
  auth: CallableRequest["auth"]
): Promise<{ uid: string; claims: Record<string, unknown>; verifiedEmail?: string }> {
  const { claims, customClaims } = await verifyCallableSession(auth)
  const verifiedEmail = claims.email_verified === true && typeof claims.email === "string" ? claims.email : undefined
  return { uid: auth!.uid, claims: customClaims, verifiedEmail }
}
