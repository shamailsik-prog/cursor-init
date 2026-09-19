import { NextResponse } from "next/server"
import { isClassification, type Classification } from "@/platform/p1/types"
import { callCommitteeBrain } from "@/platform/p1/internalAICaller"
import { rankOf } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import {
  IdempotencyError,
  IdempotencyCache,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

type Body = {
  actorId?: string
  body?: string
  classification?: string
  purpose?: string
  partyNames?: string[]
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

function requireActor(actorId: string) {
  const store = getRuntimeStore()
  const actor = store.users.get(actorId)
  if (!actor) throw new Error("unknown actor")
  if (actor.role === "client" || actor.role === "intern") {
    throw new Error("actor role not allowed for committee brain operations")
  }
  return actor
}

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const actorId = url.searchParams.get("actorId")
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))
  const blockedParam = url.searchParams.get("blocked")

  if (!actorId) {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }

  try {
    const actor = requireActor(actorId)
    const blockedFilter =
      blockedParam === "true" ? true : blockedParam === "false" ? false : undefined
    const all = (await repos.committeeOutputs.listByFirm(actor.firmId))
      .filter((row) => rankOf(actor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (blockedFilter === undefined ? true : row.blocked === blockedFilter))
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "committee brain read failed"
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
  if (!parsed.actorId || typeof parsed.actorId !== "string") {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }
  if (!parsed.body || typeof parsed.body !== "string") {
    return NextResponse.json({ error: "body is required" }, { status: 400 })
  }
  if (!isClassification(parsed.classification)) {
    return NextResponse.json(
      { error: "classification must be a rank-0–4 label" },
      { status: 400 }
    )
  }
  const classification: Classification = parsed.classification
  const partyNames = Array.isArray(parsed.partyNames)
    ? parsed.partyNames.filter((n) => typeof n === "string" && n.length > 0)
    : undefined
  const purpose =
    typeof parsed.purpose === "string" ? parsed.purpose : "committee-brain"
  const fingerprint = JSON.stringify({
    route: "/api/p1/committee-brain",
    actorId: parsed.actorId,
    body: parsed.body,
    classification,
    purpose,
    partyNames: partyNames ?? [],
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
    const actor = requireActor(parsed.actorId)
    if (rankOf(actor.clearanceLevel) < rankOf(classification)) {
      return NextResponse.json(
        { error: "actor clearance is below requested committee classification" },
        { status: 403 }
      )
    }

    const result = await callCommitteeBrain({
      body: parsed.body,
      classification,
      provider: "ai-gateway",
      purpose,
      partyNames,
    })
    const output = {
      id: store.id("cbo"),
      firmId: actor.firmId,
      actorId: actor.id,
      classification,
      purpose,
      blocked: result.blocked,
      reason: result.reason,
      text: result.text,
      outbound: result.outbound,
      createdAt: Date.now(),
    }
    await repos.committeeOutputs.create(output)
    store.committeeOutputs.set(output.id, output)

    const payload = {
      outputId: output.id,
      blocked: result.blocked,
      reason: result.reason,
      text: result.text,
      outbound: result.outbound,
      agent: "sikander-ai",
    }
    idempotency.set(key, payload, fingerprint)
    return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : "committee brain write failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
