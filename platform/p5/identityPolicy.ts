/**
 * P5 identity policy — the one decision both runtimes make about a verified ID token
 * (SEC-2 / U-7 / I-2, Erratum E-27). Pure: no Next.js, no firebase imports, so the Next.js
 * session (platform/p5/session.ts resolveSession) and the Cloud Functions API
 * (functions/src/p5/auth.ts, bundled through the "@/" alias) run exactly this code.
 *
 * Step 1, from the token alone (`bindClaims`):
 *   - claims firmId (non-empty string), role and clearanceLevel must all be present and valid,
 *     else 403 no_claims;
 *   - the requested firm (X-Firm-Id) must equal the firmId claim, else 403 firm_mismatch.
 * Step 2, against the authoritative records (`bindRecords`):
 *   - users/{uid} must exist with `active === true`, else 403 inactive_user;
 *   - its firmId must equal the claim, else 403 firm_mismatch;
 *   - its role and clearanceLevel must be valid, else 403 no_claims;
 *   - its role must equal the role claim, else 401 claims_stale (refresh the token: claims are
 *     re-issued from the record);
 *   - the firm's MFA policy (E-19): when firms/{firmId}.mfaEnforcedRoles lists the role and the
 *     token has no `firebase.sign_in_second_factor`, 403 mfa_required — unless the call is an
 *     MFA-recovery operation (`mfaExempt`: disableMfa by its subject, syncMfaStatus), which must
 *     be reachable with the first factor alone;
 *   - effective clearance = the lower of the record's and the claim's (a claim may restrict,
 *     never elevate; a demotion takes effect before the token expires).
 */
import { CLASSIFICATION_RANKS, type Classification } from "@/platform/p1/types"

/** platform/spine/store.ts Role (guarded by tests/p5.identity-policy.parity.test.ts). */
export const IDENTITY_ROLES = ["partner", "associate", "clerk", "intern", "accounts", "client"] as const
export type IdentityRole = (typeof IDENTITY_ROLES)[number]

const ROLE_SET: ReadonlySet<string> = new Set<string>(IDENTITY_ROLES)

export function isIdentityRole(value: unknown): value is IdentityRole {
  return typeof value === "string" && ROLE_SET.has(value)
}

/** Own classification labels only (never Object.prototype keys). */
export function isIdentityClearance(value: unknown): value is Classification {
  return typeof value === "string" && Object.hasOwn(CLASSIFICATION_RANKS, value)
}

export type IdentityRefusalCode = "no_claims" | "firm_mismatch" | "inactive_user" | "claims_stale" | "mfa_required"

export type IdentityRefusal = { ok: false; status: 401 | 403; code: IdentityRefusalCode }

/** The token's identity claims, bound to the requested firm. */
export type ClaimedIdentity = { firmId: string; role: IdentityRole; clearanceLevel: Classification }

export type IdentityGrant = { ok: true; firmId: string; role: IdentityRole; clearanceLevel: Classification }

const refuse = (status: 401 | 403, code: IdentityRefusalCode): IdentityRefusal => ({ ok: false, status, code })

/** True when the verified token records a second-factor sign-in (`firebase.sign_in_second_factor`). */
export function hasSecondFactor(claims: object): boolean {
  const firebase = (claims as { firebase?: { sign_in_second_factor?: unknown } }).firebase
  return typeof firebase?.sign_in_second_factor === "string" && firebase.sign_in_second_factor !== ""
}

/** Step 1: the token's claims, bound to the requested firm. */
export function bindClaims(
  claims: Record<string, unknown>,
  firmHeader: string | undefined
): ({ ok: true } & ClaimedIdentity) | IdentityRefusal {
  const { firmId, role, clearanceLevel } = claims
  if (typeof firmId !== "string" || firmId === "" || !isIdentityRole(role) || !isIdentityClearance(clearanceLevel)) {
    return refuse(403, "no_claims")
  }
  if (firmHeader !== firmId) return refuse(403, "firm_mismatch")
  return { ok: true, firmId, role, clearanceLevel }
}

/** True when firms/{firmId}.mfaEnforcedRoles lists the role (a missing firm doc enforces nothing). */
export function isMfaEnforced(firm: Record<string, unknown> | null | undefined, role: IdentityRole): boolean {
  const enforced = firm?.mfaEnforcedRoles
  return Array.isArray(enforced) && enforced.includes(role)
}

/** Step 2: the claimed identity against users/{uid} and firms/{firmId}. */
export function bindRecords(
  claimed: ClaimedIdentity,
  records: {
    user: Record<string, unknown> | null | undefined
    firm: Record<string, unknown> | null | undefined
  },
  mfa: { secondFactor: boolean; mfaExempt: boolean }
): IdentityGrant | IdentityRefusal {
  const user = records.user
  if (!user || user.active !== true) return refuse(403, "inactive_user")
  if (user.firmId !== claimed.firmId) return refuse(403, "firm_mismatch")
  if (!isIdentityRole(user.role) || !isIdentityClearance(user.clearanceLevel)) return refuse(403, "no_claims")
  if (user.role !== claimed.role) return refuse(401, "claims_stale")
  if (!mfa.mfaExempt && !mfa.secondFactor && isMfaEnforced(records.firm, user.role)) return refuse(403, "mfa_required")
  const clearanceLevel =
    CLASSIFICATION_RANKS[user.clearanceLevel] < CLASSIFICATION_RANKS[claimed.clearanceLevel] ? user.clearanceLevel : claimed.clearanceLevel
  return { ok: true, firmId: claimed.firmId, role: user.role, clearanceLevel }
}

/** Both steps (what each runtime does, with its own record reads in between). */
export function decideIdentity(input: {
  claims: Record<string, unknown>
  firmHeader: string | undefined
  user: Record<string, unknown> | null | undefined
  firm: Record<string, unknown> | null | undefined
  mfaExempt?: boolean
}): IdentityGrant | IdentityRefusal {
  const claimed = bindClaims(input.claims, input.firmHeader)
  if (!claimed.ok) return claimed
  return bindRecords(claimed, { user: input.user, firm: input.firm }, {
    secondFactor: hasSecondFactor(input.claims),
    mfaExempt: input.mfaExempt === true,
  })
}
