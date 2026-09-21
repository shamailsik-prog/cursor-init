import { buildWorkflowOpsChainedDocumentId } from "@/platform/persistence/workflowOpsChainedDocumentId"
import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationId(
  settlementAttestationId: string
): string {
  return buildWorkflowOpsChainedDocumentId(`workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration`, settlementAttestationId)
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceId(
  queueDrainReconciliationId: string
): string {
  return buildWorkflowOpsChainedDocumentId(`workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance`, queueDrainReconciliationId)
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationStatus {
  return (
    value === "arbitration_pending" ||
    value === "verification_override_petitioned" ||
    value === "panel_confirmation_attested" ||
    value === "reopen_veto_checkpointed"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceStatus {
  return (
    value === "compliance_pending" ||
    value === "reentry_exception_attested" ||
    value === "timeout_waiver_checkpointed" ||
    value === "reconciliation_resumed"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow(
  input: {
    settlementAttestation: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow | null
    verificationOverridePetitionedBy?: string | null
    panelConfirmationAttestedBy?: string | null
    reopenVetoCheckpointedBy?: string | null
    reopenVetoNote?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const verificationOverridePetitionedBy =
    input.verificationOverridePetitionedBy ?? existing?.verificationOverridePetitionedBy ?? null
  const verificationOverridePetitionedAt = input.verificationOverridePetitionedBy
    ? now
    : (existing?.verificationOverridePetitionedAt ?? null)
  const panelConfirmationAttestedBy =
    input.panelConfirmationAttestedBy ?? existing?.panelConfirmationAttestedBy ?? null
  const panelConfirmationAttestedAt = input.panelConfirmationAttestedBy
    ? now
    : (existing?.panelConfirmationAttestedAt ?? null)
  const reopenVetoCheckpointedBy =
    input.reopenVetoCheckpointedBy ?? existing?.reopenVetoCheckpointedBy ?? null
  const reopenVetoCheckpointedAt = input.reopenVetoCheckpointedBy
    ? now
    : (existing?.reopenVetoCheckpointedAt ?? null)
  const reopenVetoNote = input.reopenVetoCheckpointedBy
    ? input.reopenVetoNote?.trim() ?? input.note?.trim() ?? "reopen veto checkpoint recorded"
    : (existing?.reopenVetoNote ?? null)
  const leadAnchorAt =
    existing?.lastStatusChangedAt ??
    input.settlementAttestation.disputeReopenGuardedAt ??
    input.settlementAttestation.lockReleaseAttestedAt ??
    input.settlementAttestation.postResolutionCheckpointedAt ??
    input.settlementAttestation.updatedAt
  const settlementArbitrationLeadTimeHours = Math.max(0, Math.ceil((now - leadAnchorAt) / HOUR_MS))
  let settlementArbitrationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationStatus =
    "arbitration_pending"
  if (reopenVetoCheckpointedBy) {
    settlementArbitrationStatus = "reopen_veto_checkpointed"
  } else if (panelConfirmationAttestedBy) {
    settlementArbitrationStatus = "panel_confirmation_attested"
  } else if (verificationOverridePetitionedBy) {
    settlementArbitrationStatus = "verification_override_petitioned"
  }
  const note = input.note?.trim()
  const noteActor =
    input.reopenVetoCheckpointedBy ??
    input.panelConfirmationAttestedBy ??
    input.verificationOverridePetitionedBy ??
    input.actorId
  const arbitrationNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.arbitrationNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationId(
      input.settlementAttestation.id
    ),
    firmId: input.settlementAttestation.firmId,
    matterId: input.settlementAttestation.matterId,
    settlementAttestationId: input.settlementAttestation.id,
    classification: input.settlementAttestation.classification,
    settlementArbitrationStatus,
    settlementAttestationStatusSnapshot: input.settlementAttestation.settlementAttestationStatus,
    verificationOverridePetitionedBy,
    verificationOverridePetitionedAt,
    panelConfirmationAttestedBy,
    panelConfirmationAttestedAt,
    reopenVetoCheckpointedBy,
    reopenVetoCheckpointedAt,
    reopenVetoNote,
    settlementArbitrationLeadTimeHours,
    arbitrationNote,
    lastStatusChangedAt:
      input.verificationOverridePetitionedBy ||
      input.panelConfirmationAttestedBy ||
      input.reopenVetoCheckpointedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `settlement_attestation_status:${input.settlementAttestation.settlementAttestationStatus}`,
      ...(existing?.provenanceTags ??
        input.settlementAttestation.provenanceTags.map((tag) => `settlement_attestation_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow(
  input: {
    queueDrainReconciliation: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow | null
    reentryExceptionAttestedBy?: string | null
    timeoutWaiverCheckpointedBy?: string | null
    timeoutWaiverHours?: number | null
    reconciliationResumedBy?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const reentryExceptionAttestedBy =
    input.reentryExceptionAttestedBy ?? existing?.reentryExceptionAttestedBy ?? null
  const reentryExceptionAttestedAt = input.reentryExceptionAttestedBy
    ? now
    : (existing?.reentryExceptionAttestedAt ?? null)
  const timeoutWaiverCheckpointedBy =
    input.timeoutWaiverCheckpointedBy ?? existing?.timeoutWaiverCheckpointedBy ?? null
  const timeoutWaiverCheckpointedAt = input.timeoutWaiverCheckpointedBy
    ? now
    : (existing?.timeoutWaiverCheckpointedAt ?? null)
  const timeoutWaiverHours =
    input.timeoutWaiverHours !== undefined
      ? input.timeoutWaiverHours
      : (existing?.timeoutWaiverHours ?? null)
  const reconciliationResumedBy =
    input.reconciliationResumedBy ?? existing?.reconciliationResumedBy ?? null
  const reconciliationResumedAt = input.reconciliationResumedBy
    ? now
    : (existing?.reconciliationResumedAt ?? null)
  let queueReentryExceptionDebtCount = input.queueDrainReconciliation.drainReopenPressureCount
  if (input.queueDrainReconciliation.reconciliationStatus === "reassignment_rollback_checkpointed") {
    queueReentryExceptionDebtCount += 1
  }
  if (timeoutWaiverCheckpointedBy) {
    queueReentryExceptionDebtCount = Math.max(0, queueReentryExceptionDebtCount - 1)
  }
  if (reconciliationResumedBy) {
    queueReentryExceptionDebtCount = 0
  }
  let complianceStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceStatus =
    "compliance_pending"
  if (reconciliationResumedBy) {
    complianceStatus = "reconciliation_resumed"
  } else if (timeoutWaiverCheckpointedBy) {
    complianceStatus = "timeout_waiver_checkpointed"
  } else if (reentryExceptionAttestedBy) {
    complianceStatus = "reentry_exception_attested"
  }
  const note = input.note?.trim()
  const noteActor =
    input.reconciliationResumedBy ??
    input.timeoutWaiverCheckpointedBy ??
    input.reentryExceptionAttestedBy ??
    input.actorId
  const complianceNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.complianceNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceId(
      input.queueDrainReconciliation.id
    ),
    firmId: input.queueDrainReconciliation.firmId,
    matterId: input.queueDrainReconciliation.matterId,
    queueDrainReconciliationId: input.queueDrainReconciliation.id,
    classification: input.queueDrainReconciliation.classification,
    complianceStatus,
    reconciliationStatusSnapshot: input.queueDrainReconciliation.reconciliationStatus,
    reentryExceptionAttestedBy,
    reentryExceptionAttestedAt,
    timeoutWaiverCheckpointedBy,
    timeoutWaiverCheckpointedAt,
    timeoutWaiverHours,
    reconciliationResumedBy,
    reconciliationResumedAt,
    queueReentryExceptionDebtCount,
    complianceNote,
    lastStatusChangedAt:
      input.reentryExceptionAttestedBy ||
      input.timeoutWaiverCheckpointedBy ||
      input.reconciliationResumedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `reconciliation_status:${input.queueDrainReconciliation.reconciliationStatus}`,
      ...(existing?.provenanceTags ??
        input.queueDrainReconciliation.provenanceTags.map((tag) => `queue_reconciliation_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
