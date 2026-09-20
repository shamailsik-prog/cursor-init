import type {
  FilingEscalationClosureAdjudicationQueueRow,
  FilingEscalationClosureAdjudicationQuorumRow,
  FilingEscalationClosureAdjudicationSloEscalationTier,
  FilingEscalationClosureAdjudicationSloRow,
  FilingEscalationClosureAdjudicationSloStatus,
  FilingEscalationClosureEnforcementRebalanceRow,
  FilingEscalationClosureFollowupQueueRow,
  FilingEscalationClosureRebalanceExecutionRow,
  FilingEscalationClosureRebalanceSafeguardRow,
  FilingEscalationClosureRebalanceSafeguardStatus,
  FilingEscalationClosureRebalanceSuppressionReason,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_REBALANCE_SUPPRESSION_HOURS = 4

export function filingEscalationClosureAdjudicationSloId(adjudicationId: string): string {
  return `closure-adjudication-slo:${adjudicationId}`
}

export function filingEscalationClosureRebalanceSafeguardId(rebalanceId: string): string {
  return `closure-rebalance-safeguard:${rebalanceId}`
}

export function isFilingEscalationClosureAdjudicationSloStatus(
  value: string | null
): value is FilingEscalationClosureAdjudicationSloStatus {
  return (
    value === "within_slo" ||
    value === "deadline_extended" ||
    value === "breach_open" ||
    value === "breach_acknowledged"
  )
}

export function isFilingEscalationClosureRebalanceSafeguardStatus(
  value: string | null
): value is FilingEscalationClosureRebalanceSafeguardStatus {
  return (
    value === "auto_exec_ready" ||
    value === "cooldown_locked" ||
    value === "duplicate_suppressed" ||
    value === "override_attested"
  )
}

export function isFilingEscalationClosureAdjudicationSloEscalationTier(
  value: string | null
): value is FilingEscalationClosureAdjudicationSloEscalationTier {
  return (
    value === "none" ||
    value === "tier_1_partner_watch" ||
    value === "tier_2_management_escalation" ||
    value === "tier_3_executive_escalation"
  )
}

export function isFilingEscalationClosureRebalanceSuppressionReason(
  value: string | null
): value is FilingEscalationClosureRebalanceSuppressionReason {
  return (
    value === "cooldown_lockout_active" ||
    value === "duplicate_execution_window" ||
    value === "manual_override_required"
  )
}

export function buildFilingEscalationClosureAdjudicationSloRow(input: {
  adjudication: FilingEscalationClosureAdjudicationQueueRow
  queue: FilingEscalationClosureFollowupQueueRow
  quorum: FilingEscalationClosureAdjudicationQuorumRow | null
  existing?: FilingEscalationClosureAdjudicationSloRow | null
  extensionHours?: number | null
  extensionApprovedBy?: string | null
  escalationTierOverride?: FilingEscalationClosureAdjudicationSloEscalationTier | null
  acknowledgeBreachBy?: string | null
  now?: number
  note?: string | null
}): FilingEscalationClosureAdjudicationSloRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const baseVerdictDueAt =
    input.quorum?.verdictDueAt ?? input.adjudication.escalatedAt + 6 * HOUR_MS
  let effectiveVerdictDueAt = existing?.effectiveVerdictDueAt ?? baseVerdictDueAt
  let extensionCount = existing?.extensionCount ?? 0
  let lastExtendedBy = existing?.lastExtendedBy ?? null
  let lastExtendedAt = existing?.lastExtendedAt ?? null
  const extensionHours = input.extensionHours ?? null
  if (extensionHours !== null && Number.isFinite(extensionHours) && extensionHours > 0) {
    effectiveVerdictDueAt = Math.max(effectiveVerdictDueAt, now) + Math.floor(extensionHours * HOUR_MS)
    extensionCount += 1
    lastExtendedBy = input.extensionApprovedBy ?? null
    lastExtendedAt = now
  }
  const breachDebtHours = Math.max(0, Math.ceil((now - effectiveVerdictDueAt) / HOUR_MS))
  const adjudicationResolved =
    input.adjudication.status === "resolved_upheld" ||
    input.adjudication.status === "resolved_overturned" ||
    !!input.adjudication.verdict
  const isDeadlineExtended = effectiveVerdictDueAt > baseVerdictDueAt
  const breachAcknowledgedBy = input.acknowledgeBreachBy ?? existing?.breachAcknowledgedBy ?? null
  const breachAcknowledgedAt = input.acknowledgeBreachBy
    ? now
    : (existing?.breachAcknowledgedAt ?? null)
  let status: FilingEscalationClosureAdjudicationSloStatus = "within_slo"
  if (!adjudicationResolved && breachDebtHours > 0) {
    status = breachAcknowledgedBy ? "breach_acknowledged" : "breach_open"
  } else if (!adjudicationResolved && isDeadlineExtended) {
    status = "deadline_extended"
  }
  const breachOpenedAt =
    breachDebtHours > 0 ? (existing?.breachOpenedAt ?? now) : (existing?.breachOpenedAt ?? null)
  let escalationTier: FilingEscalationClosureAdjudicationSloEscalationTier =
    existing?.escalationTier ?? "none"
  if (status === "breach_open" || status === "breach_acknowledged") {
    if (breachDebtHours >= 24) escalationTier = "tier_3_executive_escalation"
    else if (breachDebtHours >= 8) escalationTier = "tier_2_management_escalation"
    else escalationTier = "tier_1_partner_watch"
  } else if (status === "within_slo" || status === "deadline_extended") {
    escalationTier = "none"
  }
  if (input.escalationTierOverride) {
    escalationTier = input.escalationTierOverride
  }
  const note = input.note?.trim()
  const noteActor =
    input.acknowledgeBreachBy ?? input.extensionApprovedBy ?? input.adjudication.verdictBy ?? "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureAdjudicationSloId(input.adjudication.id),
    firmId: input.adjudication.firmId,
    ownerId: input.adjudication.ownerId,
    queueId: input.queue.id,
    adjudicationId: input.adjudication.id,
    classification: input.adjudication.classification,
    packageIds: input.adjudication.packageIds,
    status,
    escalationTier,
    baseVerdictDueAt,
    effectiveVerdictDueAt,
    extensionCount,
    lastExtendedBy,
    lastExtendedAt,
    breachOpenedAt,
    breachAcknowledgedBy,
    breachAcknowledgedAt,
    breachDebtHours,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureRebalanceSafeguardRow(input: {
  rebalance: FilingEscalationClosureEnforcementRebalanceRow
  queue: FilingEscalationClosureFollowupQueueRow
  execution: FilingEscalationClosureRebalanceExecutionRow | null
  existing?: FilingEscalationClosureRebalanceSafeguardRow | null
  cooldownLockHours?: number | null
  duplicateSuppressionHours?: number | null
  overrideAttestedBy?: string | null
  overrideReason?: string | null
  now?: number
  note?: string | null
}): FilingEscalationClosureRebalanceSafeguardRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const execution = input.execution ?? null
  let cooldownLockUntil = existing?.cooldownLockUntil ?? input.rebalance.cooldownUntil
  let duplicateSuppressionUntil =
    existing?.duplicateSuppressionUntil ?? input.rebalance.reopenThrottleUntil
  const lastAutoExecutedAt =
    execution?.executedAt ??
    existing?.lastAutoExecutedAt ??
    null
  if (input.cooldownLockHours !== undefined && input.cooldownLockHours !== null) {
    cooldownLockUntil =
      input.cooldownLockHours > 0
        ? now + Math.floor(input.cooldownLockHours * HOUR_MS)
        : null
  }
  if (input.duplicateSuppressionHours !== undefined && input.duplicateSuppressionHours !== null) {
    duplicateSuppressionUntil =
      input.duplicateSuppressionHours > 0
        ? now + Math.floor(input.duplicateSuppressionHours * HOUR_MS)
        : null
  } else if (
    execution?.status === "completed" &&
    execution.executedAt &&
    (!duplicateSuppressionUntil || duplicateSuppressionUntil <= now)
  ) {
    duplicateSuppressionUntil =
      execution.executedAt + DEFAULT_REBALANCE_SUPPRESSION_HOURS * HOUR_MS
  }
  const overrideAttestedBy = input.overrideAttestedBy ?? existing?.overrideAttestedBy ?? null
  const overrideAttestedAt = input.overrideAttestedBy ? now : (existing?.overrideAttestedAt ?? null)
  const overrideReason = input.overrideAttestedBy
    ? input.overrideReason?.trim() ?? "partner override attested"
    : (existing?.overrideReason ?? null)
  const suppressionReasons: FilingEscalationClosureRebalanceSuppressionReason[] = []
  let status: FilingEscalationClosureRebalanceSafeguardStatus = "auto_exec_ready"
  if (overrideAttestedBy && overrideAttestedAt && overrideAttestedAt + 24 * HOUR_MS > now) {
    status = "override_attested"
  } else if (cooldownLockUntil && cooldownLockUntil > now) {
    status = "cooldown_locked"
    suppressionReasons.push("cooldown_lockout_active")
  } else if (duplicateSuppressionUntil && duplicateSuppressionUntil > now) {
    status = "duplicate_suppressed"
    suppressionReasons.push("duplicate_execution_window")
  } else if (input.rebalance.status === "throttle_active") {
    suppressionReasons.push("manual_override_required")
  }
  const autoExecutionEligible = status === "auto_exec_ready" || status === "override_attested"
  const note = input.note?.trim()
  const noteActor = input.overrideAttestedBy ?? input.rebalance.lastRebalancedBy ?? "system"
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${noteActor}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureRebalanceSafeguardId(input.rebalance.id),
    firmId: input.rebalance.firmId,
    ownerId: input.rebalance.ownerId,
    queueId: input.queue.id,
    rebalanceId: input.rebalance.id,
    classification: input.rebalance.classification,
    packageIds: input.rebalance.packageIds,
    status,
    cooldownLockUntil,
    duplicateSuppressionUntil,
    overrideAttestedBy,
    overrideAttestedAt,
    overrideReason,
    lastAutoExecutedAt,
    autoExecutionEligible,
    suppressionReasons,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
