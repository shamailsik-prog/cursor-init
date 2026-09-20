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
    lineageDisputeAttestationId?: string | null
    lineageDisputeDisposition?: TenancyLineageDisputeDisposition
    lineageReconciliationDigestId?: string | null
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
      lineageDisputeAttestationId: entry.lineageDisputeAttestationId ?? null,
      lineageDisputeDisposition: entry.lineageDisputeDisposition ?? "pending",
      lineageReconciliationDigestId: entry.lineageReconciliationDigestId ?? null,
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

function lineageRootForRow(row: TenancySessionReferenceRow): string {
  return row.lineageRootSessionReferenceId || row.id
}

function digestIdForRoot(lineageRootSessionReferenceId: string): string {
  return `tenancy_lineage_digest:${lineageRootSessionReferenceId}`
}

export function attestSessionReferenceLineageDispute(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    disputedSessionReferenceId: string
    reason: string
    reviewerId?: string | null
    reviewerNote?: string | null
    now?: number
  }
): {
  dispute: TenancyLineageDisputeAttestationRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const disputedReference = store.tenancySessionReferences.get(input.disputedSessionReferenceId)
  if (!disputedReference) throw new Error("unknown disputed session reference")
  if (disputedReference.firmId !== input.firmId) {
    throw new Error("cross-firm session reference denied")
  }
  const reason = input.reason.trim()
  if (!reason) throw new Error("lineage dispute reason is required")
  if (input.reviewerId) {
    const reviewer = store.users.get(input.reviewerId)
    if (!reviewer) throw new Error("unknown reviewer")
    if (reviewer.firmId !== input.firmId) throw new Error("cross-firm reviewer denied")
  }
  const now = input.now ?? Date.now()
  const dispute: TenancyLineageDisputeAttestationRow = {
    id: store.id("tld"),
    firmId: input.firmId,
    lineageRootSessionReferenceId: lineageRootForRow(disputedReference),
    disputedSessionReferenceId: disputedReference.id,
    disputedParentSessionReferenceId: disputedReference.parentSessionReferenceId,
    disputedUserId: disputedReference.userId,
    reason,
    reviewerId: input.reviewerId ?? null,
    reviewerNote: input.reviewerNote?.trim() || null,
    disposition: "pending",
    openedBy: actor.id,
    openedAt: now,
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    updatedAt: now,
  }
  store.tenancyLineageDisputeAttestations.set(dispute.id, dispute)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_attest_lineage_dispute",
    actorId: actor.id,
    target: disputedReference.userId,
    classification: actor.clearanceLevel,
    reason,
    authBoundary: disputedReference.authBoundary,
    sessionReferenceId: disputedReference.id,
    externalSessionId: disputedReference.externalSessionId,
    delegatedBoundaryLineageRootSessionReferenceId: dispute.lineageRootSessionReferenceId,
    delegatedBoundaryComparedSessionReferenceId: disputedReference.parentSessionReferenceId,
    delegatedBoundaryReconciliationStatus:
      disputedReference.delegatedBoundaryReconciliationStatus,
    delegatedBoundaryDivergenceReasons: disputedReference.delegatedBoundaryDivergenceReasons,
    lineageDisputeAttestationId: dispute.id,
    lineageDisputeDisposition: dispute.disposition,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { dispute, auditEntry }
}

export function resolveSessionReferenceLineageDispute(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    disputeId: string
    disposition: Exclude<TenancyLineageDisputeDisposition, "pending">
    resolutionNote?: string | null
    now?: number
  }
): {
  dispute: TenancyLineageDisputeAttestationRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const existing = store.tenancyLineageDisputeAttestations.get(input.disputeId)
  if (!existing) throw new Error("unknown lineage dispute")
  if (existing.firmId !== input.firmId) throw new Error("cross-firm lineage dispute denied")
  if (existing.disposition !== "pending") throw new Error("lineage dispute already resolved")
  const now = input.now ?? Date.now()
  const dispute: TenancyLineageDisputeAttestationRow = {
    ...existing,
    disposition: input.disposition,
    resolvedBy: actor.id,
    resolvedAt: now,
    resolutionNote: input.resolutionNote?.trim() || null,
    updatedAt: now,
  }
  store.tenancyLineageDisputeAttestations.set(dispute.id, dispute)
  const disputedReference = store.tenancySessionReferences.get(dispute.disputedSessionReferenceId)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_resolve_lineage_dispute",
    actorId: actor.id,
    target: dispute.disputedUserId,
    classification: actor.clearanceLevel,
    reason: dispute.resolutionNote ?? undefined,
    authBoundary: disputedReference?.authBoundary,
    sessionReferenceId: dispute.disputedSessionReferenceId,
    externalSessionId: disputedReference?.externalSessionId ?? null,
    delegatedBoundaryLineageRootSessionReferenceId: dispute.lineageRootSessionReferenceId,
    delegatedBoundaryComparedSessionReferenceId: dispute.disputedParentSessionReferenceId,
    delegatedBoundaryReconciliationStatus:
      disputedReference?.delegatedBoundaryReconciliationStatus,
    delegatedBoundaryDivergenceReasons: disputedReference?.delegatedBoundaryDivergenceReasons,
    lineageDisputeAttestationId: dispute.id,
    lineageDisputeDisposition: dispute.disposition,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { dispute, auditEntry }
}

