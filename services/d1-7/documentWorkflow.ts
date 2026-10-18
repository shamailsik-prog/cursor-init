import { declassify } from "@/platform/classification/declassify"
import { canReadDocument } from "@/platform/p5/documentAccess"
import { PublicError } from "@/platform/http/publicError"
import { isClassification, type Classification } from "@/platform/p1/types"
import {
  rankOf, rankOfStoredOrMax,
  type DocumentRecord,
  type DocumentWorkflow,
  type SpineStore,
  type User,
  type WorkflowStatus,
} from "@/platform/spine/store"

const TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  queued: ["processing", "review_required"],
  processing: ["review_required", "complete"],
  review_required: ["processing", "complete"],
  complete: ["complete"],
}

function isUserVisibleForDocument(
  store: SpineStore,
  user: User,
  doc: DocumentRecord
): boolean {
  return canReadDocument(store, user, doc)
}

export function ensureWorkflowRow(
  store: SpineStore,
  doc: DocumentRecord
): DocumentWorkflow {
  const existing = store.documentWorkflow.get(doc.id)
  if (existing) return existing
  const row: DocumentWorkflow = {
    documentId: doc.id,
    firmId: doc.firmId,
    matterId: doc.matterId,
    status: "queued",
    reviewerId: null,
    updatedAt: Date.now(),
  }
  store.documentWorkflow.set(doc.id, row)
  return row
}

function requireActorAndDocument(
  store: SpineStore,
  actorId: string,
  documentId: string
): { actor: User; doc: DocumentRecord; row: DocumentWorkflow } {
  const actor = store.users.get(actorId)
  if (!actor) throw new PublicError("unknown actor")
  if (actor.role === "client" || actor.role === "intern" || actor.role === "accounts") {
    throw new PublicError("actor role not allowed for workflow actions")
  }
  const doc = store.documents.get(documentId)
  if (!doc) throw new PublicError("unknown document")
  if (!isUserVisibleForDocument(store, actor, doc)) {
    throw new PublicError("actor not permitted for this document")
  }
  const row = ensureWorkflowRow(store, doc)
  return { actor, doc, row }
}

export function transitionWorkflowStatus(
  store: SpineStore,
  input: {
    actorId: string
    documentId: string
    nextStatus: WorkflowStatus
    reason?: string
  }
): DocumentWorkflow {
  const { actor, doc, row } = requireActorAndDocument(
    store,
    input.actorId,
    input.documentId
  )
  if (!TRANSITIONS[row.status].includes(input.nextStatus)) {
    throw new PublicError(`invalid transition: ${row.status} -> ${input.nextStatus}`)
  }
  row.status = input.nextStatus
  row.updatedAt = Date.now()
  store.audit.push({
    action: "document_workflow_transition",
    actorId: actor.id,
    target: doc.id,
    classification: doc.classification,
    reason: input.reason ?? `${row.status}`,
  })
  store.workflowEvents.push({
    id: store.id("wfe"),
    documentId: doc.id,
    firmId: doc.firmId,
    matterId: doc.matterId,
    actorId: actor.id,
    action: "status_transition",
    status: row.status,
    classification: doc.classification,
    reason: input.reason,
    at: Date.now(),
  })
  return row
}

export function assignReviewer(
  store: SpineStore,
  input: {
    actorId: string
    documentId: string
    reviewerId: string
  }
): DocumentWorkflow {
  const { actor, doc, row } = requireActorAndDocument(
    store,
    input.actorId,
    input.documentId
  )
  const reviewer = store.users.get(input.reviewerId)
  if (!reviewer) throw new PublicError("unknown reviewer")
  if (reviewer.firmId !== doc.firmId) throw new PublicError("cross-firm reviewer denied")
  if (reviewer.role === "client" || reviewer.role === "intern" || reviewer.role === "accounts") {
    throw new PublicError("reviewer role not allowed")
  }
  if (rankOf(reviewer.clearanceLevel) < rankOfStoredOrMax(doc.classification)) {
    throw new PublicError("reviewer clearance too low")
  }
  if (doc.matterId && !store.members.has(store.memberKey(doc.matterId, reviewer.id))) {
    throw new PublicError("reviewer is not a member of this matter")
  }
  if (!canReadDocument(store, reviewer, doc)) {
    throw new PublicError("reviewer not permitted for this document")
  }
  row.reviewerId = reviewer.id
  row.updatedAt = Date.now()
  if (row.status === "queued") row.status = "review_required"
  store.audit.push({
    action: "document_workflow_assign_reviewer",
    actorId: actor.id,
    target: doc.id,
    classification: doc.classification,
    reason: reviewer.id,
  })
  store.workflowEvents.push({
    id: store.id("wfe"),
    documentId: doc.id,
    firmId: doc.firmId,
    matterId: doc.matterId,
    actorId: actor.id,
    action: "reviewer_assigned",
    status: row.status,
    classification: doc.classification,
    reason: reviewer.id,
    at: Date.now(),
  })
  return row
}

export function applyReviewDecision(
  store: SpineStore,
  input: {
    actorId: string
    documentId: string
    decision: "confirm_classification" | "declassify"
    nextClassification?: string
    reason?: string
  }
): DocumentWorkflow {
  const { actor, doc, row } = requireActorAndDocument(
    store,
    input.actorId,
    input.documentId
  )
  if (row.reviewerId && row.reviewerId !== actor.id && actor.role !== "partner") {
    throw new PublicError("only assigned reviewer or partner may submit review decision")
  }
  if (input.decision === "confirm_classification") {
    row.status = "complete"
    row.updatedAt = Date.now()
    store.audit.push({
      action: "document_classification_confirm",
      actorId: actor.id,
      target: doc.id,
      classification: doc.classification,
      reason: input.reason,
    })
    store.workflowEvents.push({
      id: store.id("wfe"),
      documentId: doc.id,
      firmId: doc.firmId,
      matterId: doc.matterId,
      actorId: actor.id,
      action: "classification_confirmed",
      status: row.status,
      classification: doc.classification,
      reason: input.reason,
      at: Date.now(),
    })
    return row
  }

  if (!isClassification(input.nextClassification)) {
    throw new PublicError("nextClassification must be a rank-0–4 label")
  }
  if (!input.reason?.trim()) {
    throw new PublicError("declassify decision requires a reason")
  }
  const next = input.nextClassification as Classification
  declassify(store, doc.id, next, actor.id, input.reason)
  const updated = store.documents.get(doc.id)
  if (!updated) throw new PublicError("document missing after declassify")
  row.status = "complete"
  row.updatedAt = Date.now()
  store.workflowEvents.push({
    id: store.id("wfe"),
    documentId: doc.id,
    firmId: doc.firmId,
    matterId: doc.matterId,
    actorId: actor.id,
    action: "classification_declassified",
    status: row.status,
    classification: updated.classification,
    reason: input.reason,
    at: Date.now(),
  })
  return row
}
