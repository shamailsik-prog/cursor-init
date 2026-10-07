/**
 * Backfill plan for job rows written before jobs carried matterId (review round 1, finding 2).
 * Pure: the caller supplies the rows and a document lookup, and applies the updates.
 * Idempotent: a row whose matterId field is already present (string or null) is left alone.
 */
export type JobRowForBackfill = { id: string; documentId: string; matterId?: string | null }

export type JobMatterBackfillPlan = {
  updates: Array<{ id: string; matterId: string | null }>
  alreadySet: string[]
  /** Jobs whose document cannot be found: left without matterId, so the rules keep denying them. */
  orphans: string[]
}

export async function planJobMatterBackfill(
  rows: readonly JobRowForBackfill[],
  lookupDocument: (documentId: string) => Promise<{ matterId?: string | null } | null>
): Promise<JobMatterBackfillPlan> {
  const plan: JobMatterBackfillPlan = { updates: [], alreadySet: [], orphans: [] }
  for (const row of rows) {
    if (row.matterId !== undefined) {
      plan.alreadySet.push(row.id)
      continue
    }
    const doc = await lookupDocument(row.documentId)
    if (!doc || doc.matterId === undefined) {
      plan.orphans.push(row.id)
      continue
    }
    plan.updates.push({ id: row.id, matterId: doc.matterId })
  }
  return plan
}
