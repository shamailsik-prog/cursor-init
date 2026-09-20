import type {
  Classification,
  FilingEscalationClosureComplianceDigestRow,
  FilingEscalationClosureComplianceDigestStatus,
  FilingEscalationClosureFollowupQueueRow,
  FilingEscalationClosureFollowupQueueStatus,
  FilingEscalationClosureSlaWindowReason,
  FilingEscalationClosureSlaWindowRow,
  FilingEscalationClosureSlaWindowStatus,
} from "@/platform/spine/store"
import { rankOf } from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_RESPONSE_WINDOW_MS = 2 * HOUR_MS
const DEFAULT_CLAIM_WINDOW_MS = 4 * HOUR_MS
const DEFAULT_RESOLUTION_WINDOW_MS = 8 * HOUR_MS

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function maxClassification(values: Classification[]): Classification {
  return [...values].sort((a, b) => rankOf(b) - rankOf(a))[0] ?? "internal"
}

export function filingEscalationClosureComplianceDigestId(firmId: string, ownerId: string): string {
  return `closure-compliance:${firmId}:${ownerId}`
}

export function filingEscalationClosureFollowupQueueId(digestId: string): string {
  return `closure-followup:${digestId}`
}

export function filingEscalationClosureSlaWindowId(queueId: string): string {
  return `closure-sla:${queueId}`
}

export function isFilingEscalationClosureComplianceDigestStatus(
  value: string | null
): value is FilingEscalationClosureComplianceDigestStatus {
  return value === "open_alert" || value === "acknowledged" || value === "cleared"
}

export function isFilingEscalationClosureFollowupQueueStatus(
  value: string | null
): value is FilingEscalationClosureFollowupQueueStatus {
  return value === "open" || value === "claimed" || value === "resolved"
}

export function isFilingEscalationClosureSlaWindowStatus(
  value: string | null
): value is FilingEscalationClosureSlaWindowStatus {
  return (
    value === "within_sla" ||
    value === "response_breached" ||
    value === "claim_breached" ||
    value === "resolution_breached" ||
    value === "cleared"
  )
}

