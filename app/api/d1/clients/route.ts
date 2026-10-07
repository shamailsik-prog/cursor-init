import { NextResponse } from "next/server"
import { BodySchema, CLIENTS_SURFACE } from "./surface"
import { z } from "zod"
import { DEFAULT_JSON_BODY_BYTES, parseBody, readJsonLimited } from "@/platform/http/validation"
import { PublicError } from "@/platform/http/publicError"
import { actionOf, getQuery, isAction, refuseUndeclaredBody } from "@/platform/http/surface"
import { withSession } from "@/platform/http/withSession"
import { REQUEST_FAILED_CODE, publicErrorMessage } from "@/platform/http/errors"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { isClassification, type Classification } from "@/platform/p1/types"
import { rankOf, rankOfStoredOrMax } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmEntities } from "@/platform/persistence/entitySync"
import { persistAuditEntriesSince } from "@/platform/persistence/auditWriteThrough"
import { buildClientSearchIndexRow } from "@/platform/persistence/matterClientSearchIndex"
import { conflictCheck, createClient } from "@/services/d1-1/clients"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)


type Body = z.infer<typeof BodySchema>

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

function requireActor(actorId: string, firmId?: string) {
  const store = getRuntimeStore()
  const actor = store.users.get(actorId)
  if (!actor) throw new PublicError("unknown actor")
  if (firmId && actor.firmId !== firmId) throw new PublicError("cross-firm actor denied")
  if (actor.role === "client" || actor.role === "intern" || actor.role === "accounts") {
    throw new PublicError("actor role not allowed for client registry operations")
  }
  return actor
}

export async function GET(request: Request) {
  return withSession(request, handleGet, { surface: CLIENTS_SURFACE })
}

async function handleGet(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const userId = getQuery(CLIENTS_SURFACE, url, "userId")
  const limit = parseLimit(getQuery(CLIENTS_SURFACE, url, "limit"))
  const cursor = parseCursor(getQuery(CLIENTS_SURFACE, url, "cursor"))

  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  const user = store.users.get(userId)
  if (!user) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 })
  }
  if (user.role === "client" || user.role === "intern" || user.role === "accounts") {
    return NextResponse.json({ error: "user role not allowed for client registry reads" }, { status: 403 })
  }

  await syncFirmEntities(store, repos, user.firmId)
  const all = [...store.entities.values()]
    .filter((row) => row.firmId === user.firmId)
    .filter((row) => rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification))
    .sort((a, b) => a.id.localeCompare(b.id))
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

export async function POST(request: Request) {
  return withSession(request, handlePost, { maxBodyBytes: DEFAULT_JSON_BODY_BYTES, surface: CLIENTS_SURFACE })
}

async function handlePost(request: Request) {
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

  const raw = await readJsonLimited(request)
  if (!raw.ok) return raw.response
  const undeclared = refuseUndeclaredBody(CLIENTS_SURFACE, raw.data)
  if (undeclared) return undeclared
  const body = parseBody(BodySchema, raw.data)
  if (!body.ok) return body.response
  const parsed: Body = body.data

  const fingerprint = JSON.stringify({
    route: "/api/d1/clients",
    action: actionOf(CLIENTS_SURFACE, parsed),
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
    if (isAction(CLIENTS_SURFACE, parsed, "create")) {
      if (!parsed.actorId || !parsed.firmId || !parsed.canonicalName || !parsed.cnic || !parsed.phone) {
        return NextResponse.json(
          { error: "actorId, firmId, canonicalName, cnic, and phone are required" },
          { status: 400 }
        )
      }
      if (!isClassification(parsed.classification)) {
        return NextResponse.json(
          { error: "classification must be a rank-0–4 label" },
          { status: 400 }
        )
      }
      const actor = requireActor(parsed.actorId, parsed.firmId)
      if (rankOf(actor.clearanceLevel) < rankOf(parsed.classification as Classification)) {
        return NextResponse.json(
          { error: "actor clearance is below requested client classification" },
          { status: 403 }
        )
      }

      await syncFirmEntities(store, repos, parsed.firmId)
      const priorAuditCount = store.audit.length
      const existingLinkKeys = new Set(
        store.links
          .filter((row) => row.firmId === parsed.firmId)
          .map((row) => `${row.leftId}:${row.rightId}:${row.identityBasis}`)
      )
      const entity = createClient(store, {
        firmId: parsed.firmId,
        canonicalName: parsed.canonicalName,
        cnic: parsed.cnic,
        phone: parsed.phone,
        classification: parsed.classification,
      })
      await repos.entities.create(entity)
      await repos.reportingIndex.upsert(buildClientSearchIndexRow(entity))
      for (const row of store.links) {
        if (row.firmId !== parsed.firmId) continue
        const linkKey = `${row.leftId}:${row.rightId}:${row.identityBasis}`
        if (existingLinkKeys.has(linkKey)) continue
        await repos.entityLinks.upsert(row)
      }
      store.audit.push({
        action: "client_create",
        actorId: actor.id,
        target: entity.id,
        classification: entity.classification,
        firmId: entity.firmId,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "create",
        entity,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (isAction(CLIENTS_SURFACE, parsed, "conflict_check")) {
      if (!parsed.actorId || !parsed.firmId || !parsed.entityId) {
        return NextResponse.json({ error: "actorId, firmId, and entityId are required" }, { status: 400 })
      }
      requireActor(parsed.actorId, parsed.firmId)
      await syncFirmEntities(store, repos, parsed.firmId)
      const result = conflictCheck(store, parsed.firmId, parsed.entityId)
      const payload = {
        action: "conflict_check",
        entityId: parsed.entityId,
        result,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    const message = publicErrorMessage(err, "client operation failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}
