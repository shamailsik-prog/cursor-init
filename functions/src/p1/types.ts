/** P1 gateway shared types (spec P3-61..P3-68). Pure: no I/O. */

/** The task types, each routed to a model in `TASK_MODEL` (P3-62; `drafting` is Phase 4b's, P4B-4). */
export type TaskType = "committee" | "drafting"

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

export type P1Outcome = "ok" | "failed" | "blocked"

/** The fixed reason recorded for any provider failure; provider error text is never stored (P3-61). */
export const TRANSPORT_ERROR = "transport_error"
