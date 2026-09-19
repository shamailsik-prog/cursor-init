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
import {
  annexureReadyForTransport,
  buildFilingAnnexureRow,
  filingAnnexureId,
  isFilingAnnexureGenerationStatus,
} from "@/platform/persistence/filingAnnexures"
import {
  buildFilingSubmissionReceiptRow,
  buildFilingSubmissionReconciliationRow,
  filingSubmissionReconciliationId,
  isFilingSubmissionCourtChannel,
  isFilingSubmissionDispatchOutcome,
  isFilingSubmissionReconciliationStatus,
} from "@/platform/persistence/filingSubmissionReceipts"
import {
  buildSubmissionExceptionRowFromFailure,
  filingSubmissionExceptionId,
  isFilingSubmissionExceptionSeverity,
  isFilingSubmissionExceptionStatus,
} from "@/platform/persistence/filingSubmissionExceptions"
import {
  buildFilingTransportExecutionEvidenceRow,
  isFilingTransportExecutionChannel,
  isFilingTransportExecutionOutcome,
} from "@/platform/persistence/filingTransportExecutionEvidence"
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

type AnnexureCheckpointBody = {
  action: "annexure_checkpoint"
  actorId?: string
  packageId?: string
  checkpoint?:
    | "mark_assembling"
    | "mark_artifact_ready"
    | "record_partner_signoff"
    | "record_clerk_verification"
    | "mark_ready_for_transport"
  artifactId?: string
  note?: string
}

type RecordSubmissionReceiptBody = {
  action: "record_submission_receipt"
  actorId?: string
  packageId?: string
  courtChannel?: "efiling_portal_stub" | "physical_counter_stub" | "courier_stub"
  dispatchOutcome?: "accepted" | "rejected" | "retry_scheduled"
  submissionReference?: string
  failureReason?: string
  retryHint?: string
  note?: string
}

type ReconcileSubmissionBody = {
  action: "reconcile_submission"
  actorId?: string
  packageId?: string
  status?: "open" | "reconciled" | "needs_retry"
  note?: string
}

type ClaimSubmissionExceptionBody = {
  action: "claim_submission_exception"
  actorId?: string
  packageId?: string
  note?: string
}

type EscalateSubmissionExceptionBody = {
  action: "escalate_submission_exception"
  actorId?: string
  packageId?: string
  escalationOwnerId?: string
  severity?: "medium" | "high" | "critical"
  slaHours?: number
  note?: string
}

type ResolveSubmissionExceptionBody = {
  action: "resolve_submission_exception"
  actorId?: string
  packageId?: string
  note?: string
}

type ReopenSubmissionExceptionBody = {
  action: "reopen_submission_exception"
  actorId?: string
  packageId?: string
  severity?: "medium" | "high" | "critical"
  note?: string
}

type MarkTransportBlockedBody = {
  action: "mark_transport_blocked"
  actorId?: string
  packageId?: string
  transportChannel?:
    | "efiling_portal_stub"
    | "physical_counter_stub"
    | "courier_stub"
    | "operator_followup_stub"
  channelPayloadHash?: string
  blockerTags?: string[]
  attachmentPointers?: string[]
  severity?: "medium" | "high" | "critical"
  note?: string
}

type AttachRetryPlanBody = {
  action: "attach_retry_plan"
  actorId?: string
  packageId?: string
  transportChannel?:
    | "efiling_portal_stub"
    | "physical_counter_stub"
    | "courier_stub"
    | "operator_followup_stub"
  channelPayloadHash?: string
  attachmentPointers?: string[]
  note?: string
}

type ConfirmDeliveredBody = {
  action: "confirm_delivered"
  actorId?: string
  packageId?: string
  transportChannel?:
    | "efiling_portal_stub"
    | "physical_counter_stub"
    | "courier_stub"
    | "operator_followup_stub"
  channelPayloadHash?: string
  attachmentPointers?: string[]
  relatedReceiptId?: string
  note?: string
}

type Body =
  | CreateBody
  | DecideBody
  | DispatchUpdateBody
  | AnnexureCheckpointBody
  | RecordSubmissionReceiptBody
  | ReconcileSubmissionBody
  | ClaimSubmissionExceptionBody
  | EscalateSubmissionExceptionBody
  | ResolveSubmissionExceptionBody
  | ReopenSubmissionExceptionBody
  | MarkTransportBlockedBody
  | AttachRetryPlanBody
  | ConfirmDeliveredBody

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

