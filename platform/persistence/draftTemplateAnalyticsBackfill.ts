import type { DraftTemplateAnalyticsRow } from "@/platform/spine/store"
import {
  draftTemplateAnalyticsId,
  isLegacyDraftTemplateAnalyticsId,
  parseDraftTemplateAnalyticsId,
  readDraftTemplateAnalyticsRow,
} from "@/platform/persistence/draftTemplateAnalytics"

/**
 * FA-D4-001: one-off backfill of legacy `draft_template_analytics/template:{templateId}` rows (one document every firm
 * shared) to `template:{firmId}:{templateId}` (platform/persistence/draftTemplateAnalytics.ts). The F13-003 pattern:
 * a pure plan over rows the caller supplies, a dry-run text naming every row, an apply that writes each move in one
 * transaction (the store) and appends bounded audit rows.
 *
 * - **move**: a legacy row that validates as its stamped firm's row of its own template, when no `drafts` row of that
 *   template belongs to another firm. Apply re-reads both rows, refuses a legacy row changed since planning or a target
 *   that is another firm's or malformed, creates the target (or merges into the row the firm wrote since deploy) and
 *   deletes the legacy row in the same transaction, so a rerun moves nothing.
 * - **unrecoverable**: a legacy row of a template that another firm also drafted: the one document mixed several firms'
 *   counts and cannot be split. Reported with ids only (the path and the firm ids), never moved or deleted.
 * - **canonical**: already at its firm-qualified id. **malformed**: anything else. Both are left as they are.
 */

export const TEMPLATE_ANALYTICS_COLLECTION = "draft_template_analytics"
const LOG = "[backfill-template-analytics]"
const path = (id: string) => `${TEMPLATE_ANALYTICS_COLLECTION}/${id}`

export type AnalyticsBackfillRow = { id: string; data: Record<string, unknown> }

export type PlannedTemplateAnalyticsMove = {
  /** The legacy document id, `template:{templateId}`. */
  from: string
  /** The firm-qualified document id. */
  to: string
  firmId: string
  templateId: string
  /** The legacy row as planned (re-keyed to `to`); apply refuses a legacy row that no longer equals it. */
  snapshot: DraftTemplateAnalyticsRow
}

export type UnrecoverableTemplateAnalyticsRow = { path: string; firmIds: string[] }

export type TemplateAnalyticsBackfillPlan = {
  moves: PlannedTemplateAnalyticsMove[]
  canonical: string[]
  unrecoverable: UnrecoverableTemplateAnalyticsRow[]
  malformed: string[]
}

/** The template ids of the legacy rows: the templates whose `drafts` the loader must read for evidence. */
export function legacyTemplateIds(rows: readonly AnalyticsBackfillRow[]): string[] {
  const ids = new Set<string>()
  for (const row of rows) if (isLegacyDraftTemplateAnalyticsId(row.id)) ids.add(row.id.slice("template:".length))
  return [...ids]
}

/** The validated legacy row re-keyed to its firm-qualified id, or null when it is not a well-formed legacy row. */
function legacyAsCanonical(row: AnalyticsBackfillRow): DraftTemplateAnalyticsRow | null {
  if (!isLegacyDraftTemplateAnalyticsId(row.id)) return null
  const templateId = row.id.slice("template:".length)
  const firmId = row.data.firmId
  if (typeof firmId !== "string" || row.data.templateId !== templateId) return null
  let to: string
  try {
    to = draftTemplateAnalyticsId(firmId, templateId)
  } catch {
    return null
  }
  // The validator also requires the id's firm to equal the stored firmId exactly (a padded firm id is refused).
  return readDraftTemplateAnalyticsRow(to, row.data)
}

/**
 * `draftFirmsByTemplate`: for each legacy template id, the firm ids of every `drafts` row of that template (the
 * compose evidence: each compose wrote one draft and touched the shared row).
 */
