import { NextResponse } from "next/server"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { isClassification, type Classification } from "@/platform/p1/types"
import { rankOf } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  composeDraft,
  listTemplates,
  runDraftPreflight,
  type DraftPreflightInput,
  type TemporalCitationInput,
} from "@/services/d4-1/drafts"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

type PreflightBody = {
  action: "preflight"
  actorId?: string
  matterId?: string
  classification?: string
  citedJudgmentIds?: string[]
  temporalCitations?: TemporalCitationInput[]
  partnerOverride?: { partnerId?: string; reason?: string }
}

type ComposeBody = {
  action: "compose"
  actorId?: string
  matterId?: string
  templateId?: string
  title?: string
  body?: string
  classification?: string
  citedJudgmentIds?: string[]
  temporalCitations?: TemporalCitationInput[]
  partnerOverride?: { partnerId?: string; reason?: string }
}

type Body = PreflightBody | ComposeBody

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

function buildPreflightInput(parsed: {
  actorId?: string
  matterId?: string
  classification?: string
  citedJudgmentIds?: string[]
  temporalCitations?: TemporalCitationInput[]
  partnerOverride?: { partnerId?: string; reason?: string }
}): DraftPreflightInput {
  if (!parsed.actorId || !parsed.matterId) {
    throw new Error("actorId and matterId are required")
  }
  if (!isClassification(parsed.classification)) {
    throw new Error("classification must be a rank-0–4 label")
  }
  const partnerOverride =
    parsed.partnerOverride?.partnerId || parsed.partnerOverride?.reason
      ? {
          partnerId: parsed.partnerOverride?.partnerId ?? "",
          reason: parsed.partnerOverride?.reason ?? "",
        }
      : undefined
  return {
    actorId: parsed.actorId,
    matterId: parsed.matterId,
    classification: parsed.classification,
    citedJudgmentIds: parsed.citedJudgmentIds ?? [],
    temporalCitations: parsed.temporalCitations ?? [],
    partnerOverride,
  }
}

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = url.searchParams.get("view") ?? "drafts"
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))

  if (view === "templates") {
    const query = (url.searchParams.get("q") ?? "").trim()
    const templates = listTemplates(query, limit, cursor)
    return NextResponse.json({
      view: "templates",
      items: templates.items,
      total: templates.total,
      limit,
      cursor,
      nextCursor: templates.nextCursor,
    })
  }

  const userId = url.searchParams.get("userId")
  const matterId = url.searchParams.get("matterId")
  if (!userId) {
    return NextResponse.json({ error: "userId is required for drafts view" }, { status: 400 })
  }
  if (!store.users.has(userId)) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 })
  }

  const user = store.users.get(userId)
  if (!user) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 })
  }
  const firmDrafts = await repos.drafts.listByFirm(user.firmId)
  const visible = firmDrafts
    .filter((draft) => (matterId ? draft.matterId === matterId : true))
    .filter((draft) => {
      const permission = checkPermission(store, userId, "draft", draft.matterId)
      if (!permission.allow) return false
      return rankOf(user.clearanceLevel) >= rankOf(draft.classification)
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  const items = visible.slice(cursor, cursor + limit)
  const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null

  return NextResponse.json({
    view: "drafts",
    items,
    total: visible.length,
    limit,
    cursor,
    nextCursor,
  })
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
  if (!parsed.action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 })
  }

  const fingerprint = JSON.stringify({
    route: "/api/d4/drafts",
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
    if (parsed.action === "preflight") {
      const input = buildPreflightInput(parsed)
      const result = runDraftPreflight(store, input)
      const payload = {
        action: "preflight",
        result,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "compose") {
      if (!parsed.templateId || !parsed.title || !parsed.body) {
        return NextResponse.json(
          { error: "templateId, title, and body are required" },
          { status: 400 }
        )
      }
      const preflightInput = buildPreflightInput(parsed)
      const gate = runDraftPreflight(store, preflightInput)
      if (!gate.ok) {
        return NextResponse.json(
          { error: "preflight blocked drafting", preflight: gate },
          { status: 422 }
        )
      }
      const draft = composeDraft(store, {
        actorId: preflightInput.actorId,
        matterId: preflightInput.matterId,
        templateId: parsed.templateId,
        title: parsed.title,
        body: parsed.body,
        classification: preflightInput.classification as Classification,
        preflight: preflightInput,
      })
      store.audit.push({
        action: "draft_compose",
        actorId: preflightInput.actorId,
        target: draft.id,
        classification: draft.classification,
      })
      await repos.drafts.create(draft)
      const payload = {
        action: "compose",
        preflight: gate,
        draft: (await repos.drafts.get(draft.id)) ?? draft,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "draft operation failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