function parseFilingsView(
  value: string | null
):
  | "packages"
  | "dispatch"
  | "annexures"
  | "submission_receipts"
  | "submission_reconciliation"
  | "submission_exceptions"
  | "transport_execution" {
  if (value === "dispatch") return "dispatch"
  if (value === "annexures") return "annexures"
  if (value === "submission_receipts") return "submission_receipts"
  if (value === "submission_reconciliation") return "submission_reconciliation"
  if (value === "submission_exceptions") return "submission_exceptions"
  if (value === "transport_execution") return "transport_execution"
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
    const queueRows = await repos.filingDispatchQueue.listByFirm(user.firmId)
    const queueByPackage = new Map(queueRows.map((row) => [row.packageId, row]))
    for (const filingPackage of firmPackages) {
      if (filingPackage.status !== "approved" || queueByPackage.has(filingPackage.id)) continue
      const queueRow = buildFilingDispatchQueueRow(filingPackage)
      await repos.filingDispatchQueue.upsert(queueRow)
      store.filingDispatchQueue.set(queueRow.id, queueRow)
      queueByPackage.set(filingPackage.id, queueRow)
    }
    if (view === "dispatch") {
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
    if (view === "annexures") {
      const annexureStatus = url.searchParams.get("annexureStatus")
      const packageId = url.searchParams.get("packageId")
      const annexureRows = await repos.filingAnnexures.listByFirm(user.firmId)
      const annexureByPackage = new Map(annexureRows.map((row) => [row.packageId, row]))
      for (const filingPackage of firmPackages) {
        if (filingPackage.status !== "approved" || annexureByPackage.has(filingPackage.id)) continue
        const queueRow = queueByPackage.get(filingPackage.id) ?? null
        if (!queueRow || queueRow.status === "blocked") continue
        const annexure = buildFilingAnnexureRow(filingPackage, queueRow)
        await repos.filingAnnexures.upsert(annexure)
        store.filingAnnexures.set(annexure.id, annexure)
        annexureByPackage.set(filingPackage.id, annexure)
      }
      const visible = [...annexureByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .filter((row) => {
          if (!annexureStatus || !isFilingAnnexureGenerationStatus(annexureStatus)) return true
          return row.generationStatus === annexureStatus
        })
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
    if (view === "submission_receipts") {
      const packageId = url.searchParams.get("packageId")
      const dispatchOutcome = url.searchParams.get("dispatchOutcome")
      const receiptRows = await repos.filingSubmissionReceipts.listByFirm(user.firmId)
      const visible = receiptRows
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!dispatchOutcome || !isFilingSubmissionDispatchOutcome(dispatchOutcome)) return true
          return row.dispatchOutcome === dispatchOutcome
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.recordedAt - a.recordedAt || a.id.localeCompare(b.id))
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
    if (view === "submission_reconciliation") {
      const packageId = url.searchParams.get("packageId")
      const reconciliationStatus = url.searchParams.get("reconciliationStatus")
      const annexureRows = await repos.filingAnnexures.listByFirm(user.firmId)
      const readyAnnexureByPackage = new Map(
        annexureRows
          .filter((row) => row.generationStatus === "ready")
          .map((row) => [row.packageId, row])
      )
      const receiptRows = await repos.filingSubmissionReceipts.listByFirm(user.firmId)
      const receiptsByPackage = new Map<string, typeof receiptRows>()
      for (const receipt of receiptRows) {
        const current = receiptsByPackage.get(receipt.packageId) ?? []
        current.push(receipt)
        receiptsByPackage.set(receipt.packageId, current)
      }
      const persistedRows = await repos.filingSubmissionReconciliation.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      for (const filingPackage of firmPackages) {
        if (filingPackage.status !== "approved") continue
        if (!readyAnnexureByPackage.has(filingPackage.id)) continue
        const receipts = receiptsByPackage.get(filingPackage.id) ?? []
        const existing = rowsByPackage.get(filingPackage.id)
        const computed = buildFilingSubmissionReconciliationRow(filingPackage, receipts, {
          notes: existing?.notes ?? [],
        })
        const hasNewAttempt =
          !existing ||
          existing.totalAttempts !== computed.totalAttempts ||
          existing.latestReceiptId !== computed.latestReceiptId
        const changed =
          !existing ||
          existing.totalAttempts !== computed.totalAttempts ||
          existing.latestReceiptId !== computed.latestReceiptId ||
          existing.latestSubmissionReference !== computed.latestSubmissionReference ||
          existing.latestDispatchOutcome !== computed.latestDispatchOutcome
        const next = changed
          ? existing
            ? {
                ...computed,
                status: hasNewAttempt ? computed.status : existing.status,
                notes: existing.notes,
                updatedAt: Date.now(),
              }
            : computed
          : existing
        if (changed || !existing) {
          await repos.filingSubmissionReconciliation.upsert(next)
        }
        store.filingSubmissionReconciliation.set(next.id, next)
        rowsByPackage.set(filingPackage.id, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (
            !reconciliationStatus ||
            !isFilingSubmissionReconciliationStatus(reconciliationStatus)
          ) {
            return true
          }
          return row.status === reconciliationStatus
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
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
    if (view === "submission_exceptions") {
      const packageId = url.searchParams.get("packageId")
      const exceptionStatus = url.searchParams.get("exceptionStatus")
      const severity = url.searchParams.get("severity")
      const escalationOwnerId = url.searchParams.get("escalationOwnerId")
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const persistedRows = await repos.filingSubmissionExceptions.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const receiptRows = await repos.filingSubmissionReceipts.listByFirm(user.firmId)
      const receiptById = new Map(receiptRows.map((row) => [row.id, row]))
      const latestFailingReceiptByPackage = new Map<string, (typeof receiptRows)[number]>()
      for (const row of receiptRows) {
        if (row.dispatchOutcome === "accepted") continue
        const current = latestFailingReceiptByPackage.get(row.packageId)
        if (!current || row.attemptNo > current.attemptNo) {
          latestFailingReceiptByPackage.set(row.packageId, row)
        }
      }
      const reconciliationRows = await repos.filingSubmissionReconciliation.listByFirm(user.firmId)
      const needsRetryReconciliationByPackage = new Map(
        reconciliationRows
          .filter((row) => row.status === "needs_retry")
          .map((row) => [row.packageId, row])
      )
      for (const [pkgId, reconciliation] of needsRetryReconciliationByPackage.entries()) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const linkedReceipt =
          (reconciliation.latestReceiptId && receiptById.get(reconciliation.latestReceiptId)) ?? null
        const next = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source: "reconciliation_needs_retry",
            receipt: linkedReceipt,
            reconciliation,
            actorId: "system_sync",
            now: reconciliation.updatedAt,
          },
          existing
        )
        const changed =
          !existing ||
          existing.source !== next.source ||
          existing.latestReceiptId !== next.latestReceiptId ||
          existing.latestReconciliationId !== next.latestReconciliationId ||
          existing.lastRaisedAt !== next.lastRaisedAt ||
          existing.status === "resolved"
        if (changed) {
          await repos.filingSubmissionExceptions.upsert(next)
        }
        store.filingSubmissionExceptions.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      for (const [pkgId, receipt] of latestFailingReceiptByPackage.entries()) {
        if (needsRetryReconciliationByPackage.has(pkgId)) continue
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const source =
          receipt.dispatchOutcome === "rejected"
            ? ("receipt_rejected" as const)
            : ("receipt_retry_scheduled" as const)
        const next = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source,
            receipt,
            reconciliation: null,
            actorId: "system_sync",
            now: receipt.recordedAt,
          },
          existing
        )
        const changed =
          !existing ||
          existing.source !== next.source ||
          existing.latestReceiptId !== next.latestReceiptId ||
          existing.lastRaisedAt !== next.lastRaisedAt ||
          existing.status === "resolved"
        if (changed) {
          await repos.filingSubmissionExceptions.upsert(next)
        }
        store.filingSubmissionExceptions.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingSubmissionExceptionStatus(exceptionStatus)) return true
          return row.status === exceptionStatus
        })
        .filter((row) => {
          if (!isFilingSubmissionExceptionSeverity(severity)) return true
          return row.severity === severity
        })
        .filter((row) => (escalationOwnerId ? row.escalationOwnerId === escalationOwnerId : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => a.slaTargetAt - b.slaTargetAt || b.updatedAt - a.updatedAt)
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
    if (view === "transport_execution") {
      const packageId = url.searchParams.get("packageId")
      const outcome = url.searchParams.get("outcome")
      const blockerTag = url.searchParams.get("blockerTag")?.trim().toLowerCase()
      const rows = await repos.filingTransportExecutionEvidence.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingTransportExecutionOutcome(outcome)) return true
          return row.outcome === outcome
        })
        .filter((row) => {
          if (!blockerTag) return true
          return row.deterministicBlockerTags.includes(blockerTag)
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
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
      const annexureRow =
        dispatchQueueRow && dispatchQueueRow.status !== "blocked"
          ? buildFilingAnnexureRow(filingPackage, dispatchQueueRow)
          : null
      if (dispatchQueueRow) {
        await repos.filingDispatchQueue.upsert(dispatchQueueRow)
        store.filingDispatchQueue.set(dispatchQueueRow.id, dispatchQueueRow)
      }
      if (annexureRow) {
        await repos.filingAnnexures.upsert(annexureRow)
        store.filingAnnexures.set(annexureRow.id, annexureRow)
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "decide_package",
        filingPackage: (await repos.filings.get(filingPackage.id)) ?? filingPackage,
        packetArtifact: (await repos.filingPacketArtifacts.get(packetArtifact.id)) ?? packetArtifact,
        dispatchQueue:
          dispatchQueueRow &&
          ((await repos.filingDispatchQueue.get(dispatchQueueRow.id)) ?? dispatchQueueRow),
        annexure: annexureRow && ((await repos.filingAnnexures.get(annexureRow.id)) ?? annexureRow),
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
      const existingAnnexure =
        (await repos.filingAnnexures.get(filingAnnexureId(filingPackage.id))) ??
        buildFilingAnnexureRow(filingPackage, updated)
      const annexure = {
        ...existingAnnexure,
        generationStatus:
          nextStatus === "blocked"
            ? ("blocked" as const)
            : existingAnnexure.generationStatus === "blocked"
              ? ("pending" as const)
              : existingAnnexure.generationStatus,
        operatorNotes:
          nextStatus === "blocked"
            ? [...existingAnnexure.operatorNotes, "dispatch queue moved to blocked status"]
            : existingAnnexure.operatorNotes,
        updatedAt: now,
      }
      await repos.filingAnnexures.upsert(annexure)
      store.filingAnnexures.set(annexure.id, annexure)
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
        annexure: (await repos.filingAnnexures.get(annexure.id)) ?? annexure,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "annexure_checkpoint") {
      if (!parsed.actorId || !parsed.packageId || !parsed.checkpoint) {
        return NextResponse.json(
          { error: "actorId, packageId, and checkpoint are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "associate", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "annexure checkpoints require partner, associate, or clerk role" },
          { status: 403 }
        )
      }
      if (parsed.checkpoint === "record_partner_signoff" && actor.role !== "partner") {
        return NextResponse.json({ error: "partner role required for partner signoff checkpoint" }, { status: 403 })
      }
      if (parsed.checkpoint === "record_clerk_verification" && !["clerk", "partner"].includes(actor.role)) {
        return NextResponse.json({ error: "clerk or partner role required for clerk verification checkpoint" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm annexure checkpoint denied" }, { status: 403 })
      }
      if (filingPackage.status !== "approved") {
        return NextResponse.json(
          { error: "annexure checkpoints require approved filing package" },
          { status: 422 }
        )
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const persistedQueue = await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))
      const queueRow = persistedQueue ?? buildFilingDispatchQueueRow(filingPackage)
      if (!persistedQueue) {
        await repos.filingDispatchQueue.upsert(queueRow)
        store.filingDispatchQueue.set(queueRow.id, queueRow)
      }
      if (queueRow.status === "blocked") {
        return NextResponse.json(
          { error: "annexure checkpoints require non-blocked dispatch queue state" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const existing =
        (await repos.filingAnnexures.get(filingAnnexureId(filingPackage.id))) ??
        buildFilingAnnexureRow(filingPackage, queueRow)
      const now = Date.now()
      const trimmedNote = parsed.note?.trim()
      const nextManifest = [...existing.manifest]
      let generationStatus = existing.generationStatus
      const signerRequirements = { ...existing.signerRequirements }
      if (parsed.checkpoint === "mark_assembling") {
        generationStatus = "assembling"
      } else if (parsed.checkpoint === "mark_artifact_ready") {
        if (!parsed.artifactId) {
          return NextResponse.json({ error: "artifactId is required for mark_artifact_ready" }, { status: 400 })
        }
        const idx = nextManifest.findIndex((item) => item.artifactId === parsed.artifactId)
        if (idx < 0) {
          return NextResponse.json({ error: "unknown annexure artifactId" }, { status: 404 })
        }
        const { note: _ignoredNote, ...withoutNote } = nextManifest[idx]
        nextManifest[idx] = { ...withoutNote, status: "ready" }
      } else if (parsed.checkpoint === "record_partner_signoff") {
        signerRequirements.partnerSignoffBy = actor.id
        signerRequirements.partnerSignoffAt = now
      } else if (parsed.checkpoint === "record_clerk_verification") {
        signerRequirements.clerkVerificationBy = actor.id
        signerRequirements.clerkVerificationAt = now
      } else if (parsed.checkpoint === "mark_ready_for_transport") {
        const candidate = {
          ...existing,
          manifest: nextManifest,
          signerRequirements,
        }
        if (!annexureReadyForTransport(candidate)) {
          return NextResponse.json(
            { error: "annexure is not ready: required artifacts/signoffs missing" },
            { status: 422 }
          )
        }
        generationStatus = "ready"
      }
      const checkpointNote = trimmedNote
        ? `${new Date(now).toISOString()} ${actor.id}: ${parsed.checkpoint} (${trimmedNote})`
        : `${new Date(now).toISOString()} ${actor.id}: ${parsed.checkpoint}`
      const updated = {
        ...existing,
        generationStatus,
        manifest: nextManifest,
        signerRequirements,
        operatorNotes: [...existing.operatorNotes, checkpointNote],
        submissionTransportBoundary: "todo_firm_external_transport_blocked" as const,
        updatedAt: now,
      }
      await repos.filingAnnexures.upsert(updated)
      store.filingAnnexures.set(updated.id, updated)
      store.audit.push({
        action: "filing_annexure_checkpoint",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: parsed.checkpoint,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "annexure_checkpoint",
        annexure: (await repos.filingAnnexures.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "record_submission_receipt") {
      if (
        !parsed.actorId ||
        !parsed.packageId ||
        !parsed.courtChannel ||
        !parsed.dispatchOutcome ||
        !parsed.submissionReference
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, packageId, courtChannel, dispatchOutcome, and submissionReference are required",
          },
          { status: 400 }
        )
      }
      if (!isFilingSubmissionCourtChannel(parsed.courtChannel)) {
        return NextResponse.json({ error: "invalid courtChannel" }, { status: 400 })
      }
      if (!isFilingSubmissionDispatchOutcome(parsed.dispatchOutcome)) {
        return NextResponse.json({ error: "invalid dispatchOutcome" }, { status: 400 })
      }
      if (parsed.dispatchOutcome === "rejected" && !parsed.failureReason?.trim()) {
        return NextResponse.json(
          { error: "failureReason is required when dispatchOutcome is rejected" },
          { status: 400 }
        )
      }
      if (parsed.dispatchOutcome === "retry_scheduled" && !parsed.retryHint?.trim()) {
        return NextResponse.json(
          { error: "retryHint is required when dispatchOutcome is retry_scheduled" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "record_submission_receipt requires partner or clerk role" },
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
        return NextResponse.json({ error: "cross-firm receipt record denied" }, { status: 403 })
      }
      if (filingPackage.status !== "approved") {
        return NextResponse.json(
          { error: "submission receipt can only be recorded for approved filing packages" },
          { status: 422 }
        )
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const annexure =
        (await repos.filingAnnexures.get(filingAnnexureId(filingPackage.id))) ??
        store.filingAnnexures.get(filingAnnexureId(filingPackage.id))
      if (!annexure || annexure.generationStatus !== "ready") {
        return NextResponse.json(
          { error: "submission receipt requires annexure generationStatus=ready" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const existingReceipts = await repos.filingSubmissionReceipts.listByPackageId(filingPackage.id)
      const highestAttempt = existingReceipts.reduce(
        (max, row) => (row.attemptNo > max ? row.attemptNo : max),
        0
      )
      const receipt = buildFilingSubmissionReceiptRow(
        filingPackage,
        {
          attemptNo: highestAttempt + 1,
          courtChannel: parsed.courtChannel,
          dispatchOutcome: parsed.dispatchOutcome,
          submissionReference: parsed.submissionReference.trim(),
          failureReason: parsed.failureReason?.trim() || null,
          retryHint: parsed.retryHint?.trim() || null,
          actorId: actor.id,
        },
        { now: Date.now() }
      )
      await repos.filingSubmissionReceipts.upsert(receipt)
      store.filingSubmissionReceipts.set(receipt.id, receipt)
      const existingReconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const note = parsed.note?.trim()
      const reconciliation = buildFilingSubmissionReconciliationRow(
        filingPackage,
        [...existingReceipts, receipt],
        {
          notes: note
            ? [
                ...(existingReconciliation?.notes ?? []),
                `${new Date(receipt.recordedAt).toISOString()} ${actor.id}: ${note}`,
              ]
            : existingReconciliation?.notes ?? [],
        }
      )
      await repos.filingSubmissionReconciliation.upsert(reconciliation)
      store.filingSubmissionReconciliation.set(reconciliation.id, reconciliation)
      let submissionException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (parsed.dispatchOutcome !== "accepted") {
        const source =
          parsed.dispatchOutcome === "rejected"
            ? ("receipt_rejected" as const)
            : ("receipt_retry_scheduled" as const)
        const nextException = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source,
            receipt,
            reconciliation,
            actorId: actor.id,
            note: note ? `auto-raised from receipt outcome ${parsed.dispatchOutcome}: ${note}` : undefined,
            now: receipt.recordedAt,
          },
          submissionException
        )
        await repos.filingSubmissionExceptions.upsert(nextException)
        store.filingSubmissionExceptions.set(nextException.id, nextException)
        submissionException = nextException
      }
      const dispatchQueue = await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))
      const dispatchStatus =
        parsed.dispatchOutcome === "accepted" ? "handoff_ready" : "retry_pending"
      const updatedDispatchQueue = dispatchQueue
        ? {
            ...dispatchQueue,
            status: dispatchStatus,
            operatorNotes: [
              ...dispatchQueue.operatorNotes,
              `${new Date(receipt.recordedAt).toISOString()} ${actor.id}: receipt ${receipt.id} (${parsed.dispatchOutcome})`,
            ],
            updatedAt: Date.now(),
          }
        : null
      if (updatedDispatchQueue) {
        await repos.filingDispatchQueue.upsert(updatedDispatchQueue)
        store.filingDispatchQueue.set(updatedDispatchQueue.id, updatedDispatchQueue)
      }
      store.audit.push({
        action: "filing_submission_receipt_record",
        actorId: actor.id,
        target: receipt.id,
        classification: filingPackage.classification,
        reason: parsed.dispatchOutcome,
      })
      store.audit.push({
        action: "filing_submission_reconciliation_update",
        actorId: actor.id,
        target: reconciliation.id,
        classification: filingPackage.classification,
        reason: reconciliation.status,
      })
      if (submissionException && parsed.dispatchOutcome !== "accepted") {
        store.audit.push({
          action: "filing_submission_exception_raise",
          actorId: actor.id,
          target: submissionException.id,
          classification: filingPackage.classification,
          reason: `${submissionException.source}:${submissionException.severity}`,
        })
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "record_submission_receipt",
        receipt: (await repos.filingSubmissionReceipts.get(receipt.id)) ?? receipt,
        reconciliation:
          (await repos.filingSubmissionReconciliation.get(reconciliation.id)) ?? reconciliation,
        submissionException:
          submissionException &&
          ((await repos.filingSubmissionExceptions.get(submissionException.id)) ?? submissionException),
        dispatchQueue: updatedDispatchQueue
          ? (await repos.filingDispatchQueue.get(updatedDispatchQueue.id)) ?? updatedDispatchQueue
          : null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reconcile_submission") {
      if (!parsed.actorId || !parsed.packageId || !parsed.status) {
        return NextResponse.json(
          { error: "actorId, packageId, and status are required" },
          { status: 400 }
        )
      }
      if (!isFilingSubmissionReconciliationStatus(parsed.status)) {
        return NextResponse.json({ error: "invalid reconciliation status" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "reconcile_submission requires partner or clerk role" },
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
        return NextResponse.json({ error: "cross-firm reconciliation denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const receipts = await repos.filingSubmissionReceipts.listByPackageId(filingPackage.id)
      const current =
        (await repos.filingSubmissionReconciliation.get(
          filingSubmissionReconciliationId(filingPackage.id)
        )) ?? buildFilingSubmissionReconciliationRow(filingPackage, receipts)
      const note = parsed.note?.trim()
      const updated = {
        ...current,
        status: parsed.status,
        notes: note
          ? [...current.notes, `${new Date().toISOString()} ${actor.id}: ${note}`]
          : current.notes,
        updatedAt: Date.now(),
      }
      await repos.filingSubmissionReconciliation.upsert(updated)
      store.filingSubmissionReconciliation.set(updated.id, updated)
      let submissionException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (parsed.status === "needs_retry") {
        const latestReceipt =
          (updated.latestReceiptId &&
            (await repos.filingSubmissionReceipts.get(updated.latestReceiptId))) ||
          null
        const nextException = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source: "reconciliation_needs_retry",
            receipt: latestReceipt,
            reconciliation: updated,
            actorId: actor.id,
            note: note ? `auto-raised from reconciliation: ${note}` : undefined,
            now: updated.updatedAt,
          },
          submissionException
        )
        await repos.filingSubmissionExceptions.upsert(nextException)
        store.filingSubmissionExceptions.set(nextException.id, nextException)
        submissionException = nextException
      } else if (parsed.status === "reconciled" && submissionException) {
        const now = Date.now()
        const resolved = {
          ...submissionException,
          status: "resolved" as const,
          resolvedBy: actor.id,
          resolvedAt: now,
          resolutionNotes: [
            ...submissionException.resolutionNotes,
            `${new Date(now).toISOString()} ${actor.id}: auto-resolved from reconciliation`,
          ],
          updatedAt: now,
        }
        await repos.filingSubmissionExceptions.upsert(resolved)
        store.filingSubmissionExceptions.set(resolved.id, resolved)
        submissionException = resolved
      }
      store.audit.push({
        action: "filing_submission_reconcile",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: parsed.status,
      })
      if (submissionException && parsed.status === "needs_retry") {
        store.audit.push({
          action: "filing_submission_exception_raise",
          actorId: actor.id,
          target: submissionException.id,
          classification: filingPackage.classification,
          reason: `${submissionException.source}:${submissionException.severity}`,
        })
      }
      if (submissionException && parsed.status === "reconciled") {
        store.audit.push({
          action: "filing_submission_exception_resolve",
          actorId: actor.id,
          target: submissionException.id,
          classification: filingPackage.classification,
          reason: "auto_reconciled",
        })
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "reconcile_submission",
        reconciliation: (await repos.filingSubmissionReconciliation.get(updated.id)) ?? updated,
        submissionException:
          submissionException &&
          ((await repos.filingSubmissionExceptions.get(submissionException.id)) ?? submissionException),
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "claim_submission_exception") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "claim_submission_exception requires partner or clerk role" },
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
        return NextResponse.json({ error: "cross-firm exception claim denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim()
      const updated = {
        ...existing,
        status: "claimed" as const,
        escalationOwnerId: existing.escalationOwnerId ?? actor.id,
        claimedBy: actor.id,
        claimedAt: now,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNotes: note
          ? [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`]
          : existing.resolutionNotes,
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_claim",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "claim_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "escalate_submission_exception") {
      if (!parsed.actorId || !parsed.packageId || !parsed.escalationOwnerId) {
        return NextResponse.json(
          { error: "actorId, packageId, and escalationOwnerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "escalate_submission_exception requires partner or clerk role" },
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
        return NextResponse.json({ error: "cross-firm exception escalation denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const escalationOwner =
        store.users.get(parsed.escalationOwnerId) ?? (await repos.users.get(parsed.escalationOwnerId))
      if (!escalationOwner || escalationOwner.firmId !== actor.firmId || escalationOwner.role !== "partner") {
        return NextResponse.json(
          { error: "escalationOwnerId must be a partner in actor firm" },
          { status: 422 }
        )
      }
      if (parsed.severity && !isFilingSubmissionExceptionSeverity(parsed.severity)) {
        return NextResponse.json({ error: "invalid severity" }, { status: 400 })
      }
      if (parsed.slaHours !== undefined) {
        const parsedHours = Number(parsed.slaHours)
        if (!Number.isFinite(parsedHours) || parsedHours < 1 || parsedHours > 168) {
          return NextResponse.json(
            { error: "slaHours must be between 1 and 168" },
            { status: 400 }
          )
        }
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim()
      const updated = {
        ...existing,
        status: "escalated" as const,
        severity: parsed.severity ?? existing.severity,
        escalationOwnerId: escalationOwner.id,
        escalatedBy: actor.id,
        escalatedAt: now,
        slaTargetAt: parsed.slaHours ? now + parsed.slaHours * 60 * 60 * 1000 : existing.slaTargetAt,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNotes: note
          ? [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`]
          : existing.resolutionNotes,
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_escalate",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: `${updated.severity}:${updated.escalationOwnerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "escalate_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_submission_exception") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "resolve_submission_exception requires partner or clerk role" },
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
        return NextResponse.json({ error: "cross-firm exception resolution denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim() || "exception resolved by operator"
      const updated = {
        ...existing,
        status: "resolved" as const,
        resolvedBy: actor.id,
        resolvedAt: now,
        resolutionNotes: [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_resolve",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "resolve_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reopen_submission_exception") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "reopen_submission_exception requires partner or clerk role" },
          { status: 403 }
        )
      }
      if (parsed.severity && !isFilingSubmissionExceptionSeverity(parsed.severity)) {
        return NextResponse.json({ error: "invalid severity" }, { status: 400 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm exception reopen denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim() || "exception reopened by operator"
      const updatedSeverity = parsed.severity ?? existing.severity
      const updated = {
        ...existing,
        status: "open" as const,
        severity: updatedSeverity,
        resolvedBy: null,
        resolvedAt: null,
        lastRaisedAt: now,
        slaTargetAt: now + (updatedSeverity === "critical" ? 2 : updatedSeverity === "high" ? 8 : 24) * 60 * 60 * 1000,
        resolutionNotes: [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_reopen",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.severity,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "reopen_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "mark_transport_blocked") {
      if (!parsed.actorId || !parsed.packageId || !parsed.transportChannel || !parsed.channelPayloadHash) {
        return NextResponse.json(
          { error: "actorId, packageId, transportChannel, and channelPayloadHash are required" },
          { status: 400 }
        )
      }
      if (!isFilingTransportExecutionChannel(parsed.transportChannel)) {
        return NextResponse.json({ error: "invalid transportChannel" }, { status: 400 })
      }
      if (parsed.severity && !isFilingSubmissionExceptionSeverity(parsed.severity)) {
        return NextResponse.json({ error: "invalid severity" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "mark_transport_blocked requires partner or clerk role" },
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
        return NextResponse.json({ error: "cross-firm transport block denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const evidenceRows = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const nextSequenceNo = evidenceRows.reduce((max, row) => Math.max(max, row.sequenceNo), 0) + 1
      const currentException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const reconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const nextException = buildSubmissionExceptionRowFromFailure(
        filingPackage,
        {
          source: "dispatch_transport_blocked",
          receipt: null,
          reconciliation,
          actorId: actor.id,
          note: parsed.note ?? "transport blocked during deterministic handoff",
          now,
        },
        currentException
      )
      const normalizedException = {
        ...nextException,
        severity: parsed.severity ?? nextException.severity,
      }
      await repos.filingSubmissionExceptions.upsert(normalizedException)
      store.filingSubmissionExceptions.set(normalizedException.id, normalizedException)
      const existingQueue =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      const updatedQueue = {
        ...existingQueue,
        status: "blocked" as const,
        externalDispatchState: "blocked_todo_firm" as const,
        operatorNotes: [
          ...existingQueue.operatorNotes,
          `${new Date(now).toISOString()} ${actor.id}: transport blocked`,
        ],
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updatedQueue)
      store.filingDispatchQueue.set(updatedQueue.id, updatedQueue)
      const evidence = buildFilingTransportExecutionEvidenceRow(
        filingPackage,
        {
          sequenceNo: nextSequenceNo,
          outcome: "transport_blocked",
          transportOperatorId: actor.id,
          transportChannel: parsed.transportChannel,
          channelPayloadHash: parsed.channelPayloadHash,
          deterministicBlockerTags: parsed.blockerTags,
          attachmentPointers: parsed.attachmentPointers,
          relatedReconciliationId: reconciliation?.id ?? null,
          relatedExceptionId: normalizedException.id,
          note: parsed.note,
        },
        { now }
      )
      await repos.filingTransportExecutionEvidence.upsert(evidence)
      store.filingTransportExecutionEvidence.set(evidence.id, evidence)
      store.audit.push({
        action: "filing_transport_execution_evidence_record",
        actorId: actor.id,
        target: evidence.id,
        classification: filingPackage.classification,
        reason: evidence.outcome,
      })
      store.audit.push({
        action: "filing_dispatch_closure_update",
        actorId: actor.id,
        target: updatedQueue.id,
        classification: filingPackage.classification,
        reason: "transport_blocked",
      })
      store.audit.push({
        action: "filing_submission_exception_raise",
        actorId: actor.id,
        target: normalizedException.id,
        classification: filingPackage.classification,
        reason: `${normalizedException.source}:${normalizedException.severity}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "mark_transport_blocked",
        evidence: (await repos.filingTransportExecutionEvidence.get(evidence.id)) ?? evidence,
        dispatchQueue: (await repos.filingDispatchQueue.get(updatedQueue.id)) ?? updatedQueue,
        submissionException:
          (await repos.filingSubmissionExceptions.get(normalizedException.id)) ?? normalizedException,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attach_retry_plan") {
      if (!parsed.actorId || !parsed.packageId || !parsed.transportChannel || !parsed.channelPayloadHash) {
        return NextResponse.json(
          { error: "actorId, packageId, transportChannel, and channelPayloadHash are required" },
          { status: 400 }
        )
      }
      if (!isFilingTransportExecutionChannel(parsed.transportChannel)) {
        return NextResponse.json({ error: "invalid transportChannel" }, { status: 400 })
      }
      if (!parsed.attachmentPointers?.some((entry) => entry.trim().length > 0)) {
        return NextResponse.json({ error: "attachmentPointers must include at least one entry" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "attach_retry_plan requires partner or clerk role" },
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
        return NextResponse.json({ error: "cross-firm retry plan attach denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const evidenceRows = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const nextSequenceNo = evidenceRows.reduce((max, row) => Math.max(max, row.sequenceNo), 0) + 1
      const currentException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const reconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const nextException = buildSubmissionExceptionRowFromFailure(
        filingPackage,
        {
          source: "dispatch_retry_plan",
          receipt: null,
          reconciliation,
          actorId: actor.id,
          note: parsed.note ?? "retry plan attached",
          now,
        },
        currentException
      )
      const normalizedException = {
        ...nextException,
        status: "escalated" as const,
        escalationOwnerId:
          actor.role === "partner" ? actor.id : (currentException?.escalationOwnerId ?? nextException.escalationOwnerId),
        escalatedBy: actor.id,
        escalatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(normalizedException)
      store.filingSubmissionExceptions.set(normalizedException.id, normalizedException)
      const existingQueue =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      const updatedQueue = {
        ...existingQueue,
        status: "retry_pending" as const,
        externalDispatchState: "blocked_todo_firm" as const,
        operatorNotes: [
          ...existingQueue.operatorNotes,
          `${new Date(now).toISOString()} ${actor.id}: retry plan attached`,
        ],
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updatedQueue)
      store.filingDispatchQueue.set(updatedQueue.id, updatedQueue)
      const evidence = buildFilingTransportExecutionEvidenceRow(
        filingPackage,
        {
          sequenceNo: nextSequenceNo,
          outcome: "retry_plan_attached",
          transportOperatorId: actor.id,
          transportChannel: parsed.transportChannel,
          channelPayloadHash: parsed.channelPayloadHash,
          attachmentPointers: parsed.attachmentPointers,
          relatedReconciliationId: reconciliation?.id ?? null,
          relatedExceptionId: normalizedException.id,
          note: parsed.note,
        },
        { now }
      )
      await repos.filingTransportExecutionEvidence.upsert(evidence)
      store.filingTransportExecutionEvidence.set(evidence.id, evidence)
      store.audit.push({
        action: "filing_transport_execution_evidence_record",
        actorId: actor.id,
        target: evidence.id,
        classification: filingPackage.classification,
        reason: evidence.outcome,
      })
      store.audit.push({
        action: "filing_dispatch_closure_update",
        actorId: actor.id,
        target: updatedQueue.id,
        classification: filingPackage.classification,
        reason: "retry_plan_attached",
      })
      store.audit.push({
        action: "filing_submission_exception_escalate",
        actorId: actor.id,
        target: normalizedException.id,
        classification: filingPackage.classification,
        reason: normalizedException.severity,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attach_retry_plan",
        evidence: (await repos.filingTransportExecutionEvidence.get(evidence.id)) ?? evidence,
        dispatchQueue: (await repos.filingDispatchQueue.get(updatedQueue.id)) ?? updatedQueue,
        submissionException:
          (await repos.filingSubmissionExceptions.get(normalizedException.id)) ?? normalizedException,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "confirm_delivered") {
      if (!parsed.actorId || !parsed.packageId || !parsed.transportChannel || !parsed.channelPayloadHash) {
        return NextResponse.json(
          { error: "actorId, packageId, transportChannel, and channelPayloadHash are required" },
          { status: 400 }
        )
      }
      if (!isFilingTransportExecutionChannel(parsed.transportChannel)) {
        return NextResponse.json({ error: "invalid transportChannel" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "confirm_delivered requires partner or clerk role" },
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
        return NextResponse.json({ error: "cross-firm delivery confirm denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const evidenceRows = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const nextSequenceNo = evidenceRows.reduce((max, row) => Math.max(max, row.sequenceNo), 0) + 1
      const reconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const currentException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const resolvedException = currentException
        ? {
            ...currentException,
            status: "resolved" as const,
            resolvedBy: actor.id,
            resolvedAt: now,
            resolutionNotes: [
              ...currentException.resolutionNotes,
              `${new Date(now).toISOString()} ${actor.id}: deterministic delivery confirmed`,
            ],
            updatedAt: now,
          }
        : null
      if (resolvedException) {
        await repos.filingSubmissionExceptions.upsert(resolvedException)
        store.filingSubmissionExceptions.set(resolvedException.id, resolvedException)
      }
      if (reconciliation) {
        const nextReconciliation = {
          ...reconciliation,
          status: "reconciled" as const,
          notes: [
            ...reconciliation.notes,
            `${new Date(now).toISOString()} ${actor.id}: deterministic delivery confirmed`,
          ],
          updatedAt: now,
        }
        await repos.filingSubmissionReconciliation.upsert(nextReconciliation)
        store.filingSubmissionReconciliation.set(nextReconciliation.id, nextReconciliation)
      }
      const existingQueue =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      const updatedQueue = {
        ...existingQueue,
        status: "handoff_ready" as const,
        externalDispatchState: "ready_for_firm_dispatch" as const,
        operatorNotes: [
          ...existingQueue.operatorNotes,
          `${new Date(now).toISOString()} ${actor.id}: deterministic delivery confirmed`,
        ],
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updatedQueue)
      store.filingDispatchQueue.set(updatedQueue.id, updatedQueue)
      const evidence = buildFilingTransportExecutionEvidenceRow(
        filingPackage,
        {
          sequenceNo: nextSequenceNo,
          outcome: "confirm_delivered",
          transportOperatorId: actor.id,
          transportChannel: parsed.transportChannel,
          channelPayloadHash: parsed.channelPayloadHash,
          attachmentPointers: parsed.attachmentPointers,
          relatedReceiptId: parsed.relatedReceiptId?.trim() || null,
          relatedReconciliationId: reconciliation?.id ?? null,
          relatedExceptionId: resolvedException?.id ?? null,
          note: parsed.note,
        },
        { now }
      )
      await repos.filingTransportExecutionEvidence.upsert(evidence)
      store.filingTransportExecutionEvidence.set(evidence.id, evidence)
      store.audit.push({
        action: "filing_transport_execution_evidence_record",
        actorId: actor.id,
        target: evidence.id,
        classification: filingPackage.classification,
        reason: evidence.outcome,
      })
      store.audit.push({
        action: "filing_dispatch_closure_update",
        actorId: actor.id,
        target: updatedQueue.id,
        classification: filingPackage.classification,
        reason: "confirm_delivered",
      })
      if (resolvedException) {
        store.audit.push({
          action: "filing_submission_exception_resolve",
          actorId: actor.id,
          target: resolvedException.id,
          classification: filingPackage.classification,
          reason: "confirm_delivered",
        })
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "confirm_delivered",
        evidence: (await repos.filingTransportExecutionEvidence.get(evidence.id)) ?? evidence,
        dispatchQueue: (await repos.filingDispatchQueue.get(updatedQueue.id)) ?? updatedQueue,
        submissionException:
          resolvedException &&
          ((await repos.filingSubmissionExceptions.get(resolvedException.id)) ?? resolvedException),
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
