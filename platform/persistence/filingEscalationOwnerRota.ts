import type {
  FilingEscalationOwnerRotaRow,
  FilingEscalationOwnerRotaStatus,
  FilingPackage,
} from "@/platform/spine/store"

const DEFAULT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000

export function filingEscalationOwnerRotaId(packageId: string): string {
  return `rota:${packageId}`
}

export function isFilingEscalationOwnerRotaStatus(
  value: string | null
): value is FilingEscalationOwnerRotaStatus {
  return value === "active" || value === "handoff_acknowledged" || value === "revoked"
}

export function buildFilingEscalationOwnerRotaRow(
  filingPackage: FilingPackage,
  input: {
    now?: number
    existing?: FilingEscalationOwnerRotaRow | null
    primaryOwnerId?: string | null
    backupOwnerId?: string | null
    linkedExceptionId?: string | null
    linkedDigestId?: string | null
    activeWindowMs?: number
    actorId?: string | null
    note?: string | null
  }
): FilingEscalationOwnerRotaRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const primaryOwnerId =
    input.primaryOwnerId !== undefined
      ? input.primaryOwnerId
      : (existing?.primaryOwnerId ?? null)
  const backupOwnerId =
    input.backupOwnerId !== undefined
      ? input.backupOwnerId
      : (existing?.backupOwnerId ?? null)
  const status: FilingEscalationOwnerRotaStatus =
    existing?.status ?? (primaryOwnerId || backupOwnerId ? "active" : "revoked")
  const note = input.note?.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.actorId ?? "system"}: ${note}`]
    : (existing?.notes ?? [])
  return {
    id: filingEscalationOwnerRotaId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    status,
    primaryOwnerId,
    backupOwnerId,
    activeWindowStartAt: existing?.activeWindowStartAt ?? now,
    activeWindowEndAt:
      existing?.activeWindowEndAt ??
      (primaryOwnerId || backupOwnerId
        ? now + (input.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS)
        : null),
    handoffRequired: existing?.handoffRequired ?? false,
    handoffAcknowledgedBy: existing?.handoffAcknowledgedBy ?? null,
    handoffAcknowledgedAt: existing?.handoffAcknowledgedAt ?? null,
    lastAssignedBy: existing?.lastAssignedBy ?? null,
    lastAssignedAt: existing?.lastAssignedAt ?? null,
    revokedBy: existing?.revokedBy ?? null,
    revokedAt: existing?.revokedAt ?? null,
    linkedExceptionId:
      input.linkedExceptionId !== undefined
        ? input.linkedExceptionId
        : (existing?.linkedExceptionId ?? null),
    linkedDigestId:
      input.linkedDigestId !== undefined
        ? input.linkedDigestId
        : (existing?.linkedDigestId ?? null),
    notes,
    updatedAt: now,
  }
}
