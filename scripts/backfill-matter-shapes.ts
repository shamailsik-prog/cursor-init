/**
 * FA-F13-003: one-off backfill of legacy `matters` / `matter_members` rows into the canonical shape
 * (platform/persistence/matterShapeBackfill.ts). Only adds missing fields; never replaces a stored value.
 *
 * Dry-run by default; pass --apply to write. Idempotent. Credentials come from the environment
 * (GOOGLE_APPLICATION_CREDENTIALS or FIRESTORE_EMULATOR_HOST), never from this file.
 *
 *   npm run backfill:matter-shapes -- [--apply] [--project <id>]   (tsx is a pinned devDependency)
 *
 * NOT run as part of this change.
 */
import { randomUUID } from "node:crypto"
import { applicationDefault, initializeApp } from "firebase-admin/app"
import { FieldValue, getFirestore } from "firebase-admin/firestore"
import { applyMatterShapeBackfill, planMatterShapeBackfill } from "@/platform/persistence/matterShapeBackfill"
import { adminMatterShapeBackfillStore, readMatterShapeRows } from "./lib/matterShapeBackfillAdmin"

async function main(argv: string[]): Promise<void> {
  const apply = argv.includes("--apply")
  const projectFlag = argv.indexOf("--project")
  const projectId = projectFlag >= 0 ? argv[projectFlag + 1] : undefined
  const app = initializeApp({
    ...(process.env.FIRESTORE_EMULATOR_HOST ? {} : { credential: applicationDefault() }),
    ...(projectId ? { projectId } : {}),
  })
  const db = getFirestore(app)
  const { matters, members } = await readMatterShapeRows(db as never)
  const plan = planMatterShapeBackfill(matters, members)
  console.log(
    `[backfill-matter-shapes] ${apply ? "APPLY" : "DRY-RUN"}: ${plan.matters.length} matters and ${plan.members.length} members to complete, ` +
      `${plan.complete.length} already complete, ${plan.malformed.length} malformed, ${plan.orphans.length} orphaned (left as they are)`
  )
  if (!apply) return
  const result = await applyMatterShapeBackfill(adminMatterShapeBackfillStore(db as never, () => FieldValue.serverTimestamp()), plan, {
    runId: randomUUID(),
    now: Date.now(),
  })
  console.log(
    `[backfill-matter-shapes] applied ${result.applied.length}, skipped ${result.skipped.length}, rejected ${result.rejected.length}; summary row written to audit_log`
  )
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[backfill-matter-shapes] failed", err)
  process.exitCode = 1
})
