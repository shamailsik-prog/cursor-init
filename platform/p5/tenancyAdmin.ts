import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import {
  rankOf, rankOfStoredOrMax,
  storedUserRecord,
  type Role,
  type SpineStore,
  type TenancyAuthBoundary,
  type TenancyLineageArbitrationDebtRetirementLedgerRow,
  type TenancyLineageArbitrationDebtRetirementDisputeLedgerRow,
  type TenancyLineageArbitrationDebtRetirementDisputeResolutionOutcome,
  type TenancyLineageArbitrationDebtRetirementDisputeStatus,
  type TenancyLineageArbitrationDebtRetirementStatus,
  type TenancyExternalSessionIdentityBridgeMismatchStatus as SpineTenancyExternalSessionIdentityBridgeMismatchStatus,
  type TenancyExternalSessionIdentityBridgeRow,
  type TenancyExternalSessionIdentityBridgeStatus as SpineTenancyExternalSessionIdentityBridgeStatus,
  type TenancyLineageClosureAdjudicationRow,
  type TenancyLineageClosureAdjudicationSettlementRow,
  type TenancyLineageClosureAdjudicationSettlementStatus,
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
export type TenancyClosureAdjudicationSettlementStatus =
  TenancyLineageClosureAdjudicationSettlementStatus
export type TenancyArbitrationDebtRetirementDisputeStatus =
  TenancyLineageArbitrationDebtRetirementDisputeStatus
export type TenancyExternalSessionIdentityBridgeStatus =
  SpineTenancyExternalSessionIdentityBridgeStatus
export type TenancyExternalSessionIdentityBridgeMismatchStatus =
  SpineTenancyExternalSessionIdentityBridgeMismatchStatus

function requirePartnerInFirm(store: SpineStore, actorId: string, firmId: string): User {
  const actor = store.users.get(actorId)
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!actor || actor.firmId !== firmId) throw new PublicError("unknown actor")
  if (actor.role !== "partner") throw new PublicError("partner role required")
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
  if (!user) throw new PublicError("unknown user")
  if (firmId && firmId !== user.firmId) throw new PublicError("firm scope mismatch")
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
    .filter((entry) => rankOfStoredOrMax(entry.classification) <= rankOf(actor.clearanceLevel))
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!target || target.firmId !== input.firmId) throw new PublicError("unknown target user")
  if (!isClassification(input.nextClearance)) {
    throw new PublicError("nextClearance must be a rank-0–4 label")
  }
  if (input.nextRole === "partner" && target.role !== "partner") {
    throw new PublicError("partner promotion is blocked in this surface")
  }
  if (rankOf(input.nextClearance) > rankOf(actor.clearanceLevel)) {
    throw new PublicError("cannot assign clearance above actor level")
  }
  if (input.nextRole === "client" && rankOf(input.nextClearance) > rankOf("internal")) {
    throw new PublicError("client clearance may not exceed internal")
  }
  target.role = input.nextRole
  target.clearanceLevel = input.nextClearance
  // `store.users.get` may return a request-scoped copy of the caller's record
  // (clearance ceiling); write the update back explicitly.
  store.users.set(target.id, target)
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
    throw new PublicError("unknown session reference")
  }
  if (existing && existing.firmId !== input.user.firmId) {
    throw new PublicError("unknown session reference")
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
    // Snapshot the provisioned clearance, not a request-scoped ceiling, so a
    // capped token does not register as privilege drift.
    clearanceSnapshot:
      storedUserRecord(store, input.user.id)?.clearanceLevel ?? input.user.clearanceLevel,
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!parent || parent.firmId !== input.firmId) throw new PublicError("unknown session reference")
  if (getTenancySessionReferenceState(parent, input.now) !== "active") {
    throw new PublicError("session reference is not active")
  }
  const user = store.users.get(parent.userId)
  if (!user) throw new PublicError("unknown session reference user")
  const nextAuthBoundary = input.authBoundary ?? parent.authBoundary
  const nextExternalSessionId =
    nextAuthBoundary === "external_session_hint"
      ? (input.externalSessionId ?? parent.externalSessionId ?? null)
      : null
  const divergenceReasons = computeDelegatedBoundaryDivergenceReasons(parent, {
    authBoundary: nextAuthBoundary,
    externalSessionId: nextExternalSessionId,
    roleSnapshot: user.role,
    clearanceSnapshot: storedUserRecord(store, user.id)?.clearanceLevel ?? user.clearanceLevel,
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
    privilegedBoundaryDriftSessionReferenceIds: [] as string[],
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!reference || reference.firmId !== input.firmId) throw new PublicError("unknown session reference")
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
    privilegedBoundaryDriftSessionReferenceIds: [] as string[],
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!root || root.firmId !== firmId) throw new PublicError("unknown session reference")
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!sessionReference || sessionReference.firmId !== input.firmId) throw new PublicError("unknown session reference")
  const reason = input.reason.trim()
  if (!reason) throw new PublicError("reason is required")
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
    privilegedBoundaryDriftSessionReferenceIds: [] as string[],
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!dispute || dispute.firmId !== input.firmId) throw new PublicError("unknown lineage dispute")
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
    privilegedBoundaryDriftSessionReferenceIds: [] as string[],
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

