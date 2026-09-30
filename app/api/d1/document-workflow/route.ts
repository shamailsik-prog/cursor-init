import { NextResponse } from "next/server"
import { z } from "zod"
import { classificationField, idField, parseBody } from "@/platform/http/validation"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { type Classification } from "@/platform/p1/types"
import { rankOf, type DocumentRecord, type SpineStore } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import type { WorkflowStatus } from "@/platform/spine/store"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { persistAuditEntriesSince } from "@/platform/persistence/auditWriteThrough"
import { buildWorkflowEventActivityRow } from "@/platform/persistence/workflowOpsActivity"
import {
  applyReviewDecision,
  assignReviewer,
  transitionWorkflowStatus,
} from "@/services/d1-7/documentWorkflow"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("transition"),
    actorId: idField,
    documentId: idField,
    nextStatus: z.enum(["queued", "processing", "review_required", "complete"]),
    reason: z.string().max(2000).optional(),
  }),
  z.object({
    action: z.literal("assign_reviewer"),
    actorId: idField,
    documentId: idField,
    reviewerId: idField,
  }),
  z.object({
    action: z.literal("review_decision"),
    actorId: idField,
    documentId: idField,
    decision: z.enum(["confirm_classification", "declassify"]),
    nextClassification: classificationField.optional(),
    reason: z.string().max(2000).optional(),
  }),
])

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

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return (
    value === "queued" ||
    value === "processing" ||
    value === "review_required" ||
    value === "complete"
  )
}

function canViewWorkflowDocument(
  store: SpineStore,
  userId: string,
  doc: Pick<DocumentRecord, "firmId" | "classification" | "matterId">
): boolean {
  const user = store.users.get(userId)
  if (!user) return false
  if (user.firmId !== doc.firmId) return false
  if (rankOf(user.clearanceLevel) < rankOf(doc.classification)) return false
  if (doc.matterId) return store.members.has(store.memberKey(doc.matterId, userId))
  return user.role !== "client" && user.role !== "intern"
}

