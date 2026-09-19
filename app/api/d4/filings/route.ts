import { NextResponse } from "next/server"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { isClassification } from "@/platform/p1/types"
import { rankOf } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { persistAuditEntriesSince } from "@/platform/persistence/auditWriteThrough"
import { buildFilingPacketArtifactRow } from "@/platform/persistence/filingPacketArtifacts"
import {
  buildFilingDispatchQueueRow,
  filingDispatchQueueId,
  isFilingDispatchQueueStatus,
} from "@/platform/persistence/filingDispatchQueue"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  createFilingPackage,
  decideFilingPackage,
} from "@/services/d4-3/filingPackage"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

type CreateBody = {
  action: "create_package"
  actorId?: string
  matterId?: string
  draftId?: string
  classification?: string
  citedJudgmentIds?: string[]
  temporalCitations?: Array<{
    sectionId: string
    offenceDate: string
    usedText: string
  }>
  partnerOverride?: {
    partnerId?: string
    reason?: string
  }
}

type DecideBody = {
  action: "decide_package"
  actorId?: string
  packageId?: string
  decision?: "approve" | "reject"
  reason?: string
}

type DispatchUpdateBody = {
  action: "dispatch_update"
  actorId?: string
  packageId?: string
  nextStatus?: "queued" | "in_progress" | "retry_pending" | "handoff_ready" | "blocked"
  assigneeId?: string | null
  note?: string
  markAttempt?: boolean
}

type Body = CreateBody | DecideBody | DispatchUpdateBody

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

function parseReadiness(value: string | null): "ready" | "blocked" | undefined {
  if (value === "ready" || value === "blocked") return value
  return undefined
}

