/**
 * FA-F13-022: one-off backfill that stamps `objectBytesStatus: "missing"` on document rows that never stored it.
 * Malformed rows are reported and not written. Dry-run by default; pass --apply to write.
 *
 *   npm run backfill:document-bytes -- [--apply] [--project <id>]
 */
import { applicationDefault, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { applyDocumentBytesBackfill, formatDocumentBytesDryRun, planDocumentBytesBackfill } from "@/platform/persistence/documentBytesBackfill"
import { adminDocumentBytesBackfillStore, readDocumentRows } from "./lib/documentBytesBackfillAdmin"

async function main(argv: string[]): Promise<void> {
  const apply = argv.includes("--apply")
  const projectFlag = argv.indexOf("--project")
  const projectId = projectFlag >= 0 ? argv[projectFlag + 1] : undefined
  const app = initializeApp({
    ...(process.env.FIRESTORE_EMULATOR_HOST ? {} : { credential: applicationDefault() }),
    ...(projectId ? { projectId } : {}),
  })
  const db = getFirestore(app)
  const plan = planDocumentBytesBackfill(await readDocumentRows(db as never))
  if (!apply) {
    console.log(formatDocumentBytesDryRun(plan))
    return
  }
  const result = await applyDocumentBytesBackfill(adminDocumentBytesBackfillStore(db as never), plan)
  console.log(
    `[backfill-document-bytes] applied ${result.applied.length}, skipped ${result.skipped.length}, rejected ${result.rejected.length}, failed ${result.failed.length}`
  )
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[backfill-document-bytes] failed", err)
  process.exitCode = 1
})
