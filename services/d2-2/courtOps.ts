import { checkPermission } from "@/platform/p5/checkPermission"
import { canReadDocument } from "@/platform/p5/documentAccess"
import { PublicError } from "@/platform/http/publicError"
import type { SpineStore, WorkflowStatus } from "@/platform/spine/store"
import { transitionWorkflowStatus } from "@/services/d1-7/documentWorkflow"

type OpsActor = {
  id: string
  firmId: string
  role: string
}

function requireOpsActor(store: SpineStore, userId: string): OpsActor {
  const actor = store.users.get(userId)
  if (!actor) throw new PublicError("unknown actor")
  if (actor.role === "client" || actor.role === "intern" || actor.role === "accounts") {
    throw new PublicError("actor role not allowed for court ops")
  }
  return actor
}

function canAccessMatter(store: SpineStore, actorId: string, matterId: string): boolean {
  const perm = checkPermission(store, actorId, "research", matterId)
  return perm.allow
}

function canSeeDocument(store: SpineStore, actorId: string, documentId: string): boolean {
  const user = store.users.get(actorId)
  const doc = store.documents.get(documentId)
  return Boolean(user && doc && canReadDocument(store, user, doc))
}

export function listCourtOpsQueue(
  store: SpineStore,
  actorId: string,
  opts: {
    matterId?: string
    limit: number
    cursor: number
  }
): {
  items: Array<{
    queueType: "follow_up" | "workflow"
    id: string
    matterId: string
    documentId?: string
    kind: string
    status: string
    detail: string
  }>
  total: number
  nextCursor: string | null
} {
  const actor = requireOpsActor(store, actorId)
  const followUps = store.followUps
    .filter((row) => row.firmId === actor.firmId)
    .filter((row) => (opts.matterId ? row.matterId === opts.matterId : true))
    .filter((row) => row.status !== "resolved")
    .filter((row) => canAccessMatter(store, actor.id, row.matterId))
    .map((row) => ({
      queueType: "follow_up" as const,
      id: row.id,
      matterId: row.matterId,
      kind: row.kind,
      status: row.status ?? "open",
      detail: row.raw,
    }))

  const workflow = [...store.documentWorkflow.values()]
    .filter((row) => row.firmId === actor.firmId)
    .filter((row) => row.status === "review_required")
    .filter((row) => (opts.matterId ? row.matterId === opts.matterId : true))
    .filter((row) => (row.matterId ? canAccessMatter(store, actor.id, row.matterId) : true))
    // Audit F14 R2-D4: a row names its document, so it is shown only to a caller who may read that document (its own
    // label, and its matter's current label and membership); a row whose document is unknown here is left out.
    .filter((row) => canSeeDocument(store, actor.id, row.documentId))
    .map((row) => ({
      queueType: "workflow" as const,
      id: row.documentId,
      matterId: row.matterId ?? "none",
      documentId: row.documentId,
      kind: "workflow_review_blocker",
      status: row.status,
      detail: row.reviewerId ? `assigned:${row.reviewerId}` : "reviewer_unassigned",
    }))

  const combined = [...followUps, ...workflow].sort((a, b) =>
    `${a.queueType}:${a.id}`.localeCompare(`${b.queueType}:${b.id}`)
  )
  const page = combined.slice(opts.cursor, opts.cursor + opts.limit)
  const nextCursor =
    opts.cursor + page.length < combined.length
      ? String(opts.cursor + page.length)
      : null
  return {
    items: page,
    total: combined.length,
    nextCursor,
  }
}

/**
 * FA-D4-001-FU1 (spec R4): the item an acknowledgement names is absent, another firm's, or not visible to the caller.
 * One answer for all three (404), so the endpoint is no existence oracle across firms.
 */
export class CourtOpsItemNotFoundError extends Error {
  readonly code = "court_ops_item_not_found"
  constructor() {
    super("court ops item not found")
    this.name = "CourtOpsItemNotFoundError"
  }
}

export type CourtOpsAckTarget = {
  actor: OpsActor
  documentId: string | null
  followUpId: string | null
}

/**
 * FA-D4-001-FU1 (spec R4): the queue item an acknowledgement names, resolved in the caller's firm and under the queue
 * listing's own visibility (a follow-up: its matter's permission; a workflow item: its matter's permission when
 * matter-bound, and its document readable). Any status: an item a colleague resolved a moment ago can still be
 * acknowledged. Throws CourtOpsItemNotFoundError otherwise. The store must hold the caller firm's rows (the route's
 * syncCourtOpsState).
 */
export function resolveCourtOpsAckItem(
  store: SpineStore,
  input: { actorId: string; queueType: "follow_up" | "workflow"; id: string }
): CourtOpsAckTarget {
  const actor = requireOpsActor(store, input.actorId)
  if (input.queueType === "follow_up") {
    const follow = store.followUps.find((row) => row.id === input.id)
    if (!follow || follow.firmId !== actor.firmId || !canAccessMatter(store, actor.id, follow.matterId)) {
      throw new CourtOpsItemNotFoundError()
    }
    return { actor, documentId: null, followUpId: follow.id }
  }
  const row = store.documentWorkflow.get(input.id)
  if (!row || row.documentId !== input.id || row.firmId !== actor.firmId) throw new CourtOpsItemNotFoundError()
  if (row.matterId && !canAccessMatter(store, actor.id, row.matterId)) throw new CourtOpsItemNotFoundError()
  if (!canSeeDocument(store, actor.id, row.documentId)) throw new CourtOpsItemNotFoundError()
  return { actor, documentId: row.documentId, followUpId: null }
}

/**
 * The acknowledgement's audit row. FA-D4-001-FU1 (spec R7): the route calls this only AFTER the activity row committed,
 * so a write that failed never leaves an "acknowledged" audit row behind.
 */
export function acknowledgeCourtOpsItem(
  store: SpineStore,
  input: {
    actorId: string
    queueType: "follow_up" | "workflow"
    id: string
    reason?: string
  }
) {
  const actor = requireOpsActor(store, input.actorId)
  store.audit.push({
    action: "court_ops_acknowledge",
    actorId: actor.id,
    target: `${input.queueType}:${input.id}`,
    classification: "internal",
    reason: input.reason,
  })
}

export function resolveFollowUp(
  store: SpineStore,
  input: { actorId: string; followUpId: string; reason?: string }
) {
  const actor = requireOpsActor(store, input.actorId)
  const follow = store.followUps.find((row) => row.id === input.followUpId)
  if (!follow) throw new PublicError("unknown follow_up id")
  if (follow.firmId !== actor.firmId) throw new PublicError("cross-firm follow_up denied")
  if (!canAccessMatter(store, actor.id, follow.matterId)) {
    throw new PublicError("actor cannot resolve this follow_up")
  }
  follow.status = "resolved"
  follow.resolvedBy = actor.id
  follow.resolvedAt = Date.now()
  store.audit.push({
    action: "court_ops_resolve_follow_up",
    actorId: actor.id,
    target: follow.id,
    classification: "internal",
    reason: input.reason,
  })
}

export function resolveWorkflowBlocker(
  store: SpineStore,
  input: {
    actorId: string
    documentId: string
    nextStatus: WorkflowStatus
    reason?: string
  }
) {
  requireOpsActor(store, input.actorId)
  return transitionWorkflowStatus(store, {
    actorId: input.actorId,
    documentId: input.documentId,
    nextStatus: input.nextStatus,
    reason: input.reason ?? "court-ops-resolve",
  })
}
