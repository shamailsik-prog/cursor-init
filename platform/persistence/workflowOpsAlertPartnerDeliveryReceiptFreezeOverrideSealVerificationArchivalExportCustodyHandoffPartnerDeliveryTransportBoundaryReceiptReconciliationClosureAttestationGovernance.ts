import { createHash } from "node:crypto"
import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow,
} from "@/platform/spine/store"

const WORKFLOW_OPS_ALERT_WAIVER_EXPIRY_DISPUTE_ADJUDICATION_SLO_DEBT_BURNDOWN_SETTLEMENT_ARBITRATION_DISPOSITION_PUBLICATION_GOVERNANCE_EXTERNAL_DISTRIBUTION_AUDIT_LEDGER_PARTNER_HANDOFF_ATTESTATION_OUTBOUND_REGISTRY_ATTESTATION_LEDGER_PARTNER_DELIVERY_RECEIPT_FREEZE_OVERRIDE_SEAL_VERIFICATION_ARCHIVAL_EXPORT_CUSTODY_HANDOFF_LOGICAL_PREFIX =
  "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff"

const WORKFLOW_OPS_ALERT_VARIANCE_REMEDIATION_SLA_BREACH_RESOLUTION_CHECKPOINT_EXPIRY_ATTESTATION_QUEUE_REENTRY_COMPLIANCE_DEBT_RETIREMENT_DISPUTE_RECONCILIATION_CLOSURE_VERIFICATION_ARCHIVAL_EXPORT_PARTNER_DELIVERY_TRANSPORT_BOUNDARY_RECEIPT_RECONCILIATION_CLOSURE_ATTESTATION_LOGICAL_PREFIX =
  "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation"

