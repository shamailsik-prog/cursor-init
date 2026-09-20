import type {
  FilingEscalationClosureAdjudicationQueueRow,
  FilingEscalationClosureAdjudicationQuorumBreachFlag,
  FilingEscalationClosureAdjudicationQuorumRow,
  FilingEscalationClosureAdjudicationQuorumStatus,
  FilingEscalationClosureEnforcementRebalanceRow,
  FilingEscalationClosureFollowupQueueRow,
  FilingEscalationClosureRebalanceExecutionMode,
  FilingEscalationClosureRebalanceExecutionRow,
  FilingEscalationClosureRebalanceExecutionStatus,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export function filingEscalationClosureAdjudicationQuorumId(adjudicationId: string): string {
  return `closure-adjudication-quorum:${adjudicationId}`
}

export function filingEscalationClosureRebalanceExecutionId(rebalanceId: string): string {
  return `closure-rebalance-execution:${rebalanceId}`
}

export function isFilingEscalationClosureAdjudicationQuorumStatus(
  value: string | null
): value is FilingEscalationClosureAdjudicationQuorumStatus {
  return (
    value === "quorum_pending" ||
    value === "quorum_met" ||
    value === "verdict_overdue" ||
    value === "closed"
  )
}

export function isFilingEscalationClosureRebalanceExecutionStatus(
  value: string | null
): value is FilingEscalationClosureRebalanceExecutionStatus {
  return (
    value === "queued" ||
    value === "owner_transfer_in_progress" ||
    value === "throttle_release_in_progress" ||
    value === "completed"
  )
}

export function isFilingEscalationClosureRebalanceExecutionMode(
  value: string | null
): value is FilingEscalationClosureRebalanceExecutionMode {
  return value === "owner_transfer" || value === "throttle_release"
}

export function buildFilingEscalationClosureAdjudicationQuorumRow(input: {
  adjudication: FilingEscalationClosureAdjudicationQueueRow
  queue: FilingEscalationClosureFollowupQueueRow
  existing?: FilingEscalationClosureAdjudicationQuorumRow | null
  requiredPanelCount?: number
  quorumWindowHours?: number
  verdictWindowHours?: number
  actorId?: string
  now?: number
  note?: string | null
}): FilingEscalationClosureAdjudicationQuorumRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const requiredPanelCount = Math.max(
    2,
    Math.floor(input.requiredPanelCount ?? existing?.requiredPanelCount ?? 2)
  )
  const confirmedPanelCount = input.adjudication.panelMemberIds.length
  const quorumWindowHours = Math.max(0, Math.floor(input.quorumWindowHours ?? 1))
  const verdictWindowHours = Math.max(0, Math.floor(input.verdictWindowHours ?? 6))
  const quorumDeadlineAt = input.adjudication.escalatedAt + quorumWindowHours * HOUR_MS
  const verdictDueAt =
    existing?.verdictDueAt ?? input.adjudication.escalatedAt + verdictWindowHours * HOUR_MS
  let status: FilingEscalationClosureAdjudicationQuorumStatus = "quorum_pending"
  const breachFlags: FilingEscalationClosureAdjudicationQuorumBreachFlag[] = []
  const verdictRecordedAt = input.adjudication.verdictAt ?? existing?.verdictRecordedAt ?? null
  if (input.adjudication.verdict) {
    status = "closed"
  } else if (confirmedPanelCount < requiredPanelCount) {
    status = "quorum_pending"
    if (now >= quorumDeadlineAt) breachFlags.push("quorum_unmet")
  } else if (now >= verdictDueAt) {
    status = "verdict_overdue"
    breachFlags.push("verdict_overdue")
  } else {
    status = "quorum_met"
  }
  const quorumMetAt =
    confirmedPanelCount >= requiredPanelCount
      ? (existing?.quorumMetAt ?? now)
      : (existing?.quorumMetAt ?? null)
  const note = input.note?.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.actorId ?? "system"}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureAdjudicationQuorumId(input.adjudication.id),
    firmId: input.adjudication.firmId,
    ownerId: input.adjudication.ownerId,
    queueId: input.adjudication.queueId,
    adjudicationId: input.adjudication.id,
    classification: input.adjudication.classification,
    packageIds: input.adjudication.packageIds,
    status,
    requiredPanelCount,
    confirmedPanelCount,
    quorumMetAt,
    quorumDeadlineAt,
    verdictDueAt,
    verdictRecordedAt,
    breachFlags,
    lastGovernedBy: input.actorId ?? existing?.lastGovernedBy ?? null,
    lastGovernedAt: input.actorId ? now : (existing?.lastGovernedAt ?? null),
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureRebalanceExecutionRow(input: {
  rebalance: FilingEscalationClosureEnforcementRebalanceRow
  queue: FilingEscalationClosureFollowupQueueRow
  existing?: FilingEscalationClosureRebalanceExecutionRow | null
  mode: FilingEscalationClosureRebalanceExecutionMode
  status?: FilingEscalationClosureRebalanceExecutionStatus
  targetOwnerId?: string | null
  appliedOwnerId?: string | null
  reopenQueue?: boolean
  actorId?: string
  now?: number
  note?: string | null
}): FilingEscalationClosureRebalanceExecutionRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const status = input.status ?? "completed"
  const note = input.note?.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.actorId ?? "system"}: ${note}`]
    : (existing?.notes ?? [])
  const churnCount =
    status === "completed"
      ? (existing?.status === "completed" ? (existing?.churnCount ?? 0) : (existing?.churnCount ?? 0) + 1)
      : (existing?.churnCount ?? 0)
  return {
    id: filingEscalationClosureRebalanceExecutionId(input.rebalance.id),
    firmId: input.rebalance.firmId,
    ownerId: input.rebalance.ownerId,
    queueId: input.queue.id,
    rebalanceId: input.rebalance.id,
    classification: input.rebalance.classification,
    packageIds: input.rebalance.packageIds,
    mode: input.mode,
    status,
    targetOwnerId: input.targetOwnerId ?? null,
    appliedOwnerId: input.appliedOwnerId ?? null,
    throttleReleased: input.mode === "throttle_release" ? status === "completed" : false,
    queueReopened: input.reopenQueue ?? false,
    executedBy: input.actorId ?? existing?.executedBy ?? null,
    executedAt: status === "completed" ? now : (existing?.executedAt ?? null),
    churnCount,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
