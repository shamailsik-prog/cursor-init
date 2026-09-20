export type FilingEscalationClosureAdjudicationQuorumStatus =
  | "quorum_pending"
  | "quorum_met"
  | "verdict_overdue"
  | "closed"

export type FilingEscalationClosureRebalanceExecutionStatus =
  | "queued"
  | "owner_transfer_in_progress"
  | "throttle_release_in_progress"
  | "completed"

export function filingEscalationClosureAdjudicationQuorumId(adjudicationId: string): string {
  return `closure-adjudication-quorum:${adjudicationId}`
}

export function filingEscalationClosureRebalanceExecutionId(rebalanceId: string): string {
  return `closure-rebalance-execution:${rebalanceId}`
}

export function isFilingEscalationClosureAdjudicationQuorumStatus(
  value: string | null
): value is FilingEscalationClosureAdjudicationQuorumStatus {
  return (
    value === "quorum_pending" ||
    value === "quorum_met" ||
    value === "verdict_overdue" ||
    value === "closed"
  )
}

export function isFilingEscalationClosureRebalanceExecutionStatus(
  value: string | null
): value is FilingEscalationClosureRebalanceExecutionStatus {
  return (
    value === "queued" ||
    value === "owner_transfer_in_progress" ||
    value === "throttle_release_in_progress" ||
    value === "completed"
  )
}
