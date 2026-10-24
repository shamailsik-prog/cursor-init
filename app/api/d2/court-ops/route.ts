import { NextResponse } from "next/server"
import { parseLimit, parseCursor } from "@/platform/http/pagination"
import { fingerprintOf } from "@/platform/http/validation"
import { COURT_OPS_SURFACE } from "./surface"
import { PublicError } from "@/platform/http/publicError"
import { actionOf, getQuery, isAction, refuseUndeclaredBody } from "@/platform/http/surface"
import { withSession } from "@/platform/http/withSession"
import { withF02Authority } from "@/platform/authority/f02Gate"
import { F02_COURT_OPS } from "@/platform/authority/f02Routes"
import { REQUEST_FAILED_CODE, publicErrorMessage } from "@/platform/http/errors"
import {
  beginIdempotentRequest,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import type { WorkflowStatus } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMatters, syncFirmMembers } from "@/platform/persistence/memberSync"
import { buildCourtOpsActivityRow, buildWorkflowEventActivityRow } from "@/platform/persistence/workflowOpsActivity"
import { WHATSAPP_GRAMMAR_HELP, handleWhatsApp, whatsAppCommandName } from "@/services/d2-1/whatsapp"
import {
  CORPUS_UNAVAILABLE_CODE,
  CORPUS_UNAVAILABLE_MESSAGE,
  CorpusUnavailableError,
} from "@/services/d5-1/corpusUnavailable"
import {
  acknowledgeCourtOpsItem,
  listCourtOpsQueue,
  resolveFollowUp,
  resolveWorkflowBlocker,
} from "@/services/d2-2/courtOps"


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

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return (
    value === "queued" ||
    value === "processing" ||
    value === "review_required" ||
    value === "complete"
  )
}

async function syncCourtOpsState(
  store: ReturnType<typeof getRuntimeStore>,
  actorId: string
) {
  const repos = await getRuntimeRepositories(store)
  const actor = store.users.get(actorId)
  if (!actor) throw new PublicError("unknown actor")

  const firmDocs = await repos.documents.listByFirm(actor.firmId)
  for (const row of firmDocs) {
    store.documents.set(row.id, row)
  }

  // Audit F14 NEW-1: the shared member sync, which keeps a membership another request caches while this listing is in
  // flight (R5-D1), in place of this route's own copy that dropped every cached membership of the firm first.
  await syncFirmMembers(store, repos, actor.firmId)
  // Audit F14 R2-D1/R2-D2: the queue's matter gate and resolve_workflow's document check read each matter's current label.
  await syncFirmMatters(store, repos, actor.firmId)

  const firmFollowUps = await repos.followUps.listByFirm(actor.firmId)
  const mergedFollowUps = new Map<string, (typeof firmFollowUps)[number]>()
  for (const row of store.followUps) {
    if (row.firmId !== actor.firmId) continue
    mergedFollowUps.set(row.id, row)
  }
  for (const row of firmFollowUps) {
    mergedFollowUps.set(row.id, row)
  }
  store.followUps = [
    ...store.followUps.filter((row) => row.firmId !== actor.firmId),
    ...mergedFollowUps.values(),
  ]

  const firmWorkflow = await repos.workflow.listByFirm(actor.firmId)
  const mergedWorkflow = new Map<string, (typeof firmWorkflow)[number]>()
  for (const [key, row] of store.documentWorkflow.entries()) {
    if (row.firmId !== actor.firmId) continue
    mergedWorkflow.set(key, row)
  }
  for (const row of firmWorkflow) {
    mergedWorkflow.set(row.documentId, row)
  }
  for (const [key, row] of mergedWorkflow.entries()) {
    store.documentWorkflow.set(key, row)
  }

  return repos
}

async function persistWorkflowEventsSince(
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>,
  store: ReturnType<typeof getRuntimeStore>,
  startIndex: number,
  sourceAction: string
): Promise<void> {
  for (const event of store.workflowEvents.slice(startIndex)) {
    await repos.workflowEvents.append(event)
    await repos.workflowOpsActivity.upsert(
      buildWorkflowEventActivityRow(event, { sourceAction })
    )
  }
}

export async function GET(request: Request) {
  return withSession(request, handleGetAuthorised, { surface: COURT_OPS_SURFACE })
}

