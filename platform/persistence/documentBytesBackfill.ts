import { documentRecordRefusal } from "@/platform/d1/documentRecord"

/**
 * FA-F13-022: one-off backfill for document rows stored before `objectBytesStatus` was written.
 * The reader already treats an absent status as "missing". This stamps that default onto the row and does not
 * invent any other field. A row the reader refuses is reported and left untouched.
 */

export type DocumentBytesBackfillPlan = {
  /** Readable rows that never stored `objectBytesStatus`. The patch is exactly that one field. */
  stamp: Array<{ id: string; patch: { objectBytesStatus: "missing" } }>
  /** Readable rows that already store `available` or `missing`. Paths, not bare ids. */
  complete: string[]
  /** Rows the reader refuses. Not patched. */
  malformed: Array<{ id: string; path: string; reason: string }>
}

export function planDocumentBytesBackfill(rows: readonly { id: string; data: unknown }[]): DocumentBytesBackfillPlan {
  const plan: DocumentBytesBackfillPlan = { stamp: [], complete: [], malformed: [] }
  for (const row of rows) {
    const reason = documentRecordRefusal(row.id, row.data)
    if (reason) {
      plan.malformed.push({ id: row.id, path: `documents/${row.id}`, reason })
      continue
    }
    const data = row.data as Record<string, unknown>
    if (data.objectBytesStatus === undefined) plan.stamp.push({ id: row.id, patch: { objectBytesStatus: "missing" } })
    else plan.complete.push(`documents/${row.id}`)
  }
  return plan
}

/** Dry-run text: counts, then each stamp, complete path, and malformed path with its reason. */
export function formatDocumentBytesDryRun(plan: DocumentBytesBackfillPlan): string {
  const lines = [
    `[backfill-document-bytes] DRY-RUN: ${plan.stamp.length} to stamp, ${plan.complete.length} already complete, ${plan.malformed.length} malformed (not written)`,
  ]
  for (const row of plan.stamp) lines.push(`[backfill-document-bytes] documents/${row.id} objectBytesStatus`)
  for (const path of plan.complete) lines.push(`[backfill-document-bytes] complete ${path}`)
  for (const row of plan.malformed) lines.push(`[backfill-document-bytes] ${row.path} malformed ${row.reason}`)
  return lines.join("\n")
}

export type DocumentBytesStampResult =
  | { status: "written" }
  | { status: "skipped" }
  | { status: "rejected"; reason: "gone" | "malformed" }

export type DocumentBytesBackfillStore = {
  /** Re-reads `documents/id` and writes `{ objectBytesStatus: "missing" }` only while that field is still absent. */
  stamp(id: string): Promise<DocumentBytesStampResult>
}

export async function applyDocumentBytesBackfill(
  store: DocumentBytesBackfillStore,
  plan: DocumentBytesBackfillPlan
): Promise<{
  applied: string[]
  skipped: string[]
  rejected: { path: string; reason: string }[]
  failed: { path: string; message: string }[]
}> {
  const applied: string[] = []
  const skipped: string[] = []
  const rejected: { path: string; reason: string }[] = []
  const failed: { path: string; message: string }[] = []
  for (const row of plan.stamp) {
    const path = `documents/${row.id}`
    try {
      const outcome = await store.stamp(row.id)
      if (outcome.status === "written") applied.push(path)
      else if (outcome.status === "skipped") skipped.push(path)
      else rejected.push({ path, reason: outcome.reason })
    } catch (err) {
      failed.push({ path, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { applied, skipped, rejected, failed }
}
