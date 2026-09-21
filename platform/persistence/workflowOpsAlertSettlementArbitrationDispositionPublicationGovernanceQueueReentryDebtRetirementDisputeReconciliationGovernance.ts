import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationStatus,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeResolutionOutcome,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceStatus,
} from "@/platform/spine/store"

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceId(
  dispositionFinalizationId: string
): string {
  return `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:${dispositionFinalizationId}`
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationId(
  debtRetirementId: string
): string {
  return `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:${debtRetirementId}`
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceStatus {
  return (
    value === "publication_governance_pending" ||
    value === "publication_correction_logged" ||
    value === "publication_rollback_checkpointed" ||
    value === "distribution_attestation_reviewed"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationStatus {
  return (
    value === "reconciliation_pending" ||
    value === "retirement_dispute_opened" ||
    value === "retirement_dispute_resolved" ||
    value === "retirement_rollback_controlled"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow(
  input: {
    dispositionFinalization: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow | null
    publicationCorrectionLoggedBy?: string | null
    publicationCorrectionNote?: string | null
    publicationRollbackCheckpointedBy?: string | null
    publicationRollbackReason?: string | null
    distributionAttestationReviewedBy?: string | null
    distributionAttestationDecision?: "approved" | "revision_required" | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const publicationCorrectionLoggedBy =
    input.publicationCorrectionLoggedBy ?? existing?.publicationCorrectionLoggedBy ?? null
  const publicationCorrectionLoggedAt = input.publicationCorrectionLoggedBy
    ? now
    : (existing?.publicationCorrectionLoggedAt ?? null)
  const publicationCorrectionNote = input.publicationCorrectionLoggedBy
    ? input.publicationCorrectionNote?.trim() ?? input.note?.trim() ?? "publication correction logged"
    : (existing?.publicationCorrectionNote ?? null)
  const publicationRollbackCheckpointedBy =
    input.publicationRollbackCheckpointedBy ?? existing?.publicationRollbackCheckpointedBy ?? null
  const publicationRollbackCheckpointedAt = input.publicationRollbackCheckpointedBy
    ? now
    : (existing?.publicationRollbackCheckpointedAt ?? null)
  const publicationRollbackReason = input.publicationRollbackCheckpointedBy
    ? input.publicationRollbackReason?.trim() ?? input.note?.trim() ?? "publication rollback checkpointed"
    : (existing?.publicationRollbackReason ?? null)
  const distributionAttestationReviewedBy =
    input.distributionAttestationReviewedBy ?? existing?.distributionAttestationReviewedBy ?? null
  const distributionAttestationReviewedAt = input.distributionAttestationReviewedBy
    ? now
    : (existing?.distributionAttestationReviewedAt ?? null)
  const distributionAttestationDecision = input.distributionAttestationReviewedBy
    ? input.distributionAttestationDecision === "revision_required"
      ? "revision_required"
      : "approved"
    : (existing?.distributionAttestationDecision ?? null)

  let arbitrationPublicationExceptionBacklogCount = 0
  if (publicationCorrectionLoggedBy) {
    arbitrationPublicationExceptionBacklogCount += 1
  }
  if (publicationRollbackCheckpointedBy) {
    arbitrationPublicationExceptionBacklogCount += 1
  }
  if (distributionAttestationDecision === "revision_required") {
    arbitrationPublicationExceptionBacklogCount += 1
  } else if (distributionAttestationDecision === "approved") {
    arbitrationPublicationExceptionBacklogCount = Math.max(0, arbitrationPublicationExceptionBacklogCount - 1)
  }

  let publicationGovernanceStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceStatus =
    "publication_governance_pending"
  if (distributionAttestationReviewedBy) {
    publicationGovernanceStatus = "distribution_attestation_reviewed"
  } else if (publicationRollbackCheckpointedBy) {
    publicationGovernanceStatus = "publication_rollback_checkpointed"
  } else if (publicationCorrectionLoggedBy) {
    publicationGovernanceStatus = "publication_correction_logged"
  }

  const note = input.note?.trim()
  const noteActor =
    input.distributionAttestationReviewedBy ??
    input.publicationRollbackCheckpointedBy ??
    input.publicationCorrectionLoggedBy ??
    input.actorId
  const publicationGovernanceNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.publicationGovernanceNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceId(
      input.dispositionFinalization.id
    ),
    firmId: input.dispositionFinalization.firmId,
    matterId: input.dispositionFinalization.matterId,
    dispositionFinalizationId: input.dispositionFinalization.id,
    classification: input.dispositionFinalization.classification,
    publicationGovernanceStatus,
    dispositionFinalizationStatusSnapshot:
      input.dispositionFinalization.dispositionFinalizationStatus,
    publicationCorrectionLoggedBy,
    publicationCorrectionLoggedAt,
    publicationCorrectionNote,
    publicationRollbackCheckpointedBy,
    publicationRollbackCheckpointedAt,
    publicationRollbackReason,
    distributionAttestationReviewedBy,
    distributionAttestationReviewedAt,
    distributionAttestationDecision,
    arbitrationPublicationExceptionBacklogCount,
    arbitrationRulingAgingHoursSnapshot: input.dispositionFinalization.arbitrationRulingAgingHours,
    publicationGovernanceNote,
    lastStatusChangedAt:
      input.publicationCorrectionLoggedBy ||
      input.publicationRollbackCheckpointedBy ||
      input.distributionAttestationReviewedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `disposition_finalization_status:${input.dispositionFinalization.dispositionFinalizationStatus}`,
      ...(existing?.provenanceTags ??
        input.dispositionFinalization.provenanceTags.map((tag) => `disposition_finalization_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow(
  input: {
    debtRetirement: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow | null
    retirementDisputeOpenedBy?: string | null
    retirementDisputeReason?: string | null
    retirementDisputeResolvedBy?: string | null
    retirementDisputeResolution?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeResolutionOutcome | null
    retirementRollbackControlledBy?: string | null
    retirementRollbackCount?: number | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const retirementDisputeOpenedBy =
    input.retirementDisputeOpenedBy ?? existing?.retirementDisputeOpenedBy ?? null
  const retirementDisputeOpenedAt = input.retirementDisputeOpenedBy
    ? now
    : (existing?.retirementDisputeOpenedAt ?? null)
  const retirementDisputeReason = input.retirementDisputeOpenedBy
    ? input.retirementDisputeReason?.trim() ?? input.note?.trim() ?? "retirement dispute opened"
    : (existing?.retirementDisputeReason ?? null)
  const retirementDisputeResolvedBy =
    input.retirementDisputeResolvedBy ?? existing?.retirementDisputeResolvedBy ?? null
  const retirementDisputeResolvedAt = input.retirementDisputeResolvedBy
    ? now
    : (existing?.retirementDisputeResolvedAt ?? null)
  const retirementDisputeResolution = input.retirementDisputeResolvedBy
    ? input.retirementDisputeResolution === "reopen_debt"
      ? "reopen_debt"
      : "uphold_retirement"
    : (existing?.retirementDisputeResolution ?? null)
  const retirementRollbackControlledBy =
    input.retirementRollbackControlledBy ?? existing?.retirementRollbackControlledBy ?? null
  const retirementRollbackControlledAt = input.retirementRollbackControlledBy
    ? now
    : (existing?.retirementRollbackControlledAt ?? null)
  const retirementRollbackCount =
    input.retirementRollbackCount !== undefined && input.retirementRollbackCount !== null
      ? Math.max(0, Math.floor(input.retirementRollbackCount))
      : (existing?.retirementRollbackCount ?? 0)

  const queueReentryExceptionDebtCountSnapshot =
    input.debtRetirement.queueReentryExceptionDebtCountSnapshot
  const queueReentryRetirementBurnCountSnapshot = input.debtRetirement.queueReentryRetirementBurnCount
  let queueReentryRetirementReconciliationDriftCount = Math.max(
    0,
    queueReentryExceptionDebtCountSnapshot - queueReentryRetirementBurnCountSnapshot
  )
  if (retirementDisputeOpenedBy) {
    queueReentryRetirementReconciliationDriftCount += 1
  }
  if (retirementDisputeResolution === "reopen_debt") {
    queueReentryRetirementReconciliationDriftCount += 1
  }
  if (retirementRollbackControlledBy) {
    queueReentryRetirementReconciliationDriftCount = Math.max(
      0,
      queueReentryRetirementReconciliationDriftCount - 1
    )
  }

  let disputeReconciliationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationStatus =
    "reconciliation_pending"
  if (retirementRollbackControlledBy) {
    disputeReconciliationStatus = "retirement_rollback_controlled"
  } else if (retirementDisputeResolvedBy) {
    disputeReconciliationStatus = "retirement_dispute_resolved"
  } else if (retirementDisputeOpenedBy) {
    disputeReconciliationStatus = "retirement_dispute_opened"
  }

  const note = input.note?.trim()
  const noteActor =
    input.retirementRollbackControlledBy ??
    input.retirementDisputeResolvedBy ??
    input.retirementDisputeOpenedBy ??
    input.actorId
  const reconciliationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.reconciliationNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationId(
      input.debtRetirement.id
    ),
    firmId: input.debtRetirement.firmId,
    matterId: input.debtRetirement.matterId,
    debtRetirementId: input.debtRetirement.id,
    classification: input.debtRetirement.classification,
    disputeReconciliationStatus,
    debtRetirementStatusSnapshot: input.debtRetirement.debtRetirementStatus,
    retirementDisputeOpenedBy,
    retirementDisputeOpenedAt,
    retirementDisputeReason,
    retirementDisputeResolvedBy,
    retirementDisputeResolvedAt,
    retirementDisputeResolution,
    retirementRollbackControlledBy,
    retirementRollbackControlledAt,
    retirementRollbackCount,
    queueReentryRetirementReconciliationDriftCount,
    reconciliationNote,
    lastStatusChangedAt:
      input.retirementDisputeOpenedBy ||
      input.retirementDisputeResolvedBy ||
      input.retirementRollbackControlledBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `debt_retirement_status:${input.debtRetirement.debtRetirementStatus}`,
      ...(existing?.provenanceTags ??
        input.debtRetirement.provenanceTags.map((tag) => `debt_retirement_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
