import { isClassification, type Classification } from "@/platform/p1/types"
import {
  rankOf,
  type Role,
  type SpineStore,
  type TenancyAuthBoundary,
  type TenancyLineageArbitrationDebtRetirementLedgerRow,
  type TenancyLineageArbitrationDebtRetirementStatus,
  type TenancyLineageClosureAdjudicationRow,
  type TenancyLineageClosureAdjudicationStatus,
  type TenancyLineageDisputeAttestationRow,
  type TenancyLineageDisputeDisposition,
  type TenancyLineageReconciliationDigestRow,
  type TenancyLineageReconciliationQueueArbitrationDisposition,
  type TenancyLineageReconciliationQueueArbitrationRow,
  type TenancyLineageDigestClosureCheckpointRow,
  type TenancySessionReferenceRow,
  type User,
} from "@/platform/spine/store"

const DEFAULT_SESSION_REFERENCE_TTL_MS = 8 * 60 * 60 * 1000

export type TenancySessionReferenceState = "active" | "revoked" | "expired"
export type TenancyDelegatedBoundaryReconciliationStatus = "aligned" | "diverged"
export type TenancyLineageDisputeStatus = "open" | "resolved"
export type TenancyLineageReconciliationQueueArbitrationStatus =
  TenancyLineageReconciliationQueueArbitrationRow["status"]
export type TenancyLineageDigestClosureCheckpointStatus =
  TenancyLineageDigestClosureCheckpointRow["status"]
export type TenancyClosureAdjudicationStatus = TenancyLineageClosureAdjudicationStatus
export type TenancyArbitrationDebtRetirementStatus =
  TenancyLineageArbitrationDebtRetirementStatus

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

function lineageDigestId(lineageRootSessionReferenceId: string): string {
  return `tenancy-lineage-digest:${lineageRootSessionReferenceId}`
}

function lineageArbitrationQueueId(lineageRootSessionReferenceId: string): string {
  return `tenancy-lineage-arbitration:${lineageRootSessionReferenceId}`
}

function lineageClosureCheckpointId(lineageRootSessionReferenceId: string): string {
  return `tenancy-lineage-closure:${lineageRootSessionReferenceId}`
}

function lineageClosureAdjudicationId(lineageRootSessionReferenceId: string): string {
  return `tenancy-lineage-closure-adjudication:${lineageRootSessionReferenceId}`
}

function lineageArbitrationDebtRetirementLedgerId(lineageRootSessionReferenceId: string): string {
  return `tenancy-lineage-arbitration-debt:${lineageRootSessionReferenceId}`
}

function computeLineageDispositionDriftReasons(input: {
  digest: TenancyLineageReconciliationDigestRow
  queue: TenancyLineageReconciliationQueueArbitrationRow
  checkpoint: TenancyLineageDigestClosureCheckpointRow
}): string[] {
  const reasons: string[] = []
  if (input.checkpoint.status === "reopened") {
    reasons.push("closure_checkpoint_reopened")
  }
  if (input.checkpoint.reopenTrigger) {
    reasons.push(`closure_reopen_trigger:${input.checkpoint.reopenTrigger}`)
  }
  if (input.queue.disposition === "dismiss_needs_review" && input.digest.status === "needs_review") {
    reasons.push("queue_dismissed_while_digest_needs_review")
  }
  if (input.queue.disposition === "confirm_needs_review" && input.digest.status === "aligned") {
    reasons.push("queue_confirmed_review_while_digest_aligned")
  }
  return [...new Set(reasons)]
}