function lineageClosureAdjudicationSettlementId(lineageRootSessionReferenceId: string): string {
  return `tenancy-lineage-closure-settlement:${lineageRootSessionReferenceId}`
}

function lineageArbitrationDebtRetirementDisputeLedgerId(
  lineageRootSessionReferenceId: string
): string {
  return `tenancy-lineage-arbitration-debt-dispute:${lineageRootSessionReferenceId}`
}

function externalSessionIdentityBridgeId(sessionReferenceId: string): string {
  return `tenancy-external-session-identity-bridge:${sessionReferenceId}`
}

function computeExternalSessionIdentityMismatchReasons(input: {
  sessionReference: TenancySessionReferenceRow
  assertedExternalSessionId: string | null
  previousIssuer: string | null
  previousSubject: string | null
  assertedIssuer: string
  assertedSubject: string
}): string[] {
  const reasons: string[] = []
  if (input.sessionReference.authBoundary !== "external_session_hint") {
    reasons.push("auth_boundary_not_external_session_hint")
  }
  if (!input.sessionReference.externalSessionId) {
    reasons.push("session_reference_missing_external_session_id")
  }
  if (
    input.assertedExternalSessionId &&
    input.sessionReference.externalSessionId &&
    input.assertedExternalSessionId !== input.sessionReference.externalSessionId
  ) {
    reasons.push("asserted_external_session_id_mismatch")
  }
  if (input.previousIssuer && input.previousIssuer !== input.assertedIssuer) {
    reasons.push("asserted_issuer_changed_since_last_attestation")
  }
  if (input.previousSubject && input.previousSubject !== input.assertedSubject) {
    reasons.push("asserted_subject_changed_since_last_attestation")
  }
  return [...new Set(reasons)]
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
  closureAdjudicationSettlement: TenancyLineageClosureAdjudicationSettlementRow
  arbitrationDebtRetirementDisputeLedger: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow
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
  const resetVerdict =
    checkpointReopened &&
    existingAdjudication?.status === "verdict_recorded" &&
    (existingAdjudication.verdictRecordedAt ?? 0) < (checkpoint.reopenedAt ?? 0)
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
      !resetVerdict && existingAdjudication?.status === "verdict_recorded"
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
  } else if (existingDebtLedger?.status === "carryover_reopened") {
    debtStatus = unresolvedQueuePressureCount > 0 ? "carryover_reopened" : "retirement_attested"
  } else if (existingDebtLedger?.status === "retirement_attested") {
    debtStatus = "retirement_attested"
  } else {
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

  const settlementId = lineageClosureAdjudicationSettlementId(
    input.digest.lineageRootSessionReferenceId
  )
  const existingSettlement = store.tenancyLineageClosureAdjudicationSettlements.get(settlementId)
  const settlementConfirmationSlaStartedAt =
    existingSettlement?.settlementConfirmationSlaStartedAt ??
    closureAdjudication.verdictRecordedAt ??
    null
  const settlementConfirmationSlaDueAt =
    settlementConfirmationSlaStartedAt !== null
      ? (existingSettlement?.settlementConfirmationSlaDueAt ??
        settlementConfirmationSlaStartedAt + 24 * 60 * 60 * 1000)
      : null
  const settlementSlaBreached =
    settlementConfirmationSlaDueAt !== null &&
    settlementConfirmationSlaDueAt < now &&
    (existingSettlement?.settlementConfirmedAt ?? null) === null
  const closureAdjudicationSettlement: TenancyLineageClosureAdjudicationSettlementRow = {
    id: settlementId,
    firmId: input.firmId,
    lineageRootSessionReferenceId: input.digest.lineageRootSessionReferenceId,
    digestId: input.digest.id,
    adjudicationId: closureAdjudication.id,
    status: existingSettlement?.status ?? "draft",
    verdictPublicationCheckpointedBy: existingSettlement?.verdictPublicationCheckpointedBy ?? null,
    verdictPublicationCheckpointedAt: existingSettlement?.verdictPublicationCheckpointedAt ?? null,
    verdictPublicationChannel: existingSettlement?.verdictPublicationChannel ?? null,
    publicationCorrectionNote: existingSettlement?.publicationCorrectionNote ?? null,
    publicationCorrectionBy: existingSettlement?.publicationCorrectionBy ?? null,
    publicationCorrectionAt: existingSettlement?.publicationCorrectionAt ?? null,
    settlementConfirmationSlaStartedAt,
    settlementConfirmationSlaDueAt,
    settlementConfirmedBy: existingSettlement?.settlementConfirmedBy ?? null,
    settlementConfirmedAt: existingSettlement?.settlementConfirmedAt ?? null,
    settlementSlaBreached,
    notes: existingSettlement?.notes ?? [],
    updatedAt: now,
  }
  store.tenancyLineageClosureAdjudicationSettlements.set(
    closureAdjudicationSettlement.id,
    closureAdjudicationSettlement
  )

  const disputeLedgerId = lineageArbitrationDebtRetirementDisputeLedgerId(
    input.digest.lineageRootSessionReferenceId
  )
  const existingDisputeLedger = store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.get(
    disputeLedgerId
  )
  const arbitrationDebtRetirementDisputeLedger: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow =
    {
      id: disputeLedgerId,
      firmId: input.firmId,
      lineageRootSessionReferenceId: input.digest.lineageRootSessionReferenceId,
      digestId: input.digest.id,
      debtLedgerId: arbitrationDebtRetirementLedger.id,
      status: existingDisputeLedger?.status ?? "open",
      challengeReason: existingDisputeLedger?.challengeReason ?? "pending_challenge_intake",
      challengeOpenedBy: existingDisputeLedger?.challengeOpenedBy ?? "system",
      challengeOpenedAt: existingDisputeLedger?.challengeOpenedAt ?? now,
      reviewerId: existingDisputeLedger?.reviewerId ?? null,
      reviewerAssignedBy: existingDisputeLedger?.reviewerAssignedBy ?? null,
      reviewerAssignedAt: existingDisputeLedger?.reviewerAssignedAt ?? null,
      resolutionOutcome: existingDisputeLedger?.resolutionOutcome ?? null,
      resolvedBy: existingDisputeLedger?.resolvedBy ?? null,
      resolvedAt: existingDisputeLedger?.resolvedAt ?? null,
      resolutionNote: existingDisputeLedger?.resolutionNote ?? null,
      rollbackControlBy: existingDisputeLedger?.rollbackControlBy ?? null,
      rollbackControlAt: existingDisputeLedger?.rollbackControlAt ?? null,
      rollbackControlNote: existingDisputeLedger?.rollbackControlNote ?? null,
      notes: existingDisputeLedger?.notes ?? [],
      updatedAt: now,
    }
  store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.set(
    arbitrationDebtRetirementDisputeLedger.id,
    arbitrationDebtRetirementDisputeLedger
  )

  return {
    arbitrationQueue: queue,
    closureCheckpoint: checkpoint,
    closureAdjudication,
    arbitrationDebtRetirementLedger,
    closureAdjudicationSettlement,
    arbitrationDebtRetirementDisputeLedger,
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!assignee || assignee.firmId !== input.firmId) throw new PublicError("unknown assigned partner")
  if (assignee.role !== "partner") throw new PublicError("assigned partner must be a partner")
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const closureReason = input.closureReason.trim()
  if (!closureReason) throw new PublicError("closureReason is required")
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const reopenTrigger = input.reopenTrigger.trim()
  if (!reopenTrigger) throw new PublicError("reopenTrigger is required")
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  const panelPartnerIds = [...new Set(input.panelPartnerIds.map((id) => id.trim()).filter(Boolean))]
  if (panelPartnerIds.length === 0) throw new PublicError("panelPartnerIds must include at least one partner")
  for (const partnerId of panelPartnerIds) {
    const user = store.users.get(partnerId)
    if (!user || user.firmId !== input.firmId) throw new PublicError("unknown panel partner")
    if (user.role !== "partner") throw new PublicError("panel partner must have partner role")
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  if (monitoring.closureCheckpoint.status !== "reopened") {
    throw new PublicError("closure checkpoint must be reopened before recording a verdict")
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const retirementNote = input.retirementNote.trim()
  if (!retirementNote) throw new PublicError("retirementNote is required")
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
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const carryoverSignal = input.carryoverSignal.trim()
  if (!carryoverSignal) throw new PublicError("carryoverSignal is required")
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

export function checkpointLineageClosureAdjudicationSettlementPublication(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    publicationChannel: string
    note?: string
    now?: number
  }
): {
  settlement: TenancyLineageClosureAdjudicationSettlementRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const publicationChannel = input.publicationChannel.trim()
  if (!publicationChannel) throw new PublicError("publicationChannel is required")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  const settlement: TenancyLineageClosureAdjudicationSettlementRow = {
    ...monitoring.closureAdjudicationSettlement,
    status: "publication_checkpointed",
    verdictPublicationCheckpointedBy: actor.id,
    verdictPublicationCheckpointedAt: now,
    verdictPublicationChannel: publicationChannel,
    updatedAt: now,
    notes: input.note
      ? [...monitoring.closureAdjudicationSettlement.notes, input.note]
      : monitoring.closureAdjudicationSettlement.notes,
  }
  store.tenancyLineageClosureAdjudicationSettlements.set(settlement.id, settlement)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_checkpoint_lineage_closure_adjudication_settlement_publication",
    actorId: actor.id,
    target: input.lineageRootSessionReferenceId,
    classification: actor.clearanceLevel,
    reason: publicationChannel,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { settlement, auditEntry }
}

export function logLineageClosureAdjudicationSettlementCorrection(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    correctionNote: string
    note?: string
    now?: number
  }
): {
  settlement: TenancyLineageClosureAdjudicationSettlementRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const correctionNote = input.correctionNote.trim()
  if (!correctionNote) throw new PublicError("correctionNote is required")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  const settlement: TenancyLineageClosureAdjudicationSettlementRow = {
    ...monitoring.closureAdjudicationSettlement,
    status: "correction_logged",
    publicationCorrectionNote: correctionNote,
    publicationCorrectionBy: actor.id,
    publicationCorrectionAt: now,
    updatedAt: now,
    notes: input.note
      ? [...monitoring.closureAdjudicationSettlement.notes, input.note]
      : monitoring.closureAdjudicationSettlement.notes,
  }
  store.tenancyLineageClosureAdjudicationSettlements.set(settlement.id, settlement)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_log_lineage_closure_adjudication_settlement_correction",
    actorId: actor.id,
    target: input.lineageRootSessionReferenceId,
    classification: actor.clearanceLevel,
    reason: correctionNote,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { settlement, auditEntry }
}

export function confirmLineageClosureAdjudicationSettlementSla(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    note?: string
    now?: number
  }
): {
  settlement: TenancyLineageClosureAdjudicationSettlementRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  const settlement: TenancyLineageClosureAdjudicationSettlementRow = {
    ...monitoring.closureAdjudicationSettlement,
    status: "sla_confirmed",
    settlementConfirmedBy: actor.id,
    settlementConfirmedAt: now,
    settlementSlaBreached:
      monitoring.closureAdjudicationSettlement.settlementConfirmationSlaDueAt !== null &&
      monitoring.closureAdjudicationSettlement.settlementConfirmationSlaDueAt < now,
    updatedAt: now,
    notes: input.note
      ? [...monitoring.closureAdjudicationSettlement.notes, input.note]
      : monitoring.closureAdjudicationSettlement.notes,
  }
  store.tenancyLineageClosureAdjudicationSettlements.set(settlement.id, settlement)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_confirm_lineage_closure_adjudication_settlement_sla",
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
  return { settlement, auditEntry }
}