async function handleGet(request: Request) {
  const store = getRuntimeStore()
  const url = new URL(request.url)
  const userId = getQuery(COURT_OPS_SURFACE, url, "userId")
  const matterId = getQuery(COURT_OPS_SURFACE, url, "matterId") ?? undefined
  const limit = parseLimit(getQuery(COURT_OPS_SURFACE, url, "limit"))
  const cursor = parseCursor(getQuery(COURT_OPS_SURFACE, url, "cursor"))
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  try {
    await syncCourtOpsState(store, userId)
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
    const message = publicErrorMessage(err, "queue read failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}

const handleGetAuthorised = withF02Authority(F02_COURT_OPS, "GET", handleGet)

export async function POST(request: Request) {
  return withSession(request, handlePostAuthorised, { surface: COURT_OPS_SURFACE })
}

const handlePostAuthorised = withF02Authority(F02_COURT_OPS, "POST", handlePost)

async function handlePost(request: Request) {
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
  const undeclared = refuseUndeclaredBody(COURT_OPS_SURFACE, parsed)
  if (undeclared) return undeclared
  if (actionOf(COURT_OPS_SURFACE, parsed) === null) {
    return NextResponse.json({ error: "action is required" }, { status: 400 })
  }

  const fingerprint = fingerprintOf({
    route: "/api/d2/court-ops",
    action: actionOf(COURT_OPS_SURFACE, parsed),
    body: parsed,
  })
  // Final audit F4: check-and-reserve the key in one synchronous step (no await in between).
  const idem = await beginIdempotentRequest(request, key, fingerprint)
  if (idem.response) return idem.response
  const claim = idem.claim

  try {
    if (isAction(COURT_OPS_SURFACE, parsed, "whatsapp_command")) {
      if (!parsed.actorId || !parsed.command) {
        return NextResponse.json({ error: "actorId and command are required" }, { status: 400 })
      }
      await syncCourtOpsState(store, parsed.actorId)
      const command = whatsAppCommandName(parsed.command)
      if (!command) {
        return NextResponse.json({ error: WHATSAPP_GRAMMAR_HELP }, { status: 400 })
      }
      const text = parsed.command.trim()
      if (command === "ops") {
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
        claim.complete(payload)
        return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
      }
      const result = await handleWhatsApp(store, parsed.actorId, text)
      if (!result.ok) {
        return NextResponse.json({ error: "permission denied", result }, { status: 403 })
      }
      const payload = {
        action: "whatsapp_command",
        command: text,
        result,
      }
      claim.complete(payload)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (isAction(COURT_OPS_SURFACE, parsed, "acknowledge_item")) {
      if (!parsed.actorId || !parsed.queueType || !parsed.id) {
        return NextResponse.json(
          { error: "actorId, queueType, and id are required" },
          { status: 400 }
        )
      }
      const repos = await syncCourtOpsState(store, parsed.actorId)
      acknowledgeCourtOpsItem(store, {
        actorId: parsed.actorId,
        queueType: parsed.queueType,
        id: parsed.id,
        reason: parsed.reason,
      })
      const actor = store.users.get(parsed.actorId)
      if (!actor) throw new PublicError("unknown actor")
      await repos.workflowOpsActivity.upsert(
        buildCourtOpsActivityRow({
          id: `ops:court_ops:ack:${parsed.queueType}:${parsed.id}`,
          firmId: actor.firmId,
          action: "court_ops_acknowledge",
          actorId: actor.id,
          classification: "internal",
          matterId: null,
          documentId: parsed.queueType === "workflow" ? parsed.id : null,
          followUpId: parsed.queueType === "follow_up" ? parsed.id : null,
          queueType: parsed.queueType,
          status: "acknowledged",
          detail: parsed.reason ?? "acknowledged by operator",
        })
      )
      const payload = {
        action: "acknowledge_item",
        queueType: parsed.queueType,
        id: parsed.id,
      }
      claim.complete(payload)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (isAction(COURT_OPS_SURFACE, parsed, "resolve_follow_up")) {
      if (!parsed.actorId || !parsed.followUpId) {
        return NextResponse.json(
          { error: "actorId and followUpId are required" },
          { status: 400 }
        )
      }
      const repos = await syncCourtOpsState(store, parsed.actorId)
      resolveFollowUp(store, {
        actorId: parsed.actorId,
        followUpId: parsed.followUpId,
        reason: parsed.reason,
      })
      const updated = store.followUps.find((row) => row.id === parsed.followUpId)
      if (updated) {
        await repos.followUps.upsert(updated)
        await repos.workflowOpsActivity.upsert(
          buildCourtOpsActivityRow({
            id: `ops:court_ops:follow_up:${updated.id}`,
            firmId: updated.firmId,
            action: "court_ops_resolve_follow_up",
            actorId: parsed.actorId,
            classification: "internal",
            matterId: updated.matterId,
            documentId: null,
            followUpId: updated.id,
            queueType: "follow_up",
            status: updated.status ?? "resolved",
            detail: parsed.reason ?? updated.raw,
          })
        )
      }
      const payload = { action: "resolve_follow_up", followUpId: parsed.followUpId }
      claim.complete(payload)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (isAction(COURT_OPS_SURFACE, parsed, "resolve_workflow")) {
      if (!parsed.actorId || !parsed.documentId || !isWorkflowStatus(parsed.nextStatus)) {
        return NextResponse.json(
          { error: "actorId, documentId, and valid nextStatus are required" },
          { status: 400 }
        )
      }
      const repos = await syncCourtOpsState(store, parsed.actorId)
      const priorEvents = store.workflowEvents.length
      const row = resolveWorkflowBlocker(store, {
        actorId: parsed.actorId,
        documentId: parsed.documentId,
        nextStatus: parsed.nextStatus,
        reason: parsed.reason,
      })
      await repos.workflow.createOrUpdate(row)
      await persistWorkflowEventsSince(repos, store, priorEvents, "court_ops_resolve_workflow")
      const payload = { action: "resolve_workflow", row }
      claim.complete(payload)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    // FA-D5-003 (spec R10): research could not read its corpus. A 503, never an empty list; the reason stays in the log.
    // The idempotency claim is not completed, so the same key may retry once the corpus is back.
    if (err instanceof CorpusUnavailableError) {
      return NextResponse.json({ error: CORPUS_UNAVAILABLE_MESSAGE, code: CORPUS_UNAVAILABLE_CODE }, { status: 503 })
    }
    const message = publicErrorMessage(err, "court ops write failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}
