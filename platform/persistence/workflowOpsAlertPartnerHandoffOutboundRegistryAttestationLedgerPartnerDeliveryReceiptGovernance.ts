import { buildWorkflowOpsChainedDocumentId } from "@/platform/persistence/workflowOpsChainedDocumentId"
import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptStatus,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow,
} from "@/platform/spine/store"

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerId(
  partnerHandoffAttestationId: string
): string {
  return buildWorkflowOpsChainedDocumentId(`workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger`, partnerHandoffAttestationId)
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptId(
  archivalExportId: string
): string {
  return buildWorkflowOpsChainedDocumentId(`workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_receipt`, archivalExportId)
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus {
  return (
    value === "outbound_registry_attestation_ledger_pending" ||
    value === "outbound_attestation_ledger_checkpointed" ||
    value === "partner_delivery_receipt_freeze_override_digested"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptStatus {
  return (
    value === "partner_delivery_receipt_pending" ||
    value === "partner_delivery_sla_breach_digested" ||
    value === "archival_export_transport_boundary_attested" ||
    value === "partner_delivery_receipt_finalized"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow(
  input: {
    partnerHandoffAttestation: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow | null
    outboundAttestationLedgerCheckpointedBy?: string | null
    outboundAttestationLedgerReference?: string | null
    partnerDeliveryReceiptFreezeOverrideDigestedBy?: string | null
    partnerDeliveryReceiptFreezeOverrideDigest?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const outboundAttestationLedgerCheckpointedBy =
    input.outboundAttestationLedgerCheckpointedBy ??
    existing?.outboundAttestationLedgerCheckpointedBy ??
    null
  const outboundAttestationLedgerCheckpointedAt = input.outboundAttestationLedgerCheckpointedBy
    ? now
    : (existing?.outboundAttestationLedgerCheckpointedAt ?? null)
  const outboundAttestationLedgerReference = input.outboundAttestationLedgerCheckpointedBy
    ? input.outboundAttestationLedgerReference?.trim() ??
      input.note?.trim() ??
      "outbound attestation ledger checkpointed"
    : (existing?.outboundAttestationLedgerReference ?? null)
  const partnerDeliveryReceiptFreezeOverrideDigestedBy =
    input.partnerDeliveryReceiptFreezeOverrideDigestedBy ??
    existing?.partnerDeliveryReceiptFreezeOverrideDigestedBy ??
    null
  const partnerDeliveryReceiptFreezeOverrideDigestedAt =
    input.partnerDeliveryReceiptFreezeOverrideDigestedBy
      ? now
      : (existing?.partnerDeliveryReceiptFreezeOverrideDigestedAt ?? null)
  const partnerDeliveryReceiptFreezeOverrideDigest =
    input.partnerDeliveryReceiptFreezeOverrideDigestedBy
      ? input.partnerDeliveryReceiptFreezeOverrideDigest?.trim() ??
        input.note?.trim() ??
        "partner delivery receipt freeze override digested"
      : (existing?.partnerDeliveryReceiptFreezeOverrideDigest ?? null)

  let partnerDeliveryBacklogCount = 0
  if (
    input.partnerHandoffAttestation.partnerHandoffAttestationStatus === "partner_handoff_attested" ||
    input.partnerHandoffAttestation.partnerHandoffAttestationStatus ===
      "outbound_registry_freeze_override_checkpointed"
  ) {
    if (!outboundAttestationLedgerCheckpointedBy) {
      partnerDeliveryBacklogCount += 1
    }
    if (outboundAttestationLedgerCheckpointedBy && !partnerDeliveryReceiptFreezeOverrideDigestedBy) {
      partnerDeliveryBacklogCount += 1
    }
  } else {
    partnerDeliveryBacklogCount += 1
  }
  if (partnerDeliveryReceiptFreezeOverrideDigestedBy) {
    partnerDeliveryBacklogCount = Math.max(0, partnerDeliveryBacklogCount - 1)
  }

  let outboundRegistryAttestationLedgerStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus =
    "outbound_registry_attestation_ledger_pending"
  if (partnerDeliveryReceiptFreezeOverrideDigestedBy) {
    outboundRegistryAttestationLedgerStatus = "partner_delivery_receipt_freeze_override_digested"
  } else if (outboundAttestationLedgerCheckpointedBy) {
    outboundRegistryAttestationLedgerStatus = "outbound_attestation_ledger_checkpointed"
  }

  const note = input.note?.trim()
  const noteActor =
    input.partnerDeliveryReceiptFreezeOverrideDigestedBy ??
    input.outboundAttestationLedgerCheckpointedBy ??
    input.actorId
  const outboundRegistryAttestationLedgerNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.outboundRegistryAttestationLedgerNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerId(
      input.partnerHandoffAttestation.id
    ),
    firmId: input.partnerHandoffAttestation.firmId,
    matterId: input.partnerHandoffAttestation.matterId,
    partnerHandoffAttestationId: input.partnerHandoffAttestation.id,
    classification: input.partnerHandoffAttestation.classification,
    outboundRegistryAttestationLedgerStatus,
    partnerHandoffAttestationStatusSnapshot:
      input.partnerHandoffAttestation.partnerHandoffAttestationStatus,
    outboundAttestationLedgerCheckpointedBy,
    outboundAttestationLedgerCheckpointedAt,
    outboundAttestationLedgerReference,
    partnerDeliveryReceiptFreezeOverrideDigestedBy,
    partnerDeliveryReceiptFreezeOverrideDigestedAt,
    partnerDeliveryReceiptFreezeOverrideDigest,
    partnerDeliveryBacklogCount,
    partnerHandoffBacklogCountSnapshot: input.partnerHandoffAttestation.partnerHandoffBacklogCount,
    outboundRegistryAttestationLedgerNote,
    lastStatusChangedAt:
      input.outboundAttestationLedgerCheckpointedBy ||
      input.partnerDeliveryReceiptFreezeOverrideDigestedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `partner_handoff_attestation_status:${input.partnerHandoffAttestation.partnerHandoffAttestationStatus}`,
      ...(existing?.provenanceTags ??
        input.partnerHandoffAttestation.provenanceTags.map(
          (tag) => `partner_handoff_attestation_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow(
  input: {
    archivalExport: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow | null
    partnerDeliverySlaBreachDigestedBy?: string | null
    partnerDeliverySlaBreachDigest?: string | null
    archivalExportTransportBoundaryAttestedBy?: string | null
    archivalExportTransportBoundaryReference?: string | null
    partnerDeliveryReceiptFinalizedBy?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const partnerDeliverySlaBreachDigestedBy =
    input.partnerDeliverySlaBreachDigestedBy ?? existing?.partnerDeliverySlaBreachDigestedBy ?? null
  const partnerDeliverySlaBreachDigestedAt = input.partnerDeliverySlaBreachDigestedBy
    ? now
    : (existing?.partnerDeliverySlaBreachDigestedAt ?? null)
  const partnerDeliverySlaBreachDigest = input.partnerDeliverySlaBreachDigestedBy
    ? input.partnerDeliverySlaBreachDigest?.trim() ??
      input.note?.trim() ??
      "partner delivery sla breach digested"
    : (existing?.partnerDeliverySlaBreachDigest ?? null)
  const archivalExportTransportBoundaryAttestedBy =
    input.archivalExportTransportBoundaryAttestedBy ??
    existing?.archivalExportTransportBoundaryAttestedBy ??
    null
  const archivalExportTransportBoundaryAttestedAt = input.archivalExportTransportBoundaryAttestedBy
    ? now
    : (existing?.archivalExportTransportBoundaryAttestedAt ?? null)
  const archivalExportTransportBoundaryReference = input.archivalExportTransportBoundaryAttestedBy
    ? input.archivalExportTransportBoundaryReference?.trim() ??
      input.note?.trim() ??
      "archival export transport boundary attested"
    : (existing?.archivalExportTransportBoundaryReference ?? null)
  const partnerDeliveryReceiptFinalizedBy =
    input.partnerDeliveryReceiptFinalizedBy ?? existing?.partnerDeliveryReceiptFinalizedBy ?? null
  const partnerDeliveryReceiptFinalizedAt = input.partnerDeliveryReceiptFinalizedBy
    ? now
    : (existing?.partnerDeliveryReceiptFinalizedAt ?? null)

  const archivalExportFinalizedAt = input.archivalExport.archivalExportFinalizedAt
  const archivalTransportLagHours =
    partnerDeliverySlaBreachDigestedBy && archivalExportFinalizedAt
      ? Math.max(0, Math.floor((now - archivalExportFinalizedAt) / (60 * 60 * 1000)))
      : (existing?.archivalTransportLagHours ?? 0)

  let archivalTransportLagCount = archivalTransportLagHours > 12 ? 1 : 0
  if (!partnerDeliverySlaBreachDigestedBy && archivalExportFinalizedAt) {
    archivalTransportLagCount = Math.max(
      1,
      Math.floor((now - archivalExportFinalizedAt) / (60 * 60 * 1000))
    )
  }
  if (partnerDeliveryReceiptFinalizedBy) {
    archivalTransportLagCount = Math.max(0, archivalTransportLagCount - 1)
  }

  let partnerDeliveryReceiptStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptStatus =
    "partner_delivery_receipt_pending"
  if (partnerDeliveryReceiptFinalizedBy) {
    partnerDeliveryReceiptStatus = "partner_delivery_receipt_finalized"
  } else if (archivalExportTransportBoundaryAttestedBy) {
    partnerDeliveryReceiptStatus = "archival_export_transport_boundary_attested"
  } else if (partnerDeliverySlaBreachDigestedBy) {
    partnerDeliveryReceiptStatus = "partner_delivery_sla_breach_digested"
  }

  const note = input.note?.trim()
  const noteActor =
    input.partnerDeliveryReceiptFinalizedBy ??
    input.archivalExportTransportBoundaryAttestedBy ??
    input.partnerDeliverySlaBreachDigestedBy ??
    input.actorId
  const partnerDeliveryReceiptNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.partnerDeliveryReceiptNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptId(
      input.archivalExport.id
    ),
    firmId: input.archivalExport.firmId,
    matterId: input.archivalExport.matterId,
    archivalExportId: input.archivalExport.id,
    classification: input.archivalExport.classification,
    partnerDeliveryReceiptStatus,
    archivalExportStatusSnapshot: input.archivalExport.archivalExportStatus,
    partnerDeliverySlaBreachDigestedBy,
    partnerDeliverySlaBreachDigestedAt,
    partnerDeliverySlaBreachDigest,
    archivalExportTransportBoundaryAttestedBy,
    archivalExportTransportBoundaryAttestedAt,
    archivalExportTransportBoundaryReference,
    partnerDeliveryReceiptFinalizedBy,
    partnerDeliveryReceiptFinalizedAt,
    archivalTransportLagHours,
    archivalTransportLagCount,
    closureArchivalLagCountSnapshot: input.archivalExport.closureArchivalLagCount,
    partnerDeliveryReceiptNote,
    lastStatusChangedAt:
      input.partnerDeliverySlaBreachDigestedBy ||
      input.archivalExportTransportBoundaryAttestedBy ||
      input.partnerDeliveryReceiptFinalizedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `archival_export_status:${input.archivalExport.archivalExportStatus}`,
      ...(existing?.provenanceTags ??
        input.archivalExport.provenanceTags.map((tag) => `archival_export_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
