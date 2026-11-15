import { requireCallerFirmId } from "@/platform/persistence/callerFirm"
import {
  nextCourtOpsAckRow,
  isCourtOpsAckQueueType,
  type CourtOpsAckQueueType,
} from "@/platform/persistence/courtOpsAcknowledgement"
import { doc, runTransaction, setDoc, type Firestore } from "@/platform/persistence/firestoreDbModular"
import type { FollowUp, SpineStore, WorkflowOpsActivityRow } from "@/platform/spine/store"

/**
 * FA-D4-001-FU1-001 (issue #30 residual R-A): a follow-up or court-ops acknowledgement that belongs to a
 * matter was stored with `matterId: null`, so the F42 purge query (`firmId` + `matterId`) never reached it.
 * The writer derives the matter from the parent row and refuses the write when a follow-up's matter cannot
 * be derived, or when the caller names a different matter. A workflow item with no matter stays firm-level.
 * Legacy null rows are classified by `decideCourtOpsReach` for the deletion saga.
 */

export class CourtOpsMatterUnboundError extends Error {
  readonly code = "court_ops_matter_unbound"
  constructor(
    readonly subject: string,
    readonly reason: "parent_missing" | "matter_unbound" | "matter_mismatch" | "parent_other_firm"
  ) {
    super(`court-ops ${subject} matter unbound: ${reason}`)
    this.name = "CourtOpsMatterUnboundError"
  }
}

export function matterIdOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

/** A follow-up belongs to a matter. Empty or non-string `matterId` is refused. */
export function assertFollowUpBound(row: { matterId?: unknown }): void {
  if (matterIdOf(row.matterId) === null) throw new CourtOpsMatterUnboundError("follow_up", "matter_unbound")
}

/**
 * The matter id to store on an acknowledgement, taken from its parent.
 * A follow-up parent must name a matter. A workflow parent may be firm-level (`null`).
 * A supplied matter id that is not the derived one is refused.
 */
export function deriveCourtOpsAckMatter(input: {
  queueType: CourtOpsAckQueueType
  suppliedMatterId: unknown
  firmId: string
  parent: unknown
}): string | null {
  if (input.parent === null || input.parent === undefined || typeof input.parent !== "object" || Array.isArray(input.parent)) {
    throw new CourtOpsMatterUnboundError(input.queueType, "parent_missing")
  }
  const row = input.parent as Record<string, unknown>
  if (typeof row.firmId === "string" && row.firmId !== "" && row.firmId !== input.firmId) {
    throw new CourtOpsMatterUnboundError(input.queueType, "parent_other_firm")
  }
  if (typeof row.firmId !== "string" || row.firmId === "") {
    throw new CourtOpsMatterUnboundError(input.queueType, "parent_other_firm")
  }
  const derived = matterIdOf(row.matterId)
  if (input.queueType === "follow_up" && derived === null) {
    throw new CourtOpsMatterUnboundError("follow_up", "matter_unbound")
  }
  const supplied = matterIdOf(input.suppliedMatterId)
  if (supplied !== null && supplied !== derived) {
    throw new CourtOpsMatterUnboundError(input.queueType, "matter_mismatch")
  }
  return derived
}

const SAFE_ITEM = /^[^/]+$/

/** The parent a court-ops activity row is linked through: its fields, or the id when the fields were not stored. */
export function courtOpsParentRef(id: string, row: Record<string, unknown>): { collection: "follow_ups" | "document_workflow"; id: string } | null {
  const follow = typeof row.followUpId === "string" && row.followUpId !== "" ? row.followUpId : null
  const documentId = typeof row.documentId === "string" && row.documentId !== "" ? row.documentId : null
  const queue = row.queueType === "follow_up" || row.queueType === "workflow" ? row.queueType : null
  const fromFields = (): { collection: "follow_ups" | "document_workflow"; id: string } | null => {
    if (queue === "follow_up" && follow && SAFE_ITEM.test(follow)) return { collection: "follow_ups", id: follow }
    if (queue === "workflow" && documentId && SAFE_ITEM.test(documentId)) return { collection: "document_workflow", id: documentId }
    if (follow && !documentId && SAFE_ITEM.test(follow)) return { collection: "follow_ups", id: follow }
    if (documentId && !follow && SAFE_ITEM.test(documentId)) return { collection: "document_workflow", id: documentId }
    return null
  }
  const named = fromFields()
  if (named) return named
  const parts = id.split(":")
  if (parts.length === 6 && parts[0] === "ops" && parts[1] === "court_ops" && parts[2] === "ack" && SAFE_ITEM.test(parts[5])) {
    if (parts[4] === "follow_up") return { collection: "follow_ups", id: parts[5] }
    if (parts[4] === "workflow") return { collection: "document_workflow", id: parts[5] }
  }
  if (parts.length === 5 && parts[0] === "ops" && parts[1] === "court_ops" && parts[2] === "ack" && SAFE_ITEM.test(parts[4])) {
    if (parts[3] === "follow_up") return { collection: "follow_ups", id: parts[4] }
    if (parts[3] === "workflow") return { collection: "document_workflow", id: parts[4] }
  }
  if (parts.length === 4 && parts[0] === "ops" && parts[1] === "court_ops" && parts[2] === "follow_up" && SAFE_ITEM.test(parts[3])) {
    return { collection: "follow_ups", id: parts[3] }
  }
  return null
}

