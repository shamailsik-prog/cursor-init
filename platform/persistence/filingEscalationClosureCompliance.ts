import type {
  Classification,
  FilingEscalationClosureComplianceDigestRow,
  FilingEscalationClosureComplianceDigestStatus,
  FilingEscalationClosureFollowupQueueRow,
  FilingEscalationClosureFollowupQueueStatus,
} from "@/platform/spine/store"
import { rankOf } from "@/platform/spine/store"

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
  const status: FilingEscalationClosureFollowupQueueStatus =
    !hasOutstanding
      ? "resolved"
      : existing?.status === "claimed"
        ? "claimed"
        : "open"
  return {
    id: filingEscalationClosureFollowupQueueId(digest.id),
    firmId: digest.firmId,
    ownerId: digest.ownerId,
    digestId: digest.id,
    classification: digest.classification,
    status,
    packageIds: digest.linkedPackageIds,
    pendingLifecycleCount: digest.pendingLifecycleCount,
    breachedReaffirmationCount: digest.breachedReaffirmationCount,
    assignedPartnerId: existing?.assignedPartnerId ?? null,
    claimedBy: status === "claimed" ? (existing?.claimedBy ?? null) : null,
    claimedAt: status === "claimed" ? (existing?.claimedAt ?? null) : null,
    resolvedBy: status === "resolved" ? (existing?.resolvedBy ?? null) : null,
    resolvedAt: status === "resolved" ? (existing?.resolvedAt ?? null) : null,
    resolutionNote: status === "resolved" ? (existing?.resolutionNote ?? null) : null,
    notes,
    updatedAt: now,
  }
}
