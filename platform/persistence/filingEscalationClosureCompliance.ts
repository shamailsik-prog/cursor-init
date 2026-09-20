import type {
  Classification,
  FilingEscalationClosureAutoAssignmentMode,
  FilingEscalationClosureAutoAssignmentRuleRow,
  FilingEscalationClosureComplianceDigestRow,
  FilingEscalationClosureComplianceDigestStatus,
  FilingEscalationClosureFollowupQueueRow,
  FilingEscalationClosureFollowupQueueStatus,
  FilingEscalationClosureSlaPressureLevel,
  FilingEscalationClosureSlaWindowConfigRow,
  FilingEscalationClosureSlaWindowRow,
  FilingEscalationClosureSlaWindowScope,
  FilingEscalationClosureSlaWindowStatus,
} from "@/platform/spine/store"
import { rankOf } from "@/platform/spine/store"

export const DEFAULT_CLOSURE_ACK_DEADLINE_MS = 2 * 60 * 60 * 1000
export const DEFAULT_CLOSURE_CLEAR_DEADLINE_MS = 8 * 60 * 60 * 1000
export const DEFAULT_CLOSURE_AUTO_ESCALATION_MS = 12 * 60 * 60 * 1000
export const DEFAULT_CLOSURE_AUTO_ASSIGNMENT_MAX_ACTIVE_CLAIMS = 6

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

export function filingEscalationClosureSlaWindowConfigId(
  firmId: string,
  ownerId: string | null = null
): string {
  return ownerId
    ? `closure-sla-window-config:${firmId}:owner:${ownerId}`
    : `closure-sla-window-config:${firmId}:default`
}

export function filingEscalationClosureAutoAssignmentRuleId(
  firmId: string,
  ownerId: string | null = null
): string {
  return ownerId
    ? `closure-auto-assignment-rule:${firmId}:owner:${ownerId}`
    : `closure-auto-assignment-rule:${firmId}:default`
}

export function filingEscalationClosureSlaWindowId(digestId: string): string {
  return `closure-sla-window:${digestId}`
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
    value === "within_window" ||
    value === "ack_breached" ||
    value === "clear_breached" ||
    value === "auto_escalation_due" ||
    value === "cleared"
  )
}

export function isFilingEscalationClosureSlaPressureLevel(
  value: string | null
): value is FilingEscalationClosureSlaPressureLevel {
  return value === "baseline" || value === "elevated" || value === "critical"
}

export function isFilingEscalationClosureSlaWindowScope(
  value: string | null
): value is FilingEscalationClosureSlaWindowScope {
  return value === "firm_default" || value === "owner_override"
}

