import { isClassification, type Classification } from "@/platform/p1/types"
import {
  rankOf,
  type Role,
  type SpineStore,
  type TenancyAuthBoundary,
  type TenancySessionReferenceRow,
  type User,
} from "@/platform/spine/store"

const DEFAULT_SESSION_REFERENCE_TTL_MS = 8 * 60 * 60 * 1000
const SESSION_REFERENCE_EXPIRY_REASON = "expired_enforced"
const SESSION_REFERENCE_DRIFT_REASON = "privileged_boundary_drift"

export type TenancySessionReferenceState = "active" | "expired" | "revoked" | "drifted"

function requirePartnerInFirm(store: SpineStore, actorId: string, firmId: string): User {
  const actor = store.users.get(actorId)
  if (!actor) throw new Error("unknown actor")
  if (actor.firmId !== firmId) throw new Error("cross-firm actor denied")
  if (actor.role !== "partner") throw new Error("partner role required")
  return actor
}

export function assertPartnerInFirm(store: SpineStore, actorId: string, firmId: string): User {
  return requirePartnerInFirm(store, actorId, firmId)
}

export function buildSessionContext(
  store: SpineStore,
  userId: string,
  firmId?: string
): {
  user: User
  firmId: string
  accessibleMatterIds: string[]
} {
  const user = store.users.get(userId)
  if (!user) throw new Error("unknown user")
  if (firmId && firmId !== user.firmId) throw new Error("firm scope mismatch")
  const accessibleMatterIds =
    user.role === "client"
      ? [...store.matters.values()]
          .filter((matter) => matter.firmId === user.firmId && matter.clientId === user.id)
          .map((matter) => matter.id)
      : [...store.members.values()]
          .filter((member) => member.userId === user.id && member.firmId === user.firmId)
          .map((member) => member.matterId)
  return {
    user,
    firmId: user.firmId,
    accessibleMatterIds: [...new Set(accessibleMatterIds)].sort(),
  }
}

export function listFirmUsers(
  store: SpineStore,
  actorId: string,
  firmId: string,
  limit: number,
  cursor: number
): {
  items: Array<{
    id: string
    role: Role
    clearanceLevel: Classification
  }>
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const users = [...store.users.values()]
    .filter((user) => user.firmId === firmId)
    .sort((a, b) => a.id.localeCompare(b.id))
  const page = users.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < users.length ? String(cursor + page.length) : null
  return {
    items: page.map((user) => ({
      id: user.id,
      role: user.role,
      clearanceLevel: user.clearanceLevel,
    })),
    total: users.length,
    nextCursor,
  }
}

export function listFirmMemberships(
  store: SpineStore,
  actorId: string,
  firmId: string,
  matterId: string | undefined,
  limit: number,
  cursor: number
): {
  items: Array<{ matterId: string; userId: string; firmId: string }>
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const memberships = [...store.members.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) => (matterId ? row.matterId === matterId : true))
    .sort((a, b) =>
      a.matterId === b.matterId
        ? a.userId.localeCompare(b.userId)
        : a.matterId.localeCompare(b.matterId)
    )
  const page = memberships.slice(cursor, cursor + limit)
  const nextCursor =
    cursor + page.length < memberships.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: memberships.length,
    nextCursor,
  }
}

export function listFirmAudit(
  store: SpineStore,
  actorId: string,
  firmId: string,
  limit: number,
  cursor: number
): {
  items: Array<{
    id: string
    action: string
    actorId: string
    target: string
    classification: Classification
    reason?: string
    authBoundary?: TenancyAuthBoundary
    sessionReferenceId?: string | null
    externalSessionId?: string | null
    at: number
  }>
  total: number
  nextCursor: string | null
} {
  const actor = requirePartnerInFirm(store, actorId, firmId)
  const rows = store.audit
    .filter((entry) => entry.firmId === firmId)
    .filter((entry) => rankOf(entry.classification) <= rankOf(actor.clearanceLevel))
    .map((entry) => ({
      id: entry.id ?? "",
      action: entry.action,
      actorId: entry.actorId,
      target: entry.target,
      classification: entry.classification,
      reason: entry.reason,
      authBoundary: entry.authBoundary,
      sessionReferenceId: entry.sessionReferenceId ?? null,
      externalSessionId: entry.externalSessionId ?? null,
      at: entry.at ?? 0,
    }))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: rows.length,
    nextCursor,
  }
}

