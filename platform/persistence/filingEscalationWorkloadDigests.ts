import type {
  FilingEscalationHandoffLagBucket,
  FilingEscalationOwnerRotaRow,
  FilingEscalationWorkloadAlertReason,
  FilingEscalationWorkloadDigestRow,
  FilingEscalationWorkloadDigestStatus,
  FilingSubmissionSlaDigestRow,
  FilingPackage,
} from "@/platform/spine/store"

const DEFAULT_OWNER_LOAD_THRESHOLD = 3

export function filingEscalationWorkloadDigestId(packageId: string): string {
  return `workload:${packageId}`
}

export function isFilingEscalationWorkloadDigestStatus(
  value: string | null
): value is FilingEscalationWorkloadDigestStatus {
  return value === "open_alert" || value === "acknowledged" || value === "snoozed" || value === "cleared"
}

export function isFilingEscalationHandoffLagBucket(
  value: string | null
): value is FilingEscalationHandoffLagBucket {
  return value === "none" || value === "lt_4h" || value === "between_4h_12h" || value === "gte_12h"
}

function handoffLagBucket(lagMs: number | null): FilingEscalationHandoffLagBucket {
  if (lagMs === null || lagMs <= 0) return "none"
  if (lagMs < 4 * 60 * 60 * 1000) return "lt_4h"
  if (lagMs < 12 * 60 * 60 * 1000) return "between_4h_12h"
  return "gte_12h"
}

export function buildFilingEscalationWorkloadDigestRow(
  filingPackage: FilingPackage,
  input: {
    rota: FilingEscalationOwnerRotaRow | null
    slaDigest: FilingSubmissionSlaDigestRow | null
    ownerLoadCount: number
    now?: number
    existing?: FilingEscalationWorkloadDigestRow | null
    ownerLoadThreshold?: number
    handoffSlaMs?: number
    note?: { actorId: string; text: string } | null
  }
): FilingEscalationWorkloadDigestRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const ownerLoadThreshold = input.ownerLoadThreshold ?? DEFAULT_OWNER_LOAD_THRESHOLD
  const handoffSlaMs = input.handoffSlaMs ?? 0
  const reasons: FilingEscalationWorkloadAlertReason[] = []
  const ownerId = input.rota?.primaryOwnerId ?? null
  const slaOpen = !!input.slaDigest && input.slaDigest.status !== "cleared"
  if (slaOpen && !ownerId) {
    reasons.push("unassigned_breach")
  }
  if (ownerId && input.ownerLoadCount > ownerLoadThreshold) {
    reasons.push("overloaded_owner")
  }
  const handoffLagMs =
    input.rota && input.rota.handoffRequired ? now - input.rota.updatedAt : null
  if (input.rota?.handoffRequired && handoffLagMs !== null && handoffLagMs >= handoffSlaMs) {
    reasons.push("handoff_lag")
  }
  const alertReasons = [...new Set(reasons)].sort((a, b) => a.localeCompare(b))
  const note = input.note?.text.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.note?.actorId}: ${note}`]
    : (existing?.notes ?? [])
  let status: FilingEscalationWorkloadDigestStatus = existing?.status ?? "cleared"
  if (alertReasons.length === 0) {
    status = "cleared"
  } else if (existing?.status === "snoozed" && existing.snoozeUntil && existing.snoozeUntil > now) {
    status = "snoozed"
  } else if (existing?.status === "acknowledged") {
    status = "acknowledged"
  } else {
    status = "open_alert"
  }
  return {
    id: filingEscalationWorkloadDigestId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    status,
    alertReasons,
    ownerId,
    ownerLoadCount: ownerId ? input.ownerLoadCount : 0,
    ownerLoadThreshold,
    handoffLagMs,
    handoffLagBucket: handoffLagBucket(handoffLagMs),
    snoozeUntil: status === "snoozed" ? (existing?.snoozeUntil ?? null) : null,
    acknowledgedBy: status === "acknowledged" ? (existing?.acknowledgedBy ?? null) : null,
    acknowledgedAt: status === "acknowledged" ? (existing?.acknowledgedAt ?? null) : null,
    rebalancedBy: existing?.rebalancedBy ?? null,
    rebalancedAt: existing?.rebalancedAt ?? null,
    linkedRotaId: input.rota?.id ?? existing?.linkedRotaId ?? null,
    linkedDigestId: input.slaDigest?.id ?? existing?.linkedDigestId ?? null,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
