import { isClassification, type Classification } from "@/platform/p1/types"
import {
  rankOf,
  type Role,
  type SpineStore,
  type TenancyAuthBoundary,
  type TenancyLineageDisputeAttestationRow,
  type TenancyLineageDisputeDisposition,
  type TenancyLineageReconciliationDigestRow,
  type TenancySessionReferenceRow,
  type User,
} from "@/platform/spine/store"

const DEFAULT_SESSION_REFERENCE_TTL_MS = 8 * 60 * 60 * 1000

export type TenancySessionReferenceState = "active" | "revoked" | "expired"
export type TenancyDelegatedBoundaryReconciliationStatus = "aligned" | "diverged"
export type TenancyLineageDisputeStatus = "open" | "resolved"

function requirePartnerInFirm(store: SpineStore, actorId: string, firmId: string): User {
  const actor = store.users.get(actorId)
  if (!actor) throw new Error("unknown actor")
  if (actor.firmId !== firmId) throw new Error("cross-firm actor denied")
  if (actor.role !== "partner") throw new Error("partner role required")
  return actor
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
    privilegedBoundaryDriftCount?: number
    privilegedBoundaryDriftSessionReferenceIds?: string[]
    delegatedBoundaryLineageRootSessionReferenceId?: string | null
    delegatedBoundaryComparedSessionReferenceId?: string | null
    delegatedBoundaryReconciliationStatus?: TenancyDelegatedBoundaryReconciliationStatus
    delegatedBoundaryDivergenceReasons?: string[]
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
      privilegedBoundaryDriftCount: entry.privilegedBoundaryDriftCount ?? 0,
      privilegedBoundaryDriftSessionReferenceIds:
        entry.privilegedBoundaryDriftSessionReferenceIds ?? [],
      delegatedBoundaryLineageRootSessionReferenceId:
        entry.delegatedBoundaryLineageRootSessionReferenceId ?? null,
      delegatedBoundaryComparedSessionReferenceId:
        entry.delegatedBoundaryComparedSessionReferenceId ?? null,
      delegatedBoundaryReconciliationStatus:
        entry.delegatedBoundaryReconciliationStatus ?? "aligned",
      delegatedBoundaryDivergenceReasons: entry.delegatedBoundaryDivergenceReasons ?? [],
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
    privilegedBoundaryDriftCount?: number
    privilegedBoundaryDriftSessionReferenceIds?: string[]
    delegatedBoundaryLineageRootSessionReferenceId?: string | null
    delegatedBoundaryComparedSessionReferenceId?: string | null
    delegatedBoundaryReconciliationStatus?: TenancyDelegatedBoundaryReconciliationStatus
    delegatedBoundaryDivergenceReasons?: string[]
  }
): { user: User; auditEntry: NonNullable<SpineStore["audit"][number]> } {
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
    privilegedBoundaryDriftCount: input.privilegedBoundaryDriftCount ?? 0,
    privilegedBoundaryDriftSessionReferenceIds: input.privilegedBoundaryDriftSessionReferenceIds ?? [],
    delegatedBoundaryLineageRootSessionReferenceId:
      input.delegatedBoundaryLineageRootSessionReferenceId ?? null,
    delegatedBoundaryComparedSessionReferenceId:
      input.delegatedBoundaryComparedSessionReferenceId ?? null,
    delegatedBoundaryReconciliationStatus: input.delegatedBoundaryReconciliationStatus ?? "aligned",
    delegatedBoundaryDivergenceReasons: input.delegatedBoundaryDivergenceReasons ?? [],
    at: Date.now(),
  } as const
  store.audit.push(auditEntry)
  return { user: target, auditEntry }
}

export function getTenancySessionReferenceState(
  row: TenancySessionReferenceRow,
  now = Date.now()
): TenancySessionReferenceState {
  if (row.revokedAt) return "revoked"
  if (row.expiresAt !== null && row.expiresAt <= now) return "expired"
  return "active"
}