export function updateUserRole(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    targetUserId: string
    nextRole: Role
    nextClearance: Classification
    reason?: string
    authBoundary?: TenancyAuthBoundary
    sessionReferenceId?: string | null
    externalSessionId?: string | null
  }
): {
  user: User
  previousRole: Role
  previousClearance: Classification
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const target = store.users.get(input.targetUserId)
  if (!target) throw new Error("unknown target user")
  if (target.firmId !== input.firmId) throw new Error("cross-firm target denied")
  if (!isClassification(input.nextClearance)) {
    throw new Error("nextClearance must be a rank-0–4 label")
  }
  if (input.nextRole === "partner" && target.role !== "partner") {
    throw new Error("partner promotion is blocked in this surface")
  }
  if (rankOf(input.nextClearance) > rankOf(actor.clearanceLevel)) {
    throw new Error("cannot assign clearance above actor level")
  }
  if (input.nextRole === "client" && rankOf(input.nextClearance) > rankOf("internal")) {
    throw new Error("client clearance may not exceed internal")
  }
  const previousRole = target.role
  const previousClearance = target.clearanceLevel
  target.role = input.nextRole
  target.clearanceLevel = input.nextClearance
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_update_role",
    actorId: actor.id,
    target: target.id,
    classification: target.clearanceLevel,
    reason: input.reason,
    authBoundary: input.authBoundary,
    sessionReferenceId: input.sessionReferenceId ?? null,
    externalSessionId: input.externalSessionId ?? null,
    at: Date.now(),
  } as const
  store.audit.push(auditEntry)
  return { user: target, previousRole, previousClearance, auditEntry }
}

function inferDriftReason(
  roleSnapshot: Role,
  clearanceSnapshot: Classification,
  user: User
): TenancySessionReferenceRow["driftReason"] {
  const roleChanged = roleSnapshot !== user.role
  const clearanceChanged = clearanceSnapshot !== user.clearanceLevel
  if (roleChanged && clearanceChanged) return "role_and_clearance_changed"
  if (roleChanged) return "role_changed"
  if (clearanceChanged) return "clearance_changed"
  return null
}

export function getTenancySessionReferenceState(
  row: TenancySessionReferenceRow,
  user: User,
  now = Date.now()
): TenancySessionReferenceState {
  if (row.driftedAt) return "drifted"
  if (inferDriftReason(row.roleSnapshot, row.clearanceSnapshot, user)) return "drifted"
  if (row.expiresAt != null && row.expiresAt <= now) return "expired"
  if (row.revokedAt) return "revoked"
  return "active"
}

export function assertUsableTenancySessionReference(
  row: TenancySessionReferenceRow,
  user: User,
  now = Date.now()
): void {
  const state = getTenancySessionReferenceState(row, user, now)
  if (state === "active") return
  if (state === "expired") {
    throw new Error("expired session reference")
  }
  if (state === "revoked") {
    throw new Error("revoked session reference")
  }
  throw new Error("privileged-boundary drift invalidated session reference")
}

export function revokeTenancySessionReference(
  store: SpineStore,
  input: {
    row: TenancySessionReferenceRow
    actorId: string
    reason?: string
    now?: number
  }
): TenancySessionReferenceRow {
  const now = input.now ?? Date.now()
  const row: TenancySessionReferenceRow = {
    ...input.row,
    revokedAt: input.row.revokedAt ?? now,
    revokedBy: input.row.revokedBy ?? input.actorId,
    revocationReason: input.reason ?? input.row.revocationReason ?? "admin_revocation",
  }
  store.tenancySessionReferences.set(row.id, row)
  return row
}

