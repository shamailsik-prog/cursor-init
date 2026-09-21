import { NextResponse } from "next/server"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { isClassification } from "@/platform/p1/types"
import type {
  Role,
  TenancyAuthBoundary,
  TenancyLineageDisputeDisposition,
  TenancyLineageReconciliationQueueArbitrationDisposition,
  User,
} from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { syncFirmUsers } from "@/platform/persistence/userSync"
import { syncFirmAudit } from "@/platform/persistence/auditSync"
import { syncFirmTenancySessionReferences } from "@/platform/persistence/tenancySessionReferenceSync"
import {
  syncFirmTenancyLineageArbitrationDebtRetirementLedgers,
  syncFirmTenancyLineageClosureAdjudications,
  syncFirmTenancyLineageDisputeAttestations,
  syncFirmTenancyLineageDigestClosureCheckpoints,
  syncFirmTenancyLineageReconciliationQueueArbitrations,
  syncFirmTenancyLineageReconciliationDigests,
} from "@/platform/persistence/tenancyLineageSync"
import {
  arbitrateLineageReconciliationQueue,
  assignLineageReconciliationArbitration,
  attestLineageArbitrationDebtRetirement,
  attestSessionLineageDispute,
  buildSessionContext,
  ensureLineageReconciliationMonitoringRows,
  governLineageClosureAdjudication,
  getTenancySessionReferenceState,
  listLineageArbitrationDebtRetirementLedgers,
  listLineageClosureAdjudications,
  invalidateSessionReferencesForPrivilegeDrift,
  listLineageDigestClosureCheckpoints,
  listLineageReconciliationQueueArbitrations,
  listLineageReconciliationDigests,
  listFirmAudit,
  recordLineageClosureAdjudicationVerdict,
  listFirmMemberships,
  listFirmSessionReferences,
  listSessionLineageDisputes,
  listSessionReferenceLineage,
  reopenLineageDigestClosureCheckpoint,
  reopenLineageArbitrationDebtRetirement,
  recomputeLineageReconciliationDigest,
  listFirmUsers,
  reissueTenancySessionReference,
  attestLineageDigestClosureCheckpoint,
  resolveSessionLineageDispute,
  revokeTenancySessionReference,
  upsertTenancySessionReference,
  updateUserRole,
} from "@/platform/p5/tenancyAdmin"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

type UpdateRoleBody = {
  action: "update_role"
  actorId?: string
  firmId?: string
  targetUserId?: string
  nextRole?: Role
  nextClearance?: string
  reason?: string
  sessionReferenceId?: string
  authBoundary?: string
  externalSessionId?: string
}

type RevokeSessionReferenceBody = {
  action: "revoke_session_reference"
  actorId?: string
  firmId?: string
  sessionReferenceId?: string
  reason?: string
}

type ReissueSessionReferenceBody = {
  action: "reissue_session_reference"
  actorId?: string
  firmId?: string
  sessionReferenceId?: string
  authBoundary?: string
  externalSessionId?: string
  reason?: string
}

type AttestLineageDisputeBody = {
  action: "attest_session_lineage_dispute"
  actorId?: string
  firmId?: string
  sessionReferenceId?: string
  reason?: string
  note?: string
}

type ResolveLineageDisputeBody = {
  action: "resolve_session_lineage_dispute"
  actorId?: string
  firmId?: string
  disputeId?: string
  disposition?: string
  resolutionNote?: string
}

type AssignLineageReconciliationQueueBody = {
  action: "assign_lineage_reconciliation_queue"
  actorId?: string
  firmId?: string
  lineageRootSessionReferenceId?: string
  assignedPartnerId?: string
  slaWindowMinutes?: number
  note?: string
}

type ArbitrateLineageReconciliationQueueBody = {
  action: "arbitrate_lineage_reconciliation_queue"
  actorId?: string
  firmId?: string
  lineageRootSessionReferenceId?: string
  disposition?: string
  note?: string
}

type AttestLineageDigestClosureBody = {
  action: "attest_lineage_digest_closure"
  actorId?: string
  firmId?: string
  lineageRootSessionReferenceId?: string
  closureReason?: string
  note?: string
}

type ReopenLineageDigestClosureBody = {
  action: "reopen_lineage_digest_closure"
  actorId?: string
  firmId?: string
  lineageRootSessionReferenceId?: string
  reopenTrigger?: string
  note?: string
}

type GovernLineageClosureAdjudicationBody = {
  action: "govern_lineage_closure_adjudication"
  actorId?: string
  firmId?: string
  lineageRootSessionReferenceId?: string
  panelPartnerIds?: string[]
  requiredPanelQuorum?: number
  verdictWindowMinutes?: number
  note?: string
}

type RecordLineageClosureAdjudicationVerdictBody = {
  action: "record_lineage_closure_adjudication_verdict"
  actorId?: string
  firmId?: string
  lineageRootSessionReferenceId?: string
  disposition?: string
  dispositionDriftReasons?: string[]
  note?: string
}

type AttestLineageArbitrationDebtRetirementBody = {
  action: "attest_lineage_arbitration_debt_retirement"
  actorId?: string
  firmId?: string
  lineageRootSessionReferenceId?: string
  retirementNote?: string
  note?: string
}

type ReopenLineageArbitrationDebtRetirementBody = {
  action: "reopen_lineage_arbitration_debt_retirement"
  actorId?: string
  firmId?: string
  lineageRootSessionReferenceId?: string
  carryoverSignal?: string
  note?: string
}

type Body =
  | UpdateRoleBody
  | RevokeSessionReferenceBody
  | ReissueSessionReferenceBody
  | AttestLineageDisputeBody
  | ResolveLineageDisputeBody
  | AssignLineageReconciliationQueueBody
  | ArbitrateLineageReconciliationQueueBody
  | AttestLineageDigestClosureBody
  | ReopenLineageDigestClosureBody
  | GovernLineageClosureAdjudicationBody
  | RecordLineageClosureAdjudicationVerdictBody
  | AttestLineageArbitrationDebtRetirementBody
  | ReopenLineageArbitrationDebtRetirementBody

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 25
  if (!Number.isFinite(parsed) || parsed < 1) return 25
  return Math.min(parsed, 100)
}