function computeLineageCarryoverSignals(input: {
  digest: TenancyLineageReconciliationDigestRow
  queue: TenancyLineageReconciliationQueueArbitrationRow
  checkpoint: TenancyLineageDigestClosureCheckpointRow
}): string[] {
  const signals: string[] = []
  if (input.digest.status === "needs_review") signals.push("digest_needs_review")
  if (input.digest.openDisputeCount > 0) signals.push("open_dispute_pressure")
  if (input.digest.unresolvedRevocationCount > 0) signals.push("revocation_pressure")
  if (!input.queue.assignedPartnerId) signals.push("owner_assignment_debt")
  if (input.checkpoint.status === "reopened") signals.push("closure_checkpoint_reopened")
  if (input.checkpoint.reopenTrigger) {
    signals.push(`closure_reopen_trigger:${input.checkpoint.reopenTrigger}`)
  }
  return [...new Set(signals)]
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
    id: lineageDigestId(input.lineageRootSessionReferenceId),
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

export function ensureLineageReconciliationMonitoringRows(
  store: SpineStore,
  input: {
    firmId: string
    digest: TenancyLineageReconciliationDigestRow
    now?: number
  }
): {
  arbitrationQueue: TenancyLineageReconciliationQueueArbitrationRow
  closureCheckpoint: TenancyLineageDigestClosureCheckpointRow
  closureAdjudication: TenancyLineageClosureAdjudicationRow
  arbitrationDebtRetirementLedger: TenancyLineageArbitrationDebtRetirementLedgerRow
} {
  const now = input.now ?? Date.now()
  const queueId = lineageArbitrationQueueId(input.digest.lineageRootSessionReferenceId)
  const existingQueue = store.tenancyLineageReconciliationQueueArbitrations.get(queueId)
  const digestRegressedToNeedsReview =
    existingQueue?.digestStatus !== "needs_review" && input.digest.status === "needs_review"
  const queue: TenancyLineageReconciliationQueueArbitrationRow = existingQueue
    ? {
        ...existingQueue,
        digestId: input.digest.id,
        digestStatus: input.digest.status,
        status:
          digestRegressedToNeedsReview && existingQueue.status === "arbitrated"
            ? existingQueue.assignedPartnerId
              ? "assigned"
              : "queued"
            : existingQueue.status,
        disposition:
          digestRegressedToNeedsReview && existingQueue.status === "arbitrated"
            ? null
            : existingQueue.disposition,
        dispositionBy:
          digestRegressedToNeedsReview && existingQueue.status === "arbitrated"
            ? null
            : existingQueue.dispositionBy,
        dispositionAt:
          digestRegressedToNeedsReview && existingQueue.status === "arbitrated"
            ? null
            : existingQueue.dispositionAt,
        updatedAt: now,
      }
    : {
        id: queueId,
        firmId: input.firmId,
        lineageRootSessionReferenceId: input.digest.lineageRootSessionReferenceId,
        digestId: input.digest.id,
        digestStatus: input.digest.status,
        status: input.digest.status === "needs_review" ? "queued" : "arbitrated",
        assignedPartnerId: null,
        assignedBy: null,
        assignedAt: null,
        slaWindowStartedAt: null,
        slaWindowDueAt: null,
        disposition: null,
        dispositionBy: null,
        dispositionAt: null,
        notes: [],
        updatedAt: now,
      }
  store.tenancyLineageReconciliationQueueArbitrations.set(queue.id, queue)

  const checkpointId = lineageClosureCheckpointId(input.digest.lineageRootSessionReferenceId)
  const existingCheckpoint = store.tenancyLineageDigestClosureCheckpoints.get(checkpointId)
  const checkpoint: TenancyLineageDigestClosureCheckpointRow = existingCheckpoint
    ? {
        ...existingCheckpoint,
        digestId: input.digest.id,
        status:
          existingCheckpoint.status === "closed_attested" && input.digest.status === "needs_review"
            ? "reopened"
            : existingCheckpoint.status,
        reopenTrigger:
          existingCheckpoint.status === "closed_attested" && input.digest.status === "needs_review"
            ? `digest_regressed:${input.digest.reasons.join(",") || "needs_review"}`
            : existingCheckpoint.reopenTrigger,
        reopenedBy:
          existingCheckpoint.status === "closed_attested" && input.digest.status === "needs_review"
            ? "system"
            : existingCheckpoint.reopenedBy,
        reopenedAt:
          existingCheckpoint.status === "closed_attested" && input.digest.status === "needs_review"
            ? now
            : existingCheckpoint.reopenedAt,
        updatedAt: now,
      }
    : {
        id: checkpointId,
        firmId: input.firmId,
        lineageRootSessionReferenceId: input.digest.lineageRootSessionReferenceId,
        digestId: input.digest.id,
        status: "pending_attestation",
        attestedBy: null,
        attestedAt: null,
        closureReason: null,
        reopenTrigger: null,
        reopenedBy: null,
        reopenedAt: null,
        notes: [],
        updatedAt: now,
      }
  store.tenancyLineageDigestClosureCheckpoints.set(checkpoint.id, checkpoint)

  const adjudicationId = lineageClosureAdjudicationId(input.digest.lineageRootSessionReferenceId)
  const existingAdjudication = store.tenancyLineageClosureAdjudications.get(adjudicationId)
  const requiredPanelQuorum = existingAdjudication?.requiredPanelQuorum ?? 2
  const confirmedPanelPartnerIds = existingAdjudication?.confirmedPanelPartnerIds ?? []
  const checkpointReopened = checkpoint.status === "reopened"
  const quorumMet = confirmedPanelPartnerIds.length >= requiredPanelQuorum
  const adjudicationStatus: TenancyLineageClosureAdjudicationStatus = checkpointReopened
    ? quorumMet
      ? "verdict_window_open"
      : "quorum_pending"
    : "standby"
  const resetVerdict = checkpointReopened && existingAdjudication?.status === "verdict_recorded"
  const existingWindowMs =
    (existingAdjudication?.verdictWindowStartedAt ?? null) !== null &&
    (existingAdjudication?.verdictWindowDueAt ?? null) !== null
      ? Math.max(
          60 * 1000,
          (existingAdjudication?.verdictWindowDueAt ?? 0) -
            (existingAdjudication?.verdictWindowStartedAt ?? 0)
        )
      : 4 * 60 * 60 * 1000
  const verdictWindowStartedAt =
    adjudicationStatus === "verdict_window_open"
      ? existingAdjudication?.status === "verdict_window_open" &&
        existingAdjudication.verdictWindowStartedAt !== null
        ? existingAdjudication.verdictWindowStartedAt
        : now
      : existingAdjudication?.status === "verdict_recorded" && !resetVerdict
        ? existingAdjudication.verdictWindowStartedAt
        : null
  const verdictWindowDueAt =
    adjudicationStatus === "verdict_window_open" && verdictWindowStartedAt !== null
      ? verdictWindowStartedAt + existingWindowMs
      : existingAdjudication?.status === "verdict_recorded" && !resetVerdict
        ? existingAdjudication.verdictWindowDueAt
        : null
  const baseDispositionDriftReasons = computeLineageDispositionDriftReasons({
    digest: input.digest,
    queue,
    checkpoint,
  })
  const closureAdjudication: TenancyLineageClosureAdjudicationRow = {
    id: adjudicationId,
    firmId: input.firmId,
    lineageRootSessionReferenceId: input.digest.lineageRootSessionReferenceId,
    digestId: input.digest.id,
    arbitrationQueueId: queue.id,
    closureCheckpointId: checkpoint.id,
    status:
      !resetVerdict &&
      existingAdjudication?.status === "verdict_recorded" &&
      checkpoint.status !== "reopened"
        ? "verdict_recorded"
        : adjudicationStatus,
    requiredPanelQuorum,
    confirmedPanelPartnerIds,
    verdictWindowStartedAt,
    verdictWindowDueAt,
    verdictDisposition: resetVerdict ? null : existingAdjudication?.verdictDisposition ?? null,
    verdictRecordedBy: resetVerdict ? null : existingAdjudication?.verdictRecordedBy ?? null,
    verdictRecordedAt: resetVerdict ? null : existingAdjudication?.verdictRecordedAt ?? null,
    dispositionDriftReasons: [
      ...new Set([...(existingAdjudication?.dispositionDriftReasons ?? []), ...baseDispositionDriftReasons]),
    ],
    reopenedClosureTrigger: checkpoint.reopenTrigger ?? null,
    notes: existingAdjudication?.notes ?? [],
    updatedAt: now,
  }
  store.tenancyLineageClosureAdjudications.set(closureAdjudication.id, closureAdjudication)

  const debtLedgerId = lineageArbitrationDebtRetirementLedgerId(
    input.digest.lineageRootSessionReferenceId
  )
  const existingDebtLedger = store.tenancyLineageArbitrationDebtRetirementLedgers.get(debtLedgerId)
  const unresolvedQueuePressureCount =
    (input.digest.status === "needs_review" ? 1 : 0) +
    input.digest.openDisputeCount +
    input.digest.unresolvedRevocationCount
  const ownerAssignmentDebtCount =
    unresolvedQueuePressureCount > 0 && !queue.assignedPartnerId ? 1 : 0
  const carryoverSignals = computeLineageCarryoverSignals({
    digest: input.digest,
    queue,
    checkpoint,
  })
  let debtStatus: TenancyLineageArbitrationDebtRetirementStatus =
    existingDebtLedger?.status ?? "pressure_open"
  const transitionedToCarryover =
    existingDebtLedger?.status === "retirement_attested" && unresolvedQueuePressureCount > 0
  if (transitionedToCarryover) {
    debtStatus = "carryover_reopened"
  } else if (existingDebtLedger?.status === "carryover_reopened" && unresolvedQueuePressureCount === 0) {
    debtStatus = "retirement_attested"
  } else if (existingDebtLedger?.status !== "retirement_attested") {
    debtStatus = "pressure_open"
  }
  const arbitrationDebtRetirementLedger: TenancyLineageArbitrationDebtRetirementLedgerRow = {
    id: debtLedgerId,
    firmId: input.firmId,
    lineageRootSessionReferenceId: input.digest.lineageRootSessionReferenceId,
    digestId: input.digest.id,
    arbitrationQueueId: queue.id,
    closureCheckpointId: checkpoint.id,
    status: debtStatus,
    unresolvedQueuePressureCount,
    ownerAssignmentDebtCount,
    assignedPartnerId: queue.assignedPartnerId,
    retirementAttestedBy: existingDebtLedger?.retirementAttestedBy ?? null,
    retirementAttestedAt: existingDebtLedger?.retirementAttestedAt ?? null,
    retirementNote: existingDebtLedger?.retirementNote ?? null,
    carryoverSignals: [...new Set([...(existingDebtLedger?.carryoverSignals ?? []), ...carryoverSignals])],
    carryoverReopenedBy: transitionedToCarryover
      ? "system"
      : existingDebtLedger?.carryoverReopenedBy ?? null,
    carryoverReopenedAt: transitionedToCarryover
      ? now
      : existingDebtLedger?.carryoverReopenedAt ?? null,
    notes: existingDebtLedger?.notes ?? [],
    updatedAt: now,
  }
  store.tenancyLineageArbitrationDebtRetirementLedgers.set(
    arbitrationDebtRetirementLedger.id,
    arbitrationDebtRetirementLedger
  )

  return {
    arbitrationQueue: queue,
    closureCheckpoint: checkpoint,
    closureAdjudication,
    arbitrationDebtRetirementLedger,
  }
}

export function assignLineageReconciliationArbitration(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    assignedPartnerId: string
    slaWindowMinutes?: number
    note?: string
    now?: number
  }
): {
  queue: TenancyLineageReconciliationQueueArbitrationRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const assignee = store.users.get(input.assignedPartnerId)
  if (!assignee) throw new Error("unknown assigned partner")
  if (assignee.firmId !== input.firmId) throw new Error("cross-firm assigned partner denied")
  if (assignee.role !== "partner") throw new Error("assigned partner must be a partner")
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  if (!digest) throw new Error("unknown lineage reconciliation digest")
  if (digest.firmId !== input.firmId) throw new Error("cross-firm digest denied")
  const now = input.now ?? Date.now()
  const existing =
    store.tenancyLineageReconciliationQueueArbitrations.get(
      lineageArbitrationQueueId(input.lineageRootSessionReferenceId)
    ) ??
    ensureLineageReconciliationMonitoringRows(store, {
      firmId: input.firmId,
      digest,
      now,
    }).arbitrationQueue
  const slaWindowMinutes = Math.max(1, Math.min(input.slaWindowMinutes ?? 240, 30 * 24 * 60))
  const queue: TenancyLineageReconciliationQueueArbitrationRow = {
    ...existing,
    digestStatus: digest.status,
    status: "assigned",
    assignedPartnerId: assignee.id,
    assignedBy: actor.id,
    assignedAt: now,
    slaWindowStartedAt: now,
    slaWindowDueAt: now + slaWindowMinutes * 60 * 1000,
    updatedAt: now,
    notes: input.note ? [...existing.notes, input.note] : existing.notes,
  }
  store.tenancyLineageReconciliationQueueArbitrations.set(queue.id, queue)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_assign_lineage_reconciliation_queue",
    actorId: actor.id,
    target: assignee.id,
    classification: actor.clearanceLevel,
    reason: input.note,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { queue, auditEntry }
}

