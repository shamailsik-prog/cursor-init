export type FilingEscalationClosureSettlementArbitrationStatus =
  | "arbitration_pending"
  | "verification_override_petitioned"
  | "panel_confirmation_attested"
  | "reopen_veto_checkpointed"

export type FilingEscalationClosureQueueReentryComplianceStatus =
  | "compliance_pending"
  | "reentry_exception_attested"
  | "timeout_waiver_checkpointed"
  | "reconciliation_resumed"

export function filingEscalationClosureSettlementArbitrationId(
  settlementAttestationId: string
): string {
  return `closure-settlement-arbitration:${settlementAttestationId}`
}

export function filingEscalationClosureQueueReentryComplianceId(
  queueReconciliationId: string
): string {
  return `closure-queue-reentry-compliance:${queueReconciliationId}`
}

export function isFilingEscalationClosureSettlementArbitrationStatus(
  value: string | null
): value is FilingEscalationClosureSettlementArbitrationStatus {
  return (
    value === "arbitration_pending" ||
    value === "verification_override_petitioned" ||
    value === "panel_confirmation_attested" ||
    value === "reopen_veto_checkpointed"
  )
}

export function isFilingEscalationClosureQueueReentryComplianceStatus(
  value: string | null
): value is FilingEscalationClosureQueueReentryComplianceStatus {
  return (
    value === "compliance_pending" ||
    value === "reentry_exception_attested" ||
    value === "timeout_waiver_checkpointed" ||
    value === "reconciliation_resumed"
  )
}