export function openLineageArbitrationDebtRetirementDispute(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    challengeReason: string
    note?: string
    now?: number
  }
): {
  disputeLedger: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const challengeReason = input.challengeReason.trim()
  if (!challengeReason) throw new PublicError("challengeReason is required")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  const disputeLedger: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow = {
    ...monitoring.arbitrationDebtRetirementDisputeLedger,
    status: "open",
    challengeReason,
    challengeOpenedBy: actor.id,
    challengeOpenedAt: now,
    updatedAt: now,
    notes: input.note
      ? [...monitoring.arbitrationDebtRetirementDisputeLedger.notes, input.note]
      : monitoring.arbitrationDebtRetirementDisputeLedger.notes,
  }
  store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.set(disputeLedger.id, disputeLedger)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_open_lineage_arbitration_debt_retirement_dispute",
    actorId: actor.id,
    target: input.lineageRootSessionReferenceId,
    classification: actor.clearanceLevel,
    reason: challengeReason,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { disputeLedger, auditEntry }
}

export function assignLineageArbitrationDebtRetirementDisputeReviewer(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    reviewerId: string
    note?: string
    now?: number
  }
): {
  disputeLedger: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const reviewer = store.users.get(input.reviewerId)
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!reviewer || reviewer.firmId !== input.firmId) throw new PublicError("unknown reviewer")
  if (reviewer.role !== "partner") throw new PublicError("reviewer must be a partner")
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  const disputeLedger: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow = {
    ...monitoring.arbitrationDebtRetirementDisputeLedger,
    status: "reviewer_assigned",
    reviewerId: reviewer.id,
    reviewerAssignedBy: actor.id,
    reviewerAssignedAt: now,
    updatedAt: now,
    notes: input.note
      ? [...monitoring.arbitrationDebtRetirementDisputeLedger.notes, input.note]
      : monitoring.arbitrationDebtRetirementDisputeLedger.notes,
  }
  store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.set(disputeLedger.id, disputeLedger)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_assign_lineage_arbitration_debt_retirement_dispute_reviewer",
    actorId: actor.id,
    target: reviewer.id,
    classification: actor.clearanceLevel,
    reason: input.note,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { disputeLedger, auditEntry }
}