export function buildFilingEscalationClosureComplianceDigestRow(input: {
  firmId: string
  ownerId: string
  classifications: Classification[]
  linkedPackageIds: string[]
  linkedLifecycleIds: string[]
  linkedReaffirmationSlaIds: string[]
  existing?: FilingEscalationClosureComplianceDigestRow | null
  linkedFollowupQueueId?: string | null
  now?: number
  note?: { actorId: string; text: string } | null
}): FilingEscalationClosureComplianceDigestRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const linkedPackageIds = sortUnique(input.linkedPackageIds)
  const linkedLifecycleIds = sortUnique(input.linkedLifecycleIds)
  const linkedReaffirmationSlaIds = sortUnique(input.linkedReaffirmationSlaIds)
  const pendingLifecycleCount = linkedLifecycleIds.length
  const breachedReaffirmationCount = linkedReaffirmationSlaIds.length
  const alerting = pendingLifecycleCount > 0 || breachedReaffirmationCount > 0
  const note = input.note?.text.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.note?.actorId}: ${note}`]
    : (existing?.notes ?? [])
  let status: FilingEscalationClosureComplianceDigestStatus = existing?.status ?? "cleared"
  if (!alerting) {
    status = "cleared"
  } else if (existing?.status === "acknowledged") {
    status = "acknowledged"
  } else {
    status = "open_alert"
  }
  return {
    id: filingEscalationClosureComplianceDigestId(input.firmId, input.ownerId),
    firmId: input.firmId,
    ownerId: input.ownerId,
    classification: maxClassification(input.classifications),
    status,
    pendingLifecycleCount,
    breachedReaffirmationCount,
    linkedPackageIds,
    linkedLifecycleIds,
    linkedReaffirmationSlaIds,
    linkedFollowupQueueId: input.linkedFollowupQueueId ?? existing?.linkedFollowupQueueId ?? null,
    acknowledgedBy: status === "acknowledged" ? (existing?.acknowledgedBy ?? null) : null,
    acknowledgedAt: status === "acknowledged" ? (existing?.acknowledgedAt ?? null) : null,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureFollowupQueueRow(
  digest: FilingEscalationClosureComplianceDigestRow,
  input: {
    existing?: FilingEscalationClosureFollowupQueueRow | null
    now?: number
    note?: { actorId: string; text: string } | null
  } = {}
): FilingEscalationClosureFollowupQueueRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const note = input.note?.text.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.note?.actorId}: ${note}`]
    : (existing?.notes ?? [])
  const hasOutstanding = digest.status !== "cleared"
  const isReopened = hasOutstanding && existing?.status === "resolved"
  const status: FilingEscalationClosureFollowupQueueStatus =
    !hasOutstanding
      ? "resolved"
      : existing?.status === "claimed"
        ? "claimed"
        : "open"
  const openedAt = isReopened ? now : (existing?.openedAt ?? now)
  const assignedPartnerId = existing?.assignedPartnerId ?? null
  const assignedAt = assignedPartnerId
    ? (isReopened ? now : (existing?.assignedAt ?? openedAt))
    : null
  return {
    id: filingEscalationClosureFollowupQueueId(digest.id),
    firmId: digest.firmId,
    ownerId: digest.ownerId,
    digestId: digest.id,
    classification: digest.classification,
    status,
    openedAt,
    packageIds: digest.linkedPackageIds,
    pendingLifecycleCount: digest.pendingLifecycleCount,
    breachedReaffirmationCount: digest.breachedReaffirmationCount,
    assignedPartnerId,
    assignedAt,
    claimedBy: status === "claimed" ? (existing?.claimedBy ?? null) : null,
    claimedAt: status === "claimed" ? (existing?.claimedAt ?? null) : null,
    resolvedBy: status === "resolved" ? (existing?.resolvedBy ?? null) : null,
    resolvedAt: status === "resolved" ? (existing?.resolvedAt ?? null) : null,
    resolutionNote: status === "resolved" ? (existing?.resolutionNote ?? null) : null,
    notes,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureSlaWindowRow(
  digest: FilingEscalationClosureComplianceDigestRow,
  queue: FilingEscalationClosureFollowupQueueRow,
  input: {
    existing?: FilingEscalationClosureSlaWindowRow | null
    now?: number
    responseWindowMs?: number
    claimWindowMs?: number
    resolutionWindowMs?: number
    note?: { actorId: string; text: string } | null
  } = {}
): FilingEscalationClosureSlaWindowRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const responseWindowMs = input.responseWindowMs ?? DEFAULT_RESPONSE_WINDOW_MS
  const claimWindowMs = input.claimWindowMs ?? DEFAULT_CLAIM_WINDOW_MS
  const resolutionWindowMs = input.resolutionWindowMs ?? DEFAULT_RESOLUTION_WINDOW_MS
  const responseDueAt = queue.status === "resolved" ? null : queue.openedAt + responseWindowMs
  const claimDueAt =
    queue.status === "resolved" || queue.assignedAt === null ? null : queue.assignedAt + claimWindowMs
  const resolutionDueAt =
    queue.status !== "claimed" || queue.claimedAt === null
      ? null
      : queue.claimedAt + resolutionWindowMs
  const reasons: FilingEscalationClosureSlaWindowReason[] = []
  if (queue.status !== "resolved" && responseDueAt !== null && now > responseDueAt) {
    reasons.push("response_overdue")
  }
  if (queue.status === "open" && claimDueAt !== null && now > claimDueAt) {
    reasons.push("claim_overdue")
  }
  if (queue.status === "claimed" && resolutionDueAt !== null && now > resolutionDueAt) {
    reasons.push("resolution_overdue")
  }
  const sortedReasons = [...new Set(reasons)].sort((a, b) => a.localeCompare(b))
  let status: FilingEscalationClosureSlaWindowStatus = existing?.status ?? "within_sla"
  if (queue.status === "resolved" || digest.status === "cleared") {
    status = "cleared"
  } else if (sortedReasons.includes("resolution_overdue")) {
    status = "resolution_breached"
  } else if (sortedReasons.includes("claim_overdue")) {
    status = "claim_breached"
  } else if (sortedReasons.includes("response_overdue")) {
    status = "response_breached"
  } else {
    status = "within_sla"
  }
  const note = input.note?.text.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.note?.actorId}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureSlaWindowId(queue.id),
    firmId: queue.firmId,
    ownerId: queue.ownerId,
    queueId: queue.id,
    digestId: digest.id,
    classification: queue.classification,
    status,
    reasons: sortedReasons,
    responseWindowMs,
    claimWindowMs,
    resolutionWindowMs,
    openedAt: queue.openedAt,
    assignedAt: queue.assignedAt,
    claimedAt: queue.claimedAt,
    resolvedAt: queue.resolvedAt,
    responseDueAt,
    claimDueAt,
    resolutionDueAt,
    assignedPartnerId: queue.assignedPartnerId,
    autoAssignedPartnerId: existing?.autoAssignedPartnerId ?? null,
    autoAssignedAt: existing?.autoAssignedAt ?? null,
    autoAssignmentAttestation: existing?.autoAssignmentAttestation ?? null,
    secondReviewRequired: existing?.secondReviewRequired ?? false,
    secondReviewedBy: existing?.secondReviewedBy ?? null,
    secondReviewedAt: existing?.secondReviewedAt ?? null,
    secondReviewNote: existing?.secondReviewNote ?? null,
    linkedPackageIds: queue.packageIds,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
