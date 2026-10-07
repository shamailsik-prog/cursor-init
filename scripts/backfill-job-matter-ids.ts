/**
 * One-off backfill: set `matterId` on `jobs` rows written before jobs carried it
 * (review round 1, finding 2). The Firestore rules deny any job without the field, so until
 * this runs legacy jobs are invisible to everyone (fail closed), not over-exposed.
 *
 * Dry-run by default; pass --apply to write. Idempotent (rows that already have the field are
 * skipped). Credentials come from the environment (GOOGLE_APPLICATION_CREDENTIALS or
 * FIRESTORE_EMULATOR_HOST), never from this file.
 *
 *   npx tsx scripts/backfill-job-matter-ids.ts [--apply] [--project <id>]
 *
 * NOT run as part of this change.
 */
import { applicationDefault, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { planJobMatterBackfill } from "@/platform/persistence/jobMatterBackfill"

async function main(argv: string[]): Promise<void> {
  const apply = argv.includes("--apply")
  const projectFlag = argv.indexOf("--project")
  const projectId = projectFlag >= 0 ? argv[projectFlag + 1] : undefined
  const app = initializeApp({
    ...(process.env.FIRESTORE_EMULATOR_HOST ? {} : { credential: applicationDefault() }),
    ...(projectId ? { projectId } : {}),
  })
  const db = getFirestore(app)
  const snapshot = await db.collection("jobs").get()
  const rows = snapshot.docs.map((d) => {
    const data = d.data() as { documentId?: unknown; matterId?: unknown }
    return {
      id: d.id,
      documentId: typeof data.documentId === "string" ? data.documentId : "",
      ...("matterId" in data ? { matterId: (data.matterId as string | null) ?? null } : {}),
    }
  })
  const plan = await planJobMatterBackfill(rows, async (documentId) => {
    if (!documentId) return null
    const docSnap = await db.collection("documents").doc(documentId).get()
    if (!docSnap.exists) return null
    const data = docSnap.data() as { matterId?: string | null }
    return "matterId" in data ? { matterId: data.matterId ?? null } : null
  })
  console.log(
    `[backfill-job-matter-ids] ${apply ? "APPLY" : "DRY-RUN"}: ${plan.updates.length} to update, ` +
      `${plan.alreadySet.length} already set, ${plan.orphans.length} orphaned (left denied)`
  )
  if (!apply) return
  for (let i = 0; i < plan.updates.length; i += 400) {
    const batch = db.batch()
    for (const update of plan.updates.slice(i, i + 400)) {
      batch.update(db.collection("jobs").doc(update.id), { matterId: update.matterId })
    }
    await batch.commit()
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[backfill-job-matter-ids] failed", err)
  process.exitCode = 1
})