export function planTemplateAnalyticsBackfill(
  rows: readonly AnalyticsBackfillRow[],
  draftFirmsByTemplate: ReadonlyMap<string, ReadonlySet<string>>
): TemplateAnalyticsBackfillPlan {
  const plan: TemplateAnalyticsBackfillPlan = { moves: [], canonical: [], unrecoverable: [], malformed: [] }
  for (const row of rows) {
    if (isLegacyDraftTemplateAnalyticsId(row.id)) {
      const snapshot = legacyAsCanonical(row)
      if (!snapshot) {
        plan.malformed.push(path(row.id))
        continue
      }
      const drafted = draftFirmsByTemplate.get(snapshot.templateId) ?? new Set<string>()
      const others = [...drafted].filter((firm) => firm !== snapshot.firmId)
      if (others.length > 0) {
        plan.unrecoverable.push({ path: path(row.id), firmIds: [...new Set([snapshot.firmId, ...others])].sort() })
        continue
      }
      plan.moves.push({ from: row.id, to: snapshot.id, firmId: snapshot.firmId, templateId: snapshot.templateId, snapshot })
      continue
    }
    if (parseDraftTemplateAnalyticsId(row.id) && readDraftTemplateAnalyticsRow(row.id, row.data)) {
      plan.canonical.push(path(row.id))
      continue
    }
    plan.malformed.push(path(row.id))
  }
  return plan
}

const unrecoverableLine = (u: UnrecoverableTemplateAnalyticsRow) => `${LOG} unrecoverable ${u.path} firms=${u.firmIds.join(",")}`

function countsLine(mode: "DRY-RUN" | "APPLY", plan: TemplateAnalyticsBackfillPlan): string {
  return (
    `${LOG} ${mode}: ${plan.moves.length} legacy rows to move, ${plan.canonical.length} already canonical, ` +
    `${plan.unrecoverable.length} unrecoverable (shared by several firms; left as they are), ` +
    `${plan.malformed.length} malformed (left as they are)`
  )
}

/** The dry-run text: the counts line, then every row named (ids only, never counts or query text). */
export function formatTemplateAnalyticsBackfillDryRun(plan: TemplateAnalyticsBackfillPlan): string {
  const lines = [countsLine("DRY-RUN", plan)]
  for (const move of plan.moves) lines.push(`${LOG} move ${path(move.from)} -> ${path(move.to)}`)
  for (const p of plan.canonical) lines.push(`${LOG} canonical ${p}`)
  for (const u of plan.unrecoverable) lines.push(unrecoverableLine(u))
  for (const p of plan.malformed) lines.push(`${LOG} malformed ${p}`)
  return lines.join("\n")
}

/** The APPLY header and the rows apply will leave (unrecoverable, malformed). */
export function formatTemplateAnalyticsBackfillApplyHeader(plan: TemplateAnalyticsBackfillPlan): string {
  return [countsLine("APPLY", plan), ...plan.unrecoverable.map(unrecoverableLine), ...plan.malformed.map((p) => `${LOG} malformed ${p}`)].join("\n")
}

const later = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b))

/**
 * A legacy row merged into the row the same firm wrote at its firm-qualified id after deploy: the two cover disjoint
 * periods, so counts add; each `last*` is the later of the two (the search query goes with its timestamp, the target's
 * on a tie); the target keeps its template metadata.
 */
export function mergeTemplateAnalyticsRows(
  target: DraftTemplateAnalyticsRow,
  legacy: DraftTemplateAnalyticsRow
): DraftTemplateAnalyticsRow {
  const legacySearchLater =
    legacy.lastTemplateSearchAt !== null && (target.lastTemplateSearchAt === null || legacy.lastTemplateSearchAt > target.lastTemplateSearchAt)
  return {
    ...target,
    composeCount: target.composeCount + legacy.composeCount,
    templateSearchCount: target.templateSearchCount + legacy.templateSearchCount,
    lastComposedAt: later(target.lastComposedAt, legacy.lastComposedAt),
    lastTemplateSearchAt: legacySearchLater ? legacy.lastTemplateSearchAt : target.lastTemplateSearchAt,
    lastTemplateSearchQuery: legacySearchLater ? legacy.lastTemplateSearchQuery : target.lastTemplateSearchQuery,
    updatedAt: Math.max(target.updatedAt, legacy.updatedAt),
  }
}

