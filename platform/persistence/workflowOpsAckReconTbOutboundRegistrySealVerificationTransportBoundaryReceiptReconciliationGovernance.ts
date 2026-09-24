/**
 * PR slice (continuous build after PR #221) — TB outbound-registry partner-delivery freeze-override
 * seal verification parents → transport-boundary receipt reconciliation (waiver/custody + variance/closure).
 * Mirrors PR #191-shaped builders on PR #221 dual-track seal-verification rows (GET 483–484 parents).
 */
import { buildWorkflowOpsChainedDocumentId } from "@/platform/persistence/workflowOpsChainedDocumentId"
import { WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM } from "@/platform/persistence/workflowOpsAlertArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentClosureAttestationExternalTransportReceiptAcknowledgmentGovernance"
import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationStatus,
} from "@/platform/spine/store"

const TRANSPORT_STUB_PROVENANCE_TAG = "transport_stub:true"

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId(
  partnerDeliveryReceiptFreezeOverrideSealVerificationId: string
): string {
  return buildWorkflowOpsChainedDocumentId(
    `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation`,
    partnerDeliveryReceiptFreezeOverrideSealVerificationId
  )
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId(
  partnerDeliveryReceiptFreezeOverrideSealVerificationId: string
): string {
  return buildWorkflowOpsChainedDocumentId(
    `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation`,
    partnerDeliveryReceiptFreezeOverrideSealVerificationId
  )
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationStatus {
  return (
    value === "transport_boundary_receipt_reconciliation_pending" ||
    value === "archival_export_transport_boundary_receipt_reconciled" ||
    value === "partner_delivery_transport_boundary_receipt_reconciliation_finalized"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationStatus {
  return (
    value === "transport_boundary_receipt_reconciliation_closure_attestation_pending" ||
    value ===
      "transport_boundary_receipt_reconciliation_closure_attestation_digest_checkpointed" ||
    value === "transport_boundary_receipt_reconciliation_closure_attested"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow(
  input: {
    partnerDeliveryReceiptFreezeOverrideSealVerification: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow | null
    archivalExportTransportBoundaryReceiptReconciledBy?: string | null
    archivalExportTransportBoundaryReceiptReconciliationDigest?: string | null
    transportBoundaryReceiptReconciliationFinalizedBy?: string | null
    transportBoundaryReceiptReconciliationReference?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const sealVerificationStatus =
    input.partnerDeliveryReceiptFreezeOverrideSealVerification
      .partnerDeliveryReceiptFreezeOverrideSealVerificationStatus

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

  const sealVerifiedAt =
    input.partnerDeliveryReceiptFreezeOverrideSealVerification.partnerDeliveryReceiptFreezeOverrideSealVerifiedAt ??
    null
  const archivalTransportReconciliationLagHours =
    archivalExportTransportBoundaryReceiptReconciledBy && sealVerifiedAt
      ? Math.max(0, Math.floor((now - sealVerifiedAt) / (60 * 60 * 1000)))
      : (existing?.archivalTransportReconciliationLagHours ?? 0)

  let archivalTransportReconciliationLagCount = archivalTransportReconciliationLagHours > 8 ? 1 : 0
  if (
    sealVerificationStatus === "partner_delivery_receipt_freeze_override_seal_verified" &&
    input.partnerDeliveryReceiptFreezeOverrideSealVerification.partnerDeliverySealBacklogCount === 0 &&
    !archivalExportTransportBoundaryReceiptReconciledBy
  ) {
    archivalTransportReconciliationLagCount = Math.max(1, archivalTransportReconciliationLagCount)
  } else if (
    sealVerificationStatus !== "partner_delivery_receipt_freeze_override_seal_verified" ||
    input.partnerDeliveryReceiptFreezeOverrideSealVerification.partnerDeliverySealBacklogCount > 0
  ) {
    archivalTransportReconciliationLagCount = Math.max(1, archivalTransportReconciliationLagCount)
  }
  if (transportBoundaryReceiptReconciliationFinalizedBy) {
    archivalTransportReconciliationLagCount = Math.max(0, archivalTransportReconciliationLagCount - 1)
  }

  let partnerDeliveryTransportBoundaryReceiptReconciliationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationStatus =
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
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId(
      input.partnerDeliveryReceiptFreezeOverrideSealVerification.id
    ),
    firmId: input.partnerDeliveryReceiptFreezeOverrideSealVerification.firmId,
    matterId: input.partnerDeliveryReceiptFreezeOverrideSealVerification.matterId,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
      input.partnerDeliveryReceiptFreezeOverrideSealVerification.id,
    classification: input.partnerDeliveryReceiptFreezeOverrideSealVerification.classification,
    partnerDeliveryTransportBoundaryReceiptReconciliationStatus,
    partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot: sealVerificationStatus,
    archivalExportTransportBoundaryReceiptReconciledBy,
    archivalExportTransportBoundaryReceiptReconciledAt,
    archivalExportTransportBoundaryReceiptReconciliationDigest,
    transportBoundaryReceiptReconciliationFinalizedBy,
    transportBoundaryReceiptReconciliationFinalizedAt,
    transportBoundaryReceiptReconciliationReference,
    archivalTransportReconciliationLagHours,
    archivalTransportReconciliationLagCount,
    partnerDeliverySealBacklogCountSnapshot:
      input.partnerDeliveryReceiptFreezeOverrideSealVerification.partnerDeliverySealBacklogCount,
    externalTransportChannel: WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM,
    partnerDeliveryTransportBoundaryReceiptReconciliationNote,
    lastStatusChangedAt:
      input.archivalExportTransportBoundaryReceiptReconciledBy ||
      input.transportBoundaryReceiptReconciliationFinalizedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      TRANSPORT_STUB_PROVENANCE_TAG,
      `reason:${input.reason}`,
      `partner_delivery_receipt_freeze_override_seal_verification_status:${sealVerificationStatus}`,
      ...(existing?.provenanceTags ??
        input.partnerDeliveryReceiptFreezeOverrideSealVerification.provenanceTags.map(
          (tag) => `ack_recon_tb_outbound_registry_seal_verification_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow(
  input: {
    partnerDeliveryReceiptFreezeOverrideSealVerification: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow | null
    transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy?: string | null
    transportBoundaryReceiptReconciliationClosureAttestationDigest?: string | null
    transportBoundaryReceiptReconciliationClosureAttestedBy?: string | null
    transportBoundaryReceiptReconciliationClosureAttestationReference?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const sealVerificationStatus =
    input.partnerDeliveryReceiptFreezeOverrideSealVerification
      .partnerDeliveryReceiptFreezeOverrideSealVerificationStatus

  const transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy =
    input.transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy ??
    existing?.transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy ??
    null
  const transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedAt =
    input.transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy
      ? now
      : (existing?.transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedAt ??
        null)
  const transportBoundaryReceiptReconciliationClosureAttestationDigest =
    input.transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy
      ? input.transportBoundaryReceiptReconciliationClosureAttestationDigest?.trim() ??
        input.note?.trim() ??
        "transport boundary receipt reconciliation closure attestation digest checkpointed"
      : (existing?.transportBoundaryReceiptReconciliationClosureAttestationDigest ?? null)
  const transportBoundaryReceiptReconciliationClosureAttestedBy =
    input.transportBoundaryReceiptReconciliationClosureAttestedBy ??
    existing?.transportBoundaryReceiptReconciliationClosureAttestedBy ??
    null
  const transportBoundaryReceiptReconciliationClosureAttestedAt =
    input.transportBoundaryReceiptReconciliationClosureAttestedBy
      ? now
      : (existing?.transportBoundaryReceiptReconciliationClosureAttestedAt ?? null)
  const transportBoundaryReceiptReconciliationClosureAttestationReference =
    input.transportBoundaryReceiptReconciliationClosureAttestedBy
      ? input.transportBoundaryReceiptReconciliationClosureAttestationReference?.trim() ??
        input.note?.trim() ??
        "transport boundary receipt reconciliation closure attested"
      : (existing?.transportBoundaryReceiptReconciliationClosureAttestationReference ?? null)

  const sealFinalizedAt =
    input.partnerDeliveryReceiptFreezeOverrideSealVerification
      .partnerDeliveryReceiptFreezeOverrideSealVerifiedAt ?? null
  const reconciliationClosureLagHours =
    transportBoundaryReceiptReconciliationClosureAttestedBy && sealFinalizedAt
      ? Math.max(0, Math.floor((now - sealFinalizedAt) / (60 * 60 * 1000)))
      : (existing?.reconciliationClosureLagHours ?? 0)

  let reconciliationClosureLagCount = reconciliationClosureLagHours > 6 ? 1 : 0
  if (
    sealVerificationStatus === "partner_delivery_receipt_freeze_override_seal_verified" &&
    input.partnerDeliveryReceiptFreezeOverrideSealVerification.partnerDeliverySealBacklogCount === 0 &&
    !transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy
  ) {
    reconciliationClosureLagCount = Math.max(1, reconciliationClosureLagCount)
  } else if (
    sealVerificationStatus !== "partner_delivery_receipt_freeze_override_seal_verified" ||
    input.partnerDeliveryReceiptFreezeOverrideSealVerification.partnerDeliverySealBacklogCount > 0
  ) {
    reconciliationClosureLagCount = Math.max(1, reconciliationClosureLagCount)
  }
  if (transportBoundaryReceiptReconciliationClosureAttestedBy) {
    reconciliationClosureLagCount = Math.max(0, reconciliationClosureLagCount - 1)
  }

  let partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationStatus =
    "transport_boundary_receipt_reconciliation_closure_attestation_pending"
  if (transportBoundaryReceiptReconciliationClosureAttestedBy) {
    partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus =
      "transport_boundary_receipt_reconciliation_closure_attested"
  } else if (transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy) {
    partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus =
      "transport_boundary_receipt_reconciliation_closure_attestation_digest_checkpointed"
  }

  const note = input.note?.trim()
  const noteActor =
    input.transportBoundaryReceiptReconciliationClosureAttestedBy ??
    input.transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy ??
    input.actorId
  const partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId(
      input.partnerDeliveryReceiptFreezeOverrideSealVerification.id
    ),
    firmId: input.partnerDeliveryReceiptFreezeOverrideSealVerification.firmId,
    matterId: input.partnerDeliveryReceiptFreezeOverrideSealVerification.matterId,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
      input.partnerDeliveryReceiptFreezeOverrideSealVerification.id,
    classification: input.partnerDeliveryReceiptFreezeOverrideSealVerification.classification,
    partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus,
    partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot: sealVerificationStatus,
    transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy,
    transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedAt,
    transportBoundaryReceiptReconciliationClosureAttestationDigest,
    transportBoundaryReceiptReconciliationClosureAttestedBy,
    transportBoundaryReceiptReconciliationClosureAttestedAt,
    transportBoundaryReceiptReconciliationClosureAttestationReference,
    reconciliationClosureLagHours,
    reconciliationClosureLagCount,
    partnerDeliverySealBacklogCountSnapshot:
      input.partnerDeliveryReceiptFreezeOverrideSealVerification.partnerDeliverySealBacklogCount,
    externalTransportChannel: WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM,
    partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationNote,
    lastStatusChangedAt:
      input.transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy ||
      input.transportBoundaryReceiptReconciliationClosureAttestedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      TRANSPORT_STUB_PROVENANCE_TAG,
      `reason:${input.reason}`,
      `partner_delivery_receipt_freeze_override_seal_verification_status:${sealVerificationStatus}`,
      ...(existing?.provenanceTags ??
        input.partnerDeliveryReceiptFreezeOverrideSealVerification.provenanceTags.map(
          (tag) => `ack_recon_tb_outbound_registry_seal_verification_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
