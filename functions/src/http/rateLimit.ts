import { Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { logFailure } from "../p5/common"
import { HttpError } from "./errors"

/**
 * Per-user rate limits (L18 §4.4), fixed one-minute UTC windows. Each window
 * is a counter doc `rate_limits/{uid}_{kind}_{yyyyMMddHHmm}` incremented in a
 * transaction; the request that would exceed the limit is refused with 429
 * `rate_limited` and a Retry-After of the seconds left in the window (≥ 1).
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

/** Upper bound for a per-firm override in `firms/{firmId}.rateLimits` (that doc is partner-writable). */
export const MAX_LIMIT_OVERRIDE = 1000

const WINDOW_MS = 60_000
/** Counter docs outlive their window by an hour, then the TTL policy may delete them. */
const COUNTER_TTL_MS = 60 * 60 * 1000

export class RateLimitedError extends HttpError {
  constructor(readonly retryAfter: number) {
    super(429, "rate_limited")
    this.name = "RateLimitedError"
  }
}

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
 * Takes one request from the counter `rate_limits/{docId}` (limit per window).
 * Over the limit → RateLimitedError (the count is not incremented). The store
 * failing → 503 store_unavailable (fails closed).
 */
async function consume(docId: string, limit: number, nowMs: number): Promise<void> {
  const db = adminDb()
  const ref = db.collection("rate_limits").doc(docId)
  let allowed: boolean
  try {
    allowed = await db.runTransaction(async (tx) => {
      const count: unknown = (await tx.get(ref)).data()?.count
      const used = typeof count === "number" ? count : 0
      if (used >= limit) return false
      tx.set(ref, { count: used + 1, expiresAt: Timestamp.fromMillis(windowEnd(nowMs) + COUNTER_TTL_MS) })
      return true
    })
  } catch (err) {
    logFailure("rate limit store failed", err)
    throw new HttpError(503, "store_unavailable")
  }
  if (!allowed) throw new RateLimitedError(retryAfterSeconds(nowMs))
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

/** Per-IP limit for requests that failed authentication: `rate_limits/ip:{ip}_anon_{yyyyMMddHHmm}`. */
export async function rateLimitAnonymous(ip: string, now = Date.now()): Promise<void> {
  const safeIp = ip.replace(/[^0-9A-Za-z.:-]/g, "_").slice(0, 64) || "unknown"
  await consume(`ip:${safeIp}_anon_${windowId(now)}`, ANONYMOUS_IP_LIMIT, now)
}