export function arbitrateLineageReconciliationQueue(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    disposition: TenancyLineageReconciliationQueueArbitrationDisposition
    note?: string
    now?: number
  }
): {
  queue: TenancyLineageReconciliationQueueArbitrationRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  if (!digest) throw new Error("unknown lineage reconciliation digest")
  if (digest.firmId !== input.firmId) throw new Error("cross-firm digest denied")
  const now = input.now ?? Date.now()
  const existing =
    store.tenancyLineageReconciliationQueueArbitrations.get(
      lineageArbitrationQueueId(input.lineageRootSessionReferenceId)
    ) ??
    ensureLineageReconciliationMonitoringRows(store, {
      firmId: input.firmId,
      digest,
      now,
    }).arbitrationQueue
  const queue: TenancyLineageReconciliationQueueArbitrationRow = {
    ...existing,
    digestStatus: digest.status,
    status: "arbitrated",
    disposition: input.disposition,
    dispositionBy: actor.id,
    dispositionAt: now,
    updatedAt: now,
    notes: input.note ? [...existing.notes, input.note] : existing.notes,
  }
  store.tenancyLineageReconciliationQueueArbitrations.set(queue.id, queue)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_arbitrate_lineage_reconciliation_queue",
    actorId: actor.id,
    target: queue.assignedPartnerId ?? actor.id,
    classification: actor.clearanceLevel,
    reason: input.note,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { queue, auditEntry }
}

