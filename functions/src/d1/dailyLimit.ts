import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { RateLimitedError } from "../http/errors"
import { karachiDay } from "./numbering"

/**
 * Per-firm daily cap on conflict checks (spec P2-17, L8156-8157): 100 per Asia/Karachi day,
 * counted in `counters/{firmId}_conflictday_{YYYYMMDD}` = { firmId, count, expiresAt, classification }.
 * The count only grows for an admitted check (it is staged in the check's own transaction), so a
 * refused call leaves it at the cap. The 101st call → 429 `daily_limit` with Retry-After to the
 * next Karachi midnight.
 */

export const DAILY_CONFLICT_LIMIT = 100

/** Counter docs outlive their day by two days, then the TTL policy may delete them. */
const COUNTER_TTL_MS = 2 * 24 * 60 * 60 * 1000

/** Milliseconds `now`'s Karachi wall clock is ahead of UTC (Intl, so a future DST rule is honoured). */
function karachiOffsetMs(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now)
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"))
  return wall - Math.floor(now.getTime() / 1000) * 1000
}

/** The instant of the next Asia/Karachi midnight after `now`, in epoch ms. */
export function nextKarachiMidnight(now: Date): number {
  const offset = karachiOffsetMs(now)
  const wall = new Date(now.getTime() + offset)
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1) - offset
}

/** Whole seconds until the next Asia/Karachi midnight, at least 1. */
export function secondsToKarachiMidnight(now: Date): number {
  return Math.max(1, Math.ceil((nextKarachiMidnight(now) - now.getTime()) / 1000))
}

const counterRef = (firmId: string, now: Date) => adminDb().collection("counters").doc(`${firmId}_conflictday_${karachiDay(now)}`)

/** The stored count; a malformed one reads as infinite (fails closed). */
function countOf(data: Record<string, unknown> | undefined): number {
  if (data === undefined) return 0
  const raw = data.count
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : Number.POSITIVE_INFINITY
}

/**
 * A cheap non-transactional look at the day counter, before the registry is read: refuses with
 * RateLimitedError(secondsToKarachiMidnight, "daily_limit") when the firm is already at the cap.
 * Advisory only; consumeDailyConflict in the check's transaction stays authoritative.
 */
export async function assertDailyConflictOpen(firmId: string, now: Date): Promise<void> {
  const data = (await counterRef(firmId, now).get()).data()
  if (countOf(data) >= DAILY_CONFLICT_LIMIT) throw new RateLimitedError(secondsToKarachiMidnight(now), "daily_limit")
}

/**
 * Counts one conflict check for the firm's Karachi day, or refuses it with
 * RateLimitedError(secondsToKarachiMidnight, "daily_limit") once DAILY_CONFLICT_LIMIT are counted.
 * With `tx` the read and the increment join the caller's transaction (call it before the
 * transaction's writes); without, it runs its own. A malformed count fails closed (refused).
 */
export async function consumeDailyConflict(firmId: string, now: Date, tx?: Transaction): Promise<void> {
  if (!tx) return adminDb().runTransaction((own) => consumeDailyConflict(firmId, now, own))
  const ref = counterRef(firmId, now)
  const data = (await tx.get(ref)).data()
  if (countOf(data) >= DAILY_CONFLICT_LIMIT) throw new RateLimitedError(secondsToKarachiMidnight(now), "daily_limit")
  const expiresAt = Timestamp.fromMillis(nextKarachiMidnight(now) + COUNTER_TTL_MS)
  if (data) tx.update(ref, { count: FieldValue.increment(1) })
  else tx.create(ref, { firmId, count: 1, expiresAt, classification: "internal", createdAt: FieldValue.serverTimestamp() })
}
