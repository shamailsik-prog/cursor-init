import { isClassification, type Classification } from "@/platform/p1/types"

/**
 * Audit F13 (HIGH): the one canonical Firestore shape of `matters/{matterId}` and
 * `matter_members/{matterId}_{userId}`, shared by both API stacks. This module is the schema owner: Cloud Functions
 * (functions/src/d1/matter/ops.ts) and the Next repositories (platform/persistence/firestoreSpineRepositories.ts)
 * build every matter / membership document they write through it, and read every one they load through
 * `readMatterDocument`, the single validator. It imports nothing but the shared classification labels, so the
 * Functions bundle and the Next server share the same code.
 *
 * The field set is the one firestore.rules already fences (matters update: caseNumber, caseNumberStatus, courtId,
 * stage, status, clientId, matterNo, conflictCheckId, closedBy, closedAt, createdBy, createdAt). The document id is the
 * matter id: a stored `id` field is never authoritative (F14 R8), so it is dropped on read and never written.
 *
 * Rows stored before the fix are read with defaults, never refused for a field one stack did not write:
 * Functions rows had no courtId (when none was given), caseNumber or caseNumberStatus; Next rows had no matterNo,
 * stage, conflictCheckId or createdBy. A Next row with no stage was opened by Next, which has no stage flow: it is at
 * `pre_filing`. A row with a wrong-typed or unknown value is malformed and both stacks refuse it.
 */

export const MATTER_STAGES = ["pre_filing", "filed", "hearing", "reserved", "decided", "archived"] as const
export type MatterStage = (typeof MATTER_STAGES)[number]

export const MATTER_STATUSES = ["engagement_unconfirmed", "live", "closed"] as const
export type MatterStatus = (typeof MATTER_STATUSES)[number]

export const CASE_NUMBER_STATUSES = ["pending", "recorded"] as const
export type CaseNumberStatus = (typeof CASE_NUMBER_STATUSES)[number]

/** The canonical fields of a matter document (timestamps and closure fields ride along unvalidated). */
export type MatterFields = {
  firmId: string
  clientId: string
  title: string
  classification: Classification
  matterNo: string | null
  stage: MatterStage
  status: MatterStatus
  courtId: string | null
  caseNumber: string | null
  caseNumberStatus: CaseNumberStatus
  conflictCheckId: string | null
  createdBy: string | null
}

export type MatterDocument = MatterFields & Record<string, unknown>

/** A matter document that is not in the canonical shape (409 matter_malformed on the Functions API). */
export class MatterShapeError extends Error {
  readonly code = "matter_malformed"
  constructor(reason: string) {
    super(`matter document is malformed: ${reason}`)
    this.name = "MatterShapeError"
  }
}

/** FA-F13-005 / 007: a write refused because the stored matter is closed (closing is final; Next never reopens). */
export class MatterClosedError extends Error {
  readonly code = "matter_closed"
  constructor() {
    super("matter is closed")
    this.name = "MatterClosedError"
  }
}

const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== ""
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === "string" && (values as readonly string[]).includes(v)

/** `value` when it is a string, null when absent or null; `undefined` when wrong-typed (malformed). */
function nullableString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  return typeof value === "string" ? value : undefined
}

function canonicalOrReason(data: unknown): MatterDocument | string {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return "not an object"
  const { id: _storedId, ...row } = data as Record<string, unknown>
  if (!isNonEmpty(row.firmId)) return "firmId"
  if (!isNonEmpty(row.clientId)) return "clientId"
  if (typeof row.title !== "string") return "title"
  if (!isClassification(row.classification)) return "classification"
  if (!oneOf(MATTER_STATUSES, row.status)) return "status"
  const stage = row.stage === undefined ? "pre_filing" : row.stage
  if (!oneOf(MATTER_STAGES, stage)) return "stage"
  const caseNumberStatus = row.caseNumberStatus === undefined ? "pending" : row.caseNumberStatus
  if (!oneOf(CASE_NUMBER_STATUSES, caseNumberStatus)) return "caseNumberStatus"
  const nullable = {
    matterNo: nullableString(row.matterNo),
    courtId: nullableString(row.courtId),
    caseNumber: nullableString(row.caseNumber),
    conflictCheckId: nullableString(row.conflictCheckId),
    createdBy: nullableString(row.createdBy),
  }
  for (const [field, value] of Object.entries(nullable)) if (value === undefined) return field
  return {
    ...row,
    firmId: row.firmId,
    clientId: row.clientId,
    title: row.title,
    classification: row.classification,
    stage,
    status: row.status,
    caseNumberStatus,
    ...(nullable as { [K in keyof typeof nullable]: string | null }),
  }
}

/** The single validator: the canonical document, or null when `data` is malformed. */
export function readMatterDocument(data: unknown): MatterDocument | null {
  const out = canonicalOrReason(data)
  return typeof out === "string" ? null : out
}

/** The canonical document to write (validated by `readMatterDocument`'s rules); throws MatterShapeError otherwise. */
export function canonicalMatterDocument(data: unknown): MatterDocument {
  const out = canonicalOrReason(data)
  if (typeof out === "string") throw new MatterShapeError(out)
  return out
}

/** The canonical fields of a membership row (`createdAt` is the writer's server timestamp). */
export type MatterMemberFields = {
  firmId: string
  matterId: string
  userId: string
  addedBy: string | null
  classification: Classification
}

export const matterMemberDocId = (matterId: string, userId: string): string => `${matterId}_${userId}`

/** The canonical membership row to write; throws MatterShapeError when a field is missing or wrong-typed. */
export function canonicalMatterMemberDocument(row: {
  firmId: unknown
  matterId: unknown
  userId: unknown
  addedBy?: unknown
  classification: unknown
}): MatterMemberFields {
  if (!isNonEmpty(row.firmId)) throw new MatterShapeError("member firmId")
  if (!isNonEmpty(row.matterId)) throw new MatterShapeError("member matterId")
  if (!isNonEmpty(row.userId)) throw new MatterShapeError("member userId")
  const addedBy = nullableString(row.addedBy)
  if (addedBy === undefined) throw new MatterShapeError("member addedBy")
  if (!isClassification(row.classification)) throw new MatterShapeError("member classification")
  return { firmId: row.firmId, matterId: row.matterId, userId: row.userId, addedBy, classification: row.classification }
}

/** Whether a stored membership row is complete (Cloud Functions orders listMatters by its `createdAt`). */
export function isCanonicalMatterMemberRow(data: unknown, matterId: string, userId: string, firmId: string): boolean {
  if (typeof data !== "object" || data === null) return false
  const row = data as Record<string, unknown>
  return (
    row.firmId === firmId &&
    row.matterId === matterId &&
    row.userId === userId &&
    isClassification(row.classification) &&
    row.createdAt !== undefined &&
    row.createdAt !== null
  )
}