async function persistWorkflowEventsSince(
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>,
  store: SpineStore,
  startIndex: number,
  sourceAction?: string
): Promise<void> {
  const newEvents = store.workflowEvents.slice(startIndex)
  for (const event of newEvents) {
    await repos.workflowEvents.append(event)
    await repos.workflowOpsActivity.upsert(
      buildWorkflowEventActivityRow(event, { sourceAction })
    )
  }
}

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = url.searchParams.get("view") ?? "queue"
  const userId = url.searchParams.get("userId")
  const matterId = url.searchParams.get("matterId") ?? undefined
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))

  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }

  try {
    if (view === "timeline") {
      if (!matterId) {
        return NextResponse.json({ error: "matterId is required for timeline view" }, { status: 400 })
      }
      const user = store.users.get(userId)
      if (!user) throw new Error("unknown user")
      await syncFirmMembers(store, repos, user.firmId)
      const matter = store.matters.get(matterId)
      if (!matter) throw new Error("unknown matter")
      if (matter.firmId !== user.firmId) throw new Error("cross-firm matter denied")
      if (!store.members.has(store.memberKey(matterId, user.id))) {
        throw new Error("not a matter member")
      }
      const timelineRows = (await repos.workflowEvents.listByFirm(user.firmId))
        .filter((event) => event.matterId === matterId)
        .sort((a, b) => a.at - b.at)
      const paged = timelineRows.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + paged.length < timelineRows.length ? String(cursor + paged.length) : null
      return NextResponse.json({
        view: "timeline",
        items: paged.map((event) => ({
          id: event.id,
          documentId: event.documentId,
          action: event.action,
          status: event.status,
          classification: event.classification,
          actorId: event.actorId,
          reason: event.reason,
          at: event.at,
        })),
        total: timelineRows.length,
        limit,
        cursor,
        nextCursor,
      })
    }

    const rawStatus = url.searchParams.get("status")
    const status = isWorkflowStatus(rawStatus) ? rawStatus : undefined
    const user = store.users.get(userId)
    if (!user) throw new Error("unknown user")
    await syncFirmMembers(store, repos, user.firmId)
    const docs = await repos.documents.listByFirm(user.firmId)
    const rows = await repos.workflow.listByFirm(user.firmId)
    const rowsByDocId = new Map(rows.map((row) => [row.documentId, row]))
    const queueItems = docs
      .filter((doc) => (matterId ? doc.matterId === matterId : true))
      .filter((doc) => canViewWorkflowDocument(store, userId, doc))
      .map((doc) => {
        const row = rowsByDocId.get(doc.id) ??
          store.documentWorkflow.get(doc.id) ?? {
            documentId: doc.id,
            firmId: doc.firmId,
            matterId: doc.matterId,
            status: "queued" as WorkflowStatus,
            reviewerId: null,
            updatedAt: 0,
          }
        return {
          documentId: doc.id,
          matterId: doc.matterId,
          status: row.status,
          reviewerId: row.reviewerId,
          classification: doc.classification as Classification,
          updatedAt: row.updatedAt,
        }
      })
      .filter((row) => (status ? row.status === status : true))
      .sort((a, b) => a.updatedAt - b.updatedAt)
    const items = queueItems.slice(cursor, cursor + limit)
    const nextCursor =
      cursor + items.length < queueItems.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "queue",
      items,
      total: queueItems.length,
      limit,
      cursor,
      nextCursor,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "workflow read failed"
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

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body", code: "invalid_request" }, { status: 400 })
  }
  const body = parseBody(BodySchema, raw)
  if (!body.ok) return body.response
  const parsed: Body = body.data

  const fingerprint = JSON.stringify({
    route: "/api/d1/document-workflow",
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
    if (parsed.action === "transition") {
      if (!parsed.actorId || !parsed.documentId || !isWorkflowStatus(parsed.nextStatus)) {
        return NextResponse.json(
          { error: "actorId, documentId, and valid nextStatus are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) throw new Error("unknown actor")
      await syncFirmMembers(store, repos, actor.firmId)
      const priorAuditCount = store.audit.length
      const priorEvents = store.workflowEvents.length
      const row = transitionWorkflowStatus(store, {
        actorId: parsed.actorId,
        documentId: parsed.documentId,
        nextStatus: parsed.nextStatus,
        reason: parsed.reason,
      })
      await repos.workflow.createOrUpdate(row)
      await persistWorkflowEventsSince(repos, store, priorEvents, "workflow_transition")
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = { action: "transition", row }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_reviewer") {
      if (!parsed.actorId || !parsed.documentId || !parsed.reviewerId) {
        return NextResponse.json(
          { error: "actorId, documentId, and reviewerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) throw new Error("unknown actor")
      await syncFirmMembers(store, repos, actor.firmId)
      const priorAuditCount = store.audit.length
      const priorEvents = store.workflowEvents.length
      const row = assignReviewer(store, {
        actorId: parsed.actorId,
        documentId: parsed.documentId,
        reviewerId: parsed.reviewerId,
      })
      await repos.workflow.createOrUpdate(row)
      await persistWorkflowEventsSince(repos, store, priorEvents, "workflow_assign_reviewer")
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = { action: "assign_reviewer", row }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "review_decision") {
      if (!parsed.actorId || !parsed.documentId || !parsed.decision) {
        return NextResponse.json(
          { error: "actorId, documentId, and decision are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) throw new Error("unknown actor")
      await syncFirmMembers(store, repos, actor.firmId)
      const priorAuditCount = store.audit.length
      const priorEvents = store.workflowEvents.length
      const row = applyReviewDecision(store, {
        actorId: parsed.actorId,
        documentId: parsed.documentId,
        decision: parsed.decision,
        nextClassification: parsed.nextClassification,
        reason: parsed.reason,
      })
      await repos.workflow.createOrUpdate(row)
      await persistWorkflowEventsSince(repos, store, priorEvents, "workflow_review_decision")
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const updatedDoc = store.documents.get(parsed.documentId)
      if (updatedDoc) {
        const persistedDoc = await repos.documents.get(updatedDoc.id)
        if (persistedDoc) {
          await repos.documents.update(updatedDoc.id, {
            classification: updatedDoc.classification,
            matterId: updatedDoc.matterId,
            sourceChannel: updatedDoc.sourceChannel,
            contentHash: updatedDoc.contentHash,
          })
        } else {
          await repos.documents.create(updatedDoc)
        }
      }
      const payload = { action: "review_decision", row }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "workflow write failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
