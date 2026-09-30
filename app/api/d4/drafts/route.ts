import { NextResponse } from "next/server"
import { PublicError } from "@/platform/http/publicError"
import { withSession, type HandlerSession } from "@/platform/http/withSession"
import { errorResponse } from "@/platform/http/errors"
import { resolvePartnerOverride } from "@/services/d4-2/partnerOverride"
import type { SpineStore } from "@/platform/spine/store"
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
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { syncFirmUsers } from "@/platform/persistence/userSync"
import { persistAuditEntriesSince } from "@/platform/persistence/auditWriteThrough"
import {
  buildDraftTemplateAnalyticsRow,
  draftTemplateAnalyticsId,
  withTemplateComposed,
  withTemplateSearchSeen,
} from "@/platform/persistence/draftTemplateAnalytics"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  composeDraft,
  listTemplateCatalog,
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
  /** Optional draft text to extract citations from. */
  body?: string
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

function normalizeTerms(value: string | null): string[] {
  if (!value) return []
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

function buildPreflightInput(
  store: SpineStore,
  session: HandlerSession | null,
  parsed: {
    actorId?: string
    matterId?: string
    classification?: string
    citedJudgmentIds?: string[]
    temporalCitations?: TemporalCitationInput[]
    partnerOverride?: { partnerId?: string; reason?: string }
    body?: string
  }
): DraftPreflightInput | Response {
  if (!parsed.actorId || !parsed.matterId) {
    throw new PublicError("actorId and matterId are required")
  }
  if (!isClassification(parsed.classification)) {
    throw new PublicError("classification must be a rank-0–4 label")
  }
  // The override partner is the authenticated caller (L17.1 human control), never a body field.
  const resolved = resolvePartnerOverride(
    store,
    parsed.partnerOverride,
    session?.userId ?? undefined
  )
  if (!resolved.ok) return errorResponse(resolved.status, resolved.code, resolved.error)
  const partnerOverride = resolved.override
  return {
    actorId: parsed.actorId,
    matterId: parsed.matterId,
    classification: parsed.classification,
    citedJudgmentIds: parsed.citedJudgmentIds ?? [],
    temporalCitations: parsed.temporalCitations ?? [],
    partnerOverride,
    ...(typeof parsed.body === "string" ? { draftBody: parsed.body } : {}),
  }
}

export async function GET(request: Request) {
  return withSession(request, handleGet)
}

async function handleGet(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = url.searchParams.get("view") ?? "drafts"
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))

  if (view === "templates") {
    const query = (url.searchParams.get("q") ?? "").trim()
    const actorId = (url.searchParams.get("actorId") ?? "").trim()
    if (!actorId) {
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
    const actor = store.users.get(actorId)
    if (!actor) {
      return NextResponse.json({ error: "unknown actor" }, { status: 404 })
    }
    if (actor.role === "client" || actor.role === "intern") {
      return NextResponse.json(
        { error: "actor role not allowed for template analytics search" },
        { status: 403 }
      )
    }
    await syncFirmUsers(store, repos, actor.firmId)
    const refreshedActor = store.users.get(actorId)
    if (!refreshedActor) {
      return NextResponse.json({ error: "unknown actor" }, { status: 404 })
    }

    const existing = await repos.draftTemplateAnalytics.listByFirm(refreshedActor.firmId)
    const analytics = new Map(existing.map((row) => [row.templateId, row]))
    const ranked = listTemplateCatalog(query)
      .map((template) => {
        const row =
          analytics.get(template.id) ??
          buildDraftTemplateAnalyticsRow(refreshedActor.firmId, template)
        return {
          template,
          row,
        }
      })
      .sort((a, b) => {
        const primary = b.row.composeCount - a.row.composeCount
        if (primary !== 0) return primary
        const secondary = b.row.templateSearchCount - a.row.templateSearchCount
        if (secondary !== 0) return secondary
        return a.template.id.localeCompare(b.template.id)
      })
    const sliced = ranked.slice(cursor, cursor + limit)
    const nextCursor =
      cursor + sliced.length < ranked.length ? String(cursor + sliced.length) : null
    if (query.length > 0) {
      const now = Date.now()
      for (const entry of sliced) {
        const next = withTemplateSearchSeen(entry.row, query, { now })
        await repos.draftTemplateAnalytics.upsert(next)
        analytics.set(next.templateId, next)
      }
    }
    return NextResponse.json({
      view: "templates",
      items: sliced.map(({ template, row }) => {
        const refreshed = analytics.get(template.id) ?? row
        return {
          ...template,
          analytics: {
            composeCount: refreshed.composeCount,
            templateSearchCount: refreshed.templateSearchCount,
            lastComposedAt: refreshed.lastComposedAt,
            lastTemplateSearchAt: refreshed.lastTemplateSearchAt,
          },
        }
      }),
      total: ranked.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  const userId = url.searchParams.get("userId")
  const matterId = url.searchParams.get("matterId")
  const terms = normalizeTerms(url.searchParams.get("q"))
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
  await syncFirmMembers(store, repos, user.firmId)
  const templateAnalytics = await repos.draftTemplateAnalytics.listByFirm(user.firmId)
  const templateUsage = new Map(
    templateAnalytics.map((row) => [row.templateId, row.composeCount])
  )
  const firmDrafts = await repos.drafts.listByFirm(user.firmId)
  const visible = firmDrafts
    .filter((draft) => (matterId ? draft.matterId === matterId : true))
    .filter((draft) => {
      if (terms.length === 0) return true
      const haystack = `${draft.templateId} ${draft.title} ${draft.body}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    .filter((draft) => {
      const permission = checkPermission(store, userId, "draft", draft.matterId)
      if (!permission.allow) return false
      return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(draft.classification)
    })
    .sort((a, b) => {
      const scoreA = templateUsage.get(a.templateId) ?? 0
      const scoreB = templateUsage.get(b.templateId) ?? 0
      if (scoreA !== scoreB) return scoreB - scoreA
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
      return a.id.localeCompare(b.id)
    })
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
  return withSession(request, handlePost)
}

async function handlePost(request: Request, session: HandlerSession | null) {
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
      const input = buildPreflightInput(store, session, parsed)
      if (input instanceof Response) return input
      const actor = store.users.get(input.actorId)
      if (!actor) throw new PublicError("unknown actor")
      await syncFirmMembers(store, repos, actor.firmId)
      const priorAuditCount = store.audit.length
      const result = runDraftPreflight(store, input)
      await persistAuditEntriesSince(store, repos, priorAuditCount)
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
      const preflightInput = buildPreflightInput(store, session, parsed)
      if (preflightInput instanceof Response) return preflightInput
      const actor = store.users.get(preflightInput.actorId)
      if (!actor) throw new PublicError("unknown actor")
      await syncFirmMembers(store, repos, actor.firmId)
      const priorAuditCount = store.audit.length
      // Pre-check only for the 422 body; composeDraft re-runs the gate and records any override.
      const gate = runDraftPreflight(store, preflightInput, { recordOverride: false })
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
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      await repos.drafts.create(draft)
      const template = listTemplateCatalog("").find((item) => item.id === draft.templateId)
      const analyticsId = draftTemplateAnalyticsId(draft.templateId)
      const existingAnalytics = await repos.draftTemplateAnalytics.get(analyticsId)
      const baseAnalytics =
        existingAnalytics ??
        buildDraftTemplateAnalyticsRow(actor.firmId, {
          id: draft.templateId,
          name: template?.name ?? draft.templateId,
          posture: template?.posture ?? "unknown",
          category: template?.category ?? "unknown",
        })
      const nextAnalytics = withTemplateComposed(baseAnalytics)
      await repos.draftTemplateAnalytics.upsert(nextAnalytics)
      store.draftTemplateAnalytics.set(nextAnalytics.id, nextAnalytics)
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
    const message = publicErrorMessage(err, "draft operation failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}
