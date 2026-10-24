/**
 * FA-F13-003: one-off backfill of legacy `matters` / `matter_members` rows into the canonical shape
 * (platform/persistence/matterShapeBackfill.ts). Only adds missing fields; never replaces a stored value.
 *
 * Dry-run by default; pass --apply to write. Idempotent. Credentials come from the environment
 * (GOOGLE_APPLICATION_CREDENTIALS or FIRESTORE_EMULATOR_HOST), never from this file.
 *
 * FA-F13-030: --apply exits 1 when a write failed. Later rows still run; the failure count is not success.
 *
 *   npm run backfill:matter-shapes -- [--apply] [--project <id>]   (tsx is a pinned devDependency)
 *
 * NOT run as part of this change.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app"
import { FieldValue, getFirestore } from "firebase-admin/firestore"
import { adminMatterShapeBackfillStore, readMatterShapeRows } from "./lib/matterShapeBackfillAdmin"
import { runMatterShapeBackfill } from "./lib/matterShapeBackfillCli"

async function main(argv: string[]): Promise<void> {
  const projectFlag = argv.indexOf("--project")
  const projectId = projectFlag >= 0 ? argv[projectFlag + 1] : undefined
  const app = initializeApp({
    ...(process.env.FIRESTORE_EMULATOR_HOST ? {} : { credential: applicationDefault() }),
    ...(projectId ? { projectId } : {}),
  })
  const db = getFirestore(app)
  process.exitCode = await runMatterShapeBackfill(argv, {
    load: () => readMatterShapeRows(db as never),
    store: adminMatterShapeBackfillStore(db as never, () => FieldValue.serverTimestamp()),
  })
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[backfill-matter-shapes] failed", err)
  process.exitCode = 1
})
