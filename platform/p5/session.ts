/**
 * P5 session resolution — the single place a route learns *who* is calling.
 *
 * Mode is chosen by `SIKANDER_AUTH_MODE`:
 *   - "firebase" (DEFAULT when unset — fail closed): verifies
 *     `Authorization: Bearer <Firebase ID token>` with firebase-admin (revocation
 *     checked), requires `X-Firm-Id` (Layer 18 §4.1), then applies the shared P5
 *     identity policy (platform/p5/identityPolicy.ts, the same code the Cloud
 *     Functions API runs — SEC-2 / E-27): firmId, role and clearanceLevel claims
 *     must all be present (403 NO_CLAIMS) and the firm claim must equal
 *     X-Firm-Id (403 FIRM_MISMATCH); users/{uid} must exist with active === true
 *     (403 INACTIVE_USER) in that firm; its role must equal the role claim (401
 *     CLAIMS_STALE); the firm's MFA policy applies (firms/{firmId}
 *     .mfaEnforcedRoles without a second factor: 403 MFA_REQUIRED); clearance is
 *     the lower of record and claim. Codes are the policy's, upper-cased.
 *   - "insecure-dev": local development and tests ONLY. Trusts the
 *     `actorId` / `userId` the request carries, exactly as routes did before
 *     authentication existed. Must be set explicitly, and is allowed only when
 *     NODE_ENV is "development" or "test" and no hosted-runtime marker
 *     (K_SERVICE, VERCEL, VERCEL_ENV, FUNCTION_TARGET, FIREBASE_CONFIG,
 *     GAE_SERVICE) is present; otherwise 503.
 *
 * Any other value fails closed.
 */
import type { Classification } from "@/platform/p1/types"
import type { FirmRecord, Role, SpineStore, User } from "@/platform/spine/store"
import { bindClaims, bindRecords, hasSecondFactor, type IdentityRefusal } from "@/platform/p5/identityPolicy"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"

export type AuthMode = "firebase" | "insecure-dev"

export type Session = {
  userId: string
  firmId: string
  role: Role
  clearance: Classification
  mode: "firebase"
}

export type AuthErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "AUTH_NOT_CONFIGURED"
  | "AUTH_MISCONFIGURED"
  | "FIRM_HEADER_REQUIRED"
  | "FIRM_MISMATCH"
  | "NO_CLAIMS"
  | "INACTIVE_USER"
  | "CLAIMS_STALE"
  | "MFA_REQUIRED"
  | "IDENTITY_UNAVAILABLE"

export class AuthError extends Error {
  readonly status: number
  readonly code: AuthErrorCode
  constructor(status: number, code: AuthErrorCode, message: string) {
    super(message)
    this.name = "AuthError"
    this.status = status
    this.code = code
  }
}

/** Insecure-dev sessions carry no verified identity until the request supplies one. */
export type InsecureDevSession = { mode: "insecure-dev" }

export const FIRM_HEADER = "X-Firm-Id"

let insecureDevWarned = false

/** Env vars set by Cloud Run, Vercel, Cloud Functions, Firebase and App Engine. */
const HOSTED_RUNTIME_MARKERS = [
  "K_SERVICE",
  "VERCEL",
  "VERCEL_ENV",
  "FUNCTION_TARGET",
  "FIREBASE_CONFIG",
  "GAE_SERVICE",
] as const

export function resolveAuthMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const raw = (env.SIKANDER_AUTH_MODE ?? "").trim().toLowerCase()
  if (raw === "" || raw === "firebase") return "firebase"
  if (raw === "insecure-dev") {
    // Allow-list, not deny-list: only a local development or test process, and
    // never on a hosted runtime even if NODE_ENV was mis-set there.
    if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
      throw new AuthError(
        503,
        "AUTH_MISCONFIGURED",
        `SIKANDER_AUTH_MODE=insecure-dev is refused when NODE_ENV=${env.NODE_ENV ?? "(unset)"}`
      )
    }
    const hosted = HOSTED_RUNTIME_MARKERS.find((name) => (env[name] ?? "") !== "")
    if (hosted) {
      throw new AuthError(
        503,
        "AUTH_MISCONFIGURED",
        `SIKANDER_AUTH_MODE=insecure-dev is refused on a hosted runtime (${hosted} is set)`
      )
    }
    if (!insecureDevWarned) {
      insecureDevWarned = true
      console.warn(
        "[auth] WARNING: SIKANDER_AUTH_MODE=insecure-dev — request-supplied actorId/userId " +
          "is TRUSTED WITHOUT AUTHENTICATION. Never use this outside local development/tests."
      )
    }
    return "insecure-dev"
  }
  throw new AuthError(503, "AUTH_MISCONFIGURED", `unknown SIKANDER_AUTH_MODE "${raw}"`)
}

type DecodedToken = { uid: string } & Record<string, unknown>
type IdTokenVerifier = (token: string) => Promise<DecodedToken>

let verifierPromise: Promise<IdTokenVerifier> | null = null

function firebaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
      env.FIREBASE_PROJECT_ID?.trim() ||
      env.GOOGLE_CLOUD_PROJECT?.trim()
  )
}

/** Lazily initialises firebase-admin from standard env. Never called in insecure-dev. */
async function getVerifier(): Promise<IdTokenVerifier> {
  if (!firebaseConfigured()) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "auth not configured")
  }
  if (!verifierPromise) {
    verifierPromise = (async () => {
      const { getApps, initializeApp, applicationDefault } = await import("firebase-admin/app")
      const { getAuth } = await import("firebase-admin/auth")
      const projectId =
        process.env.FIREBASE_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim()
      const app =
        getApps()[0] ??
        initializeApp({
          ...(process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
            ? { credential: applicationDefault() }
            : {}),
          ...(projectId ? { projectId } : {}),
        })
      const auth = getAuth(app)
      // checkRevoked=true: a revoked / disabled account is rejected immediately.
      return async (token: string) => (await auth.verifyIdToken(token, true)) as DecodedToken
    })().catch((err) => {
      verifierPromise = null
      throw err
    })
  }
  return verifierPromise
}