export function upsertTenancySessionReference(
  store: SpineStore,
  input: {
    user: User
    sessionReferenceId?: string
    existing?: TenancySessionReferenceRow | null
    parentSessionReferenceId?: string | null
    lineageRootSessionReferenceId?: string
    lineageDepth?: number
    authBoundary?: TenancyAuthBoundary
    externalSessionId?: string | null
    delegatedBoundaryComparedSessionReferenceId?: string | null
    delegatedBoundaryReconciliationStatus?: TenancyDelegatedBoundaryReconciliationStatus
    delegatedBoundaryDivergenceReasons?: string[]
    delegatedBoundaryReconciledAt?: number | null
    delegatedBoundaryReconciledBy?: string | null
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
  const lineageRootSessionReferenceId =
    input.lineageRootSessionReferenceId ?? existing?.lineageRootSessionReferenceId ?? id
  const lineageDepth = input.lineageDepth ?? existing?.lineageDepth ?? 0
  const expiresAt =
    input.ttlMs === null ? null : now + (input.ttlMs ?? DEFAULT_SESSION_REFERENCE_TTL_MS)
  const delegatedBoundaryDivergenceReasons = input.delegatedBoundaryDivergenceReasons ?? []
  const delegatedBoundaryReconciliationStatus =
    input.delegatedBoundaryReconciliationStatus ??
    existing?.delegatedBoundaryReconciliationStatus ??
    (delegatedBoundaryDivergenceReasons.length > 0 ? "diverged" : "aligned")
  const row: TenancySessionReferenceRow = {
    id,
    firmId: input.user.firmId,
    userId: input.user.id,
    roleSnapshot: input.user.role,
    clearanceSnapshot: input.user.clearanceLevel,
    parentSessionReferenceId: input.parentSessionReferenceId ?? existing?.parentSessionReferenceId ?? null,
    lineageRootSessionReferenceId,
    lineageDepth,
    authBoundary,
    externalSessionId,
    delegatedBoundaryComparedSessionReferenceId:
      input.delegatedBoundaryComparedSessionReferenceId ??
      existing?.delegatedBoundaryComparedSessionReferenceId ??
      null,
    delegatedBoundaryReconciliationStatus,
    delegatedBoundaryDivergenceReasons,
    delegatedBoundaryReconciledAt:
      input.delegatedBoundaryReconciledAt ??
      existing?.delegatedBoundaryReconciledAt ??
      (delegatedBoundaryDivergenceReasons.length > 0 ? now : null),
    delegatedBoundaryReconciledBy:
      input.delegatedBoundaryReconciledBy ??
      existing?.delegatedBoundaryReconciledBy ??
      (delegatedBoundaryDivergenceReasons.length > 0 ? input.user.id : null),
    issuedAt: existing?.issuedAt ?? now,
    lastSeenAt: now,
    expiresAt,
    revokedAt: existing?.revokedAt ?? null,
    revokedBy: existing?.revokedBy ?? null,
    revokedReason: existing?.revokedReason ?? null,
    privilegedBoundaryDriftedAt: existing?.privilegedBoundaryDriftedAt ?? null,
    privilegedBoundaryDriftedBy: existing?.privilegedBoundaryDriftedBy ?? null,
    privilegedBoundaryDriftReason: existing?.privilegedBoundaryDriftReason ?? null,
  }
  store.tenancySessionReferences.set(row.id, row)
  return row
}

function computeDelegatedBoundaryDivergenceReasons(
  parent: TenancySessionReferenceRow,
  child: Pick<
    TenancySessionReferenceRow,
    "authBoundary" | "externalSessionId" | "roleSnapshot" | "clearanceSnapshot"
  >
): string[] {
  const reasons: string[] = []
  if (parent.authBoundary !== child.authBoundary) reasons.push("auth_boundary_changed")
  if ((parent.externalSessionId ?? null) !== (child.externalSessionId ?? null)) {
    reasons.push("external_session_hint_changed")
  }
  if (parent.roleSnapshot !== child.roleSnapshot) reasons.push("role_snapshot_changed")
  if (parent.clearanceSnapshot !== child.clearanceSnapshot) {
    reasons.push("clearance_snapshot_changed")
  }
  return reasons
}

export function reissueTenancySessionReference(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    parentSessionReferenceId: string
    reason?: string
    authBoundary?: TenancyAuthBoundary
    externalSessionId?: string | null
    now?: number
    ttlMs?: number | null
  }
): {
  reference: TenancySessionReferenceRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const parent = store.tenancySessionReferences.get(input.parentSessionReferenceId)
  if (!parent) throw new Error("unknown session reference")
  if (parent.firmId !== input.firmId) throw new Error("cross-firm session reference denied")
  if (getTenancySessionReferenceState(parent, input.now) !== "active") {
    throw new Error("session reference is not active")
  }
  const user = store.users.get(parent.userId)
  if (!user) throw new Error("unknown session reference user")
  const nextAuthBoundary = input.authBoundary ?? parent.authBoundary
  const nextExternalSessionId =
    nextAuthBoundary === "external_session_hint"
      ? (input.externalSessionId ?? parent.externalSessionId ?? null)
      : null
  const divergenceReasons = computeDelegatedBoundaryDivergenceReasons(parent, {
    authBoundary: nextAuthBoundary,
    externalSessionId: nextExternalSessionId,
    roleSnapshot: user.role,
    clearanceSnapshot: user.clearanceLevel,
  })
  const now = input.now ?? Date.now()
  const reference = upsertTenancySessionReference(store, {
    user,
    parentSessionReferenceId: parent.id,
    lineageRootSessionReferenceId: parent.lineageRootSessionReferenceId || parent.id,
    lineageDepth: (parent.lineageDepth ?? 0) + 1,
    authBoundary: nextAuthBoundary,
    externalSessionId: nextExternalSessionId,
    delegatedBoundaryComparedSessionReferenceId: parent.id,
    delegatedBoundaryReconciliationStatus: divergenceReasons.length > 0 ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: divergenceReasons,
    delegatedBoundaryReconciledAt: now,
    delegatedBoundaryReconciledBy: actor.id,
    now,
    ttlMs: input.ttlMs,
  })
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_reissue_session_reference",
    actorId: actor.id,
    target: user.id,
    classification: actor.clearanceLevel,
    reason: input.reason,
    authBoundary: reference.authBoundary,
    sessionReferenceId: reference.id,
    externalSessionId: reference.externalSessionId,
    privilegedBoundaryDriftCount: 0,
    privilegedBoundaryDriftSessionReferenceIds: [],
    delegatedBoundaryLineageRootSessionReferenceId: reference.lineageRootSessionReferenceId,
    delegatedBoundaryComparedSessionReferenceId: parent.id,
    delegatedBoundaryReconciliationStatus: reference.delegatedBoundaryReconciliationStatus,
    delegatedBoundaryDivergenceReasons: reference.delegatedBoundaryDivergenceReasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { reference, auditEntry }
}

