import type { CallableRequest } from "firebase-functions/v2/https"
import type { DecodedIdToken } from "firebase-admin/auth"
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

type Headers = Record<string, string | undefined>

/** HTTP (onRequest) identity: verified, revocation-checked Bearer token + X-Firm-Id binding. */
export async function requireAuth(req: { headers: Headers }): Promise<Caller> {
  return (await bindHttpSession(await verifyBearer(req.headers), req.headers, { mfaExempt: false })).caller
}

/**
 * HTTP step 1: verifies the `Authorization: Bearer` ID token, revocation-checked.
 * No header → 401 missing_token; revoked → token_revoked; disabled → user_disabled;
 * anything else → invalid_token.
 */
export async function verifyBearer(headers: Headers): Promise<DecodedIdToken> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header(headers, "authorization") ?? "")
  if (!match) throw new HttpError(401, "missing_token")
  try {
    return await adminAuth().verifyIdToken(match[1], true)
  } catch (err) {
    const code = (err as { code?: unknown })?.code
    if (code === "auth/id-token-revoked") throw new HttpError(401, "token_revoked")
    if (code === "auth/user-disabled") throw new HttpError(401, "user_disabled")
    throw new HttpError(401, "invalid_token")
  }
}

/**
 * HTTP step 2: binds a verified token to `X-Firm-Id` and the authoritative
 * users doc (see bindToUserDoc), applying the firm's MFA policy unless
 * `mfaExempt`. Also returns whether the token has a second factor and the
 * firm doc read for the binding (for per-firm settings such as rate limits).
 */
export async function bindHttpSession(
  decoded: DecodedIdToken,
  headers: Headers,
  opts: { mfaExempt: boolean }
): Promise<{ caller: Caller; secondFactor: boolean; firm: Record<string, unknown> | undefined }> {
  const secondFactor = hasSecondFactor(decoded)
  const caller = callerFromClaims(decoded.uid, decoded, header(headers, "x-firm-id"))
  return { ...(await bindToUserDoc(caller, { secondFactor, mfaExempt: opts.mfaExempt })), secondFactor }
}

/**
 * HTTP identity for callers that have no firm yet (firm onboarding), from a
 * token already checked by verifyBearer: the uid, the user's *current* custom
 * claims from the user record, and the token's email when it is verified.
 * An unreadable user record → 401 invalid_token.
 */
export async function firmlessFromToken(decoded: DecodedIdToken): Promise<FirmlessIdentity> {
  let customClaims: Record<string, unknown>
  try {
    customClaims = { ...((await adminAuth().getUser(decoded.uid)).customClaims ?? {}) }
  } catch {
    throw new HttpError(401, "invalid_token")
  }
  const verifiedEmail = decoded.email_verified === true && typeof decoded.email === "string" ? decoded.email : undefined
  return { uid: decoded.uid, claims: customClaims, verifiedEmail }
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
async function bindToUserDoc(
  caller: Caller,
  mfa: MfaContext
): Promise<{ caller: Caller; firm: Record<string, unknown> | undefined }> {
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
  return { caller: { ...caller, clearanceLevel }, firm }
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
 * (403 mfa_required); `mfaExempt` is only for disableMfa called by the
 * subject (a user who lost their device) and syncMfaStatus, which must be
 * reachable with the first factor alone.
 */
export async function callerFromCallable(
  auth: CallableRequest["auth"],
  firmIdHeader: string,
  opts: { mfaExempt?: boolean } = {}
): Promise<Caller> {
  return (await callableSession(auth, firmIdHeader, opts)).caller
}

/** callerFromCallable, also returning the firm doc read for the binding (per-firm settings such as rate limits). */
export async function callableSession(
  auth: CallableRequest["auth"],
  firmIdHeader: string,
  opts: { mfaExempt?: boolean } = {}
): Promise<{ caller: Caller; firm: Record<string, unknown> | undefined }> {
  if (!auth) throw new HttpError(401, "missing_token")
  if (typeof firmIdHeader !== "string" || firmIdHeader === "") throw new HttpError(400, "firm_required")
  const { claims } = await verifyCallableSession(auth)
  const caller = callerFromClaims(auth.uid, claims, firmIdHeader)
  return bindToUserDoc(caller, { secondFactor: hasSecondFactor(claims), mfaExempt: opts.mfaExempt === true })
}

/** A caller without a firm yet (onboarding): uid, current custom claims, verified email if any. */
export type FirmlessIdentity = { uid: string; claims: Record<string, unknown>; verifiedEmail?: string }

/**
 * Callable identity for callers that have no firm yet (firm onboarding):
 * the same revocation/disabled checks, returning the uid, the user's
 * *current* custom claims from the user record (not the possibly stale token)
 * and the token's email when it is verified.
 */
export async function callerWithoutFirm(auth: CallableRequest["auth"]): Promise<FirmlessIdentity> {
  const { claims, customClaims } = await verifyCallableSession(auth)
  const verifiedEmail = claims.email_verified === true && typeof claims.email === "string" ? claims.email : undefined
  return { uid: auth!.uid, claims: customClaims, verifiedEmail }
}