export function resolveLineageArbitrationDebtRetirementDispute(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    resolutionOutcome: TenancyLineageArbitrationDebtRetirementDisputeResolutionOutcome
    resolutionNote?: string
    note?: string
    now?: number
  }
): {
  disputeLedger: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  const disputeLedger: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow = {
    ...monitoring.arbitrationDebtRetirementDisputeLedger,
    status: "resolved",
    resolutionOutcome: input.resolutionOutcome,
    resolvedBy: actor.id,
    resolvedAt: now,
    resolutionNote: input.resolutionNote ?? null,
    updatedAt: now,
    notes: input.note
      ? [...monitoring.arbitrationDebtRetirementDisputeLedger.notes, input.note]
      : monitoring.arbitrationDebtRetirementDisputeLedger.notes,
  }
  store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.set(disputeLedger.id, disputeLedger)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_resolve_lineage_arbitration_debt_retirement_dispute",
    actorId: actor.id,
    target: input.lineageRootSessionReferenceId,
    classification: actor.clearanceLevel,
    reason: input.resolutionNote ?? input.note,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { disputeLedger, auditEntry }
}

export function controlLineageArbitrationDebtRetirementDisputeRollback(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    lineageRootSessionReferenceId: string
    rollbackControlNote: string
    note?: string
    now?: number
  }
): {
  disputeLedger: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const digest = store.tenancyLineageReconciliationDigests.get(
    lineageDigestId(input.lineageRootSessionReferenceId)
  )
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!digest || digest.firmId !== input.firmId) throw new PublicError("unknown lineage reconciliation digest")
  const rollbackControlNote = input.rollbackControlNote.trim()
  if (!rollbackControlNote) throw new PublicError("rollbackControlNote is required")
  const now = input.now ?? Date.now()
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
    now,
  })
  const disputeLedger: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow = {
    ...monitoring.arbitrationDebtRetirementDisputeLedger,
    status: "rollback_controlled",
    rollbackControlBy: actor.id,
    rollbackControlAt: now,
    rollbackControlNote,
    updatedAt: now,
    notes: input.note
      ? [...monitoring.arbitrationDebtRetirementDisputeLedger.notes, input.note]
      : monitoring.arbitrationDebtRetirementDisputeLedger.notes,
  }
  store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.set(disputeLedger.id, disputeLedger)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_control_lineage_arbitration_debt_retirement_dispute_rollback",
    actorId: actor.id,
    target: input.lineageRootSessionReferenceId,
    classification: actor.clearanceLevel,
    reason: rollbackControlNote,
    sessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryLineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
    delegatedBoundaryReconciliationStatus: digest.status === "needs_review" ? "diverged" : "aligned",
    delegatedBoundaryDivergenceReasons: digest.reasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { disputeLedger, auditEntry }
}

