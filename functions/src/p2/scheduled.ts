import { FieldPath } from "firebase-admin/firestore"
import { onSchedule, type ScheduleFunction } from "firebase-functions/v2/scheduler"
import { adminDb } from "../admin"
import { INTERNAL_ONLY, RUNTIME_DEFAULTS } from "../runtimeOptions"
import { logFailure } from "../log"
import { AUTO_CONFIRM_SPEC } from "../d1/entity/autoConfirmJob"
import { NAME_REINDEX_SPEC } from "../d1/conflict/reindexJob"
import { enqueueJob } from "./enqueue"
import { handlerFor } from "./registry"

/**
 * The scheduled-job primitive (spec P3-16): one run per firm per period, keyed by jobType + period
 * (the run key is `${jobType}:${periodKey}`, so a repeated tick or a backfill reuses the same job).
 * Period keys are PKT (Asia/Karachi, UTC+5, no DST) wall-clock values computed with fixed-offset
 * arithmetic, so they do not depend on the host's timezone.
 */

export type Period = "hour" | "day" | "week" | "month"
export type ScheduledJobSpec = { jobType: string; cron: string; period: Period }

/** The scheduled P2 jobs: none in 3a; the 3c auto-confirm materialisation (P3-43); the F37 conflict name index reconciliation. */
export const SCHEDULED_JOBS: readonly ScheduledJobSpec[] = [AUTO_CONFIRM_SPEC, NAME_REINDEX_SPEC]

const PKT_OFFSET_MS = 5 * 3_600_000
const DAY_MS = 86_400_000
const FIRM_PAGE_SIZE = 300
export const MAX_BACKFILL_KEYS = 366

/** A malformed or out-of-bounds period range (a caller error, not a store failure). */
export class PeriodRangeError extends Error {}

/** The job type has a schedule but no registered handler. */
export class UnregisteredJobTypeError extends Error {}

/** Some firms' runs could not be enqueued; the others were. Carries counts only. */
export class ScheduledRunsFailedError extends Error {
  readonly failed: number
  constructor(failed: number) {
    super(`scheduled runs failed for ${failed} firm run(s)`)
    this.failed = failed
  }
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0")

/** ISO 8601 week-numbering year and week of the UTC calendar date held by `d`. */
function isoWeek(d: Date): { year: number; week: number } {
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7))
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1)
  return { year: thursday.getUTCFullYear(), week: Math.floor((thursday.getTime() - jan1) / (7 * DAY_MS)) + 1 }
}

/** Formats a PKT-shifted instant (UTC fields hold PKT wall-clock) as the period's key. */
function formatShifted(period: Period, shiftedMs: number): string {
  const d = new Date(shiftedMs)
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  switch (period) {
    case "hour":
      return `${date}T${pad(d.getUTCHours())}`
    case "day":
      return date
    case "week": {
      const { year, week } = isoWeek(d)
      return `${pad(year, 4)}-W${pad(week)}`
    }
    case "month":
      return date.slice(0, 7)
  }
}

/** The period key containing `nowMs`, in PKT. */
export function periodKey(period: Period, nowMs: number): string {
  return formatShifted(period, nowMs + PKT_OFFSET_MS)
}

/** The PKT-shifted instant at the start of the period a key names, or null when the key is not valid. */
function parseKey(period: Period, key: string): number | null {
  let ms: number
  let m: RegExpMatchArray | null
  switch (period) {
    case "hour":
      m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(key)
      if (!m) return null
      ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4])
      break
    case "day":
      m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
      if (!m) return null
      ms = Date.UTC(+m[1], +m[2] - 1, +m[3])
      break
    case "week": {
      m = /^(\d{4})-W(\d{2})$/.exec(key)
      if (!m) return null
      // Jan 4 is always in ISO week 1; step back to that week's Monday, then forward whole weeks.
      const jan4 = new Date(Date.UTC(+m[1], 0, 4))
      const monday = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * DAY_MS
      ms = monday + (+m[2] - 1) * 7 * DAY_MS
      break
    }
    case "month":
      m = /^(\d{4})-(\d{2})$/.exec(key)
      if (!m) return null
      ms = Date.UTC(+m[1], +m[2] - 1, 1)
      break
  }
  // Round-trip rejects overflow (2026-02-30, week 54, hour 24, month 13).
  return Number.isFinite(ms) && formatShifted(period, ms) === key ? ms : null
}

/** The next period's start, as a PKT-shifted instant. */
function nextStart(period: Period, ms: number): number {
  switch (period) {
    case "hour":
      return ms + 3_600_000
    case "day":
      return ms + DAY_MS
    case "week":
      return ms + 7 * DAY_MS
    case "month": {
      const d = new Date(ms)
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    }
  }
}