export function revokeTenancySessionReference(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    sessionReferenceId: string
    reason?: string
    now?: number
  }
): {
  reference: TenancySessionReferenceRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const reference = store.tenancySessionReferences.get(input.sessionReferenceId)
  if (!reference) throw new Error("unknown session reference")
  if (reference.firmId !== input.firmId) throw new Error("cross-firm session reference denied")
  const now = input.now ?? Date.now()
  const revoked =
    reference.revokedAt !== null
      ? reference
      : {
          ...reference,
          revokedAt: now,
          revokedBy: actor.id,
          revokedReason: input.reason ?? "admin_revocation",
        }
  store.tenancySessionReferences.set(revoked.id, revoked)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_revoke_session_reference",
    actorId: actor.id,
    target: revoked.userId,
    classification: actor.clearanceLevel,
    reason: input.reason,
    authBoundary: revoked.authBoundary,
    sessionReferenceId: revoked.id,
    externalSessionId: revoked.externalSessionId,
    privilegedBoundaryDriftCount: 0,
    privilegedBoundaryDriftSessionReferenceIds: [],
    delegatedBoundaryLineageRootSessionReferenceId: revoked.lineageRootSessionReferenceId,
    delegatedBoundaryComparedSessionReferenceId:
      revoked.delegatedBoundaryComparedSessionReferenceId,
    delegatedBoundaryReconciliationStatus: revoked.delegatedBoundaryReconciliationStatus,
    delegatedBoundaryDivergenceReasons: revoked.delegatedBoundaryDivergenceReasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { reference: revoked, auditEntry }
}

