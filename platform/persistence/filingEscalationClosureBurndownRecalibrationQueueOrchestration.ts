import type {
  FilingEscalationClosureAdjudicationDebtBurndownRow,
  FilingEscalationClosureBurndownRecalibrationRow,
  FilingEscalationClosureBurndownRecalibrationStatus,
  FilingEscalationClosureExpiryAttestationQueueRow,
  FilingEscalationClosureExpiryAttestationQueueStatus,
  FilingEscalationClosureSafeguardExpiryAttestationRow,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

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

export function buildFilingEscalationClosureBurndownRecalibrationRow(input: {
  burndown: FilingEscalationClosureAdjudicationDebtBurndownRow
  existing?: FilingEscalationClosureBurndownRecalibrationRow | null
  rebaselineTargetHours?: number | null
  confidenceBandLowerHours?: number | null
  confidenceBandUpperHours?: number | null
  confidenceOverriddenBy?: string | null
  rollbackNotedBy?: string | null
  rollbackReason?: string | null
  settledBy?: string | null
  now?: number
  note?: string | null
}): FilingEscalationClosureBurndownRecalibrationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const rebaselineTargetAt =
    input.rebaselineTargetHours !== undefined && input.rebaselineTargetHours !== null
      ? (input.rebaselineTargetHours > 0 ? now + Math.floor(input.rebaselineTargetHours * HOUR_MS) : now)
      : (existing?.rebaselineTargetAt ?? input.burndown.retirementTargetAt ?? null)
  const confidenceBandLowerHours =
    input.confidenceBandLowerHours !== undefined
      ? input.confidenceBandLowerHours
      : (existing?.confidenceBandLowerHours ?? null)
  const confidenceBandUpperHours =
    input.confidenceBandUpperHours !== undefined
      ? input.confidenceBandUpperHours
      : (existing?.confidenceBandUpperHours ?? null)
  const confidenceOverriddenBy = input.confidenceOverriddenBy ?? existing?.confidenceOverriddenBy ?? null
  const confidenceOverriddenAt = input.confidenceOverriddenBy
    ? now
    : (existing?.confidenceOverriddenAt ?? null)
  const rollbackNotedBy = input.rollbackNotedBy ?? existing?.rollbackNotedBy ?? null
  const rollbackNotedAt = input.rollbackNotedBy ? now : (existing?.rollbackNotedAt ?? null)
  const rollbackReason = input.rollbackNotedBy
    ? input.rollbackReason?.trim() ?? input.note?.trim() ?? "rollback annotation recorded"
    : (existing?.rollbackReason ?? null)
  const settledBy = input.settledBy ?? existing?.settledBy ?? null
  const inferredSettled =
    !input.settledBy &&
    input.burndown.status === "burndown_attested" &&
    input.burndown.forecastBreachHours === 0
  const settledAt =
    input.settledBy || inferredSettled ? now : (existing?.settledAt ?? null)
  const driftBaseline = rebaselineTargetAt ?? input.burndown.retirementTargetAt
  const confidenceDriftHours =
    driftBaseline && input.burndown.projectedBurndownHours > 0
      ? Math.max(0, Math.ceil((now - driftBaseline) / HOUR_MS))
      : 0
  let status: FilingEscalationClosureBurndownRecalibrationStatus = "recalibration_pending"
  if (settledBy || inferredSettled) {
    status = "recalibration_settled"
  } else if (rollbackNotedBy) {
    status = "checkpoint_rollback_noted"
  } else if (confidenceOverriddenBy) {
    status = "confidence_band_overridden"
  }
  const note = input.note?.trim()
  const noteActor =
    input.settledBy ?? input.rollbackNotedBy ?? input.confidenceOverriddenBy ?? "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureBurndownRecalibrationId(input.burndown.id),
    firmId: input.burndown.firmId,
    ownerId: input.burndown.ownerId,
    queueId: input.burndown.queueId,
    adjudicationId: input.burndown.adjudicationId,
    burndownId: input.burndown.id,
    classification: input.burndown.classification,
    packageIds: input.burndown.packageIds,
    status,
    rebaselineTargetAt,
    confidenceBandLowerHours,
    confidenceBandUpperHours,
    confidenceOverriddenBy,
    confidenceOverriddenAt,
    rollbackNotedBy,
    rollbackNotedAt,
    rollbackReason,
    settledBy,
    settledAt,
    confidenceDriftHours,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureExpiryAttestationQueueRow(input: {
  attestation: FilingEscalationClosureSafeguardExpiryAttestationRow
  existing?: FilingEscalationClosureExpiryAttestationQueueRow | null
  triagedBy?: string | null
  handoffAttestedBy?: string | null
  handoffToOwnerId?: string | null
  autoDrainCheckpointBy?: string | null
  reconciliationCarryoverNote?: string | null
  now?: number
  note?: string | null
}): FilingEscalationClosureExpiryAttestationQueueRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const triagedBy = input.triagedBy ?? existing?.triagedBy ?? null
  const triagedAt = input.triagedBy ? now : (existing?.triagedAt ?? null)
  const handoffAttestedBy = input.handoffAttestedBy ?? existing?.handoffAttestedBy ?? null
  const handoffAttestedAt = input.handoffAttestedBy ? now : (existing?.handoffAttestedAt ?? null)
  const handoffToOwnerId = input.handoffAttestedBy
    ? input.handoffToOwnerId?.trim() ?? existing?.handoffToOwnerId ?? null
    : (existing?.handoffToOwnerId ?? null)
  const autoDrainCheckpointAt = input.autoDrainCheckpointBy
    ? now
    : (existing?.autoDrainCheckpointAt ?? null)
  const queueAgingHours =
    input.attestation.openBacklogHours > 0
      ? Math.max(input.attestation.openBacklogHours, existing?.queueAgingHours ?? 0)
      : 0
  const openExceptionCount =
    input.attestation.status === "attestation_overdue" || input.attestation.openBacklogHours > 0 ? 1 : 0
  const reconciliationCarryoverNote = input.handoffAttestedBy
    ? input.reconciliationCarryoverNote?.trim() ?? null
    : (existing?.reconciliationCarryoverNote ?? null)
  let status: FilingEscalationClosureExpiryAttestationQueueStatus = "queue_open"
  if (autoDrainCheckpointAt && openExceptionCount === 0) {
    status = "queue_auto_drained"
  } else if (handoffAttestedBy) {
    status = "handoff_attested"
  } else if (triagedBy) {
    status = "queue_triaged"
  }
  const note = input.note?.trim()
  const noteActor =
    input.autoDrainCheckpointBy ?? input.handoffAttestedBy ?? input.triagedBy ?? "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureExpiryAttestationQueueId(input.attestation.id),
    firmId: input.attestation.firmId,
    ownerId: input.attestation.ownerId,
    queueId: input.attestation.queueId,
    rebalanceId: input.attestation.rebalanceId,
    attestationId: input.attestation.id,
    classification: input.attestation.classification,
    packageIds: input.attestation.packageIds,
    status,
    triagedBy,
    triagedAt,
    handoffAttestedBy,
    handoffAttestedAt,
    handoffToOwnerId,
    autoDrainCheckpointAt,
    queueAgingHours,
    openExceptionCount,
    reconciliationCarryoverNote,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
