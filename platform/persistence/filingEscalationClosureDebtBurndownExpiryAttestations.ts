export type FilingEscalationClosureAdjudicationDebtBurndownStatus =
  | "burndown_tracking"
  | "burndown_checkpoint_due"
  | "burndown_attested"
  | "burndown_forecast_breached"

export type FilingEscalationClosureSafeguardExpiryAttestationStatus =
  | "attestation_open"
  | "attestation_acknowledged"
  | "attestation_overdue"
  | "attestation_reconciled"

export function filingEscalationClosureAdjudicationDebtBurndownId(remediationId: string): string {
  return `closure-adjudication-debt-burndown:${remediationId}`
}

export function filingEscalationClosureSafeguardExpiryAttestationId(expiryId: string): string {
  return `closure-safeguard-expiry-attestation:${expiryId}`
}

export function isFilingEscalationClosureAdjudicationDebtBurndownStatus(
  value: string | null
): value is FilingEscalationClosureAdjudicationDebtBurndownStatus {
  return (
    value === "burndown_tracking" ||
    value === "burndown_checkpoint_due" ||
    value === "burndown_attested" ||
    value === "burndown_forecast_breached"
  )
}

export function isFilingEscalationClosureSafeguardExpiryAttestationStatus(
  value: string | null
): value is FilingEscalationClosureSafeguardExpiryAttestationStatus {
  return (
    value === "attestation_open" ||
    value === "attestation_acknowledged" ||
    value === "attestation_overdue" ||
    value === "attestation_reconciled"
  )
}
