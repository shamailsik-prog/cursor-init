import type {
  FilingEscalationBreachWaiverLedgerRow,
  FilingEscalationPolicyBaselineRow,
  FilingEscalationPolicyBaselineScope,
  FilingEscalationWaiverStatus,
  FilingPackage,
} from "@/platform/spine/store"

export const DEFAULT_ESCALATION_OWNER_LOAD_THRESHOLD = 3
export const DEFAULT_ESCALATION_HANDOFF_SLA_MS = 4 * 60 * 60 * 1000
export const DEFAULT_ESCALATION_WAIVER_WINDOW_MS = 24 * 60 * 60 * 1000

export function filingEscalationPolicyBaselineId(input: {
  firmId: string
  packageId?: string | null
}): string {
  if (input.packageId) return `policy:${input.packageId}:override`
  return `policy:${input.firmId}:default`
}

export function filingEscalationWaiverLedgerId(packageId: string, sequenceNo: number): string {
  return `waiver:${packageId}:${sequenceNo}`
}

export function isFilingEscalationPolicyBaselineScope(
  value: string | null
): value is FilingEscalationPolicyBaselineScope {
  return value === "firm_default" || value === "package_override"
}

export function isFilingEscalationWaiverStatus(
  value: string | null
): value is FilingEscalationWaiverStatus {
  return value === "active" || value === "revoked" || value === "expired"
}

export function buildFilingEscalationPolicyBaselineRow(
  input: {
    firmId: string
    actorId: string
    packageId?: string | null
    matterId?: string | null
    classification: FilingPackage["classification"]
    ownerLoadThreshold?: number
    handoffSlaMs?: number
    waiverWindowMs?: number
    now?: number
    existing?: FilingEscalationPolicyBaselineRow | null
    note?: string | null
  }
): FilingEscalationPolicyBaselineRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const scope: FilingEscalationPolicyBaselineScope = input.packageId
    ? "package_override"
    : "firm_default"
  const note = input.note?.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.actorId}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationPolicyBaselineId({ firmId: input.firmId, packageId: input.packageId }),
    firmId: input.firmId,
    packageId: input.packageId ?? null,
    matterId: input.matterId ?? null,
    classification: input.classification,
    scope,
    ownerLoadThreshold:
      input.ownerLoadThreshold ??
      existing?.ownerLoadThreshold ??
      DEFAULT_ESCALATION_OWNER_LOAD_THRESHOLD,
    handoffSlaMs:
      input.handoffSlaMs ?? existing?.handoffSlaMs ?? DEFAULT_ESCALATION_HANDOFF_SLA_MS,
    waiverWindowMs:
      input.waiverWindowMs ?? existing?.waiverWindowMs ?? DEFAULT_ESCALATION_WAIVER_WINDOW_MS,
    setBy: input.actorId,
    setAt: now,
    notes,
    updatedAt: now,
  }
}

export function buildFilingEscalationWaiverLedgerRow(
  filingPackage: FilingPackage,
  input: {
    actorId: string
    sequenceNo: number
    reason: string
    durationMs: number
    now?: number
    linkedSlaDigestId?: string | null
    linkedWorkloadDigestId?: string | null
    note?: string | null
  }
): FilingEscalationBreachWaiverLedgerRow {
  const now = input.now ?? Date.now()
  const reason = input.reason.trim()
  const note = input.note?.trim()
  return {
    id: filingEscalationWaiverLedgerId(filingPackage.id, input.sequenceNo),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    status: "active",
    reason,
    grantedBy: input.actorId,
    grantedAt: now,
    expiresAt: now + input.durationMs,
    revokedBy: null,
    revokedAt: null,
    linkedSlaDigestId: input.linkedSlaDigestId ?? null,
    linkedWorkloadDigestId: input.linkedWorkloadDigestId ?? null,
    notes: note ? [`${new Date(now).toISOString()} ${input.actorId}: ${note}`] : [],
    updatedAt: now,
  }
}
