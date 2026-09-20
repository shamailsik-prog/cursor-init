export type FilingEscalationClosureAttestationStatus =
  | "pending_second_review"
  | "attested"
  | "rejected"

export type FilingEscalationClosureSlaExceptionStatus =
  | "open_exception"
  | "waived"
  | "expired"
  | "cleared"

export function filingEscalationClosureAttestationId(
  queueId: string,
  sequenceNo: number
): string {
  return `closure-attestation:${queueId}:${sequenceNo}`
}

export function filingEscalationClosureSlaExceptionDigestId(queueId: string): string {
  return `closure-sla-exception:${queueId}`
}

export function isFilingEscalationClosureAttestationStatus(
  value: string | null
): value is FilingEscalationClosureAttestationStatus {
  return (
    value === "pending_second_review" || value === "attested" || value === "rejected"
  )
}

export function isFilingEscalationClosureSlaExceptionStatus(
  value: string | null
): value is FilingEscalationClosureSlaExceptionStatus {
  return (
    value === "open_exception" ||
    value === "waived" ||
    value === "expired" ||
    value === "cleared"
  )
}
