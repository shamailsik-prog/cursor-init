import type { WorkflowOpsActivityRow } from "@/platform/spine/store"
import {
  isCourtOpsAckPath,
  readCourtOpsAckRow,
  readLegacyCourtOpsAckRow,
  type CourtOpsAckQueueType,
} from "@/platform/persistence/courtOpsAcknowledgement"

/**
 * FA-D4-001-FU1 (spec R12, R13): one-off backfill of legacy court-ops acknowledgement rows
 * `workflow_ops_activity/ops:court_ops:ack:{queueType}:{itemId}` (one document every firm shared for an item id) to
 * `ops:court_ops:ack:{firmId}:{queueType}:{itemId}` (platform/persistence/courtOpsAcknowledgement.ts). The F13-003 /
 * FA-D4-001 pattern: a pure plan over rows the caller supplies, a dry-run text naming every ack row (ids only), an apply
 * that writes each move in one transaction (the store) and appends bounded audit rows. With the FA-D4-001-R1-004
 * lessons: a row an operator must look at is reported as "needs operator review" (exit 2), never "rerun to retry", and the
 * dry run already shows every conflict it can know of.
 *
 * - **move**: a legacy row that validates as its stamped firm's acknowledgement of its own item, when the item is that
 *   firm's (`document_workflow/{itemId}` or `follow_ups/{itemId}` carries the firm). Apply re-reads both rows, creates the
 *   target (or, when the firm acknowledged again after deploy, keeps the later of the two) and deletes the legacy row in
 *   the same transaction, so a rerun moves nothing.
 * - **needs operator review** (left as they are, ids only):
 *   - `item_not_in_firm`: the item is absent or another firm's (a cross-firm write, or an acknowledgement of an unknown id);
 *   - `malformed`: an ack-prefixed row that is neither canonical nor a consistent legacy row (FU1b's arbitrary queueType,
 *     a row planted at another firm's id);
 *   - `target_conflict`: the target id holds another firm's row or a malformed one;
 *   - `nested`: a document under an ack-prefixed parent (FU1b's `/`), which no rule matches and no route reads.
 * - **canonical**: already at its firm-qualified id. Rows outside the prefix are not the backfill's.
 */

export const COURT_OPS_ACK_COLLECTION = "workflow_ops_activity"
const LOG = "[backfill-court-ops-acks]"
const path = (id: string) => `${COURT_OPS_ACK_COLLECTION}/${id}`

export type CourtOpsAckBackfillRow = { id: string; data: Record<string, unknown> }
/** A document found under an ack-prefixed parent: its path from the database root. */
export type NestedCourtOpsAckDocument = { path: string }

/** The key of an item in the loader's evidence map. */
export const courtOpsAckItemKey = (queueType: CourtOpsAckQueueType, itemId: string) => `${queueType}:${itemId}`

export type PlannedCourtOpsAckMove = {
  /** The legacy document id. */
  from: string
  /** The firm-qualified document id. */
  to: string
  firmId: string
  /** The legacy row as planned (re-keyed to `to`); apply refuses a legacy row that no longer equals it. */
  snapshot: WorkflowOpsActivityRow
}

export type CourtOpsAckOperatorReason = "item_not_in_firm" | "malformed" | "target_conflict" | "nested"
export type CourtOpsAckNeedsOperator = { path: string; reason: CourtOpsAckOperatorReason; firmIds?: string[] }

export type CourtOpsAckBackfillPlan = {
  moves: PlannedCourtOpsAckMove[]
  canonical: string[]
  needsOperator: CourtOpsAckNeedsOperator[]
}

const firmIdsOf = (...values: unknown[]): string[] =>
  [...new Set(values.filter((v): v is string => typeof v === "string" && v !== ""))].sort()

/** The items of the legacy rows: the `document_workflow` / `follow_ups` rows the loader reads for evidence. */
export function legacyCourtOpsAckItems(rows: readonly CourtOpsAckBackfillRow[]): Array<{ queueType: CourtOpsAckQueueType; itemId: string }> {
  const items = new Map<string, { queueType: CourtOpsAckQueueType; itemId: string }>()
  for (const row of rows) {
    const legacy = readLegacyCourtOpsAckRow(row.id, row.data)
    if (!legacy || !legacy.queueType) continue
    const itemId = (legacy.queueType === "workflow" ? legacy.documentId : legacy.followUpId) as string
    items.set(courtOpsAckItemKey(legacy.queueType, itemId), { queueType: legacy.queueType, itemId })
  }
  return [...items.values()]
}

