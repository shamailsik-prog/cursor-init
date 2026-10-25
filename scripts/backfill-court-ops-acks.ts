/**
 * FA-D4-001-FU1: one-off backfill of legacy court-ops acknowledgement rows
 * `workflow_ops_activity/ops:court_ops:ack:{queueType}:{itemId}` to the firm-qualified id
 * `ops:court_ops:ack:{firmId}:{queueType}:{itemId}` (platform/persistence/courtOpsAckBackfill.ts). A row whose item is not
 * evidently its stamped firm's, a malformed or planted row, a target conflict and a nested FU1b document are reported
 * (ids only) for operator review and left.
 *
 * Dry-run by default; pass --apply to write. Idempotent: a move deletes its legacy row in the same transaction, so a
 * rerun moves only rows written since. Run it after the new code is fully deployed (old instances write legacy ids).
 * Credentials come from the environment (GOOGLE_APPLICATION_CREDENTIALS or FIRESTORE_EMULATOR_HOST), never from this file.
 *
 * Exit codes: 0 clean; 1 a rerun can finish the job (rerun to retry); 2 rows need operator review (2 wins).
 *
 *   npm run backfill:court-ops-acks -- [--apply] [--project <id>]   (tsx is a pinned devDependency)
 *
 * NOT run against any live project as part of this change.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { adminCourtOpsAckBackfillStore, readCourtOpsAckBackfillInput } from "./lib/courtOpsAckBackfillAdmin"
import { runCourtOpsAckBackfill } from "./lib/courtOpsAckBackfillCli"

async function main(argv: string[]): Promise<void> {
  const projectFlag = argv.indexOf("--project")
  const projectId = projectFlag >= 0 ? argv[projectFlag + 1] : undefined
  const app = initializeApp({
    ...(process.env.FIRESTORE_EMULATOR_HOST ? {} : { credential: applicationDefault() }),
    ...(projectId ? { projectId } : {}),
  })
  const db = getFirestore(app)
  process.exitCode = await runCourtOpsAckBackfill(argv, {
    load: () => readCourtOpsAckBackfillInput(db),
    store: adminCourtOpsAckBackfillStore(db),
  })
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[backfill-court-ops-acks] failed", err)
  process.exitCode = 1
})
