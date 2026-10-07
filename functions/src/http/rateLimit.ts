import { FieldValue, Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { trustedProxyHops } from "../deployConfig"
import { logFailure } from "../log"
import { HttpError, RateLimitedError } from "./errors"

export { RateLimitedError }

/**
 * Per-user rate limits (L18 §4.4), fixed one-minute UTC windows. Each window
 * is a counter doc `rate_limits/{uid}_{kind}_{yyyyMMddHHmm}`. A request
 * increments it atomically (FieldValue.increment) and reads it back; if the
 * count exceeds the limit it is refused with 429 `rate_limited` and a
 * Retry-After of the seconds left in the window (≥ 1).
 *
 * Why not a read-modify-write transaction: concurrent requests from one user
 * all contend on the same doc, and 30 parallel calls stalled past 15 s on the
 * emulator. Increment + read never admits more than the limit (each read sees
 * at least the request's own increment, so an admitted request is among the
 * first `limit`); under a burst it may refuse a few more than strictly needed.
 * Refused requests are counted too, which only keeps the window closed.
 * The collection is server-only (no rules match) and carries `expiresAt` for
 * a Firestore TTL policy.
 *
 * Out of scope here (follow-up): the spec's per-firm daily limits (100/day
 * conflict checks, 500/day WhatsApp research).
 */

export type RateKind = "general" | "p1"

/** Per-user requests per minute: general, and P1-backed operations (research, draft, translate, ...). */
export const DEFAULT_LIMITS: Readonly<Record<RateKind, number>> = { general: 60, p1: 10 }

/** Requests per minute per client IP that fail authentication (keeps anonymous calls from flooding audit_log). */
export const ANONYMOUS_IP_LIMIT = 60

/**
 * Upper bound for a per-firm override in `firms/{firmId}.rateLimits`. That doc is server-only:
 * the rules deny every client write, so only Cloud Functions (Admin SDK) set an override (E-34).
 * The cap is defence in depth against a bad server-side value, not against a client.
 */
export const MAX_LIMIT_OVERRIDE = 1000

const WINDOW_MS = 60_000
/** Counter docs outlive their window by an hour, then the TTL policy may delete them. */
const COUNTER_TTL_MS = 60 * 60 * 1000

const pad = (n: number, width = 2) => String(n).padStart(width, "0")

/** The UTC minute of `nowMs` as yyyyMMddHHmm. */
export function windowId(nowMs: number): string {
  const d = new Date(nowMs)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
}

function windowEnd(nowMs: number): number {
  return (Math.floor(nowMs / WINDOW_MS) + 1) * WINDOW_MS
}

/** Whole seconds until the current window ends, at least 1. */
export function retryAfterSeconds(nowMs: number): number {
  return Math.max(1, Math.ceil((windowEnd(nowMs) - nowMs) / 1000))
}

/**
 * The per-user limit for `kind`: `firms/{firmId}.rateLimits[kind]` when it is
 * an integer in 1..MAX_LIMIT_OVERRIDE (spec: configurable per firm), else the default.
 */
export function limitFor(kind: RateKind, firm: Record<string, unknown> | undefined): number {
  const overrides = firm?.rateLimits
  const value: unknown = overrides !== null && typeof overrides === "object" ? (overrides as Record<string, unknown>)[kind] : undefined
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT_OVERRIDE
    ? value
    : DEFAULT_LIMITS[kind]
}

/**
 * Counts one request on `rate_limits/{docId}` and refuses it when the count
 * is over `limit` → RateLimitedError. The store failing → 503
 * store_unavailable (fails closed).
 */
async function consume(docId: string, limit: number, nowMs: number): Promise<void> {
  const ref = adminDb().collection("rate_limits").doc(docId)
  let count: unknown
  try {
    await ref.set(
      { count: FieldValue.increment(1), expiresAt: Timestamp.fromMillis(windowEnd(nowMs) + COUNTER_TTL_MS) },
      { merge: true }
    )
    count = (await ref.get()).data()?.count
  } catch (err) {
    logFailure("rate limit store failed", err)
    throw new HttpError(503, "store_unavailable")
  }
  if (typeof count !== "number" || count > limit) throw new RateLimitedError(retryAfterSeconds(nowMs))
}

/** Per-user limit for an authenticated request, per firm override if the firm doc sets one. */
export async function rateLimit(
  caller: { uid: string },
  kind: RateKind,
  opts: { firm?: Record<string, unknown>; now?: number } = {}
): Promise<void> {
  const now = opts.now ?? Date.now()
  await consume(`${caller.uid}_${kind}_${windowId(now)}`, limitFor(kind, opts.firm), now)
}

/**
 * The client IP for the per-IP limit: with TRUSTED_PROXY_HOPS = N, the entry
 * N+1 from the right of X-Forwarded-For (N = 0: the last hop); else `req.ip`.
 * Google's front end appends the address of the connection it received, and
 * each trusted proxy appends its own after that; every hop to the left of the
 * client's is whatever the client sent, so keying on it would let a caller
 * pick a fresh key per request. A header with fewer hops than expected did not
 * come through the trusted proxies, so `req.ip` is used.
 */
export function clientIp(req: { headers: Record<string, unknown>; ip?: string }): string {
  const raw = req.headers["x-forwarded-for"]
  const value = Array.isArray(raw) ? raw.join(",") : typeof raw === "string" ? raw : ""
  const hops = value.split(",").map((h) => h.trim()).filter((h) => h !== "")
  return hops[hops.length - 1 - trustedProxyHops()] ?? req.ip ?? "unknown"
}

/** Per-IP limit for requests that failed authentication: `rate_limits/ip:{ip}_anon_{yyyyMMddHHmm}`. */
export async function rateLimitAnonymous(ip: string, now = Date.now()): Promise<void> {
  const safeIp = ip.replace(/[^0-9A-Za-z.:-]/g, "_").slice(0, 64) || "unknown"
  await consume(`ip:${safeIp}_anon_${windowId(now)}`, ANONYMOUS_IP_LIMIT, now)
}
