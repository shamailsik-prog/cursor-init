export type FilingEscalationClosureAttestationDisputeStatus =
  | "open_dispute"
  | "under_review"
  | "resolved_upheld"
  | "resolved_overturned"

export type FilingEscalationClosureSlaExceptionEnforcementStatus =
  | "countdown_active"
  | "reminder_sent"
  | "escalated"
  | "closed"

export function filingEscalationClosureAttestationDisputeId(
  attestationId: string,
  sequenceNo: number
): string {
  return `closure-attestation-dispute:${attestationId}:${sequenceNo}`
}

export function filingEscalationClosureSlaExceptionEnforcementId(queueId: string): string {
  return `closure-sla-exception-enforcement:${queueId}`
}

export function isFilingEscalationClosureAttestationDisputeStatus(
  value: string | null
): value is FilingEscalationClosureAttestationDisputeStatus {
  return (
    value === "open_dispute" ||
    value === "under_review" ||
    value === "resolved_upheld" ||
    value === "resolved_overturned"
  )
}

export function isFilingEscalationClosureSlaExceptionEnforcementStatus(
  value: string | null
): value is FilingEscalationClosureSlaExceptionEnforcementStatus {
  return (
    value === "countdown_active" ||
    value === "reminder_sent" ||
    value === "escalated" ||
    value === "closed"
  )
}
