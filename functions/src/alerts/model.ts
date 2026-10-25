import { createHash } from "node:crypto"
import type { CollectionReference, Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../admin"

/**
 * Operational alerts (audit F43; spec `docs/superpowers/specs/2026-10-24-f43-durable-alert-delivery-design.md`). Pure
 * values and the collection handles: no I/O at import. The alert document is the delivery mechanism of record; a log
 * line only announces it.
 */

/** Every condition that raises an alert (spec R8). */
export const ALERT_CONDITIONS = [
  "job.dead_lettered",
  "job.dispatch_stalled",
  "job.commit_failed",
  "job.queue_age",
  "saga.age",
  "ai.budget_threshold",
  "ai.kill_switch_blocked",
  "ai.reservation_failed",
  "ai.reservation_unresolved",
  // Audit F42: a matter deletion whose stores are not all acknowledged by the deadline (functions/src/retention/watch.ts).
  "retention.deletion_unacknowledged",
] as const
export type AlertCondition = (typeof ALERT_CONDITIONS)[number]

/** Severities, lowest first (spec R4). */
export const SEVERITIES = ["warning", "high", "critical"] as const
export type Severity = (typeof SEVERITIES)[number]

/** How long an alert at each severity waits for acknowledgment before it escalates (spec R4). */
export const ACK_WINDOW_MS: Readonly<Record<Severity, number>> = { critical: 15 * 60_000, high: 30 * 60_000, warning: 4 * 3_600_000 }

/**
 * Who owns an alert at each escalation level (spec R4): the named on-call operator first (only the operator can repair
 * a queue, a store or the reconciler), then the firm's partners (their work is stalled; they can retry, cancel, raise a
 * budget or call the operator), then the firm administrator (the founding partner).
 */
export const OWNER_LADDER = ["operator", "partner", "firm_admin"] as const
export type OwnerRole = (typeof OWNER_LADDER)[number]
/** The last escalation level. */
export const LAST_LEVEL = OWNER_LADDER.length - 1

export const ALERT_STATES = ["open", "acknowledged", "resolved"] as const
export type AlertState = (typeof ALERT_STATES)[number]

/** A row re-dispatched this many times by the sweeper without a claim is a stalled dispatch (spec R8). */
export const DISPATCH_STALL_REDISPATCHES = 3
/** A job waiting (due, or past its lease) this long is reported by the checker and the sweeper (spec R8). */
export const JOB_WAIT_ALERT_MS = 15 * 60_000
/** An un-merge saga in progress this long is reported (spec R8). */
export const SAGA_AGE_ALERT_MS = 60 * 60_000
/** A P1 reservation still held this long after its lease (the reconciler runs every minute) is reported (spec R8). */
export const RESERVATION_UNRESOLVED_ALERT_MS = 10 * 60_000

/** One step up the severity order, capped at critical. */
export function raiseSeverity(s: Severity): Severity {
  return SEVERITIES[Math.min(SEVERITIES.indexOf(s) + 1, SEVERITIES.length - 1)]
}

/** The higher of two severities. */
export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITIES.indexOf(a) >= SEVERITIES.indexOf(b) ? a : b
}

export function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v)
}

/**
 * `"a"` + the first 40 hex characters of SHA-256 of the JSON array `[condition, firmId, subjectKey]`: one document per
 * condition and subject. JSON, not a separator join, so no part can forge another's boundary.
 */
export function alertIdFor(condition: string, firmId: string, subjectKey: string): string {
  return "a" + createHash("sha256").update(JSON.stringify([condition, firmId, subjectKey])).digest("hex").slice(0, 40)
}

/** A detail value: an integer, or a code / id / path of `[A-Za-z0-9_.:/-]`, 1 to 128 characters. */
const DETAIL_TEXT = /^[A-Za-z0-9_.:/-]{1,128}$/
const DETAIL_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
const MAX_DETAIL_KEYS = 12

export type AlertDetail = Readonly<Record<string, string | number>>

/**
 * Spec R2: an alert carries codes, ids and integers only, never text a person wrote or a job's payload. Anything else
 * is a programming error and throws before any write.
 */
export function assertSafeDetail(detail: Record<string, unknown>): asserts detail is AlertDetail {
  const entries = Object.entries(detail)
  if (entries.length > MAX_DETAIL_KEYS) throw new Error("alert detail: too many keys")
  for (const [key, value] of entries) {
    if (!DETAIL_KEY.test(key)) throw new Error("alert detail: invalid key")
    if (typeof value === "number" ? !Number.isSafeInteger(value) : typeof value !== "string" || !DETAIL_TEXT.test(value)) {
      throw new Error(`alert detail: invalid value for ${key}`)
    }
  }
}

/** What a caller raises: the condition, its firm and subject, the latest concrete reference and the observation. */
export type AlertSpec = {
  condition: AlertCondition
  firmId: string
  /** `kind:id`, e.g. `job:j3a…`, `jobType:platform.diagnostic`, `budget:2026-10:90`. */
  subjectKey: string
  /** The latest concrete document path, e.g. `jobs/j3a…`; null when there is none. */
  ref: string | null
  severity: Severity
  detail: Record<string, string | number>
}

export type ActorRecord = { uid: string; role: "operator" | "partner" }
export type AlertActionRecord = { action: "acknowledge" | "resolve"; by: string; role: "operator" | "partner"; level: number; at: Timestamp }
export type EscalationStep = { level: number; ownerRole: OwnerRole; severity: Severity; at: Timestamp }

/** The stored alert (spec R1). */
export type AlertRow = {
  schemaVersion: 1
  condition: AlertCondition
  firmId: string
  subjectKey: string
  ref: string | null
  detail: AlertDetail
  baseSeverity: Severity
  severity: Severity
  state: AlertState
  level: number
  ownerRole: OwnerRole
  episode: number
  count: number
  totalCount: number
  firstSeenAt: Timestamp
  lastSeenAt: Timestamp
  escalateAt: Timestamp | null
  escalations: EscalationStep[]
  actions: AlertActionRecord[]
  acknowledgedAt: Timestamp | null
  acknowledgedBy: ActorRecord | null
  resolvedAt: Timestamp | null
  resolvedBy: ActorRecord | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** The acknowledge and resolve records kept on an alert. */
export const MAX_ACTIONS = 20

export const OPS_ALERTS = "ops_alerts"
export const ALERT_OUTBOX = "ops_alert_notifications"
export const USER_NOTIFICATIONS = "notifications"

export function opsAlertsRef(): CollectionReference {
  return adminDb().collection(OPS_ALERTS)
}

export function alertOutboxRef(): CollectionReference {
  return adminDb().collection(ALERT_OUTBOX)
}

/** The outbox row of one page: one per alert, episode and level. */
export function pageIdFor(alertId: string, episode: number, level: number): string {
  return `${alertId}_e${episode}_l${level}`
}
