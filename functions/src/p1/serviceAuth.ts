import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto"

/**
 * FA-D3C-002 (spec docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-boundary-design.md, ruling R9): the code-level
 * check of a service-to-service caller. `p1CorpusEmbedding` is also IAM-private on the platform, but project-level
 * `run.invoker` holders can invoke any private service and the emulator enforces no IAM, so the handler verifies the
 * caller's Google-signed OIDC ID token itself and admits only the identities on its allowlist.
 *
 * Verified with node:crypto (no dependency): RS256 only; the key by `kid` from Google's JWKS, an RSA signing key of at
 * least 2048 bits; issuer `accounts.google.com`; audience exactly the configured one; unexpired with CLOCK_SKEW_SECONDS
 * of skew; issued no later than now + skew; a lifetime of at most MAX_TOKEN_LIFETIME_SECONDS (+ skew); `email_verified`
 * exactly true; the email on the caller allowlist (case-insensitive). Every refusal is a fixed code with a fixed message
 * that never carries the token or a claim; a key set that cannot be read fails closed.
 */

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
export const GOOGLE_ISSUERS: readonly string[] = Object.freeze(["https://accounts.google.com", "accounts.google.com"])
export const CLOCK_SKEW_SECONDS = 60
/** Google ID tokens live one hour. */
export const MAX_TOKEN_LIFETIME_SECONDS = 3600
/** A Google ID token is about 1 KB; anything this large is not one. */
export const MAX_TOKEN_CHARS = 8192
export const JWKS_TIMEOUT_MS = 2_000
/** The key set is cached for its `max-age`, at most this long, and five minutes when it names none. */
export const JWKS_MAX_CACHE_MS = 3_600_000
export const JWKS_DEFAULT_CACHE_MS = 300_000
/** A refresh asked for by an unknown `kid` refetches only a set older than this (Google rotates keys rarely). */
export const JWKS_REFRESH_AFTER_MS = 60_000
const MIN_RSA_BITS = 2048

export type ServiceAuthCode =
  | "missing_token"
  | "malformed_token"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "lifetime_too_long"
  | "email_unverified"
  | "caller_not_allowed"
  | "keys_unavailable"

const STATUS: Readonly<Record<ServiceAuthCode, 401 | 403 | 503>> = Object.freeze({
  missing_token: 401,
  malformed_token: 401,
  unsupported_algorithm: 401,
  unknown_key: 401,
  bad_signature: 401,
  wrong_issuer: 401,
  wrong_audience: 401,
  expired: 401,
  not_yet_valid: 401,
  lifetime_too_long: 401,
  email_unverified: 401,
  caller_not_allowed: 403,
  keys_unavailable: 503,
})

/** A refused caller: a fixed code and its HTTP status; the message is the code, never token or claim text. */
export class ServiceAuthError extends Error {
  readonly code: ServiceAuthCode
  readonly status: 401 | 403 | 503

  constructor(code: ServiceAuthCode) {
    super(`service caller refused: ${code}`)
    this.name = "ServiceAuthError"
    this.code = code
    this.status = STATUS[code]
  }
}

export type ServiceCaller = { email: string; subject: string }
export type JwkSet = { keys: Array<Record<string, unknown>> }
export type KeySource = (opts?: { refresh?: boolean }) => Promise<JwkSet>
export type VerifyOptions = { audience: string; callers: ReadonlySet<string>; nowMs: number; keys?: KeySource }

const BEARER = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/
const refuse = (code: ServiceAuthCode): never => {
  throw new ServiceAuthError(code)
}

/** A JSON object from a base64url segment, or null. */
function segmentObject(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The RSA signing key for `kid` in `set`, or null: RS256 (or no `alg`), `sig` (or no `use`), at least 2048 bits. */
function signingKey(set: JwkSet, kid: string): KeyObject | null {
  for (const jwk of Array.isArray(set?.keys) ? set.keys : []) {
    if (jwk?.kid !== kid || jwk.kty !== "RSA") continue
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue
    if (jwk.use !== undefined && jwk.use !== "sig") continue
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue
    try {
      const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e } as JsonWebKey, format: "jwk" })
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_RSA_BITS) return key
    } catch {
      continue
    }
  }
  return null
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/**
 * Verifies `authorization` (the request's Authorization header) as a Google OIDC ID token for one of `callers`. Resolves
 * with the caller; rejects with a ServiceAuthError.
 */
