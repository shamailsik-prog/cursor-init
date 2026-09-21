import { buildWorkflowOpsChainedDocumentId } from "@/platform/persistence/workflowOpsChainedDocumentId"
import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportStatus,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow,
} from "@/platform/spine/store"

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationId(
  externalDistributionAuditLedgerId: string
): string {
  return buildWorkflowOpsChainedDocumentId(`workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation`, externalDistributionAuditLedgerId)
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportId(
  closureVerificationId: string
): string {
  return buildWorkflowOpsChainedDocumentId(`workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export`, closureVerificationId)
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationStatus {
  return (
    value === "partner_handoff_attestation_pending" ||
    value === "outbound_registry_registered" ||
    value === "partner_handoff_attested" ||
    value === "outbound_registry_freeze_override_checkpointed"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportStatus {
  return (
    value === "archival_export_pending" ||
    value === "archival_export_checkpointed" ||
    value === "closure_verification_sla_breach_digested" ||
    value === "archival_export_finalized"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow(
  input: {
    externalDistributionAuditLedger: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow | null
    outboundPartnerHandoffRegistry?: string | null
    outboundRegistryRegisteredBy?: string | null
    partnerHandoffAttestedBy?: string | null
    partnerHandoffReference?: string | null
    outboundRegistryFreezeOverrideCheckpointedBy?: string | null
    outboundRegistryFreezeOverrideReason?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const outboundPartnerHandoffRegistry =
    input.outboundPartnerHandoffRegistry?.trim() ?? existing?.outboundPartnerHandoffRegistry ?? null
  const outboundRegistryRegisteredBy =
    input.outboundRegistryRegisteredBy ?? existing?.outboundRegistryRegisteredBy ?? null
  const outboundRegistryRegisteredAt = input.outboundRegistryRegisteredBy
    ? now
    : (existing?.outboundRegistryRegisteredAt ?? null)
  const partnerHandoffAttestedBy =
    input.partnerHandoffAttestedBy ?? existing?.partnerHandoffAttestedBy ?? null
  const partnerHandoffAttestedAt = input.partnerHandoffAttestedBy
    ? now
    : (existing?.partnerHandoffAttestedAt ?? null)
  const partnerHandoffReference = input.partnerHandoffAttestedBy
    ? input.partnerHandoffReference?.trim() ?? input.note?.trim() ?? "partner handoff attested"
    : (existing?.partnerHandoffReference ?? null)
  const outboundRegistryFreezeOverrideCheckpointedBy =
    input.outboundRegistryFreezeOverrideCheckpointedBy ??
    existing?.outboundRegistryFreezeOverrideCheckpointedBy ??
    null
  const outboundRegistryFreezeOverrideCheckpointedAt =
    input.outboundRegistryFreezeOverrideCheckpointedBy
      ? now
      : (existing?.outboundRegistryFreezeOverrideCheckpointedAt ?? null)
  const outboundRegistryFreezeOverrideReason = input.outboundRegistryFreezeOverrideCheckpointedBy
    ? input.outboundRegistryFreezeOverrideReason?.trim() ??
      input.note?.trim() ??
      "outbound registry freeze override checkpointed"
    : (existing?.outboundRegistryFreezeOverrideReason ?? null)

  let partnerHandoffBacklogCount = 0
  if (outboundRegistryRegisteredBy && !partnerHandoffAttestedBy) {
    partnerHandoffBacklogCount += 1
  }
  if (partnerHandoffAttestedBy && !outboundRegistryFreezeOverrideCheckpointedBy) {
    partnerHandoffBacklogCount += 1
  }
  if (
    input.externalDistributionAuditLedger.externalDistributionAuditLedgerStatus !==
    "publication_freeze_checkpointed"
  ) {
    partnerHandoffBacklogCount += 1
  }
  if (outboundRegistryFreezeOverrideCheckpointedBy) {
    partnerHandoffBacklogCount = Math.max(0, partnerHandoffBacklogCount - 1)
  }

  let partnerHandoffAttestationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationStatus =
    "partner_handoff_attestation_pending"
  if (outboundRegistryFreezeOverrideCheckpointedBy) {
    partnerHandoffAttestationStatus = "outbound_registry_freeze_override_checkpointed"
  } else if (partnerHandoffAttestedBy) {
    partnerHandoffAttestationStatus = "partner_handoff_attested"
  } else if (outboundRegistryRegisteredBy) {
    partnerHandoffAttestationStatus = "outbound_registry_registered"
  }

  const note = input.note?.trim()
  const noteActor =
    input.outboundRegistryFreezeOverrideCheckpointedBy ??
    input.partnerHandoffAttestedBy ??
    input.outboundRegistryRegisteredBy ??
    input.actorId
  const partnerHandoffAttestationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.partnerHandoffAttestationNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationId(
      input.externalDistributionAuditLedger.id
    ),
    firmId: input.externalDistributionAuditLedger.firmId,
    matterId: input.externalDistributionAuditLedger.matterId,
    externalDistributionAuditLedgerId: input.externalDistributionAuditLedger.id,
    classification: input.externalDistributionAuditLedger.classification,
    partnerHandoffAttestationStatus,
    externalDistributionAuditLedgerStatusSnapshot:
      input.externalDistributionAuditLedger.externalDistributionAuditLedgerStatus,
    outboundPartnerHandoffRegistry,
    outboundRegistryRegisteredBy,
    outboundRegistryRegisteredAt,
    partnerHandoffAttestedBy,
    partnerHandoffAttestedAt,
    partnerHandoffReference,
    outboundRegistryFreezeOverrideCheckpointedBy,
    outboundRegistryFreezeOverrideCheckpointedAt,
    outboundRegistryFreezeOverrideReason,
    partnerHandoffBacklogCount,
    distributionAttestationBacklogCountSnapshot:
      input.externalDistributionAuditLedger.distributionAttestationBacklogCount,
    partnerHandoffAttestationNote,
    lastStatusChangedAt:
      input.outboundRegistryRegisteredBy ||
      input.partnerHandoffAttestedBy ||
      input.outboundRegistryFreezeOverrideCheckpointedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `external_distribution_audit_ledger_status:${input.externalDistributionAuditLedger.externalDistributionAuditLedgerStatus}`,
      ...(existing?.provenanceTags ??
        input.externalDistributionAuditLedger.provenanceTags.map(
          (tag) => `external_distribution_audit_ledger_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow(
  input: {
    closureVerification: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow | null
    archivalExportCheckpointedBy?: string | null
    archivalExportReference?: string | null
    closureVerificationSlaBreachDigestedBy?: string | null
    closureVerificationSlaBreachDigest?: string | null
    archivalExportFinalizedBy?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const archivalExportCheckpointedBy =
    input.archivalExportCheckpointedBy ?? existing?.archivalExportCheckpointedBy ?? null
  const archivalExportCheckpointedAt = input.archivalExportCheckpointedBy
    ? now
    : (existing?.archivalExportCheckpointedAt ?? null)
  const archivalExportReference = input.archivalExportCheckpointedBy
    ? input.archivalExportReference?.trim() ?? input.note?.trim() ?? "archival export checkpointed"
    : (existing?.archivalExportReference ?? null)
  const closureVerificationSlaBreachDigestedBy =
    input.closureVerificationSlaBreachDigestedBy ?? existing?.closureVerificationSlaBreachDigestedBy ?? null
  const closureVerificationSlaBreachDigestedAt = input.closureVerificationSlaBreachDigestedBy
    ? now
    : (existing?.closureVerificationSlaBreachDigestedAt ?? null)
  const closureVerificationSlaBreachDigest = input.closureVerificationSlaBreachDigestedBy
    ? input.closureVerificationSlaBreachDigest?.trim() ??
      input.note?.trim() ??
      "closure verification sla breach digested"
    : (existing?.closureVerificationSlaBreachDigest ?? null)
  const archivalExportFinalizedBy =
    input.archivalExportFinalizedBy ?? existing?.archivalExportFinalizedBy ?? null
  const archivalExportFinalizedAt = input.archivalExportFinalizedBy
    ? now
    : (existing?.archivalExportFinalizedAt ?? null)

  const disputeArchiveCheckpointedAt = input.closureVerification.disputeArchiveCheckpointedAt
  const closureArchivalLagHours =
    archivalExportCheckpointedBy && disputeArchiveCheckpointedAt
      ? Math.max(0, Math.floor((now - disputeArchiveCheckpointedAt) / (60 * 60 * 1000)))
      : (existing?.closureArchivalLagHours ?? 0)

  let closureArchivalLagCount = closureArchivalLagHours > 24 ? 1 : 0
  if (!archivalExportCheckpointedBy && disputeArchiveCheckpointedAt) {
    closureArchivalLagCount = Math.max(
      1,
      Math.floor((now - disputeArchiveCheckpointedAt) / (60 * 60 * 1000))
    )
  }
  if (archivalExportFinalizedBy) {
    closureArchivalLagCount = Math.max(0, closureArchivalLagCount - 1)
  }

  let archivalExportStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportStatus =
    "archival_export_pending"
  if (archivalExportFinalizedBy) {
    archivalExportStatus = "archival_export_finalized"
  } else if (closureVerificationSlaBreachDigestedBy) {
    archivalExportStatus = "closure_verification_sla_breach_digested"
  } else if (archivalExportCheckpointedBy) {
    archivalExportStatus = "archival_export_checkpointed"
  }

  const note = input.note?.trim()
  const noteActor =
    input.archivalExportFinalizedBy ??
    input.closureVerificationSlaBreachDigestedBy ??
    input.archivalExportCheckpointedBy ??
    input.actorId
  const archivalExportNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.archivalExportNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportId(
      input.closureVerification.id
    ),
    firmId: input.closureVerification.firmId,
    matterId: input.closureVerification.matterId,
    closureVerificationId: input.closureVerification.id,
    classification: input.closureVerification.classification,
    archivalExportStatus,
    closureVerificationStatusSnapshot: input.closureVerification.closureVerificationStatus,
    archivalExportCheckpointedBy,
    archivalExportCheckpointedAt,
    archivalExportReference,
    closureVerificationSlaBreachDigestedBy,
    closureVerificationSlaBreachDigestedAt,
    closureVerificationSlaBreachDigest,
    archivalExportFinalizedBy,
    archivalExportFinalizedAt,
    closureArchivalLagHours,
    closureArchivalLagCount,
    reconciliationClosureLagCountSnapshot: input.closureVerification.reconciliationClosureLagCount,
    archivalExportNote,
    lastStatusChangedAt:
      input.archivalExportCheckpointedBy ||
      input.closureVerificationSlaBreachDigestedBy ||
      input.archivalExportFinalizedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `closure_verification_status:${input.closureVerification.closureVerificationStatus}`,
      ...(existing?.provenanceTags ??
        input.closureVerification.provenanceTags.map((tag) => `closure_verification_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
