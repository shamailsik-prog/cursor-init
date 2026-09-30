/**
 * P5 session resolution — the single place a route learns *who* is calling.
 *
 * Mode is chosen by `SIKANDER_AUTH_MODE`:
 *   - "firebase" (DEFAULT when unset — fail closed): verifies
 *     `Authorization: Bearer <Firebase ID token>` with firebase-admin, requires
 *     `X-Firm-Id` (Layer 18 §4.1) to equal the caller's firm, and maps the token
 *     uid to the user record. firmId / role / clearanceLevel come from the
 *     token's custom claims (Layer 18 §4.5), falling back to the user record when
 *     a claim is absent. A claim may restrict but never elevate the record: a
 *     firmId claim must match the record, clearance is the stricter of claim and
 *     record, and a differing role claim is ignored in favour of the record.
 *   - "insecure-dev": local development and tests ONLY. Trusts the
 *     `actorId` / `userId` the request carries, exactly as routes did before
 *     authentication existed. Must be set explicitly, and is allowed only when
 *     NODE_ENV is "development" or "test" and no hosted-runtime marker
 *     (K_SERVICE, VERCEL, VERCEL_ENV, FUNCTION_TARGET, FIREBASE_CONFIG,
 *     GAE_SERVICE) is present; otherwise 503.
 *
 * Any other value fails closed.
 */
import { classificationRank, isClassification, type Classification } from "@/platform/p1/types"
import type { Role, SpineStore, User } from "@/platform/spine/store"
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
  | "USER_NOT_PROVISIONED"
  | "identity_unavailable"

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

const KNOWN_ROLES: ReadonlySet<string> = new Set<Role>([
  "partner",
  "associate",
  "clerk",
  "intern",
  "accounts",
  "client",
])

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
  options: { preferRepository?: boolean; store?: SpineStore } = {}
): Promise<User | null> {
  const store = options.store ?? getRuntimeStore()
  const cached = store.users.get(userId)
  if (cached && !options.preferRepository) return cached
  let fromRepo: User | null = null
  try {
    const repos = await getRuntimeRepositories(store)
    fromRepo = (await repos.users.get(userId)) ?? null
  } catch (err) {
    console.error("[auth] user lookup failed", err)
    if (options.preferRepository) {
      // Firebase mode: the repository is authoritative. Never authenticate
      // against a possibly stale in-memory record (a user demoted or
      // deprovisioned on another instance) while it is unreachable.
      throw new AuthError(503, "identity_unavailable", "identity service unavailable")
    }
  }
  if (fromRepo) {
    store.users.set(fromRepo.id, fromRepo)
    return fromRepo
  }
  return cached ?? null
}

function stricterClearance(a: Classification, b: Classification): Classification {
  return classificationRank(a) <= classificationRank(b) ? a : b
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

  const record = await loadUserRecord(decoded.uid, { preferRepository: true })
  if (!record) {
    throw new AuthError(403, "USER_NOT_PROVISIONED", "user not provisioned")
  }

  const claimFirm = typeof decoded.firmId === "string" ? decoded.firmId : undefined
  const claimRole =
    typeof decoded.role === "string" && KNOWN_ROLES.has(decoded.role)
      ? (decoded.role as Role)
      : undefined
  const claimClearance = isClassification(decoded.clearanceLevel)
    ? decoded.clearanceLevel
    : undefined

  if (claimFirm && claimFirm !== record.firmId) {
    // Token and record disagree about tenancy: refuse rather than guess.
    throw new AuthError(403, "FIRM_MISMATCH", "firm scope mismatch")
  }
  const firmId = claimFirm ?? record.firmId

  const headerFirm = request.headers.get(FIRM_HEADER)?.trim()
  if (!headerFirm) {
    throw new AuthError(400, "FIRM_HEADER_REQUIRED", `${FIRM_HEADER} header required`)
  }
  if (headerFirm !== firmId) {
    throw new AuthError(403, "FIRM_MISMATCH", "firm scope mismatch")
  }

  if (claimRole && claimRole !== record.role) {
    // Roles are unordered, so a stale claim cannot be "restricted" safely:
    // the provisioned record (what every handler authorises against) wins.
    console.warn(`[auth] role claim for ${record.id} differs from record; using record`)
  }

  return {
    mode,
    userId: record.id,
    firmId,
    role: record.role,
    // A claim may restrict but never elevate the provisioned clearance.
    clearance: claimClearance
      ? stricterClearance(claimClearance, record.clearanceLevel)
      : record.clearanceLevel,
  }
}