export function attestExternalSessionIdentityBridge(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    sessionReferenceId: string
    assertedIssuer: string
    assertedSubject: string
    assertedExternalSessionId?: string
    note?: string
    now?: number
  }
): {
  bridge: TenancyExternalSessionIdentityBridgeRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const sessionReference = store.tenancySessionReferences.get(input.sessionReferenceId)
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!sessionReference || sessionReference.firmId !== input.firmId) throw new PublicError("unknown session reference")
  const assertedIssuer = input.assertedIssuer.trim()
  if (!assertedIssuer) throw new PublicError("assertedIssuer is required")
  const assertedSubject = input.assertedSubject.trim()
  if (!assertedSubject) throw new PublicError("assertedSubject is required")
  const assertedExternalSessionId = input.assertedExternalSessionId?.trim() || null
  const now = input.now ?? Date.now()
  const bridgeId = externalSessionIdentityBridgeId(sessionReference.id)
  const existing = store.tenancyExternalSessionIdentityBridges.get(bridgeId)
  const mismatchReasons = computeExternalSessionIdentityMismatchReasons({
    sessionReference,
    assertedExternalSessionId,
    previousIssuer: existing?.assertedIssuer ?? null,
    previousSubject: existing?.assertedSubject ?? null,
    assertedIssuer,
    assertedSubject,
  })
  const mismatchStatus: TenancyExternalSessionIdentityBridgeMismatchStatus =
    mismatchReasons.length > 0 ? "mismatch_detected" : "aligned"
  const status: TenancyExternalSessionIdentityBridgeStatus =
    existing?.status === "quarantined" ? "quarantined" : "attested"
  const bridge: TenancyExternalSessionIdentityBridgeRow = {
    id: bridgeId,
    firmId: input.firmId,
    lineageRootSessionReferenceId:
      sessionReference.lineageRootSessionReferenceId || sessionReference.id,
    sessionReferenceId: sessionReference.id,
    authBoundary: sessionReference.authBoundary,
    sessionExternalSessionId: sessionReference.externalSessionId,
    status,
    mismatchStatus,
    mismatchReasons,
    assertedIssuer,
    assertedSubject,
    assertedExternalSessionId,
    attestedBy: actor.id,
    attestedAt: now,
    quarantinedBy: existing?.quarantinedBy ?? null,
    quarantinedAt: existing?.quarantinedAt ?? null,
    quarantineReason: existing?.quarantineReason ?? null,
    clearedBy: existing?.clearedBy ?? null,
    clearedAt: existing?.clearedAt ?? null,
    clearReason: existing?.clearReason ?? null,
    notes: input.note ? [...(existing?.notes ?? []), input.note] : (existing?.notes ?? []),
    updatedAt: now,
  }
  store.tenancyExternalSessionIdentityBridges.set(bridge.id, bridge)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_attest_external_session_identity_bridge",
    actorId: actor.id,
    target: sessionReference.id,
    classification: actor.clearanceLevel,
    reason: `issuer=${assertedIssuer}`,
    authBoundary: sessionReference.authBoundary,
    sessionReferenceId: sessionReference.id,
    externalSessionId: sessionReference.externalSessionId,
    delegatedBoundaryLineageRootSessionReferenceId:
      sessionReference.lineageRootSessionReferenceId || sessionReference.id,
    delegatedBoundaryComparedSessionReferenceId: null,
    delegatedBoundaryReconciliationStatus: sessionReference.delegatedBoundaryReconciliationStatus,
    delegatedBoundaryDivergenceReasons: sessionReference.delegatedBoundaryDivergenceReasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { bridge, auditEntry }
}

