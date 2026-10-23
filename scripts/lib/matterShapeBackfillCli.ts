/**
 * FA-F13-030: the matter-shape backfill entry the operator script and the unit tests share.
 * A thrown write is already recorded by apply and the later rows still run; this returns 1 when any write failed
 * so the process does not report success. No Firebase import: the script supplies the store.
 */
import { randomUUID } from "node:crypto"
import {
  applyMatterShapeBackfill,
  formatMatterShapeBackfillDryRun,
  planMatterShapeBackfill,
  type BackfillRow,
  type MatterShapeBackfillStore,
} from "@/platform/persistence/matterShapeBackfill"

export type MatterShapeBackfillCliDeps = {
  load: () => Promise<{ matters: readonly BackfillRow[]; members: readonly BackfillRow[] }>
  store: MatterShapeBackfillStore
  log?: (line: string) => void
  runId?: string
  now?: number
}

export async function runMatterShapeBackfill(argv: readonly string[], deps: MatterShapeBackfillCliDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const { matters, members } = await deps.load()
  const plan = planMatterShapeBackfill(matters, members)
  if (!argv.includes("--apply")) {
    log(formatMatterShapeBackfillDryRun(plan))
    return 0
  }
  log(
    `[backfill-matter-shapes] APPLY: ${plan.matters.length} matters and ${plan.members.length} members to complete, ` +
      `${plan.complete.length} already complete, ${plan.malformed.length} malformed, ${plan.orphans.length} orphaned (left as they are)`
  )
  const result = await applyMatterShapeBackfill(deps.store, plan, {
    runId: deps.runId ?? randomUUID(),
    now: deps.now ?? Date.now(),
  })
  log(
    `[backfill-matter-shapes] applied ${result.applied.length}, skipped ${result.skipped.length}, rejected ${result.rejected.length}, failed ${result.failed.length}; summary row written to audit_log`
  )
  return result.failed.length > 0 ? 1 : 0
}
