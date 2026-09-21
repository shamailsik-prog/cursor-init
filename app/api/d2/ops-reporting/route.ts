import { NextResponse } from "next/server"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import {
  rankOf,
  type Classification,
  type FollowUp,
  type Matter,
  type User,
  type WorkflowOpsActivityRow,
  type WorkflowOpsAlertAttestationFreshnessStatus,
  type WorkflowOpsAlertAttestationRow,
  type WorkflowOpsAlertAttestationStatus,
  type WorkflowOpsAlertDigestFreshnessStatus,
  type WorkflowOpsAlertDigestRow,
  type WorkflowOpsAlertDigestSeverity,
  type WorkflowOpsAlertEscalationFreshnessStatus,
  type WorkflowOpsAlertEscalationLedgerRow,
  type WorkflowOpsAlertEscalationStatus,
} from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { syncFirmUsers } from "@/platform/persistence/userSync"
import { persistAuditEntriesSince } from "@/platform/persistence/auditWriteThrough"
import { checkPermission } from "@/platform/p5/checkPermission"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000

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

type View = "activity" | "alert_digests" | "alert_attestations" | "alert_escalation_ledgers"

function parseView(value: string | null): View | undefined {
  if (!value || value === "activity") return "activity"
  if (value === "alert_digests") return value
  if (value === "alert_attestations") return value
  if (value === "alert_escalation_ledgers") return value
  return undefined
}

function parseSeverity(value: string | null): WorkflowOpsAlertDigestSeverity | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value
  }
  return undefined
}

function parseFreshness(value: string | null): WorkflowOpsAlertDigestFreshnessStatus | undefined {
  if (value === "fresh" || value === "stale") return value
  return undefined
}

function parseAttestationStatus(value: string | null): WorkflowOpsAlertAttestationStatus | undefined {
  if (value === "pending_attestation" || value === "attested" || value === "reopened") return value
  return undefined
}

function parseEscalationStatus(value: string | null): WorkflowOpsAlertEscalationStatus | undefined {
  if (value === "not_required" || value === "open" || value === "assigned" || value === "resolved") {
    return value
  }
  return undefined
}

function parseSnoozedUntil(value: unknown, now: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN
  if (!Number.isFinite(parsed)) {
    throw new Error("snoozedUntil must be a unix epoch milliseconds number")
  }
  if (parsed <= now) {
    throw new Error("snoozedUntil must be in the future")
  }
  return parsed
}

function normalizeReason(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function asFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertDigestFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function alertDigestId(matterId: string): string {
  return `workflow_ops_alert:${matterId}`
}

function alertAttestationId(matterId: string): string {
  return `workflow_ops_alert_attestation:${matterId}`
}

function alertEscalationLedgerId(matterId: string): string {
  return `workflow_ops_alert_escalation:${matterId}`
}

function severityRank(value: WorkflowOpsAlertDigestSeverity): number {
  switch (value) {
    case "critical":
      return 4
    case "high":
      return 3
    case "medium":
      return 2
    case "low":
    default:
      return 1
  }
}

function strongerClassification(left: Classification, right: Classification): Classification {
  return rankOf(left) >= rankOf(right) ? left : right
}

function isResolvedStatus(status: string | null): boolean {
  if (!status) return false
  const normalized = status.toLowerCase()
  return (
    normalized.includes("resolved") ||
    normalized.includes("complete") ||
    normalized.includes("closed")
  )
}

function computeSeverity(params: {
  backlogPressureCount: number
  unresolvedFollowUpDebtCount: number
  staleQueueWindowCount: number
}): WorkflowOpsAlertDigestSeverity {
  const { backlogPressureCount, unresolvedFollowUpDebtCount, staleQueueWindowCount } = params
  if (staleQueueWindowCount >= 4 || unresolvedFollowUpDebtCount >= 4 || backlogPressureCount >= 12) {
    return "critical"
  }
  if (staleQueueWindowCount >= 2 || unresolvedFollowUpDebtCount >= 2 || backlogPressureCount >= 7) {
    return "high"
  }
  if (staleQueueWindowCount >= 1 || unresolvedFollowUpDebtCount >= 1 || backlogPressureCount >= 3) {
    return "medium"
  }
  return "low"
}

function normalizeProvenanceTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))]
}