export function attestLineageDigestClosureCheckpoint(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    closureReason: string
    note?: string
    now?: number
  }
): {
  checkpoint: TenancyLineageDigestClosureCheckpointRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  if (!digest) throw new Error("unknown lineage reconciliation digest")
  if (digest.firmId !== input.firmId) throw new Error("cross-firm digest denied")
  const closureReason = input.closureReason.trim()
  if (!closureReason) throw new Error("closureReason is required")
  const now = input.now ?? Date.now()
  const existing =
    store.tenancyLineageDigestClosureCheckpoints.get(
      lineageClosureCheckpointId(input.lineageRootSessionReferenceId)
    ) ??
    ensureLineageReconciliationMonitoringRows(store, {
      firmId: input.firmId,
      digest,
      now,
    }).closureCheckpoint
  const checkpoint: TenancyLineageDigestClosureCheckpointRow = {
    ...existing,
    digestId: digest.id,
    status: "closed_attested",
    attestedBy: actor.id,
    attestedAt: now,
    closureReason,
    reopenTrigger: null,
    updatedAt: now,
    notes: input.note ? [...existing.notes, input.note] : existing.notes,
  }
  store.tenancyLineageDigestClosureCheckpoints.set(checkpoint.id, checkpoint)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_attest_lineage_digest_closure",
    actorId: actor.id,
    target: input.lineageRootSessionReferenceId,
    classification: actor.clearanceLevel,
    reason: closureReason,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { checkpoint, auditEntry }
}

