import { NextResponse } from "next/server"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { isClassification } from "@/platform/p1/types"
import type { Role, TenancyAuthBoundary, User } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { syncFirmUsers } from "@/platform/persistence/userSync"
import { syncFirmAudit } from "@/platform/persistence/auditSync"
import { syncFirmTenancySessionReferences } from "@/platform/persistence/tenancySessionReferenceSync"
import {
  buildSessionContext,
  getTenancySessionReferenceState,
  invalidateSessionReferencesForPrivilegeDrift,
  listFirmAudit,
  listFirmMemberships,
  listFirmSessionReferences,
  listFirmUsers,
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

type Body = UpdateRoleBody | RevokeSessionReferenceBody

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
          authBoundary: sessionReference.authBoundary,
          externalSessionId: sessionReference.externalSessionId,
          issuedAt: sessionReference.issuedAt,
          lastSeenAt: sessionReference.lastSeenAt,
          expiresAt: sessionReference.expiresAt,
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

  if (parsed.action !== "update_role" && parsed.action !== "revoke_session_reference") {
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
      const revoked = revokeTenancySessionReference(store, {
        actorId,
        firmId,
        sessionReferenceId,
        reason: normalizeOptionalString(parsed.reason),
      })
      await repos.tenancySessionReferences.upsert(revoked.reference)
      await repos.audit.append(revoked.auditEntry)
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
    const enrichedAuditEntry = {
      ...updated.auditEntry,
      privilegedBoundaryDriftCount: driftedReferences.length,
      privilegedBoundaryDriftSessionReferenceIds: driftedReferences.map((row) => row.id),
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
    }
    idempotency.set(key, payload, fingerprint)
    return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : "tenancy write failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
