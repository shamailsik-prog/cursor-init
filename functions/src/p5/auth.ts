import type { DecodedIdToken } from "firebase-admin/auth"
import type { Classification } from "@/platform/p1/types"
import {
  bindClaims,
  bindRecords,
  hasSecondFactor,
  IDENTITY_ROLES,
  isIdentityRole,
  type IdentityRefusal,
  type IdentityRole,
} from "@/platform/p5/identityPolicy"
import { adminAuth, adminDb } from "../admin"
import { HttpError } from "../http/errors"
import { header, type Headers } from "../http/headers"

/**
 * `Role` in platform/spine/store.ts, from the shared identity policy (guarded by
 * test/p5.role.test.ts and the root identity parity test).
 */
export const ROLES = IDENTITY_ROLES
export type Role = IdentityRole

/**
 * Verified identity. `users/{uid}` is authoritative for role and clearance; the
 * token's custom claims can only restrict them (see `bindToUserDoc`).
 */
export type Caller = { uid: string; firmId: string; role: Role; clearanceLevel: Classification }

export const isRole = isIdentityRole
export { hasSecondFactor }

const refusal = (r: IdentityRefusal): HttpError => new HttpError(r.status, r.code)

/**
 * Builds a Caller from verified token claims and binds it to the requested firm
 * (identityPolicy.bindClaims, shared with the Next.js session — SEC-2 / E-27).
 * Missing or malformed claims → 403 no_claims; firm header ≠ claims.firmId → 403 firm_mismatch.
 */
function callerFromClaims(uid: string, claims: Record<string, unknown>, firmIdHeader: string | undefined): Caller {
  const claimed = bindClaims(claims, firmIdHeader)
  if (!claimed.ok) throw refusal(claimed)
  return { uid, firmId: claimed.firmId, role: claimed.role, clearanceLevel: claimed.clearanceLevel }
}

/** HTTP (onRequest) identity: verified, revocation-checked Bearer token + X-Firm-Id binding. */
export async function requireAuth(req: { headers: Headers }): Promise<Caller> {
  return (await bindHttpSession(await verifyBearer(req.headers), req.headers, { mfaExempt: false })).caller
}

/**
 * A token refused by verifyBearer. `uid` is set only for token_revoked /
 * user_disabled, for the audit row's actor (see tokenSubject); it is never
 * used to authorise anything.
 */
export class TokenRejectedError extends HttpError {
  constructor(
    code: string,
    readonly uid?: string
  ) {
    super(401, code)
    this.name = "TokenRejectedError"
  }
}

/**
 * The `sub` claim of a JWT, decoded without verification. Only called after
 * the Admin SDK rejected the token as revoked or disabled: it reports those
 * only once the signature and expiry have been verified (and the user looked
 * up), so the subject is genuine. A forged token fails earlier with
 * invalid_token and stays anonymous.
 */
function tokenSubject(token: string): string | undefined {
  try {
    const sub: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")).sub
    return typeof sub === "string" && sub !== "" && sub.length <= 128 ? sub : undefined
  } catch {
    return undefined
  }
}

/**
 * HTTP step 1: verifies the `Authorization: Bearer` ID token, revocation-checked.
 * No header → 401 missing_token; revoked → token_revoked; disabled → user_disabled
 * (both carry the token's uid for the audit row); anything else → invalid_token.
 */
export async function verifyBearer(headers: Headers): Promise<DecodedIdToken> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header(headers, "authorization") ?? "")
  if (!match) throw new TokenRejectedError("missing_token")
  try {
    return await adminAuth().verifyIdToken(match[1], true)
  } catch (err) {
    const code = (err as { code?: unknown })?.code
    if (code === "auth/id-token-revoked") throw new TokenRejectedError("token_revoked", tokenSubject(match[1]))
    if (code === "auth/user-disabled") throw new TokenRejectedError("user_disabled", tokenSubject(match[1]))
    throw new TokenRejectedError("invalid_token")
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

/** How a session relates to the firm's MFA policy (`firms/{firmId}.mfaEnforcedRoles`). */
type MfaContext = { secondFactor: boolean; mfaExempt: boolean }

/**
 * Applies the authoritative `users/{uid}` doc to a token-derived Caller
 * (identityPolicy.bindRecords, shared with the Next.js session — SEC-2 / E-27):
 * missing doc or not `active: true` → 403 inactive_user; doc in another firm →
 * 403 firm_mismatch; malformed doc role/clearance → 403 no_claims; doc role ≠
 * token role → 401 claims_stale (refresh the token). Clearance is the lower of
 * the doc's and the token's, so a demotion takes effect before revocation does.
 * Then the firm's MFA policy (E-19): if the doc role is listed in
 * `firms/{firmId}.mfaEnforcedRoles` and the session has no second factor →
 * 403 mfa_required, unless the operation is MFA recovery (`mfaExempt`).
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
  const decision = bindRecords(caller, { user: doc, firm }, mfa)
  if (!decision.ok) throw refusal(decision)
  return { caller: { ...caller, role: decision.role, clearanceLevel: decision.clearanceLevel }, firm }
}

/** A caller without a firm yet (onboarding): uid, current custom claims, verified email if any. */
export type FirmlessIdentity = { uid: string; claims: Record<string, unknown>; verifiedEmail?: string }