/**
 * `itemFirms`: for each legacy row's item (`courtOpsAckItemKey`), the firm id its `document_workflow` or `follow_ups` row
 * carries, or null when there is none.
 */
export function planCourtOpsAckBackfill(
  rows: readonly CourtOpsAckBackfillRow[],
  nested: readonly NestedCourtOpsAckDocument[],
  itemFirms: ReadonlyMap<string, string | null>
): CourtOpsAckBackfillPlan {
  const plan: CourtOpsAckBackfillPlan = { moves: [], canonical: [], needsOperator: [] }
  const byId = new Map(rows.map((row) => [row.id, row.data]))
  for (const row of rows) {
    if (!isCourtOpsAckPath(row.id)) continue
    if (readCourtOpsAckRow(row.id, row.data)) {
      plan.canonical.push(path(row.id))
      continue
    }
    const legacy = readLegacyCourtOpsAckRow(row.id, row.data)
    if (!legacy || !legacy.queueType) {
      const firmIds = firmIdsOf(row.data.firmId)
      plan.needsOperator.push({ path: path(row.id), reason: "malformed", ...(firmIds.length ? { firmIds } : {}) })
      continue
    }
    const itemId = (legacy.queueType === "workflow" ? legacy.documentId : legacy.followUpId) as string
    const itemFirm = itemFirms.get(courtOpsAckItemKey(legacy.queueType, itemId)) ?? null
    if (itemFirm !== legacy.firmId) {
      plan.needsOperator.push({ path: path(row.id), reason: "item_not_in_firm", firmIds: firmIdsOf(legacy.firmId, itemFirm) })
      continue
    }
    const target = byId.get(legacy.id)
    if (target !== undefined && (target.firmId !== legacy.firmId || !readCourtOpsAckRow(legacy.id, target))) {
      plan.needsOperator.push({ path: path(row.id), reason: "target_conflict", firmIds: firmIdsOf(legacy.firmId, target.firmId) })
      continue
    }
    plan.moves.push({ from: row.id, to: legacy.id, firmId: legacy.firmId, snapshot: legacy })
  }
  for (const doc of nested) plan.needsOperator.push({ path: doc.path, reason: "nested" })
  return plan
}

const operatorLine = (n: { path: string; reason: string; firmIds?: string[] }) =>
  `${LOG} needs operator review ${n.path} ${n.reason}${n.firmIds?.length ? ` firms=${n.firmIds.join(",")}` : ""}`

function countsLine(mode: "DRY-RUN" | "APPLY", plan: CourtOpsAckBackfillPlan): string {
  return (
    `${LOG} ${mode}: ${plan.moves.length} legacy rows to move, ${plan.canonical.length} already canonical, ` +
    `${plan.needsOperator.length} need operator review (left as they are)`
  )
}

/** The dry-run text: the counts line, then every ack row named (ids only, never detail, actor or tags). */
export function formatCourtOpsAckBackfillDryRun(plan: CourtOpsAckBackfillPlan): string {
  const lines = [countsLine("DRY-RUN", plan)]
  for (const move of plan.moves) lines.push(`${LOG} move ${path(move.from)} -> ${path(move.to)}`)
  for (const p of plan.canonical) lines.push(`${LOG} canonical ${p}`)
  for (const n of plan.needsOperator) lines.push(operatorLine(n))
  return lines.join("\n")
}

/** The APPLY header and the rows apply will leave for an operator. */
export function formatCourtOpsAckBackfillApplyHeader(plan: CourtOpsAckBackfillPlan): string {
  return [countsLine("APPLY", plan), ...plan.needsOperator.map(operatorLine)].join("\n")
}

/** Overtaken since planning: a rerun replans from what is stored and finishes the job. */
export type CourtOpsAckRetryRejection = "legacy_gone" | "legacy_changed"
/** The target turned out another firm's or malformed at apply: no rerun can fix it. */
export type CourtOpsAckOperatorRejection = "target_foreign_firm" | "target_malformed"
export type CourtOpsAckMoveRejection = CourtOpsAckRetryRejection | CourtOpsAckOperatorRejection

