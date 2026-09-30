import { NextResponse } from "next/server"
import { PublicError } from "@/platform/http/publicError"
import { withSession } from "@/platform/http/withSession"
import { REQUEST_FAILED_CODE, publicErrorMessage } from "@/platform/http/errors"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import {
  rankOf, rankOfStoredOrMax,
  type Matter,
  type MatterReportExportAnalyticsRow,
  type MatterReportRelevanceFreshnessStatus,
  type MatterReportRelevanceScoreBand,
  type MatterReportRelevanceSnapshotRow,
  type User,
} from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import {
  buildClientSearchIndexRow,
  buildMatterSearchIndexRow,
} from "@/platform/persistence/matterClientSearchIndex"
import { persistAuditEntriesSince } from "@/platform/persistence/auditWriteThrough"
import { syncFirmUsers } from "@/platform/persistence/userSync"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)
const RELEVANCE_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000

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

type ReportingView = "search" | "matter_report_export_analytics" | "matter_report_relevance_snapshots"

function parseView(value: string | null): ReportingView | undefined {
  if (!value) return "search"
  if (
    value === "search" ||
    value === "matter_report_export_analytics" ||
    value === "matter_report_relevance_snapshots"
  ) {
    return value
  }
  return undefined
}

function parseScoreBand(value: string | null): MatterReportRelevanceScoreBand | undefined {
  if (value === "high" || value === "medium" || value === "low") return value
  return undefined
}

function parseFreshness(value: string | null): MatterReportRelevanceFreshnessStatus | undefined {
  if (value === "fresh" || value === "stale") return value
  return undefined
}

function reportExportAnalyticsId(matterId: string): string {
  return `matter_report_export:${matterId}`
}

function reportRelevanceSnapshotId(matterId: string): string {
  return `matter_report_relevance:${matterId}`
}

function parseExportFormat(value: unknown): "csv" | "json" | "pdf" {
  if (value === "csv" || value === "json" || value === "pdf") return value
  throw new PublicError("exportFormat must be csv, json, or pdf")
}

function parseExportScope(value: unknown): "summary" | "detailed" | "relevance_review" {
  if (value === "summary" || value === "detailed" || value === "relevance_review") return value
  throw new PublicError("exportScope must be summary, detailed, or relevance_review")
}

function normalizeReason(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function normalizeOptionalTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, "_"))
    .filter((item) => item.length > 0)
}