/** Every period key from `fromKey` to `toKey`, inclusive. Bounded to `MAX_BACKFILL_KEYS` keys. */
export function periodRange(period: Period, fromKey: string, toKey: string): string[] {
  const from = parseKey(period, fromKey)
  const to = parseKey(period, toKey)
  if (from === null || to === null) throw new PeriodRangeError("invalid period key")
  if (from > to) throw new PeriodRangeError("from after to")
  const keys: string[] = []
  for (let at = from; at <= to; at = nextStart(period, at)) {
    if (keys.length >= MAX_BACKFILL_KEYS) throw new PeriodRangeError(`range spans at most ${MAX_BACKFILL_KEYS} periods`)
    keys.push(formatShifted(period, at))
  }
  return keys
}

export type RunCounts = { firms: number; created: number; reused: number; failed: number }

/** Enqueues the run for `key` for every firm, one transaction per firm, paging firms by document id. */
async function enqueueKey(spec: ScheduledJobSpec, key: string, nowMs: number, pageSize: number): Promise<RunCounts> {
  if (handlerFor(spec.jobType) === undefined) throw new UnregisteredJobTypeError(`no handler registered for ${spec.jobType}`)
  const db = adminDb()
  const counts: RunCounts = { firms: 0, created: 0, reused: 0, failed: 0 }
  const runKey = `${spec.jobType}:${key}`
  let last: string | undefined
  for (;;) {
    let q = db.collection("firms").orderBy(FieldPath.documentId()).select().limit(pageSize)
    if (last !== undefined) q = q.startAfter(last)
    const page = await q.get()
    for (const doc of page.docs) {
      counts.firms += 1
      try {
        const result = await db.runTransaction((tx) =>
          enqueueJob(
            tx,
            {
              firmId: doc.id,
              jobType: spec.jobType,
              classification: "internal",
              matterId: null,
              payload: { period: key },
              idempotencyKey: runKey,
              runKey,
              createdBy: "system",
            },
            { now: nowMs }
          )
        )
        if (result.reused) counts.reused += 1
        else counts.created += 1
      } catch (err) {
        // One firm's failure must not starve the firms after it; the caller throws once all are tried.
        counts.failed += 1
        logFailure(`scheduled run failed firm=${doc.id}`, err)
      }
    }
    if (page.size < pageSize) return counts
    last = page.docs[page.size - 1].id
  }
}

/** The tick: the run for the period containing `nowMs`, for every firm. Idempotent per firm and period. */
export async function enqueueScheduledRuns(spec: ScheduledJobSpec, nowMs: number, opts: { pageSize?: number } = {}): Promise<RunCounts> {
  const counts = await enqueueKey(spec, periodKey(spec.period, nowMs), nowMs, opts.pageSize ?? FIRM_PAGE_SIZE)
  if (counts.failed > 0) throw new ScheduledRunsFailedError(counts.failed)
  return counts
}

/** Enqueues every period of the inclusive range for every firm; re-running it creates nothing new. */
export async function backfillScheduledRuns(spec: ScheduledJobSpec, fromKey: string, toKey: string, nowMs: number): Promise<RunCounts> {
  const keys = periodRange(spec.period, fromKey, toKey)
  const total: RunCounts = { firms: 0, created: 0, reused: 0, failed: 0 }
  for (const key of keys) {
    const c = await enqueueKey(spec, key, nowMs, FIRM_PAGE_SIZE)
    total.firms = Math.max(total.firms, c.firms)
    total.created += c.created
    total.reused += c.reused
    total.failed += c.failed
  }
  if (total.failed > 0) throw new ScheduledRunsFailedError(total.failed)
  return total
}

/**
 * O-43 (P3-51): a tick that throws (`ScheduledRunsFailedError`, a firm-page read failure) is retried
 * by the scheduler, 3 times at 60 s to 600 s. Safe because a run is keyed per firm and period, so a
 * retry reuses the jobs the failed tick already created.
 */
export const SCHEDULE_RETRY = { retryCount: 3, minBackoffSeconds: 60, maxBackoffSeconds: 600 } as const

/** A deployed schedule for `spec`, in PKT. */
export function scheduledJobFunction(spec: ScheduledJobSpec): ScheduleFunction {
  return onSchedule(
    {
      ...RUNTIME_DEFAULTS,
      schedule: spec.cron,
      timeZone: "Asia/Karachi",
      maxInstances: 1,
      timeoutSeconds: 60,
      ingressSettings: INTERNAL_ONLY,
      ...SCHEDULE_RETRY,
    },
    async () => {
      await enqueueScheduledRuns(spec, Date.now())
    }
  )
}
