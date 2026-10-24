import { isClassification } from "@/platform/p1/types"
import type {
  Entity,
  Matter,
  MatterClientSearchIndexRow,
} from "@/platform/spine/store"

/**
 * FA-F13-004 (reporting-index slice): the one validator for a stored `matter_client_search_index/{id}` row, instead of
 * the blind `getById<MatterClientSearchIndexRow>` cast. Every field the search reads is type-checked, so a wrong-typed
 * or partial row (another writer, a legacy row, a manual edit) is refused (null), never handed on as an index row.
 *
 * The document id is authoritative: a stored `id` field is never trusted. `detail` must be a string, including ""
 * when a matter has no case number and no court (FA-F13-008); null is malformed, not an empty detail.
 */

const ROW_TYPES = ["matter", "client"] as const

const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value)
const isNullableId = (value: unknown): value is string | null => value === null || isNonEmpty(value)

/** The canonical index row, or null when the stored row is malformed. */
export function readMatterClientSearchIndexRow(id: string, data: unknown): MatterClientSearchIndexRow | null {
  if (!isNonEmpty(id) || typeof data !== "object" || data === null || Array.isArray(data)) return null
  const row = data as Record<string, unknown>
  if (!isNonEmpty(row.firmId)) return null
  if (!oneOf(ROW_TYPES, row.rowType)) return null
  if (!isNonEmpty(row.referenceId)) return null
  if (!isClassification(row.classification)) return null
  if (typeof row.label !== "string") return null
  if (typeof row.detail !== "string") return null
  if (!isNullableId(row.linkedMatterId)) return null
  if (!isNullableId(row.linkedClientId)) return null
  if (typeof row.status !== "string") return null
  if (!Array.isArray(row.tags) || row.tags.some((tag) => typeof tag !== "string")) return null
  if (typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) return null
  return {
    id,
    firmId: row.firmId,
    rowType: row.rowType,
    referenceId: row.referenceId,
    classification: row.classification,
    label: row.label,
    detail: row.detail,
    linkedMatterId: row.linkedMatterId,
    linkedClientId: row.linkedClientId,
    status: row.status,
    tags: [...row.tags],
    updatedAt: row.updatedAt,
  }
}

/** A stored search-index row that exists but is not in the canonical shape: refused, and distinguishable from absence. */
export class SearchIndexMalformedError extends Error {
  readonly code = "search_index_malformed"
  constructor(readonly indexId: string) {
    super(`search index ${indexId} is malformed`)
    this.name = "SearchIndexMalformedError"
  }
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
}

function uniqueTokens(values: string[]): string[] {
  return [...new Set(values)]
}

export function buildMatterSearchIndexRow(
  matter: Matter,
  opts?: { updatedAt?: number }
): MatterClientSearchIndexRow {
  const detail = matter.caseNumber ?? matter.courtId ?? ""
  return {
    id: `matter:${matter.id}`,
    firmId: matter.firmId,
    rowType: "matter",
    referenceId: matter.id,
    classification: matter.classification,
    label: matter.title,
    detail,
    linkedMatterId: matter.id,
    linkedClientId: matter.clientId,
    status: `${matter.status}:${matter.caseNumberStatus}`,
    tags: uniqueTokens(
      tokenize([matter.title, detail, matter.courtId, matter.clientId].join(" "))
    ),
    updatedAt: opts?.updatedAt ?? Date.now(),
  }
}

export function buildClientSearchIndexRow(
  entity: Entity,
  opts?: { updatedAt?: number }
): MatterClientSearchIndexRow {
  return {
    id: `client:${entity.id}`,
    firmId: entity.firmId,
    rowType: "client",
    referenceId: entity.id,
    classification: entity.classification,
    label: entity.canonicalName,
    detail: entity.phone,
    linkedMatterId: null,
    linkedClientId: entity.id,
    status: "active",
    tags: uniqueTokens(
      tokenize([entity.canonicalName, entity.phone, entity.cnic].join(" "))
    ),
    updatedAt: opts?.updatedAt ?? Date.now(),
  }
}
