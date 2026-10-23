/**
 * FA-F13-022: one-off backfill that stamps `objectBytesStatus: "missing"` on document rows that never stored it.
 * Malformed rows are reported and not written. Dry-run by default; pass --apply to write.
 *
 * FA-F13-031: --apply exits 1 when a stamp failed. Later rows still run.
 * FA-F13-032: --apply prints the malformed count and each `documents/<id> malformed <reason>` path.
 * A malformed row is a report, not a failed write, so it does not by itself set a non-zero exit.
 *
 *   npm run backfill:document-bytes -- [--apply] [--project <id>]
 */
import { applicationDefault, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { adminDocumentBytesBackfillStore, readDocumentRows } from "./lib/documentBytesBackfillAdmin"
import { runDocumentBytesBackfill } from "./lib/documentBytesBackfillCli"

async function main(argv: string[]): Promise<void> {
  const projectFlag = argv.indexOf("--project")
  const projectId = projectFlag >= 0 ? argv[projectFlag + 1] : undefined
  const app = initializeApp({
    ...(process.env.FIRESTORE_EMULATOR_HOST ? {} : { credential: applicationDefault() }),
    ...(projectId ? { projectId } : {}),
  })
  const db = getFirestore(app)
  process.exitCode = await runDocumentBytesBackfill(argv, {
    readRows: () => readDocumentRows(db as never),
    store: adminDocumentBytesBackfillStore(db as never),
  })
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[backfill-document-bytes] failed", err)
  process.exitCode = 1
})
