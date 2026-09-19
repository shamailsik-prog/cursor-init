import { NextResponse } from "next/server"
import { rankOf } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { syncFirmUsers } from "@/platform/persistence/userSync"
import { checkPermission } from "@/platform/p5/checkPermission"

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

function normalizeTerms(value: string | null): string[] {
  if (!value) return []
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

function parseSource(value: string | null): "workflow_event" | "court_ops" | undefined {
  if (value === "workflow_event" || value === "court_ops") return value
  return undefined
}

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const actorId = url.searchParams.get("actorId")
  const matterId = url.searchParams.get("matterId")
  const source = parseSource(url.searchParams.get("source"))
  const action = url.searchParams.get("action")
  const status = url.searchParams.get("status")
  const terms = normalizeTerms(url.searchParams.get("q"))
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))

  if (!actorId) {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }

  let actor = store.users.get(actorId)
  if (!actor) {
    const persistedActor = await repos.users.get(actorId)
    if (!persistedActor) {
      return NextResponse.json({ error: "unknown actor" }, { status: 404 })
    }
    store.users.set(persistedActor.id, persistedActor)
    actor = persistedActor
  }
  if (actor.role === "client" || actor.role === "intern") {
    return NextResponse.json({ error: "actor role not allowed for ops reporting" }, { status: 403 })
  }

  await syncFirmUsers(store, repos, actor.firmId)
  await syncFirmMembers(store, repos, actor.firmId)
  const firmMatters = await repos.matters.listByFirm(actor.firmId)
  for (const matter of firmMatters) {
    store.matters.set(matter.id, matter)
  }

  const refreshedActor = store.users.get(actorId)
  if (!refreshedActor) {
    return NextResponse.json({ error: "unknown actor" }, { status: 404 })
  }

  const all = (await repos.workflowOpsActivity.listByFirm(refreshedActor.firmId))
    .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
    .filter((row) => (matterId ? row.matterId === matterId : true))
    .filter((row) => (source ? row.source === source : true))
    .filter((row) => (action ? row.action === action : true))
    .filter((row) => (status ? row.status === status : true))
    .filter((row) => terms.every((term) => row.tags.includes(term)))
    .filter((row) => {
      if (!row.matterId) return true
      return checkPermission(store, refreshedActor.id, "research", row.matterId).allow
    })
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))

  const items = all.slice(cursor, cursor + limit)
  const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null

  return NextResponse.json({
    items,
    total: all.length,
    limit,
    cursor,
    nextCursor,
  })
}