export function listSessionReferenceLineageDisputes(
  store: SpineStore,
  actorId: string,
  firmId: string,
  lineageRootSessionReferenceId: string | undefined,
  disposition: TenancyLineageDisputeDisposition | undefined,
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
    .filter((row) => (disposition ? row.disposition === disposition : true))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: rows.length,
    nextCursor,
  }
}

function buildLineageReconciliationDigest(
  store: SpineStore,
  firmId: string,
  lineageRootSessionReferenceId: string,
  now: number
): TenancyLineageReconciliationDigestRow {
  const lineageRows = [...store.tenancySessionReferences.values()].filter(
    (row) => row.firmId === firmId && lineageRootForRow(row) === lineageRootSessionReferenceId
  )
  const lineageDisputes = [...store.tenancyLineageDisputeAttestations.values()].filter(
    (row) => row.firmId === firmId && row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
  )
  const openDisputeIds = lineageDisputes
    .filter((row) => row.disposition === "pending")
    .map((row) => row.id)
  const divergedSessionReferenceIds = lineageRows
    .filter((row) => row.delegatedBoundaryReconciliationStatus === "diverged")
    .map((row) => row.id)
  const resolvedDisputedSessionReferenceIds = new Set(
    lineageDisputes
      .filter((row) => row.disposition !== "pending")
      .map((row) => row.disputedSessionReferenceId)
  )
  const unresolvedRevocationSessionReferenceIds = lineageRows
    .filter((row) => row.revokedAt !== null)
    .filter((row) => !resolvedDisputedSessionReferenceIds.has(row.id))
    .map((row) => row.id)
  const digest: TenancyLineageReconciliationDigestRow = {
    id: digestIdForRoot(lineageRootSessionReferenceId),
    firmId,
    lineageRootSessionReferenceId,
    openDisputeCount: openDisputeIds.length,
    divergedHopCount: divergedSessionReferenceIds.length,
    unresolvedRevocationCount: unresolvedRevocationSessionReferenceIds.length,
    openDisputeIds,
    divergedSessionReferenceIds,
    unresolvedRevocationSessionReferenceIds,
    updatedAt: now,
  }
  store.tenancyLineageReconciliationDigests.set(digest.id, digest)
  return digest
}

export function reconcileSessionReferenceLineageDigests(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId?: string
    now?: number
  }
): TenancyLineageReconciliationDigestRow[] {
  requirePartnerInFirm(store, input.actorId, input.firmId)
  const now = input.now ?? Date.now()
  const lineageRoots = new Set<string>()
  for (const row of store.tenancySessionReferences.values()) {
    if (row.firmId !== input.firmId) continue
    lineageRoots.add(lineageRootForRow(row))
  }
  if (input.lineageRootSessionReferenceId) {
    if (!lineageRoots.has(input.lineageRootSessionReferenceId)) {
      throw new Error("unknown root session reference")
    }
    return [
      buildLineageReconciliationDigest(
        store,
        input.firmId,
        input.lineageRootSessionReferenceId,
        now
      ),
    ]
  }
  return [...lineageRoots.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((lineageRootSessionReferenceId) =>
      buildLineageReconciliationDigest(store, input.firmId, lineageRootSessionReferenceId, now)
    )
}

export function listSessionReferenceLineageReconciliationDigests(
  store: SpineStore,
  actorId: string,
  firmId: string,
  lineageRootSessionReferenceId: string | undefined,
  openDisputesOnly: boolean,
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
    .filter((row) =>
      lineageRootSessionReferenceId
        ? row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        : true
    )
    .filter((row) => (openDisputesOnly ? row.openDisputeCount > 0 : true))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: rows.length,
    nextCursor,
  }
}
