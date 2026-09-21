import { buildWorkflowOpsChainedDocumentId } from "@/platform/persistence/workflowOpsChainedDocumentId"
import { WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM } from "@/platform/persistence/workflowOpsAlertArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentClosureAttestationExternalTransportReceiptAcknowledgmentGovernance"
import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow,
} from "@/platform/spine/store"

const TRANSPORT_STUB_PROVENANCE_TAG = "transport_stub:true"
const STUB_PARTNER_HANDOFF_REGISTRY_PREFIX = "blocked_todo_firm:transport_stub_partner_handoff_registry"

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId(
  archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationId: string
): string {
  return buildWorkflowOpsChainedDocumentId(
    `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger`,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationId
  )
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId(
  closureAttestationExternalTransportReceiptAcknowledgmentReconciliationId: string
): string {
  return buildWorkflowOpsChainedDocumentId(
    `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation`,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationId
  )
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus {
  return (
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending" ||
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_entry_recorded" ||
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_finalized"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus {
  return (
    value ===
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending" ||
    value ===
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_registered" ||
    value ===
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attested" ||
    value ===
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow(
  input: {
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow | null
    reconciliationFinalizedDigestAnchoredBy?: string | null
    reconciliationFinalizedDigestAnchor?: string | null
    externalDistributionAuditLedgerEntryRecordedBy?: string | null
    externalDistributionAuditLedgerEntryReference?: string | null
    externalDistributionAuditLedgerFinalizedBy?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const parentFinalized =
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation
      .archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus ===
    "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_finalized"

  const reconciliationFinalizedDigestAnchoredBy =
    input.reconciliationFinalizedDigestAnchoredBy ??
    existing?.reconciliationFinalizedDigestAnchoredBy ??
    null
  const reconciliationFinalizedDigestAnchoredAt = input.reconciliationFinalizedDigestAnchoredBy
    ? now
    : (existing?.reconciliationFinalizedDigestAnchoredAt ?? null)
  const reconciliationFinalizedDigestAnchor = input.reconciliationFinalizedDigestAnchoredBy
    ? input.reconciliationFinalizedDigestAnchor?.trim() ??
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation
        .custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigest?.trim() ??
      input.note?.trim() ??
      "reconciliation finalized digest anchored for external distribution audit ledger"
    : parentFinalized && !existing?.reconciliationFinalizedDigestAnchor
      ? input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation
          .custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigest?.trim() ??
        `transport_stub:reconciliation_finalized:${input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation.id}`
      : (existing?.reconciliationFinalizedDigestAnchor ?? null)

  const externalDistributionAuditLedgerEntryRecordedBy =
    input.externalDistributionAuditLedgerEntryRecordedBy ??
    existing?.externalDistributionAuditLedgerEntryRecordedBy ??
    null
  const externalDistributionAuditLedgerEntryRecordedAt =
    input.externalDistributionAuditLedgerEntryRecordedBy ? now : (existing?.externalDistributionAuditLedgerEntryRecordedAt ?? null)
  const externalDistributionAuditLedgerEntryReference =
    input.externalDistributionAuditLedgerEntryRecordedBy
      ? input.externalDistributionAuditLedgerEntryReference?.trim() ??
        input.note?.trim() ??
        "external distribution audit ledger entry recorded"
      : (existing?.externalDistributionAuditLedgerEntryReference ?? null)

  const externalDistributionAuditLedgerFinalizedBy =
    input.externalDistributionAuditLedgerFinalizedBy ?? existing?.externalDistributionAuditLedgerFinalizedBy ?? null
  const externalDistributionAuditLedgerFinalizedAt = input.externalDistributionAuditLedgerFinalizedBy
    ? now
    : (existing?.externalDistributionAuditLedgerFinalizedAt ?? null)

  let externalDistributionAuditLedgerBacklogCount = 0
  if (!parentFinalized) {
    externalDistributionAuditLedgerBacklogCount += 1
  }
  if (parentFinalized && !reconciliationFinalizedDigestAnchoredBy && !reconciliationFinalizedDigestAnchor) {
    externalDistributionAuditLedgerBacklogCount += 1
  }
  if (reconciliationFinalizedDigestAnchoredBy && !externalDistributionAuditLedgerEntryRecordedBy) {
    externalDistributionAuditLedgerBacklogCount += 1
  }
  if (externalDistributionAuditLedgerEntryRecordedBy && !externalDistributionAuditLedgerFinalizedBy) {
    externalDistributionAuditLedgerBacklogCount += 1
  }
  if (externalDistributionAuditLedgerFinalizedBy) {
    externalDistributionAuditLedgerBacklogCount = Math.max(0, externalDistributionAuditLedgerBacklogCount - 1)
  }

  let externalDistributionAuditLedgerStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus =
    "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending"
  if (externalDistributionAuditLedgerFinalizedBy) {
    externalDistributionAuditLedgerStatus =
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_finalized"
  } else if (externalDistributionAuditLedgerEntryRecordedBy) {
    externalDistributionAuditLedgerStatus =
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_entry_recorded"
  }

  const note = input.note?.trim()
  const noteActor =
    input.externalDistributionAuditLedgerFinalizedBy ??
    input.externalDistributionAuditLedgerEntryRecordedBy ??
    input.reconciliationFinalizedDigestAnchoredBy ??
    input.actorId
  const externalDistributionAuditLedgerNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.externalDistributionAuditLedgerNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId(
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation.id
    ),
    firmId: input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation.firmId,
    matterId: input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation.matterId,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationId:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation.id,
    classification: input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation.classification,
    externalDistributionAuditLedgerStatus,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation
        .archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus,
    reconciliationFinalizedDigestAnchoredBy,
    reconciliationFinalizedDigestAnchoredAt,
    reconciliationFinalizedDigestAnchor,
    externalDistributionAuditLedgerEntryRecordedBy,
    externalDistributionAuditLedgerEntryRecordedAt,
    externalDistributionAuditLedgerEntryReference,
    externalDistributionAuditLedgerFinalizedBy,
    externalDistributionAuditLedgerFinalizedAt,
    externalTransportChannel: WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM,
    externalDistributionAuditLedgerBacklogCount,
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation
        .crossTrackExternalTransportReceiptAcknowledgmentMismatchCount,
    externalDistributionAuditLedgerNote,
    lastStatusChangedAt:
      input.reconciliationFinalizedDigestAnchoredBy ||
      input.externalDistributionAuditLedgerEntryRecordedBy ||
      input.externalDistributionAuditLedgerFinalizedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      TRANSPORT_STUB_PROVENANCE_TAG,
      `reason:${input.reason}`,
      `parent_reconciliation_finalized:${parentFinalized}`,
      ...(existing?.provenanceTags ??
        input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliation.provenanceTags.map(
          (tag) => `custody_handoff_ack_reconciliation_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow(
  input: {
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliation: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow | null
    outboundPartnerHandoffRegistry?: string | null
    outboundRegistryRegisteredBy?: string | null
    partnerHandoffAttestedBy?: string | null
    partnerHandoffReference?: string | null
    partnerHandoffAttestationFinalizedBy?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const parentFinalized =
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliation
      .closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus ===
    "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_finalized"

  const outboundPartnerHandoffRegistry =
    input.outboundPartnerHandoffRegistry?.trim() ?? existing?.outboundPartnerHandoffRegistry ?? null
  const outboundRegistryRegisteredBy =
    input.outboundRegistryRegisteredBy ?? existing?.outboundRegistryRegisteredBy ?? null
  const outboundRegistryRegisteredAt = input.outboundRegistryRegisteredBy
    ? now
    : (existing?.outboundRegistryRegisteredAt ?? null)
  const partnerHandoffAttestedBy = input.partnerHandoffAttestedBy ?? existing?.partnerHandoffAttestedBy ?? null
  const partnerHandoffAttestedAt = input.partnerHandoffAttestedBy ? now : (existing?.partnerHandoffAttestedAt ?? null)
  const partnerHandoffReference = input.partnerHandoffAttestedBy
    ? input.partnerHandoffReference?.trim() ?? input.note?.trim() ?? `${STUB_PARTNER_HANDOFF_REGISTRY_PREFIX}:attested`
    : (existing?.partnerHandoffReference ?? null)
  const partnerHandoffAttestationFinalizedBy =
    input.partnerHandoffAttestationFinalizedBy ?? existing?.partnerHandoffAttestationFinalizedBy ?? null
  const partnerHandoffAttestationFinalizedAt = input.partnerHandoffAttestationFinalizedBy
    ? now
    : (existing?.partnerHandoffAttestationFinalizedAt ?? null)

  let partnerHandoffAttestationBacklogCount = 0
  if (!parentFinalized) {
    partnerHandoffAttestationBacklogCount += 1
  }
  if (outboundRegistryRegisteredBy && !partnerHandoffAttestedBy) {
    partnerHandoffAttestationBacklogCount += 1
  }
  if (partnerHandoffAttestedBy && !partnerHandoffAttestationFinalizedBy) {
    partnerHandoffAttestationBacklogCount += 1
  }
  if (partnerHandoffAttestationFinalizedBy) {
    partnerHandoffAttestationBacklogCount = Math.max(0, partnerHandoffAttestationBacklogCount - 1)
  }

  let partnerHandoffAttestationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus =
    "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending"
  if (partnerHandoffAttestationFinalizedBy) {
    partnerHandoffAttestationStatus =
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized"
  } else if (partnerHandoffAttestedBy) {
    partnerHandoffAttestationStatus =
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attested"
  } else if (outboundRegistryRegisteredBy) {
    partnerHandoffAttestationStatus =
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_registered"
  }

  const note = input.note?.trim()
  const noteActor =
    input.partnerHandoffAttestationFinalizedBy ??
    input.partnerHandoffAttestedBy ??
    input.outboundRegistryRegisteredBy ??
    input.actorId
  const partnerHandoffAttestationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.partnerHandoffAttestationNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId(
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliation.id
    ),
    firmId: input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliation.firmId,
    matterId: input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliation.matterId,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationId:
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliation.id,
    classification: input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliation.classification,
    partnerHandoffAttestationStatus,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliation
        .closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus,
    outboundPartnerHandoffRegistry:
      outboundPartnerHandoffRegistry ??
      (outboundRegistryRegisteredBy ? STUB_PARTNER_HANDOFF_REGISTRY_PREFIX : null),
    outboundRegistryRegisteredBy,
    outboundRegistryRegisteredAt,
    partnerHandoffAttestedBy,
    partnerHandoffAttestedAt,
    partnerHandoffReference,
    partnerHandoffAttestationFinalizedBy,
    partnerHandoffAttestationFinalizedAt,
    externalTransportChannel: WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM,
    partnerHandoffAttestationBacklogCount,
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot:
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliation
        .crossTrackExternalTransportReceiptAcknowledgmentMismatchCount,
    partnerHandoffAttestationNote,
    lastStatusChangedAt:
      input.outboundRegistryRegisteredBy ||
      input.partnerHandoffAttestedBy ||
      input.partnerHandoffAttestationFinalizedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      TRANSPORT_STUB_PROVENANCE_TAG,
      `reason:${input.reason}`,
      `parent_reconciliation_finalized:${parentFinalized}`,
      ...(existing?.provenanceTags ??
        input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliation.provenanceTags.map(
          (tag) => `closure_attestation_ack_reconciliation_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