export function invalidateSessionReferencesForPrivilegeDrift(
  store: SpineStore,
  input: {
    actorId: string
    updatedUser: User
    auditEntryId: string
    now?: number
    excludeReferenceIds?: string[]
  }
): Array<{ id: string; driftReason: NonNullable<TenancySessionReferenceRow["driftReason"]> }> {
  const now = input.now ?? Date.now()
  const excluded = new Set(input.excludeReferenceIds ?? [])
  const invalidated: Array<{ id: string; driftReason: NonNullable<TenancySessionReferenceRow["driftReason"]> }> =
    []
  for (const row of store.tenancySessionReferences.values()) {
    if (row.userId !== input.updatedUser.id || row.firmId !== input.updatedUser.firmId) continue
    if (excluded.has(row.id)) continue
    const driftReason = inferDriftReason(row.roleSnapshot, row.clearanceSnapshot, input.updatedUser)
    if (!driftReason) continue
    const next: TenancySessionReferenceRow = {
      ...row,
      revokedAt: row.revokedAt ?? now,
      revokedBy: row.revokedBy ?? input.actorId,
      revocationReason: row.revocationReason ?? SESSION_REFERENCE_DRIFT_REASON,
      driftedAt: row.driftedAt ?? now,
      driftedBy: input.actorId,
      driftReason,
      driftFromRole: row.driftFromRole ?? row.roleSnapshot,
      driftToRole: input.updatedUser.role,
      driftFromClearance: row.driftFromClearance ?? row.clearanceSnapshot,
      driftToClearance: input.updatedUser.clearanceLevel,
      driftAuditEntryId: input.auditEntryId,
    }
    store.tenancySessionReferences.set(next.id, next)
    invalidated.push({ id: next.id, driftReason })
  }
  return invalidated
}

export function enforceFirmSessionReferenceExpiry(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    now?: number
  }
): string[] {
  requirePartnerInFirm(store, input.actorId, input.firmId)
  const now = input.now ?? Date.now()
  const revoked: string[] = []
  for (const row of store.tenancySessionReferences.values()) {
    if (row.firmId !== input.firmId) continue
    if (row.expiresAt == null || row.expiresAt > now) continue
    if (row.revokedAt || row.driftedAt) continue
    const next = revokeTenancySessionReference(store, {
      row,
      actorId: input.actorId,
      reason: SESSION_REFERENCE_EXPIRY_REASON,
      now,
    })
    revoked.push(next.id)
  }
  return revoked
}

export function upsertTenancySessionReference(
  store: SpineStore,
  input: {
    user: User
    sessionReferenceId?: string
    existing?: TenancySessionReferenceRow | null
    authBoundary?: TenancyAuthBoundary
    externalSessionId?: string | null
    now?: number
    ttlMs?: number | null
  }
): TenancySessionReferenceRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  if (existing && existing.userId !== input.user.id) {
    throw new Error("session reference user mismatch")
  }
  if (existing && existing.firmId !== input.user.firmId) {
    throw new Error("cross-firm session reference denied")
  }
  const authBoundary = input.authBoundary ?? existing?.authBoundary ?? "runtime_local"
  const rawExternalSessionId = input.externalSessionId ?? existing?.externalSessionId ?? null
  const externalSessionId =
    authBoundary === "external_session_hint"
      ? rawExternalSessionId?.trim() || null
      : null
  const id = existing?.id ?? input.sessionReferenceId ?? store.id("tsr")
  const expiresAt =
    input.ttlMs === null ? null : now + (input.ttlMs ?? DEFAULT_SESSION_REFERENCE_TTL_MS)
  const row: TenancySessionReferenceRow = {
    id,
    firmId: input.user.firmId,
    userId: input.user.id,
    roleSnapshot: input.user.role,
    clearanceSnapshot: input.user.clearanceLevel,
    authBoundary,
    externalSessionId,
    issuedAt: existing?.issuedAt ?? now,
    lastSeenAt: now,
    expiresAt,
    revokedAt: existing?.revokedAt ?? null,
    revokedBy: existing?.revokedBy ?? null,
    revocationReason: existing?.revocationReason ?? null,
    driftedAt: existing?.driftedAt ?? null,
    driftedBy: existing?.driftedBy ?? null,
    driftReason: existing?.driftReason ?? null,
    driftFromRole: existing?.driftFromRole ?? null,
    driftToRole: existing?.driftToRole ?? null,
    driftFromClearance: existing?.driftFromClearance ?? null,
    driftToClearance: existing?.driftToClearance ?? null,
    driftAuditEntryId: existing?.driftAuditEntryId ?? null,
  }
  store.tenancySessionReferences.set(row.id, row)
  return row
}

export function listFirmSessionReferences(
  store: SpineStore,
  actorId: string,
  firmId: string,
  userId: string | undefined,
  limit: number,
  cursor: number
): {
  items: TenancySessionReferenceRow[]
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const rows = [...store.tenancySessionReferences.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) => (userId ? row.userId === userId : true))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: rows.length,
    nextCursor,
  }
}
