import type {
  FilingEscalationClosureBurndownSettlementRow,
  FilingEscalationClosureExpiryAttestationQueueDrainRow,
  FilingEscalationClosureQueueDrainReconciliationRow,
  FilingEscalationClosureQueueDrainReconciliationStatus,
  FilingEscalationClosureSettlementAttestationRow,
  FilingEscalationClosureSettlementAttestationStatus,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export function filingEscalationClosureSettlementAttestationId(settlementId: string): string {
  return `closure-settlement-attestation:${settlementId}`
}

export function filingEscalationClosureQueueDrainReconciliationId(queueDrainId: string): string {
  return `closure-queue-drain-reconciliation:${queueDrainId}`
}

export function isFilingEscalationClosureSettlementAttestationStatus(
  value: string | null
): value is FilingEscalationClosureSettlementAttestationStatus {
  return (
    value === "verification_pending" ||
    value === "lock_release_attested" ||
    value === "dispute_reopen_guarded" ||
    value === "settlement_verified"
  )
}

export function isFilingEscalationClosureQueueDrainReconciliationStatus(
  value: string | null
): value is FilingEscalationClosureQueueDrainReconciliationStatus {
  return (
    value === "reconciliation_pending" ||
    value === "forced_drain_attested" ||
    value === "reassignment_rollback_checkpointed" ||
    value === "timeout_reentry_controlled"
  )
}

export function buildFilingEscalationClosureSettlementAttestationRow(input: {
  settlement: FilingEscalationClosureBurndownSettlementRow
  existing?: FilingEscalationClosureSettlementAttestationRow | null
  postResolutionCheckpointedBy?: string | null
  lockReleaseAttestedBy?: string | null
  disputeReopenGuardedBy?: string | null
  disputeReopenGuardNote?: string | null
  now?: number
  note?: string | null
}): FilingEscalationClosureSettlementAttestationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const postResolutionCheckpointedBy =
    input.postResolutionCheckpointedBy ?? existing?.postResolutionCheckpointedBy ?? null
  const postResolutionCheckpointedAt = input.postResolutionCheckpointedBy
    ? now
    : (existing?.postResolutionCheckpointedAt ?? null)
  const lockReleaseAttestedBy = input.lockReleaseAttestedBy ?? existing?.lockReleaseAttestedBy ?? null
  const lockReleaseAttestedAt = input.lockReleaseAttestedBy ? now : (existing?.lockReleaseAttestedAt ?? null)
  const disputeReopenGuardedBy =
    input.disputeReopenGuardedBy ?? existing?.disputeReopenGuardedBy ?? null
  const disputeReopenGuardedAt = input.disputeReopenGuardedBy
    ? now
    : (existing?.disputeReopenGuardedAt ?? null)
  const disputeReopenGuardNote = input.disputeReopenGuardedBy
    ? input.disputeReopenGuardNote?.trim() ??
      input.note?.trim() ??
      "dispute reopen safeguard recorded"
    : (existing?.disputeReopenGuardNote ?? null)
  const lagAnchorAt =
    input.settlement.rollbackResolutionClosedAt ??
    input.settlement.targetLockAttestedAt ??
    input.settlement.driftAcknowledgedAt ??
    input.settlement.updatedAt
  const settlementVerificationLagHours = Math.max(0, Math.ceil((now - lagAnchorAt) / HOUR_MS))
  let status: FilingEscalationClosureSettlementAttestationStatus = "verification_pending"
  if (disputeReopenGuardedBy) {
    status = "dispute_reopen_guarded"
  } else if (postResolutionCheckpointedBy && lockReleaseAttestedBy) {
    status = "settlement_verified"
  } else if (lockReleaseAttestedBy) {
    status = "lock_release_attested"
  }
  const note = input.note?.trim()
  const noteActor =
    input.disputeReopenGuardedBy ??
    input.lockReleaseAttestedBy ??
    input.postResolutionCheckpointedBy ??
    "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureSettlementAttestationId(input.settlement.id),
    firmId: input.settlement.firmId,
    ownerId: input.settlement.ownerId,
    queueId: input.settlement.queueId,
    adjudicationId: input.settlement.adjudicationId,
    settlementId: input.settlement.id,
    classification: input.settlement.classification,
    packageIds: input.settlement.packageIds,
    status,
    postResolutionCheckpointedBy,
    postResolutionCheckpointedAt,
    lockReleaseAttestedBy,
    lockReleaseAttestedAt,
    disputeReopenGuardedBy,
    disputeReopenGuardedAt,
    disputeReopenGuardNote,
    settlementVerificationLagHours,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureQueueDrainReconciliationRow(input: {
  queueDrain: FilingEscalationClosureExpiryAttestationQueueDrainRow
  existing?: FilingEscalationClosureQueueDrainReconciliationRow | null
  forcedDrainAttestedBy?: string | null
  reassignmentRollbackCheckpointedBy?: string | null
  rollbackToOwnerId?: string | null
  timeoutReentryControlledBy?: string | null
  timeoutReentryWindowHours?: number | null
  now?: number
  note?: string | null
}): FilingEscalationClosureQueueDrainReconciliationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const forcedDrainAttestedBy = input.forcedDrainAttestedBy ?? existing?.forcedDrainAttestedBy ?? null
  const forcedDrainAttestedAt = input.forcedDrainAttestedBy ? now : (existing?.forcedDrainAttestedAt ?? null)
  const reassignmentRollbackCheckpointedBy =
    input.reassignmentRollbackCheckpointedBy ?? existing?.reassignmentRollbackCheckpointedBy ?? null
  const reassignmentRollbackCheckpointedAt = input.reassignmentRollbackCheckpointedBy
    ? now
    : (existing?.reassignmentRollbackCheckpointedAt ?? null)
  const rollbackToOwnerId = input.reassignmentRollbackCheckpointedBy
    ? input.rollbackToOwnerId?.trim() ?? existing?.rollbackToOwnerId ?? null
    : (existing?.rollbackToOwnerId ?? null)
  const timeoutReentryControlledBy =
    input.timeoutReentryControlledBy ?? existing?.timeoutReentryControlledBy ?? null
  const timeoutReentryControlledAt = input.timeoutReentryControlledBy
    ? now
    : (existing?.timeoutReentryControlledAt ?? null)
  const timeoutReentryWindowHours =
    input.timeoutReentryWindowHours !== undefined
      ? input.timeoutReentryWindowHours
      : (existing?.timeoutReentryWindowHours ?? null)
  let drainReopenPressureCount = 0
  if (input.queueDrain.status === "handoff_timeout_escalated") drainReopenPressureCount += 2
  if (input.queueDrain.status === "stale_reassignment_attested") drainReopenPressureCount += 1
  if (input.queueDrain.openQueueAgingHours >= 4) drainReopenPressureCount += 1
  if (timeoutReentryControlledBy) {
    drainReopenPressureCount = Math.max(0, drainReopenPressureCount - 1)
  }
  let status: FilingEscalationClosureQueueDrainReconciliationStatus = "reconciliation_pending"
  if (timeoutReentryControlledBy) {
    status = "timeout_reentry_controlled"
  } else if (reassignmentRollbackCheckpointedBy) {
    status = "reassignment_rollback_checkpointed"
  } else if (forcedDrainAttestedBy) {
    status = "forced_drain_attested"
  }
  const note = input.note?.trim()
  const noteActor =
    input.timeoutReentryControlledBy ??
    input.reassignmentRollbackCheckpointedBy ??
    input.forcedDrainAttestedBy ??
    "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureQueueDrainReconciliationId(input.queueDrain.id),
    firmId: input.queueDrain.firmId,
    ownerId: input.queueDrain.ownerId,
    queueId: input.queueDrain.queueId,
    rebalanceId: input.queueDrain.rebalanceId,
    queueDrainId: input.queueDrain.id,
    classification: input.queueDrain.classification,
    packageIds: input.queueDrain.packageIds,
    status,
    forcedDrainAttestedBy,
    forcedDrainAttestedAt,
    reassignmentRollbackCheckpointedBy,
    reassignmentRollbackCheckpointedAt,
    rollbackToOwnerId,
    timeoutReentryControlledBy,
    timeoutReentryControlledAt,
    timeoutReentryWindowHours,
    drainReopenPressureCount,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
