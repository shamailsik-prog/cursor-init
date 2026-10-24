import type { DraftTemplateAnalyticsRow } from "@/platform/spine/store"
import type { TemplateSummary } from "@/services/d4-1/drafts"
import { requireCallerFirmId } from "@/platform/persistence/callerFirm"

/**
 * Audit FA-D4-001: `draft_template_analytics/{id}` was `template:${templateId}`. The template id is a shared catalog id,
 * so every firm composing (or searching) template T wrote the same document and one firm's write replaced or
 * incremented another's row. The id now carries the firm, every write goes through `nextDraftTemplateAnalyticsRow`
 * inside one transaction (repositories' `record`), and a legacy shared row is never read or written by the routes:
 * `scripts/backfill-template-analytics.ts` moves it, or reports it when several firms shared it.
 */

const PREFIX = "template:"

/** A firm or template id that cannot be placed in the id without making it ambiguous or a sub-path. */
export class DraftTemplateAnalyticsIdError extends Error {
  readonly code = "template_analytics_id_invalid"
  constructor(message: string) {
    super(message)
    this.name = "DraftTemplateAnalyticsIdError"
  }
}

export type DraftTemplateAnalyticsRefusal = "foreign_firm" | "malformed"

/** A write refused because the row stored at the caller's own id is another firm's or is not a canonical row. */
export class DraftTemplateAnalyticsRefusedError extends Error {
  readonly code = "template_analytics_refused"
  constructor(
    readonly analyticsId: string,
    readonly reason: DraftTemplateAnalyticsRefusal
  ) {
    super(`template analytics ${analyticsId} refused: ${reason}`)
    this.name = "DraftTemplateAnalyticsRefusedError"
  }
}

function idPart(value: string, label: string): string {
  if (value === "" || value.includes(":") || value.includes("/")) {
    throw new DraftTemplateAnalyticsIdError(`${label} must be non-empty and contain no ':' or '/'`)
  }
  return value
}

/** `template:{firmId}:{templateId}`. Neither part may be empty or contain `:` or `/` (an ambiguous id could be shared). */
export function draftTemplateAnalyticsId(firmId: string, templateId: string): string {
  const firm = idPart(requireCallerFirmId(firmId, "draftTemplateAnalyticsId"), "firmId")
  return `${PREFIX}${firm}:${idPart(templateId, "templateId")}`
}

/** The firm and template of a firm-qualified id; null for a legacy or any other id. */
export function parseDraftTemplateAnalyticsId(id: string): { firmId: string; templateId: string } | null {
  if (!id.startsWith(PREFIX)) return null
  const parts = id.slice(PREFIX.length).split(":")
  if (parts.length !== 2) return null
  const [firmId, templateId] = parts as [string, string]
  if (firmId === "" || templateId === "" || firmId.includes("/") || templateId.includes("/")) return null
  return { firmId, templateId }
}

