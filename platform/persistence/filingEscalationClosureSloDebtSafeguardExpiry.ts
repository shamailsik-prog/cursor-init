export type FilingEscalationClosureAdjudicationSloDebtRemediationStatus =
  | "debt_open"
  | "debt_retirement_pending"
  | "debt_retired"
  | "breach_closure_attested"

export type FilingEscalationClosureRebalanceSafeguardExpiryStatus =
  | "expiry_pending"
  | "auto_cleared"
  | "override_expired"
  | "stale_lock_cleaned"

export function filingEscalationClosureAdjudicationSloDebtRemediationId(
  adjudicationSloId: string
): string {
  return `closure-adjudication-slo-debt-remediation:${adjudicationSloId}`
}

export function filingEscalationClosureRebalanceSafeguardExpiryId(safeguardId: string): string {
  return `closure-rebalance-safeguard-expiry:${safeguardId}`
}

export function isFilingEscalationClosureAdjudicationSloDebtRemediationStatus(
  value: string | null
): value is FilingEscalationClosureAdjudicationSloDebtRemediationStatus {
  return (
    value === "debt_open" ||
    value === "debt_retirement_pending" ||
    value === "debt_retired" ||
    value === "breach_closure_attested"
  )
}

export function isFilingEscalationClosureRebalanceSafeguardExpiryStatus(
  value: string | null
): value is FilingEscalationClosureRebalanceSafeguardExpiryStatus {
  return (
    value === "expiry_pending" ||
    value === "auto_cleared" ||
    value === "override_expired" ||
    value === "stale_lock_cleaned"
  )
}
