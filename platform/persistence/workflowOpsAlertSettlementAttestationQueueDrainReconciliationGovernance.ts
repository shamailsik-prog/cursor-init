import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationStatus,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationId(
  settlementId: string
): string {
  return `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:${settlementId}`
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationId(
  queueDrainId: string
): string {
  return `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:${queueDrainId}`
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow(
  input: {
    settlement: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow | null
    postResolutionCheckpointedBy?: string | null
    lockReleaseAttestedBy?: string | null
    disputeReopenGuardedBy?: string | null
    disputeReopenGuardNote?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow {
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
  let settlementAttestationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationStatus =
    "verification_pending"
  if (disputeReopenGuardedBy) {
    settlementAttestationStatus = "dispute_reopen_guarded"
  } else if (postResolutionCheckpointedBy && lockReleaseAttestedBy) {
    settlementAttestationStatus = "settlement_verified"
  } else if (lockReleaseAttestedBy) {
    settlementAttestationStatus = "lock_release_attested"
  }
  const note = input.note?.trim()
  const noteActor =
    input.disputeReopenGuardedBy ??
    input.lockReleaseAttestedBy ??
    input.postResolutionCheckpointedBy ??
    input.actorId
  const attestationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.attestationNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationId(
      input.settlement.id
    ),
    firmId: input.settlement.firmId,
    matterId: input.settlement.matterId,
    waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementId: input.settlement.id,
    classification: input.settlement.classification,
    settlementAttestationStatus,
    settlementStatusSnapshot: input.settlement.settlementStatus,
    postResolutionCheckpointedBy,
    postResolutionCheckpointedAt,
    lockReleaseAttestedBy,
    lockReleaseAttestedAt,
    disputeReopenGuardedBy,
    disputeReopenGuardedAt,
    disputeReopenGuardNote,
    settlementVerificationLagHours,
    reopenPressureCount: existing?.reopenPressureCount ?? input.settlement.reopenPressureCount,
    attestationNote,
    lastStatusChangedAt:
      input.postResolutionCheckpointedBy ||
      input.lockReleaseAttestedBy ||
      input.disputeReopenGuardedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `settlement_status:${input.settlement.settlementStatus}`,
      ...(existing?.provenanceTags ??
        input.settlement.provenanceTags.map((tag) => `settlement_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow(
  input: {
    queueDrain: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow | null
    forcedDrainAttestedBy?: string | null
    reassignmentRollbackCheckpointedBy?: string | null
    rollbackToOwnerId?: string | null
    timeoutReentryControlledBy?: string | null
    timeoutReentryWindowHours?: number | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow {
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
  if (input.queueDrain.drainStatus === "handoff_timeout_escalated") drainReopenPressureCount += 2
  if (input.queueDrain.drainStatus === "stale_reassignment_attested") drainReopenPressureCount += 1
  if (input.queueDrain.openQueueAgingHours >= 4) drainReopenPressureCount += 1
  if (timeoutReentryControlledBy) {
    drainReopenPressureCount = Math.max(0, drainReopenPressureCount - 1)
  }
  let reconciliationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationStatus =
    "reconciliation_pending"
  if (timeoutReentryControlledBy) {
    reconciliationStatus = "timeout_reentry_controlled"
  } else if (reassignmentRollbackCheckpointedBy) {
    reconciliationStatus = "reassignment_rollback_checkpointed"
  } else if (forcedDrainAttestedBy) {
    reconciliationStatus = "forced_drain_attested"
  }
  const note = input.note?.trim()
  const noteActor =
    input.timeoutReentryControlledBy ??
    input.reassignmentRollbackCheckpointedBy ??
    input.forcedDrainAttestedBy ??
    input.actorId
  const reconciliationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.reconciliationNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationId(
      input.queueDrain.id
    ),
    firmId: input.queueDrain.firmId,
    matterId: input.queueDrain.matterId,
    expiryAttestationQueueDrainId: input.queueDrain.id,
    classification: input.queueDrain.classification,
    reconciliationStatus,
    drainStatusSnapshot: input.queueDrain.drainStatus,
    forcedDrainAttestedBy,
    forcedDrainAttestedAt,
    reassignmentRollbackCheckpointedBy,
    reassignmentRollbackCheckpointedAt,
    rollbackToOwnerId,
    timeoutReentryControlledBy,
    timeoutReentryControlledAt,
    timeoutReentryWindowHours,
    drainReopenPressureCount,
    reopenPressureCount: existing?.reopenPressureCount ?? input.queueDrain.reopenPressureCount,
    reconciliationNote,
    lastStatusChangedAt:
      input.forcedDrainAttestedBy ||
      input.reassignmentRollbackCheckpointedBy ||
      input.timeoutReentryControlledBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `drain_status:${input.queueDrain.drainStatus}`,
      ...(existing?.provenanceTags ??
        input.queueDrain.provenanceTags.map((tag) => `queue_drain_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
