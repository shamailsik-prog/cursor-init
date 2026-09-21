import { buildWorkflowOpsChainedDocumentId } from "@/platform/persistence/workflowOpsChainedDocumentId"
import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentStatus,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow,
} from "@/platform/spine/store"

export const WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM =
  "blocked_todo_firm" as const

export const WORKFLOW_OPS_EXTERNAL_TRANSPORT_RECEIPT_STUB_REFERENCE =
  "blocked_todo_firm:transport_stub_external_receipt_acknowledgment"

const TRANSPORT_STUB_PROVENANCE_TAG = "transport_stub:true"

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentId(
  archivalExportCustodyHandoffId: string
): string {
  return buildWorkflowOpsChainedDocumentId(
    `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment`,
    archivalExportCustodyHandoffId
  )
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentId(
  partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationId: string
): string {
  return buildWorkflowOpsChainedDocumentId(
    `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment`,
    partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationId
  )
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus {
  return (
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_pending" ||
    value ===
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_checkpointed" ||
    value === "archival_export_custody_handoff_external_transport_receipt_acknowledged"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentStatus {
  return (
    value === "closure_attestation_external_transport_receipt_acknowledgment_pending" ||
    value ===
      "closure_attestation_external_transport_receipt_acknowledgment_digest_checkpointed" ||
    value === "closure_attestation_external_transport_receipt_acknowledged"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow(
  input: {
    archivalExportCustodyHandoff: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow | null
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy?: string | null
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointReference?: string | null
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy?: string | null
    externalTransportReceiptReference?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy =
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy ??
    existing?.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy ??
    null
  const archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedAt =
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy
      ? now
      : (existing?.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedAt ??
        null)
  const archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointReference =
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy
      ? input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointReference?.trim() ??
        input.note?.trim() ??
        "archival export custody handoff external transport receipt acknowledgment checkpointed"
      : (existing?.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointReference ??
        null)
  const archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy =
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy ??
    existing?.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy ??
    null
  const archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedAt =
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy
      ? now
      : (existing?.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedAt ?? null)
  const externalTransportReceiptReference =
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy
      ? input.externalTransportReceiptReference?.trim() ??
        WORKFLOW_OPS_EXTERNAL_TRANSPORT_RECEIPT_STUB_REFERENCE
      : (existing?.externalTransportReceiptReference ?? null)

  let custodyHandoffExternalTransportReceiptBacklogCount = 0
  if (
    input.archivalExportCustodyHandoff.archivalExportCustodyHandoffStatus !==
    "archival_export_custody_handoff_finalized"
  ) {
    custodyHandoffExternalTransportReceiptBacklogCount += 1
  } else if (!archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy) {
    custodyHandoffExternalTransportReceiptBacklogCount += 1
  } else if (!archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy) {
    custodyHandoffExternalTransportReceiptBacklogCount += 1
  }
  if (archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy) {
    custodyHandoffExternalTransportReceiptBacklogCount = Math.max(
      0,
      custodyHandoffExternalTransportReceiptBacklogCount - 1
    )
  }

  let archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus =
    "archival_export_custody_handoff_external_transport_receipt_acknowledgment_pending"
  if (archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy) {
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus =
      "archival_export_custody_handoff_external_transport_receipt_acknowledged"
  } else if (archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy) {
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus =
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_checkpointed"
  }

  const note = input.note?.trim()
  const noteActor =
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy ??
    input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy ??
    input.actorId
  const archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentId(
      input.archivalExportCustodyHandoff.id
    ),
    firmId: input.archivalExportCustodyHandoff.firmId,
    matterId: input.archivalExportCustodyHandoff.matterId,
    archivalExportCustodyHandoffId: input.archivalExportCustodyHandoff.id,
    classification: input.archivalExportCustodyHandoff.classification,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus,
    archivalExportCustodyHandoffStatusSnapshot:
      input.archivalExportCustodyHandoff.archivalExportCustodyHandoffStatus,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedAt,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointReference,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedAt,
    externalTransportReceiptReference,
    externalTransportChannel: WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM,
    custodyHandoffExternalTransportReceiptBacklogCount,
    sealVerificationCustodyBacklogCountSnapshot:
      input.archivalExportCustodyHandoff.sealVerificationCustodyBacklogCount,
    archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentNote,
    lastStatusChangedAt:
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy ||
      input.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      TRANSPORT_STUB_PROVENANCE_TAG,
      `reason:${input.reason}`,
      `archival_export_custody_handoff_status:${input.archivalExportCustodyHandoff.archivalExportCustodyHandoffStatus}`,
      ...(existing?.provenanceTags ??
        input.archivalExportCustodyHandoff.provenanceTags.map(
          (tag) => `archival_export_custody_handoff_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow(
  input: {
    partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestation: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow | null
    closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy?: string | null
    closureAttestationExternalTransportReceiptAcknowledgmentDigest?: string | null
    closureAttestationExternalTransportReceiptAcknowledgedBy?: string | null
    externalTransportReceiptReference?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy =
    input.closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy ??
    existing?.closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy ??
    null
  const closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedAt =
    input.closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy
      ? now
      : (existing?.closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedAt ??
        null)
  const closureAttestationExternalTransportReceiptAcknowledgmentDigest =
    input.closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy
      ? input.closureAttestationExternalTransportReceiptAcknowledgmentDigest?.trim() ??
        input.note?.trim() ??
        "closure attestation external transport receipt acknowledgment digest checkpointed"
      : (existing?.closureAttestationExternalTransportReceiptAcknowledgmentDigest ?? null)
  const closureAttestationExternalTransportReceiptAcknowledgedBy =
    input.closureAttestationExternalTransportReceiptAcknowledgedBy ??
    existing?.closureAttestationExternalTransportReceiptAcknowledgedBy ??
    null
  const closureAttestationExternalTransportReceiptAcknowledgedAt =
    input.closureAttestationExternalTransportReceiptAcknowledgedBy
      ? now
      : (existing?.closureAttestationExternalTransportReceiptAcknowledgedAt ?? null)
  const externalTransportReceiptReference =
    input.closureAttestationExternalTransportReceiptAcknowledgedBy
      ? input.externalTransportReceiptReference?.trim() ??
        WORKFLOW_OPS_EXTERNAL_TRANSPORT_RECEIPT_STUB_REFERENCE
      : (existing?.externalTransportReceiptReference ?? null)

  let closureAttestationExternalTransportReceiptBacklogCount = 0
  if (
    input.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestation
      .partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus !==
    "transport_boundary_receipt_reconciliation_closure_attested"
  ) {
    closureAttestationExternalTransportReceiptBacklogCount += 1
  } else if (!closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy) {
    closureAttestationExternalTransportReceiptBacklogCount += 1
  } else if (!closureAttestationExternalTransportReceiptAcknowledgedBy) {
    closureAttestationExternalTransportReceiptBacklogCount += 1
  }
  if (closureAttestationExternalTransportReceiptAcknowledgedBy) {
    closureAttestationExternalTransportReceiptBacklogCount = Math.max(
      0,
      closureAttestationExternalTransportReceiptBacklogCount - 1
    )
  }

  let closureAttestationExternalTransportReceiptAcknowledgmentStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentStatus =
    "closure_attestation_external_transport_receipt_acknowledgment_pending"
  if (closureAttestationExternalTransportReceiptAcknowledgedBy) {
    closureAttestationExternalTransportReceiptAcknowledgmentStatus =
      "closure_attestation_external_transport_receipt_acknowledged"
  } else if (closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy) {
    closureAttestationExternalTransportReceiptAcknowledgmentStatus =
      "closure_attestation_external_transport_receipt_acknowledgment_digest_checkpointed"
  }

  const note = input.note?.trim()
  const noteActor =
    input.closureAttestationExternalTransportReceiptAcknowledgedBy ??
    input.closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy ??
    input.actorId
  const closureAttestationExternalTransportReceiptAcknowledgmentNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.closureAttestationExternalTransportReceiptAcknowledgmentNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentId(
      input.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestation.id
    ),
    firmId: input.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestation.firmId,
    matterId: input.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestation.matterId,
    partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationId:
      input.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestation.id,
    classification:
      input.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestation.classification,
    closureAttestationExternalTransportReceiptAcknowledgmentStatus,
    partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatusSnapshot:
      input.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestation
        .partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus,
    closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy,
    closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedAt,
    closureAttestationExternalTransportReceiptAcknowledgmentDigest,
    closureAttestationExternalTransportReceiptAcknowledgedBy,
    closureAttestationExternalTransportReceiptAcknowledgedAt,
    externalTransportReceiptReference,
    externalTransportChannel: WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM,
    closureAttestationExternalTransportReceiptBacklogCount,
    reconciliationClosureLagCountSnapshot:
      input.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestation
        .reconciliationClosureLagCount,
    closureAttestationExternalTransportReceiptAcknowledgmentNote,
    lastStatusChangedAt:
      input.closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy ||
      input.closureAttestationExternalTransportReceiptAcknowledgedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      TRANSPORT_STUB_PROVENANCE_TAG,
      `reason:${input.reason}`,
      `partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_status:${input.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestation.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus}`,
      ...(existing?.provenanceTags ??
        input.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestation.provenanceTags.map(
          (tag) => `closure_attestation_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
