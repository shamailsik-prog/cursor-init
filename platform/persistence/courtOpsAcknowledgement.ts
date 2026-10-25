import { isClassification } from "@/platform/p1/types"
import type { WorkflowOpsActivityRow } from "@/platform/spine/store"
import { requireCallerFirmId } from "@/platform/persistence/callerFirm"

/**
 * Audit FA-D4-001-FU1: a court-ops acknowledgement row was `workflow_ops_activity/ops:court_ops:ack:${queueType}:${id}`,
 * both parts taken from the request body and written blind. Firm A sending firm B's item id replaced B's row; an id with
 * `/` wrote a nested document no rule matches; any queueType was stored. The id now carries the caller's firm, the
 * queue type is allowlisted, the item id may hold neither `:` nor `/`, and the only writer is the repositories'
 * `recordCourtOpsAcknowledgement`, one transaction that refuses a row stamped with another firm (`nextCourtOpsAckRow`).
 * Legacy rows are moved by `scripts/backfill-court-ops-acks.ts`.
 * Spec: docs/superpowers/specs/2026-10-24-fa-d4-001-fu1-firm-qualified-court-ops-acks-design.md.
 */

export const COURT_OPS_ACK_PREFIX = "ops:court_ops:ack:"
export const COURT_OPS_ACK_ACTION = "court_ops_acknowledge"
export const COURT_OPS_ACK_QUEUE_TYPES = ["follow_up", "workflow"] as const
export type CourtOpsAckQueueType = (typeof COURT_OPS_ACK_QUEUE_TYPES)[number]
/**
 * Over six times the longest real item id (`doc_<uuid>` is 40 characters, `fu_<uuid>` 39; both from SpineStore.id);
 * keeps the composite id far below 1,500 bytes.
 */
export const COURT_OPS_ACK_ITEM_ID_MAX_BYTES = 256

export function isCourtOpsAckQueueType(value: unknown): value is CourtOpsAckQueueType {
  return value === "follow_up" || value === "workflow"
}

/** Why `id` cannot be an acknowledged item id, or null when it can (R3). */
export function courtOpsAckItemIdProblem(id: unknown): string | null {
  if (typeof id !== "string" || id === "") return "id must be a non-empty string"
  if (id.includes(":") || id.includes("/")) return "id must contain no ':' or '/'"
  if (Buffer.byteLength(id, "utf8") > COURT_OPS_ACK_ITEM_ID_MAX_BYTES) {
    return `id must be at most ${COURT_OPS_ACK_ITEM_ID_MAX_BYTES} bytes`
  }
  return null
}

/** An acknowledgement id that cannot be built: a part would be ambiguous, a sub-path, or not the caller's firm. */
export class CourtOpsAckIdError extends Error {
  readonly code = "court_ops_ack_id_invalid"
  constructor(message: string) {
    super(message)
    this.name = "CourtOpsAckIdError"
  }
}

export type CourtOpsAckRefusal = "foreign_firm" | "malformed"

/** A write refused because the row stored at the caller's own acknowledgement id is another firm's or not canonical. */
export class CourtOpsAckRefusedError extends Error {
  readonly code = "court_ops_ack_refused"
  constructor(
    readonly ackId: string,
    readonly reason: CourtOpsAckRefusal
  ) {
    super(`court-ops acknowledgement ${ackId} refused: ${reason}`)
    this.name = "CourtOpsAckRefusedError"
  }
}

function firmPart(firmId: string): string {
  if (typeof firmId !== "string" || firmId === "" || firmId !== firmId.trim() || firmId.includes(":") || firmId.includes("/")) {
    throw new CourtOpsAckIdError("firmId must be non-empty, unpadded and contain no ':' or '/'")
  }
  return requireCallerFirmId(firmId, "courtOpsAckId")
}

/** `ops:court_ops:ack:{firmId}:{queueType}:{itemId}` (R5). Every part is checked; none can be ambiguous or a sub-path. */
export function courtOpsAckId(firmId: string, queueType: CourtOpsAckQueueType, itemId: string): string {
  const firm = firmPart(firmId)
  if (!isCourtOpsAckQueueType(queueType)) throw new CourtOpsAckIdError("queueType must be follow_up or workflow")
  const problem = courtOpsAckItemIdProblem(itemId)
  if (problem) throw new CourtOpsAckIdError(problem)
  return `${COURT_OPS_ACK_PREFIX}${firm}:${queueType}:${itemId}`
}

/** The pre-fix id `ops:court_ops:ack:{queueType}:{itemId}` (the backfill's legacy rows). Not validated. */
export function legacyCourtOpsAckId(queueType: string, itemId: string): string {
  return `${COURT_OPS_ACK_PREFIX}${queueType}:${itemId}`
}

/** True for any document id under the acknowledgement prefix, canonical or not. */
export function isCourtOpsAckPath(id: string): boolean {
  return id.startsWith(COURT_OPS_ACK_PREFIX)
}

type AckFields = { row: Omit<WorkflowOpsActivityRow, "id">; firmId: string; queueType: CourtOpsAckQueueType; itemId: string }

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== ""