export type CourtOpsAckMoveOutcome =
  | { status: "moved" }
  | { status: "merged" }
  | { status: "rejected"; reason: CourtOpsAckMoveRejection }

const sameRow = (a: WorkflowOpsActivityRow, b: WorkflowOpsActivityRow) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The decision of one move, from the two rows read in its transaction. `write` is the target row to set (and the legacy
 * row is then deleted in that transaction); absent when the move is rejected. When the firm acknowledged the item again
 * after deploy, the later acknowledgement (by createdAt) is kept; on a tie, the target.
 */
export function decideCourtOpsAckMove(
  planned: PlannedCourtOpsAckMove,
  legacyStored: unknown,
  targetStored: unknown
): { outcome: CourtOpsAckMoveOutcome; write?: WorkflowOpsActivityRow } {
  if (legacyStored === null || legacyStored === undefined) return { outcome: { status: "rejected", reason: "legacy_gone" } }
  const legacy = readLegacyCourtOpsAckRow(planned.from, legacyStored)
  if (!legacy || !sameRow(legacy, planned.snapshot)) return { outcome: { status: "rejected", reason: "legacy_changed" } }
  if (targetStored === null || targetStored === undefined) return { outcome: { status: "moved" }, write: legacy }
  if ((targetStored as { firmId?: unknown }).firmId !== planned.firmId) {
    return { outcome: { status: "rejected", reason: "target_foreign_firm" } }
  }
  const target = readCourtOpsAckRow(planned.to, targetStored)
  if (!target) return { outcome: { status: "rejected", reason: "target_malformed" } }
  return { outcome: { status: "merged" }, write: legacy.createdAt > target.createdAt ? legacy : target }
}

const isRetryRejection = (reason: CourtOpsAckMoveRejection): reason is CourtOpsAckRetryRejection =>
  reason === "legacy_gone" || reason === "legacy_changed"

export type CourtOpsAckBackfillAuditRow = {
  id: string
  firmId: string
  action: "court_ops_ack_backfill"
  actorId: string
  target: string
  classification: "internal"
  reason: string
  at: number
  runId: string
  planned?: string[]
  moved?: string[]
  merged?: string[]
  retry?: { path: string; reason: CourtOpsAckRetryRejection }[]
  failed?: { path: string; message: string }[]
  needsOperator?: { path: string; reason: CourtOpsAckOperatorReason | CourtOpsAckOperatorRejection; firmIds?: string[] }[]
  movedCount?: number
  mergedCount?: number
  retryCount?: number
  failedCount?: number
  needsOperatorCount?: number
  canonicalCount?: number
  batches?: number
}

export type CourtOpsAckBackfillStore = {
  /** In one transaction: reads the legacy and target rows, `decideCourtOpsAckMove`, then sets the target and deletes the legacy row. */
  move(planned: PlannedCourtOpsAckMove): Promise<CourtOpsAckMoveOutcome>
  /** Creates one audit row; never overwrites one. */
  appendAudit(row: CourtOpsAckBackfillAuditRow): Promise<void>
}

export const COURT_OPS_ACK_BACKFILL_AUDIT_FIRM_ID = "_platform"
export const COURT_OPS_ACK_BACKFILL_ACTOR_ID = "system:backfill-court-ops-acks"
/** The most paths one audit row (and one batch of moves) carries, as the F13-003 backfill. */
export const COURT_OPS_ACK_BACKFILL_AUDIT_BATCH = 200

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export type CourtOpsAckBackfillResult = {
  moved: string[]
  merged: string[]
  /** Overtaken since planning: rerun to retry. */
  retry: { path: string; reason: CourtOpsAckRetryRejection }[]
  /** Rejected at apply for a reason no rerun fixes. */
  needsOperator: { path: string; reason: CourtOpsAckOperatorRejection }[]
  /** The move threw (a transient store failure): rerun to retry. */
  failed: { path: string; message: string }[]
}

const emptyResult = (): CourtOpsAckBackfillResult => ({ moved: [], merged: [], retry: [], needsOperator: [], failed: [] })

/**
 * Writes the plan. A run appends, under `aud_court_ops_ack_backfill_{runId}`: `_b{k}_planned` before each batch of moves
 * and `_b{k}_done` after it, `_needs_operator_{k}` chunks (ids only), and the summary (counts only) last. A thrown move
 * is recorded on its batch's done row and the run continues (FA-F13-033).
 */