export function quarantineExternalSessionIdentityBridge(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    sessionReferenceId: string
    quarantineReason: string
    note?: string
    now?: number
  }
): {
  bridge: TenancyExternalSessionIdentityBridgeRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const sessionReference = store.tenancySessionReferences.get(input.sessionReferenceId)
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!sessionReference || sessionReference.firmId !== input.firmId) throw new PublicError("unknown session reference")
  const quarantineReason = input.quarantineReason.trim()
  if (!quarantineReason) throw new PublicError("quarantineReason is required")
  const now = input.now ?? Date.now()
  const bridgeId = externalSessionIdentityBridgeId(sessionReference.id)
  const existing = store.tenancyExternalSessionIdentityBridges.get(bridgeId)
  const bridge: TenancyExternalSessionIdentityBridgeRow = {
    id: bridgeId,
    firmId: input.firmId,
    lineageRootSessionReferenceId:
      sessionReference.lineageRootSessionReferenceId || sessionReference.id,
    sessionReferenceId: sessionReference.id,
    authBoundary: sessionReference.authBoundary,
    sessionExternalSessionId: sessionReference.externalSessionId,
    status: "quarantined",
    mismatchStatus: "mismatch_detected",
    mismatchReasons: [
      ...new Set([...(existing?.mismatchReasons ?? []), `manual_quarantine:${quarantineReason}`]),
    ],
    assertedIssuer: existing?.assertedIssuer ?? null,
    assertedSubject: existing?.assertedSubject ?? null,
    assertedExternalSessionId: existing?.assertedExternalSessionId ?? null,
    attestedBy: existing?.attestedBy ?? null,
    attestedAt: existing?.attestedAt ?? null,
    quarantinedBy: actor.id,
    quarantinedAt: now,
    quarantineReason,
    clearedBy: null,
    clearedAt: null,
    clearReason: null,
    notes: input.note ? [...(existing?.notes ?? []), input.note] : (existing?.notes ?? []),
    updatedAt: now,
  }
  store.tenancyExternalSessionIdentityBridges.set(bridge.id, bridge)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_quarantine_external_session_identity_bridge",
    actorId: actor.id,
    target: sessionReference.id,
    classification: actor.clearanceLevel,
    reason: quarantineReason,
    authBoundary: sessionReference.authBoundary,
    sessionReferenceId: sessionReference.id,
    externalSessionId: sessionReference.externalSessionId,
    delegatedBoundaryLineageRootSessionReferenceId:
      sessionReference.lineageRootSessionReferenceId || sessionReference.id,
    delegatedBoundaryComparedSessionReferenceId: null,
    delegatedBoundaryReconciliationStatus: sessionReference.delegatedBoundaryReconciliationStatus,
    delegatedBoundaryDivergenceReasons: sessionReference.delegatedBoundaryDivergenceReasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { bridge, auditEntry }
}

