import { buildWorkflowOpsChainedDocumentId } from "@/platform/persistence/workflowOpsChainedDocumentId"
import { WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM } from "@/platform/persistence/workflowOpsAlertArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentClosureAttestationExternalTransportReceiptAcknowledgmentGovernance"
import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationStatus,
} from "@/platform/spine/store"

const TRANSPORT_STUB_PROVENANCE_TAG = "transport_stub:true"
const STUB_PARTNER_HANDOFF_REGISTRY_PREFIX = "blocked_todo_firm:transport_stub_partner_handoff_registry"

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationId(
  archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId: string
): string {
  return buildWorkflowOpsChainedDocumentId(
    `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation`,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId
  )
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerId(
  closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId: string
): string {
  return buildWorkflowOpsChainedDocumentId(
    `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger`,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId
  )
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationStatus {
  return (
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_pending" ||
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_outbound_registry_registered" ||
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attested" ||
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_outbound_registry_freeze_override_checkpointed"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus {
  return (
    value ===
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending" ||
    value ===
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_outbound_attestation_ledger_checkpointed" ||
    value ===
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow(
  input: {
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedger: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow | null
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
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const parentFinalized =
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedger
      .externalDistributionAuditLedgerStatus ===
    "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_finalized"

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
    ? input.partnerHandoffReference?.trim() ??
      input.note?.trim() ??
      `${STUB_PARTNER_HANDOFF_REGISTRY_PREFIX}:attested`
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

  let partnerHandoffAttestationBacklogCount = 0
  if (!parentFinalized) {
    partnerHandoffAttestationBacklogCount += 1
  }
  if (outboundRegistryRegisteredBy && !partnerHandoffAttestedBy) {
    partnerHandoffAttestationBacklogCount += 1
  }
  if (partnerHandoffAttestedBy && !outboundRegistryFreezeOverrideCheckpointedBy) {
    partnerHandoffAttestationBacklogCount += 1
  }
  if (outboundRegistryFreezeOverrideCheckpointedBy) {
    partnerHandoffAttestationBacklogCount = Math.max(0, partnerHandoffAttestationBacklogCount - 1)
  }

  let partnerHandoffAttestationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationStatus =
    "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_pending"
  if (outboundRegistryFreezeOverrideCheckpointedBy) {
    partnerHandoffAttestationStatus =
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_outbound_registry_freeze_override_checkpointed"
  } else if (partnerHandoffAttestedBy) {
    partnerHandoffAttestationStatus =
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attested"
  } else if (outboundRegistryRegisteredBy) {
    partnerHandoffAttestationStatus =
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_outbound_registry_registered"
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
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationId(
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedger.id
    ),
    firmId:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedger.firmId,
    matterId:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedger.matterId,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedger.id,
    classification:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedger.classification,
    partnerHandoffAttestationStatus,
    externalDistributionAuditLedgerStatusSnapshot:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedger
        .externalDistributionAuditLedgerStatus,
    outboundPartnerHandoffRegistry:
      outboundPartnerHandoffRegistry ??
      (outboundRegistryRegisteredBy ? STUB_PARTNER_HANDOFF_REGISTRY_PREFIX : null),
    outboundRegistryRegisteredBy,
    outboundRegistryRegisteredAt,
    partnerHandoffAttestedBy,
    partnerHandoffAttestedAt,
    partnerHandoffReference,
    outboundRegistryFreezeOverrideCheckpointedBy,
    outboundRegistryFreezeOverrideCheckpointedAt,
    outboundRegistryFreezeOverrideReason,
    externalTransportChannel: WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM,
    partnerHandoffAttestationBacklogCount,
    externalDistributionAuditLedgerBacklogCountSnapshot:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedger
        .externalDistributionAuditLedgerBacklogCount,
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedger
        .crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot,
    partnerHandoffAttestationNote,
    lastStatusChangedAt:
      input.outboundRegistryRegisteredBy ||
      input.partnerHandoffAttestedBy ||
      input.outboundRegistryFreezeOverrideCheckpointedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      TRANSPORT_STUB_PROVENANCE_TAG,
      `reason:${input.reason}`,
      `parent_audit_ledger_finalized:${parentFinalized}`,
      ...(existing?.provenanceTags ??
        input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedger.provenanceTags.map(
          (tag) => `ack_recon_audit_ledger_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow(
  input: {
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestation: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow | null
    outboundAttestationLedgerCheckpointedBy?: string | null
    outboundAttestationLedgerReference?: string | null
    partnerDeliveryReceiptFreezeOverrideDigestedBy?: string | null
    partnerDeliveryReceiptFreezeOverrideDigest?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const partnerHandoffStatus =
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestation
      .partnerHandoffAttestationStatus

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
    partnerHandoffStatus ===
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attested" ||
    partnerHandoffStatus ===
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized"
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

  let outboundRegistryAttestationLedgerStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus =
    "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending"
  if (partnerDeliveryReceiptFreezeOverrideDigestedBy) {
    outboundRegistryAttestationLedgerStatus =
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested"
  } else if (outboundAttestationLedgerCheckpointedBy) {
    outboundRegistryAttestationLedgerStatus =
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_outbound_attestation_ledger_checkpointed"
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
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerId(
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestation.id
    ),
    firmId:
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestation.firmId,
    matterId:
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestation.matterId,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestation.id,
    classification:
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestation.classification,
    outboundRegistryAttestationLedgerStatus,
    partnerHandoffAttestationStatusSnapshot: partnerHandoffStatus,
    outboundAttestationLedgerCheckpointedBy,
    outboundAttestationLedgerCheckpointedAt,
    outboundAttestationLedgerReference,
    partnerDeliveryReceiptFreezeOverrideDigestedBy,
    partnerDeliveryReceiptFreezeOverrideDigestedAt,
    partnerDeliveryReceiptFreezeOverrideDigest,
    externalTransportChannel: WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM,
    partnerDeliveryBacklogCount,
    partnerHandoffAttestationBacklogCountSnapshot:
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestation
        .partnerHandoffAttestationBacklogCount,
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot:
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestation
        .crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot,
    outboundRegistryAttestationLedgerNote,
    lastStatusChangedAt:
      input.outboundAttestationLedgerCheckpointedBy ||
      input.partnerDeliveryReceiptFreezeOverrideDigestedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      TRANSPORT_STUB_PROVENANCE_TAG,
      `reason:${input.reason}`,
      `partner_handoff_attestation_status:${partnerHandoffStatus}`,
      ...(existing?.provenanceTags ??
        input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestation.provenanceTags.map(
          (tag) => `ack_recon_partner_handoff_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