export function isCourtOpsDeletionRow(collection: "follow_ups" | "workflow_ops_activity", id: string, row: Record<string, unknown>): boolean {
  if (collection === "follow_ups") return true
  if (id.startsWith("ops:court_ops:ack:") || id.startsWith("ops:court_ops:follow_up:")) return true
  if (row.action === "court_ops_acknowledge" || row.action === "court_ops_resolve_follow_up") return true
  if (row.source === "court_ops" && (row.queueType === "follow_up" || row.queueType === "workflow")) return true
  return false
}

export type CourtOpsReach =
  | { action: "stamp"; matterId: string }
  | { action: "leave" }
  | { action: "report"; reason: "matter_unbound" | "parent_missing" | "parent_other_firm" | "no_parent" }

/**
 * What F42 should do with one stored row whose `matterId` is null. A row that is not a follow-up or a
 * court-ops acknowledgement is left. A firm-level workflow acknowledgement (parent exists, no matter) is left.
 * A parent that names a matter is stamped with that matter. Anything that cannot be linked is reported.
 */
export function decideCourtOpsReach(input: {
  collection: "follow_ups" | "workflow_ops_activity"
  id: string
  row: Record<string, unknown>
  parent: Record<string, unknown> | null
}): CourtOpsReach {
  if (!isCourtOpsDeletionRow(input.collection, input.id, input.row)) return { action: "leave" }
  if (matterIdOf(input.row.matterId) !== null) return { action: "leave" }
  if (input.collection === "follow_ups") return { action: "report", reason: "matter_unbound" }
  const parentKey = courtOpsParentRef(input.id, input.row)
  if (!parentKey) return { action: "report", reason: "no_parent" }
  if (input.parent === null) return { action: "report", reason: "parent_missing" }
  const firmId = typeof input.row.firmId === "string" ? input.row.firmId : ""
  const parentFirm = input.parent.firmId
  if (typeof parentFirm !== "string" || parentFirm === "" || parentFirm !== firmId) {
    return { action: "report", reason: "parent_other_firm" }
  }
  const matterId = matterIdOf(input.parent.matterId)
  if (matterId !== null) return { action: "stamp", matterId }
  if (parentKey.collection === "document_workflow") return { action: "leave" }
  return { action: "report", reason: "matter_unbound" }
}

function parentFromMemory(store: SpineStore, row: WorkflowOpsActivityRow): unknown {
  if (!isCourtOpsAckQueueType(row.queueType)) return null
  const key = courtOpsParentRef(row.id, row as unknown as Record<string, unknown>)
  if (!key) return null
  if (key.collection === "follow_ups") return store.followUps.find((entry) => entry.id === key.id) ?? null
  return store.documentWorkflow.get(key.id) ?? null
}

/** Memory: derive the matter, then the existing firm-checked acknowledgement write. No await between read and write. */
export async function recordCourtOpsAckMemory(store: SpineStore, firmId: string, row: WorkflowOpsActivityRow): Promise<WorkflowOpsActivityRow> {
  const firm = requireCallerFirmId(firmId, "workflowOpsActivity.recordCourtOpsAcknowledgement")
  const matterId = isCourtOpsAckQueueType(row.queueType)
    ? deriveCourtOpsAckMatter({ queueType: row.queueType, suppliedMatterId: row.matterId, firmId: firm, parent: parentFromMemory(store, row) })
    : row.matterId
  const next = nextCourtOpsAckRow(firm, { ...row, matterId }, store.workflowOpsActivity.get(row.id) ?? null)
  store.workflowOpsActivity.set(next.id, next)
  return next
}

export async function upsertFollowUpMemory(store: SpineStore, row: FollowUp): Promise<void> {
  assertFollowUpBound(row)
  const idx = store.followUps.findIndex((entry) => entry.id === row.id)
  if (idx >= 0) store.followUps[idx] = row
  else store.followUps.push(row)
}

/** Firestore: one transaction reads the parent and the stored acknowledgement, then writes the derived row. */
export async function recordCourtOpsAckFirestore(db: Firestore, firmId: string, row: WorkflowOpsActivityRow): Promise<WorkflowOpsActivityRow> {
  const firm = requireCallerFirmId(firmId, "workflowOpsActivity.recordCourtOpsAcknowledgement")
  if (!isCourtOpsAckQueueType(row.queueType)) {
    return nextCourtOpsAckRow(firm, row, null)
  }
  const key = courtOpsParentRef(row.id, row as unknown as Record<string, unknown>)
  if (!key) throw new CourtOpsMatterUnboundError(row.queueType, "parent_missing")
  const parentRef = doc(db, key.collection, key.id)
  const ref = doc(db, "workflow_ops_activity", row.id)
  return runTransaction(db, async (tx) => {
    const parentSnap = await tx.get(parentRef)
    const snap = await tx.get(ref)
    const matterId = deriveCourtOpsAckMatter({
      queueType: row.queueType as CourtOpsAckQueueType,
      suppliedMatterId: row.matterId,
      firmId: firm,
      parent: parentSnap.exists() ? parentSnap.data() : null,
    })
    const next = nextCourtOpsAckRow(firm, { ...row, matterId }, snap.exists() ? snap.data() : null)
    tx.set(ref, next)
    return next
  })
}

export async function upsertFollowUpFirestore(db: Firestore, row: FollowUp): Promise<void> {
  assertFollowUpBound(row)
  const payload: Record<string, unknown> = { ...row }
  if (payload.status === undefined) delete payload.status
  if (payload.resolvedBy === undefined) delete payload.resolvedBy
  if (payload.resolvedAt === undefined) delete payload.resolvedAt
  await setDoc(doc(db, "follow_ups", row.id), payload)
}
