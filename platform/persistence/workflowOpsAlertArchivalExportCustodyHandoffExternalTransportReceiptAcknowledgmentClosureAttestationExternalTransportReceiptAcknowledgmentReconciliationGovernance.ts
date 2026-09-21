import { buildWorkflowOpsChainedDocumentId } from "@/platform/persistence/workflowOpsChainedDocumentId"
import {
  WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM,
  WORKFLOW_OPS_EXTERNAL_TRANSPORT_RECEIPT_STUB_REFERENCE,
} from "@/platform/persistence/workflowOpsAlertArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentClosureAttestationExternalTransportReceiptAcknowledgmentGovernance"
import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow,
} from "@/platform/spine/store"

const TRANSPORT_STUB_PROVENANCE_TAG = "transport_stub:true"

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationId(
  archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentId: string
): string {
  return buildWorkflowOpsChainedDocumentId(
    `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation`,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentId
  )
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationId(
  closureAttestationExternalTransportReceiptAcknowledgmentId: string
): string {
  return buildWorkflowOpsChainedDocumentId(
    `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation`,
    closureAttestationExternalTransportReceiptAcknowledgmentId
  )
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus {
  return (
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_pending" ||
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_digest_checkpointed" ||
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_finalized"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus {
  return (
    value ===
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_pending" ||
    value ===
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_digest_checkpointed" ||
    value === "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_finalized"
  )
}

function externalTransportReceiptReferencesMatch(
  custodyHandoffAck: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow,
  closureAttestationAck: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow
): boolean {
  const custodyRef =
    custodyHandoffAck.externalTransportReceiptReference ??
    WORKFLOW_OPS_EXTERNAL_TRANSPORT_RECEIPT_STUB_REFERENCE
  const closureRef =
    closureAttestationAck.externalTransportReceiptReference ??
    WORKFLOW_OPS_EXTERNAL_TRANSPORT_RECEIPT_STUB_REFERENCE
  return custodyRef === closureRef
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow(
  input: {
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow
    closureAttestationExternalTransportReceiptAcknowledgment: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow | null
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy?: string | null
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigest?: string | null
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledBy?: string | null
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy =
    input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy ??
    existing?.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy ??
    null
  const custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt =
    input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy
      ? now
      : (existing?.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt ??
        null)
  const custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigest =
    input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy
      ? input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigest?.trim() ??
        input.note?.trim() ??
        "custody handoff external transport receipt acknowledgment reconciliation digest checkpointed"
      : (existing?.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigest ?? null)
  const custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledBy =
    input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledBy ??
    existing?.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledBy ??
    null
  const custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledAt =
    input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledBy
      ? now
      : (existing?.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledAt ??
        null)
  const custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy =
    input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy ??
    existing?.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy ??
    null
  const custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt =
    input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy
      ? now
      : (existing?.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt ??
        null)

  const bothAcknowledged =
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment
      .archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledged" &&
    input.closureAttestationExternalTransportReceiptAcknowledgment
      .closureAttestationExternalTransportReceiptAcknowledgmentStatus ===
      "closure_attestation_external_transport_receipt_acknowledged"
  const referencesAligned = bothAcknowledged
    ? externalTransportReceiptReferencesMatch(
        input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment,
        input.closureAttestationExternalTransportReceiptAcknowledgment
      )
    : false

  let crossTrackExternalTransportReceiptAcknowledgmentMismatchCount = 0
  if (!bothAcknowledged) {
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCount += 1
  } else if (!referencesAligned) {
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCount += 1
  }
  if (custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledBy && referencesAligned) {
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCount = Math.max(
      0,
      crossTrackExternalTransportReceiptAcknowledgmentMismatchCount - 1
    )
  }

  let archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus =
    "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_pending"
  if (custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy) {
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus =
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_finalized"
  } else if (custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy) {
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus =
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_digest_checkpointed"
  }

  const externalTransportReceiptReferenceParityDigest = bothAcknowledged
    ? referencesAligned
      ? `transport_stub:parity:${input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment.externalTransportReceiptReference ?? WORKFLOW_OPS_EXTERNAL_TRANSPORT_RECEIPT_STUB_REFERENCE}`
      : "transport_stub:parity_mismatch"
    : (existing?.externalTransportReceiptReferenceParityDigest ?? null)

  const note = input.note?.trim()
  const noteActor =
    input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy ??
    input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledBy ??
    input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy ??
    input.actorId
  const custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationId(
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment.id
    ),
    firmId: input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment.firmId,
    matterId: input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment.matterId,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentId:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment.id,
    closureAttestationExternalTransportReceiptAcknowledgmentId:
      input.closureAttestationExternalTransportReceiptAcknowledgment.id,
    classification: input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment.classification,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatusSnapshot:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment
        .archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus,
    closureAttestationExternalTransportReceiptAcknowledgmentStatusSnapshot:
      input.closureAttestationExternalTransportReceiptAcknowledgment
        .closureAttestationExternalTransportReceiptAcknowledgmentStatus,
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy,
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt,
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigest,
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledBy,
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledAt,
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy,
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt,
    externalTransportReceiptReferenceParityDigest,
    externalTransportChannel: WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM,
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCount,
    custodyHandoffExternalTransportReceiptBacklogCountSnapshot:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment
        .custodyHandoffExternalTransportReceiptBacklogCount,
    closureAttestationExternalTransportReceiptBacklogCountSnapshot:
      input.closureAttestationExternalTransportReceiptAcknowledgment
        .closureAttestationExternalTransportReceiptBacklogCount,
    custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationNote,
    lastStatusChangedAt:
      input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy ||
      input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledBy ||
      input.custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      TRANSPORT_STUB_PROVENANCE_TAG,
      `reason:${input.reason}`,
      `cross_track_references_aligned:${referencesAligned}`,
      ...(existing?.provenanceTags ??
        input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment.provenanceTags.map(
          (tag) => `custody_handoff_ack_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow(
  input: {
    closureAttestationExternalTransportReceiptAcknowledgment: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow | null
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy?: string | null
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigest?: string | null
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy?: string | null
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy =
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy ??
    existing?.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy ??
    null
  const closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt =
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy
      ? now
      : (existing?.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt ??
        null)
  const closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigest =
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy
      ? input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigest?.trim() ??
        input.note?.trim() ??
        "closure attestation external transport receipt acknowledgment reconciliation digest checkpointed"
      : (existing?.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigest ?? null)
  const closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy =
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy ??
    existing?.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy ??
    null
  const closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt =
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy
      ? now
      : (existing?.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt ??
        null)
  const closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy =
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy ??
    existing?.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy ??
    null
  const closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt =
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy
      ? now
      : (existing?.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt ??
        null)

  const bothAcknowledged =
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment
      .archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledged" &&
    input.closureAttestationExternalTransportReceiptAcknowledgment
      .closureAttestationExternalTransportReceiptAcknowledgmentStatus ===
      "closure_attestation_external_transport_receipt_acknowledged"
  const referencesAligned = bothAcknowledged
    ? externalTransportReceiptReferencesMatch(
        input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment,
        input.closureAttestationExternalTransportReceiptAcknowledgment
      )
    : false

  let crossTrackExternalTransportReceiptAcknowledgmentMismatchCount = 0
  if (!bothAcknowledged) {
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCount += 1
  } else if (!referencesAligned) {
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCount += 1
  }
  if (closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy && referencesAligned) {
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCount = Math.max(
      0,
      crossTrackExternalTransportReceiptAcknowledgmentMismatchCount - 1
    )
  }

  let closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus =
    "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_pending"
  if (closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy) {
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus =
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_finalized"
  } else if (closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy) {
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus =
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_digest_checkpointed"
  }

  const externalTransportReceiptReferenceParityDigest = bothAcknowledged
    ? referencesAligned
      ? `transport_stub:parity:${input.closureAttestationExternalTransportReceiptAcknowledgment.externalTransportReceiptReference ?? WORKFLOW_OPS_EXTERNAL_TRANSPORT_RECEIPT_STUB_REFERENCE}`
      : "transport_stub:parity_mismatch"
    : (existing?.externalTransportReceiptReferenceParityDigest ?? null)

  const note = input.note?.trim()
  const noteActor =
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy ??
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy ??
    input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy ??
    input.actorId
  const closureAttestationExternalTransportReceiptAcknowledgmentReconciliationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationId(
      input.closureAttestationExternalTransportReceiptAcknowledgment.id
    ),
    firmId: input.closureAttestationExternalTransportReceiptAcknowledgment.firmId,
    matterId: input.closureAttestationExternalTransportReceiptAcknowledgment.matterId,
    closureAttestationExternalTransportReceiptAcknowledgmentId:
      input.closureAttestationExternalTransportReceiptAcknowledgment.id,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentId:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment.id,
    classification: input.closureAttestationExternalTransportReceiptAcknowledgment.classification,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus,
    closureAttestationExternalTransportReceiptAcknowledgmentStatusSnapshot:
      input.closureAttestationExternalTransportReceiptAcknowledgment
        .closureAttestationExternalTransportReceiptAcknowledgmentStatus,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatusSnapshot:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment
        .archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigest,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt,
    externalTransportReceiptReferenceParityDigest,
    externalTransportChannel: WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM,
    crossTrackExternalTransportReceiptAcknowledgmentMismatchCount,
    closureAttestationExternalTransportReceiptBacklogCountSnapshot:
      input.closureAttestationExternalTransportReceiptAcknowledgment
        .closureAttestationExternalTransportReceiptBacklogCount,
    custodyHandoffExternalTransportReceiptBacklogCountSnapshot:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgment
        .custodyHandoffExternalTransportReceiptBacklogCount,
    closureAttestationExternalTransportReceiptAcknowledgmentReconciliationNote,
    lastStatusChangedAt:
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy ||
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy ||
      input.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      TRANSPORT_STUB_PROVENANCE_TAG,
      `reason:${input.reason}`,
      `cross_track_references_aligned:${referencesAligned}`,
      ...(existing?.provenanceTags ??
        input.closureAttestationExternalTransportReceiptAcknowledgment.provenanceTags.map(
          (tag) => `closure_attestation_ack_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