export async function verifyServiceCaller(authorization: unknown, opts: VerifyOptions): Promise<ServiceCaller> {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return refuse("missing_token")
  if (authorization.length > MAX_TOKEN_CHARS + 7) return refuse("malformed_token")
  const parts = BEARER.exec(authorization)
  if (!parts) return refuse("malformed_token")
  const [, headerPart, payloadPart, signaturePart] = parts as unknown as [string, string, string, string]
  const header = segmentObject(headerPart)
  const payload = segmentObject(payloadPart)
  if (header === null || payload === null) return refuse("malformed_token")
  if (header.alg !== "RS256" || header.crit !== undefined || (header.typ !== undefined && header.typ !== "JWT")) return refuse("unsupported_algorithm")
  const kid = header.kid
  if (typeof kid !== "string" || kid === "" || kid.length > 200) return refuse("unknown_key")

  const source = opts.keys ?? activeKeySource()
  let key: KeyObject | null
  try {
    key = signingKey(await source(), kid) ?? signingKey(await source({ refresh: true }), kid)
  } catch {
    return refuse("keys_unavailable")
  }
  if (key === null) return refuse("unknown_key")
  const signed = Buffer.from(`${headerPart}.${payloadPart}`, "ascii")
  if (!verifySignature("RSA-SHA256", signed, key, Buffer.from(signaturePart, "base64url"))) return refuse("bad_signature")

  const now = opts.nowMs / 1000
  if (typeof payload.iss !== "string" || !GOOGLE_ISSUERS.includes(payload.iss)) return refuse("wrong_issuer")
  if (typeof payload.aud !== "string" || payload.aud !== opts.audience) return refuse("wrong_audience")
  if (!isNumber(payload.exp) || now >= payload.exp + CLOCK_SKEW_SECONDS) return refuse("expired")
  if (!isNumber(payload.iat) || payload.iat > now + CLOCK_SKEW_SECONDS) return refuse("not_yet_valid")
  if (payload.nbf !== undefined && (!isNumber(payload.nbf) || payload.nbf > now + CLOCK_SKEW_SECONDS)) return refuse("not_yet_valid")
  if (payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) return refuse("lifetime_too_long")
  if (typeof payload.email !== "string" || payload.email_verified !== true) return refuse("email_unverified")
  if (typeof payload.sub !== "string" || payload.sub === "") return refuse("malformed_token")
  const email = payload.email.toLowerCase()
  const allowed = [...opts.callers].some((c) => c.toLowerCase() === email)
  if (!allowed) return refuse("caller_not_allowed")
  return { email, subject: payload.sub }
}

/** Seconds from a Cache-Control `max-age`, or null. */
function maxAgeMs(cacheControl: string | null): number | null {
  const m = /(?:^|,)\s*max-age=(\d{1,10})\s*(?:,|$)/i.exec(cacheControl ?? "")
  return m ? Number(m[1]) * 1000 : null
}

let googleCache: { at: number; until: number; set: JwkSet } | null = null

/** Test-only: forget the cached Google key set. */
export function resetGoogleKeyCacheForTests(): void {
  googleCache = null
}

/**
 * Google's OIDC key set, fetched with redirects refused and a JWKS_TIMEOUT_MS timeout, cached for its `max-age` (at most
 * JWKS_MAX_CACHE_MS; JWKS_DEFAULT_CACHE_MS without one). `refresh` refetches a set older than JWKS_REFRESH_AFTER_MS. A
 * non-2xx, a body that is not `{ keys: [...] }` or any fetch error throws (the caller refuses `keys_unavailable`).
 */
export function googleKeySource(clock: () => number = Date.now): KeySource {
  return async (opts) => {
    const now = clock()
    const cached = googleCache
    if (cached && now < cached.until && !(opts?.refresh && now - cached.at > JWKS_REFRESH_AFTER_MS)) return cached.set
    const res = await fetch(GOOGLE_JWKS_URL, { redirect: "error", signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error("google jwks status")
    }
    const body = (await res.json()) as { keys?: unknown } | null
    if (body === null || typeof body !== "object" || !Array.isArray(body.keys)) throw new Error("google jwks shape")
    const set: JwkSet = { keys: body.keys as Array<Record<string, unknown>> }
    const ttl = Math.min(maxAgeMs(res.headers.get("cache-control")) ?? JWKS_DEFAULT_CACHE_MS, JWKS_MAX_CACHE_MS)
    googleCache = { at: now, until: now + ttl, set }
    return set
  }
}

let testKeys: JwkSet | null = null

/** Test-only. Refused in production, like the other P1 test seams. */
export function setServiceKeysForTests(keys: JwkSet | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setServiceKeysForTests is test-only")
  testKeys = keys
}

/** The test key set when one is set; otherwise Google's. */
export function activeKeySource(): KeySource {
  const keys = testKeys
  return keys ? async () => keys : googleKeySource()
}
