import type {
  FilingPackage,
  FilingSubmissionExceptionRow,
  FilingSubmissionSlaDigestReason,
  FilingSubmissionSlaDigestRow,
  FilingSubmissionSlaDigestStatus,
  FilingTransportExecutionEvidenceRow,
} from "@/platform/spine/store"

const RETRY_PLAN_STALE_AFTER_MS = 8 * 60 * 60 * 1000

export function filingSubmissionSlaDigestId(packageId: string): string {
  return `digest:${packageId}`
}

export function isFilingSubmissionSlaDigestStatus(
  value: string | null
): value is FilingSubmissionSlaDigestStatus {
  return (
    value === "open_breach" ||
    value === "acknowledged" ||
    value === "deferred" ||
    value === "cleared"
  )
}

function sortedReasons(reasons: FilingSubmissionSlaDigestReason[]): FilingSubmissionSlaDigestReason[] {
  return [...new Set(reasons)].sort((a, b) => a.localeCompare(b))
}

export function buildSubmissionSlaDigestRow(
  filingPackage: FilingPackage,
  input: {
    exception: FilingSubmissionExceptionRow | null
    latestEvidence: FilingTransportExecutionEvidenceRow | null
    deliveredEvidenceAt: number | null
    now?: number
    existing?: FilingSubmissionSlaDigestRow | null
    note?: { actorId: string; text: string } | null
    staleAfterMs?: number
  }
): FilingSubmissionSlaDigestRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const staleAfterMs = input.staleAfterMs ?? RETRY_PLAN_STALE_AFTER_MS
  const reasons: FilingSubmissionSlaDigestReason[] = []
  if (input.exception && input.exception.status !== "resolved" && now > input.exception.slaTargetAt) {
    reasons.push("sla_overdue")
  }
  if (
    input.exception &&
    input.exception.status !== "resolved" &&
    input.exception.source === "dispatch_transport_blocked"
  ) {
    reasons.push("transport_blocked")
  }
  if (
    input.latestEvidence?.outcome === "transport_blocked" &&
    (!input.deliveredEvidenceAt || input.deliveredEvidenceAt < input.latestEvidence.createdAt)
  ) {
    reasons.push("transport_blocked")
  }
  const staleRetryPlan =
    input.latestEvidence?.outcome === "retry_plan_attached" &&
    (!input.deliveredEvidenceAt || input.deliveredEvidenceAt < input.latestEvidence.createdAt) &&
    now - input.latestEvidence.createdAt > staleAfterMs
  if (staleRetryPlan) {
    reasons.push("retry_plan_stale")
  }
  const breachReasons = sortedReasons(reasons)
  const note = input.note?.text.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.note?.actorId}: ${note}`]
    : (existing?.notes ?? [])

  let status: FilingSubmissionSlaDigestStatus = existing?.status ?? "cleared"
  if (breachReasons.length === 0) {
    status = "cleared"
  } else if (existing?.status === "deferred" && existing.deferUntil && existing.deferUntil > now) {
    status = "deferred"
  } else if (existing?.status === "acknowledged") {
    status = "acknowledged"
  } else {
    status = "open_breach"
  }

  const reopening = breachReasons.length > 0 && (!existing || existing.status === "cleared")
  return {
    id: filingSubmissionSlaDigestId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    status,
    breachReasons,
    staleRetryPlan,
    outstandingOwnerId: input.exception?.escalationOwnerId ?? existing?.outstandingOwnerId ?? null,
    linkedExceptionId: input.exception?.id ?? existing?.linkedExceptionId ?? null,
    linkedEvidenceId: input.latestEvidence?.id ?? existing?.linkedEvidenceId ?? null,
    breachWindowStartedAt: reopening
      ? now
      : (existing?.breachWindowStartedAt ?? now),
    deferUntil: status === "deferred" ? (existing?.deferUntil ?? null) : null,
    acknowledgedBy: status === "acknowledged" ? (existing?.acknowledgedBy ?? null) : null,
    acknowledgedAt: status === "acknowledged" ? (existing?.acknowledgedAt ?? null) : null,
    deferredBy: status === "deferred" ? (existing?.deferredBy ?? null) : null,
    deferredAt: status === "deferred" ? (existing?.deferredAt ?? null) : null,
    clearedBy: status === "cleared" ? (existing?.clearedBy ?? null) : null,
    clearedAt: status === "cleared" ? (existing?.clearedAt ?? null) : null,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
