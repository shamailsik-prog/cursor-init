import type {
  FilingPackage,
  FilingSubmissionExceptionRow,
  FilingSubmissionExceptionSeverity,
  FilingSubmissionExceptionSource,
  FilingSubmissionExceptionStatus,
  FilingSubmissionReceiptRow,
  FilingSubmissionReconciliationRow,
} from "@/platform/spine/store"

const SLA_MS_BY_SEVERITY: Record<FilingSubmissionExceptionSeverity, number> = {
  medium: 24 * 60 * 60 * 1000,
  high: 8 * 60 * 60 * 1000,
  critical: 2 * 60 * 60 * 1000,
}

export function filingSubmissionExceptionId(packageId: string): string {
  return `exception:${packageId}`
}

export function isFilingSubmissionExceptionStatus(
  value: string | null
): value is FilingSubmissionExceptionStatus {
  return value === "open" || value === "claimed" || value === "escalated" || value === "resolved"
}

export function isFilingSubmissionExceptionSeverity(
  value: string | null
): value is FilingSubmissionExceptionSeverity {
  return value === "medium" || value === "high" || value === "critical"
}

export function severityForSubmissionExceptionSource(
  source: FilingSubmissionExceptionSource
): FilingSubmissionExceptionSeverity {
  if (source === "receipt_rejected") return "critical"
  if (source === "reconciliation_needs_retry") return "high"
  return "medium"
}

export function buildSubmissionExceptionRowFromFailure(
  filingPackage: FilingPackage,
  failure: {
    source: FilingSubmissionExceptionSource
    receipt: FilingSubmissionReceiptRow | null
    reconciliation: FilingSubmissionReconciliationRow | null
    actorId: string
    note?: string | null
    now?: number
  },
  existing: FilingSubmissionExceptionRow | null
): FilingSubmissionExceptionRow {
  const now = failure.now ?? Date.now()
  const severity = severityForSubmissionExceptionSource(failure.source)
  const note = failure.note?.trim()
  const baseNotes = existing?.resolutionNotes ?? []
  const nextNotes = note
    ? [...baseNotes, `${new Date(now).toISOString()} ${failure.actorId}: ${note}`]
    : baseNotes
  const previousStatus = existing?.status
  const reopened = previousStatus === "resolved"
  const status = reopened ? ("open" as const) : (existing?.status ?? "open")
  return {
    id: filingSubmissionExceptionId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    status,
    severity,
    source: failure.source,
    latestReceiptId: failure.receipt?.id ?? existing?.latestReceiptId ?? null,
    latestReconciliationId:
      failure.reconciliation?.id ?? existing?.latestReconciliationId ?? null,
    escalationOwnerId: existing?.escalationOwnerId ?? null,
    firstRaisedAt: existing?.firstRaisedAt ?? now,
    lastRaisedAt: now,
    slaTargetAt: now + SLA_MS_BY_SEVERITY[severity],
    claimedBy: status === "claimed" ? existing?.claimedBy ?? null : null,
    claimedAt: status === "claimed" ? existing?.claimedAt ?? null : null,
    escalatedBy: status === "escalated" ? existing?.escalatedBy ?? null : null,
    escalatedAt: status === "escalated" ? existing?.escalatedAt ?? null : null,
    resolvedBy: status === "resolved" ? existing?.resolvedBy ?? null : null,
    resolvedAt: status === "resolved" ? existing?.resolvedAt ?? null : null,
    resolutionNotes: nextNotes,
    updatedAt: now,
  }
}
