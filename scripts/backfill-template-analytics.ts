/**
 * FA-D4-001: one-off backfill of legacy `draft_template_analytics/template:{templateId}` rows to the firm-qualified id
 * `template:{firmId}:{templateId}` (platform/persistence/draftTemplateAnalyticsBackfill.ts). A legacy row several firms
 * shared is reported (ids only) and left; it cannot be split.
 *
 * Dry-run by default; pass --apply to write. Idempotent: a move deletes its legacy row in the same transaction, so a
 * rerun moves only rows written since. Run it after the new code is fully deployed (old instances write legacy ids).
 * Credentials come from the environment (GOOGLE_APPLICATION_CREDENTIALS or FIRESTORE_EMULATOR_HOST), never from this file.
 *
 * Exit codes: 0 clean; 1 a write failed; 2 unrecoverable rows reported.
 *
 *   npm run backfill:template-analytics -- [--apply] [--project <id>]   (tsx is a pinned devDependency)
 *
 * NOT run as part of this change.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import {
  adminTemplateAnalyticsBackfillStore,
  readTemplateAnalyticsBackfillInput,
} from "./lib/draftTemplateAnalyticsBackfillAdmin"
import { runTemplateAnalyticsBackfill } from "./lib/draftTemplateAnalyticsBackfillCli"

async function main(argv: string[]): Promise<void> {
  const projectFlag = argv.indexOf("--project")
  const projectId = projectFlag >= 0 ? argv[projectFlag + 1] : undefined
  const app = initializeApp({
    ...(process.env.FIRESTORE_EMULATOR_HOST ? {} : { credential: applicationDefault() }),
    ...(projectId ? { projectId } : {}),
  })
  const db = getFirestore(app)
  process.exitCode = await runTemplateAnalyticsBackfill(argv, {
    load: () => readTemplateAnalyticsBackfillInput(db),
    store: adminTemplateAnalyticsBackfillStore(db),
  })
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[backfill-template-analytics] failed", err)
  process.exitCode = 1
})