function workflowOpsAlertFirestoreDocumentIdFromLogicalKey(logicalKey: string): string {
  return createHash("sha256").update(logicalKey).digest("hex")
}

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffLogicalKey(
  partnerDeliveryReceiptFreezeOverrideSealVerificationId: string
): string {
  return `${WORKFLOW_OPS_ALERT_WAIVER_EXPIRY_DISPUTE_ADJUDICATION_SLO_DEBT_BURNDOWN_SETTLEMENT_ARBITRATION_DISPOSITION_PUBLICATION_GOVERNANCE_EXTERNAL_DISTRIBUTION_AUDIT_LEDGER_PARTNER_HANDOFF_ATTESTATION_OUTBOUND_REGISTRY_ATTESTATION_LEDGER_PARTNER_DELIVERY_RECEIPT_FREEZE_OVERRIDE_SEAL_VERIFICATION_ARCHIVAL_EXPORT_CUSTODY_HANDOFF_LOGICAL_PREFIX}:${partnerDeliveryReceiptFreezeOverrideSealVerificationId}`
}

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffId(
  partnerDeliveryReceiptFreezeOverrideSealVerificationId: string
): string {
  return workflowOpsAlertFirestoreDocumentIdFromLogicalKey(
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffLogicalKey(
      partnerDeliveryReceiptFreezeOverrideSealVerificationId
    )
  )
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationLogicalKey(
  partnerDeliveryTransportBoundaryReceiptReconciliationId: string
): string {
  return `${WORKFLOW_OPS_ALERT_VARIANCE_REMEDIATION_SLA_BREACH_RESOLUTION_CHECKPOINT_EXPIRY_ATTESTATION_QUEUE_REENTRY_COMPLIANCE_DEBT_RETIREMENT_DISPUTE_RECONCILIATION_CLOSURE_VERIFICATION_ARCHIVAL_EXPORT_PARTNER_DELIVERY_TRANSPORT_BOUNDARY_RECEIPT_RECONCILIATION_CLOSURE_ATTESTATION_LOGICAL_PREFIX}:${partnerDeliveryTransportBoundaryReceiptReconciliationId}`
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationId(
  partnerDeliveryTransportBoundaryReceiptReconciliationId: string
): string {
  return workflowOpsAlertFirestoreDocumentIdFromLogicalKey(
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationLogicalKey(
      partnerDeliveryTransportBoundaryReceiptReconciliationId
    )
  )
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffStatus {
  return (
    value === "archival_export_custody_handoff_pending" ||
    value === "archival_export_custody_handoff_checkpointed" ||
    value === "archival_export_custody_handoff_finalized"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus {
  return (
    value === "transport_boundary_receipt_reconciliation_closure_attestation_pending" ||
    value ===
      "transport_boundary_receipt_reconciliation_closure_attestation_digest_checkpointed" ||
    value === "transport_boundary_receipt_reconciliation_closure_attested"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow(
  input: {
    partnerDeliveryReceiptFreezeOverrideSealVerification: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow | null
    archivalExportCustodyHandoffCheckpointedBy?: string | null
    archivalExportCustodyHandoffReference?: string | null
    archivalExportCustodyHandedOffBy?: string | null
    archivalExportCustodyHandoffDigest?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const archivalExportCustodyHandoffCheckpointedBy =
    input.archivalExportCustodyHandoffCheckpointedBy ??
    existing?.archivalExportCustodyHandoffCheckpointedBy ??
    null
  const archivalExportCustodyHandoffCheckpointedAt = input.archivalExportCustodyHandoffCheckpointedBy
    ? now
    : (existing?.archivalExportCustodyHandoffCheckpointedAt ?? null)
  const archivalExportCustodyHandoffReference =
    input.archivalExportCustodyHandoffCheckpointedBy
      ? input.archivalExportCustodyHandoffReference?.trim() ??
        input.note?.trim() ??
        "archival export custody handoff checkpointed"
      : (existing?.archivalExportCustodyHandoffReference ?? null)
  const archivalExportCustodyHandedOffBy =
    input.archivalExportCustodyHandedOffBy ?? existing?.archivalExportCustodyHandedOffBy ?? null
  const archivalExportCustodyHandedOffAt = input.archivalExportCustodyHandedOffBy
    ? now
    : (existing?.archivalExportCustodyHandedOffAt ?? null)
  const archivalExportCustodyHandoffDigest =
    input.archivalExportCustodyHandedOffBy
      ? input.archivalExportCustodyHandoffDigest?.trim() ??
        input.note?.trim() ??
        "archival export custody handoff attested"
      : (existing?.archivalExportCustodyHandoffDigest ?? null)

  let sealVerificationCustodyBacklogCount = 0
  if (
    input.partnerDeliveryReceiptFreezeOverrideSealVerification
      .partnerDeliveryReceiptFreezeOverrideSealVerificationStatus ===
    "partner_delivery_receipt_freeze_override_seal_verified"
  ) {
    if (!archivalExportCustodyHandoffCheckpointedBy) {
      sealVerificationCustodyBacklogCount += 1
    }
    if (archivalExportCustodyHandoffCheckpointedBy && !archivalExportCustodyHandedOffBy) {
      sealVerificationCustodyBacklogCount += 1
    }
  } else {
    sealVerificationCustodyBacklogCount += 1
  }
  if (archivalExportCustodyHandedOffBy) {
    sealVerificationCustodyBacklogCount = Math.max(0, sealVerificationCustodyBacklogCount - 1)
  }

  let archivalExportCustodyHandoffStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffStatus =
    "archival_export_custody_handoff_pending"
  if (archivalExportCustodyHandedOffBy) {
    archivalExportCustodyHandoffStatus = "archival_export_custody_handoff_finalized"
  } else if (archivalExportCustodyHandoffCheckpointedBy) {
    archivalExportCustodyHandoffStatus = "archival_export_custody_handoff_checkpointed"
  }

  const note = input.note?.trim()
  const noteActor =
    input.archivalExportCustodyHandedOffBy ??
    input.archivalExportCustodyHandoffCheckpointedBy ??
    input.actorId
  const archivalExportCustodyHandoffNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.archivalExportCustodyHandoffNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffId(
      input.partnerDeliveryReceiptFreezeOverrideSealVerification.id
    ),
    firmId: input.partnerDeliveryReceiptFreezeOverrideSealVerification.firmId,
    matterId: input.partnerDeliveryReceiptFreezeOverrideSealVerification.matterId,
    partnerDeliveryReceiptFreezeOverrideSealVerificationId:
      input.partnerDeliveryReceiptFreezeOverrideSealVerification.id,
    classification: input.partnerDeliveryReceiptFreezeOverrideSealVerification.classification,
    archivalExportCustodyHandoffStatus,
    partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
      input.partnerDeliveryReceiptFreezeOverrideSealVerification
        .partnerDeliveryReceiptFreezeOverrideSealVerificationStatus,
    archivalExportCustodyHandoffCheckpointedBy,
    archivalExportCustodyHandoffCheckpointedAt,
    archivalExportCustodyHandoffReference,
    archivalExportCustodyHandedOffBy,
    archivalExportCustodyHandedOffAt,
    archivalExportCustodyHandoffDigest,
    sealVerificationCustodyBacklogCount,
    partnerDeliverySealBacklogCountSnapshot:
      input.partnerDeliveryReceiptFreezeOverrideSealVerification.partnerDeliverySealBacklogCount,
    archivalExportCustodyHandoffNote,
    lastStatusChangedAt:
      input.archivalExportCustodyHandoffCheckpointedBy || input.archivalExportCustodyHandedOffBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `partner_delivery_receipt_freeze_override_seal_verification_status:${input.partnerDeliveryReceiptFreezeOverrideSealVerification.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus}`,
      ...(existing?.provenanceTags ??
        input.partnerDeliveryReceiptFreezeOverrideSealVerification.provenanceTags.map(
          (tag) => `freeze_override_seal_verification_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow(
  input: {
    partnerDeliveryTransportBoundaryReceiptReconciliation: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow | null
    transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy?: string | null
    transportBoundaryReceiptReconciliationClosureAttestationDigest?: string | null
    transportBoundaryReceiptReconciliationClosureAttestedBy?: string | null
    transportBoundaryReceiptReconciliationClosureAttestationReference?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
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

  const reconciledAt =
    input.partnerDeliveryTransportBoundaryReceiptReconciliation
      .transportBoundaryReceiptReconciliationFinalizedAt ??
    input.partnerDeliveryTransportBoundaryReceiptReconciliation
      .archivalExportTransportBoundaryReceiptReconciledAt ??
    null
  const reconciliationClosureLagHours =
    transportBoundaryReceiptReconciliationClosureAttestedBy && reconciledAt
      ? Math.max(0, Math.floor((now - reconciledAt) / (60 * 60 * 1000)))
      : (existing?.reconciliationClosureLagHours ?? 0)

  let reconciliationClosureLagCount = reconciliationClosureLagHours > 6 ? 1 : 0
  if (
    input.partnerDeliveryTransportBoundaryReceiptReconciliation
      .partnerDeliveryTransportBoundaryReceiptReconciliationStatus ===
      "partner_delivery_transport_boundary_receipt_reconciliation_finalized" &&
    !transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy
  ) {
    reconciliationClosureLagCount = Math.max(1, reconciliationClosureLagCount)
  }
  if (transportBoundaryReceiptReconciliationClosureAttestedBy) {
    reconciliationClosureLagCount = Math.max(0, reconciliationClosureLagCount - 1)
  }

  let partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus =
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
    : (existing?.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationNote ??
      null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationId(
      input.partnerDeliveryTransportBoundaryReceiptReconciliation.id
    ),
    firmId: input.partnerDeliveryTransportBoundaryReceiptReconciliation.firmId,
    matterId: input.partnerDeliveryTransportBoundaryReceiptReconciliation.matterId,
    partnerDeliveryTransportBoundaryReceiptReconciliationId:
      input.partnerDeliveryTransportBoundaryReceiptReconciliation.id,
    classification: input.partnerDeliveryTransportBoundaryReceiptReconciliation.classification,
    partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus,
    partnerDeliveryTransportBoundaryReceiptReconciliationStatusSnapshot:
      input.partnerDeliveryTransportBoundaryReceiptReconciliation
        .partnerDeliveryTransportBoundaryReceiptReconciliationStatus,
    transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy,
    transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedAt,
    transportBoundaryReceiptReconciliationClosureAttestationDigest,
    transportBoundaryReceiptReconciliationClosureAttestedBy,
    transportBoundaryReceiptReconciliationClosureAttestedAt,
    transportBoundaryReceiptReconciliationClosureAttestationReference,
    reconciliationClosureLagHours,
    reconciliationClosureLagCount,
    archivalTransportReconciliationLagCountSnapshot:
      input.partnerDeliveryTransportBoundaryReceiptReconciliation
        .archivalTransportReconciliationLagCount,
    partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationNote,
    lastStatusChangedAt:
      input.transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy ||
      input.transportBoundaryReceiptReconciliationClosureAttestedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `partner_delivery_transport_boundary_receipt_reconciliation_status:${input.partnerDeliveryTransportBoundaryReceiptReconciliation.partnerDeliveryTransportBoundaryReceiptReconciliationStatus}`,
      ...(existing?.provenanceTags ??
        input.partnerDeliveryTransportBoundaryReceiptReconciliation.provenanceTags.map(
          (tag) => `transport_boundary_receipt_reconciliation_${tag}`
        )),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
