import { NextResponse } from "next/server"
import { parseLimit, parseCursor } from "@/platform/http/pagination"
import { fingerprintOf } from "@/platform/http/validation"
import { REPORTING_SURFACE } from "./surface"
import { PublicError } from "@/platform/http/publicError"
import { actionOf, getQuery, isAction, refuseUndeclaredBody, selectView } from "@/platform/http/surface"
import { withSession } from "@/platform/http/withSession"
import { REQUEST_FAILED_CODE, publicErrorMessage } from "@/platform/http/errors"
import {
  beginIdempotentRequest,
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
  SearchIndexMalformedError,
} from "@/platform/persistence/matterClientSearchIndex"
import { syncFirmUsers } from "@/platform/persistence/userSync"
import { syncFirmMatters } from "@/platform/persistence/memberSync"

const RELEVANCE_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000

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

async function resolveActor(
  actorId: string,
  firmId: string,
  store: ReturnType<typeof getRuntimeStore>,
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
): Promise<User | null> {
  const local = store.users.get(actorId)
  if (local) return local
  const persisted = await repos.users.get(actorId, firmId)
  if (!persisted) return null
  store.users.set(persisted.id, persisted)
  return persisted
}

async function resolveMatter(
  matterId: string,
  firmId: string,
  store: ReturnType<typeof getRuntimeStore>,
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
): Promise<Matter | null> {
  const local = store.matters.get(matterId)
  if (local) return local
  const persisted = await repos.matters.get(matterId, firmId)
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
  const existingExport = await repos.matterReportExportAnalytics.get(exportId, matter.firmId)
  const existingRelevance = await repos.matterReportRelevanceSnapshots.get(relevanceId, matter.firmId)
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
  return withSession(request, handleGet, { surface: REPORTING_SURFACE })
}

async function handleGet(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = selectView(REPORTING_SURFACE, url)
  if (!view) {
    return NextResponse.json({ error: "unknown view" }, { status: 400 })
  }
  const actorId = getQuery(REPORTING_SURFACE, url, "actorId")
  const limit = parseLimit(getQuery(REPORTING_SURFACE, url, "limit"))
  const cursor = parseCursor(getQuery(REPORTING_SURFACE, url, "cursor"))
  const matterId = getQuery(REPORTING_SURFACE, url, "matterId")
  const scoreBand = parseScoreBand(getQuery(REPORTING_SURFACE, url, "scoreBand"))
  const freshnessStatus = parseFreshness(getQuery(REPORTING_SURFACE, url, "freshnessStatus"))

  if (!actorId) {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }
  const actor = await resolveActor(
    actorId,
    store.users.get(actorId)?.firmId ?? "",
    store,
    repos
  )
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
  // Audit F14 NEW-1: the shared matter sync (reconciles the cache as every other route does) in place of this route's
  // own upsert loop; its listing is reused below.
  const matters = await syncFirmMatters(store, repos, refreshedActor.firmId)

  if (view === "search") {
    const rowType = parseRowType(getQuery(REPORTING_SURFACE, url, "rowType"))
    const terms = normalizeTerms(getQuery(REPORTING_SURFACE, url, "q"))
    const clients = await repos.entities.listByFirm(refreshedActor.firmId)
    for (const matter of matters) {
      try {
        await repos.reportingIndex.upsert(buildMatterSearchIndexRow(matter))
      } catch (err) {
        // A malformed stored row is denied. The search does not republish over it and does not fail the whole firm.
        if (!(err instanceof SearchIndexMalformedError)) throw err
      }
    }
    for (const entity of clients) {
      try {
        await repos.reportingIndex.upsert(buildClientSearchIndexRow(entity))
      } catch (err) {
        if (!(err instanceof SearchIndexMalformedError)) throw err
      }
    }

    const indexed = await repos.reportingIndex.listByFirm(refreshedActor.firmId)
    // FA-F13-004 (reporting-index slice): rows the validator omitted are not absent data. Drop this process's cached
    // copy of each one so a later read cannot serve it in place of the refused row.
    const liveIds = new Set(indexed.map((row) => row.id))
    for (const id of [...store.matterClientSearchIndex.keys()]) {
      const cached = store.matterClientSearchIndex.get(id)
      if (cached && cached.firmId === refreshedActor.firmId && !liveIds.has(id)) {
        store.matterClientSearchIndex.delete(id)
      }
    }
    const all = indexed
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
  return withSession(request, handlePost, { surface: REPORTING_SURFACE })
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
  const undeclared = refuseUndeclaredBody(REPORTING_SURFACE, parsed)
  if (undeclared) return undeclared

  if (actionOf(REPORTING_SURFACE, parsed) === null) {
    return NextResponse.json({ error: "action is required" }, { status: 400 })
  }
  if (
    !isAction(REPORTING_SURFACE, parsed, "record_matter_report_export") &&
    !isAction(REPORTING_SURFACE, parsed, "recompute_matter_report_relevance")
  ) {
    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  }

  const fingerprint = fingerprintOf({
    route: "/api/d1/reporting",
    action: actionOf(REPORTING_SURFACE, parsed),
    body: parsed,
  })
  // Final audit F4: check-and-reserve the key in one synchronous step (no await in between).
  const idem = await beginIdempotentRequest(request, key, fingerprint)
  if (idem.response) return idem.response
  const claim = idem.claim

  const actorId = parsed.actorId
  const matterId = parsed.matterId
  if (!actorId || typeof actorId !== "string") {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }
  if (!matterId || typeof matterId !== "string") {
    return NextResponse.json({ error: "matterId is required" }, { status: 400 })
  }

  const actor = await resolveActor(
    actorId,
    store.users.get(actorId)?.firmId ?? "",
    store,
    repos
  )
  if (!actor) {
    return NextResponse.json({ error: "unknown actor" }, { status: 404 })
  }
  if (actor.role !== "partner") {
    return NextResponse.json({ error: "actor role not allowed for reporting governance" }, { status: 403 })
  }

  await syncFirmUsers(store, repos, actor.firmId)
  // Audit F14 R2-D1: the reporting rows seeded below take the matter's current label, not a cached one.
  await syncFirmMatters(store, repos, actor.firmId)
  const matter = await resolveMatter(matterId, actor.firmId, store, repos)
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
    if (isAction(REPORTING_SURFACE, parsed, "record_matter_report_export")) {
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
      store.audit.push({
        action: "reporting_matter_export_recorded",
        actorId: actor.id,
        target: matter.id,
        classification: matter.classification,
        reason: `${nextRow.lastExportScope}:${nextRow.lastExportFormat}:${nextRow.lastExportReason}`,
      })
      const payload = {
        action: actionOf(REPORTING_SURFACE, parsed),
        exportAnalytics: nextRow,
        relevanceSnapshot: baseline.relevanceSnapshot,
      }
      claim.complete(payload)
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
    store.audit.push({
      action: "reporting_matter_relevance_recomputed",
      actorId: actor.id,
      target: matter.id,
      classification: matter.classification,
      reason: recomputeReason,
    })
    const payload = {
      action: actionOf(REPORTING_SURFACE, parsed),
      relevanceSnapshot: nextSnapshot,
      exportAnalytics: baseline.exportAnalytics,
    }
    claim.complete(payload)
    return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
  } catch (err) {
    const message = publicErrorMessage(err, "reporting operation failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}