export function clearExternalSessionIdentityBridge(
  store: SpineStore,
  input: {
    actorId: string
    firmId: string
    sessionReferenceId: string
    clearReason: string
    note?: string
    now?: number
  }
): {
  bridge: TenancyExternalSessionIdentityBridgeRow
  auditEntry: NonNullable<SpineStore["audit"][number]>
} {
  const actor = requirePartnerInFirm(store, input.actorId, input.firmId)
  const sessionReference = store.tenancySessionReferences.get(input.sessionReferenceId)
  // One answer for not-found and other-firm (no cross-firm existence oracle).
  if (!sessionReference || sessionReference.firmId !== input.firmId) throw new PublicError("unknown session reference")
  const clearReason = input.clearReason.trim()
  if (!clearReason) throw new PublicError("clearReason is required")
  const now = input.now ?? Date.now()
  const bridgeId = externalSessionIdentityBridgeId(sessionReference.id)
  const existing = store.tenancyExternalSessionIdentityBridges.get(bridgeId)
  const bridge: TenancyExternalSessionIdentityBridgeRow = {
    id: bridgeId,
    firmId: input.firmId,
    lineageRootSessionReferenceId:
      sessionReference.lineageRootSessionReferenceId || sessionReference.id,
    sessionReferenceId: sessionReference.id,
    authBoundary: sessionReference.authBoundary,
    sessionExternalSessionId: sessionReference.externalSessionId,
    status: "cleared",
    mismatchStatus: "aligned",
    mismatchReasons: [],
    assertedIssuer: existing?.assertedIssuer ?? null,
    assertedSubject: existing?.assertedSubject ?? null,
    assertedExternalSessionId: existing?.assertedExternalSessionId ?? null,
    attestedBy: existing?.attestedBy ?? null,
    attestedAt: existing?.attestedAt ?? null,
    quarantinedBy: existing?.quarantinedBy ?? null,
    quarantinedAt: existing?.quarantinedAt ?? null,
    quarantineReason: existing?.quarantineReason ?? null,
    clearedBy: actor.id,
    clearedAt: now,
    clearReason,
    notes: input.note ? [...(existing?.notes ?? []), input.note] : (existing?.notes ?? []),
    updatedAt: now,
  }
  store.tenancyExternalSessionIdentityBridges.set(bridge.id, bridge)
  const auditEntry = {
    id: store.id("aud"),
    firmId: input.firmId,
    action: "tenant_clear_external_session_identity_bridge",
    actorId: actor.id,
    target: sessionReference.id,
    classification: actor.clearanceLevel,
    reason: clearReason,
    authBoundary: sessionReference.authBoundary,
    sessionReferenceId: sessionReference.id,
    externalSessionId: sessionReference.externalSessionId,
    delegatedBoundaryLineageRootSessionReferenceId:
      sessionReference.lineageRootSessionReferenceId || sessionReference.id,
    delegatedBoundaryComparedSessionReferenceId: null,
    delegatedBoundaryReconciliationStatus: sessionReference.delegatedBoundaryReconciliationStatus,
    delegatedBoundaryDivergenceReasons: sessionReference.delegatedBoundaryDivergenceReasons,
    at: now,
  } as const
  store.audit.push(auditEntry)
  return { bridge, auditEntry }
}

