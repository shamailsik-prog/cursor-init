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

/** The canonical record, or null when the stored row is malformed. */
export function readDocumentRecord(id: string, data: unknown): DocumentRecord | null {
  if (!isNonEmpty(id) || typeof data !== "object" || data === null || Array.isArray(data)) return null
  const row = data as Record<string, unknown>
  if (!isNonEmpty(row.firmId)) return null
  if (!(row.matterId === null || isNonEmpty(row.matterId))) return null
  if (typeof row.contentHash !== "string") return null
  if (!oneOf(SOURCE_CHANNELS, row.sourceChannel)) return null
  if (!isClassification(row.classification)) return null
  if (typeof row.storagePath !== "string") return null
  if (typeof row.isImmutable !== "boolean") return null
  if (!isCount(row.byteSize)) return null
  if (typeof row.mimeType !== "string") return null
  if (!isCount(row.objectVersion)) return null
  if (!isNonEmpty(row.uploadedBy)) return null
  const objectBytesStatus = row.objectBytesStatus === undefined ? "missing" : row.objectBytesStatus
  if (!oneOf(BYTES_STATUSES, objectBytesStatus)) return null
  return {
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
  } as DocumentRecord
}

/** A stored document row that exists but is not in the canonical shape: refused, and distinguishable from absence. */
export class DocumentMalformedError extends Error {
  readonly code = "document_malformed"
  constructor(readonly documentId: string) {
    super(`document ${documentId} is malformed`)
    this.name = "DocumentMalformedError"
  }
}
