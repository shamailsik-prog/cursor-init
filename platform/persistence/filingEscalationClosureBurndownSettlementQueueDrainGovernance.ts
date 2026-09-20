import type {
  FilingEscalationClosureBurndownRecalibrationRow,
  FilingEscalationClosureBurndownSettlementRow,
  FilingEscalationClosureBurndownSettlementStatus,
  FilingEscalationClosureExpiryAttestationQueueDrainRow,
  FilingEscalationClosureExpiryAttestationQueueDrainStatus,
  FilingEscalationClosureExpiryAttestationQueueRow,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export function filingEscalationClosureBurndownSettlementId(recalibrationId: string): string {
  return `closure-burndown-settlement:${recalibrationId}`
}

export function filingEscalationClosureExpiryAttestationQueueDrainId(queueId: string): string {
  return `closure-expiry-attestation-queue-drain:${queueId}`
}

export function isFilingEscalationClosureBurndownSettlementStatus(
  value: string | null
): value is FilingEscalationClosureBurndownSettlementStatus {
  return (
    value === "settlement_pending" ||
    value === "drift_acknowledged" ||
    value === "target_lock_attested" ||
    value === "rollback_resolution_closed"
  )
}

export function isFilingEscalationClosureExpiryAttestationQueueDrainStatus(
  value: string | null
): value is FilingEscalationClosureExpiryAttestationQueueDrainStatus {
  return (
    value === "drain_pending" ||
    value === "handoff_timeout_escalated" ||
    value === "stale_reassignment_attested" ||
    value === "forced_drain_checkpointed"
  )
}

export function buildFilingEscalationClosureBurndownSettlementRow(input: {
  recalibration: FilingEscalationClosureBurndownRecalibrationRow
  existing?: FilingEscalationClosureBurndownSettlementRow | null
  driftAcknowledgedBy?: string | null
  targetLockAttestedBy?: string | null
  rollbackResolutionClosedBy?: string | null
  rollbackResolutionNote?: string | null
  now?: number
  note?: string | null
}): FilingEscalationClosureBurndownSettlementRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const driftAcknowledgedBy = input.driftAcknowledgedBy ?? existing?.driftAcknowledgedBy ?? null
  const driftAcknowledgedAt = input.driftAcknowledgedBy ? now : (existing?.driftAcknowledgedAt ?? null)
  const targetLockAttestedBy = input.targetLockAttestedBy ?? existing?.targetLockAttestedBy ?? null
  const targetLockAttestedAt = input.targetLockAttestedBy ? now : (existing?.targetLockAttestedAt ?? null)
  const rollbackResolutionClosedBy =
    input.rollbackResolutionClosedBy ?? existing?.rollbackResolutionClosedBy ?? null
  const rollbackResolutionClosedAt = input.rollbackResolutionClosedBy
    ? now
    : (existing?.rollbackResolutionClosedAt ?? null)
  const rollbackResolutionNote = input.rollbackResolutionClosedBy
    ? input.rollbackResolutionNote?.trim() ?? input.note?.trim() ?? "rollback resolution closed"
    : (existing?.rollbackResolutionNote ?? null)
  const anchorAt =
    existing?.lastEvaluatedAt ??
    input.recalibration.rollbackNotedAt ??
    input.recalibration.confidenceOverriddenAt ??
    input.recalibration.updatedAt
  const settlementLatencyHours = Math.max(0, Math.ceil((now - anchorAt) / HOUR_MS))
  let status: FilingEscalationClosureBurndownSettlementStatus = "settlement_pending"
  if (rollbackResolutionClosedBy) {
    status = "rollback_resolution_closed"
  } else if (targetLockAttestedBy) {
    status = "target_lock_attested"
  } else if (driftAcknowledgedBy) {
    status = "drift_acknowledged"
  }
  const note = input.note?.trim()
  const noteActor =
    input.rollbackResolutionClosedBy ?? input.targetLockAttestedBy ?? input.driftAcknowledgedBy ?? "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureBurndownSettlementId(input.recalibration.id),
    firmId: input.recalibration.firmId,
    ownerId: input.recalibration.ownerId,
    queueId: input.recalibration.queueId,
    adjudicationId: input.recalibration.adjudicationId,
    recalibrationId: input.recalibration.id,
    classification: input.recalibration.classification,
    packageIds: input.recalibration.packageIds,
    status,
    driftAcknowledgedBy,
    driftAcknowledgedAt,
    targetLockAttestedBy,
    targetLockAttestedAt,
    rollbackResolutionClosedBy,
    rollbackResolutionClosedAt,
    rollbackResolutionNote,
    settlementLatencyHours,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureExpiryAttestationQueueDrainRow(input: {
  queueItem: FilingEscalationClosureExpiryAttestationQueueRow
  existing?: FilingEscalationClosureExpiryAttestationQueueDrainRow | null
  handoffTimeoutEscalatedBy?: string | null
  staleReassignmentAttestedBy?: string | null
  reassignedOwnerId?: string | null
  forcedDrainCheckpointedBy?: string | null
  forcedDrainOverrideNote?: string | null
  now?: number
  note?: string | null
}): FilingEscalationClosureExpiryAttestationQueueDrainRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const handoffTimeoutEscalatedBy =
    input.handoffTimeoutEscalatedBy ?? existing?.handoffTimeoutEscalatedBy ?? null
  const handoffTimeoutEscalatedAt = input.handoffTimeoutEscalatedBy
    ? now
    : (existing?.handoffTimeoutEscalatedAt ?? null)
  const staleReassignmentAttestedBy =
    input.staleReassignmentAttestedBy ?? existing?.staleReassignmentAttestedBy ?? null
  const staleReassignmentAttestedAt = input.staleReassignmentAttestedBy
    ? now
    : (existing?.staleReassignmentAttestedAt ?? null)
  const reassignedOwnerId = input.staleReassignmentAttestedBy
    ? input.reassignedOwnerId?.trim() ?? existing?.reassignedOwnerId ?? null
    : (existing?.reassignedOwnerId ?? null)
  const forcedDrainCheckpointedBy =
    input.forcedDrainCheckpointedBy ?? existing?.forcedDrainCheckpointedBy ?? null
  const forcedDrainCheckpointedAt = input.forcedDrainCheckpointedBy
    ? now
    : (existing?.forcedDrainCheckpointedAt ?? null)
  const forcedDrainOverrideNote = input.forcedDrainCheckpointedBy
    ? input.forcedDrainOverrideNote?.trim() ?? input.note?.trim() ?? "forced drain checkpoint recorded"
    : (existing?.forcedDrainOverrideNote ?? null)
  const openQueueAgingHours = Math.max(
    input.queueItem.queueAgingHours,
    existing?.openQueueAgingHours ?? 0
  )
  const priorThroughput = existing?.drainThroughputPerDay ?? 0
  const elapsedHours = Math.max(1, (now - (existing?.lastEvaluatedAt ?? now)) / HOUR_MS)
  const drainedDelta =
    input.queueItem.status === "queue_auto_drained" || forcedDrainCheckpointedBy ? 1 : 0
  const observedThroughput = (drainedDelta / elapsedHours) * 24
  const drainThroughputPerDay = observedThroughput > 0 ? observedThroughput : priorThroughput
  let status: FilingEscalationClosureExpiryAttestationQueueDrainStatus = "drain_pending"
  if (forcedDrainCheckpointedBy) {
    status = "forced_drain_checkpointed"
  } else if (staleReassignmentAttestedBy) {
    status = "stale_reassignment_attested"
  } else if (handoffTimeoutEscalatedBy) {
    status = "handoff_timeout_escalated"
  }
  const note = input.note?.trim()
  const noteActor =
    input.forcedDrainCheckpointedBy ??
    input.staleReassignmentAttestedBy ??
    input.handoffTimeoutEscalatedBy ??
    "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureExpiryAttestationQueueDrainId(input.queueItem.id),
    firmId: input.queueItem.firmId,
    ownerId: input.queueItem.ownerId,
    queueId: input.queueItem.queueId,
    rebalanceId: input.queueItem.rebalanceId,
    queueItemId: input.queueItem.id,
    classification: input.queueItem.classification,
    packageIds: input.queueItem.packageIds,
    status,
    handoffTimeoutEscalatedBy,
    handoffTimeoutEscalatedAt,
    staleReassignmentAttestedBy,
    staleReassignmentAttestedAt,
    reassignedOwnerId,
    forcedDrainCheckpointedBy,
    forcedDrainCheckpointedAt,
    forcedDrainOverrideNote,
    drainThroughputPerDay,
    openQueueAgingHours,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