export function invalidateSessionReferencesForPrivilegeDrift(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    targetUserId: string
    targetRole: Role
    targetClearance: Classification
    now?: number
  }
): TenancySessionReferenceRow[] {
  requirePartnerInFirm(store, input.actorId, input.firmId)
  const now = input.now ?? Date.now()
  const updatedRows: TenancySessionReferenceRow[] = []
  for (const row of store.tenancySessionReferences.values()) {
    if (row.firmId !== input.firmId || row.userId !== input.targetUserId) continue
    if (row.revokedAt !== null) continue
    const state = getTenancySessionReferenceState(row, now)
    if (state === "expired") continue
    if (row.roleSnapshot === input.targetRole && row.clearanceSnapshot === input.targetClearance) {
      continue
    }
    const invalidated = {
      ...row,
      revokedAt: now,
      revokedBy: input.actorId,
      revokedReason: "privileged_boundary_drift",
      privilegedBoundaryDriftedAt: now,
      privilegedBoundaryDriftedBy: input.actorId,
      privilegedBoundaryDriftReason: "role_or_clearance_changed",
    }
    store.tenancySessionReferences.set(invalidated.id, invalidated)
    updatedRows.push(invalidated)
  }
  return updatedRows
}

export function listFirmSessionReferences(
  store: SpineStore,
  actorId: string,
  firmId: string,
  userId: string | undefined,
  limit: number,
  cursor: number
): {
  items: Array<TenancySessionReferenceRow & { state: TenancySessionReferenceState }>
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const now = Date.now()
  const rows = [...store.tenancySessionReferences.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) => (userId ? row.userId === userId : true))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page.map((row) => ({
      ...row,
      state: getTenancySessionReferenceState(row, now),
    })),
    total: rows.length,
    nextCursor,
  }
}

export function listSessionReferenceLineage(
  store: SpineStore,
  actorId: string,
  firmId: string,
  rootSessionReferenceId: string,
  delegatedDivergedOnly: boolean,
  limit: number,
  cursor: number
): {
  items: Array<TenancySessionReferenceRow & { state: TenancySessionReferenceState }>
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const root = store.tenancySessionReferences.get(rootSessionReferenceId)
  if (!root) throw new Error("unknown root session reference")
  if (root.firmId !== firmId) throw new Error("cross-firm session reference denied")
  const now = Date.now()
  const rows = [...store.tenancySessionReferences.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) => (row.lineageRootSessionReferenceId || row.id) === rootSessionReferenceId)
    .filter((row) =>
      delegatedDivergedOnly ? row.delegatedBoundaryReconciliationStatus === "diverged" : true
    )
    .sort((a, b) => {
      if (a.lineageDepth !== b.lineageDepth) return a.lineageDepth - b.lineageDepth
      if (a.issuedAt !== b.issuedAt) return a.issuedAt - b.issuedAt
      return a.id.localeCompare(b.id)
    })
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page.map((row) => ({
      ...row,
      state: getTenancySessionReferenceState(row, now),
    })),
    total: rows.length,
    nextCursor,
  }
}