function buildWorkflowOpsAlertDigest(params: {
  firmId: string
  matter: Matter
  actorId: string
  reason: string
  activities: WorkflowOpsActivityRow[]
  followUps: FollowUp[]
  existing: WorkflowOpsAlertDigestRow | null
  now: number
}): WorkflowOpsAlertDigestRow {
  const { firmId, matter, actorId, reason, activities, followUps, existing, now } = params
  const unresolvedFollowUps = followUps.filter((row) => row.status !== "resolved")
  const unresolvedActivities = activities.filter((row) => !isResolvedStatus(row.status))
  const staleActivities = unresolvedActivities.filter((row) => now - row.createdAt >= STALE_WINDOW_MS)

  const backlogPressureCount = unresolvedActivities.length + unresolvedFollowUps.length
  const unresolvedFollowUpDebtCount = unresolvedFollowUps.length
  const staleQueueWindowCount = staleActivities.length
  const severity = computeSeverity({
    backlogPressureCount,
    unresolvedFollowUpDebtCount,
    staleQueueWindowCount,
  })

  let classification: Classification = matter.classification
  for (const row of activities) {
    classification = strongerClassification(classification, row.classification)
  }

  return {
    id: alertDigestId(matter.id),
    firmId,
    matterId: matter.id,
    classification,
    severity,
    backlogPressureCount,
    unresolvedFollowUpDebtCount,
    staleQueueWindowCount,
    freshnessStatus: "fresh",
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `backlog:${backlogPressureCount}`,
      `unresolved_followups:${unresolvedFollowUpDebtCount}`,
      `stale_windows:${staleQueueWindowCount}`,
      `activity_rows:${activities.length}`,
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    acknowledgedAt: existing?.acknowledgedAt ?? null,
    acknowledgedBy: existing?.acknowledgedBy ?? null,
    acknowledgedReason: existing?.acknowledgedReason ?? null,
    snoozedUntil: existing?.snoozedUntil ?? null,
    snoozedBy: existing?.snoozedBy ?? null,
    snoozedReason: existing?.snoozedReason ?? null,
    updatedAt: now,
  }
}

function computeDefaultEscalationStatus(
  severity: WorkflowOpsAlertDigestSeverity
): WorkflowOpsAlertEscalationStatus {
  if (severity === "high" || severity === "critical") return "open"
  return "not_required"
}

function asAttestationFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertAttestationFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asEscalationFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertEscalationFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function buildWorkflowOpsAlertAttestationRow(params: {
  digest: WorkflowOpsAlertDigestRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertAttestationRow | null
  now: number
}): WorkflowOpsAlertAttestationRow {
  const { digest, actorId, reason, existing, now } = params
  const attestationStatus: WorkflowOpsAlertAttestationStatus =
    existing?.attestationStatus ?? "pending_attestation"
  return {
    id: alertAttestationId(digest.matterId ?? digest.id),
    firmId: digest.firmId,
    matterId: digest.matterId ?? digest.id,
    alertDigestId: digest.id,
    classification: digest.classification,
    attestationStatus,
    lastAttestedAt: existing?.lastAttestedAt ?? null,
    lastAttestedBy: existing?.lastAttestedBy ?? null,
    attestationReason: existing?.attestationReason ?? null,
    freshnessStatus: asAttestationFreshnessStatus(digest.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `digest_severity:${digest.severity}`,
      ...digest.provenanceTags.map((tag) => `digest_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertEscalationLedgerRow(params: {
  digest: WorkflowOpsAlertDigestRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertEscalationLedgerRow | null
  now: number
}): WorkflowOpsAlertEscalationLedgerRow {
  const { digest, actorId, reason, existing, now } = params
  const defaultStatus = computeDefaultEscalationStatus(digest.severity)
  const escalationStatus = existing?.escalationStatus ?? defaultStatus

  const openedAt =
    escalationStatus === "open" || escalationStatus === "assigned"
      ? existing?.openedAt ?? now
      : existing?.openedAt ?? null
  const lastStatusChangedAt = existing?.lastStatusChangedAt ?? openedAt
  const resolvedAt = escalationStatus === "resolved" ? existing?.resolvedAt ?? now : null
  const resolutionReason = escalationStatus === "resolved" ? existing?.resolutionReason ?? null : null

  return {
    id: alertEscalationLedgerId(digest.matterId ?? digest.id),
    firmId: digest.firmId,
    matterId: digest.matterId ?? digest.id,
    alertDigestId: digest.id,
    classification: digest.classification,
    escalationStatus,
    severity: digest.severity,
    ownerId: existing?.ownerId ?? null,
    openedAt,
    lastStatusChangedAt,
    resolvedAt,
    resolutionReason,
    freshnessStatus: asEscalationFreshnessStatus(digest.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `digest_severity:${digest.severity}`,
      ...digest.provenanceTags.map((tag) => `digest_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

async function resolveActor(params: {
  actorId: string
  store: ReturnType<typeof getRuntimeStore>
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
}): Promise<User | null> {
  const { actorId, store, repos } = params
  const local = store.users.get(actorId)
  if (local) return local
  const persisted = await repos.users.get(actorId)
  if (!persisted) return null
  store.users.set(persisted.id, persisted)
  return persisted
}

async function resolveMatter(params: {
  matterId: string
  store: ReturnType<typeof getRuntimeStore>
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
}): Promise<Matter | null> {
  const { matterId, store, repos } = params
  const local = store.matters.get(matterId)
  if (local) return local
  const persisted = await repos.matters.get(matterId)
  if (!persisted) return null
  store.matters.set(persisted.id, persisted)
  return persisted
}

async function ensureWorkflowOpsAlertDigests(params: {
  actorId: string
  actorFirmId: string
  reason: string
  store: ReturnType<typeof getRuntimeStore>
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
}): Promise<WorkflowOpsAlertDigestRow[]> {
  const { actorId, actorFirmId, reason, store, repos } = params
  const matters = await repos.matters.listByFirm(actorFirmId)
  for (const matter of matters) {
    store.matters.set(matter.id, matter)
  }
  const matterById = new Map(matters.map((matter) => [matter.id, matter]))
  const activities = await repos.workflowOpsActivity.listByFirm(actorFirmId)
  const followUps = await repos.followUps.listByFirm(actorFirmId)
  const now = Date.now()
  const matterIds = new Set<string>()
  for (const row of activities) {
    if (row.matterId) matterIds.add(row.matterId)
  }
  for (const row of followUps) {
    matterIds.add(row.matterId)
  }
  const rows: WorkflowOpsAlertDigestRow[] = []
  for (const matterId of [...matterIds].sort((a, b) => a.localeCompare(b))) {
    const matter = matterById.get(matterId)
    if (!matter) continue
    const existing = await repos.workflowOpsAlertDigests.get(alertDigestId(matter.id))
    const digest = buildWorkflowOpsAlertDigest({
      firmId: actorFirmId,
      matter,
      actorId,
      reason,
      activities: activities.filter((row) => row.matterId === matter.id),
      followUps: followUps.filter((row) => row.matterId === matter.id),
      existing,
      now,
    })
    await repos.workflowOpsAlertDigests.upsert(digest)
    store.workflowOpsAlertDigests.set(digest.id, digest)
    rows.push(digest)
  }
  return rows
}

async function ensureWorkflowOpsAlertGovernanceRows(params: {
  digests: WorkflowOpsAlertDigestRow[]
  actorId: string
  reason: string
  store: ReturnType<typeof getRuntimeStore>
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
}): Promise<{
  attestations: WorkflowOpsAlertAttestationRow[]
  escalationLedgers: WorkflowOpsAlertEscalationLedgerRow[]
}> {
  const { digests, actorId, reason, store, repos } = params
  const now = Date.now()
  const attestations: WorkflowOpsAlertAttestationRow[] = []
  const escalationLedgers: WorkflowOpsAlertEscalationLedgerRow[] = []

  for (const digest of digests) {
    if (!digest.matterId) continue
    const attestationKey = alertAttestationId(digest.matterId)
    const escalationKey = alertEscalationLedgerId(digest.matterId)
    const existingAttestation = await repos.workflowOpsAlertAttestations.get(attestationKey)
    const existingEscalation = await repos.workflowOpsAlertEscalationLedgers.get(escalationKey)

    const attestation = buildWorkflowOpsAlertAttestationRow({
      digest,
      actorId,
      reason,
      existing: existingAttestation,
      now,
    })
    const escalation = buildWorkflowOpsAlertEscalationLedgerRow({
      digest,
      actorId,
      reason,
      existing: existingEscalation,
      now,
    })

    await repos.workflowOpsAlertAttestations.upsert(attestation)
    await repos.workflowOpsAlertEscalationLedgers.upsert(escalation)
    store.workflowOpsAlertAttestations.set(attestation.id, attestation)
    store.workflowOpsAlertEscalationLedgers.set(escalation.id, escalation)
    attestations.push(attestation)
    escalationLedgers.push(escalation)
  }

  return { attestations, escalationLedgers }
}

type ViewActivityBody = never

type AcknowledgeWorkflowOpsAlertDigestBody = {
  action: "acknowledge_workflow_ops_alert_digest"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type SnoozeWorkflowOpsAlertDigestBody = {
  action: "snooze_workflow_ops_alert_digest"
  actorId?: string
  matterId?: string
  snoozedUntil?: unknown
  reason?: unknown
}

type AttestWorkflowOpsAlertDigestBody = {
  action: "attest_workflow_ops_alert_digest"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type OpenWorkflowOpsAlertEscalationBody = {
  action: "open_workflow_ops_alert_escalation"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AssignWorkflowOpsAlertEscalationOwnerBody = {
  action: "assign_workflow_ops_alert_escalation_owner"
  actorId?: string
  matterId?: string
  ownerId?: unknown
  reason?: unknown
}

type ResolveWorkflowOpsAlertEscalationBody = {
  action: "resolve_workflow_ops_alert_escalation"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type Body =
  | ViewActivityBody
  | AcknowledgeWorkflowOpsAlertDigestBody
  | SnoozeWorkflowOpsAlertDigestBody
  | AttestWorkflowOpsAlertDigestBody
  | OpenWorkflowOpsAlertEscalationBody
  | AssignWorkflowOpsAlertEscalationOwnerBody
  | ResolveWorkflowOpsAlertEscalationBody

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = parseView(url.searchParams.get("view"))
  if (!view) {
    return NextResponse.json({ error: "unknown view" }, { status: 400 })
  }
  const actorId = url.searchParams.get("actorId")
  const matterId = url.searchParams.get("matterId")
  const source = parseSource(url.searchParams.get("source"))
  const action = url.searchParams.get("action")
  const status = url.searchParams.get("status")
  const severity = parseSeverity(url.searchParams.get("severity"))
  const freshnessStatus = parseFreshness(url.searchParams.get("freshnessStatus"))
  const attestationStatus = parseAttestationStatus(url.searchParams.get("attestationStatus"))
  const escalationStatus = parseEscalationStatus(url.searchParams.get("escalationStatus"))
  const terms = normalizeTerms(url.searchParams.get("q"))
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))

  if (!actorId) {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }

  const actor = await resolveActor({ actorId, store, repos })
  if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
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

  if (view === "activity") {
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
      view: "activity",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  const digests = await ensureWorkflowOpsAlertDigests({
    actorId: refreshedActor.id,
    actorFirmId: refreshedActor.firmId,
    reason: "read_scaffold_seed",
    store,
    repos,
  })
  await ensureWorkflowOpsAlertGovernanceRows({
    digests,
    actorId: refreshedActor.id,
    reason: "read_scaffold_seed",
    store,
    repos,
  })
  const now = Date.now()
  if (view === "alert_digests") {
    const all = (await repos.workflowOpsAlertDigests.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (severity ? row.severity === severity : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => {
        if (!row.matterId) return true
        return checkPermission(store, refreshedActor.id, "research", row.matterId).allow
      })
      .sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          b.updatedAt - a.updatedAt ||
          a.id.localeCompare(b.id)
      )

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null

    return NextResponse.json({
      view: "alert_digests",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_attestations") {
    const all = (await repos.workflowOpsAlertAttestations.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asAttestationFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (attestationStatus ? row.attestationStatus === attestationStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_attestations",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  const all = (await repos.workflowOpsAlertEscalationLedgers.listByFirm(refreshedActor.firmId))
    .map((row) => ({
      ...row,
      freshnessStatus: asEscalationFreshnessStatus(row.recomputedAt, now),
    }))
    .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
    .filter((row) => (matterId ? row.matterId === matterId : true))
    .filter((row) => (escalationStatus ? row.escalationStatus === escalationStatus : true))
    .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
    .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

  const items = all.slice(cursor, cursor + limit)
  const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
  return NextResponse.json({
    view: "alert_escalation_ledgers",
    items,
    total: all.length,
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
    const message = err instanceof IdempotencyError ? err.message : "Idempotency-Key header required"
    return NextResponse.json({ error: message }, { status: 400 })
  }

  let parsed: Body
  try {
    parsed = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  if (
    !parsed ||
    (parsed.action !== "acknowledge_workflow_ops_alert_digest" &&
      parsed.action !== "snooze_workflow_ops_alert_digest" &&
      parsed.action !== "attest_workflow_ops_alert_digest" &&
      parsed.action !== "open_workflow_ops_alert_escalation" &&
      parsed.action !== "assign_workflow_ops_alert_escalation_owner" &&
      parsed.action !== "resolve_workflow_ops_alert_escalation")
  ) {
    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  }

  const fingerprint = JSON.stringify({
    route: "/api/d2/ops-reporting",
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

  const actor = await resolveActor({ actorId, store, repos })
  if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
  if (actor.role !== "partner") {
    return NextResponse.json({ error: "actor role not allowed for ops alert governance" }, { status: 403 })
  }

  await syncFirmUsers(store, repos, actor.firmId)
  await syncFirmMembers(store, repos, actor.firmId)
  const matter = await resolveMatter({ matterId, store, repos })
  if (!matter || matter.firmId !== actor.firmId) {
    return NextResponse.json({ error: "unknown matter" }, { status: 404 })
  }

  const now = Date.now()
  const seeded = await ensureWorkflowOpsAlertDigests({
    actorId: actor.id,
    actorFirmId: actor.firmId,
    reason: "post_scaffold_seed",
    store,
    repos,
  })
  const seededRow = seeded.find((row) => row.matterId === matter.id) ?? null
  const digestId = alertDigestId(matter.id)
  const current =
    seededRow ??
    store.workflowOpsAlertDigests.get(digestId) ??
    (await repos.workflowOpsAlertDigests.get(digestId))
  if (!current) {
    return NextResponse.json({ error: "no alert digest exists for matter" }, { status: 404 })
  }
  const governance = await ensureWorkflowOpsAlertGovernanceRows({
    digests: [current],
    actorId: actor.id,
    reason: "post_scaffold_seed",
    store,
    repos,
  })
  const currentAttestation =
    governance.attestations.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertAttestations.get(alertAttestationId(matter.id)) ??
    (await repos.workflowOpsAlertAttestations.get(alertAttestationId(matter.id)))
  const currentEscalation =
    governance.escalationLedgers.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertEscalationLedgers.get(alertEscalationLedgerId(matter.id)) ??
    (await repos.workflowOpsAlertEscalationLedgers.get(alertEscalationLedgerId(matter.id)))
  if (!currentAttestation || !currentEscalation) {
    return NextResponse.json({ error: "alert governance rows are unavailable for matter" }, { status: 404 })
  }

  try {
    if (parsed.action === "acknowledge_workflow_ops_alert_digest") {
      const reason = normalizeReason(parsed.reason, "alert_acknowledged")
      const next: WorkflowOpsAlertDigestRow = {
        ...current,
        freshnessStatus: asFreshnessStatus(current.recomputedAt, now),
        acknowledgedAt: now,
        acknowledgedBy: actor.id,
        acknowledgedReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertDigests.upsert(next)
      store.workflowOpsAlertDigests.set(next.id, next)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_digest_acknowledged",
        actorId: actor.id,
        target: next.matterId ?? next.id,
        classification: next.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: next,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "snooze_workflow_ops_alert_digest") {
      const snoozedUntil = parseSnoozedUntil(parsed.snoozedUntil, now)
      const reason = normalizeReason(parsed.reason, "alert_snoozed")
      const next: WorkflowOpsAlertDigestRow = {
        ...current,
        freshnessStatus: asFreshnessStatus(current.recomputedAt, now),
        snoozedUntil,
        snoozedBy: actor.id,
        snoozedReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertDigests.upsert(next)
      store.workflowOpsAlertDigests.set(next.id, next)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_digest_snoozed",
        actorId: actor.id,
        target: next.matterId ?? next.id,
        classification: next.classification,
        reason: `${reason}:${snoozedUntil}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: next,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_workflow_ops_alert_digest") {
      const reason = normalizeReason(parsed.reason, "attestation_recorded")
      const nextAttestation: WorkflowOpsAlertAttestationRow = {
        ...currentAttestation,
        attestationStatus: "attested",
        lastAttestedAt: now,
        lastAttestedBy: actor.id,
        attestationReason: reason,
        freshnessStatus: asAttestationFreshnessStatus(current.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertAttestations.upsert(nextAttestation)
      store.workflowOpsAlertAttestations.set(nextAttestation.id, nextAttestation)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_attested",
        actorId: actor.id,
        target: nextAttestation.matterId,
        classification: nextAttestation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        attestation: nextAttestation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "open_workflow_ops_alert_escalation") {
      const reason = normalizeReason(parsed.reason, "escalation_opened")
      const nextEscalation: WorkflowOpsAlertEscalationLedgerRow = {
        ...currentEscalation,
        escalationStatus: "open",
        openedAt: currentEscalation.openedAt ?? now,
        lastStatusChangedAt: now,
        resolvedAt: null,
        resolutionReason: null,
        freshnessStatus: asEscalationFreshnessStatus(current.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEscalationLedgers.upsert(nextEscalation)
      store.workflowOpsAlertEscalationLedgers.set(nextEscalation.id, nextEscalation)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_escalation_opened",
        actorId: actor.id,
        target: nextEscalation.matterId,
        classification: nextEscalation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        escalation: nextEscalation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_workflow_ops_alert_escalation_owner") {
      const ownerId = typeof parsed.ownerId === "string" ? parsed.ownerId.trim() : ""
      if (!ownerId) {
        return NextResponse.json({ error: "ownerId is required" }, { status: 400 })
      }
      const reason = normalizeReason(parsed.reason, "escalation_owner_assigned")
      const nextEscalation: WorkflowOpsAlertEscalationLedgerRow = {
        ...currentEscalation,
        escalationStatus: "assigned",
        ownerId,
        openedAt: currentEscalation.openedAt ?? now,
        lastStatusChangedAt: now,
        resolvedAt: null,
        resolutionReason: null,
        freshnessStatus: asEscalationFreshnessStatus(current.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEscalationLedgers.upsert(nextEscalation)
      store.workflowOpsAlertEscalationLedgers.set(nextEscalation.id, nextEscalation)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_escalation_owner_assigned",
        actorId: actor.id,
        target: nextEscalation.matterId,
        classification: nextEscalation.classification,
        reason: `${reason}:${ownerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        escalation: nextEscalation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    const reason = normalizeReason(parsed.reason, "escalation_resolved")
    const nextEscalation: WorkflowOpsAlertEscalationLedgerRow = {
      ...currentEscalation,
      escalationStatus: "resolved",
      lastStatusChangedAt: now,
      resolvedAt: now,
      resolutionReason: reason,
      freshnessStatus: asEscalationFreshnessStatus(current.recomputedAt, now),
      updatedAt: now,
    }
    await repos.workflowOpsAlertEscalationLedgers.upsert(nextEscalation)
    store.workflowOpsAlertEscalationLedgers.set(nextEscalation.id, nextEscalation)
    const priorAuditCount = store.audit.length
    store.audit.push({
      action: "ops_reporting_alert_escalation_resolved",
      actorId: actor.id,
      target: nextEscalation.matterId,
      classification: nextEscalation.classification,
      reason,
    })
    await persistAuditEntriesSince(store, repos, priorAuditCount)
    const payload = {
      action: parsed.action,
      digest: current,
      escalation: nextEscalation,
    }
    idempotency.set(key, payload, fingerprint)
    return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : "ops reporting action failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
