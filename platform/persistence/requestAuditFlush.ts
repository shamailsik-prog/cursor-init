import type { AuditEntry, SpineStore } from "@/platform/spine/store"
import {
  beginAuditFlight,
  endAuditFlight,
  isAuditRowDeadLettered,
  isAuditRowInFlight,
  isAuditRowPersisted,
  markAuditRowPersisted,
  type AuditLog,
  type DeadLetterWriter,
} from "@/platform/audit/requestAudit"
import { normalizeAuditEntryInPlace } from "@/platform/persistence/auditWriteThrough"

type AuditSink = (rows: AuditEntry[]) => Promise<void>

let sinkForTests: AuditSink | null = null

/** Test hook: replace the audit repository append for request flushes (null restores it). */
export function setRequestAuditSinkForTests(sink: AuditSink | null): void {
  sinkForTests = sink
}

/**
 * Persists a request's collected audit rows — plus every row still owed from earlier failed
 * flushes or pushed outside a request (the log's retry queue) — through the audit repository.
 * Rows already persisted are skipped; re-appending an identical row is a no-op in the
 * repositories anyway. A failed row goes back on the retry queue (dead-lettered after
 * MAX_FLUSH_ATTEMPTS). Throws when any of *this request's* rows could not be persisted, so the
 * request answers 503 AUDIT_UNAVAILABLE; failures of older retried rows do not fail it.
 *
 * R3 N13: a row being sent by one flush is in flight and every concurrent flush skips it, a
 * failed row waits out an exponential backoff window before its next attempt (so attempts are
 * counted per window, not per concurrent request), and dead-letters are written with the full
 * row to the durable, server-only audit_dead_letter repository.
 */
export async function flushRequestAudit(rows: readonly AuditEntry[]): Promise<void> {
  const { getRuntimeStore } = await import("@/platform/spine/runtimeStore")
  const store = getRuntimeStore()
  const log = store.audit as Partial<AuditLog> & AuditEntry[]
  const retries = typeof log.pendingRetries === "function" ? log.pendingRetries(Date.now()) : []
  const own = new Set(rows)
  const pending = [...new Set([...retries, ...rows])].filter(
    (row) => !isAuditRowPersisted(row) && !isAuditRowDeadLettered(row) && !isAuditRowInFlight(row)
  )
  beginAuditFlight(pending)
  try {
    await sendRows(store, log, own, pending)
  } finally {
    endAuditFlight(pending)
    await storeDeadLetters(store, log)
  }
}

async function storeDeadLetters(store: SpineStore, log: Partial<AuditLog>): Promise<void> {
  // R4-6: dead-letters are written when dead-lettered; the flush retries what is still cached.
  if (typeof log.flushDeadLetters !== "function") return
  if (log.hasDeadLetterWriter && !log.hasDeadLetterWriter()) log.setDeadLetterWriter?.(repositoryDeadLetterWriter(store))
  await log.flushDeadLetters()
}

/** Writes a dead-letter to the store's audit_dead_letter repository. */
export function repositoryDeadLetterWriter(store: SpineStore): DeadLetterWriter {
  return async (letter) => {
    const { getRuntimeRepositories } = await import("@/platform/persistence/runtimeRepositories")
    const repos = await getRuntimeRepositories(store)
    await repos.auditDeadLetter.append(letter)
  }
}

async function sendRows(
  store: SpineStore,
  log: Partial<AuditLog> & AuditEntry[],
  own: ReadonlySet<AuditEntry>,
  initial: AuditEntry[]
): Promise<void> {
  let pending = initial
  if (pending.length === 0) return
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
        log.settled?.(row)
        return false
      }
      return true
    })
    if (pending.length === 0) return
  }
  const ready: AuditEntry[] = []
  let ownFailed: unknown = null
  for (const row of pending) {
    try {
      normalizeAuditEntryInPlace(store, row)
      ready.push(row)
    } catch (err) {
      // No resolvable firm: can never be persisted.
      if (log.deadLetter) log.deadLetter(row, String(err))
      if (own.has(row)) ownFailed = err
    }
  }
  const fail = (row: AuditEntry, err: unknown) => {
    if (log.recordFailure) log.recordFailure(row, err, Date.now())
    if (own.has(row)) ownFailed = ownFailed ?? err
  }
  if (sinkForTests) {
    try {
      await sinkForTests(ready)
      for (const row of ready) {
        markAuditRowPersisted(row)
        log.settled?.(row)
      }
    } catch (err) {
      for (const row of ready) fail(row, err)
    }
  } else {
    const { getRuntimeRepositories } = await import("@/platform/persistence/runtimeRepositories")
    const repos = await getRuntimeRepositories(store)
    for (const row of ready) {
      try {
        await repos.audit.append(row)
        markAuditRowPersisted(row)
        log.settled?.(row)
      } catch (err) {
        fail(row, err)
      }
    }
  }
  if (ownFailed) throw ownFailed instanceof Error ? ownFailed : new Error(String(ownFailed))
}
