import { isClassification } from "@/platform/p1/types"
import type { DocumentRecord } from "@/platform/spine/store"

/**
 * FA-F13-004 (documents slice): the one validator for a stored `documents/{documentId}` row, instead of the blind
 * `getById<DocumentRecord>` cast. Every field the code reads is type-checked, so a wrong-typed or partial row (another
 * writer, a legacy row, a manual edit) is refused (null), never handed on as a `DocumentRecord`.
 *
 * - The document id is authoritative: a stored `id` field is never trusted (as F14 R8 rules for matters).
 * - `matterId` must be present (a string or null): an absent one is malformed, not read as the loose vault, so a row
 *   can never widen its own audience by omission (the jobs backfill treats it the same way).
 * - `objectBytesStatus` predates nothing on its own: an absent one reads as "missing" (fail closed: the bytes are
 *   unverified), so no download is served from a row that never recorded them.
 */

const SOURCE_CHANNELS = ["web", "team_portal", "whatsapp", "bulk"] as const
const BYTES_STATUSES = ["available", "missing"] as const

const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== ""
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === "string" && (values as readonly string[]).includes(v)
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0

type ParsedDocument = { ok: true; record: DocumentRecord } | { ok: false; reason: string }

/** The first field that makes a stored row unreadable, or a readable canonical record. */
function parseDocumentRecord(id: string, data: unknown): ParsedDocument {
  if (!isNonEmpty(id)) return { ok: false, reason: "id" }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, reason: "shape" }
  const row = data as Record<string, unknown>
  if (!isNonEmpty(row.firmId)) return { ok: false, reason: "firmId" }
  if (!(row.matterId === null || isNonEmpty(row.matterId))) return { ok: false, reason: "matterId" }
  if (typeof row.contentHash !== "string") return { ok: false, reason: "contentHash" }
  if (!oneOf(SOURCE_CHANNELS, row.sourceChannel)) return { ok: false, reason: "sourceChannel" }
  if (!isClassification(row.classification)) return { ok: false, reason: "classification" }
  if (typeof row.storagePath !== "string") return { ok: false, reason: "storagePath" }
  if (typeof row.isImmutable !== "boolean") return { ok: false, reason: "isImmutable" }
  if (!isCount(row.byteSize)) return { ok: false, reason: "byteSize" }
  if (typeof row.mimeType !== "string") return { ok: false, reason: "mimeType" }
  if (!isCount(row.objectVersion)) return { ok: false, reason: "objectVersion" }
  if (!isNonEmpty(row.uploadedBy)) return { ok: false, reason: "uploadedBy" }
  const objectBytesStatus = row.objectBytesStatus === undefined ? "missing" : row.objectBytesStatus
  if (!oneOf(BYTES_STATUSES, objectBytesStatus)) return { ok: false, reason: "objectBytesStatus" }
  return {
    ok: true,
    record: {
      ...(row as Record<string, unknown>),
      id,
      firmId: row.firmId,
      matterId: row.matterId,
      contentHash: row.contentHash,
      sourceChannel: row.sourceChannel,
      classification: row.classification,
      storagePath: row.storagePath,
      isImmutable: row.isImmutable,
      byteSize: row.byteSize,
      mimeType: row.mimeType,
      objectVersion: row.objectVersion,
      uploadedBy: row.uploadedBy,
      objectBytesStatus,
    } as DocumentRecord,
  }
}

/** The canonical record, or null when the stored row is malformed. */
export function readDocumentRecord(id: string, data: unknown): DocumentRecord | null {
  const parsed = parseDocumentRecord(id, data)
  return parsed.ok ? parsed.record : null
}

/** Why `readDocumentRecord` refused the row, or null when the row is readable. */
export function documentRecordRefusal(id: string, data: unknown): string | null {
  const parsed = parseDocumentRecord(id, data)
  return parsed.ok ? null : parsed.reason
}

export type DroppedDocument = { id: string; reason: string }

/** Valid rows to return, and the firm rows the reader refused, with the first failing field. */
export function partitionFirmDocuments(rows: readonly { id: string }[]): {
  items: DocumentRecord[]
  droppedDocuments: DroppedDocument[]
} {
  const items: DocumentRecord[] = []
  const droppedDocuments: DroppedDocument[] = []
  for (const row of rows) {
    const doc = readDocumentRecord(row.id, row)
    if (doc) items.push(doc)
    else droppedDocuments.push({ id: row.id, reason: documentRecordRefusal(row.id, row) ?? "malformed" })
  }
  return { items, droppedDocuments }
}

/**
 * FA-F13-028: the document to write on create. A row the reader refuses throws, and the caller must not write.
 * The returned record is canonical: the id argument wins, and an absent `objectBytesStatus` is `missing`.
 */
export function canonicalDocumentForCreate(row: unknown): DocumentRecord {
  const id = row !== null && typeof row === "object" && typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id : ""
  const parsed = readDocumentRecord(id, row)
  if (!parsed) throw new DocumentMalformedError(id.trim() !== "" ? id : "unknown")
  return parsed
}

/** A stored document row that exists but is not in the canonical shape: refused, and distinguishable from absence. */
export class DocumentMalformedError extends Error {
  readonly code = "document_malformed"
  constructor(readonly documentId: string) {
    super(`document ${documentId} is malformed`)
    this.name = "DocumentMalformedError"
  }
}
