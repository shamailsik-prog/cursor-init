/** P1 gateway shared types (spec P3-61..P3-68). Pure: no I/O. */

/** The one task type this phase (P3-62). */
export type TaskType = "committee"

/** Why a call was refused before any provider call: a fixed set, never free text (P3-61). */
export type BlockReason =
  | "kill_switch_platform"
  | "kill_switch_firm"
  | "policy_denied"
  | "not_minimised"
  | "model_unpriced"
  | "budget_not_set"
  | "budget_exhausted"
  | "no_credentials"
  /** F08: the firm has a provider attempt whose lease lapsed unsettled; nothing more is spent until it is reconciled. */
  | "accounting_indeterminate"
  /** F07: the firm already holds its maximum of live reservations (`ai_config.maxConcurrentCalls`, default 4). */
  | "concurrency_exhausted"
  /** F07, F08: the reservation or the provider-attempt record could not be written, so nothing was sent. */
  | "reservation_failed"

export type P1Outcome = "ok" | "failed" | "blocked"

/** A usage row's outcome: a decision's own, or `reconciled` when the lease reconciler wrote the row (F08). */
export type UsageOutcome = P1Outcome | "reconciled"

/**
 * Whether a call's books are complete (F08), apart from whether its result is available: `settled` when its usage
 * row and the month total are committed; `pending` when they are not, in which case any provider spend stays held
 * by the call's reservation (`ai_reservations/{usageLogId}`) until the lease reconciler settles it.
 */
export type P1Accounting = "settled" | "pending"

/**
 * A reservation's state (F07, F08): held, settled at a charge, released with no charge, or quarantined by the reconciler
 * after repeated failures (`reconcile_failed`, re-audit R1-D2), which keeps its hold and its firm blocked.
 */
export type ReservationState = "reserved" | "settled" | "released" | "reconcile_failed"

/** The fixed reason recorded for any provider failure; provider error text is never stored (P3-61). */
export const TRANSPORT_ERROR = "transport_error"