export type TemplateAnalyticsMoveRejection = "legacy_gone" | "legacy_changed" | "target_foreign_firm" | "target_malformed"

export type TemplateAnalyticsMoveOutcome =
  | { status: "moved" }
  | { status: "merged" }
  | { status: "rejected"; reason: TemplateAnalyticsMoveRejection }

const sameRow = (a: DraftTemplateAnalyticsRow, b: DraftTemplateAnalyticsRow) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The decision of one move, from the two rows read in its transaction. `write` is the target row to set (and the legacy
 * row is then deleted in that transaction); absent when the move is rejected.
 */
export function decideTemplateAnalyticsMove(
  planned: PlannedTemplateAnalyticsMove,
  legacyStored: unknown,
  targetStored: unknown
): { outcome: TemplateAnalyticsMoveOutcome; write?: DraftTemplateAnalyticsRow } {
  if (legacyStored === null || legacyStored === undefined) return { outcome: { status: "rejected", reason: "legacy_gone" } }
  const legacy = readDraftTemplateAnalyticsRow(planned.to, legacyStored)
  if (!legacy || !sameRow(legacy, planned.snapshot)) return { outcome: { status: "rejected", reason: "legacy_changed" } }
  if (targetStored === null || targetStored === undefined) return { outcome: { status: "moved" }, write: legacy }
  if ((targetStored as { firmId?: unknown }).firmId !== planned.firmId) {
    return { outcome: { status: "rejected", reason: "target_foreign_firm" } }
  }
  const target = readDraftTemplateAnalyticsRow(planned.to, targetStored)
  if (!target) return { outcome: { status: "rejected", reason: "target_malformed" } }
  return { outcome: { status: "merged" }, write: mergeTemplateAnalyticsRows(target, legacy) }
}

export type TemplateAnalyticsBackfillAuditRow = {
  id: string
  firmId: string
  action: "template_analytics_backfill"
  actorId: string
  target: string
  classification: "internal"
  reason: string
  at: number
  runId: string
  planned?: string[]
  moved?: string[]
  merged?: string[]
  rejected?: { path: string; reason: TemplateAnalyticsMoveRejection }[]
  failed?: { path: string; message: string }[]
  unrecoverable?: UnrecoverableTemplateAnalyticsRow[]
  malformed?: string[]
  movedCount?: number
  mergedCount?: number
  rejectedCount?: number
  failedCount?: number
  unrecoverableCount?: number
  malformedCount?: number
  canonicalCount?: number
  batches?: number
}

export type TemplateAnalyticsBackfillStore = {
  /** In one transaction: reads the legacy and target rows, `decideTemplateAnalyticsMove`, then sets the target and deletes the legacy row. */
  move(planned: PlannedTemplateAnalyticsMove): Promise<TemplateAnalyticsMoveOutcome>
  /** Creates one audit row; never overwrites one. */
  appendAudit(row: TemplateAnalyticsBackfillAuditRow): Promise<void>
}

export const TEMPLATE_ANALYTICS_BACKFILL_AUDIT_FIRM_ID = "_platform"
export const TEMPLATE_ANALYTICS_BACKFILL_ACTOR_ID = "system:backfill-template-analytics"
/** The most paths one audit row (and one batch of moves) carries, as the F13-003 backfill. */
export const TEMPLATE_ANALYTICS_BACKFILL_AUDIT_BATCH = 200

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export type TemplateAnalyticsBackfillResult = {
  moved: string[]
  merged: string[]
  rejected: { path: string; reason: TemplateAnalyticsMoveRejection }[]
  failed: { path: string; message: string }[]
}

/**
 * Writes the plan. A run appends, under `aud_template_analytics_backfill_{runId}`: `_b{k}_planned` before each batch of
 * moves and `_b{k}_done` after it, `_unrecoverable_{k}` / `_malformed_{k}` chunks (ids only), and the summary (counts
 * only) last. A thrown move is recorded on its batch's done row and the run continues (FA-F13-033).
 */