/** The pre-FA-D4-001 shared id `template:{templateId}`. */
export function isLegacyDraftTemplateAnalyticsId(id: string): boolean {
  if (!id.startsWith(PREFIX)) return false
  const rest = id.slice(PREFIX.length)
  return rest !== "" && !rest.includes(":") && !rest.includes("/")
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const isNullableTime = (value: unknown): value is number | null => value === null || isTime(value)

/**
 * The one validator for a stored row (the F13 canonical-shape pattern). Every field is type-checked, and the document
 * id must be the firm-qualified id of the row's own firm and template: a legacy id, or an id naming another firm or
 * template, is refused (null). The document id wins over any stored `id`.
 */
export function readDraftTemplateAnalyticsRow(id: string, data: unknown): DraftTemplateAnalyticsRow | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null
  const row = data as Record<string, unknown>
  if (typeof row.firmId !== "string" || typeof row.templateId !== "string") return null
  const parsed = parseDraftTemplateAnalyticsId(id)
  if (!parsed || parsed.firmId !== row.firmId || parsed.templateId !== row.templateId) return null
  if (typeof row.templateName !== "string" || typeof row.templatePosture !== "string" || typeof row.templateCategory !== "string") {
    return null
  }
  if (!isCount(row.composeCount) || !isCount(row.templateSearchCount)) return null
  if (!isNullableTime(row.lastComposedAt) || !isNullableTime(row.lastTemplateSearchAt)) return null
  if (row.lastTemplateSearchQuery !== null && typeof row.lastTemplateSearchQuery !== "string") return null
  if (!isTime(row.updatedAt)) return null
  return {
    id,
    firmId: row.firmId,
    templateId: row.templateId,
    templateName: row.templateName,
    templatePosture: row.templatePosture,
    templateCategory: row.templateCategory,
    composeCount: row.composeCount,
    templateSearchCount: row.templateSearchCount,
    lastComposedAt: row.lastComposedAt,
    lastTemplateSearchAt: row.lastTemplateSearchAt,
    lastTemplateSearchQuery: row.lastTemplateSearchQuery,
    updatedAt: row.updatedAt,
  }
}

export function buildDraftTemplateAnalyticsRow(
  firmId: string,
  template: TemplateSummary,
  opts?: { now?: number }
): DraftTemplateAnalyticsRow {
  const now = opts?.now ?? Date.now()
  return {
    id: draftTemplateAnalyticsId(firmId, template.id),
    firmId,
    templateId: template.id,
    templateName: template.name,
    templatePosture: template.posture,
    templateCategory: template.category,
    composeCount: 0,
    templateSearchCount: 0,
    lastComposedAt: null,
    lastTemplateSearchAt: null,
    lastTemplateSearchQuery: null,
    updatedAt: now,
  }
}

export function withTemplateComposed(
  row: DraftTemplateAnalyticsRow,
  opts?: { now?: number }
): DraftTemplateAnalyticsRow {
  const now = opts?.now ?? Date.now()
  return {
    ...row,
    composeCount: row.composeCount + 1,
    lastComposedAt: now,
    updatedAt: now,
  }
}

export function withTemplateSearchSeen(
  row: DraftTemplateAnalyticsRow,
  query: string,
  opts?: { now?: number }
): DraftTemplateAnalyticsRow {
  const now = opts?.now ?? Date.now()
  return {
    ...row,
    templateSearchCount: row.templateSearchCount + 1,
    lastTemplateSearchAt: now,
    lastTemplateSearchQuery: query,
    updatedAt: now,
  }
}

export type DraftTemplateAnalyticsChange = { kind: "compose" } | { kind: "search"; query: string }

/**
 * The next row for one compose or template search of `template` by `firmId`, given what is stored at the firm's own id
 * (`stored`, null when absent). Both repositories call this between the read and the write of one transaction.
 * A stored row of another firm (`foreign_firm`) or one that is not canonical (`malformed`) is refused, never replaced.
 */
export function nextDraftTemplateAnalyticsRow(
  firmId: string,
  template: TemplateSummary,
  stored: unknown,
  change: DraftTemplateAnalyticsChange,
  opts?: { now?: number }
): DraftTemplateAnalyticsRow {
  const firm = requireCallerFirmId(firmId, "draftTemplateAnalytics.record")
  const id = draftTemplateAnalyticsId(firm, template.id)
  let base: DraftTemplateAnalyticsRow
  if (stored === null || stored === undefined) {
    base = buildDraftTemplateAnalyticsRow(firm, template, opts)
  } else {
    if ((stored as { firmId?: unknown }).firmId !== firm) throw new DraftTemplateAnalyticsRefusedError(id, "foreign_firm")
    const row = readDraftTemplateAnalyticsRow(id, stored)
    if (!row) throw new DraftTemplateAnalyticsRefusedError(id, "malformed")
    base = row
  }
  return change.kind === "compose" ? withTemplateComposed(base, opts) : withTemplateSearchSeen(base, change.query, opts)
}
