import type {
  FilingEscalationClosureQueueDrainReconciliationRow,
  FilingEscalationClosureQueueReentryComplianceRow,
  FilingEscalationClosureQueueReentryComplianceStatus,
  FilingEscalationClosureSettlementArbitrationRow,
  FilingEscalationClosureSettlementArbitrationStatus,
  FilingEscalationClosureSettlementAttestationRow,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export function filingEscalationClosureSettlementArbitrationId(
  settlementAttestationId: string
): string {
  return `closure-settlement-arbitration:${settlementAttestationId}`
}

export function filingEscalationClosureQueueReentryComplianceId(
  queueReconciliationId: string
): string {
  return `closure-queue-reentry-compliance:${queueReconciliationId}`
}

export function isFilingEscalationClosureSettlementArbitrationStatus(
  value: string | null
): value is FilingEscalationClosureSettlementArbitrationStatus {
  return (
    value === "arbitration_pending" ||
    value === "verification_override_petitioned" ||
    value === "panel_confirmation_attested" ||
    value === "reopen_veto_checkpointed" ||
    value === "final_ruling_issued" ||
    value === "dissent_memorialized" ||
    value === "ruling_publication_checkpointed" ||
    value === "publication_correction_logged" ||
    value === "publication_rollback_checkpointed" ||
    value === "distribution_attestation_reviewed"
  )
}

export function isFilingEscalationClosureQueueReentryComplianceStatus(
  value: string | null
): value is FilingEscalationClosureQueueReentryComplianceStatus {
  return (
    value === "compliance_pending" ||
    value === "reentry_exception_attested" ||
    value === "timeout_waiver_checkpointed" ||
    value === "reconciliation_resumed" ||
    value === "exception_debt_assigned" ||
    value === "debt_retirement_attested" ||
    value === "debt_aging_auto_escalated" ||
    value === "retirement_dispute_opened" ||
    value === "retirement_dispute_resolved" ||
    value === "retirement_rollback_controlled"
  )
}

export function buildFilingEscalationClosureSettlementArbitrationRow(input: {
  settlementAttestation: FilingEscalationClosureSettlementAttestationRow
  existing?: FilingEscalationClosureSettlementArbitrationRow | null
  verificationOverridePetitionedBy?: string | null
  panelConfirmationAttestedBy?: string | null
  reopenVetoCheckpointedBy?: string | null
  reopenVetoNote?: string | null
  finalRulingIssuedBy?: string | null
  finalRulingSummary?: string | null
  dissentMemorializedBy?: string | null
  dissentMemorializedNote?: string | null
  rulingPublicationCheckpointedBy?: string | null
  rulingPublicationChannel?: string | null
  publicationCorrectionLoggedBy?: string | null
  publicationCorrectionNote?: string | null
  publicationRollbackCheckpointedBy?: string | null
  publicationRollbackReason?: string | null
  distributionAttestationReviewedBy?: string | null
  distributionAttestationDecision?: "approved" | "revision_required" | null
  now?: number
  note?: string | null
}): FilingEscalationClosureSettlementArbitrationRow {
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
  const publicationCorrectionLoggedBy =
    input.publicationCorrectionLoggedBy ?? existing?.publicationCorrectionLoggedBy ?? null
  const publicationCorrectionLoggedAt = input.publicationCorrectionLoggedBy
    ? now
    : (existing?.publicationCorrectionLoggedAt ?? null)
  const publicationCorrectionNote = input.publicationCorrectionLoggedBy
    ? input.publicationCorrectionNote?.trim() ?? input.note?.trim() ?? "publication correction logged"
    : (existing?.publicationCorrectionNote ?? null)
  const publicationRollbackCheckpointedBy =
    input.publicationRollbackCheckpointedBy ?? existing?.publicationRollbackCheckpointedBy ?? null
  const publicationRollbackCheckpointedAt = input.publicationRollbackCheckpointedBy
    ? now
    : (existing?.publicationRollbackCheckpointedAt ?? null)
  const publicationRollbackReason = input.publicationRollbackCheckpointedBy
    ? input.publicationRollbackReason?.trim() ?? input.note?.trim() ?? "publication rollback checkpointed"
    : (existing?.publicationRollbackReason ?? null)
  const distributionAttestationReviewedBy =
    input.distributionAttestationReviewedBy ?? existing?.distributionAttestationReviewedBy ?? null
  const distributionAttestationReviewedAt = input.distributionAttestationReviewedBy
    ? now
    : (existing?.distributionAttestationReviewedAt ?? null)
  const distributionAttestationDecision = input.distributionAttestationReviewedBy
    ? input.distributionAttestationDecision === "revision_required"
      ? "revision_required"
      : "approved"
    : (existing?.distributionAttestationDecision ?? null)
  const leadAnchorAt =
    existing?.lastEvaluatedAt ??
    input.settlementAttestation.disputeReopenGuardedAt ??
    input.settlementAttestation.lockReleaseAttestedAt ??
    input.settlementAttestation.postResolutionCheckpointedAt ??
    input.settlementAttestation.updatedAt
  const settlementArbitrationLeadTimeHours = Math.max(0, Math.ceil((now - leadAnchorAt) / HOUR_MS))
  const rulingAgingAnchorAt = finalRulingIssuedAt ?? leadAnchorAt
  const arbitrationRulingAgingHours = Math.max(0, Math.ceil((now - rulingAgingAnchorAt) / HOUR_MS))
  let arbitrationPublicationExceptionBacklogCount = 0
  if (publicationCorrectionLoggedBy) {
    arbitrationPublicationExceptionBacklogCount += 1
  }
  if (publicationRollbackCheckpointedBy) {
    arbitrationPublicationExceptionBacklogCount += 1
  }
  if (distributionAttestationDecision === "revision_required") {
    arbitrationPublicationExceptionBacklogCount += 1
  } else if (distributionAttestationDecision === "approved") {
    arbitrationPublicationExceptionBacklogCount = Math.max(0, arbitrationPublicationExceptionBacklogCount - 1)
  }
  let status: FilingEscalationClosureSettlementArbitrationStatus = "arbitration_pending"
  if (distributionAttestationReviewedBy) {
    status = "distribution_attestation_reviewed"
  } else if (publicationRollbackCheckpointedBy) {
    status = "publication_rollback_checkpointed"
  } else if (publicationCorrectionLoggedBy) {
    status = "publication_correction_logged"
  } else if (rulingPublicationCheckpointedBy) {
    status = "ruling_publication_checkpointed"
  } else if (dissentMemorializedBy) {
    status = "dissent_memorialized"
  } else if (finalRulingIssuedBy) {
    status = "final_ruling_issued"
  } else if (reopenVetoCheckpointedBy) {
    status = "reopen_veto_checkpointed"
  } else if (panelConfirmationAttestedBy) {
    status = "panel_confirmation_attested"
  } else if (verificationOverridePetitionedBy) {
    status = "verification_override_petitioned"
  }
  const note = input.note?.trim()
  const noteActor =
    input.distributionAttestationReviewedBy ??
    input.publicationRollbackCheckpointedBy ??
    input.publicationCorrectionLoggedBy ??
    input.rulingPublicationCheckpointedBy ??
    input.dissentMemorializedBy ??
    input.finalRulingIssuedBy ??
    input.reopenVetoCheckpointedBy ??
    input.panelConfirmationAttestedBy ??
    input.verificationOverridePetitionedBy ??
    "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureSettlementArbitrationId(input.settlementAttestation.id),
    firmId: input.settlementAttestation.firmId,
    ownerId: input.settlementAttestation.ownerId,
    queueId: input.settlementAttestation.queueId,
    adjudicationId: input.settlementAttestation.adjudicationId,
    settlementAttestationId: input.settlementAttestation.id,
    classification: input.settlementAttestation.classification,
    packageIds: input.settlementAttestation.packageIds,
    status,
    verificationOverridePetitionedBy,
    verificationOverridePetitionedAt,
    panelConfirmationAttestedBy,
    panelConfirmationAttestedAt,
    reopenVetoCheckpointedBy,
    reopenVetoCheckpointedAt,
    reopenVetoNote,
    finalRulingIssuedBy,
    finalRulingIssuedAt,
    finalRulingSummary,
    dissentMemorializedBy,
    dissentMemorializedAt,
    dissentMemorializedNote,
    rulingPublicationCheckpointedBy,
    rulingPublicationCheckpointedAt,
    rulingPublicationChannel,
    publicationCorrectionLoggedBy,
    publicationCorrectionLoggedAt,
    publicationCorrectionNote,
    publicationRollbackCheckpointedBy,
    publicationRollbackCheckpointedAt,
    publicationRollbackReason,
    distributionAttestationReviewedBy,
    distributionAttestationReviewedAt,
    distributionAttestationDecision,
    settlementArbitrationLeadTimeHours,
    arbitrationRulingAgingHours,
    arbitrationPublicationExceptionBacklogCount,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureQueueReentryComplianceRow(input: {
  queueReconciliation: FilingEscalationClosureQueueDrainReconciliationRow
  existing?: FilingEscalationClosureQueueReentryComplianceRow | null
  reentryExceptionAttestedBy?: string | null
  timeoutWaiverCheckpointedBy?: string | null
  timeoutWaiverHours?: number | null
  reconciliationResumedBy?: string | null
  exceptionDebtAssignedBy?: string | null
  debtAssigneeId?: string | null
  debtRetirementAttestedBy?: string | null
  debtRetiredCount?: number
  debtAgingAutoEscalatedBy?: string | null
  debtAgingEscalationHours?: number | null
  retirementDisputeOpenedBy?: string | null
  retirementDisputeReason?: string | null
  retirementDisputeResolvedBy?: string | null
  retirementDisputeResolution?: "uphold_retirement" | "reopen_debt" | null
  retirementRollbackControlledBy?: string | null
  retirementRollbackCount?: number
  now?: number
  note?: string | null
}): FilingEscalationClosureQueueReentryComplianceRow {
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
    input.debtRetiredCount !== undefined
      ? Math.max(0, Math.floor(input.debtRetiredCount))
      : (existing?.debtRetiredCount ?? 0)
  const debtAgingAutoEscalatedBy =
    input.debtAgingAutoEscalatedBy ?? existing?.debtAgingAutoEscalatedBy ?? null
  const debtAgingAutoEscalatedAt = input.debtAgingAutoEscalatedBy
    ? now
    : (existing?.debtAgingAutoEscalatedAt ?? null)
  const debtAgingEscalationHours =
    input.debtAgingEscalationHours !== undefined
      ? input.debtAgingEscalationHours
      : (existing?.debtAgingEscalationHours ?? null)
  const retirementDisputeOpenedBy =
    input.retirementDisputeOpenedBy ?? existing?.retirementDisputeOpenedBy ?? null
  const retirementDisputeOpenedAt = input.retirementDisputeOpenedBy
    ? now
    : (existing?.retirementDisputeOpenedAt ?? null)
  const retirementDisputeReason = input.retirementDisputeOpenedBy
    ? input.retirementDisputeReason?.trim() ?? input.note?.trim() ?? "retirement dispute opened"
    : (existing?.retirementDisputeReason ?? null)
  const retirementDisputeResolvedBy =
    input.retirementDisputeResolvedBy ?? existing?.retirementDisputeResolvedBy ?? null
  const retirementDisputeResolvedAt = input.retirementDisputeResolvedBy
    ? now
    : (existing?.retirementDisputeResolvedAt ?? null)
  const retirementDisputeResolution = input.retirementDisputeResolvedBy
    ? input.retirementDisputeResolution === "reopen_debt"
      ? "reopen_debt"
      : "uphold_retirement"
    : (existing?.retirementDisputeResolution ?? null)
  const retirementRollbackControlledBy =
    input.retirementRollbackControlledBy ?? existing?.retirementRollbackControlledBy ?? null
  const retirementRollbackControlledAt = input.retirementRollbackControlledBy
    ? now
    : (existing?.retirementRollbackControlledAt ?? null)
  const retirementRollbackCount =
    input.retirementRollbackCount !== undefined
      ? Math.max(0, Math.floor(input.retirementRollbackCount))
      : (existing?.retirementRollbackCount ?? 0)
  let queueReentryExceptionDebtCount = input.queueReconciliation.drainReopenPressureCount
  if (input.queueReconciliation.status === "reassignment_rollback_checkpointed") {
    queueReentryExceptionDebtCount += 1
  }
  if (timeoutWaiverCheckpointedBy) {
    queueReentryExceptionDebtCount = Math.max(0, queueReentryExceptionDebtCount - 1)
  }
  if (reconciliationResumedBy) {
    queueReentryExceptionDebtCount = 0
  }
  const queueReentryRetirementBurnCount = Math.max(
    0,
    Math.min(debtRetiredCount, queueReentryExceptionDebtCount)
  )
  let queueReentryRetirementReconciliationDriftCount = Math.max(
    0,
    queueReentryExceptionDebtCount - queueReentryRetirementBurnCount
  )
  if (retirementDisputeOpenedBy) {
    queueReentryRetirementReconciliationDriftCount += 1
  }
  if (retirementDisputeResolution === "reopen_debt") {
    queueReentryRetirementReconciliationDriftCount += 1
  }
  if (retirementRollbackCount > 0) {
    queueReentryRetirementReconciliationDriftCount += retirementRollbackCount
  }
  if (retirementDisputeResolution === "uphold_retirement") {
    queueReentryRetirementReconciliationDriftCount = Math.max(
      0,
      queueReentryRetirementReconciliationDriftCount - 1
    )
  }
  let status: FilingEscalationClosureQueueReentryComplianceStatus = "compliance_pending"
  if (retirementRollbackControlledBy) {
    status = "retirement_rollback_controlled"
  } else if (retirementDisputeResolvedBy) {
    status = "retirement_dispute_resolved"
  } else if (retirementDisputeOpenedBy) {
    status = "retirement_dispute_opened"
  } else if (debtAgingAutoEscalatedBy) {
    status = "debt_aging_auto_escalated"
  } else if (debtRetirementAttestedBy) {
    status = "debt_retirement_attested"
  } else if (exceptionDebtAssignedBy) {
    status = "exception_debt_assigned"
  } else if (reconciliationResumedBy) {
    status = "reconciliation_resumed"
  } else if (timeoutWaiverCheckpointedBy) {
    status = "timeout_waiver_checkpointed"
  } else if (reentryExceptionAttestedBy) {
    status = "reentry_exception_attested"
  }
  const note = input.note?.trim()
  const noteActor =
    input.retirementRollbackControlledBy ??
    input.retirementDisputeResolvedBy ??
    input.retirementDisputeOpenedBy ??
    input.debtAgingAutoEscalatedBy ??
    input.debtRetirementAttestedBy ??
    input.exceptionDebtAssignedBy ??
    input.reconciliationResumedBy ??
    input.timeoutWaiverCheckpointedBy ??
    input.reentryExceptionAttestedBy ??
    "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureQueueReentryComplianceId(input.queueReconciliation.id),
    firmId: input.queueReconciliation.firmId,
    ownerId: input.queueReconciliation.ownerId,
    queueId: input.queueReconciliation.queueId,
    rebalanceId: input.queueReconciliation.rebalanceId,
    queueReconciliationId: input.queueReconciliation.id,
    classification: input.queueReconciliation.classification,
    packageIds: input.queueReconciliation.packageIds,
    status,
    reentryExceptionAttestedBy,
    reentryExceptionAttestedAt,
    timeoutWaiverCheckpointedBy,
    timeoutWaiverCheckpointedAt,
    timeoutWaiverHours,
    reconciliationResumedBy,
    reconciliationResumedAt,
    exceptionDebtAssignedBy,
    exceptionDebtAssignedAt,
    debtAssigneeId,
    debtRetirementAttestedBy,
    debtRetirementAttestedAt,
    debtRetiredCount,
    debtAgingAutoEscalatedBy,
    debtAgingAutoEscalatedAt,
    debtAgingEscalationHours,
    retirementDisputeOpenedBy,
    retirementDisputeOpenedAt,
    retirementDisputeReason,
    retirementDisputeResolvedBy,
    retirementDisputeResolvedAt,
    retirementDisputeResolution,
    retirementRollbackControlledBy,
    retirementRollbackControlledAt,
    retirementRollbackCount,
    queueReentryExceptionDebtCount,
    queueReentryRetirementBurnCount,
    queueReentryRetirementReconciliationDriftCount,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
