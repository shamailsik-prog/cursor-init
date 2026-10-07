/**
 * One-off backfill: set `matterId` on `jobs` rows written before jobs carried it
 * (review round 1, finding 2). The Firestore rules deny any job without the field, so until
 * this runs legacy jobs are invisible to everyone (fail closed), not over-exposed.
 *
 * Dry-run by default; pass --apply to write. Idempotent (rows that already have the field are
 * skipped). Credentials come from the environment (GOOGLE_APPLICATION_CREDENTIALS or
 * FIRESTORE_EMULATOR_HOST), never from this file.
 *
 * Final audit F7: a job whose document is in another firm is an orphan (not written); each
 * update is a transaction that re-checks matterId is still absent; an applied run appends one
 * `job_matter_backfill` summary row to audit_log. A dry run writes nothing.
 *
 *   npx tsx scripts/backfill-job-matter-ids.ts [--apply] [--project <id>]
 *
 * NOT run as part of this change.
 */
import { randomUUID } from "node:crypto"
import { applicationDefault, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  applyJobMatterBackfill,
  planJobMatterBackfill,
  type JobMatterBackfillStore,
} from "@/platform/persistence/jobMatterBackfill"

function firestoreBackfillStore(db: Firestore): JobMatterBackfillStore {
  return {
    async setMatterIdIfUnset(jobId, matterId) {
      const ref = db.collection("jobs").doc(jobId)
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        if (!snap.exists || "matterId" in (snap.data() ?? {})) return false
        tx.update(ref, { matterId })
        return true
      })
    },
    async appendAudit(row) {
      // create(): an audit row is never overwritten.
      await db.collection("audit_log").doc(row.id).create(row)
    },
  }
}

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
    const data = d.data() as { firmId?: unknown; documentId?: unknown; matterId?: unknown }
    return {
      id: d.id,
      ...(typeof data.firmId === "string" ? { firmId: data.firmId } : {}),
      documentId: typeof data.documentId === "string" ? data.documentId : "",
      ...("matterId" in data ? { matterId: (data.matterId as string | null) ?? null } : {}),
    }
  })
  const plan = await planJobMatterBackfill(rows, async (documentId) => {
    if (!documentId) return null
    const docSnap = await db.collection("documents").doc(documentId).get()
    if (!docSnap.exists) return null
    const data = docSnap.data() as { firmId?: unknown; matterId?: string | null }
    if (!("matterId" in data)) return null
    return {
      ...(typeof data.firmId === "string" ? { firmId: data.firmId } : {}),
      matterId: data.matterId ?? null,
    }
  })
  console.log(
    `[backfill-job-matter-ids] ${apply ? "APPLY" : "DRY-RUN"}: ${plan.updates.length} to update, ` +
      `${plan.alreadySet.length} already set, ${plan.orphans.length} orphaned (left denied)`
  )
  if (!apply) return
  const result = await applyJobMatterBackfill(firestoreBackfillStore(db), plan, {
    runId: randomUUID(),
    now: Date.now(),
  })
  console.log(
    `[backfill-job-matter-ids] applied ${result.applied.length}, skipped ${result.skipped.length} ` +
      `(matterId set since planning); summary row written to audit_log`
  )
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[backfill-job-matter-ids] failed", err)
  process.exitCode = 1
})
