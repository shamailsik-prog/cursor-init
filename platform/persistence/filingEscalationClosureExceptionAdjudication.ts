export type FilingEscalationClosureAdjudicationStatus =
  | "pending_panel_assignment"
  | "panel_in_review"
  | "resolved_upheld"
  | "resolved_overturned"

export type FilingEscalationClosureEnforcementRebalanceStatus =
  | "none"
  | "cooldown_scheduled"
  | "owner_reassignment_recommended"
  | "throttle_active"

export function filingEscalationClosureAdjudicationQueueId(ownerId: string): string {
  return `closure-adjudication-queue:${ownerId}`
}

export function filingEscalationClosureEnforcementRebalanceId(queueId: string): string {
  return `closure-enforcement-rebalance:${queueId}`
}

export function isFilingEscalationClosureAdjudicationStatus(
  value: string | null
): value is FilingEscalationClosureAdjudicationStatus {
  return (
    value === "pending_panel_assignment" ||
    value === "panel_in_review" ||
    value === "resolved_upheld" ||
    value === "resolved_overturned"
  )
}

export function isFilingEscalationClosureEnforcementRebalanceStatus(
  value: string | null
): value is FilingEscalationClosureEnforcementRebalanceStatus {
  return (
    value === "none" ||
    value === "cooldown_scheduled" ||
    value === "owner_reassignment_recommended" ||
    value === "throttle_active"
  )
}