export function reopenLineageDigestClosureCheckpoint(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    reopenTrigger: string
    note?: string
    now?: number
  }
): {
  checkpoint: TenancyLineageDigestClosureCheckpointRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  if (!digest) throw new Error("unknown lineage reconciliation digest")
  if (digest.firmId !== input.firmId) throw new Error("cross-firm digest denied")
  const reopenTrigger = input.reopenTrigger.trim()
  if (!reopenTrigger) throw new Error("reopenTrigger is required")
  const now = input.now ?? Date.now()
  const existing =
    store.tenancyLineageDigestClosureCheckpoints.get(
      lineageClosureCheckpointId(input.lineageRootSessionReferenceId)
    ) ??
    ensureLineageReconciliationMonitoringRows(store, {
      firmId: input.firmId,
      digest,
      now,
    }).closureCheckpoint
  const checkpoint: TenancyLineageDigestClosureCheckpointRow = {
    ...existing,
    digestId: digest.id,
    status: "reopened",
    reopenTrigger,
    reopenedBy: actor.id,
    reopenedAt: now,
    updatedAt: now,
    notes: input.note ? [...existing.notes, input.note] : existing.notes,
  }
  store.tenancyLineageDigestClosureCheckpoints.set(checkpoint.id, checkpoint)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_reopen_lineage_digest_closure",
    actorId: actor.id,
    target: input.lineageRootSessionReferenceId,
    classification: actor.clearanceLevel,
    reason: reopenTrigger,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { checkpoint, auditEntry }
}

