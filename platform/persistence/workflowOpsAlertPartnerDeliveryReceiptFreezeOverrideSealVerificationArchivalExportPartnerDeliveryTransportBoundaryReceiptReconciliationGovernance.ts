import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow,
} from "@/platform/spine/store"

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId(
  outboundRegistryAttestationLedgerId: string
): string {
  return `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification:${outboundRegistryAttestationLedgerId}`
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationId(
  partnerDeliveryReceiptId: string
): string {
  return `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation:${partnerDeliveryReceiptId}`
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus {
  return (
    value === "partner_delivery_receipt_freeze_override_seal_verification_pending" ||
    value === "partner_delivery_receipt_freeze_override_seal_checkpointed" ||
    value === "partner_delivery_receipt_freeze_override_seal_verified"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationStatus {
  return (
    value === "transport_boundary_receipt_reconciliation_pending" ||
    value === "archival_export_transport_boundary_receipt_reconciled" ||
    value === "partner_delivery_transport_boundary_receipt_reconciliation_finalized"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow(
  input: {
    outboundRegistryAttestationLedger: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow | null
    partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy?: string | null
    partnerDeliveryReceiptFreezeOverrideSealReference?: string | null
    partnerDeliveryReceiptFreezeOverrideSealVerifiedBy?: string | null
    partnerDeliveryReceiptFreezeOverrideSealVerificationDigest?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy =
    input.partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy ??
    existing?.partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy ??
    null
  const partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt =
    input.partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy
      ? now
      : (existing?.partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt ?? null)
  const partnerDeliveryReceiptFreezeOverrideSealReference =
    input.partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy
      ? input.partnerDeliveryReceiptFreezeOverrideSealReference?.trim() ??
        input.note?.trim() ??
        "partner delivery receipt freeze override seal checkpointed"
      : (existing?.partnerDeliveryReceiptFreezeOverrideSealReference ?? null)
  const partnerDeliveryReceiptFreezeOverrideSealVerifiedBy =
    input.partnerDeliveryReceiptFreezeOverrideSealVerifiedBy ??
    existing?.partnerDeliveryReceiptFreezeOverrideSealVerifiedBy ??
    null
  const partnerDeliveryReceiptFreezeOverrideSealVerifiedAt = input.partnerDeliveryReceiptFreezeOverrideSealVerifiedBy
    ? now
    : (existing?.partnerDeliveryReceiptFreezeOverrideSealVerifiedAt ?? null)
  const partnerDeliveryReceiptFreezeOverrideSealVerificationDigest =
    input.partnerDeliveryReceiptFreezeOverrideSealVerifiedBy
      ? input.partnerDeliveryReceiptFreezeOverrideSealVerificationDigest?.trim() ??
        input.note?.trim() ??
        "partner delivery receipt freeze override seal verified"
      : (existing?.partnerDeliveryReceiptFreezeOverrideSealVerificationDigest ?? null)

  let partnerDeliverySealBacklogCount = 0
  if (
    input.outboundRegistryAttestationLedger.outboundRegistryAttestationLedgerStatus ===
    "partner_delivery_receipt_freeze_override_digested"
  ) {
    if (!partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy) {
      partnerDeliverySealBacklogCount += 1
    }
    if (partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy && !partnerDeliveryReceiptFreezeOverrideSealVerifiedBy) {
      partnerDeliverySealBacklogCount += 1
    }
  } else {
    partnerDeliverySealBacklogCount += 1
  }
  if (partnerDeliveryReceiptFreezeOverrideSealVerifiedBy) {
    partnerDeliverySealBacklogCount = Math.max(0, partnerDeliverySealBacklogCount - 1)
  }

  let partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus =
    "partner_delivery_receipt_freeze_override_seal_verification_pending"
  if (partnerDeliveryReceiptFreezeOverrideSealVerifiedBy) {
    partnerDeliveryReceiptFreezeOverrideSealVerificationStatus =
      "partner_delivery_receipt_freeze_override_seal_verified"
  } else if (partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy) {
    partnerDeliveryReceiptFreezeOverrideSealVerificationStatus =
      "partner_delivery_receipt_freeze_override_seal_checkpointed"
  }

  const note = input.note?.trim()
  const noteActor =
    input.partnerDeliveryReceiptFreezeOverrideSealVerifiedBy ??
    input.partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy ??
    input.actorId
  const partnerDeliveryReceiptFreezeOverrideSealVerificationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.partnerDeliveryReceiptFreezeOverrideSealVerificationNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId(
      input.outboundRegistryAttestationLedger.id
    ),
    firmId: input.outboundRegistryAttestationLedger.firmId,
    matterId: input.outboundRegistryAttestationLedger.matterId,
    outboundRegistryAttestationLedgerId: input.outboundRegistryAttestationLedger.id,
    classification: input.outboundRegistryAttestationLedger.classification,
    partnerDeliveryReceiptFreezeOverrideSealVerificationStatus,
    outboundRegistryAttestationLedgerStatusSnapshot:
      input.outboundRegistryAttestationLedger.outboundRegistryAttestationLedgerStatus,
    partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy,
    partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt,
    partnerDeliveryReceiptFreezeOverrideSealReference,
    partnerDeliveryReceiptFreezeOverrideSealVerifiedBy,
    partnerDeliveryReceiptFreezeOverrideSealVerifiedAt,
    partnerDeliveryReceiptFreezeOverrideSealVerificationDigest,
    partnerDeliverySealBacklogCount,
    partnerDeliveryBacklogCountSnapshot: input.outboundRegistryAttestationLedger.partnerDeliveryBacklogCount,
    partnerDeliveryReceiptFreezeOverrideSealVerificationNote,
    lastStatusChangedAt:
      input.partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy ||
      input.partnerDeliveryReceiptFreezeOverrideSealVerifiedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `outbound_registry_attestation_ledger_status:${input.outboundRegistryAttestationLedger.outboundRegistryAttestationLedgerStatus}`,
      ...(existing?.provenanceTags ??
        input.outboundRegistryAttestationLedger.provenanceTags.map(
          (tag) => `outbound_registry_attestation_ledger_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow(
  input: {
    partnerDeliveryReceipt: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow | null
    archivalExportTransportBoundaryReceiptReconciledBy?: string | null
    archivalExportTransportBoundaryReceiptReconciliationDigest?: string | null
    transportBoundaryReceiptReconciliationFinalizedBy?: string | null
    transportBoundaryReceiptReconciliationReference?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const archivalExportTransportBoundaryReceiptReconciledBy =
    input.archivalExportTransportBoundaryReceiptReconciledBy ??
    existing?.archivalExportTransportBoundaryReceiptReconciledBy ??
    null
  const archivalExportTransportBoundaryReceiptReconciledAt =
    input.archivalExportTransportBoundaryReceiptReconciledBy
      ? now
      : (existing?.archivalExportTransportBoundaryReceiptReconciledAt ?? null)
  const archivalExportTransportBoundaryReceiptReconciliationDigest =
    input.archivalExportTransportBoundaryReceiptReconciledBy
      ? input.archivalExportTransportBoundaryReceiptReconciliationDigest?.trim() ??
        input.note?.trim() ??
        "archival export transport boundary receipt reconciled"
      : (existing?.archivalExportTransportBoundaryReceiptReconciliationDigest ?? null)
  const transportBoundaryReceiptReconciliationFinalizedBy =
    input.transportBoundaryReceiptReconciliationFinalizedBy ??
    existing?.transportBoundaryReceiptReconciliationFinalizedBy ??
    null
  const transportBoundaryReceiptReconciliationFinalizedAt = input.transportBoundaryReceiptReconciliationFinalizedBy
    ? now
    : (existing?.transportBoundaryReceiptReconciliationFinalizedAt ?? null)
  const transportBoundaryReceiptReconciliationReference =
    input.transportBoundaryReceiptReconciliationFinalizedBy
      ? input.transportBoundaryReceiptReconciliationReference?.trim() ??
        input.note?.trim() ??
        "partner delivery transport boundary receipt reconciliation finalized"
      : (existing?.transportBoundaryReceiptReconciliationReference ?? null)

  const transportBoundaryAttestedAt =
    input.partnerDeliveryReceipt.archivalExportTransportBoundaryAttestedAt ?? null
  const archivalTransportReconciliationLagHours =
    archivalExportTransportBoundaryReceiptReconciledBy && transportBoundaryAttestedAt
      ? Math.max(0, Math.floor((now - transportBoundaryAttestedAt) / (60 * 60 * 1000)))
      : (existing?.archivalTransportReconciliationLagHours ?? 0)

  let archivalTransportReconciliationLagCount = archivalTransportReconciliationLagHours > 8 ? 1 : 0
  if (
    !archivalExportTransportBoundaryReceiptReconciledBy &&
    input.partnerDeliveryReceipt.partnerDeliveryReceiptStatus === "archival_export_transport_boundary_attested"
  ) {
    archivalTransportReconciliationLagCount = Math.max(1, archivalTransportReconciliationLagCount)
  }
  if (transportBoundaryReceiptReconciliationFinalizedBy) {
    archivalTransportReconciliationLagCount = Math.max(0, archivalTransportReconciliationLagCount - 1)
  }

  let partnerDeliveryTransportBoundaryReceiptReconciliationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationStatus =
    "transport_boundary_receipt_reconciliation_pending"
  if (transportBoundaryReceiptReconciliationFinalizedBy) {
    partnerDeliveryTransportBoundaryReceiptReconciliationStatus =
      "partner_delivery_transport_boundary_receipt_reconciliation_finalized"
  } else if (archivalExportTransportBoundaryReceiptReconciledBy) {
    partnerDeliveryTransportBoundaryReceiptReconciliationStatus =
      "archival_export_transport_boundary_receipt_reconciled"
  }

  const note = input.note?.trim()
  const noteActor =
    input.transportBoundaryReceiptReconciliationFinalizedBy ??
    input.archivalExportTransportBoundaryReceiptReconciledBy ??
    input.actorId
  const partnerDeliveryTransportBoundaryReceiptReconciliationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.partnerDeliveryTransportBoundaryReceiptReconciliationNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationId(
      input.partnerDeliveryReceipt.id
    ),
    firmId: input.partnerDeliveryReceipt.firmId,
    matterId: input.partnerDeliveryReceipt.matterId,
    partnerDeliveryReceiptId: input.partnerDeliveryReceipt.id,
    classification: input.partnerDeliveryReceipt.classification,
    partnerDeliveryTransportBoundaryReceiptReconciliationStatus,
    partnerDeliveryReceiptStatusSnapshot: input.partnerDeliveryReceipt.partnerDeliveryReceiptStatus,
    archivalExportTransportBoundaryReceiptReconciledBy,
    archivalExportTransportBoundaryReceiptReconciledAt,
    archivalExportTransportBoundaryReceiptReconciliationDigest,
    transportBoundaryReceiptReconciliationFinalizedBy,
    transportBoundaryReceiptReconciliationFinalizedAt,
    transportBoundaryReceiptReconciliationReference,
    archivalTransportReconciliationLagHours,
    archivalTransportReconciliationLagCount,
    archivalTransportLagCountSnapshot: input.partnerDeliveryReceipt.archivalTransportLagCount,
    partnerDeliveryTransportBoundaryReceiptReconciliationNote,
    lastStatusChangedAt:
      input.archivalExportTransportBoundaryReceiptReconciledBy ||
      input.transportBoundaryReceiptReconciliationFinalizedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `partner_delivery_receipt_status:${input.partnerDeliveryReceipt.partnerDeliveryReceiptStatus}`,
      ...(existing?.provenanceTags ??
        input.partnerDeliveryReceipt.provenanceTags.map((tag) => `partner_delivery_receipt_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
