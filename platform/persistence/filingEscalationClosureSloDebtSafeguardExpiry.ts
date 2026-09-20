import type {
  FilingEscalationClosureAdjudicationSloDebtRemediationRow,
  FilingEscalationClosureAdjudicationSloDebtRemediationStatus,
  FilingEscalationClosureAdjudicationSloEscalationTier,
  FilingEscalationClosureAdjudicationSloRow,
  FilingEscalationClosureRebalanceSafeguardExpiryRow,
  FilingEscalationClosureRebalanceSafeguardExpiryStatus,
  FilingEscalationClosureRebalanceSafeguardRow,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export function filingEscalationClosureAdjudicationSloDebtRemediationId(
  adjudicationSloId: string
): string {
  return `closure-adjudication-slo-debt-remediation:${adjudicationSloId}`
}

export function filingEscalationClosureRebalanceSafeguardExpiryId(safeguardId: string): string {
  return `closure-rebalance-safeguard-expiry:${safeguardId}`
}

export function isFilingEscalationClosureAdjudicationSloDebtRemediationStatus(
  value: string | null
): value is FilingEscalationClosureAdjudicationSloDebtRemediationStatus {
  return (
    value === "debt_open" ||
    value === "debt_retirement_pending" ||
    value === "debt_retired" ||
    value === "breach_closure_attested"
  )
}

export function isFilingEscalationClosureRebalanceSafeguardExpiryStatus(
  value: string | null
): value is FilingEscalationClosureRebalanceSafeguardExpiryStatus {
  return (
    value === "expiry_pending" ||
    value === "auto_cleared" ||
    value === "override_expired" ||
    value === "stale_lock_cleaned"
  )
}

function escalationTierRank(tier: FilingEscalationClosureAdjudicationSloEscalationTier): number {
  if (tier === "none") return 0
  if (tier === "tier_1_partner_watch") return 1
  if (tier === "tier_2_management_escalation") return 2
  return 3
}

export function buildFilingEscalationClosureAdjudicationSloDebtRemediationRow(input: {
  slo: FilingEscalationClosureAdjudicationSloRow
  existing?: FilingEscalationClosureAdjudicationSloDebtRemediationRow | null
  retirementNotedBy?: string | null
  tierDownshiftedTo?: FilingEscalationClosureAdjudicationSloEscalationTier | null
  tierDownshiftedBy?: string | null
  breachClosureAttestedBy?: string | null
  now?: number
  note?: string | null
}): FilingEscalationClosureAdjudicationSloDebtRemediationRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const debtAgeHours = Math.max(0, Math.floor(input.slo.breachDebtHours))
  const priorRetiredHours = existing?.debtRetiredHours ?? 0
  const debtRetiredHours =
    input.retirementNotedBy || (existing?.retirementNotedAt && debtAgeHours === 0)
      ? Math.max(priorRetiredHours, debtAgeHours)
      : priorRetiredHours
  const retirementNotedBy = input.retirementNotedBy ?? existing?.retirementNotedBy ?? null
  const retirementNotedAt =
    input.retirementNotedBy || (retirementNotedBy && debtAgeHours === 0)
      ? now
      : (existing?.retirementNotedAt ?? null)
  const tierDownshiftedTo =
    input.tierDownshiftedTo ??
    existing?.tierDownshiftedTo ??
    null
  const tierDownshiftedBy = input.tierDownshiftedBy ?? existing?.tierDownshiftedBy ?? null
  const tierDownshiftedAt = input.tierDownshiftedBy
    ? now
    : (existing?.tierDownshiftedAt ?? null)
  const breachClosureAttestedBy =
    input.breachClosureAttestedBy ?? existing?.breachClosureAttestedBy ?? null
  const breachClosureAttestedAt = input.breachClosureAttestedBy
    ? now
    : (existing?.breachClosureAttestedAt ?? null)
  let status: FilingEscalationClosureAdjudicationSloDebtRemediationStatus
  if (breachClosureAttestedBy) {
    status = "breach_closure_attested"
  } else if (debtAgeHours > 0) {
    status = retirementNotedBy ? "debt_retirement_pending" : "debt_open"
  } else if (retirementNotedBy || input.slo.status === "within_slo") {
    status = "debt_retired"
  } else {
    status = "debt_open"
  }
  const note = input.note?.trim()
  const noteActor =
    input.breachClosureAttestedBy ??
    input.tierDownshiftedBy ??
    input.retirementNotedBy ??
    "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureAdjudicationSloDebtRemediationId(input.slo.id),
    firmId: input.slo.firmId,
    ownerId: input.slo.ownerId,
    queueId: input.slo.queueId,
    adjudicationId: input.slo.adjudicationId,
    adjudicationSloId: input.slo.id,
    classification: input.slo.classification,
    packageIds: input.slo.packageIds,
    status,
    debtAgeHours,
    debtRetiredHours,
    retirementNotedBy,
    retirementNotedAt,
    tierDownshiftedTo,
    tierDownshiftedBy,
    tierDownshiftedAt,
    breachClosureAttestedBy,
    breachClosureAttestedAt,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function canDownshiftClosureAdjudicationSloTier(input: {
  currentTier: FilingEscalationClosureAdjudicationSloEscalationTier
  nextTier: FilingEscalationClosureAdjudicationSloEscalationTier
}): boolean {
  return escalationTierRank(input.nextTier) <= escalationTierRank(input.currentTier)
}

export function buildFilingEscalationClosureRebalanceSafeguardExpiryRow(input: {
  safeguard: FilingEscalationClosureRebalanceSafeguardRow
  existing?: FilingEscalationClosureRebalanceSafeguardExpiryRow | null
  overrideExpiryHours?: number | null
  staleLockCleanedBy?: string | null
  clearSuppression?: boolean
  now?: number
  note?: string | null
}): FilingEscalationClosureRebalanceSafeguardExpiryRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const suppressionExpiresAt = input.clearSuppression
    ? now
    : Math.max(
        input.safeguard.cooldownLockUntil ?? 0,
        input.safeguard.duplicateSuppressionUntil ?? 0
      ) || null
  const overrideExpiresAt =
    input.overrideExpiryHours !== undefined && input.overrideExpiryHours !== null
      ? (input.overrideExpiryHours > 0 ? now + Math.floor(input.overrideExpiryHours * HOUR_MS) : now)
      : (existing?.overrideExpiresAt ?? null)
  const staleLockCleanedBy = input.staleLockCleanedBy ?? existing?.staleLockCleanedBy ?? null
  const staleLockCleanedAt = input.staleLockCleanedBy ? now : (existing?.staleLockCleanedAt ?? null)
  const autoClearedAt =
    suppressionExpiresAt !== null && suppressionExpiresAt <= now
      ? (existing?.autoClearedAt ?? now)
      : (existing?.autoClearedAt ?? null)
  const expiryDebtHours =
    suppressionExpiresAt !== null && suppressionExpiresAt < now
      ? Math.ceil((now - suppressionExpiresAt) / HOUR_MS)
      : 0
  let status: FilingEscalationClosureRebalanceSafeguardExpiryStatus = "expiry_pending"
  if (staleLockCleanedBy) {
    status = "stale_lock_cleaned"
  } else if (overrideExpiresAt !== null && overrideExpiresAt <= now) {
    status = "override_expired"
  } else if (suppressionExpiresAt !== null && suppressionExpiresAt <= now) {
    status = "auto_cleared"
  }
  const note = input.note?.trim()
  const noteActor = input.staleLockCleanedBy ?? input.safeguard.overrideAttestedBy ?? "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureRebalanceSafeguardExpiryId(input.safeguard.id),
    firmId: input.safeguard.firmId,
    ownerId: input.safeguard.ownerId,
    queueId: input.safeguard.queueId,
    rebalanceId: input.safeguard.rebalanceId,
    safeguardId: input.safeguard.id,
    classification: input.safeguard.classification,
    packageIds: input.safeguard.packageIds,
    status,
    suppressionExpiresAt,
    overrideExpiresAt,
    autoClearedAt,
    staleLockCleanedBy,
    staleLockCleanedAt,
    expiryDebtHours,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
