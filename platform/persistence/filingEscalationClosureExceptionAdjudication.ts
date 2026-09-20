export type FilingEscalationClosureAdjudicationStatus =
  | "pending_panel_assignment"
  | "panel_in_review"
  | "resolved_upheld"
  | "resolved_overturned"

export type FilingEscalationClosureEnforcementRebalanceStatus =
  | "none"
  | "cooldown_scheduled"
  | "owner_reassignment_recommended"
  | "throttle_active"

import type {
  FilingEscalationClosureAttestationDisputeRow,
  FilingEscalationClosureFollowupQueueRow,
  FilingEscalationClosureSlaExceptionEnforcementRow,
  FilingEscalationClosureAdjudicationQueueRow,
  FilingEscalationClosureEnforcementRebalanceRow,
  FilingEscalationClosureAdjudicationStatus as StoreAdjudicationStatus,
  FilingEscalationClosureEnforcementRebalanceStatus as StoreRebalanceStatus,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export type FilingEscalationClosureAdjudicationVerdict = "uphold_dispute" | "override_dispute"

export function filingEscalationClosureAdjudicationQueueId(disputeId: string): string {
  return `closure-adjudication-queue:${disputeId}`
}

export function filingEscalationClosureEnforcementRebalanceId(queueId: string): string {
  return `closure-enforcement-rebalance:${queueId}`
}

export function isFilingEscalationClosureAdjudicationStatus(
  value: string | null
): value is FilingEscalationClosureAdjudicationStatus {
  return (
    value === "pending_panel_assignment" ||
    value === "panel_in_review" ||
    value === "resolved_upheld" ||
    value === "resolved_overturned"
  )
}

export function isFilingEscalationClosureEnforcementRebalanceStatus(
  value: string | null
): value is FilingEscalationClosureEnforcementRebalanceStatus {
  return (
    value === "none" ||
    value === "cooldown_scheduled" ||
    value === "owner_reassignment_recommended" ||
    value === "throttle_active"
  )
}

export function isFilingEscalationClosureAdjudicationVerdict(
  value: string | null
): value is FilingEscalationClosureAdjudicationVerdict {
  return value === "uphold_dispute" || value === "override_dispute"
}

export function buildFilingEscalationClosureAdjudicationQueueRow(input: {
  dispute: FilingEscalationClosureAttestationDisputeRow
  queue: FilingEscalationClosureFollowupQueueRow
  enforcement: FilingEscalationClosureSlaExceptionEnforcementRow | null
  existing?: FilingEscalationClosureAdjudicationQueueRow | null
  panelMemberIds?: string[] | null
  actorId?: string
  verdict?: FilingEscalationClosureAdjudicationVerdict | null
  dissentNote?: string | null
  now?: number
  note?: string | null
}): FilingEscalationClosureAdjudicationQueueRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const verdict = input.verdict ?? existing?.verdict ?? null
  const panelMemberIds = input.panelMemberIds ?? existing?.panelMemberIds ?? []
  let status: StoreAdjudicationStatus = existing?.status ?? "pending_panel_assignment"
  if (input.dispute.status === "resolved_upheld") status = "resolved_upheld"
  else if (input.dispute.status === "resolved_overturned") status = "resolved_overturned"
  else if (panelMemberIds.length > 0) status = "panel_in_review"
  else status = "pending_panel_assignment"
  if (verdict === "uphold_dispute") status = "resolved_upheld"
  if (verdict === "override_dispute") status = "resolved_overturned"
  const dissent = input.dissentNote?.trim()
  const dissentNotes = dissent ? [...(existing?.dissentNotes ?? []), dissent] : (existing?.dissentNotes ?? [])
  const actionNote = input.note?.trim()
  const notes = actionNote
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.actorId ?? "system"}: ${actionNote}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureAdjudicationQueueId(input.dispute.id),
    firmId: input.dispute.firmId,
    ownerId: input.dispute.ownerId,
    queueId: input.dispute.queueId,
    disputeId: input.dispute.id,
    attestationId: input.dispute.attestationId,
    exceptionDigestId: input.dispute.exceptionDigestId,
    classification: input.dispute.classification,
    packageIds: input.dispute.packageIds,
    status,
    panelMemberIds: [...new Set(panelMemberIds)].sort((a, b) => a.localeCompare(b)),
    escalatedBy: existing?.escalatedBy ?? input.actorId ?? "system",
    escalatedAt: existing?.escalatedAt ?? now,
    verdict,
    verdictBy: verdict ? (input.actorId ?? existing?.verdictBy ?? null) : null,
    verdictAt: verdict ? now : null,
    dissentNotes,
    linkedEnforcementRebalanceId:
      existing?.linkedEnforcementRebalanceId ??
      filingEscalationClosureEnforcementRebalanceId(input.queue.id),
    notes,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureEnforcementRebalanceRow(input: {
  queue: FilingEscalationClosureFollowupQueueRow
  enforcement: FilingEscalationClosureSlaExceptionEnforcementRow
  adjudication: FilingEscalationClosureAdjudicationQueueRow | null
  existing?: FilingEscalationClosureEnforcementRebalanceRow | null
  statusOverride?: StoreRebalanceStatus | null
  recommendedOwnerId?: string | null
  cooldownHours?: number | null
  throttleHours?: number | null
  actorId?: string
  now?: number
  note?: string | null
}): FilingEscalationClosureEnforcementRebalanceRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const autoStatus: StoreRebalanceStatus =
    input.enforcement.status === "escalated" && input.enforcement.escalationCount >= 2
      ? "owner_reassignment_recommended"
      : input.enforcement.status === "reminder_sent" && input.enforcement.reminderCount >= 2
        ? "cooldown_scheduled"
        : input.adjudication?.status === "panel_in_review" &&
            input.enforcement.status === "escalated"
          ? "throttle_active"
          : "none"
  const status = input.statusOverride ?? autoStatus
  const cooldownUntil =
    status === "cooldown_scheduled"
      ? now + Math.max(1, Math.floor(input.cooldownHours ?? 2)) * HOUR_MS
      : null
  const reopenThrottleUntil =
    status === "throttle_active"
      ? now + Math.max(1, Math.floor(input.throttleHours ?? 1)) * HOUR_MS
      : null
  const actionNote = input.note?.trim()
  const notes = actionNote
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.actorId ?? "system"}: ${actionNote}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureEnforcementRebalanceId(input.queue.id),
    firmId: input.queue.firmId,
    ownerId: input.queue.ownerId,
    digestId: input.queue.digestId,
    queueId: input.queue.id,
    enforcementId: input.enforcement.id,
    classification: input.queue.classification,
    packageIds: input.queue.packageIds,
    status,
    triggeredByEscalationCount: input.enforcement.escalationCount,
    cooldownUntil,
    recommendedOwnerId:
      status === "owner_reassignment_recommended" ? (input.recommendedOwnerId ?? null) : null,
    reopenThrottleUntil,
    lastRebalancedBy: input.actorId ?? existing?.lastRebalancedBy ?? null,
    lastRebalancedAt: input.actorId ? now : (existing?.lastRebalancedAt ?? null),
    linkedAdjudicationQueueId: input.adjudication?.id ?? null,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