export function listSessionLineageDisputes(
  store: SpineStore,
  actorId: string,
  firmId: string,
  lineageRootSessionReferenceId: string | undefined,
  status: TenancyLineageDisputeStatus | undefined,
  limit: number,
  cursor: number
): {
  items: TenancyLineageDisputeAttestationRow[]
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const rows = [...store.tenancyLineageDisputeAttestations.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) =>
      lineageRootSessionReferenceId
        ? row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        : true
    )
    .filter((row) => (status ? row.status === status : true))
    .sort((a, b) => b.raisedAt - a.raisedAt || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: rows.length,
    nextCursor,
  }
}

export function attestSessionLineageDispute(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    sessionReferenceId: string
    reason: string
    note?: string
    now?: number
  }
): {
  dispute: TenancyLineageDisputeAttestationRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const sessionReference = store.tenancySessionReferences.get(input.sessionReferenceId)
  if (!sessionReference) throw new Error("unknown session reference")
  if (sessionReference.firmId !== input.firmId) throw new Error("cross-firm session reference denied")
  const reason = input.reason.trim()
  if (!reason) throw new Error("reason is required")
  const now = input.now ?? Date.now()
  const dispute: TenancyLineageDisputeAttestationRow = {
    id: store.id("tld"),
    firmId: input.firmId,
    lineageRootSessionReferenceId: sessionReference.lineageRootSessionReferenceId,
    sessionReferenceId: sessionReference.id,
    parentSessionReferenceId: sessionReference.parentSessionReferenceId,
    raisedBy: actor.id,
    raisedAt: now,
    reason,
    notes: input.note ? [input.note] : [],
    status: "open",
    reviewedBy: null,
    reviewedAt: null,
    disposition: null,
    resolutionNote: null,
  }
  store.tenancyLineageDisputeAttestations.set(dispute.id, dispute)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_attest_lineage_dispute",
    actorId: actor.id,
    target: sessionReference.userId,
    classification: actor.clearanceLevel,
    reason,
    authBoundary: sessionReference.authBoundary,
    sessionReferenceId: sessionReference.id,
    externalSessionId: sessionReference.externalSessionId,
    privilegedBoundaryDriftCount: 0,
    privilegedBoundaryDriftSessionReferenceIds: [],
    delegatedBoundaryLineageRootSessionReferenceId: sessionReference.lineageRootSessionReferenceId,
    delegatedBoundaryComparedSessionReferenceId:
      sessionReference.delegatedBoundaryComparedSessionReferenceId,
    delegatedBoundaryReconciliationStatus:
      sessionReference.delegatedBoundaryReconciliationStatus,
    delegatedBoundaryDivergenceReasons: sessionReference.delegatedBoundaryDivergenceReasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { dispute, auditEntry }
}

