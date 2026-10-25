/**
 * FA-D4-001-FU1: the court-ops acknowledgement backfill entry the operator script and the tests share. No Firebase
 * import: the script supplies the loader and the store.
 *
 * Exit codes (spec R12, the FA-D4-001-R1-004 lesson):
 *   0  a clean run: nothing failed, nothing was overtaken, nothing needs an operator;
 *   1  a rerun can finish the job: a move threw, or its legacy row changed or went since planning ("rerun to retry");
 *   2  at least one row needs operator review (dry run or apply): no rerun will move it. 2 wins over 1.
 */
import { randomUUID } from "node:crypto"
import {
  applyCourtOpsAckBackfill,
  courtOpsAckBackfillExitCode,
  formatCourtOpsAckBackfillApplyHeader,
  formatCourtOpsAckBackfillDryRun,
  planCourtOpsAckBackfill,
  type CourtOpsAckBackfillRow,
  type CourtOpsAckBackfillStore,
  type NestedCourtOpsAckDocument,
} from "@/platform/persistence/courtOpsAckBackfill"

const LOG = "[backfill-court-ops-acks]"

export type CourtOpsAckBackfillCliDeps = {
  load: () => Promise<{
    rows: readonly CourtOpsAckBackfillRow[]
    nested: readonly NestedCourtOpsAckDocument[]
    itemFirms: ReadonlyMap<string, string | null>
  }>
  store: CourtOpsAckBackfillStore
  log?: (line: string) => void
  runId?: string
  now?: number
}

export async function runCourtOpsAckBackfill(argv: readonly string[], deps: CourtOpsAckBackfillCliDeps): Promise<0 | 1 | 2> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const { rows, nested, itemFirms } = await deps.load()
  const plan = planCourtOpsAckBackfill(rows, nested, itemFirms)
  if (!argv.includes("--apply")) {
    log(formatCourtOpsAckBackfillDryRun(plan))
    return courtOpsAckBackfillExitCode(plan)
  }
  log(formatCourtOpsAckBackfillApplyHeader(plan))
  const result = await applyCourtOpsAckBackfill(deps.store, plan, {
    runId: deps.runId ?? randomUUID(),
    now: deps.now ?? Date.now(),
  })
  for (const n of result.needsOperator) log(`${LOG} needs operator review ${n.path} ${n.reason}`)
  for (const r of result.retry) log(`${LOG} rejected ${r.path} ${r.reason} (rerun to retry)`)
  for (const f of result.failed) log(`${LOG} failed ${f.path}: ${f.message} (rerun to retry)`)
  log(
    `${LOG} moved ${result.moved.length}, merged ${result.merged.length}, overtaken ${result.retry.length}, ` +
      `failed ${result.failed.length}, need operator review ${plan.needsOperator.length + result.needsOperator.length}; ` +
      "summary row written to audit_log"
  )
  return courtOpsAckBackfillExitCode(plan, result)
}