export function isFilingEscalationClosureAutoAssignmentMode(
  value: string | null
): value is FilingEscalationClosureAutoAssignmentMode {
  return value === "owner_rota" || value === "workload_aware_claim"
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

export function buildFilingEscalationClosureSlaWindowConfigRow(input: {
  firmId: string
  ownerId?: string | null
  classification: Classification
  actorId: string
  ackDeadlineMs?: number
  clearDeadlineMs?: number
  autoEscalationMs?: number
  existing?: FilingEscalationClosureSlaWindowConfigRow | null
  now?: number
  note?: string | null
}): FilingEscalationClosureSlaWindowConfigRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const ownerId = input.ownerId ?? null
  const ackDeadlineMs = Math.max(30 * 60 * 1000, input.ackDeadlineMs ?? existing?.ackDeadlineMs ?? DEFAULT_CLOSURE_ACK_DEADLINE_MS)
  const clearDeadlineMs = Math.max(ackDeadlineMs, input.clearDeadlineMs ?? existing?.clearDeadlineMs ?? DEFAULT_CLOSURE_CLEAR_DEADLINE_MS)
  const autoEscalationMs = Math.max(
    clearDeadlineMs,
    input.autoEscalationMs ?? existing?.autoEscalationMs ?? DEFAULT_CLOSURE_AUTO_ESCALATION_MS
  )
  const note = input.note?.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.actorId}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureSlaWindowConfigId(input.firmId, ownerId),
    firmId: input.firmId,
    ownerId,
    classification: input.classification,
    scope: ownerId ? "owner_override" : "firm_default",
    ackDeadlineMs,
    clearDeadlineMs,
    autoEscalationMs,
    setBy: input.actorId,
    setAt: now,
    notes,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureAutoAssignmentRuleRow(input: {
  firmId: string
  ownerId?: string | null
  classification: Classification
  actorId: string
  mode?: FilingEscalationClosureAutoAssignmentMode
  enabled?: boolean
  maxActiveClaimsPerPartner?: number
  existing?: FilingEscalationClosureAutoAssignmentRuleRow | null
  now?: number
  note?: string | null
}): FilingEscalationClosureAutoAssignmentRuleRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const ownerId = input.ownerId ?? null
  const note = input.note?.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.actorId}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationClosureAutoAssignmentRuleId(input.firmId, ownerId),
    firmId: input.firmId,
    ownerId,
    classification: input.classification,
    mode: input.mode ?? existing?.mode ?? "owner_rota",
    enabled: input.enabled ?? existing?.enabled ?? true,
    maxActiveClaimsPerPartner:
      input.maxActiveClaimsPerPartner ??
      existing?.maxActiveClaimsPerPartner ??
      DEFAULT_CLOSURE_AUTO_ASSIGNMENT_MAX_ACTIVE_CLAIMS,
    setBy: input.actorId,
    setAt: now,
    notes,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureSlaWindowRow(input: {
  digest: FilingEscalationClosureComplianceDigestRow
  queue: FilingEscalationClosureFollowupQueueRow
  config: FilingEscalationClosureSlaWindowConfigRow
  existing?: FilingEscalationClosureSlaWindowRow | null
  now?: number
  linkedAutoAssignmentRuleId?: string | null
  autoEscalationTriggeredAt?: number | null
  autoEscalatedToPartnerId?: string | null
  note?: { actorId: string; text: string } | null
}): FilingEscalationClosureSlaWindowRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const hasOutstanding = input.digest.status !== "cleared" && input.queue.status !== "resolved"
  const openedAt = hasOutstanding ? (existing?.openedAt ?? now) : null
  const ackDeadlineAt = openedAt !== null ? openedAt + input.config.ackDeadlineMs : null
  const clearDeadlineAt = openedAt !== null ? openedAt + input.config.clearDeadlineMs : null
  const autoEscalateAt = openedAt !== null ? openedAt + input.config.autoEscalationMs : null
  const ackBreached = hasOutstanding && ackDeadlineAt !== null && now > ackDeadlineAt
  const clearBreached = hasOutstanding && clearDeadlineAt !== null && now > clearDeadlineAt
  const autoEscalationDue = hasOutstanding && autoEscalateAt !== null && now > autoEscalateAt

  let status: FilingEscalationClosureSlaWindowStatus = "within_window"
  if (!hasOutstanding) {
    status = "cleared"
  } else if (autoEscalationDue) {
    status = "auto_escalation_due"
  } else if (clearBreached) {
    status = "clear_breached"
  } else if (ackBreached) {
    status = "ack_breached"
  }

  let pressureLevel: FilingEscalationClosureSlaPressureLevel = "baseline"
  if (status === "ack_breached" || input.digest.pendingLifecycleCount > 0) {
    pressureLevel = "elevated"
  }
  if (
    status === "clear_breached" ||
    status === "auto_escalation_due" ||
    input.digest.breachedReaffirmationCount > 0
  ) {
    pressureLevel = "critical"
  }

  const note = input.note?.text.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.note?.actorId}: ${note}`]
    : (existing?.notes ?? [])

  const autoEscalationTriggeredAt =
    input.autoEscalationTriggeredAt ??
    existing?.autoEscalationTriggeredAt ??
    (input.autoEscalatedToPartnerId ? now : null)
  const autoEscalatedToPartnerId = input.autoEscalatedToPartnerId ?? existing?.autoEscalatedToPartnerId ?? null

  return {
    id: filingEscalationClosureSlaWindowId(input.digest.id),
    firmId: input.digest.firmId,
    ownerId: input.digest.ownerId,
    digestId: input.digest.id,
    queueId: input.queue.id,
    classification: input.digest.classification,
    status,
    pressureLevel,
    openedAt,
    acknowledgedAt: input.queue.claimedAt ?? existing?.acknowledgedAt ?? null,
    clearedAt: status === "cleared" ? existing?.clearedAt ?? now : null,
    ackDeadlineAt,
    clearDeadlineAt,
    autoEscalateAt,
    breachedAt: status === "within_window" || status === "cleared" ? null : existing?.breachedAt ?? now,
    autoEscalationTriggeredAt,
    autoEscalatedToPartnerId,
    linkedConfigId: input.config.id,
    linkedAutoAssignmentRuleId: input.linkedAutoAssignmentRuleId ?? existing?.linkedAutoAssignmentRuleId ?? null,
    notes,
    updatedAt: now,
  }
}
