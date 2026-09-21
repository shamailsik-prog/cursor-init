import type {
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementStatus,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationStatus,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export function workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationId(
  settlementArbitrationId: string
): string {
  return `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:${settlementArbitrationId}`
}

export function workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementId(
  queueReentryComplianceId: string
): string {
  return `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:${queueReentryComplianceId}`
}

export function isWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationStatus(
  value: string | null
): value is WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationStatus {
  return (
    value === "disposition_pending" ||
    value === "final_ruling_issued" ||
    value === "dissent_memorialized" ||
    value === "ruling_publication_checkpointed"
  )
}

export function isWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementStatus(
  value: string | null
): value is WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementStatus {
  return (
    value === "retirement_pending" ||
    value === "exception_debt_assigned" ||
    value === "debt_retirement_attested" ||
    value === "debt_aging_auto_escalated"
  )
}

export function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow(
  input: {
    settlementArbitration: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow
    existing?: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow | null
    finalRulingIssuedBy?: string | null
    finalRulingSummary?: string | null
    dissentMemorializedBy?: string | null
    dissentMemorializedNote?: string | null
    rulingPublicationCheckpointedBy?: string | null
    rulingPublicationChannel?: string | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const finalRulingIssuedBy = input.finalRulingIssuedBy ?? existing?.finalRulingIssuedBy ?? null
  const finalRulingIssuedAt = input.finalRulingIssuedBy ? now : (existing?.finalRulingIssuedAt ?? null)
  const finalRulingSummary = input.finalRulingIssuedBy
    ? input.finalRulingSummary?.trim() ?? input.note?.trim() ?? "final ruling issued"
    : (existing?.finalRulingSummary ?? null)
  const dissentMemorializedBy = input.dissentMemorializedBy ?? existing?.dissentMemorializedBy ?? null
  const dissentMemorializedAt = input.dissentMemorializedBy
    ? now
    : (existing?.dissentMemorializedAt ?? null)
  const dissentMemorializedNote = input.dissentMemorializedBy
    ? input.dissentMemorializedNote?.trim() ?? input.note?.trim() ?? "dissent memorialized"
    : (existing?.dissentMemorializedNote ?? null)
  const rulingPublicationCheckpointedBy =
    input.rulingPublicationCheckpointedBy ?? existing?.rulingPublicationCheckpointedBy ?? null
  const rulingPublicationCheckpointedAt = input.rulingPublicationCheckpointedBy
    ? now
    : (existing?.rulingPublicationCheckpointedAt ?? null)
  const rulingPublicationChannel = input.rulingPublicationCheckpointedBy
    ? input.rulingPublicationChannel?.trim() ?? input.note?.trim() ?? "internal_panel_registry"
    : (existing?.rulingPublicationChannel ?? null)
  const leadAnchorAt =
    existing?.lastStatusChangedAt ??
    input.settlementArbitration.panelConfirmationAttestedAt ??
    input.settlementArbitration.verificationOverridePetitionedAt ??
    input.settlementArbitration.lastStatusChangedAt ??
    input.settlementArbitration.updatedAt
  const rulingAgingAnchorAt = finalRulingIssuedAt ?? leadAnchorAt
  const arbitrationRulingAgingHours = Math.max(0, Math.ceil((now - rulingAgingAnchorAt) / HOUR_MS))
  let dispositionFinalizationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationStatus =
    "disposition_pending"
  if (rulingPublicationCheckpointedBy) {
    dispositionFinalizationStatus = "ruling_publication_checkpointed"
  } else if (dissentMemorializedBy) {
    dispositionFinalizationStatus = "dissent_memorialized"
  } else if (finalRulingIssuedBy) {
    dispositionFinalizationStatus = "final_ruling_issued"
  }
  const note = input.note?.trim()
  const noteActor =
    input.rulingPublicationCheckpointedBy ??
    input.dissentMemorializedBy ??
    input.finalRulingIssuedBy ??
    input.actorId
  const dispositionNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.dispositionNote ?? null)

  return {
    id: workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationId(
      input.settlementArbitration.id
    ),
    firmId: input.settlementArbitration.firmId,
    matterId: input.settlementArbitration.matterId,
    settlementArbitrationId: input.settlementArbitration.id,
    classification: input.settlementArbitration.classification,
    dispositionFinalizationStatus,
    settlementArbitrationStatusSnapshot: input.settlementArbitration.settlementArbitrationStatus,
    finalRulingIssuedBy,
    finalRulingIssuedAt,
    finalRulingSummary,
    dissentMemorializedBy,
    dissentMemorializedAt,
    dissentMemorializedNote,
    rulingPublicationCheckpointedBy,
    rulingPublicationCheckpointedAt,
    rulingPublicationChannel,
    arbitrationRulingAgingHours,
    dispositionNote,
    lastStatusChangedAt:
      input.finalRulingIssuedBy ||
      input.dissentMemorializedBy ||
      input.rulingPublicationCheckpointedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `settlement_arbitration_status:${input.settlementArbitration.settlementArbitrationStatus}`,
      ...(existing?.provenanceTags ??
        input.settlementArbitration.provenanceTags.map((tag) => `settlement_arbitration_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}

export function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow(
  input: {
    queueReentryCompliance: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow
    existing?: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow | null
    exceptionDebtAssignedBy?: string | null
    debtAssigneeId?: string | null
    debtRetirementAttestedBy?: string | null
    debtRetiredCount?: number | null
    debtAgingAutoEscalatedBy?: string | null
    debtAgingEscalationHours?: number | null
    actorId: string
    reason: string
    now?: number
    note?: string | null
  }
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const exceptionDebtAssignedBy =
    input.exceptionDebtAssignedBy ?? existing?.exceptionDebtAssignedBy ?? null
  const exceptionDebtAssignedAt = input.exceptionDebtAssignedBy
    ? now
    : (existing?.exceptionDebtAssignedAt ?? null)
  const debtAssigneeId = input.exceptionDebtAssignedBy
    ? input.debtAssigneeId ?? input.exceptionDebtAssignedBy
    : (existing?.debtAssigneeId ?? null)
  const debtRetirementAttestedBy =
    input.debtRetirementAttestedBy ?? existing?.debtRetirementAttestedBy ?? null
  const debtRetirementAttestedAt = input.debtRetirementAttestedBy
    ? now
    : (existing?.debtRetirementAttestedAt ?? null)
  const debtRetiredCount =
    input.debtRetiredCount !== undefined && input.debtRetiredCount !== null
      ? Math.max(0, Math.floor(input.debtRetiredCount))
      : (existing?.debtRetiredCount ?? 0)
  const debtAgingAutoEscalatedBy =
    input.debtAgingAutoEscalatedBy ?? existing?.debtAgingAutoEscalatedBy ?? null
  const debtAgingAutoEscalatedAt = input.debtAgingAutoEscalatedBy
    ? now
    : (existing?.debtAgingAutoEscalatedAt ?? null)
  const debtAgingEscalationHours =
    input.debtAgingEscalationHours !== undefined && input.debtAgingEscalationHours !== null
      ? input.debtAgingEscalationHours
      : (existing?.debtAgingEscalationHours ?? null)
  const queueReentryExceptionDebtCount = input.queueReentryCompliance.queueReentryExceptionDebtCount
  const queueReentryRetirementBurnCount = Math.max(
    0,
    Math.min(debtRetiredCount, queueReentryExceptionDebtCount)
  )
  let debtRetirementStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementStatus =
    "retirement_pending"
  if (debtAgingAutoEscalatedBy) {
    debtRetirementStatus = "debt_aging_auto_escalated"
  } else if (debtRetirementAttestedBy) {
    debtRetirementStatus = "debt_retirement_attested"
  } else if (exceptionDebtAssignedBy) {
    debtRetirementStatus = "exception_debt_assigned"
  }
  const note = input.note?.trim()
  const noteActor =
    input.debtAgingAutoEscalatedBy ??
    input.debtRetirementAttestedBy ??
    input.exceptionDebtAssignedBy ??
    input.actorId
  const retirementNote = note
    ? `${new Date(now).toISOString()} ${noteActor}: ${note}`
    : (existing?.retirementNote ?? null)

  return {
    id: workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementId(
      input.queueReentryCompliance.id
    ),
    firmId: input.queueReentryCompliance.firmId,
    matterId: input.queueReentryCompliance.matterId,
    queueReentryComplianceId: input.queueReentryCompliance.id,
    classification: input.queueReentryCompliance.classification,
    debtRetirementStatus,
    complianceStatusSnapshot: input.queueReentryCompliance.complianceStatus,
    exceptionDebtAssignedBy,
    exceptionDebtAssignedAt,
    debtAssigneeId,
    debtRetirementAttestedBy,
    debtRetirementAttestedAt,
    debtRetiredCount,
    debtAgingAutoEscalatedBy,
    debtAgingAutoEscalatedAt,
    debtAgingEscalationHours,
    queueReentryExceptionDebtCountSnapshot: queueReentryExceptionDebtCount,
    queueReentryRetirementBurnCount,
    retirementNote,
    lastStatusChangedAt:
      input.exceptionDebtAssignedBy ||
      input.debtRetirementAttestedBy ||
      input.debtAgingAutoEscalatedBy
        ? now
        : (existing?.lastStatusChangedAt ?? null),
    freshnessStatus: existing?.freshnessStatus ?? "fresh",
    provenanceTags: [
      `reason:${input.reason}`,
      `compliance_status:${input.queueReentryCompliance.complianceStatus}`,
      ...(existing?.provenanceTags ??
        input.queueReentryCompliance.provenanceTags.map((tag) => `queue_reentry_compliance_${tag}`)),
    ],
    recomputedAt: now,
    recomputedBy: input.actorId,
    recomputeReason: input.reason,
    updatedAt: now,
  }
}