/** Test hook: forget the cached firebase-admin verifier (so env/mocks can change). */
export function resetSessionStateForTests(): void {
  verifierPromise = null
  insecureDevWarned = false
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (!header) return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match ? match[1] : null
}

/**
 * Loads a user through the repository layer (Firestore in runtime mode) and
 * hydrates the per-instance store with it, so handlers that look the caller
 * up in memory see the provisioned record.
 *   - `preferRepository` (firebase mode): the repository is authoritative, so a
 *     demotion made through another instance is seen immediately.
 *   - otherwise the in-memory record wins and the repository fills a miss.
 */
export async function loadUserRecord(
  userId: string,
  options: { preferRepository?: boolean; store?: SpineStore; firmId?: string } = {}
): Promise<User | null> {
  const store = options.store ?? getRuntimeStore()
  const cached = store.users.get(userId)
  if (cached && !options.preferRepository) return cached
  let fromRepo: User | null = null
  try {
    const repos = await getRuntimeRepositories(store)
    const firmScope = options.firmId ?? cached?.firmId
    fromRepo =
      firmScope !== undefined ? ((await repos.users.get(userId, firmScope)) ?? null) : null
  } catch (err) {
    console.error("[auth] user lookup failed", err)
    if (options.preferRepository) {
      // Firebase mode: the repository is authoritative. Never authenticate
      // against a possibly stale in-memory record (a user demoted or
      // deprovisioned on another instance) while it is unreachable.
      throw new AuthError(503, "IDENTITY_UNAVAILABLE", "identity service unavailable")
    }
  }
  if (fromRepo) {
    store.users.set(fromRepo.id, fromRepo)
    return fromRepo
  }
  if (options.preferRepository) {
    // The repository is authoritative and says the user no longer exists:
    // evict the cached copy so it cannot keep authenticating anywhere.
    store.users.delete(userId)
    return null
  }
  return cached ?? null
}

/** firms/{firmId} through the repository layer (authoritative; a failed read fails closed). */
async function loadFirmRecord(firmId: string): Promise<FirmRecord | null> {
  try {
    const repos = await getRuntimeRepositories(getRuntimeStore())
    return await repos.firms.get(firmId, firmId)
  } catch (err) {
    console.error("[auth] firm lookup failed", err)
    throw new AuthError(503, "IDENTITY_UNAVAILABLE", "identity service unavailable")
  }
}

const REFUSAL_MESSAGES: Record<IdentityRefusal["code"], string> = {
  no_claims: "missing or malformed identity claims",
  firm_mismatch: "firm scope mismatch",
  inactive_user: "user is not active",
  claims_stale: "identity claims are stale; refresh the token",
  mfa_required: "a second factor is required for this role",
}

function refusalError(refusal: IdentityRefusal): AuthError {
  return new AuthError(refusal.status, refusal.code.toUpperCase() as AuthErrorCode, REFUSAL_MESSAGES[refusal.code])
}

/**
 * Resolve the caller. In firebase mode returns a verified `Session` or throws
 * `AuthError`. In insecure-dev mode returns `{ mode: "insecure-dev" }`; the
 * request's own actorId/userId is then trusted by the route wrapper.
 */
export async function resolveSession(request: Request): Promise<Session | InsecureDevSession> {
  const mode = resolveAuthMode()
  if (mode === "insecure-dev") return { mode }

  const verify = await getVerifier()
  const token = bearerToken(request)
  if (!token) {
    throw new AuthError(401, "AUTH_REQUIRED", "authentication required")
  }
  let decoded: DecodedToken
  try {
    decoded = await verify(token)
  } catch (err) {
    console.warn("[auth] ID token rejected", err instanceof Error ? err.message : err)
    throw new AuthError(401, "AUTH_INVALID", "invalid or expired token")
  }
  if (!decoded || typeof decoded.uid !== "string" || decoded.uid.length === 0) {
    throw new AuthError(401, "AUTH_INVALID", "invalid or expired token")
  }

  // Step 1 (identityPolicy.bindClaims): the token's claims, bound to X-Firm-Id.
  const headerFirm = request.headers.get(FIRM_HEADER)?.trim() || undefined
  const claimed = bindClaims(decoded, headerFirm)
  if (!claimed.ok) {
    // L18 §4.1: a missing header is the caller's request error, not a tenancy mismatch
    if (claimed.code === "firm_mismatch" && !headerFirm) {
      throw new AuthError(400, "FIRM_HEADER_REQUIRED", `${FIRM_HEADER} header required`)
    }
    throw refusalError(claimed)
  }

  // Step 2 (identityPolicy.bindRecords): the authoritative users/{uid} and firms/{firmId}.
  const record = await loadUserRecord(decoded.uid, {
    preferRepository: true,
    firmId: claimed.firmId,
  })
  const firm = await loadFirmRecord(claimed.firmId)
  const decision = bindRecords(
    claimed,
    { user: record as Record<string, unknown> | null, firm: firm as Record<string, unknown> | null },
    // Next.js serves no MFA-recovery operation, so nothing here is exempt.
    { secondFactor: hasSecondFactor(decoded), mfaExempt: false }
  )
  if (!decision.ok) throw refusalError(decision)

  return {
    mode,
    userId: decoded.uid,
    firmId: decision.firmId,
    role: decision.role as Role,
    clearance: decision.clearanceLevel as Classification,
  }
}
