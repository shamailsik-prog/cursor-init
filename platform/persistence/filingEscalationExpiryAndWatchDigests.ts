import type {
  FilingEscalationRemediationExpiryDigestRow,
  FilingEscalationRemediationExpiryDigestStatus,
  FilingEscalationRemediationExpiryReason,
  FilingEscalationRolloverBreachWatchReason,
  FilingEscalationRolloverBreachWatchRow,
  FilingEscalationRolloverBreachWatchStatus,
  FilingEscalationVarianceRemediationRow,
  FilingEscalationWaiverRolloverAttestationRow,
  FilingEscalationBreachWaiverLedgerRow,
  FilingPackage,
} from "@/platform/spine/store"

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000

function sortUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b)) as T[]
}

export function filingEscalationRemediationExpiryDigestId(packageId: string): string {
  return `remediation-expiry:${packageId}`
}

export function filingEscalationRolloverBreachWatchId(packageId: string): string {
  return `rollover-breach:${packageId}`
}

export function isFilingEscalationRemediationExpiryDigestStatus(
  value: string | null
): value is FilingEscalationRemediationExpiryDigestStatus {
  return value === "open_expiry" || value === "acknowledged" || value === "snoozed" || value === "cleared"
}

export function isFilingEscalationRolloverBreachWatchStatus(
  value: string | null
): value is FilingEscalationRolloverBreachWatchStatus {
  return value === "open_breach" || value === "acknowledged" || value === "cleared"
}

export function buildFilingEscalationRemediationExpiryDigestRow(
  filingPackage: FilingPackage,
  input: {
    activeRemediation: FilingEscalationVarianceRemediationRow | null
    linkedPolicyId?: string | null
    now?: number
    existing?: FilingEscalationRemediationExpiryDigestRow | null
    note?: { actorId: string; text: string } | null
  }
): FilingEscalationRemediationExpiryDigestRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const reasons: FilingEscalationRemediationExpiryReason[] = []
  if (input.activeRemediation) {
    const msUntilExpiry = input.activeRemediation.expiresAt - now
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
  let status: FilingEscalationRemediationExpiryDigestStatus = existing?.status ?? "cleared"
  if (sortedReasons.length === 0) {
    status = "cleared"
  } else if (existing?.status === "snoozed" && existing.snoozeUntil && existing.snoozeUntil > now) {
    status = "snoozed"
  } else if (existing?.status === "acknowledged") {
    status = "acknowledged"
  } else {
    status = "open_expiry"
  }
  return {
    id: filingEscalationRemediationExpiryDigestId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    status,
    reasons: sortedReasons,
    linkedRemediationId: input.activeRemediation?.id ?? null,
    linkedPolicyVarianceDigestId: input.activeRemediation?.linkedPolicyVarianceDigestId ?? null,
    linkedPolicyId: input.linkedPolicyId ?? input.activeRemediation?.linkedPolicyId ?? null,
    remediationExpiresAt: input.activeRemediation?.expiresAt ?? null,
    msUntilExpiry: input.activeRemediation ? input.activeRemediation.expiresAt - now : null,
    acknowledgedBy: status === "acknowledged" ? (existing?.acknowledgedBy ?? null) : null,
    acknowledgedAt: status === "acknowledged" ? (existing?.acknowledgedAt ?? null) : null,
    snoozeUntil: status === "snoozed" ? (existing?.snoozeUntil ?? null) : null,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function buildFilingEscalationRolloverBreachWatchRow(
  filingPackage: FilingPackage,
  input: {
    activeWaiver: FilingEscalationBreachWaiverLedgerRow | null
    policyCapExpiresAt: number | null
    latestAttestation: FilingEscalationWaiverRolloverAttestationRow | null
    linkedPolicyId?: string | null
    now?: number
    existing?: FilingEscalationRolloverBreachWatchRow | null
    note?: { actorId: string; text: string } | null
  }
): FilingEscalationRolloverBreachWatchRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const reasons: FilingEscalationRolloverBreachWatchReason[] = []
  const capCrossed =
    !!input.activeWaiver &&
    input.policyCapExpiresAt !== null &&
    input.activeWaiver.expiresAt > input.policyCapExpiresAt
  if (capCrossed) {
    if (!input.latestAttestation) {
      reasons.push("cap_crossed_without_attestation")
    } else {
      const hasReaffirmationNote = input.latestAttestation.notes.some((entry) =>
        entry.toLowerCase().includes("reaffirm")
      )
      const staleReaffirmation = input.latestAttestation.updatedAt <= now - TWENTY_FOUR_HOURS_MS
      if (!hasReaffirmationNote || staleReaffirmation) {
        reasons.push("reaffirmation_note_stale")
      }
    }
  }
  const sortedReasons = sortUnique(reasons)
  const note = input.note?.text.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.note?.actorId}: ${note}`]
    : (existing?.notes ?? [])
  let status: FilingEscalationRolloverBreachWatchStatus = existing?.status ?? "cleared"
  if (sortedReasons.length === 0) {
    status = "cleared"
  } else if (existing?.status === "acknowledged") {
    status = "acknowledged"
  } else {
    status = "open_breach"
  }
  return {
    id: filingEscalationRolloverBreachWatchId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    status,
    reasons: sortedReasons,
    linkedWaiverId: input.activeWaiver?.id ?? null,
    linkedAttestationId: input.latestAttestation?.id ?? null,
    linkedPolicyId: input.linkedPolicyId ?? null,
    policyCapExpiresAt: input.policyCapExpiresAt,
    waiverExpiresAt: input.activeWaiver?.expiresAt ?? null,
    attestationUpdatedAt: input.latestAttestation?.updatedAt ?? null,
    acknowledgedBy: status === "acknowledged" ? (existing?.acknowledgedBy ?? null) : null,
    acknowledgedAt: status === "acknowledged" ? (existing?.acknowledgedAt ?? null) : null,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
