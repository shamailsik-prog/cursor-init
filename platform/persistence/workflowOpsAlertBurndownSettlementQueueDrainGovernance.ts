import { buildWorkflowOpsChainedDocumentId } from "@/platform/persistence/workflowOpsChainedDocumentId"
import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainStatus,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementStatus,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementId(
  matterId: string
): string {
  return buildWorkflowOpsChainedDocumentId(`workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement`, matterId)
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainId(
  matterId: string
): string {
  return buildWorkflowOpsChainedDocumentId(`workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain`, matterId)
}

export function computeDefaultWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementStatus(
  burndownStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow["burndownStatus"]
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementStatus {
  if (burndownStatus === "burndown_checkpointed") {
    return "settlement_pending"
  }
  return "settlement_pending"
}

export function computeDefaultWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainStatus(
  queueStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow["queueStatus"]
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainStatus {
  if (queueStatus === "queue_auto_drained") {
    return "drain_pending"
  }
  return "drain_pending"
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow(params: {
  burndown: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow | null
  now: number
}): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow {
  const { burndown, actorId, reason, existing, now } = params
  const computed = computeDefaultWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementStatus(
    burndown.burndownStatus
  )
  let settlementStatus = existing?.settlementStatus ?? computed
  if (
    existing &&
    (existing.settlementStatus === "drift_acknowledged" ||
      existing.settlementStatus === "target_lock_attested" ||
      existing.settlementStatus === "rollback_resolution_closed")
  ) {
    settlementStatus = existing.settlementStatus
  }
  const anchorAt = burndown.checkpointedAt ?? burndown.targetSetAt ?? burndown.recomputedAt
  const settlementLatencyHours = Math.max(0, Math.ceil((now - anchorAt) / HOUR_MS))

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementId(burndown.matterId),
    firmId: burndown.firmId,
    matterId: burndown.matterId,
    waiverExpiryDisputeAdjudicationSloDebtBurndownId: burndown.id,
    classification: burndown.classification,
    settlementStatus,
    burndownStatusSnapshot: burndown.burndownStatus,
    settlementLatencyHours,
    driftAcknowledgedBy: existing?.driftAcknowledgedBy ?? null,
    driftAcknowledgedAt: existing?.driftAcknowledgedAt ?? null,
    targetLockAttestedBy: existing?.targetLockAttestedBy ?? null,
    targetLockAttestedAt: existing?.targetLockAttestedAt ?? null,
    rollbackResolutionClosedBy: existing?.rollbackResolutionClosedBy ?? null,
    rollbackResolutionClosedAt: existing?.rollbackResolutionClosedAt ?? null,
    rollbackResolutionNote: existing?.rollbackResolutionNote ?? null,
    settlementNote: existing?.settlementNote ?? null,
    reopenPressureCount: existing?.reopenPressureCount ?? burndown.reopenPressureCount,
    lastStatusChangedAt:
      existing?.lastStatusChangedAt ??
      (burndown.burndownStatus === "burndown_checkpointed" ? now : null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${reason}`,
      `burndown_status:${burndown.burndownStatus}`,
      ...(existing?.provenanceTags ?? burndown.provenanceTags.map((tag) => `burndown_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow(
  params: {
    queueOrchestration: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow
    actorId: string
    reason: string
    existing: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow | null
    now: number
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow {
  const { queueOrchestration, actorId, reason, existing, now } = params
  const computed =
    computeDefaultWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainStatus(
      queueOrchestration.queueStatus
    )
  let drainStatus = existing?.drainStatus ?? computed
  if (
    existing &&
    (existing.drainStatus === "handoff_timeout_escalated" ||
      existing.drainStatus === "stale_reassignment_attested" ||
      existing.drainStatus === "forced_drain_checkpointed")
  ) {
    drainStatus = existing.drainStatus
  }
  const openQueueAgingHours = Math.max(
    queueOrchestration.queueAgingHours,
    existing?.openQueueAgingHours ?? 0
  )
  const drainThroughputPerDay = Math.max(
    queueOrchestration.drainVelocityPerDay,
    existing?.drainThroughputPerDay ?? 0
  )

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainId(
      queueOrchestration.matterId
    ),
    firmId: queueOrchestration.firmId,
    matterId: queueOrchestration.matterId,
    expiryAttestationQueueOrchestrationId: queueOrchestration.id,
    classification: queueOrchestration.classification,
    drainStatus,
    queueStatusSnapshot: queueOrchestration.queueStatus,
    openQueueAgingHours,
    drainThroughputPerDay,
    handoffTimeoutEscalatedBy: existing?.handoffTimeoutEscalatedBy ?? null,
    handoffTimeoutEscalatedAt: existing?.handoffTimeoutEscalatedAt ?? null,
    staleReassignmentAttestedBy: existing?.staleReassignmentAttestedBy ?? null,
    staleReassignmentAttestedAt: existing?.staleReassignmentAttestedAt ?? null,
    reassignedOwnerId: existing?.reassignedOwnerId ?? null,
    forcedDrainCheckpointedBy: existing?.forcedDrainCheckpointedBy ?? null,
    forcedDrainCheckpointedAt: existing?.forcedDrainCheckpointedAt ?? null,
    forcedDrainOverrideNote: existing?.forcedDrainOverrideNote ?? null,
    drainNote: existing?.drainNote ?? null,
    reopenPressureCount: existing?.reopenPressureCount ?? queueOrchestration.reopenPressureCount,
    lastStatusChangedAt:
      existing?.lastStatusChangedAt ??
      (queueOrchestration.queueStatus === "queue_auto_drained" ? now : null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${reason}`,
      `queue_status:${queueOrchestration.queueStatus}`,
      ...(existing?.provenanceTags ??
        queueOrchestration.provenanceTags.map((tag) => `queue_orchestration_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}
