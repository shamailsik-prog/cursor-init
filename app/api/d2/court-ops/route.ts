import { NextResponse } from "next/server"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import type { WorkflowStatus } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { handleWhatsApp } from "@/services/d2-1/whatsapp"
import {
  acknowledgeCourtOpsItem,
  listCourtOpsQueue,
  resolveFollowUp,
  resolveWorkflowBlocker,
} from "@/services/d2-2/courtOps"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

type WhatsAppBody = {
  action: "whatsapp_command"
  actorId?: string
  command?: string
}

type AcknowledgeBody = {
  action: "acknowledge_item"
  actorId?: string
  queueType?: "follow_up" | "workflow"
  id?: string
  reason?: string
}

type ResolveFollowUpBody = {
  action: "resolve_follow_up"
  actorId?: string
  followUpId?: string
  reason?: string
}

type ResolveWorkflowBody = {
  action: "resolve_workflow"
  actorId?: string
  documentId?: string
  nextStatus?: WorkflowStatus
  reason?: string
}

type Body = WhatsAppBody | AcknowledgeBody | ResolveFollowUpBody | ResolveWorkflowBody

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

function validateWhatsAppCommand(command: string): boolean {
  const text = command.trim()
  return (
    /^\/matters$/i.test(text) ||
    /^\/research\s+.+/i.test(text) ||
    /^\/ops\s+queue$/i.test(text)
  )
}

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const url = new URL(request.url)
  const userId = url.searchParams.get("userId")
  const matterId = url.searchParams.get("matterId") ?? undefined
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  try {
    const queue = listCourtOpsQueue(store, userId, { matterId, limit, cursor })
    return NextResponse.json({
      view: "court_ops_queue",
      items: queue.items,
      total: queue.total,
      limit,
      cursor,
      nextCursor: queue.nextCursor,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "queue read failed"
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
    route: "/api/d2/court-ops",
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
    if (parsed.action === "whatsapp_command") {
      if (!parsed.actorId || !parsed.command) {
        return NextResponse.json({ error: "actorId and command are required" }, { status: 400 })
      }
      if (!validateWhatsAppCommand(parsed.command)) {
        return NextResponse.json(
          {
            error:
              "unsupported command grammar; allowed: /matters, /research <query>, /ops queue",
          },
          { status: 400 }
        )
      }
      const text = parsed.command.trim()
      if (/^\/ops\s+queue$/i.test(text)) {
        const queue = listCourtOpsQueue(store, parsed.actorId, {
          limit: 20,
          cursor: 0,
        })
        const payload = {
          action: "whatsapp_command",
          command: text,
          queueCount: queue.total,
          queuePreview: queue.items.slice(0, 5),
        }
        idempotency.set(key, payload, fingerprint)
        return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
      }
      const result = handleWhatsApp(store, parsed.actorId, text)
      if (!result.ok) {
        return NextResponse.json({ error: "permission denied", result }, { status: 403 })
      }
      const payload = {
        action: "whatsapp_command",
        command: text,
        result,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_item") {
      if (!parsed.actorId || !parsed.queueType || !parsed.id) {
        return NextResponse.json(
          { error: "actorId, queueType, and id are required" },
          { status: 400 }
        )
      }
      acknowledgeCourtOpsItem(store, {
        actorId: parsed.actorId,
        queueType: parsed.queueType,
        id: parsed.id,
        reason: parsed.reason,
      })
      const payload = {
        action: "acknowledge_item",
        queueType: parsed.queueType,
        id: parsed.id,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_follow_up") {
      if (!parsed.actorId || !parsed.followUpId) {
        return NextResponse.json(
          { error: "actorId and followUpId are required" },
          { status: 400 }
        )
      }
      resolveFollowUp(store, {
        actorId: parsed.actorId,
        followUpId: parsed.followUpId,
        reason: parsed.reason,
      })
      const payload = { action: "resolve_follow_up", followUpId: parsed.followUpId }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_workflow") {
      if (!parsed.actorId || !parsed.documentId || !isWorkflowStatus(parsed.nextStatus)) {
        return NextResponse.json(
          { error: "actorId, documentId, and valid nextStatus are required" },
          { status: 400 }
        )
      }
      const row = resolveWorkflowBlocker(store, {
        actorId: parsed.actorId,
        documentId: parsed.documentId,
        nextStatus: parsed.nextStatus,
        reason: parsed.reason,
      })
      const payload = { action: "resolve_workflow", row }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "court ops write failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