export async function applyCourtOpsAckBackfill(
  store: CourtOpsAckBackfillStore,
  plan: CourtOpsAckBackfillPlan,
  meta: { runId: string; now: number }
): Promise<CourtOpsAckBackfillResult> {
  const base = `aud_court_ops_ack_backfill_${meta.runId}`
  const audit = (id: string, reason: string, extra: Partial<CourtOpsAckBackfillAuditRow>): CourtOpsAckBackfillAuditRow => ({
    id,
    firmId: COURT_OPS_ACK_BACKFILL_AUDIT_FIRM_ID,
    action: "court_ops_ack_backfill",
    actorId: COURT_OPS_ACK_BACKFILL_ACTOR_ID,
    target: COURT_OPS_ACK_COLLECTION,
    classification: "internal",
    reason,
    at: meta.now,
    runId: meta.runId,
    ...extra,
  })
  const result = emptyResult()
  const batches = chunks(plan.moves, COURT_OPS_ACK_BACKFILL_AUDIT_BATCH)
  for (const [k, batch] of batches.entries()) {
    const paths = batch.map((move) => path(move.from))
    await store.appendAudit(audit(`${base}_b${k}_planned`, `batch ${k}: ${paths.length} planned`, { planned: paths }))
    const done = emptyResult()
    for (const [i, move] of batch.entries()) {
      const p = paths[i] as string
      try {
        const outcome = await store.move(move)
        if (outcome.status === "moved") done.moved.push(p)
        else if (outcome.status === "merged") done.merged.push(p)
        else if (isRetryRejection(outcome.reason)) done.retry.push({ path: p, reason: outcome.reason })
        else done.needsOperator.push({ path: p, reason: outcome.reason })
      } catch (err) {
        done.failed.push({ path: p, message: err instanceof Error ? err.message : String(err) })
      }
    }
    await store.appendAudit(
      audit(
        `${base}_b${k}_done`,
        `batch ${k}: ${done.moved.length} moved, ${done.merged.length} merged, ${done.retry.length} overtaken, ` +
          `${done.needsOperator.length} need operator review, ${done.failed.length} failed`,
        {
          moved: done.moved,
          merged: done.merged,
          ...(done.retry.length ? { retry: done.retry } : {}),
          ...(done.needsOperator.length ? { needsOperator: done.needsOperator } : {}),
          ...(done.failed.length ? { failed: done.failed } : {}),
        }
      )
    )
    for (const key of ["moved", "merged", "retry", "needsOperator", "failed"] as const) {
      ;(result[key] as unknown[]).push(...done[key])
    }
  }
  for (const [k, part] of chunks(plan.needsOperator, COURT_OPS_ACK_BACKFILL_AUDIT_BATCH).entries()) {
    await store.appendAudit(audit(`${base}_needs_operator_${k}`, `${part.length} need operator review (not written)`, { needsOperator: part }))
  }
  const needsOperatorCount = plan.needsOperator.length + result.needsOperator.length
  await store.appendAudit(
    audit(
      base,
      `${result.moved.length} moved, ${result.merged.length} merged, ${result.retry.length} overtaken, ${result.failed.length} failed, ` +
        `${needsOperatorCount} need operator review, ${plan.canonical.length} already canonical`,
      {
        movedCount: result.moved.length,
        mergedCount: result.merged.length,
        retryCount: result.retry.length,
        failedCount: result.failed.length,
        needsOperatorCount,
        canonicalCount: plan.canonical.length,
        batches: batches.length,
      }
    )
  )
  return result
}

/**
 * Exit code (spec R12): 2 when any row needs an operator (planned, or rejected at apply for a reason no rerun fixes);
 * else 1 when a rerun can finish the job (a move threw, or was overtaken since planning); else 0, a clean run.
 */
export function courtOpsAckBackfillExitCode(plan: CourtOpsAckBackfillPlan, result?: CourtOpsAckBackfillResult): 0 | 1 | 2 {
  if (plan.needsOperator.length > 0 || (result?.needsOperator.length ?? 0) > 0) return 2
  if (result && (result.failed.length > 0 || result.retry.length > 0)) return 1
  return 0
}
