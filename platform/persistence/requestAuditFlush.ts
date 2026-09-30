import type { AuditEntry } from "@/platform/spine/store"
import { isAuditRowPersisted, markAuditRowPersisted } from "@/platform/audit/requestAudit"
import { normalizeAuditEntryInPlace } from "@/platform/persistence/auditWriteThrough"

type AuditSink = (rows: AuditEntry[]) => Promise<void>

let sinkForTests: AuditSink | null = null

/** Test hook: replace the audit repository append for request flushes (null restores it). */
export function setRequestAuditSinkForTests(sink: AuditSink | null): void {
  sinkForTests = sink
}

/**
 * Persists a request's collected audit rows through the audit repository. Rows already
 * persisted (e.g. by a route's persistAuditEntriesSince) are skipped; re-appending an
 * identical row is an idempotent no-op in the repositories anyway. Throws if any append fails.
 */
export async function flushRequestAudit(rows: readonly AuditEntry[]): Promise<void> {
  let pending = rows.filter((row) => !isAuditRowPersisted(row))
  if (pending.length === 0) return
  const { getRuntimeStore } = await import("@/platform/spine/runtimeStore")
  const store = getRuntimeStore()
  // A handler may replace a row in the log with an enriched copy under the same id and persist
  // that copy (p5/tenancy does); the superseded original is not re-appended.
  if (pending.some((row) => row.id)) {
    const persistedById = new Map<string, AuditEntry>()
    for (const row of store.audit) {
      if (row.id && isAuditRowPersisted(row)) persistedById.set(row.id, row)
    }
    pending = pending.filter((row) => {
      const current = row.id ? persistedById.get(row.id) : undefined
      if (current && current !== row) {
        markAuditRowPersisted(row)
        return false
      }
      return true
    })
    if (pending.length === 0) return
  }
  for (const row of pending) normalizeAuditEntryInPlace(store, row)
  if (sinkForTests) {
    await sinkForTests(pending)
  } else {
    const { getRuntimeRepositories } = await import("@/platform/persistence/runtimeRepositories")
    const repos = await getRuntimeRepositories(store)
    for (const row of pending) await repos.audit.append(row)
  }
  for (const row of pending) markAuditRowPersisted(row)
}