export function governLineageClosureAdjudication(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    panelPartnerIds: string[]
    requiredPanelQuorum?: number
    verdictWindowMinutes?: number
    note?: string
    now?: number
  }
): {
  adjudication: TenancyLineageClosureAdjudicationRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  if (!digest) throw new Error("unknown lineage reconciliation digest")
  if (digest.firmId !== input.firmId) throw new Error("cross-firm digest denied")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  const panelPartnerIds = [...new Set(input.panelPartnerIds.map((id) => id.trim()).filter(Boolean))]
  if (panelPartnerIds.length === 0) throw new Error("panelPartnerIds must include at least one partner")
  for (const partnerId of panelPartnerIds) {
    const user = store.users.get(partnerId)
    if (!user) throw new Error(`unknown panel partner: ${partnerId}`)
    if (user.firmId !== input.firmId) throw new Error("cross-firm panel partner denied")
    if (user.role !== "partner") throw new Error("panel partner must have partner role")
  }
  const requiredPanelQuorum = Math.max(1, Math.min(input.requiredPanelQuorum ?? 2, 12))
  const quorumMet = panelPartnerIds.length >= requiredPanelQuorum
  const verdictWindowMinutes = Math.max(15, Math.min(input.verdictWindowMinutes ?? 240, 30 * 24 * 60))
  const status: TenancyLineageClosureAdjudicationStatus =
    monitoring.closureCheckpoint.status !== "reopened"
      ? "standby"
      : quorumMet
        ? "verdict_window_open"
        : "quorum_pending"
  const baseDispositionDriftReasons = computeLineageDispositionDriftReasons({
    digest,
    queue: monitoring.arbitrationQueue,
    checkpoint: monitoring.closureCheckpoint,
  })
  const adjudication: TenancyLineageClosureAdjudicationRow = {
    ...monitoring.closureAdjudication,
    status,
    requiredPanelQuorum,
    confirmedPanelPartnerIds: panelPartnerIds,
    verdictWindowStartedAt: status === "verdict_window_open" ? now : null,
    verdictWindowDueAt:
      status === "verdict_window_open" ? now + verdictWindowMinutes * 60 * 1000 : null,
    verdictDisposition:
      monitoring.closureCheckpoint.status === "reopened"
        ? monitoring.closureAdjudication.verdictDisposition
        : null,
    verdictRecordedBy:
      monitoring.closureCheckpoint.status === "reopened"
        ? monitoring.closureAdjudication.verdictRecordedBy
        : null,
    verdictRecordedAt:
      monitoring.closureCheckpoint.status === "reopened"
        ? monitoring.closureAdjudication.verdictRecordedAt
        : null,
    dispositionDriftReasons: [
      ...new Set([
        ...monitoring.closureAdjudication.dispositionDriftReasons,
        ...baseDispositionDriftReasons,
      ]),
    ],
    reopenedClosureTrigger: monitoring.closureCheckpoint.reopenTrigger ?? null,
    updatedAt: now,
    notes: input.note
      ? [...monitoring.closureAdjudication.notes, input.note]
      : monitoring.closureAdjudication.notes,
  }
  store.tenancyLineageClosureAdjudications.set(adjudication.id, adjudication)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_govern_lineage_closure_adjudication",
    actorId: actor.id,
    target: input.lineageRootSessionReferenceId,
    classification: actor.clearanceLevel,
    reason: input.note,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { adjudication, auditEntry }
}

