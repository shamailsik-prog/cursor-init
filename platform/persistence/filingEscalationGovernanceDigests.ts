import type {
  FilingEscalationBreachWaiverLedgerRow,
  FilingEscalationPolicyBaselineRow,
  FilingEscalationPolicyVarianceDigestRow,
  FilingEscalationPolicyVarianceDigestStatus,
  FilingEscalationPolicyVarianceReason,
  FilingEscalationWaiverExpiryDigestRow,
  FilingEscalationWaiverExpiryDigestStatus,
  FilingEscalationWaiverExpiryReason,
  FilingPackage,
} from "@/platform/spine/store"

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000

export function filingEscalationPolicyVarianceDigestId(packageId: string): string {
  return `policy-variance:${packageId}`
}

export function filingEscalationWaiverExpiryDigestId(packageId: string): string {
  return `waiver-expiry:${packageId}`
}

export function isFilingEscalationPolicyVarianceDigestStatus(
  value: string | null
): value is FilingEscalationPolicyVarianceDigestStatus {
  return value === "open_alert" || value === "acknowledged" || value === "snoozed" || value === "cleared"
}

export function isFilingEscalationWaiverExpiryDigestStatus(
  value: string | null
): value is FilingEscalationWaiverExpiryDigestStatus {
  return value === "open_expiry" || value === "acknowledged" || value === "extended" || value === "cleared"
}

function sortUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b)) as T[]
}

export function buildFilingEscalationPolicyVarianceDigestRow(
  filingPackage: FilingPackage,
  input: {
    firmDefaultPolicy: FilingEscalationPolicyBaselineRow | null
    packagePolicy: FilingEscalationPolicyBaselineRow | null
    now?: number
    existing?: FilingEscalationPolicyVarianceDigestRow | null
    note?: { actorId: string; text: string } | null
  }
): FilingEscalationPolicyVarianceDigestRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const defaultOwnerLoadThreshold = input.firmDefaultPolicy?.ownerLoadThreshold ?? 3
  const defaultHandoffSlaMs = input.firmDefaultPolicy?.handoffSlaMs ?? 0
  const defaultWaiverWindowMs = input.firmDefaultPolicy?.waiverWindowMs ?? TWENTY_FOUR_HOURS_MS
  const effectiveOwnerLoadThreshold =
    input.packagePolicy?.ownerLoadThreshold ?? defaultOwnerLoadThreshold
  const effectiveHandoffSlaMs = input.packagePolicy?.handoffSlaMs ?? defaultHandoffSlaMs
  const effectiveWaiverWindowMs = input.packagePolicy?.waiverWindowMs ?? defaultWaiverWindowMs
  const reasons: FilingEscalationPolicyVarianceReason[] = []
  if (input.packagePolicy && effectiveOwnerLoadThreshold !== defaultOwnerLoadThreshold) {
    reasons.push("owner_load_threshold_override")
  }
  if (input.packagePolicy && effectiveHandoffSlaMs !== defaultHandoffSlaMs) {
    reasons.push("handoff_sla_override")
  }
  if (input.packagePolicy && effectiveWaiverWindowMs !== defaultWaiverWindowMs) {
    reasons.push("waiver_window_override")
  }
  const varianceReasons = sortUnique(reasons)
  const note = input.note?.text.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.note?.actorId}: ${note}`]
    : (existing?.notes ?? [])

  let status: FilingEscalationPolicyVarianceDigestStatus = existing?.status ?? "cleared"
  if (varianceReasons.length === 0) {
    status = "cleared"
  } else if (existing?.status === "snoozed" && existing.snoozeUntil && existing.snoozeUntil > now) {
    status = "snoozed"
  } else if (existing?.status === "acknowledged") {
    status = "acknowledged"
  } else {
    status = "open_alert"
  }

  return {
    id: filingEscalationPolicyVarianceDigestId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    status,
    varianceReasons,
    firmDefaultPolicyId: input.firmDefaultPolicy?.id ?? null,
    packagePolicyId: input.packagePolicy?.id ?? null,
    ownerLoadThresholdDefault: defaultOwnerLoadThreshold,
    ownerLoadThresholdEffective: effectiveOwnerLoadThreshold,
    handoffSlaMsDefault: defaultHandoffSlaMs,
    handoffSlaMsEffective: effectiveHandoffSlaMs,
    waiverWindowMsDefault: defaultWaiverWindowMs,
    waiverWindowMsEffective: effectiveWaiverWindowMs,
    acknowledgedBy: status === "acknowledged" ? (existing?.acknowledgedBy ?? null) : null,
    acknowledgedAt: status === "acknowledged" ? (existing?.acknowledgedAt ?? null) : null,
    snoozeUntil: status === "snoozed" ? (existing?.snoozeUntil ?? null) : null,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function buildFilingEscalationWaiverExpiryDigestRow(
  filingPackage: FilingPackage,
  input: {
    activeWaiver: FilingEscalationBreachWaiverLedgerRow | null
    linkedPolicyId?: string | null
    now?: number
    existing?: FilingEscalationWaiverExpiryDigestRow | null
    note?: { actorId: string; text: string } | null
  }
): FilingEscalationWaiverExpiryDigestRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const reasons: FilingEscalationWaiverExpiryReason[] = []
  const activeWaiver = input.activeWaiver
  if (activeWaiver) {
    const msUntilExpiry = activeWaiver.expiresAt - now
    if (msUntilExpiry <= 0) {
      reasons.push("already_expired")
    } else if (msUntilExpiry <= FOUR_HOURS_MS) {
      reasons.push("expires_lte_4h")
    } else if (msUntilExpiry <= TWENTY_FOUR_HOURS_MS) {
      reasons.push("expires_lte_24h")
    }
  }
  const sortedReasons = sortUnique(reasons)
  const note = input.note?.text.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.note?.actorId}: ${note}`]
    : (existing?.notes ?? [])
  let status: FilingEscalationWaiverExpiryDigestStatus = existing?.status ?? "cleared"
  if (sortedReasons.length === 0) {
    status = "cleared"
  } else if (existing?.status === "acknowledged") {
    status = "acknowledged"
  } else if (existing?.status === "extended") {
    status = "extended"
  } else {
    status = "open_expiry"
  }

  return {
    id: filingEscalationWaiverExpiryDigestId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    status,
    reasons: sortedReasons,
    linkedWaiverId: activeWaiver?.id ?? null,
    linkedPolicyId: input.linkedPolicyId ?? null,
    waiverExpiresAt: activeWaiver?.expiresAt ?? null,
    msUntilExpiry: activeWaiver ? activeWaiver.expiresAt - now : null,
    acknowledgedBy: status === "acknowledged" ? (existing?.acknowledgedBy ?? null) : null,
    acknowledgedAt: status === "acknowledged" ? (existing?.acknowledgedAt ?? null) : null,
    extendedBy: status === "extended" ? (existing?.extendedBy ?? null) : null,
    extendedAt: status === "extended" ? (existing?.extendedAt ?? null) : null,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