/** Every field of a stored acknowledgement row type-checked; the id is checked by the callers. */
function ackFields(data: unknown): AckFields | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null
  const row = data as Record<string, unknown>
  if (row.source !== "court_ops" || row.action !== COURT_OPS_ACK_ACTION) return null
  if (!isNonEmptyString(row.firmId) || !isNonEmptyString(row.actorId)) return null
  if (!isCourtOpsAckQueueType(row.queueType)) return null
  const itemId = row.queueType === "workflow" ? row.documentId : row.followUpId
  const other = row.queueType === "workflow" ? row.followUpId : row.documentId
  if (typeof itemId !== "string" || courtOpsAckItemIdProblem(itemId) !== null || other !== null) return null
  if (!isClassification(row.classification)) return null
  if (row.matterId !== null && typeof row.matterId !== "string") return null
  if (row.status !== null && typeof row.status !== "string") return null
  if (typeof row.detail !== "string") return null
  if (!Array.isArray(row.tags) || !row.tags.every((tag) => typeof tag === "string")) return null
  if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) return null
  return {
    firmId: row.firmId,
    queueType: row.queueType,
    itemId,
    row: {
      firmId: row.firmId,
      source: "court_ops",
      action: COURT_OPS_ACK_ACTION,
      actorId: row.actorId,
      classification: row.classification,
      matterId: row.matterId,
      documentId: row.queueType === "workflow" ? itemId : null,
      followUpId: row.queueType === "follow_up" ? itemId : null,
      queueType: row.queueType,
      status: row.status,
      detail: row.detail,
      tags: [...(row.tags as string[])],
      createdAt: row.createdAt,
    },
  }
}

const asRow = (id: string, fields: AckFields): WorkflowOpsActivityRow => ({ id, ...fields.row })

/** The firm-qualified id of the fields' own firm, queue and item, or null when it cannot be built. */
function canonicalIdOf(fields: AckFields): string | null {
  try {
    return courtOpsAckId(fields.firmId, fields.queueType, fields.itemId)
  } catch {
    return null
  }
}

/**
 * The one validator of a stored acknowledgement row (the F13 canonical-shape pattern). Every field is type-checked, and
 * the document id must be the firm-qualified id of the row's own firm, queue and item: a legacy id, or an id naming
 * another firm or item, is refused (null). The document id wins over any stored `id`.
 */
export function readCourtOpsAckRow(id: string, data: unknown): WorkflowOpsActivityRow | null {
  const fields = ackFields(data)
  if (!fields || canonicalIdOf(fields) !== id) return null
  return asRow(id, fields)
}

/**
 * A pre-fix row at `ops:court_ops:ack:{queueType}:{itemId}` that matches its own content, re-keyed to its firm-qualified
 * id (the backfill's move); null for anything else, a canonical id included.
 */
export function readLegacyCourtOpsAckRow(id: string, data: unknown): WorkflowOpsActivityRow | null {
  const fields = ackFields(data)
  if (!fields || legacyCourtOpsAckId(fields.queueType, fields.itemId) !== id) return null
  const canonical = canonicalIdOf(fields)
  return canonical === null ? null : asRow(canonical, fields)
}

/**
 * The row to write for one acknowledgement by `firmId`, given what is stored at its id (`stored`, null when absent).
 * Both repositories call this between the read and the write of one transaction. A stored row of another firm
 * (`foreign_firm`) or one that is not canonical (`malformed`) is refused, never replaced. The firm's own previous
 * acknowledgement of the item is replaced (the latest one is the row; audit_log keeps every one).
 */
export function nextCourtOpsAckRow(firmId: string, next: WorkflowOpsActivityRow, stored: unknown): WorkflowOpsActivityRow {
  const firm = requireCallerFirmId(firmId, "workflowOpsActivity.recordCourtOpsAcknowledgement")
  if (next.firmId !== firm) throw new CourtOpsAckIdError("an acknowledgement row must be the caller firm's")
  const row = readCourtOpsAckRow(next.id, next)
  if (!row) throw new CourtOpsAckIdError("an acknowledgement row must be canonical at its firm-qualified id")
  if (stored === null || stored === undefined) return row
  if ((stored as { firmId?: unknown }).firmId !== firm) throw new CourtOpsAckRefusedError(next.id, "foreign_firm")
  if (!readCourtOpsAckRow(next.id, stored)) throw new CourtOpsAckRefusedError(next.id, "malformed")
  return row
}

/** A row reaching `upsert` under the acknowledgement prefix: record is the only writer of those ids (R6). */
export function refuseBlindCourtOpsAckWrite(id: string): void {
  if (isCourtOpsAckPath(id)) {
    throw new CourtOpsAckIdError("court-ops acknowledgement rows are written by recordCourtOpsAcknowledgement only")
  }
}

/**
 * A stored `workflow_ops_activity` row as the repositories return it (R11): a row under the acknowledgement prefix only
 * when it is canonical (legacy, mismatched and malformed ones wait for the backfill); any other row as stored.
 */
export function readWorkflowOpsActivityRow(id: string, row: WorkflowOpsActivityRow): WorkflowOpsActivityRow | null {
  if (!isCourtOpsAckPath(id)) return row
  return readCourtOpsAckRow(id, row)
}
