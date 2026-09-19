import { NextResponse } from "next/server"
import { rankOf } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import {
  buildClientSearchIndexRow,
  buildMatterSearchIndexRow,
} from "@/platform/persistence/matterClientSearchIndex"
import { syncFirmUsers } from "@/platform/persistence/userSync"

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

type RowType = "matter" | "client"

function parseRowType(value: string | null): RowType | undefined {
  if (value === "matter" || value === "client") return value
  return undefined
}

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const actorId = url.searchParams.get("actorId")
  const rowType = parseRowType(url.searchParams.get("rowType"))
  const terms = normalizeTerms(url.searchParams.get("q"))
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))

  if (!actorId) {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }
  const actor = store.users.get(actorId)
  if (!actor) {
    return NextResponse.json({ error: "unknown actor" }, { status: 404 })
  }
  if (actor.role === "client" || actor.role === "intern") {
    return NextResponse.json({ error: "actor role not allowed for reporting search" }, { status: 403 })
  }

  await syncFirmUsers(store, repos, actor.firmId)
  const refreshedActor = store.users.get(actorId)
  if (!refreshedActor) {
    return NextResponse.json({ error: "unknown actor" }, { status: 404 })
  }
  const matters = await repos.matters.listByFirm(refreshedActor.firmId)
  for (const matter of matters) {
    await repos.reportingIndex.upsert(buildMatterSearchIndexRow(matter))
  }
  const clients = await repos.entities.listByFirm(refreshedActor.firmId)
  for (const entity of clients) {
    await repos.reportingIndex.upsert(buildClientSearchIndexRow(entity))
  }

  const all = (await repos.reportingIndex.listByFirm(refreshedActor.firmId))
    .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
    .filter((row) => (rowType ? row.rowType === rowType : true))
    .filter((row) => terms.every((term) => row.tags.includes(term)))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

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
