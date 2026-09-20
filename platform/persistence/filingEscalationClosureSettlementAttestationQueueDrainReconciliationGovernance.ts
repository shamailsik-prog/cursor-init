export type FilingEscalationClosureSettlementAttestationStatus =
  | "verification_pending"
  | "lock_release_attested"
  | "dispute_reopen_guarded"
  | "settlement_verified"

export type FilingEscalationClosureQueueDrainReconciliationStatus =
  | "reconciliation_pending"
  | "forced_drain_attested"
  | "reassignment_rollback_checkpointed"
  | "timeout_reentry_controlled"

export function filingEscalationClosureSettlementAttestationId(settlementId: string): string {
  return `closure-settlement-attestation:${settlementId}`
}

export function filingEscalationClosureQueueDrainReconciliationId(queueDrainId: string): string {
  return `closure-queue-drain-reconciliation:${queueDrainId}`
}

export function isFilingEscalationClosureSettlementAttestationStatus(
  value: string | null
): value is FilingEscalationClosureSettlementAttestationStatus {
  return (
    value === "verification_pending" ||
    value === "lock_release_attested" ||
    value === "dispute_reopen_guarded" ||
    value === "settlement_verified"
  )
}

export function isFilingEscalationClosureQueueDrainReconciliationStatus(
  value: string | null
): value is FilingEscalationClosureQueueDrainReconciliationStatus {
  return (
    value === "reconciliation_pending" ||
    value === "forced_drain_attested" ||
    value === "reassignment_rollback_checkpointed" ||
    value === "timeout_reentry_controlled"
  )
}
