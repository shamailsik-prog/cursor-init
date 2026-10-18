import { createHash } from "node:crypto"
import { Timestamp, type DocumentData, type DocumentReference } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { effectiveLinkState, LINK_AUTO_CONFIRM_MS } from "./linkState"

/**
 * Why the auto-confirm job passed a pair over, and when it looks again (audit F38; spec
 * `docs/superpowers/specs/2026-10-18-f38-auto-confirm-progress-design.md`, R2-R5).
 *
 * A pair the job re-checks and cannot confirm gets one record in `autoconfirm_deferrals` (server-only), written
 * in the step's transaction: the reason (a code), the ids, when it was first and last checked, and `recheckAt`,
 * when the job may usefully look again. Codes and ids only. A pair that is confirmed, or that has left the
 * backlog, loses its record in the same transaction. The job's recheck query (`firmId ==`, `recheckAt <= now`)
 * brings due records back, so a stuck pair costs one re-check per interval, not one per run.
 */

export const AUTO_CONFIRM_DEFERRALS = "autoconfirm_deferrals"

/** How long a pair deferred for a cause that does not lapse by itself waits before the job re-checks it (R4). */
export const AUTO_CONFIRM_RECHECK_MS = 7 * 24 * 60 * 60 * 1000

/** Row reasons, strongest first (R3): the first one any row of the pair has decides. */
export const ROW_REASONS = ["unmerge_in_progress", "confirmed_row", "rejected_row", "disputed_row", "invalid_row", "young_row"] as const
export type RowReason = (typeof ROW_REASONS)[number]
/** Every deferral reason: the pair read's entity causes, the row causes and the P3-57 event skip. */
export type DeferralReason = "entity_missing" | "entity_other_firm" | RowReason | "event_exists"

/** What the rows say about a pair: confirm it, defer it (why, which row, until when), or it has left the backlog. */
export type Verdict = { kind: "eligible" } | { kind: "gone" } | { kind: "deferred"; reason: RowReason; rowId: string; recheckAtMs: number }

const millisOf = (value: unknown): number | null => (value instanceof Timestamp ? value.toMillis() : null)

/** The scan's predicate (R1): an undisputed candidate whose Timestamp `createdAt` is at least 30 days old. */
export function inBacklog(row: DocumentData, nowMs: number): boolean {
  const created = millisOf(row.createdAt)
  return row.state === "candidate" && row.disputed === false && created !== null && created <= nowMs - LINK_AUTO_CONFIRM_MS
}

/** The reason one row keeps its pair from auto-confirming, or null when it reads `auto_confirmed`. */
function rowReason(row: DocumentData, nowMs: number): RowReason | null {
  switch (effectiveLinkState(row, nowMs, true)) {
    case "auto_confirmed":
      return null
    case "unmerging":
      return "unmerge_in_progress"
    case "confirmed":
      return "confirmed_row"
    case "rejected":
      return "rejected_row"
    case "disputed":
      return "disputed_row"
    case "candidate":
      // An undisputed candidate with a Timestamp createdAt that has not aged yet; any other candidate reading is malformed.
      return row.state === "candidate" && row.disputed === false && millisOf(row.createdAt) !== null ? "young_row" : "invalid_row"
  }
}

/**
 * The verdict on a pair's rows at `nowMs` (R3, R4). No row left in the scan's predicate: the pair has left the
 * backlog. Every row `auto_confirmed` (the P3-44 re-check): eligible. Otherwise deferred for the strongest row
 * reason, naming the first row with it; a young row defers until the latest young row's 30-day mark, any other
 * reason for `AUTO_CONFIRM_RECHECK_MS`.
 */
export function judgeRows(rows: ReadonlyArray<{ id: string; data: DocumentData }>, nowMs: number): Verdict {
  if (!rows.some((r) => inBacklog(r.data, nowMs))) return { kind: "gone" }
  const read = rows.map((r) => ({ id: r.id, created: millisOf(r.data.createdAt), reason: rowReason(r.data, nowMs) }))
  for (const reason of ROW_REASONS) {
    const deciding = read.filter((r) => r.reason === reason)
    if (deciding.length === 0) continue
    const recheckAtMs = reason === "young_row" ? Math.max(...deciding.map((r) => (r.created as number) + LINK_AUTO_CONFIRM_MS)) : nowMs + AUTO_CONFIRM_RECHECK_MS
    return { kind: "deferred", reason, rowId: deciding[0].id, recheckAtMs }
  }
  return { kind: "eligible" }
}

/** The record id (R2): `acd_` and the first 40 hex characters of SHA-256(firmId NUL pairId), so firms never share one. */
export function deferralIdOf(firmId: string, pairId: string): string {
  return "acd_" + createHash("sha256").update(`${firmId}\0${pairId}`).digest("hex").slice(0, 40)
}

export const deferralRefOf = (firmId: string, pairId: string): DocumentReference => adminDb().collection(AUTO_CONFIRM_DEFERRALS).doc(deferralIdOf(firmId, pairId))

export type DeferralInput = {
  firmId: string
  pairId: string
  leftId: string
  rightId: string
  linkIds: string[]
  reason: DeferralReason
  rowId: string | null
  recheckAtMs: number
  nowMs: number
  jobId: string
  /** The record as read in the step's transaction, if any. Its `since` and `checks` carry over when it is this pair's. */
  previous: DocumentData | undefined
}

/** The record to write for a deferred pair (R2): codes and ids only, label `internal`. */
export function deferralRecord(d: DeferralInput): DocumentData {
  const mine = d.previous !== undefined && d.previous.firmId === d.firmId && d.previous.pairId === d.pairId
  const since = mine && d.previous!.since instanceof Timestamp ? d.previous!.since : Timestamp.fromMillis(d.nowMs)
  const checks = mine && Number.isSafeInteger(d.previous!.checks) && (d.previous!.checks as number) >= 0 ? (d.previous!.checks as number) + 1 : 1
  return {
    firmId: d.firmId,
    pairId: d.pairId,
    leftId: d.leftId,
    rightId: d.rightId,
    linkIds: d.linkIds,
    reason: d.reason,
    rowId: d.rowId,
    since,
    lastCheckedAt: Timestamp.fromMillis(d.nowMs),
    recheckAt: Timestamp.fromMillis(d.recheckAtMs),
    checks,
    jobId: d.jobId,
    classification: "internal",
  }
}