export async function applyTemplateAnalyticsBackfill(
  store: TemplateAnalyticsBackfillStore,
  plan: TemplateAnalyticsBackfillPlan,
  meta: { runId: string; now: number }
): Promise<TemplateAnalyticsBackfillResult> {
  const base = `aud_template_analytics_backfill_${meta.runId}`
  const audit = (id: string, reason: string, extra: Partial<TemplateAnalyticsBackfillAuditRow>): TemplateAnalyticsBackfillAuditRow => ({
    id,
    firmId: TEMPLATE_ANALYTICS_BACKFILL_AUDIT_FIRM_ID,
    action: "template_analytics_backfill",
    actorId: TEMPLATE_ANALYTICS_BACKFILL_ACTOR_ID,
    target: TEMPLATE_ANALYTICS_COLLECTION,
    classification: "internal",
    reason,
    at: meta.now,
    runId: meta.runId,
    ...extra,
  })
  const result: TemplateAnalyticsBackfillResult = { moved: [], merged: [], rejected: [], failed: [] }
  const batches = chunks(plan.moves, TEMPLATE_ANALYTICS_BACKFILL_AUDIT_BATCH)
  for (const [k, batch] of batches.entries()) {
    const paths = batch.map((move) => path(move.from))
    await store.appendAudit(audit(`${base}_b${k}_planned`, `batch ${k}: ${paths.length} planned`, { planned: paths }))
    const done: TemplateAnalyticsBackfillResult = { moved: [], merged: [], rejected: [], failed: [] }
    for (const [i, move] of batch.entries()) {
      const p = paths[i] as string
      try {
        const outcome = await store.move(move)
        if (outcome.status === "moved") done.moved.push(p)
        else if (outcome.status === "merged") done.merged.push(p)
        else done.rejected.push({ path: p, reason: outcome.reason })
      } catch (err) {
        done.failed.push({ path: p, message: err instanceof Error ? err.message : String(err) })
      }
    }
    await store.appendAudit(
      audit(
        `${base}_b${k}_done`,
        `batch ${k}: ${done.moved.length} moved, ${done.merged.length} merged, ${done.rejected.length} rejected at apply, ${done.failed.length} failed`,
        {
          moved: done.moved,
          merged: done.merged,
          ...(done.rejected.length ? { rejected: done.rejected } : {}),
          ...(done.failed.length ? { failed: done.failed } : {}),
        }
      )
    )
    result.moved.push(...done.moved)
    result.merged.push(...done.merged)
    result.rejected.push(...done.rejected)
    result.failed.push(...done.failed)
  }
  for (const [k, part] of chunks(plan.unrecoverable, TEMPLATE_ANALYTICS_BACKFILL_AUDIT_BATCH).entries()) {
    await store.appendAudit(
      audit(`${base}_unrecoverable_${k}`, `${part.length} unrecoverable (shared by several firms; not moved)`, { unrecoverable: part })
    )
  }
  for (const [k, part] of chunks(plan.malformed, TEMPLATE_ANALYTICS_BACKFILL_AUDIT_BATCH).entries()) {
    await store.appendAudit(audit(`${base}_malformed_${k}`, `${part.length} malformed (not written)`, { malformed: part }))
  }
  await store.appendAudit(
    audit(
      base,
      `${result.moved.length} moved, ${result.merged.length} merged, ${result.rejected.length} rejected at apply, ` +
        `${result.failed.length} failed, ${plan.unrecoverable.length} unrecoverable, ${plan.malformed.length} malformed, ` +
        `${plan.canonical.length} already canonical`,
      {
        movedCount: result.moved.length,
        mergedCount: result.merged.length,
        rejectedCount: result.rejected.length,
        failedCount: result.failed.length,
        unrecoverableCount: plan.unrecoverable.length,
        malformedCount: plan.malformed.length,
        canonicalCount: plan.canonical.length,
        batches: batches.length,
      }
    )
  )
  return result
}
