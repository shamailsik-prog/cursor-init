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
    value === "reopen_veto_checkpointed"
  )
}

export function isFilingEscalationClosureQueueReentryComplianceStatus(
  value: string | null
): value is FilingEscalationClosureQueueReentryComplianceStatus {
  return (
    value === "compliance_pending" ||
    value === "reentry_exception_attested" ||
    value === "timeout_waiver_checkpointed" ||
    value === "reconciliation_resumed"
  )
}

export function buildFilingEscalationClosureSettlementArbitrationRow(input: {
  settlementAttestation: FilingEscalationClosureSettlementAttestationRow
  existing?: FilingEscalationClosureSettlementArbitrationRow | null
  verificationOverridePetitionedBy?: string | null
  panelConfirmationAttestedBy?: string | null
  reopenVetoCheckpointedBy?: string | null
  reopenVetoNote?: string | null
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
  const leadAnchorAt =
    existing?.lastEvaluatedAt ??
    input.settlementAttestation.disputeReopenGuardedAt ??
    input.settlementAttestation.lockReleaseAttestedAt ??
    input.settlementAttestation.postResolutionCheckpointedAt ??
    input.settlementAttestation.updatedAt
  const settlementArbitrationLeadTimeHours = Math.max(0, Math.ceil((now - leadAnchorAt) / HOUR_MS))
  let status: FilingEscalationClosureSettlementArbitrationStatus = "arbitration_pending"
  if (reopenVetoCheckpointedBy) {
    status = "reopen_veto_checkpointed"
  } else if (panelConfirmationAttestedBy) {
    status = "panel_confirmation_attested"
  } else if (verificationOverridePetitionedBy) {
    status = "verification_override_petitioned"
  }
  const note = input.note?.trim()
  const noteActor =
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
    settlementArbitrationLeadTimeHours,
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
  let status: FilingEscalationClosureQueueReentryComplianceStatus = "compliance_pending"
  if (reconciliationResumedBy) {
    status = "reconciliation_resumed"
  } else if (timeoutWaiverCheckpointedBy) {
    status = "timeout_waiver_checkpointed"
  } else if (reentryExceptionAttestedBy) {
    status = "reentry_exception_attested"
  }
  const note = input.note?.trim()
  const noteActor =
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
    queueReentryExceptionDebtCount,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
