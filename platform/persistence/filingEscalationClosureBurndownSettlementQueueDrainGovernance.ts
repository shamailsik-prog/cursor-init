export type FilingEscalationClosureBurndownSettlementStatus =
  | "settlement_pending"
  | "drift_acknowledged"
  | "target_lock_attested"
  | "rollback_resolution_closed"

export type FilingEscalationClosureExpiryAttestationQueueDrainStatus =
  | "drain_pending"
  | "handoff_timeout_escalated"
  | "stale_reassignment_attested"
  | "forced_drain_checkpointed"

export function filingEscalationClosureBurndownSettlementId(recalibrationId: string): string {
  return `closure-burndown-settlement:${recalibrationId}`
}

export function filingEscalationClosureExpiryAttestationQueueDrainId(queueId: string): string {
  return `closure-expiry-attestation-queue-drain:${queueId}`
}

export function isFilingEscalationClosureBurndownSettlementStatus(
  value: string | null
): value is FilingEscalationClosureBurndownSettlementStatus {
  return (
    value === "settlement_pending" ||
    value === "drift_acknowledged" ||
    value === "target_lock_attested" ||
    value === "rollback_resolution_closed"
  )
}

export function isFilingEscalationClosureExpiryAttestationQueueDrainStatus(
  value: string | null
): value is FilingEscalationClosureExpiryAttestationQueueDrainStatus {
  return (
    value === "drain_pending" ||
    value === "handoff_timeout_escalated" ||
    value === "stale_reassignment_attested" ||
    value === "forced_drain_checkpointed"
  )
}