export function resolveSessionLineageDispute(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    disputeId: string
    disposition: TenancyLineageDisputeDisposition
    resolutionNote?: string
    now?: number
  }
): {
  dispute: TenancyLineageDisputeAttestationRow
  relatedSessionReference: TenancySessionReferenceRow | null
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const dispute = store.tenancyLineageDisputeAttestations.get(input.disputeId)
  if (!dispute) throw new Error("unknown lineage dispute")
  if (dispute.firmId !== input.firmId) throw new Error("cross-firm dispute denied")
  const now = input.now ?? Date.now()
  const resolved: TenancyLineageDisputeAttestationRow = {
    ...dispute,
    status: "resolved",
    reviewedBy: actor.id,
    reviewedAt: now,
    disposition: input.disposition,
    resolutionNote: input.resolutionNote ?? null,
  }
  store.tenancyLineageDisputeAttestations.set(resolved.id, resolved)

  let relatedSessionReference = store.tenancySessionReferences.get(dispute.sessionReferenceId) ?? null
  if (relatedSessionReference && input.disposition === "mark_reconciled") {
    relatedSessionReference = {
      ...relatedSessionReference,
      delegatedBoundaryReconciliationStatus: "aligned",
      delegatedBoundaryDivergenceReasons: [],
      delegatedBoundaryReconciledAt: now,
      delegatedBoundaryReconciledBy: actor.id,
    }
    store.tenancySessionReferences.set(relatedSessionReference.id, relatedSessionReference)
  }

  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_resolve_lineage_dispute",
    actorId: actor.id,
    target: relatedSessionReference?.userId ?? dispute.sessionReferenceId,
    classification: actor.clearanceLevel,
    reason: input.resolutionNote,
    authBoundary: relatedSessionReference?.authBoundary,
    sessionReferenceId: relatedSessionReference?.id ?? dispute.sessionReferenceId,
    externalSessionId: relatedSessionReference?.externalSessionId,
    privilegedBoundaryDriftCount: 0,
    privilegedBoundaryDriftSessionReferenceIds: [],
    delegatedBoundaryLineageRootSessionReferenceId: dispute.lineageRootSessionReferenceId,
    delegatedBoundaryComparedSessionReferenceId:
      relatedSessionReference?.delegatedBoundaryComparedSessionReferenceId ?? null,
    delegatedBoundaryReconciliationStatus:
      relatedSessionReference?.delegatedBoundaryReconciliationStatus ??
      (input.disposition === "mark_reconciled" ? "aligned" : "diverged"),
    delegatedBoundaryDivergenceReasons:
      relatedSessionReference?.delegatedBoundaryDivergenceReasons ?? [],
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { dispute: resolved, relatedSessionReference, auditEntry }
}

export function recomputeLineageReconciliationDigest(
  store: SpineStore,
  input: {
    firmId: string
    lineageRootSessionReferenceId: string
    now?: number
  }
): TenancyLineageReconciliationDigestRow {
  const now = input.now ?? Date.now()
  const references = [...store.tenancySessionReferences.values()].filter(
    (row) =>
      row.firmId === input.firmId &&
      (row.lineageRootSessionReferenceId || row.id) === input.lineageRootSessionReferenceId
  )
  const disputes = [...store.tenancyLineageDisputeAttestations.values()].filter(
    (row) =>
      row.firmId === input.firmId &&
      row.lineageRootSessionReferenceId === input.lineageRootSessionReferenceId
  )
  const openDisputeCount = disputes.filter((row) => row.status === "open").length
  const resolvedDisputeCount = disputes.filter((row) => row.status === "resolved").length
  const divergedHopCount = references.filter(
    (row) => row.delegatedBoundaryReconciliationStatus === "diverged"
  ).length
  const unresolvedRevocationCount = references.filter((row) => row.revokedAt !== null).length
  const lineageDepthMax = references.reduce(
    (maxDepth, row) => Math.max(maxDepth, row.lineageDepth ?? 0),
    0
  )
  const reasons: string[] = []
  if (openDisputeCount > 0) reasons.push("open_lineage_dispute")
  if (divergedHopCount > 0) reasons.push("delegated_boundary_divergence")
  if (unresolvedRevocationCount > 0) reasons.push("revoked_session_reference")
  const row: TenancyLineageReconciliationDigestRow = {
    id: `tenancy-lineage-digest:${input.lineageRootSessionReferenceId}`,
    firmId: input.firmId,
    lineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    lineageNodeCount: references.length,
    lineageDepthMax,
    divergedHopCount,
    openDisputeCount,
    resolvedDisputeCount,
    unresolvedRevocationCount,
    status: reasons.length > 0 ? "needs_review" : "aligned",
    reasons,
    updatedAt: now,
  }
  store.tenancyLineageReconciliationDigests.set(row.id, row)
  return row
}

export function listLineageReconciliationDigests(
  store: SpineStore,
  actorId: string,
  firmId: string,
  status: "aligned" | "needs_review" | undefined,
  limit: number,
  cursor: number
): {
  items: TenancyLineageReconciliationDigestRow[]
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const rows = [...store.tenancyLineageReconciliationDigests.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) => (status ? row.status === status : true))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: rows.length,
    nextCursor,
  }
}
