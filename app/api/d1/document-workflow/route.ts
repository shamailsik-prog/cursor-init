import { NextResponse } from "next/server"
import { parseLimit, parseCursor } from "@/platform/http/pagination"
import { fingerprintOf } from "@/platform/http/validation"
import { BodySchema, DOCUMENT_WORKFLOW_SURFACE } from "./surface"
import { canReadDocument } from "@/platform/p5/documentAccess"
import { z } from "zod"
import { DEFAULT_JSON_BODY_BYTES, parseBody, readJsonLimited } from "@/platform/http/validation"
import { PublicError } from "@/platform/http/publicError"
import { actionOf, getQuery, isAction, refuseUndeclaredBody, selectView } from "@/platform/http/surface"
import { withSession } from "@/platform/http/withSession"
import { REQUEST_FAILED_CODE, publicErrorMessage } from "@/platform/http/errors"
import {
  beginIdempotentRequest,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { type Classification } from "@/platform/p1/types"
import { type DocumentRecord, type SpineStore } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import type { WorkflowStatus } from "@/platform/spine/store"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { buildWorkflowEventActivityRow } from "@/platform/persistence/workflowOpsActivity"
import {
  applyReviewDecision,
  assignReviewer,
  transitionWorkflowStatus,
} from "@/services/d1-7/documentWorkflow"



type Body = z.infer<typeof BodySchema>

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
  return canReadDocument(store, user, doc)
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
  return withSession(request, handleGet, { surface: DOCUMENT_WORKFLOW_SURFACE })
}

async function handleGet(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = selectView(DOCUMENT_WORKFLOW_SURFACE, url)
  const userId = getQuery(DOCUMENT_WORKFLOW_SURFACE, url, "userId")
  const matterId = getQuery(DOCUMENT_WORKFLOW_SURFACE, url, "matterId") ?? undefined
  const limit = parseLimit(getQuery(DOCUMENT_WORKFLOW_SURFACE, url, "limit"))
  const cursor = parseCursor(getQuery(DOCUMENT_WORKFLOW_SURFACE, url, "cursor"))

  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }

  try {
    if (view === "timeline") {
      if (!matterId) {
        return NextResponse.json({ error: "matterId is required for timeline view" }, { status: 400 })
      }
      const user = store.users.get(userId)
      if (!user) throw new PublicError("unknown user")
      await syncFirmMembers(store, repos, user.firmId)
      const matter = store.matters.get(matterId)
      if (!matter) throw new PublicError("unknown matter")
      if (matter.firmId !== user.firmId) throw new PublicError("cross-firm matter denied")
      if (!store.members.has(store.memberKey(matterId, user.id))) {
        throw new PublicError("not a matter member")
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

    const rawStatus = getQuery(DOCUMENT_WORKFLOW_SURFACE, url, "status")
    const status = isWorkflowStatus(rawStatus) ? rawStatus : undefined
    const user = store.users.get(userId)
    if (!user) throw new PublicError("unknown user")
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
    const message = publicErrorMessage(err, "workflow read failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}

export async function POST(request: Request) {
  return withSession(request, handlePost, { maxBodyBytes: DEFAULT_JSON_BODY_BYTES, surface: DOCUMENT_WORKFLOW_SURFACE })
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
  const undeclared = refuseUndeclaredBody(DOCUMENT_WORKFLOW_SURFACE, raw.data)
  if (undeclared) return undeclared
  const body = parseBody(BodySchema, raw.data)
  if (!body.ok) return body.response
  const parsed: Body = body.data

  const fingerprint = fingerprintOf({
    route: "/api/d1/document-workflow",
    action: actionOf(DOCUMENT_WORKFLOW_SURFACE, parsed),
    body: parsed,
  })
  // Final audit F4: check-and-reserve the key in one synchronous step (no await in between).
  const idem = beginIdempotentRequest(request, key, fingerprint)
  if (idem.response) return idem.response
  const claim = idem.claim

  try {
    if (isAction(DOCUMENT_WORKFLOW_SURFACE, parsed, "transition")) {
      if (!parsed.actorId || !parsed.documentId || !isWorkflowStatus(parsed.nextStatus)) {
        return NextResponse.json(
          { error: "actorId, documentId, and valid nextStatus are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) throw new PublicError("unknown actor")
      await syncFirmMembers(store, repos, actor.firmId)
      const priorEvents = store.workflowEvents.length
      const row = transitionWorkflowStatus(store, {
        actorId: parsed.actorId,
        documentId: parsed.documentId,
        nextStatus: parsed.nextStatus,
        reason: parsed.reason,
      })
      await repos.workflow.createOrUpdate(row)
      await persistWorkflowEventsSince(repos, store, priorEvents, "workflow_transition")
      const payload = { action: "transition", row }
      claim.complete(payload)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (isAction(DOCUMENT_WORKFLOW_SURFACE, parsed, "assign_reviewer")) {
      if (!parsed.actorId || !parsed.documentId || !parsed.reviewerId) {
        return NextResponse.json(
          { error: "actorId, documentId, and reviewerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) throw new PublicError("unknown actor")
      await syncFirmMembers(store, repos, actor.firmId)
      const priorEvents = store.workflowEvents.length
      const row = assignReviewer(store, {
        actorId: parsed.actorId,
        documentId: parsed.documentId,
        reviewerId: parsed.reviewerId,
      })
      await repos.workflow.createOrUpdate(row)
      await persistWorkflowEventsSince(repos, store, priorEvents, "workflow_assign_reviewer")
      const payload = { action: "assign_reviewer", row }
      claim.complete(payload)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (isAction(DOCUMENT_WORKFLOW_SURFACE, parsed, "review_decision")) {
      if (!parsed.actorId || !parsed.documentId || !parsed.decision) {
        return NextResponse.json(
          { error: "actorId, documentId, and decision are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) throw new PublicError("unknown actor")
      await syncFirmMembers(store, repos, actor.firmId)
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
      claim.complete(payload)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    const message = publicErrorMessage(err, "workflow write failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}
