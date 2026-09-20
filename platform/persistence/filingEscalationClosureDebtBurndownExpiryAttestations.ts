import type {
  FilingEscalationClosureAdjudicationDebtBurndownRow,
  FilingEscalationClosureAdjudicationDebtBurndownStatus,
  FilingEscalationClosureAdjudicationSloDebtRemediationRow,
  FilingEscalationClosureAdjudicationSloEscalationTier,
  FilingEscalationClosureRebalanceSafeguardExpiryRow,
  FilingEscalationClosureSafeguardExpiryAttestationRow,
  FilingEscalationClosureSafeguardExpiryAttestationStatus,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export function filingEscalationClosureAdjudicationDebtBurndownId(remediationId: string): string {
  return `closure-adjudication-debt-burndown:${remediationId}`
}

export function filingEscalationClosureSafeguardExpiryAttestationId(expiryId: string): string {
  return `closure-safeguard-expiry-attestation:${expiryId}`
}

export function isFilingEscalationClosureAdjudicationDebtBurndownStatus(
  value: string | null
): value is FilingEscalationClosureAdjudicationDebtBurndownStatus {
  return (
    value === "burndown_tracking" ||
    value === "burndown_checkpoint_due" ||
    value === "burndown_attested" ||
    value === "burndown_forecast_breached"
  )
}

export function isFilingEscalationClosureSafeguardExpiryAttestationStatus(
  value: string | null
): value is FilingEscalationClosureSafeguardExpiryAttestationStatus {
  return (
    value === "attestation_open" ||
    value === "attestation_acknowledged" ||
    value === "attestation_overdue" ||
    value === "attestation_reconciled"
  )
}

export function buildFilingEscalationClosureAdjudicationDebtBurndownRow(input: {
  remediation: FilingEscalationClosureAdjudicationSloDebtRemediationRow
  existing?: FilingEscalationClosureAdjudicationDebtBurndownRow | null
  retirementTargetHours?: number | null
  backlogAttestedBy?: string | null
  tierNormalizedBy?: string | null
  tierNormalizedTo?: FilingEscalationClosureAdjudicationSloEscalationTier | null
  now?: number
  note?: string | null
}): FilingEscalationClosureAdjudicationDebtBurndownRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const retirementTargetAt =
    input.retirementTargetHours !== undefined && input.retirementTargetHours !== null
      ? (input.retirementTargetHours > 0 ? now + Math.floor(input.retirementTargetHours * HOUR_MS) : now)
      : (existing?.retirementTargetAt ?? null)
  const checkpointAt = retirementTargetAt
  const backlogAttestedBy = input.backlogAttestedBy ?? existing?.backlogAttestedBy ?? null
  const backlogAttestedAt = input.backlogAttestedBy ? now : (existing?.backlogAttestedAt ?? null)
  const tierNormalizedBy = input.tierNormalizedBy ?? existing?.tierNormalizedBy ?? null
  const tierNormalizedAt = input.tierNormalizedBy ? now : (existing?.tierNormalizedAt ?? null)
  const tierNormalizedTo = input.tierNormalizedTo ?? existing?.tierNormalizedTo ?? null
  const debtNow = Math.max(0, input.remediation.debtAgeHours)
  const priorDebt = existing?.projectedBurndownHours ?? debtNow
  const elapsedHours = Math.max(1, (now - (existing?.lastEvaluatedAt ?? now)) / HOUR_MS)
  const debtDelta = Math.max(0, priorDebt - debtNow)
  const observedVelocityPerDay = (debtDelta / elapsedHours) * 24
  const debtVelocityPerDay =
    observedVelocityPerDay > 0
      ? observedVelocityPerDay
      : (existing?.debtVelocityPerDay ?? 0)
  const forecastBreachHours =
    retirementTargetAt && debtNow > 0 && now > retirementTargetAt
      ? Math.ceil((now - retirementTargetAt) / HOUR_MS)
      : 0
  let status: FilingEscalationClosureAdjudicationDebtBurndownStatus = "burndown_tracking"
  if (forecastBreachHours > 0) {
    status = "burndown_forecast_breached"
  } else if (checkpointAt && debtNow > 0 && now >= checkpointAt) {
    status = "burndown_checkpoint_due"
  } else if (
    backlogAttestedBy &&
    (tierNormalizedBy ||
      input.remediation.status === "debt_retired" ||
      input.remediation.status === "breach_closure_attested")
  ) {
    status = "burndown_attested"
  }
  const note = input.note?.trim()
  const noteActor = input.tierNormalizedBy ?? input.backlogAttestedBy ?? "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureAdjudicationDebtBurndownId(input.remediation.id),
    firmId: input.remediation.firmId,
    ownerId: input.remediation.ownerId,
    queueId: input.remediation.queueId,
    adjudicationId: input.remediation.adjudicationId,
    remediationId: input.remediation.id,
    classification: input.remediation.classification,
    packageIds: input.remediation.packageIds,
    status,
    retirementTargetAt,
    checkpointAt,
    backlogAttestedBy,
    backlogAttestedAt,
    tierNormalizedBy,
    tierNormalizedAt,
    tierNormalizedTo,
    debtVelocityPerDay,
    projectedBurndownHours: debtNow,
    forecastBreachHours,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureSafeguardExpiryAttestationRow(input: {
  expiry: FilingEscalationClosureRebalanceSafeguardExpiryRow
  existing?: FilingEscalationClosureSafeguardExpiryAttestationRow | null
  acknowledgedBy?: string | null
  queueOverdueExceptionBy?: string | null
  reconcileOverrideBy?: string | null
  reconciliationNote?: string | null
  now?: number
  note?: string | null
}): FilingEscalationClosureSafeguardExpiryAttestationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const acknowledgedBy = input.acknowledgedBy ?? existing?.acknowledgedBy ?? null
  const acknowledgedAt = input.acknowledgedBy ? now : (existing?.acknowledgedAt ?? null)
  const overdueExceptionQueuedBy =
    input.queueOverdueExceptionBy ?? existing?.overdueExceptionQueuedBy ?? null
  const overdueExceptionQueuedAt = input.queueOverdueExceptionBy
    ? now
    : (existing?.overdueExceptionQueuedAt ?? null)
  const overrideReconciledBy = input.reconcileOverrideBy ?? existing?.overrideReconciledBy ?? null
  const overrideReconciledAt = input.reconcileOverrideBy
    ? now
    : (existing?.overrideReconciledAt ?? null)
  const latestReconciliationNote = input.reconcileOverrideBy
    ? input.reconciliationNote?.trim() ?? input.note?.trim() ?? "override reconciliation captured"
    : (existing?.latestReconciliationNote ?? null)
  const openBacklogHours = Math.max(
    0,
    input.expiry.expiryDebtHours + (input.expiry.status === "override_expired" ? 1 : 0)
  )
  let status: FilingEscalationClosureSafeguardExpiryAttestationStatus = "attestation_open"
  if (overrideReconciledBy) {
    status = "attestation_reconciled"
  } else if (openBacklogHours > 0 && (overdueExceptionQueuedBy || openBacklogHours >= 2)) {
    status = "attestation_overdue"
  } else if (acknowledgedBy) {
    status = "attestation_acknowledged"
  }
  const note = input.note?.trim()
  const noteActor =
    input.reconcileOverrideBy ?? input.queueOverdueExceptionBy ?? input.acknowledgedBy ?? "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureSafeguardExpiryAttestationId(input.expiry.id),
    firmId: input.expiry.firmId,
    ownerId: input.expiry.ownerId,
    queueId: input.expiry.queueId,
    rebalanceId: input.expiry.rebalanceId,
    expiryId: input.expiry.id,
    classification: input.expiry.classification,
    packageIds: input.expiry.packageIds,
    status,
    acknowledgedBy,
    acknowledgedAt,
    overdueExceptionQueuedBy,
    overdueExceptionQueuedAt,
    overrideReconciledBy,
    overrideReconciledAt,
    latestReconciliationNote,
    openBacklogHours,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
