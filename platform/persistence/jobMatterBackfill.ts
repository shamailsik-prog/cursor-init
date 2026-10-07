/**
 * Backfill plan for job rows written before jobs carried matterId (review round 1, finding 2).
 * The plan is pure: the caller supplies the rows and a document lookup. Idempotent: a row whose
 * matterId field is already present (string or null) is left alone.
 *
 * Final audit F7:
 * - a job is only given the matterId of a document in its own firm; a firm mismatch (or a job
 *   or document without a firmId to compare) is an orphan and is not written, so the rules keep
 *   denying it rather than placing it in another firm's matter;
 * - `applyJobMatterBackfill` writes each update through a check-and-set that re-checks, in one
 *   transaction, that matterId is still absent (a value written between plan and apply wins);
 * - every applied run appends one summary audit row (`job_matter_backfill`).
 */
export type JobRowForBackfill = { id: string; firmId?: string; documentId: string; matterId?: string | null }

export type JobMatterBackfillPlan = {
  updates: Array<{ id: string; matterId: string | null }>
  alreadySet: string[]
  /**
   * Jobs whose document cannot be found, or belongs to another firm (or either firm is
   * unknown): left without matterId, so the rules keep denying them.
   */
  orphans: string[]
}

export async function planJobMatterBackfill(
  rows: readonly JobRowForBackfill[],
  lookupDocument: (documentId: string) => Promise<{ firmId?: string; matterId?: string | null } | null>
): Promise<JobMatterBackfillPlan> {
  const plan: JobMatterBackfillPlan = { updates: [], alreadySet: [], orphans: [] }
  for (const row of rows) {
    if (row.matterId !== undefined) {
      plan.alreadySet.push(row.id)
      continue
    }
    const doc = await lookupDocument(row.documentId)
    if (!doc || doc.matterId === undefined || !row.firmId || !doc.firmId || doc.firmId !== row.firmId) {
      plan.orphans.push(row.id)
      continue
    }
    plan.updates.push({ id: row.id, matterId: doc.matterId })
  }
  return plan
}

/** The one summary row an applied run appends to audit_log. */
export type JobMatterBackfillAuditRow = {
  id: string
  firmId: string
  action: "job_matter_backfill"
  actorId: string
  target: string
  classification: "internal"
  reason: string
  at: number
  appliedJobIds: string[]
  skippedJobIds: string[]
  orphanJobIds: string[]
}

export type JobMatterBackfillStore = {
  /**
   * In one transaction: sets jobs/{jobId}.matterId only if the field is still absent. Returns
   * whether it wrote.
   */
  setMatterIdIfUnset(jobId: string, matterId: string | null): Promise<boolean>
  appendAudit(row: JobMatterBackfillAuditRow): Promise<void>
}

/** The backfill spans firms; its summary row is recorded under the platform scope. */
export const BACKFILL_AUDIT_FIRM_ID = "_platform"
export const BACKFILL_ACTOR_ID = "system:backfill-job-matter-ids"

export async function applyJobMatterBackfill(
  store: JobMatterBackfillStore,
  plan: JobMatterBackfillPlan,
  meta: { runId: string; now: number }
): Promise<{ applied: string[]; skipped: string[] }> {
  const applied: string[] = []
  const skipped: string[] = []
  for (const update of plan.updates) {
    if (await store.setMatterIdIfUnset(update.id, update.matterId)) applied.push(update.id)
    else skipped.push(update.id)
  }
  await store.appendAudit({
    id: `aud_job_matter_backfill_${meta.runId}`,
    firmId: BACKFILL_AUDIT_FIRM_ID,
    action: "job_matter_backfill",
    actorId: BACKFILL_ACTOR_ID,
    target: "jobs",
    classification: "internal",
    reason:
      `${applied.length} applied, ${skipped.length} skipped (matterId set since planning), ` +
      `${plan.orphans.length} orphaned, ${plan.alreadySet.length} already set`,
    at: meta.now,
    appliedJobIds: applied,
    skippedJobIds: skipped,
    orphanJobIds: [...plan.orphans],
  })
  return { applied, skipped }
}
