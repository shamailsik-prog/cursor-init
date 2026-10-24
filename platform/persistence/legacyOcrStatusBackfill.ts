/**
 * FA-F04-013: idempotent backfill for legacy `jobType: "ocr"` upload rows written before `ocrStatus`
 * was stamped at create time. Firestore `not-in` excludes documents where the field is missing, so the
 * OCR sweep never sees them until the field exists.
 */

export type LegacyOcrStatusBackfillPlan = {
  /** Legacy upload rows (no `engine: "p2"`) that still lack `ocrStatus`. */
  stamp: Array<{ id: string; patch: { ocrStatus: "queued" } }>
  /** Rows that already carry a status, or are engine rows. */
  complete: string[]
}

export function planLegacyOcrStatusBackfill(rows: readonly { id: string; data: unknown }[]): LegacyOcrStatusBackfillPlan {
  const plan: LegacyOcrStatusBackfillPlan = { stamp: [], complete: [] }
  for (const row of rows) {
    const data = row.data
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      plan.complete.push(`jobs/${row.id}`)
      continue
    }
    const record = data as Record<string, unknown>
    if (record.jobType !== "ocr" || record.engine === "p2") {
      plan.complete.push(`jobs/${row.id}`)
      continue
    }
    if (Object.hasOwn(record, "ocrStatus")) plan.complete.push(`jobs/${row.id}`)
    else plan.stamp.push({ id: row.id, patch: { ocrStatus: "queued" } })
  }
  return plan
}

export type LegacyOcrStatusStampResult = { status: "written" } | { status: "skipped" }

export type LegacyOcrStatusBackfillStore = {
  /** Re-reads `jobs/id` and writes `{ ocrStatus: "queued" }` only while the field is still absent. */
  stamp(id: string): Promise<LegacyOcrStatusStampResult>
}

export async function applyLegacyOcrStatusBackfill(
  store: LegacyOcrStatusBackfillStore,
  plan: LegacyOcrStatusBackfillPlan
): Promise<{ applied: string[]; skipped: string[]; failed: { path: string; message: string }[] }> {
  const applied: string[] = []
  const skipped: string[] = []
  const failed: { path: string; message: string }[] = []
  for (const row of plan.stamp) {
    const path = `jobs/${row.id}`
    try {
      const outcome = await store.stamp(row.id)
      if (outcome.status === "written") applied.push(path)
      else skipped.push(path)
    } catch (err) {
      failed.push({ path, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { applied, skipped, failed }
}
