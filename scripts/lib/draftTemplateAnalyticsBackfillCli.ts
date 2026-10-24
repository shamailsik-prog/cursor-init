/**
 * FA-D4-001: the template-analytics backfill entry the operator script and the tests share. No Firebase import: the
 * script supplies the loader and the store.
 *
 * Exit codes: 0 nothing failed and nothing unrecoverable; 1 a write failed (later rows still ran; FA-F13-030);
 * 2 unrecoverable rows were reported (dry-run or apply): legacy rows several firms shared, which no run will move.
 */
import { randomUUID } from "node:crypto"
import {
  applyTemplateAnalyticsBackfill,
  formatTemplateAnalyticsBackfillApplyHeader,
  formatTemplateAnalyticsBackfillDryRun,
  planTemplateAnalyticsBackfill,
  type AnalyticsBackfillRow,
  type TemplateAnalyticsBackfillStore,
} from "@/platform/persistence/draftTemplateAnalyticsBackfill"

export type TemplateAnalyticsBackfillCliDeps = {
  load: () => Promise<{ rows: readonly AnalyticsBackfillRow[]; draftFirmsByTemplate: ReadonlyMap<string, ReadonlySet<string>> }>
  store: TemplateAnalyticsBackfillStore
  log?: (line: string) => void
  runId?: string
  now?: number
}

export async function runTemplateAnalyticsBackfill(argv: readonly string[], deps: TemplateAnalyticsBackfillCliDeps): Promise<0 | 1 | 2> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const { rows, draftFirmsByTemplate } = await deps.load()
  const plan = planTemplateAnalyticsBackfill(rows, draftFirmsByTemplate)
  const unrecoverable = plan.unrecoverable.length > 0
  if (!argv.includes("--apply")) {
    log(formatTemplateAnalyticsBackfillDryRun(plan))
    return unrecoverable ? 2 : 0
  }
  log(formatTemplateAnalyticsBackfillApplyHeader(plan))
  const result = await applyTemplateAnalyticsBackfill(deps.store, plan, {
    runId: deps.runId ?? randomUUID(),
    now: deps.now ?? Date.now(),
  })
  for (const r of result.rejected) log(`[backfill-template-analytics] rejected ${r.path} ${r.reason} (rerun to retry)`)
  for (const f of result.failed) log(`[backfill-template-analytics] failed ${f.path}: ${f.message}`)
  log(
    `[backfill-template-analytics] moved ${result.moved.length}, merged ${result.merged.length}, rejected ${result.rejected.length}, ` +
      `failed ${result.failed.length}; summary row written to audit_log`
  )
  if (result.failed.length > 0) return 1
  return unrecoverable ? 2 : 0
}