export function recordLineageClosureAdjudicationVerdict(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    disposition: TenancyLineageReconciliationQueueArbitrationDisposition
    dispositionDriftReasons?: string[]
    note?: string
    now?: number
  }
): {
  adjudication: TenancyLineageClosureAdjudicationRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  if (!digest) throw new Error("unknown lineage reconciliation digest")
  if (digest.firmId !== input.firmId) throw new Error("cross-firm digest denied")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  if (monitoring.closureCheckpoint.status !== "reopened") {
    throw new Error("closure checkpoint must be reopened before recording a verdict")
  }
  const explicitDriftReasons = (input.dispositionDriftReasons ?? [])
    .map((reason) => reason.trim())
    .filter(Boolean)
  const driftReasons = computeLineageDispositionDriftReasons({
    digest,
    queue: monitoring.arbitrationQueue,
    checkpoint: monitoring.closureCheckpoint,
  })
  if (
    monitoring.arbitrationQueue.disposition &&
    monitoring.arbitrationQueue.disposition !== input.disposition
  ) {
    driftReasons.push("queue_disposition_mismatch_with_verdict")
  }
  const adjudication: TenancyLineageClosureAdjudicationRow = {
    ...monitoring.closureAdjudication,
    status: "verdict_recorded",
    verdictDisposition: input.disposition,
    verdictRecordedBy: actor.id,
    verdictRecordedAt: now,
    dispositionDriftReasons: [
      ...new Set([
        ...monitoring.closureAdjudication.dispositionDriftReasons,
        ...driftReasons,
        ...explicitDriftReasons,
      ]),
    ],
    updatedAt: now,
    notes: input.note
      ? [...monitoring.closureAdjudication.notes, input.note]
      : monitoring.closureAdjudication.notes,
  }
  store.tenancyLineageClosureAdjudications.set(adjudication.id, adjudication)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_record_lineage_closure_adjudication_verdict",
    actorId: actor.id,
    target: input.lineageRootSessionReferenceId,
    classification: actor.clearanceLevel,
    reason: input.note,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { adjudication, auditEntry }
}

export function attestLineageArbitrationDebtRetirement(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    retirementNote: string
    note?: string
    now?: number
  }
): {
  ledger: TenancyLineageArbitrationDebtRetirementLedgerRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  if (!digest) throw new Error("unknown lineage reconciliation digest")
  if (digest.firmId !== input.firmId) throw new Error("cross-firm digest denied")
  const retirementNote = input.retirementNote.trim()
  if (!retirementNote) throw new Error("retirementNote is required")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  const ledger: TenancyLineageArbitrationDebtRetirementLedgerRow = {
    ...monitoring.arbitrationDebtRetirementLedger,
    status: "retirement_attested",
    retirementAttestedBy: actor.id,
    retirementAttestedAt: now,
    retirementNote,
    updatedAt: now,
    notes: input.note
      ? [...monitoring.arbitrationDebtRetirementLedger.notes, input.note]
      : monitoring.arbitrationDebtRetirementLedger.notes,
  }
  store.tenancyLineageArbitrationDebtRetirementLedgers.set(ledger.id, ledger)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_attest_lineage_arbitration_debt_retirement",
    actorId: actor.id,
    target: input.lineageRootSessionReferenceId,
    classification: actor.clearanceLevel,
    reason: retirementNote,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { ledger, auditEntry }
}