function asFreshnessStatus(recomputedAt: number, now: number): MatterReportRelevanceFreshnessStatus {
  return now - recomputedAt <= RELEVANCE_FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asScoreBand(score: number): MatterReportRelevanceScoreBand {
  if (score >= 75) return "high"
  if (score >= 45) return "medium"
  return "low"
}

function computeRelevanceScore(matter: Matter, documentCount: number): number {
  let score = 20
  if (matter.status === "live") score += 30
  if (matter.caseNumberStatus === "recorded") score += 20
  score += Math.min(documentCount, 10) * 4
  return Math.max(0, Math.min(score, 100))
}

function buildRelevanceSnapshot(
  matter: Matter,
  documentCount: number,
  recomputedBy: string,
  recomputeReason: string,
  extraTags: string[],
  now: number
): MatterReportRelevanceSnapshotRow {
  const relevanceScore = computeRelevanceScore(matter, documentCount)
  const provenanceTags = [
    `matter_status:${matter.status}`,
    `case_number_status:${matter.caseNumberStatus}`,
    `document_count_bucket:${Math.min(documentCount, 10)}`,
    ...extraTags,
  ]
  return {
    id: reportRelevanceSnapshotId(matter.id),
    firmId: matter.firmId,
    matterId: matter.id,
    classification: matter.classification,
    relevanceScore,
    scoreBand: asScoreBand(relevanceScore),
    freshnessStatus: "fresh",
    provenanceTags: [...new Set(provenanceTags)],
    recomputedAt: now,
    recomputedBy,
    recomputeReason,
    updatedAt: now,
  }
}

async function resolveActor(actorId: string, store: ReturnType<typeof getRuntimeStore>, repos: Awaited<ReturnType<typeof getRuntimeRepositories>>): Promise<User | null> {
  const local = store.users.get(actorId)
  if (local) return local
  const persisted = await repos.users.get(actorId)
  if (!persisted) return null
  store.users.set(persisted.id, persisted)
  return persisted
}

async function resolveMatter(
  matterId: string,
  store: ReturnType<typeof getRuntimeStore>,
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
): Promise<Matter | null> {
  const local = store.matters.get(matterId)
  if (local) return local
  const persisted = await repos.matters.get(matterId)
  if (!persisted) return null
  store.matters.set(persisted.id, persisted)
  return persisted
}

async function countFirmDocumentsByMatter(
  firmId: string,
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  const docs = await repos.documents.listByFirm(firmId)
  for (const doc of docs) {
    if (!doc.matterId) continue
    map.set(doc.matterId, (map.get(doc.matterId) ?? 0) + 1)
  }
  return map
}

async function ensureMatterReportingRows(params: {
  matter: Matter
  actorId: string
  reason: string
  documentCountByMatter: Map<string, number>
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
  store: ReturnType<typeof getRuntimeStore>
}): Promise<{
  exportAnalytics: MatterReportExportAnalyticsRow
  relevanceSnapshot: MatterReportRelevanceSnapshotRow
}> {
  const { matter, actorId, reason, documentCountByMatter, repos, store } = params
  const now = Date.now()
  const exportId = reportExportAnalyticsId(matter.id)
  const relevanceId = reportRelevanceSnapshotId(matter.id)
  const existingExport = await repos.matterReportExportAnalytics.get(exportId)
  const existingRelevance = await repos.matterReportRelevanceSnapshots.get(relevanceId)
  const exportAnalytics =
    existingExport ??
    ({
      id: exportId,
      firmId: matter.firmId,
      matterId: matter.id,
      classification: matter.classification,
      exportCount: 0,
      lastExportedAt: null,
      lastExportedBy: null,
      lastExportFormat: null,
      lastExportScope: null,
      lastExportReason: null,
      updatedAt: now,
    } satisfies MatterReportExportAnalyticsRow)
  const relevanceSnapshot =
    existingRelevance ??
    buildRelevanceSnapshot(
      matter,
      documentCountByMatter.get(matter.id) ?? 0,
      actorId,
      reason,
      ["scaffold_seed"],
      now
    )
  if (!existingExport) {
    await repos.matterReportExportAnalytics.upsert(exportAnalytics)
    store.matterReportExportAnalytics.set(exportAnalytics.id, exportAnalytics)
  }
  if (!existingRelevance) {
    await repos.matterReportRelevanceSnapshots.upsert(relevanceSnapshot)
    store.matterReportRelevanceSnapshots.set(relevanceSnapshot.id, relevanceSnapshot)
  }
  return { exportAnalytics, relevanceSnapshot }
}

type RecordMatterReportExportBody = {
  action: "record_matter_report_export"
  actorId?: string
  matterId?: string
  exportFormat?: unknown
  exportScope?: unknown
  reason?: unknown
}

type RecomputeMatterReportRelevanceBody = {
  action: "recompute_matter_report_relevance"
  actorId?: string
  matterId?: string
  reason?: unknown
  provenanceTags?: unknown
}

type Body = RecordMatterReportExportBody | RecomputeMatterReportRelevanceBody

export async function GET(request: Request) {
  return withSession(request, handleGet)
}

async function handleGet(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = parseView(url.searchParams.get("view"))
  if (!view) {
    return NextResponse.json({ error: "unknown view" }, { status: 400 })
  }
  const actorId = url.searchParams.get("actorId")
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))
  const matterId = url.searchParams.get("matterId")
  const scoreBand = parseScoreBand(url.searchParams.get("scoreBand"))
  const freshnessStatus = parseFreshness(url.searchParams.get("freshnessStatus"))

  if (!actorId) {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }
  const actor = await resolveActor(actorId, store, repos)
  if (!actor) {
    return NextResponse.json({ error: "unknown actor" }, { status: 404 })
  }
  if (actor.role === "client" || actor.role === "intern" || actor.role === "accounts") {
    return NextResponse.json({ error: "actor role not allowed for reporting search" }, { status: 403 })
  }

  await syncFirmUsers(store, repos, actor.firmId)
  const refreshedActor = store.users.get(actorId)
  if (!refreshedActor) {
    return NextResponse.json({ error: "unknown actor" }, { status: 404 })
  }
  const matters = await repos.matters.listByFirm(refreshedActor.firmId)
  for (const matter of matters) store.matters.set(matter.id, matter)

  if (view === "search") {
    const rowType = parseRowType(url.searchParams.get("rowType"))
    const terms = normalizeTerms(url.searchParams.get("q"))
    const clients = await repos.entities.listByFirm(refreshedActor.firmId)
    for (const matter of matters) {
      await repos.reportingIndex.upsert(buildMatterSearchIndexRow(matter))
    }
    for (const entity of clients) {
      await repos.reportingIndex.upsert(buildClientSearchIndexRow(entity))
    }

    const all = (await repos.reportingIndex.listByFirm(refreshedActor.firmId))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOfStoredOrMax(row.classification))
      .filter((row) => (rowType ? row.rowType === rowType : true))
      .filter((row) => terms.every((term) => row.tags.includes(term)))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null

    return NextResponse.json({
      view: "search",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  const documentCountByMatter = await countFirmDocumentsByMatter(refreshedActor.firmId, repos)
  for (const matter of matters) {
    await ensureMatterReportingRows({
      matter,
      actorId: refreshedActor.id,
      reason: "read_scaffold_seed",
      documentCountByMatter,
      repos,
      store,
    })
  }
  const now = Date.now()
  const relevanceRows = await repos.matterReportRelevanceSnapshots.listByFirm(refreshedActor.firmId)
  const normalizedRelevance = relevanceRows
    .map((row) => ({
      ...row,
      freshnessStatus: asFreshnessStatus(row.recomputedAt, now),
    }))
    .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOfStoredOrMax(row.classification))
    .filter((row) => (matterId ? row.matterId === matterId : true))
    .filter((row) => (scoreBand ? row.scoreBand === scoreBand : true))
    .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

  if (view === "matter_report_relevance_snapshots") {
    const items = normalizedRelevance.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < normalizedRelevance.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view,
      items,
      total: normalizedRelevance.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  const relevanceByMatter = new Map(normalizedRelevance.map((row) => [row.matterId, row]))
  const exportRows = (await repos.matterReportExportAnalytics.listByFirm(refreshedActor.firmId))
    .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOfStoredOrMax(row.classification))
    .filter((row) => (matterId ? row.matterId === matterId : true))
    .filter((row) => {
      const relevance = relevanceByMatter.get(row.matterId)
      if (!relevance) return false
      if (scoreBand && relevance.scoreBand !== scoreBand) return false
      if (freshnessStatus && relevance.freshnessStatus !== freshnessStatus) return false
      return true
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const items = exportRows.slice(cursor, cursor + limit).map((row) => ({
    ...row,
    relevance: relevanceByMatter.get(row.matterId) ?? null,
  }))
  const nextCursor = cursor + items.length < exportRows.length ? String(cursor + items.length) : null

  return NextResponse.json({
    view,
    items,
    total: exportRows.length,
    limit,
    cursor,
    nextCursor,
  })
}

export async function POST(request: Request) {
  return withSession(request, handlePost)
}

async function handlePost(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  let key: string
  try {
    key = requireIdempotencyKey(request)
  } catch (err) {
    const message = err instanceof IdempotencyError ? err.message : "Idempotency-Key header required"
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
  if (
    parsed.action !== "record_matter_report_export" &&
    parsed.action !== "recompute_matter_report_relevance"
  ) {
    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  }

  const fingerprint = JSON.stringify({
    route: "/api/d1/reporting",
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

  const actorId = parsed.actorId
  const matterId = parsed.matterId
  if (!actorId || typeof actorId !== "string") {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }
  if (!matterId || typeof matterId !== "string") {
    return NextResponse.json({ error: "matterId is required" }, { status: 400 })
  }

  const actor = await resolveActor(actorId, store, repos)
  if (!actor) {
    return NextResponse.json({ error: "unknown actor" }, { status: 404 })
  }
  if (actor.role !== "partner") {
    return NextResponse.json({ error: "actor role not allowed for reporting governance" }, { status: 403 })
  }

  await syncFirmUsers(store, repos, actor.firmId)
  const matter = await resolveMatter(matterId, store, repos)
  if (!matter || matter.firmId !== actor.firmId) {
    return NextResponse.json({ error: "unknown matter" }, { status: 404 })
  }

  const documentCountByMatter = await countFirmDocumentsByMatter(actor.firmId, repos)
  const baseline = await ensureMatterReportingRows({
    matter,
    actorId: actor.id,
    reason: "post_scaffold_seed",
    documentCountByMatter,
    repos,
    store,
  })

  try {
    if (parsed.action === "record_matter_report_export") {
      const now = Date.now()
      const nextRow: MatterReportExportAnalyticsRow = {
        ...baseline.exportAnalytics,
        exportCount: baseline.exportAnalytics.exportCount + 1,
        lastExportedAt: now,
        lastExportedBy: actor.id,
        lastExportFormat: parseExportFormat(parsed.exportFormat),
        lastExportScope: parseExportScope(parsed.exportScope),
        lastExportReason: normalizeReason(parsed.reason, "export_recorded"),
        updatedAt: now,
      }
      await repos.matterReportExportAnalytics.upsert(nextRow)
      store.matterReportExportAnalytics.set(nextRow.id, nextRow)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "reporting_matter_export_recorded",
        actorId: actor.id,
        target: matter.id,
        classification: matter.classification,
        reason: `${nextRow.lastExportScope}:${nextRow.lastExportFormat}:${nextRow.lastExportReason}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        exportAnalytics: nextRow,
        relevanceSnapshot: baseline.relevanceSnapshot,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    const now = Date.now()
    const recomputeReason = normalizeReason(parsed.reason, "manual_recompute")
    const nextSnapshot = buildRelevanceSnapshot(
      matter,
      documentCountByMatter.get(matter.id) ?? 0,
      actor.id,
      recomputeReason,
      normalizeOptionalTags(parsed.provenanceTags),
      now
    )
    await repos.matterReportRelevanceSnapshots.upsert(nextSnapshot)
    store.matterReportRelevanceSnapshots.set(nextSnapshot.id, nextSnapshot)
    const priorAuditCount = store.audit.length
    store.audit.push({
      action: "reporting_matter_relevance_recomputed",
      actorId: actor.id,
      target: matter.id,
      classification: matter.classification,
      reason: recomputeReason,
    })
    await persistAuditEntriesSince(store, repos, priorAuditCount)
    const payload = {
      action: parsed.action,
      relevanceSnapshot: nextSnapshot,
      exportAnalytics: baseline.exportAnalytics,
    }
    idempotency.set(key, payload, fingerprint)
    return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
  } catch (err) {
    const message = publicErrorMessage(err, "reporting operation failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}