function parseFilingsView(value: string | null): "packages" | "dispatch" {
  if (value === "dispatch") return "dispatch"
  return "packages"
}

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = parseFilingsView(url.searchParams.get("view"))
  const userId = url.searchParams.get("userId")
  const matterId = url.searchParams.get("matterId") ?? undefined
  const readiness = parseReadiness(url.searchParams.get("readiness"))
  const dispatchStatus = url.searchParams.get("dispatchStatus")
  const assigneeId = url.searchParams.get("assigneeId")
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  try {
    const user = store.users.get(userId)
    if (!user) {
      return NextResponse.json({ error: "unknown user" }, { status: 404 })
    }
    await syncFirmMembers(store, repos, user.firmId)
    const firmPackages = await repos.filings.listByFirm(user.firmId)
    const artifactRows = await repos.filingPacketArtifacts.listByFirm(user.firmId)
    const artifactByPackage = new Map(artifactRows.map((row) => [row.packageId, row]))
    for (const filingPackage of firmPackages) {
      if (artifactByPackage.has(filingPackage.id)) continue
      const draft =
        store.drafts.get(filingPackage.draftId) ?? (await repos.drafts.get(filingPackage.draftId))
      const artifact = buildFilingPacketArtifactRow(filingPackage, draft)
      await repos.filingPacketArtifacts.upsert(artifact)
      store.filingPacketArtifacts.set(artifact.id, artifact)
      artifactByPackage.set(filingPackage.id, artifact)
    }
    if (view === "dispatch") {
      const queueRows = await repos.filingDispatchQueue.listByFirm(user.firmId)
      const queueByPackage = new Map(queueRows.map((row) => [row.packageId, row]))
      for (const filingPackage of firmPackages) {
        if (filingPackage.status !== "approved" || queueByPackage.has(filingPackage.id)) continue
        const queueRow = buildFilingDispatchQueueRow(filingPackage)
        await repos.filingDispatchQueue.upsert(queueRow)
        store.filingDispatchQueue.set(queueRow.id, queueRow)
        queueByPackage.set(filingPackage.id, queueRow)
      }
      const visible = [...queueByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .filter((row) => {
          if (!dispatchStatus || !isFilingDispatchQueueStatus(dispatchStatus)) return true
          return row.status === dispatchStatus
        })
        .filter((row) => (assigneeId ? row.assigneeId === assigneeId : true))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }

    const visible = firmPackages
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => {
        const permission = checkPermission(store, user.id, "draft", row.matterId)
        if (!permission.allow) return false
        return rankOf(user.clearanceLevel) >= rankOf(row.classification)
      })
      .filter((row) => {
        if (!readiness) return true
        const artifact = artifactByPackage.get(row.id)
        if (!artifact) return readiness === "blocked"
        return artifact.readiness === readiness
      })
      .map((row) => ({
        ...row,
        packetArtifact: artifactByPackage.get(row.id) ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const items = visible.slice(cursor, cursor + limit)
    const nextCursor =
      cursor + items.length < visible.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view,
      items,
      total: visible.length,
      limit,
      cursor,
      nextCursor,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "filings read failed"
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
  if (!parsed.action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 })
  }

  const fingerprint = JSON.stringify({
    route: "/api/d4/filings",
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
    if (parsed.action === "create_package") {
      if (
        !parsed.actorId ||
        !parsed.matterId ||
        !parsed.draftId ||
        !isClassification(parsed.classification)
      ) {
        return NextResponse.json(
          { error: "actorId, matterId, draftId, and classification are required" },
          { status: 400 }
        )
      }
      const partnerOverride =
        parsed.partnerOverride?.partnerId || parsed.partnerOverride?.reason
          ? {
              partnerId: parsed.partnerOverride?.partnerId ?? "",
              reason: parsed.partnerOverride?.reason ?? "",
            }
          : undefined
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const priorAuditCount = store.audit.length
      const created = createFilingPackage(store, {
        actorId: parsed.actorId,
        matterId: parsed.matterId,
        draftId: parsed.draftId,
        preflight: {
          actorId: parsed.actorId,
          matterId: parsed.matterId,
          classification: parsed.classification,
          citedJudgmentIds: parsed.citedJudgmentIds ?? [],
          temporalCitations: parsed.temporalCitations ?? [],
          partnerOverride,
        },
      })
      await repos.filings.create(created.filingPackage)
      const draft =
        store.drafts.get(created.filingPackage.draftId) ??
        (await repos.drafts.get(created.filingPackage.draftId))
      const packetArtifact = buildFilingPacketArtifactRow(created.filingPackage, draft)
      await repos.filingPacketArtifacts.upsert(packetArtifact)
      store.filingPacketArtifacts.set(packetArtifact.id, packetArtifact)
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "create_package",
        filingPackage:
          (await repos.filings.get(created.filingPackage.id)) ?? created.filingPackage,
        packetArtifact: (await repos.filingPacketArtifacts.get(packetArtifact.id)) ?? packetArtifact,
        preflight: created.preflight,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "decide_package") {
      if (!parsed.actorId || !parsed.packageId || !parsed.decision || !parsed.reason) {
        return NextResponse.json(
          { error: "actorId, packageId, decision, and reason are required" },
          { status: 400 }
        )
      }
      const filingPackage = decideFilingPackage(store, {
        actorId: parsed.actorId,
        packageId: parsed.packageId,
        decision: parsed.decision,
        reason: parsed.reason,
      })
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const priorAuditCount = store.audit.length
      const persisted = await repos.filings.get(filingPackage.id)
      if (persisted) {
        await repos.filings.update(filingPackage.id, {
          status: filingPackage.status,
          approvedBy: filingPackage.approvedBy,
          approvalReason: filingPackage.approvalReason,
        })
      } else {
        await repos.filings.create(filingPackage)
      }
      const draft =
        store.drafts.get(filingPackage.draftId) ?? (await repos.drafts.get(filingPackage.draftId))
      const packetArtifact = buildFilingPacketArtifactRow(filingPackage, draft)
      await repos.filingPacketArtifacts.upsert(packetArtifact)
      store.filingPacketArtifacts.set(packetArtifact.id, packetArtifact)
      const dispatchQueueRow =
        filingPackage.status === "approved" ? buildFilingDispatchQueueRow(filingPackage) : null
      if (dispatchQueueRow) {
        await repos.filingDispatchQueue.upsert(dispatchQueueRow)
        store.filingDispatchQueue.set(dispatchQueueRow.id, dispatchQueueRow)
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "decide_package",
        filingPackage: (await repos.filings.get(filingPackage.id)) ?? filingPackage,
        packetArtifact: (await repos.filingPacketArtifacts.get(packetArtifact.id)) ?? packetArtifact,
        dispatchQueue:
          dispatchQueueRow &&
          ((await repos.filingDispatchQueue.get(dispatchQueueRow.id)) ?? dispatchQueueRow),
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "dispatch_update") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      if (parsed.nextStatus && !isFilingDispatchQueueStatus(parsed.nextStatus)) {
        return NextResponse.json({ error: "invalid dispatch status" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "associate", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "dispatch queue updates require partner, associate, or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm dispatch update denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      if (filingPackage.status !== "approved") {
        return NextResponse.json(
          { error: "dispatch queue can only be updated for approved filing packages" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const existing =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      if (parsed.assigneeId !== undefined && parsed.assigneeId !== null) {
        const assignee =
          store.users.get(parsed.assigneeId) ?? (await repos.users.get(parsed.assigneeId))
        if (!assignee || assignee.firmId !== actor.firmId) {
          return NextResponse.json({ error: "unknown assignee in actor firm" }, { status: 404 })
        }
      }
      const now = Date.now()
      const note = parsed.note?.trim()
      const nextStatus = parsed.nextStatus ?? existing.status
      const updated = {
        ...existing,
        status: nextStatus,
        assigneeId: parsed.assigneeId === undefined ? existing.assigneeId : parsed.assigneeId,
        retryCount: existing.retryCount + (parsed.markAttempt ? 1 : 0),
        lastAttemptAt: parsed.markAttempt ? now : existing.lastAttemptAt,
        operatorNotes: note
          ? [...existing.operatorNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`]
          : existing.operatorNotes,
        externalDispatchState:
          nextStatus === "handoff_ready" ? "ready_for_firm_dispatch" : "blocked_todo_firm",
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updated)
      store.filingDispatchQueue.set(updated.id, updated)
      store.audit.push({
        action: "filing_dispatch_update",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: parsed.note?.trim() || parsed.nextStatus || "dispatch queue update",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "dispatch_update",
        dispatchQueue: (await repos.filingDispatchQueue.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "filing package write failed"
    const status = /preflight blocked/.test(message) ? 422 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