export function reopenLineageArbitrationDebtRetirement(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    carryoverSignal: string
    note?: string
    now?: number
  }
): {
  ledger: TenancyLineageArbitrationDebtRetirementLedgerRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  if (!digest) throw new Error("unknown lineage reconciliation digest")
  if (digest.firmId !== input.firmId) throw new Error("cross-firm digest denied")
  const carryoverSignal = input.carryoverSignal.trim()
  if (!carryoverSignal) throw new Error("carryoverSignal is required")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  const ledger: TenancyLineageArbitrationDebtRetirementLedgerRow = {
    ...monitoring.arbitrationDebtRetirementLedger,
    status: "carryover_reopened",
    carryoverSignals: [
      ...new Set([...monitoring.arbitrationDebtRetirementLedger.carryoverSignals, carryoverSignal]),
    ],
    carryoverReopenedBy: actor.id,
    carryoverReopenedAt: now,
    updatedAt: now,
    notes: input.note
      ? [...monitoring.arbitrationDebtRetirementLedger.notes, input.note]
      : monitoring.arbitrationDebtRetirementLedger.notes,
  }
  store.tenancyLineageArbitrationDebtRetirementLedgers.set(ledger.id, ledger)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_reopen_lineage_arbitration_debt_retirement",
    actorId: actor.id,
    target: input.lineageRootSessionReferenceId,
    classification: actor.clearanceLevel,
    reason: carryoverSignal,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { ledger, auditEntry }
}

export function listLineageClosureAdjudications(
  store: SpineStore,
  actorId: string,
  firmId: string,
  status: TenancyClosureAdjudicationStatus | undefined,
  lineageRootSessionReferenceId: string | undefined,
  limit: number,
  cursor: number
): {
  items: TenancyLineageClosureAdjudicationRow[]
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const rows = [...store.tenancyLineageClosureAdjudications.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) => (status ? row.status === status : true))
    .filter((row) =>
      lineageRootSessionReferenceId
        ? row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        : true
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: rows.length,
    nextCursor,
  }
}

export function listLineageArbitrationDebtRetirementLedgers(
  store: SpineStore,
  actorId: string,
  firmId: string,
  status: TenancyArbitrationDebtRetirementStatus | undefined,
  lineageRootSessionReferenceId: string | undefined,
  limit: number,
  cursor: number
): {
  items: TenancyLineageArbitrationDebtRetirementLedgerRow[]
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const rows = [...store.tenancyLineageArbitrationDebtRetirementLedgers.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) => (status ? row.status === status : true))
    .filter((row) =>
      lineageRootSessionReferenceId
        ? row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        : true
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: rows.length,
    nextCursor,
  }
}

export function listLineageReconciliationQueueArbitrations(
  store: SpineStore,
  actorId: string,
  firmId: string,
  status: TenancyLineageReconciliationQueueArbitrationStatus | undefined,
  lineageRootSessionReferenceId: string | undefined,
  limit: number,
  cursor: number
): {
  items: TenancyLineageReconciliationQueueArbitrationRow[]
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const rows = [...store.tenancyLineageReconciliationQueueArbitrations.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) => (status ? row.status === status : true))
    .filter((row) =>
      lineageRootSessionReferenceId
        ? row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        : true
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: rows.length,
    nextCursor,
  }
}

export function listLineageDigestClosureCheckpoints(
  store: SpineStore,
  actorId: string,
  firmId: string,
  status: TenancyLineageDigestClosureCheckpointStatus | undefined,
  lineageRootSessionReferenceId: string | undefined,
  limit: number,
  cursor: number
): {
  items: TenancyLineageDigestClosureCheckpointRow[]
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const rows = [...store.tenancyLineageDigestClosureCheckpoints.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) => (status ? row.status === status : true))
    .filter((row) =>
      lineageRootSessionReferenceId
        ? row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        : true
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < rows.length ? String(cursor + page.length) : null
  return {
    items: page,
    total: rows.length,
    nextCursor,
  }
}
