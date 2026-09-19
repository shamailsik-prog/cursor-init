import { NextResponse } from "next/server"
import { isClassification, type Classification } from "@/platform/p1/types"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { checkPermission } from "@/platform/p5/checkPermission"
import { rankOf } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import {
  addMember,
  confirmEngagement,
} from "@/services/d1-2/matters"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

type CreateBody = {
  action: "create"
  actorId?: string
  firmId?: string
  clientId?: string
  title?: string
  courtId?: string
  classification?: string
  memberUserIds?: string[]
}

type ConfirmBody = {
  action: "confirm_engagement"
  actorId?: string
  matterId?: string
  atMs?: number
}

type CaseBody = {
  action: "record_case_number"
  actorId?: string
  matterId?: string
  raw?: string
  courtId?: string
}

type Body = CreateBody | ConfirmBody | CaseBody

function deny(message: string, status = 403) {
  return NextResponse.json({ error: message }, { status })
}

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

function ensureActor(actorId: string, firmId?: string) {
  const store = getRuntimeStore()
  const actor = store.users.get(actorId)
  if (!actor) throw new Error("unknown actor")
  if (firmId && actor.firmId !== firmId) throw new Error("cross-firm actor denied")
  if (actor.role === "client" || actor.role === "intern") {
    throw new Error("actor role not allowed for matter operations")
  }
  return actor
}

function ensureMatterAccess(actorId: string, matterId: string) {
  const store = getRuntimeStore()
  const actor = ensureActor(actorId)
  const matter = store.matters.get(matterId)
  if (!matter) throw new Error("unknown matter")
  if (matter.firmId !== actor.firmId) throw new Error("cross-firm access denied")
  if (!store.members.has(store.memberKey(matterId, actorId))) {
    throw new Error("actor is not a member of this matter")
  }
  if (rankOf(actor.clearanceLevel) < rankOf(matter.classification)) {
    throw new Error("actor clearance is below matter classification")
  }
  return { actor, matter }
}

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repo = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const userId = url.searchParams.get("userId")
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  const user = store.users.get(userId)
  if (!user) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 })
  }
  const perm = checkPermission(store, userId, "list_matters")
  if (!perm.allow) {
    return deny(`permission denied: ${perm.reason}`)
  }
  const firmMatters = await repo.matters.listByFirm(user.firmId)
  const all = firmMatters
    .filter((matter) => {
      if (user.role === "client") return matter.clientId === user.id
      return store.members.has(store.memberKey(matter.id, user.id))
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  const items = all.slice(cursor, cursor + limit)
  const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
  return NextResponse.json({
    items,
    total: all.length,
    cursor,
    limit,
    nextCursor,
  })
}

export async function POST(request: Request) {
  const store = getRuntimeStore()
  const repo = await getRuntimeRepositories(store)
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

  if (!parsed.action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 })
  }

  const fingerprint = JSON.stringify({
    route: "/api/d1/matters",
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
    if (parsed.action === "create") {
      if (!parsed.actorId || !parsed.firmId || !parsed.clientId || !parsed.title || !parsed.courtId) {
        return NextResponse.json(
          { error: "actorId, firmId, clientId, title, and courtId are required" },
          { status: 400 }
        )
      }
      if (!isClassification(parsed.classification)) {
        return NextResponse.json(
          { error: "classification must be a rank-0–4 label" },
          { status: 400 }
        )
      }
      const actor = ensureActor(parsed.actorId, parsed.firmId)
      if (rankOf(actor.clearanceLevel) < rankOf(parsed.classification as Classification)) {
        return deny("actor clearance is below requested matter classification")
      }
      const matter = {
        id: store.id("mat"),
        firmId: parsed.firmId,
        clientId: parsed.clientId,
        title: parsed.title,
        courtId: parsed.courtId,
        caseNumber: null,
        caseNumberStatus: "pending" as const,
        status: "engagement_unconfirmed" as const,
        classification: parsed.classification,
      }
      await repo.matters.create(matter)
      // Keep in-memory mirror in sync for flows that still read the spine directly.
      store.matters.set(matter.id, matter)
      addMember(store, matter.id, parsed.actorId, parsed.firmId)
      for (const userId of new Set(parsed.memberUserIds ?? [])) {
        addMember(store, matter.id, userId, parsed.firmId)
      }
      store.audit.push({
        action: "matter_create",
        actorId: parsed.actorId,
        target: matter.id,
        classification: matter.classification,
      })
      const payload = {
        action: "create",
        matter,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "confirm_engagement") {
      if (!parsed.actorId || !parsed.matterId) {
        return NextResponse.json({ error: "actorId and matterId are required" }, { status: 400 })
      }
      const { matter } = ensureMatterAccess(parsed.actorId, parsed.matterId)
      confirmEngagement(store, parsed.matterId, parsed.atMs)
      store.audit.push({
        action: "matter_confirm_engagement",
        actorId: parsed.actorId,
        target: parsed.matterId,
        classification: matter.classification,
      })
      const payload = {
        action: "confirm_engagement",
        matter: store.matters.get(parsed.matterId),
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "record_case_number") {
      if (!parsed.actorId || !parsed.matterId || !parsed.raw || !parsed.courtId) {
        return NextResponse.json(
          { error: "actorId, matterId, raw, and courtId are required" },
          { status: 400 }
        )
      }
      const { matter } = ensureMatterAccess(parsed.actorId, parsed.matterId)
      const result = recordCaseNumber(store, parsed.matterId, parsed.raw, parsed.courtId)
      store.audit.push({
        action: "matter_record_case_number",
        actorId: parsed.actorId,
        target: parsed.matterId,
        classification: matter.classification,
        reason: result.status,
      })
      const payload = {
        action: "record_case_number",
        result,
        matter: store.matters.get(parsed.matterId),
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "matter operation failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