function parseCursor(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 0
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

function parseBoolean(value: string | null): boolean {
  return value === "1" || value === "true" || value === "yes"
}

function parseLineageDisputeStatus(value: string | null): "open" | "resolved" | undefined {
  if (!value) return undefined
  if (value === "open" || value === "resolved") return value
  throw new Error("status must be open or resolved")
}

function parseLineageDigestStatus(value: string | null): "aligned" | "needs_review" | undefined {
  if (!value) return undefined
  if (value === "aligned" || value === "needs_review") return value
  throw new Error("status must be aligned or needs_review")
}

function parseLineageDisputeDisposition(
  value: unknown
): TenancyLineageDisputeDisposition | undefined {
  if (value == null || value === "") return undefined
  if (
    value === "confirm_divergence" ||
    value === "dismiss_dispute" ||
    value === "mark_reconciled"
  ) {
    return value
  }
  throw new Error("disposition must be confirm_divergence, dismiss_dispute, or mark_reconciled")
}

function parseLineageArbitrationDisposition(
  value: unknown
): TenancyLineageReconciliationQueueArbitrationDisposition | undefined {
  if (value == null || value === "") return undefined
  if (
    value === "confirm_needs_review" ||
    value === "dismiss_needs_review" ||
    value === "mark_reconciled"
  ) {
    return value
  }
  throw new Error(
    "disposition must be confirm_needs_review, dismiss_needs_review, or mark_reconciled"
  )
}

function parseLineageQueueStatus(value: string | null): "queued" | "assigned" | "arbitrated" | undefined {
  if (!value) return undefined
  if (value === "queued" || value === "assigned" || value === "arbitrated") return value
  throw new Error("status must be queued, assigned, or arbitrated")
}

function parseLineageClosureStatus(
  value: string | null
): "pending_attestation" | "closed_attested" | "reopened" | undefined {
  if (!value) return undefined
  if (value === "pending_attestation" || value === "closed_attested" || value === "reopened") {
    return value
  }
  throw new Error("status must be pending_attestation, closed_attested, or reopened")
}

function parseLineageClosureAdjudicationStatus(
  value: string | null
): "standby" | "quorum_pending" | "verdict_window_open" | "verdict_recorded" | undefined {
  if (!value) return undefined
  if (
    value === "standby" ||
    value === "quorum_pending" ||
    value === "verdict_window_open" ||
    value === "verdict_recorded"
  ) {
    return value
  }
  throw new Error(
    "status must be standby, quorum_pending, verdict_window_open, or verdict_recorded"
  )
}

function parseLineageDebtRetirementStatus(
  value: string | null
): "pressure_open" | "retirement_attested" | "carryover_reopened" | undefined {
  if (!value) return undefined
  if (
    value === "pressure_open" ||
    value === "retirement_attested" ||
    value === "carryover_reopened"
  ) {
    return value
  }
  throw new Error("status must be pressure_open, retirement_attested, or carryover_reopened")
}

function isRole(value: unknown): value is Role {
  return (
    value === "partner" ||
    value === "associate" ||
    value === "clerk" ||
    value === "intern" ||
    value === "accounts" ||
    value === "client"
  )
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function parseAuthBoundary(value: unknown): TenancyAuthBoundary | undefined {
  if (value == null || value === "") return undefined
  if (value === "runtime_local" || value === "external_session_hint") return value
  throw new Error("authBoundary must be runtime_local or external_session_hint")
}

async function loadUser(
  store: ReturnType<typeof getRuntimeStore>,
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>,
  userId: string
): Promise<User | null> {
  const cached = store.users.get(userId)
  if (cached) return cached
  const row = await repos.users.get(userId)
  if (!row) return null
  store.users.set(row.id, row)
  return row
}

async function recomputeAndPersistLineageDigestState(
  store: ReturnType<typeof getRuntimeStore>,
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>,
  input: {
    firmId: string
    lineageRootSessionReferenceId: string
  }
) {
  const digest = recomputeLineageReconciliationDigest(store, {
    firmId: input.firmId,
    lineageRootSessionReferenceId: input.lineageRootSessionReferenceId,
  })
  await repos.tenancyLineageReconciliationDigests.upsert(digest)
  const monitoring = ensureLineageReconciliationMonitoringRows(store, {
    firmId: input.firmId,
    digest,
  })
  await repos.tenancyLineageReconciliationQueueArbitrations.upsert(monitoring.arbitrationQueue)
  await repos.tenancyLineageDigestClosureCheckpoints.upsert(monitoring.closureCheckpoint)
  await repos.tenancyLineageClosureAdjudications.upsert(monitoring.closureAdjudication)
  await repos.tenancyLineageArbitrationDebtRetirementLedgers.upsert(
    monitoring.arbitrationDebtRetirementLedger
  )
  return { digest, monitoring }
}

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = url.searchParams.get("view") ?? "session"
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))

  try {
    if (view === "session") {
      const requestedUserId = normalizeOptionalString(url.searchParams.get("userId"))
      const requestedFirmId = normalizeOptionalString(url.searchParams.get("firmId"))
      const sessionReferenceId = normalizeOptionalString(url.searchParams.get("sessionRefId"))
      const authBoundary = parseAuthBoundary(url.searchParams.get("authBoundary"))
      const externalSessionId = normalizeOptionalString(url.searchParams.get("externalSessionId"))

      if (!requestedUserId && !sessionReferenceId) {
        return NextResponse.json(
          { error: "userId or sessionRefId is required" },
          { status: 400 }
        )
      }

      let resolvedUserId = requestedUserId
      let resolvedFirmId = requestedFirmId
      let existingReference = null
      if (sessionReferenceId) {
        existingReference = await repos.tenancySessionReferences.get(sessionReferenceId)
        if (!existingReference) {
          return NextResponse.json({ error: "unknown session reference" }, { status: 404 })
        }
        const state = getTenancySessionReferenceState(existingReference)
        if (state === "revoked") {
          return NextResponse.json({ error: "session reference revoked" }, { status: 410 })
        }
        if (state === "expired") {
          return NextResponse.json({ error: "session reference expired" }, { status: 410 })
        }
        store.tenancySessionReferences.set(existingReference.id, existingReference)
        if (requestedUserId && requestedUserId !== existingReference.userId) {
          return NextResponse.json({ error: "session reference user mismatch" }, { status: 400 })
        }
        if (requestedFirmId && requestedFirmId !== existingReference.firmId) {
          return NextResponse.json({ error: "cross-firm session reference denied" }, { status: 400 })
        }
        resolvedUserId = existingReference.userId
        resolvedFirmId = existingReference.firmId
      }

      if (!resolvedUserId) {
        return NextResponse.json({ error: "userId is required" }, { status: 400 })
      }

      const user = await loadUser(store, repos, resolvedUserId)
      if (!user) {
        return NextResponse.json({ error: "unknown user" }, { status: 400 })
      }
      if (resolvedFirmId && resolvedFirmId !== user.firmId) {
        return NextResponse.json({ error: "firm scope mismatch" }, { status: 400 })
      }
      if (
        existingReference &&
        (existingReference.roleSnapshot !== user.role ||
          existingReference.clearanceSnapshot !== user.clearanceLevel)
      ) {
        const now = Date.now()
        const staleReference = {
          ...existingReference,
          revokedAt: now,
          revokedBy: user.id,
          revokedReason: "privileged_boundary_drift",
          privilegedBoundaryDriftedAt: now,
          privilegedBoundaryDriftedBy: user.id,
          privilegedBoundaryDriftReason: "role_or_clearance_changed",
        }
        store.tenancySessionReferences.set(staleReference.id, staleReference)
        await repos.tenancySessionReferences.upsert(staleReference)
        return NextResponse.json({ error: "session reference stale due privilege drift" }, { status: 410 })
      }
      await syncFirmUsers(store, repos, user.firmId)
      await syncFirmMembers(store, repos, user.firmId)
      const session = buildSessionContext(store, user.id, resolvedFirmId ?? user.firmId)
      const sessionReference = upsertTenancySessionReference(store, {
        user: session.user,
        existing: existingReference,
        sessionReferenceId,
        authBoundary,
        externalSessionId,
      })
      await repos.tenancySessionReferences.upsert(sessionReference)
      return NextResponse.json({
        view: "session",
        session,
        sessionReference: {
          id: sessionReference.id,
          firmId: sessionReference.firmId,
          userId: sessionReference.userId,
          parentSessionReferenceId: sessionReference.parentSessionReferenceId,
          lineageRootSessionReferenceId: sessionReference.lineageRootSessionReferenceId,
          lineageDepth: sessionReference.lineageDepth,
          authBoundary: sessionReference.authBoundary,
          externalSessionId: sessionReference.externalSessionId,
          delegatedBoundaryComparedSessionReferenceId:
            sessionReference.delegatedBoundaryComparedSessionReferenceId,
          delegatedBoundaryReconciliationStatus:
            sessionReference.delegatedBoundaryReconciliationStatus,
          delegatedBoundaryDivergenceReasons:
            sessionReference.delegatedBoundaryDivergenceReasons,
          delegatedBoundaryReconciledAt: sessionReference.delegatedBoundaryReconciledAt,
          delegatedBoundaryReconciledBy: sessionReference.delegatedBoundaryReconciledBy,
          issuedAt: sessionReference.issuedAt,
          lastSeenAt: sessionReference.lastSeenAt,
          expiresAt: sessionReference.expiresAt,
          revokedAt: sessionReference.revokedAt,
          revokedBy: sessionReference.revokedBy,
          revokedReason: sessionReference.revokedReason,
        },
        limit,
        cursor,
      })
    }

    if (view === "users") {
      const actorId = url.searchParams.get("actorId")
      const firmId = url.searchParams.get("firmId")
      if (!actorId || !firmId) {
        return NextResponse.json({ error: "actorId and firmId are required" }, { status: 400 })
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmMembers(store, repos, firmId)
      const users = listFirmUsers(store, actorId, firmId, limit, cursor)
      return NextResponse.json({
        view: "users",
        items: users.items,
        total: users.total,
        limit,
        cursor,
        nextCursor: users.nextCursor,
      })
    }

    if (view === "memberships") {
      const actorId = url.searchParams.get("actorId")
      const firmId = url.searchParams.get("firmId")
      const matterId = url.searchParams.get("matterId") ?? undefined
      if (!actorId || !firmId) {
        return NextResponse.json({ error: "actorId and firmId are required" }, { status: 400 })
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmMembers(store, repos, firmId)
      const memberships = listFirmMemberships(
        store,
        actorId,
        firmId,
        matterId,
        limit,
        cursor
      )
      return NextResponse.json({
        view: "memberships",
        items: memberships.items,
        total: memberships.total,
        limit,
        cursor,
        nextCursor: memberships.nextCursor,
      })
    }

    if (view === "audit") {
      const actorId = url.searchParams.get("actorId")
      const firmId = url.searchParams.get("firmId")
      if (!actorId || !firmId) {
        return NextResponse.json({ error: "actorId and firmId are required" }, { status: 400 })
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmAudit(store, repos, firmId)
      const audit = listFirmAudit(store, actorId, firmId, limit, cursor)
      return NextResponse.json({
        view: "audit",
        items: audit.items,
        total: audit.total,
        limit,
        cursor,
        nextCursor: audit.nextCursor,
      })
    }

    if (view === "session_refs") {
      const actorId = url.searchParams.get("actorId")
      const firmId = url.searchParams.get("firmId")
      const userId = normalizeOptionalString(url.searchParams.get("userId"))
      if (!actorId || !firmId) {
        return NextResponse.json({ error: "actorId and firmId are required" }, { status: 400 })
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      const refs = listFirmSessionReferences(store, actorId, firmId, userId, limit, cursor)
      return NextResponse.json({
        view: "session_refs",
        items: refs.items,
        total: refs.total,
        limit,
        cursor,
        nextCursor: refs.nextCursor,
      })
    }

    if (view === "session_lineage") {
      const actorId = url.searchParams.get("actorId")
      const firmId = url.searchParams.get("firmId")
      const rootSessionReferenceId = normalizeOptionalString(url.searchParams.get("rootSessionRefId"))
      const delegatedDivergedOnly = parseBoolean(url.searchParams.get("delegatedDivergedOnly"))
      if (!actorId || !firmId || !rootSessionReferenceId) {
        return NextResponse.json(
          { error: "actorId, firmId, and rootSessionRefId are required" },
          { status: 400 }
        )
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      const lineage = listSessionReferenceLineage(
        store,
        actorId,
        firmId,
        rootSessionReferenceId,
        delegatedDivergedOnly,
        limit,
        cursor
      )
      return NextResponse.json({
        view: "session_lineage",
        items: lineage.items,
        total: lineage.total,
        limit,
        cursor,
        nextCursor: lineage.nextCursor,
      })
    }

    if (view === "session_lineage_disputes") {
      const actorId = url.searchParams.get("actorId")
      const firmId = url.searchParams.get("firmId")
      const lineageRootSessionReferenceId = normalizeOptionalString(
        url.searchParams.get("rootSessionRefId")
      )
      const status = parseLineageDisputeStatus(url.searchParams.get("status"))
      if (!actorId || !firmId) {
        return NextResponse.json({ error: "actorId and firmId are required" }, { status: 400 })
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      const disputes = listSessionLineageDisputes(
        store,
        actorId,
        firmId,
        lineageRootSessionReferenceId,
        status,
        limit,
        cursor
      )
      return NextResponse.json({
        view: "session_lineage_disputes",
        items: disputes.items,
        total: disputes.total,
        limit,
        cursor,
        nextCursor: disputes.nextCursor,
      })
    }

    if (view === "session_lineage_reconciliation_digests") {
      const actorId = url.searchParams.get("actorId")
      const firmId = url.searchParams.get("firmId")
      const lineageRootSessionReferenceId = normalizeOptionalString(
        url.searchParams.get("rootSessionRefId")
      )
      const status = parseLineageDigestStatus(url.searchParams.get("status"))
      if (!actorId || !firmId) {
        return NextResponse.json({ error: "actorId and firmId are required" }, { status: 400 })
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const rootIds = new Set<string>()
      for (const row of store.tenancySessionReferences.values()) {
        if (row.firmId !== firmId) continue
        if (
          lineageRootSessionReferenceId &&
          row.lineageRootSessionReferenceId !== lineageRootSessionReferenceId
        ) {
          continue
        }
        rootIds.add(row.lineageRootSessionReferenceId)
      }
      for (const rootId of rootIds) {
        await recomputeAndPersistLineageDigestState(store, repos, {
          firmId,
          lineageRootSessionReferenceId: rootId,
        })
      }
      const digests = listLineageReconciliationDigests(
        store,
        actorId,
        firmId,
        status,
        limit,
        cursor
      )
      return NextResponse.json({
        view: "session_lineage_reconciliation_digests",
        items: digests.items,
        total: digests.total,
        limit,
        cursor,
        nextCursor: digests.nextCursor,
      })
    }

    if (view === "session_lineage_reconciliation_queue") {
      const actorId = url.searchParams.get("actorId")
      const firmId = url.searchParams.get("firmId")
      const lineageRootSessionReferenceId = normalizeOptionalString(
        url.searchParams.get("rootSessionRefId")
      )
      const status = parseLineageQueueStatus(url.searchParams.get("status"))
      if (!actorId || !firmId) {
        return NextResponse.json({ error: "actorId and firmId are required" }, { status: 400 })
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const rootIds = new Set<string>()
      for (const row of store.tenancySessionReferences.values()) {
        if (row.firmId !== firmId) continue
        if (
          lineageRootSessionReferenceId &&
          row.lineageRootSessionReferenceId !== lineageRootSessionReferenceId
        ) {
          continue
        }
        rootIds.add(row.lineageRootSessionReferenceId)
      }
      for (const rootId of rootIds) {
        await recomputeAndPersistLineageDigestState(store, repos, {
          firmId,
          lineageRootSessionReferenceId: rootId,
        })
      }
      const queue = listLineageReconciliationQueueArbitrations(
        store,
        actorId,
        firmId,
        status,
        lineageRootSessionReferenceId,
        limit,
        cursor
      )
      return NextResponse.json({
        view: "session_lineage_reconciliation_queue",
        items: queue.items,
        total: queue.total,
        limit,
        cursor,
        nextCursor: queue.nextCursor,
      })
    }

    if (view === "session_lineage_digest_closure_checkpoints") {
      const actorId = url.searchParams.get("actorId")
      const firmId = url.searchParams.get("firmId")
      const lineageRootSessionReferenceId = normalizeOptionalString(
        url.searchParams.get("rootSessionRefId")
      )
      const status = parseLineageClosureStatus(url.searchParams.get("status"))
      if (!actorId || !firmId) {
        return NextResponse.json({ error: "actorId and firmId are required" }, { status: 400 })
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const rootIds = new Set<string>()
      for (const row of store.tenancySessionReferences.values()) {
        if (row.firmId !== firmId) continue
        if (
          lineageRootSessionReferenceId &&
          row.lineageRootSessionReferenceId !== lineageRootSessionReferenceId
        ) {
          continue
        }
        rootIds.add(row.lineageRootSessionReferenceId)
      }
      for (const rootId of rootIds) {
        await recomputeAndPersistLineageDigestState(store, repos, {
          firmId,
          lineageRootSessionReferenceId: rootId,
        })
      }
      const checkpoints = listLineageDigestClosureCheckpoints(
        store,
        actorId,
        firmId,
        status,
        lineageRootSessionReferenceId,
        limit,
        cursor
      )
      return NextResponse.json({
        view: "session_lineage_digest_closure_checkpoints",
        items: checkpoints.items,
        total: checkpoints.total,
        limit,
        cursor,
        nextCursor: checkpoints.nextCursor,
      })
    }

    if (view === "session_lineage_closure_adjudications") {
      const actorId = url.searchParams.get("actorId")
      const firmId = url.searchParams.get("firmId")
      const lineageRootSessionReferenceId = normalizeOptionalString(
        url.searchParams.get("rootSessionRefId")
      )
      const status = parseLineageClosureAdjudicationStatus(url.searchParams.get("status"))
      if (!actorId || !firmId) {
        return NextResponse.json({ error: "actorId and firmId are required" }, { status: 400 })
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const rootIds = new Set<string>()
      for (const row of store.tenancySessionReferences.values()) {
        if (row.firmId !== firmId) continue
        if (
          lineageRootSessionReferenceId &&
          row.lineageRootSessionReferenceId !== lineageRootSessionReferenceId
        ) {
          continue
        }
        rootIds.add(row.lineageRootSessionReferenceId)
      }
      for (const rootId of rootIds) {
        await recomputeAndPersistLineageDigestState(store, repos, {
          firmId,
          lineageRootSessionReferenceId: rootId,
        })
      }
      const adjudications = listLineageClosureAdjudications(
        store,
        actorId,
        firmId,
        status,
        lineageRootSessionReferenceId,
        limit,
        cursor
      )
      return NextResponse.json({
        view: "session_lineage_closure_adjudications",
        items: adjudications.items,
        total: adjudications.total,
        limit,
        cursor,
        nextCursor: adjudications.nextCursor,
      })
    }

    if (view === "session_lineage_arbitration_debt_retirement_ledgers") {
      const actorId = url.searchParams.get("actorId")
      const firmId = url.searchParams.get("firmId")
      const lineageRootSessionReferenceId = normalizeOptionalString(
        url.searchParams.get("rootSessionRefId")
      )
      const status = parseLineageDebtRetirementStatus(url.searchParams.get("status"))
      if (!actorId || !firmId) {
        return NextResponse.json({ error: "actorId and firmId are required" }, { status: 400 })
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const rootIds = new Set<string>()
      for (const row of store.tenancySessionReferences.values()) {
        if (row.firmId !== firmId) continue
        if (
          lineageRootSessionReferenceId &&
          row.lineageRootSessionReferenceId !== lineageRootSessionReferenceId
        ) {
          continue
        }
        rootIds.add(row.lineageRootSessionReferenceId)
      }
      for (const rootId of rootIds) {
        await recomputeAndPersistLineageDigestState(store, repos, {
          firmId,
          lineageRootSessionReferenceId: rootId,
        })
      }
      const ledgers = listLineageArbitrationDebtRetirementLedgers(
        store,
        actorId,
        firmId,
        status,
        lineageRootSessionReferenceId,
        limit,
        cursor
      )
      return NextResponse.json({
        view: "session_lineage_arbitration_debt_retirement_ledgers",
        items: ledgers.items,
        total: ledgers.total,
        limit,
        cursor,
        nextCursor: ledgers.nextCursor,
      })
    }

    return NextResponse.json({ error: "unknown view" }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "tenancy read failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function POST(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  let key: string
  try {
    key = requireIdempotencyKey(request)
  } catch (err) {
    const message =
      err instanceof IdempotencyError ? err.message : "Idempotency-Key header required"
    return NextResponse.json({ error: message }, { status: 400 })
  }

  let parsed: Body
  try {
    parsed = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  if (
    parsed.action !== "update_role" &&
    parsed.action !== "revoke_session_reference" &&
    parsed.action !== "reissue_session_reference" &&
    parsed.action !== "attest_session_lineage_dispute" &&
    parsed.action !== "resolve_session_lineage_dispute" &&
    parsed.action !== "assign_lineage_reconciliation_queue" &&
    parsed.action !== "arbitrate_lineage_reconciliation_queue" &&
    parsed.action !== "attest_lineage_digest_closure" &&
    parsed.action !== "reopen_lineage_digest_closure" &&
    parsed.action !== "govern_lineage_closure_adjudication" &&
    parsed.action !== "record_lineage_closure_adjudication_verdict" &&
    parsed.action !== "attest_lineage_arbitration_debt_retirement" &&
    parsed.action !== "reopen_lineage_arbitration_debt_retirement"
  ) {
    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  }

  if (parsed.action === "update_role") {
    if (!parsed.actorId || !parsed.firmId || !parsed.targetUserId || !isRole(parsed.nextRole)) {
      return NextResponse.json(
        { error: "actorId, firmId, targetUserId, and nextRole are required" },
        { status: 400 }
      )
    }
    if (!isClassification(parsed.nextClearance)) {
      return NextResponse.json(
        { error: "nextClearance must be a rank-0–4 label" },
        { status: 400 }
      )
    }
  } else if (parsed.action === "resolve_session_lineage_dispute") {
    if (!parsed.actorId || !parsed.firmId || !parsed.disputeId) {
      return NextResponse.json(
        { error: "actorId, firmId, and disputeId are required" },
        { status: 400 }
      )
    }
    if (
      parsed.disposition !== "confirm_divergence" &&
      parsed.disposition !== "dismiss_dispute" &&
      parsed.disposition !== "mark_reconciled"
    ) {
      return NextResponse.json(
        { error: "disposition must be confirm_divergence, dismiss_dispute, or mark_reconciled" },
        { status: 400 }
      )
    }
  } else if (parsed.action === "assign_lineage_reconciliation_queue") {
    if (
      !parsed.actorId ||
      !parsed.firmId ||
      !parsed.lineageRootSessionReferenceId ||
      !parsed.assignedPartnerId
    ) {
      return NextResponse.json(
        {
          error:
            "actorId, firmId, lineageRootSessionReferenceId, and assignedPartnerId are required",
        },
        { status: 400 }
      )
    }
  } else if (parsed.action === "arbitrate_lineage_reconciliation_queue") {
    if (!parsed.actorId || !parsed.firmId || !parsed.lineageRootSessionReferenceId) {
      return NextResponse.json(
        { error: "actorId, firmId, and lineageRootSessionReferenceId are required" },
        { status: 400 }
      )
    }
    if (
      parsed.disposition !== "confirm_needs_review" &&
      parsed.disposition !== "dismiss_needs_review" &&
      parsed.disposition !== "mark_reconciled"
    ) {
      return NextResponse.json(
        {
          error:
            "disposition must be confirm_needs_review, dismiss_needs_review, or mark_reconciled",
        },
        { status: 400 }
      )
    }
  } else if (parsed.action === "attest_lineage_digest_closure") {
    if (
      !parsed.actorId ||
      !parsed.firmId ||
      !parsed.lineageRootSessionReferenceId ||
      !normalizeOptionalString(parsed.closureReason)
    ) {
      return NextResponse.json(
        { error: "actorId, firmId, lineageRootSessionReferenceId, and closureReason are required" },
        { status: 400 }
      )
    }
  } else if (parsed.action === "reopen_lineage_digest_closure") {
    if (
      !parsed.actorId ||
      !parsed.firmId ||
      !parsed.lineageRootSessionReferenceId ||
      !normalizeOptionalString(parsed.reopenTrigger)
    ) {
      return NextResponse.json(
        { error: "actorId, firmId, lineageRootSessionReferenceId, and reopenTrigger are required" },
        { status: 400 }
      )
    }
  } else if (parsed.action === "govern_lineage_closure_adjudication") {
    if (!parsed.actorId || !parsed.firmId || !parsed.lineageRootSessionReferenceId) {
      return NextResponse.json(
        { error: "actorId, firmId, and lineageRootSessionReferenceId are required" },
        { status: 400 }
      )
    }
    if (!Array.isArray(parsed.panelPartnerIds) || parsed.panelPartnerIds.length === 0) {
      return NextResponse.json(
        { error: "panelPartnerIds must include at least one partner ID" },
        { status: 400 }
      )
    }
  } else if (parsed.action === "record_lineage_closure_adjudication_verdict") {
    if (!parsed.actorId || !parsed.firmId || !parsed.lineageRootSessionReferenceId) {
      return NextResponse.json(
        { error: "actorId, firmId, and lineageRootSessionReferenceId are required" },
        { status: 400 }
      )
    }
    if (
      parsed.disposition !== "confirm_needs_review" &&
      parsed.disposition !== "dismiss_needs_review" &&
      parsed.disposition !== "mark_reconciled"
    ) {
      return NextResponse.json(
        {
          error:
            "disposition must be confirm_needs_review, dismiss_needs_review, or mark_reconciled",
        },
        { status: 400 }
      )
    }
  } else if (parsed.action === "attest_lineage_arbitration_debt_retirement") {
    if (
      !parsed.actorId ||
      !parsed.firmId ||
      !parsed.lineageRootSessionReferenceId ||
      !normalizeOptionalString(parsed.retirementNote)
    ) {
      return NextResponse.json(
        { error: "actorId, firmId, lineageRootSessionReferenceId, and retirementNote are required" },
        { status: 400 }
      )
    }
  } else if (parsed.action === "reopen_lineage_arbitration_debt_retirement") {
    if (
      !parsed.actorId ||
      !parsed.firmId ||
      !parsed.lineageRootSessionReferenceId ||
      !normalizeOptionalString(parsed.carryoverSignal)
    ) {
      return NextResponse.json(
        { error: "actorId, firmId, lineageRootSessionReferenceId, and carryoverSignal are required" },
        { status: 400 }
      )
    }
  } else if (!parsed.actorId || !parsed.firmId || !parsed.sessionReferenceId) {
    return NextResponse.json(
      { error: "actorId, firmId, and sessionReferenceId are required" },
      { status: 400 }
    )
  }

  const fingerprint = JSON.stringify({
    route: "/api/p5/tenancy",
    action: parsed.action,
    body: parsed,
  })
  const replay = idempotency.getReplay(key, fingerprint)
  if (replay.conflict) {
    return NextResponse.json(
      { error: "Idempotency-Key reused with a different request payload" },
      { status: 409 }
    )
  }
  if (replay.body !== undefined) {
    return NextResponse.json({ result: replay.body, idempotencyKey: key, reused: true })
  }

  try {
    if (parsed.action === "revoke_session_reference") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const sessionReferenceId = parsed.sessionReferenceId
      if (!actorId || !firmId || !sessionReferenceId) {
        throw new Error("actorId, firmId, and sessionReferenceId are required")
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const revoked = revokeTenancySessionReference(store, {
        actorId,
        firmId,
        sessionReferenceId,
        reason: normalizeOptionalString(parsed.reason),
      })
      await repos.tenancySessionReferences.upsert(revoked.reference)
      await repos.audit.append(revoked.auditEntry)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId: revoked.reference.lineageRootSessionReferenceId,
      })
      const payload = {
        action: "revoke_session_reference",
        sessionReference: {
          id: revoked.reference.id,
          userId: revoked.reference.userId,
          firmId: revoked.reference.firmId,
          revokedAt: revoked.reference.revokedAt,
          revokedBy: revoked.reference.revokedBy,
          revokedReason: revoked.reference.revokedReason,
        },
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          lineageNodeCount: digest.lineageNodeCount,
          divergedHopCount: digest.divergedHopCount,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
          status: digest.status,
          reasons: digest.reasons,
        },
        arbitrationQueue: {
          id: monitoring.arbitrationQueue.id,
          status: monitoring.arbitrationQueue.status,
          assignedPartnerId: monitoring.arbitrationQueue.assignedPartnerId,
          disposition: monitoring.arbitrationQueue.disposition,
        },
        closureCheckpoint: {
          id: monitoring.closureCheckpoint.id,
          status: monitoring.closureCheckpoint.status,
          attestedBy: monitoring.closureCheckpoint.attestedBy,
          reopenTrigger: monitoring.closureCheckpoint.reopenTrigger,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reissue_session_reference") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const parentSessionReferenceId = parsed.sessionReferenceId
      if (!actorId || !firmId || !parentSessionReferenceId) {
        throw new Error("actorId, firmId, and sessionReferenceId are required")
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const reissued = reissueTenancySessionReference(store, {
        actorId,
        firmId,
        parentSessionReferenceId,
        authBoundary: parseAuthBoundary(parsed.authBoundary),
        externalSessionId: normalizeOptionalString(parsed.externalSessionId),
        reason: normalizeOptionalString(parsed.reason),
      })
      await repos.tenancySessionReferences.upsert(reissued.reference)
      await repos.audit.append(reissued.auditEntry)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId: reissued.reference.lineageRootSessionReferenceId,
      })
      const payload = {
        action: "reissue_session_reference",
        sessionReference: {
          id: reissued.reference.id,
          userId: reissued.reference.userId,
          firmId: reissued.reference.firmId,
          parentSessionReferenceId: reissued.reference.parentSessionReferenceId,
          lineageRootSessionReferenceId: reissued.reference.lineageRootSessionReferenceId,
          lineageDepth: reissued.reference.lineageDepth,
          delegatedBoundaryComparedSessionReferenceId:
            reissued.reference.delegatedBoundaryComparedSessionReferenceId,
          delegatedBoundaryReconciliationStatus:
            reissued.reference.delegatedBoundaryReconciliationStatus,
          delegatedBoundaryDivergenceReasons:
            reissued.reference.delegatedBoundaryDivergenceReasons,
          delegatedBoundaryReconciledAt: reissued.reference.delegatedBoundaryReconciledAt,
          delegatedBoundaryReconciledBy: reissued.reference.delegatedBoundaryReconciledBy,
        },
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          lineageNodeCount: digest.lineageNodeCount,
          divergedHopCount: digest.divergedHopCount,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
          status: digest.status,
          reasons: digest.reasons,
        },
        arbitrationQueue: {
          id: monitoring.arbitrationQueue.id,
          status: monitoring.arbitrationQueue.status,
          assignedPartnerId: monitoring.arbitrationQueue.assignedPartnerId,
          disposition: monitoring.arbitrationQueue.disposition,
        },
        closureCheckpoint: {
          id: monitoring.closureCheckpoint.id,
          status: monitoring.closureCheckpoint.status,
          attestedBy: monitoring.closureCheckpoint.attestedBy,
          reopenTrigger: monitoring.closureCheckpoint.reopenTrigger,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_session_lineage_dispute") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const sessionReferenceId = parsed.sessionReferenceId
      const reason = normalizeOptionalString(parsed.reason)
      if (!actorId || !firmId || !sessionReferenceId || !reason) {
        throw new Error("actorId, firmId, sessionReferenceId, and reason are required")
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const attested = attestSessionLineageDispute(store, {
        actorId,
        firmId,
        sessionReferenceId,
        reason,
        note: normalizeOptionalString(parsed.note),
      })
      await repos.tenancyLineageDisputeAttestations.upsert(attested.dispute)
      await repos.audit.append(attested.auditEntry)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId: attested.dispute.lineageRootSessionReferenceId,
      })
      const payload = {
        action: "attest_session_lineage_dispute",
        dispute: attested.dispute,
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          lineageNodeCount: digest.lineageNodeCount,
          divergedHopCount: digest.divergedHopCount,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
          status: digest.status,
          reasons: digest.reasons,
        },
        arbitrationQueue: {
          id: monitoring.arbitrationQueue.id,
          status: monitoring.arbitrationQueue.status,
          assignedPartnerId: monitoring.arbitrationQueue.assignedPartnerId,
          disposition: monitoring.arbitrationQueue.disposition,
        },
        closureCheckpoint: {
          id: monitoring.closureCheckpoint.id,
          status: monitoring.closureCheckpoint.status,
          attestedBy: monitoring.closureCheckpoint.attestedBy,
          reopenTrigger: monitoring.closureCheckpoint.reopenTrigger,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_session_lineage_dispute") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const disputeId = parsed.disputeId
      const disposition = parseLineageDisputeDisposition(parsed.disposition)
      if (!actorId || !firmId || !disputeId || !disposition) {
        throw new Error("actorId, firmId, disputeId, and disposition are required")
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const resolved = resolveSessionLineageDispute(store, {
        actorId,
        firmId,
        disputeId,
        disposition,
        resolutionNote: normalizeOptionalString(parsed.resolutionNote),
      })
      await repos.tenancyLineageDisputeAttestations.upsert(resolved.dispute)
      if (resolved.relatedSessionReference) {
        await repos.tenancySessionReferences.upsert(resolved.relatedSessionReference)
      }
      await repos.audit.append(resolved.auditEntry)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId: resolved.dispute.lineageRootSessionReferenceId,
      })
      const payload = {
        action: "resolve_session_lineage_dispute",
        dispute: resolved.dispute,
        relatedSessionReference: resolved.relatedSessionReference
          ? {
              id: resolved.relatedSessionReference.id,
              delegatedBoundaryReconciliationStatus:
                resolved.relatedSessionReference.delegatedBoundaryReconciliationStatus,
              delegatedBoundaryDivergenceReasons:
                resolved.relatedSessionReference.delegatedBoundaryDivergenceReasons,
            }
          : null,
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          lineageNodeCount: digest.lineageNodeCount,
          divergedHopCount: digest.divergedHopCount,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
          status: digest.status,
          reasons: digest.reasons,
        },
        arbitrationQueue: {
          id: monitoring.arbitrationQueue.id,
          status: monitoring.arbitrationQueue.status,
          assignedPartnerId: monitoring.arbitrationQueue.assignedPartnerId,
          disposition: monitoring.arbitrationQueue.disposition,
        },
        closureCheckpoint: {
          id: monitoring.closureCheckpoint.id,
          status: monitoring.closureCheckpoint.status,
          attestedBy: monitoring.closureCheckpoint.attestedBy,
          reopenTrigger: monitoring.closureCheckpoint.reopenTrigger,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_lineage_reconciliation_queue") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const lineageRootSessionReferenceId = parsed.lineageRootSessionReferenceId
      const assignedPartnerId = parsed.assignedPartnerId
      if (!actorId || !firmId || !lineageRootSessionReferenceId || !assignedPartnerId) {
        throw new Error(
          "actorId, firmId, lineageRootSessionReferenceId, and assignedPartnerId are required"
        )
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId,
      })
      const assigned = assignLineageReconciliationArbitration(store, {
        actorId,
        firmId,
        lineageRootSessionReferenceId,
        assignedPartnerId,
        slaWindowMinutes: parsed.slaWindowMinutes,
        note: normalizeOptionalString(parsed.note),
      })
      await repos.tenancyLineageReconciliationQueueArbitrations.upsert(assigned.queue)
      await repos.tenancyLineageDigestClosureCheckpoints.upsert(monitoring.closureCheckpoint)
      await repos.audit.append(assigned.auditEntry)
      const payload = {
        action: "assign_lineage_reconciliation_queue",
        queue: assigned.queue,
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          status: digest.status,
          reasons: digest.reasons,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "arbitrate_lineage_reconciliation_queue") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const lineageRootSessionReferenceId = parsed.lineageRootSessionReferenceId
      const disposition = parseLineageArbitrationDisposition(parsed.disposition)
      if (!actorId || !firmId || !lineageRootSessionReferenceId || !disposition) {
        throw new Error(
          "actorId, firmId, lineageRootSessionReferenceId, and disposition are required"
        )
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId,
      })
      const arbitrated = arbitrateLineageReconciliationQueue(store, {
        actorId,
        firmId,
        lineageRootSessionReferenceId,
        disposition,
        note: normalizeOptionalString(parsed.note),
      })
      await repos.tenancyLineageReconciliationQueueArbitrations.upsert(arbitrated.queue)
      await repos.tenancyLineageDigestClosureCheckpoints.upsert(monitoring.closureCheckpoint)
      await repos.audit.append(arbitrated.auditEntry)
      const payload = {
        action: "arbitrate_lineage_reconciliation_queue",
        queue: arbitrated.queue,
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          status: digest.status,
          reasons: digest.reasons,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_lineage_digest_closure") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const lineageRootSessionReferenceId = parsed.lineageRootSessionReferenceId
      const closureReason = normalizeOptionalString(parsed.closureReason)
      if (!actorId || !firmId || !lineageRootSessionReferenceId || !closureReason) {
        throw new Error(
          "actorId, firmId, lineageRootSessionReferenceId, and closureReason are required"
        )
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId,
      })
      const attested = attestLineageDigestClosureCheckpoint(store, {
        actorId,
        firmId,
        lineageRootSessionReferenceId,
        closureReason,
        note: normalizeOptionalString(parsed.note),
      })
      await repos.tenancyLineageDigestClosureCheckpoints.upsert(attested.checkpoint)
      await repos.tenancyLineageReconciliationQueueArbitrations.upsert(monitoring.arbitrationQueue)
      await repos.audit.append(attested.auditEntry)
      const payload = {
        action: "attest_lineage_digest_closure",
        checkpoint: attested.checkpoint,
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          status: digest.status,
          reasons: digest.reasons,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reopen_lineage_digest_closure") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const lineageRootSessionReferenceId = parsed.lineageRootSessionReferenceId
      const reopenTrigger = normalizeOptionalString(parsed.reopenTrigger)
      if (!actorId || !firmId || !lineageRootSessionReferenceId || !reopenTrigger) {
        throw new Error(
          "actorId, firmId, lineageRootSessionReferenceId, and reopenTrigger are required"
        )
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId,
      })
      const reopened = reopenLineageDigestClosureCheckpoint(store, {
        actorId,
        firmId,
        lineageRootSessionReferenceId,
        reopenTrigger,
        note: normalizeOptionalString(parsed.note),
      })
      await repos.tenancyLineageDigestClosureCheckpoints.upsert(reopened.checkpoint)
      await repos.tenancyLineageReconciliationQueueArbitrations.upsert(monitoring.arbitrationQueue)
      await repos.audit.append(reopened.auditEntry)
      const payload = {
        action: "reopen_lineage_digest_closure",
        checkpoint: reopened.checkpoint,
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          status: digest.status,
          reasons: digest.reasons,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "govern_lineage_closure_adjudication") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const lineageRootSessionReferenceId = parsed.lineageRootSessionReferenceId
      const panelPartnerIds = parsed.panelPartnerIds
      if (!actorId || !firmId || !lineageRootSessionReferenceId || !Array.isArray(panelPartnerIds)) {
        throw new Error(
          "actorId, firmId, lineageRootSessionReferenceId, and panelPartnerIds are required"
        )
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId,
      })
      const governed = governLineageClosureAdjudication(store, {
        actorId,
        firmId,
        lineageRootSessionReferenceId,
        panelPartnerIds,
        requiredPanelQuorum: parsed.requiredPanelQuorum,
        verdictWindowMinutes: parsed.verdictWindowMinutes,
        note: normalizeOptionalString(parsed.note),
      })
      await repos.tenancyLineageClosureAdjudications.upsert(governed.adjudication)
      await repos.tenancyLineageArbitrationDebtRetirementLedgers.upsert(
        monitoring.arbitrationDebtRetirementLedger
      )
      await repos.audit.append(governed.auditEntry)
      const payload = {
        action: "govern_lineage_closure_adjudication",
        adjudication: governed.adjudication,
        debtLedger: monitoring.arbitrationDebtRetirementLedger,
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          status: digest.status,
          reasons: digest.reasons,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "record_lineage_closure_adjudication_verdict") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const lineageRootSessionReferenceId = parsed.lineageRootSessionReferenceId
      const disposition = parseLineageArbitrationDisposition(parsed.disposition)
      if (!actorId || !firmId || !lineageRootSessionReferenceId || !disposition) {
        throw new Error(
          "actorId, firmId, lineageRootSessionReferenceId, and disposition are required"
        )
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId,
      })
      const verdict = recordLineageClosureAdjudicationVerdict(store, {
        actorId,
        firmId,
        lineageRootSessionReferenceId,
        disposition,
        dispositionDriftReasons: parsed.dispositionDriftReasons,
        note: normalizeOptionalString(parsed.note),
      })
      await repos.tenancyLineageClosureAdjudications.upsert(verdict.adjudication)
      await repos.tenancyLineageArbitrationDebtRetirementLedgers.upsert(
        monitoring.arbitrationDebtRetirementLedger
      )
      await repos.audit.append(verdict.auditEntry)
      const payload = {
        action: "record_lineage_closure_adjudication_verdict",
        adjudication: verdict.adjudication,
        debtLedger: monitoring.arbitrationDebtRetirementLedger,
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          status: digest.status,
          reasons: digest.reasons,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_lineage_arbitration_debt_retirement") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const lineageRootSessionReferenceId = parsed.lineageRootSessionReferenceId
      const retirementNote = normalizeOptionalString(parsed.retirementNote)
      if (!actorId || !firmId || !lineageRootSessionReferenceId || !retirementNote) {
        throw new Error(
          "actorId, firmId, lineageRootSessionReferenceId, and retirementNote are required"
        )
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId,
      })
      const attested = attestLineageArbitrationDebtRetirement(store, {
        actorId,
        firmId,
        lineageRootSessionReferenceId,
        retirementNote,
        note: normalizeOptionalString(parsed.note),
      })
      await repos.tenancyLineageArbitrationDebtRetirementLedgers.upsert(attested.ledger)
      await repos.tenancyLineageClosureAdjudications.upsert(monitoring.closureAdjudication)
      await repos.audit.append(attested.auditEntry)
      const payload = {
        action: "attest_lineage_arbitration_debt_retirement",
        debtLedger: attested.ledger,
        adjudication: monitoring.closureAdjudication,
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          status: digest.status,
          reasons: digest.reasons,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reopen_lineage_arbitration_debt_retirement") {
      const actorId = parsed.actorId
      const firmId = parsed.firmId
      const lineageRootSessionReferenceId = parsed.lineageRootSessionReferenceId
      const carryoverSignal = normalizeOptionalString(parsed.carryoverSignal)
      if (!actorId || !firmId || !lineageRootSessionReferenceId || !carryoverSignal) {
        throw new Error(
          "actorId, firmId, lineageRootSessionReferenceId, and carryoverSignal are required"
        )
      }
      await syncFirmUsers(store, repos, firmId)
      await syncFirmTenancySessionReferences(store, repos, firmId)
      await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
      await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
      await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
      await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
      await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
      const { digest, monitoring } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId,
      })
      const reopened = reopenLineageArbitrationDebtRetirement(store, {
        actorId,
        firmId,
        lineageRootSessionReferenceId,
        carryoverSignal,
        note: normalizeOptionalString(parsed.note),
      })
      await repos.tenancyLineageArbitrationDebtRetirementLedgers.upsert(reopened.ledger)
      await repos.tenancyLineageClosureAdjudications.upsert(monitoring.closureAdjudication)
      await repos.audit.append(reopened.auditEntry)
      const payload = {
        action: "reopen_lineage_arbitration_debt_retirement",
        debtLedger: reopened.ledger,
        adjudication: monitoring.closureAdjudication,
        digest: {
          id: digest.id,
          lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
          status: digest.status,
          reasons: digest.reasons,
          openDisputeCount: digest.openDisputeCount,
          unresolvedRevocationCount: digest.unresolvedRevocationCount,
        },
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    const actorId = parsed.actorId
    const firmId = parsed.firmId
    const targetUserId = parsed.targetUserId
    const nextRole = parsed.nextRole
    const nextClearance = parsed.nextClearance
    if (
      !actorId ||
      !firmId ||
      !targetUserId ||
      !nextRole ||
      !isRole(nextRole) ||
      !nextClearance ||
      !isClassification(nextClearance)
    ) {
      throw new Error("actorId, firmId, targetUserId, nextRole, and nextClearance are required")
    }

    const sessionReferenceId = normalizeOptionalString(parsed.sessionReferenceId)
    const authBoundary = parseAuthBoundary(parsed.authBoundary)
    const externalSessionId = normalizeOptionalString(parsed.externalSessionId)
    await syncFirmUsers(store, repos, firmId)
    await syncFirmMembers(store, repos, firmId)
    await syncFirmTenancySessionReferences(store, repos, firmId)
    await syncFirmTenancyLineageDisputeAttestations(store, repos, firmId)
    await syncFirmTenancyLineageReconciliationDigests(store, repos, firmId)
    await syncFirmTenancyLineageReconciliationQueueArbitrations(store, repos, firmId)
    await syncFirmTenancyLineageDigestClosureCheckpoints(store, repos, firmId)
    await syncFirmTenancyLineageClosureAdjudications(store, repos, firmId)
    await syncFirmTenancyLineageArbitrationDebtRetirementLedgers(store, repos, firmId)
    let existingReference = null
    if (sessionReferenceId) {
      existingReference = await repos.tenancySessionReferences.get(sessionReferenceId)
      if (!existingReference) throw new Error("unknown session reference")
      store.tenancySessionReferences.set(existingReference.id, existingReference)
      if (existingReference.firmId !== firmId) {
        throw new Error("cross-firm session reference denied")
      }
      if (existingReference.userId !== actorId) {
        throw new Error("session reference actor mismatch")
      }
      const state = getTenancySessionReferenceState(existingReference)
      if (state === "revoked") throw new Error("session reference revoked")
      if (state === "expired") throw new Error("session reference expired")
    }
    const actor = await loadUser(store, repos, actorId)
    if (!actor) throw new Error("unknown actor")
    const sessionReference = upsertTenancySessionReference(store, {
      user: actor,
      existing: existingReference,
      sessionReferenceId,
      authBoundary,
      externalSessionId,
    })
    await repos.tenancySessionReferences.upsert(sessionReference)
    const updated = updateUserRole(store, {
      actorId,
      firmId,
      targetUserId,
      nextRole,
      nextClearance,
      reason: parsed.reason,
      authBoundary: sessionReference.authBoundary,
      sessionReferenceId: sessionReference.id,
      externalSessionId: sessionReference.externalSessionId,
    })
    const driftedReferences = invalidateSessionReferencesForPrivilegeDrift(store, {
      actorId,
      firmId,
      targetUserId,
      targetRole: nextRole,
      targetClearance: nextClearance,
    })
    for (const drifted of driftedReferences) {
      await repos.tenancySessionReferences.upsert(drifted)
    }
    const digestRootIds = new Set<string>([
      sessionReference.lineageRootSessionReferenceId,
      ...driftedReferences.map((row) => row.lineageRootSessionReferenceId),
    ])
    const enrichedAuditEntry = {
      ...updated.auditEntry,
      privilegedBoundaryDriftCount: driftedReferences.length,
      privilegedBoundaryDriftSessionReferenceIds: driftedReferences.map((row) => row.id),
      delegatedBoundaryLineageRootSessionReferenceId:
        sessionReference.lineageRootSessionReferenceId,
      delegatedBoundaryComparedSessionReferenceId:
        sessionReference.delegatedBoundaryComparedSessionReferenceId,
      delegatedBoundaryReconciliationStatus:
        sessionReference.delegatedBoundaryReconciliationStatus,
      delegatedBoundaryDivergenceReasons: sessionReference.delegatedBoundaryDivergenceReasons,
    }
    const auditIdx = store.audit.findIndex((row) => row.id === updated.auditEntry.id)
    if (auditIdx >= 0) {
      store.audit[auditIdx] = enrichedAuditEntry
    }
    const refreshedActor = await loadUser(store, repos, actorId)
    if (refreshedActor) {
      const refreshedReference = upsertTenancySessionReference(store, {
        user: refreshedActor,
        existing: sessionReference,
        sessionReferenceId: sessionReference.id,
        authBoundary: sessionReference.authBoundary,
        externalSessionId: sessionReference.externalSessionId ?? undefined,
      })
      await repos.tenancySessionReferences.upsert(refreshedReference)
    }
    await repos.users.upsert(updated.user)
    await repos.audit.append(enrichedAuditEntry)
    const digestSummaries: Array<{
      id: string
      lineageRootSessionReferenceId: string
      lineageNodeCount: number
      divergedHopCount: number
      openDisputeCount: number
      unresolvedRevocationCount: number
      status: "aligned" | "needs_review"
      reasons: string[]
    }> = []
    for (const rootId of digestRootIds) {
      const { digest } = await recomputeAndPersistLineageDigestState(store, repos, {
        firmId,
        lineageRootSessionReferenceId: rootId,
      })
      digestSummaries.push({
        id: digest.id,
        lineageRootSessionReferenceId: digest.lineageRootSessionReferenceId,
        lineageNodeCount: digest.lineageNodeCount,
        divergedHopCount: digest.divergedHopCount,
        openDisputeCount: digest.openDisputeCount,
        unresolvedRevocationCount: digest.unresolvedRevocationCount,
        status: digest.status,
        reasons: digest.reasons,
      })
    }
    const payload = {
      action: "update_role",
      user: {
        id: updated.user.id,
        firmId: updated.user.firmId,
        role: updated.user.role,
        clearanceLevel: updated.user.clearanceLevel,
      },
      authBoundary: enrichedAuditEntry.authBoundary ?? "runtime_local",
      sessionReferenceId: enrichedAuditEntry.sessionReferenceId ?? null,
      externalSessionId: enrichedAuditEntry.externalSessionId ?? null,
      privilegedBoundaryDriftCount: enrichedAuditEntry.privilegedBoundaryDriftCount ?? 0,
      privilegedBoundaryDriftSessionReferenceIds:
        enrichedAuditEntry.privilegedBoundaryDriftSessionReferenceIds ?? [],
      delegatedBoundaryLineageRootSessionReferenceId:
        enrichedAuditEntry.delegatedBoundaryLineageRootSessionReferenceId ?? null,
      delegatedBoundaryComparedSessionReferenceId:
        enrichedAuditEntry.delegatedBoundaryComparedSessionReferenceId ?? null,
      delegatedBoundaryReconciliationStatus:
        enrichedAuditEntry.delegatedBoundaryReconciliationStatus ?? "aligned",
      delegatedBoundaryDivergenceReasons:
        enrichedAuditEntry.delegatedBoundaryDivergenceReasons ?? [],
      digests: digestSummaries,
    }
    idempotency.set(key, payload, fingerprint)
    return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : "tenancy write failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
