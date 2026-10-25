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
 * How long an acknowledgment holds (spec R18, re-audit FA-F43-R1-002): a raise this long or longer after the alert was
 * acknowledged opens a new episode at level 0, with a page, instead of being counted into the acknowledged one.
 */
export const ACK_HOLD_MS = 4 * 3_600_000

/**
 * Conditions whose alerts never escalate (spec R23): a kill switch is only ever set by a deliberate act of a partner or
 * a platform admin, so its alert pages the on-call operator once at level 0 and is not escalated to the people who set
 * it; for the same reason an acknowledgment of it holds while the switch stays on.
 */
const NON_ESCALATING: ReadonlySet<AlertCondition> = new Set(["ai.kill_switch_blocked"])

/** True when alerts of `condition` escalate up the owner ladder (every condition but a kill switch's). */
export function escalates(condition: AlertCondition): boolean {
  return !NON_ESCALATING.has(condition)
}

/**
 * The `firmId` of an alert that belongs to the platform, not to a firm (spec R24): the platform kill switch. Firestore
 * reserves document ids matching `__.*__`, so no firm can have this id, and no partner route, worklist or ladder reaches
 * the alert; the operator acts on it.
 */
export const PLATFORM_ALERT_FIRM = "__platform__"

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
  /**
   * Spec R24: a raise of an existing, live alert writes nothing (no count). For a subject shared by every firm, whose
   * every raise would otherwise write one hot document inside the raising transactions; the alert is still created,
   * and reopened, as any other.
   */
  observeOnly?: boolean
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
  /**
   * Spec R22: set when the checker read its whole query and no longer observed this derived condition; a cleared alert
   * has no deadline (the escalator skips it) and stays open for a person to resolve. Absent on alerts written before.
   */
  clearedAt?: Timestamp | null
  /** Spec R21: re-pages of the last level in this episode. Absent on alerts written before (read as 0). */
  repages?: number
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

/** The outbox row of one page: one per alert, episode and level, and one per re-page of the last level (spec R21). */
export function pageIdFor(alertId: string, episode: number, level: number, repage = 0): string {
  return repage > 0 ? `${alertId}_e${episode}_l${level}_r${repage}` : `${alertId}_e${episode}_l${level}`
}
