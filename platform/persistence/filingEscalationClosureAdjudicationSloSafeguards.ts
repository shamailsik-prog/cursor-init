export type FilingEscalationClosureAdjudicationSloStatus =
  | "within_slo"
  | "deadline_extended"
  | "breach_open"
  | "breach_acknowledged"

export type FilingEscalationClosureRebalanceSafeguardStatus =
  | "auto_exec_ready"
  | "cooldown_locked"
  | "duplicate_suppressed"
  | "override_attested"

export function filingEscalationClosureAdjudicationSloId(adjudicationId: string): string {
  return `closure-adjudication-slo:${adjudicationId}`
}

export function filingEscalationClosureRebalanceSafeguardId(rebalanceId: string): string {
  return `closure-rebalance-safeguard:${rebalanceId}`
}

export function isFilingEscalationClosureAdjudicationSloStatus(
  value: string | null
): value is FilingEscalationClosureAdjudicationSloStatus {
  return (
    value === "within_slo" ||
    value === "deadline_extended" ||
    value === "breach_open" ||
    value === "breach_acknowledged"
  )
}

export function isFilingEscalationClosureRebalanceSafeguardStatus(
  value: string | null
): value is FilingEscalationClosureRebalanceSafeguardStatus {
  return (
    value === "auto_exec_ready" ||
    value === "cooldown_locked" ||
    value === "duplicate_suppressed" ||
    value === "override_attested"
  )
}
