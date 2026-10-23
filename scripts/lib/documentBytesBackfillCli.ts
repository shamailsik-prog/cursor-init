/**
 * FA-F13-031 / FA-F13-032: the document-bytes backfill entry the operator script and the unit tests share.
 * A thrown stamp is already recorded by apply and later rows still run; this returns 1 when any stamp failed.
 * Malformed rows are named on --apply and do not by themselves make the exit non-zero.
 * No Firebase import: the script supplies the store.
 */
import {
  applyDocumentBytesBackfill,
  formatDocumentBytesDryRun,
  planDocumentBytesBackfill,
  type DocumentBytesBackfillStore,
} from "@/platform/persistence/documentBytesBackfill"

export type DocumentBytesBackfillCliDeps = {
  readRows: () => Promise<readonly { id: string; data: unknown }[]>
  store: DocumentBytesBackfillStore
  log?: (line: string) => void
}

export async function runDocumentBytesBackfill(argv: readonly string[], deps: DocumentBytesBackfillCliDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const plan = planDocumentBytesBackfill(await deps.readRows())
  if (!argv.includes("--apply")) {
    log(formatDocumentBytesDryRun(plan))
    return 0
  }
  const result = await applyDocumentBytesBackfill(deps.store, plan)
  log(
    `[backfill-document-bytes] applied ${result.applied.length}, skipped ${result.skipped.length}, rejected ${result.rejected.length}, failed ${result.failed.length}, malformed ${plan.malformed.length}`
  )
  for (const row of plan.malformed) log(`[backfill-document-bytes] ${row.path} malformed ${row.reason}`)
  return result.failed.length > 0 ? 1 : 0
}
