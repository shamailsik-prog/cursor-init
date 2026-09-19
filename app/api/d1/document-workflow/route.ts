import { NextResponse } from "next/server"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import type { WorkflowStatus } from "@/platform/spine/store"
import {
  applyReviewDecision,
  assignReviewer,
  listWorkflowQueue,
  listWorkflowTimeline,
  transitionWorkflowStatus,
} from "@/services/d1-7/documentWorkflow"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

type TransitionBody = {
  action: "transition"
  actorId?: string
  documentId?: string
  nextStatus?: WorkflowStatus
  reason?: string
}

type AssignBody = {
  action: "assign_reviewer"
  actorId?: string
  documentId?: string
  reviewerId?: string
}

type DecisionBody = {
  action: "review_decision"
  actorId?: string
  documentId?: string
  decision?: "confirm_classification" | "declassify"
  nextClassification?: string
  reason?: string
}

type Body = TransitionBody | AssignBody | DecisionBody

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

export async function GET(request: Request) {
  const store = getRuntimeStore()
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
      const timeline = listWorkflowTimeline(store, userId, matterId, limit, cursor)
      return NextResponse.json({
        view: "timeline",
        items: timeline.items,
        total: timeline.total,
        limit,
        cursor,
        nextCursor: timeline.nextCursor,
      })
    }

    const rawStatus = url.searchParams.get("status")
    const status = isWorkflowStatus(rawStatus) ? rawStatus : undefined
    const queue = listWorkflowQueue(store, userId, {
      matterId,
      status,
      limit,
      cursor,
    })
    return NextResponse.json({
      view: "queue",
      items: queue.items,
      total: queue.total,
      limit,
      cursor,
      nextCursor: queue.nextCursor,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "workflow read failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function POST(request: Request) {
  const store = getRuntimeStore()
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
      const row = transitionWorkflowStatus(store, {
        actorId: parsed.actorId,
        documentId: parsed.documentId,
        nextStatus: parsed.nextStatus,
        reason: parsed.reason,
      })
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
      const row = assignReviewer(store, {
        actorId: parsed.actorId,
        documentId: parsed.documentId,
        reviewerId: parsed.reviewerId,
      })
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
      const row = applyReviewDecision(store, {
        actorId: parsed.actorId,
        documentId: parsed.documentId,
        decision: parsed.decision,
        nextClassification: parsed.nextClassification,
        reason: parsed.reason,
      })
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