export function listExternalSessionIdentityBridges(
  store: SpineStore,
  actorId: string,
  firmId: string,
  status: TenancyExternalSessionIdentityBridgeStatus | undefined,
  mismatchStatus: TenancyExternalSessionIdentityBridgeMismatchStatus | undefined,
  lineageRootSessionReferenceId: string | undefined,
  limit: number,
  cursor: number
): {
  items: TenancyExternalSessionIdentityBridgeRow[]
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const rows = [...store.tenancyExternalSessionIdentityBridges.values()]
    .filter((row) => row.firmId === firmId)
    .filter((row) => (status ? row.status === status : true))
    .filter((row) => (mismatchStatus ? row.mismatchStatus === mismatchStatus : true))
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

export function listLineageClosureAdjudicationSettlements(
  store: SpineStore,
  actorId: string,
  firmId: string,
  status: TenancyClosureAdjudicationSettlementStatus | undefined,
  lineageRootSessionReferenceId: string | undefined,
  limit: number,
  cursor: number
): {
  items: TenancyLineageClosureAdjudicationSettlementRow[]
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const rows = [...store.tenancyLineageClosureAdjudicationSettlements.values()]
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

export function listLineageArbitrationDebtRetirementDisputeLedgers(
  store: SpineStore,
  actorId: string,
  firmId: string,
  status: TenancyArbitrationDebtRetirementDisputeStatus | undefined,
  lineageRootSessionReferenceId: string | undefined,
  limit: number,
  cursor: number
): {
  items: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow[]
  total: number
  nextCursor: string | null
} {
  requirePartnerInFirm(store, actorId, firmId)
  const rows = [...store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.values()]
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
