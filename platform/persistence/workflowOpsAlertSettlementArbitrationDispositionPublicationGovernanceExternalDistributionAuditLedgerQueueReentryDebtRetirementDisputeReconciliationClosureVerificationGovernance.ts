import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationStatus,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow,
} from "@/platform/spine/store"

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerId(
  publicationGovernanceId: string
): string {
  return `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:${publicationGovernanceId}`
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationId(
  disputeReconciliationId: string
): string {
  return `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:${disputeReconciliationId}`
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerStatus {
  return (
    value === "external_distribution_audit_pending" ||
    value === "distribution_channel_registered" ||
    value === "attestation_signer_roster_recorded" ||
    value === "publication_freeze_checkpointed"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationStatus {
  return (
    value === "closure_verification_pending" ||
    value === "reconciliation_closure_attested" ||
    value === "rollback_verification_checkpointed" ||
    value === "dispute_archive_checkpointed"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow(
  input: {
    publicationGovernance: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow | null
    distributionChannelRegistry?: string | null
    distributionChannelRegisteredBy?: string | null
    attestationSignerRoster?: string | null
    attestationSignerRosterRecordedBy?: string | null
    publicationFreezeCheckpointedBy?: string | null
    publicationFreezeReason?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const distributionChannelRegistry =
    input.distributionChannelRegistry?.trim() ??
    existing?.distributionChannelRegistry ??
    null
  const distributionChannelRegisteredBy =
    input.distributionChannelRegisteredBy ?? existing?.distributionChannelRegisteredBy ?? null
  const distributionChannelRegisteredAt = input.distributionChannelRegisteredBy
    ? now
    : (existing?.distributionChannelRegisteredAt ?? null)
  const attestationSignerRoster =
    input.attestationSignerRoster?.trim() ?? existing?.attestationSignerRoster ?? null
  const attestationSignerRosterRecordedBy =
    input.attestationSignerRosterRecordedBy ?? existing?.attestationSignerRosterRecordedBy ?? null
  const attestationSignerRosterRecordedAt = input.attestationSignerRosterRecordedBy
    ? now
    : (existing?.attestationSignerRosterRecordedAt ?? null)
  const publicationFreezeCheckpointedBy =
    input.publicationFreezeCheckpointedBy ?? existing?.publicationFreezeCheckpointedBy ?? null
  const publicationFreezeCheckpointedAt = input.publicationFreezeCheckpointedBy
    ? now
    : (existing?.publicationFreezeCheckpointedAt ?? null)
  const publicationFreezeReason = input.publicationFreezeCheckpointedBy
    ? input.publicationFreezeReason?.trim() ?? input.note?.trim() ?? "publication freeze checkpointed"
    : (existing?.publicationFreezeReason ?? null)

  let distributionAttestationBacklogCount = 0
  if (distributionChannelRegisteredBy && !attestationSignerRosterRecordedBy) {
    distributionAttestationBacklogCount += 1
  }
  if (attestationSignerRosterRecordedBy && !publicationFreezeCheckpointedBy) {
    distributionAttestationBacklogCount += 1
  }
  if (
    input.publicationGovernance.distributionAttestationDecision === "revision_required"
  ) {
    distributionAttestationBacklogCount += 1
  }
  if (publicationFreezeCheckpointedBy) {
    distributionAttestationBacklogCount = Math.max(0, distributionAttestationBacklogCount - 1)
  }

  let externalDistributionAuditLedgerStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerStatus =
    "external_distribution_audit_pending"
  if (publicationFreezeCheckpointedBy) {
    externalDistributionAuditLedgerStatus = "publication_freeze_checkpointed"
  } else if (attestationSignerRosterRecordedBy) {
    externalDistributionAuditLedgerStatus = "attestation_signer_roster_recorded"
  } else if (distributionChannelRegisteredBy) {
    externalDistributionAuditLedgerStatus = "distribution_channel_registered"
  }

  const note = input.note?.trim()
  const noteActor =
    input.publicationFreezeCheckpointedBy ??
    input.attestationSignerRosterRecordedBy ??
    input.distributionChannelRegisteredBy ??
    input.actorId
  const auditLedgerNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.auditLedgerNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerId(
      input.publicationGovernance.id
    ),
    firmId: input.publicationGovernance.firmId,
    matterId: input.publicationGovernance.matterId,
    publicationGovernanceId: input.publicationGovernance.id,
    classification: input.publicationGovernance.classification,
    externalDistributionAuditLedgerStatus,
    publicationGovernanceStatusSnapshot: input.publicationGovernance.publicationGovernanceStatus,
    distributionChannelRegistry,
    distributionChannelRegisteredBy,
    distributionChannelRegisteredAt,
    attestationSignerRoster,
    attestationSignerRosterRecordedBy,
    attestationSignerRosterRecordedAt,
    publicationFreezeCheckpointedBy,
    publicationFreezeCheckpointedAt,
    publicationFreezeReason,
    distributionAttestationBacklogCount,
    arbitrationPublicationExceptionBacklogCountSnapshot:
      input.publicationGovernance.arbitrationPublicationExceptionBacklogCount,
    auditLedgerNote,
    lastStatusChangedAt:
      input.distributionChannelRegisteredBy ||
      input.attestationSignerRosterRecordedBy ||
      input.publicationFreezeCheckpointedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `publication_governance_status:${input.publicationGovernance.publicationGovernanceStatus}`,
      ...(existing?.provenanceTags ??
        input.publicationGovernance.provenanceTags.map((tag) => `publication_governance_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow(
  input: {
    disputeReconciliation: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow | null
    reconciliationClosureAttestedBy?: string | null
    rollbackVerificationCheckpointedBy?: string | null
    rollbackVerificationNote?: string | null
    disputeArchiveCheckpointedBy?: string | null
    disputeArchiveReference?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const reconciliationClosureAttestedBy =
    input.reconciliationClosureAttestedBy ?? existing?.reconciliationClosureAttestedBy ?? null
  const reconciliationClosureAttestedAt = input.reconciliationClosureAttestedBy
    ? now
    : (existing?.reconciliationClosureAttestedAt ?? null)
  const rollbackVerificationCheckpointedBy =
    input.rollbackVerificationCheckpointedBy ?? existing?.rollbackVerificationCheckpointedBy ?? null
  const rollbackVerificationCheckpointedAt = input.rollbackVerificationCheckpointedBy
    ? now
    : (existing?.rollbackVerificationCheckpointedAt ?? null)
  const rollbackVerificationNote = input.rollbackVerificationCheckpointedBy
    ? input.rollbackVerificationNote?.trim() ?? input.note?.trim() ?? "rollback verification checkpointed"
    : (existing?.rollbackVerificationNote ?? null)
  const disputeArchiveCheckpointedBy =
    input.disputeArchiveCheckpointedBy ?? existing?.disputeArchiveCheckpointedBy ?? null
  const disputeArchiveCheckpointedAt = input.disputeArchiveCheckpointedBy
    ? now
    : (existing?.disputeArchiveCheckpointedAt ?? null)
  const disputeArchiveReference = input.disputeArchiveCheckpointedBy
    ? input.disputeArchiveReference?.trim() ?? input.note?.trim() ?? "dispute archive checkpointed"
    : (existing?.disputeArchiveReference ?? null)

  const disputeResolvedAt = input.disputeReconciliation.retirementDisputeResolvedAt
  const reconciliationClosureLagHours =
    reconciliationClosureAttestedBy && disputeResolvedAt
      ? Math.max(0, Math.floor((now - disputeResolvedAt) / (60 * 60 * 1000)))
      : (existing?.reconciliationClosureLagHours ?? 0)

  let reconciliationClosureLagCount = reconciliationClosureLagHours > 24 ? 1 : 0
  if (!reconciliationClosureAttestedBy && disputeResolvedAt) {
    reconciliationClosureLagCount = Math.max(
      1,
      Math.floor((now - disputeResolvedAt) / (60 * 60 * 1000))
    )
  }
  if (reconciliationClosureAttestedBy) {
    reconciliationClosureLagCount = Math.max(0, reconciliationClosureLagCount - 1)
  }

  let closureVerificationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationStatus =
    "closure_verification_pending"
  if (disputeArchiveCheckpointedBy) {
    closureVerificationStatus = "dispute_archive_checkpointed"
  } else if (rollbackVerificationCheckpointedBy) {
    closureVerificationStatus = "rollback_verification_checkpointed"
  } else if (reconciliationClosureAttestedBy) {
    closureVerificationStatus = "reconciliation_closure_attested"
  }

  const note = input.note?.trim()
  const noteActor =
    input.disputeArchiveCheckpointedBy ??
    input.rollbackVerificationCheckpointedBy ??
    input.reconciliationClosureAttestedBy ??
    input.actorId
  const closureVerificationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.closureVerificationNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationId(
      input.disputeReconciliation.id
    ),
    firmId: input.disputeReconciliation.firmId,
    matterId: input.disputeReconciliation.matterId,
    disputeReconciliationId: input.disputeReconciliation.id,
    classification: input.disputeReconciliation.classification,
    closureVerificationStatus,
    disputeReconciliationStatusSnapshot: input.disputeReconciliation.disputeReconciliationStatus,
    reconciliationClosureAttestedBy,
    reconciliationClosureAttestedAt,
    rollbackVerificationCheckpointedBy,
    rollbackVerificationCheckpointedAt,
    rollbackVerificationNote,
    disputeArchiveCheckpointedBy,
    disputeArchiveCheckpointedAt,
    disputeArchiveReference,
    reconciliationClosureLagHours,
    reconciliationClosureLagCount,
    queueReentryRetirementReconciliationDriftCountSnapshot:
      input.disputeReconciliation.queueReentryRetirementReconciliationDriftCount,
    closureVerificationNote,
    lastStatusChangedAt:
      input.reconciliationClosureAttestedBy ||
      input.rollbackVerificationCheckpointedBy ||
      input.disputeArchiveCheckpointedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `dispute_reconciliation_status:${input.disputeReconciliation.disputeReconciliationStatus}`,
      ...(existing?.provenanceTags ??
        input.disputeReconciliation.provenanceTags.map((tag) => `dispute_reconciliation_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
