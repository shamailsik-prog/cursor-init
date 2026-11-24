/**
 * GOV-291-001 is closed by unreachability. A durable store cannot record a void:
 * p6_enforce_proposal_transition refuses pending → rejected and approved → rejected,
 * and it freezes every other column. Until that edge exists (W2-DURABLE-VOID, a migration),
 * an L4.6 seal on any store other than the in-memory test store is refused.
 * Removing this guard requires that migration.
 */
export const LEARNING_DURABLE_VOID_ERROR = "learning_requires_durable_void (W2-DURABLE-VOID)"

export function refuseDurableLearningSeal(): never {
  throw new Error(LEARNING_DURABLE_VOID_ERROR)
}
