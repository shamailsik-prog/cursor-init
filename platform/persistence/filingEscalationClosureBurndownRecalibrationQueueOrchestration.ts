export type FilingEscalationClosureBurndownRecalibrationStatus =
  | "recalibration_pending"
  | "confidence_band_overridden"
  | "checkpoint_rollback_noted"
  | "recalibration_settled"

export type FilingEscalationClosureExpiryAttestationQueueStatus =
  | "queue_open"
  | "queue_triaged"
  | "handoff_attested"
  | "queue_auto_drained"

export function filingEscalationClosureBurndownRecalibrationId(burndownId: string): string {
  return `closure-burndown-recalibration:${burndownId}`
}

export function filingEscalationClosureExpiryAttestationQueueId(attestationId: string): string {
  return `closure-expiry-attestation-queue:${attestationId}`
}

export function isFilingEscalationClosureBurndownRecalibrationStatus(
  value: string | null
): value is FilingEscalationClosureBurndownRecalibrationStatus {
  return (
    value === "recalibration_pending" ||
    value === "confidence_band_overridden" ||
    value === "checkpoint_rollback_noted" ||
    value === "recalibration_settled"
  )
}

export function isFilingEscalationClosureExpiryAttestationQueueStatus(
  value: string | null
): value is FilingEscalationClosureExpiryAttestationQueueStatus {
  return (
    value === "queue_open" ||
    value === "queue_triaged" ||
    value === "handoff_attested" ||
    value === "queue_auto_drained"
  )
}
