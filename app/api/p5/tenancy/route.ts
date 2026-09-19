import { NextResponse } from "next/server"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { isClassification } from "@/platform/p1/types"
import type { Role } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { syncFirmUsers } from "@/platform/persistence/userSync"
import { syncFirmAudit } from "@/platform/persistence/auditSync"
import {
  buildSessionContext,
  listFirmAudit,
  listFirmMemberships,
  listFirmUsers,
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
}

type Body = UpdateRoleBody

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

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = url.searchParams.get("view") ?? "session"
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))

  try {
    if (view === "session") {
      const userId = url.searchParams.get("userId")
      const firmId = url.searchParams.get("firmId") ?? undefined
      if (!userId) {
        return NextResponse.json({ error: "userId is required" }, { status: 400 })
      }
      const user = store.users.get(userId)
      if (!user) {
        return NextResponse.json({ error: "unknown user" }, { status: 400 })
      }
      await syncFirmUsers(store, repos, user.firmId)
      await syncFirmMembers(store, repos, user.firmId)
      const session = buildSessionContext(store, userId, firmId)
      return NextResponse.json({
        view: "session",
        session,
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

  if (parsed.action !== "update_role") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  }
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
    await syncFirmUsers(store, repos, parsed.firmId)
    await syncFirmMembers(store, repos, parsed.firmId)
    const updated = updateUserRole(store, {
      actorId: parsed.actorId,
      firmId: parsed.firmId,
      targetUserId: parsed.targetUserId,
      nextRole: parsed.nextRole,
      nextClearance: parsed.nextClearance,
      reason: parsed.reason,
    })
    await repos.users.upsert(updated.user)
    await repos.audit.append(updated.auditEntry)
    const payload = {
      action: "update_role",
      user: {
        id: updated.user.id,
        firmId: updated.user.firmId,
        role: updated.user.role,
        clearanceLevel: updated.user.clearanceLevel,
      },
    }
    idempotency.set(key, payload, fingerprint)
    return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : "role update failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
