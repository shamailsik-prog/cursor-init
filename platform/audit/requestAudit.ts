/**
 * Request-scoped audit collection (review round 1, finding 4).
 *
 * Every row pushed to the spine audit log (`store.audit`, an AuditLog) while a request runs is
 * also recorded in that request's AsyncLocalStorage context — by object, never by global
 * index, so concurrent requests cannot pick up each other's rows. `withSession` persists the
 * collected rows through the audit repository before the response is returned (GET and POST
 * alike) and answers 503 AUDIT_UNAVAILABLE if that fails.
 *
 * The log is bounded: once it holds more than AUDIT_LOG_CAPACITY rows, the oldest rows are
 * evicted — but only rows already persisted. Unpersisted rows are never dropped.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import type { AuditEntry } from "@/platform/spine/store"

export const AUDIT_LOG_CAPACITY = 10_000

type RequestAuditContext = { rows: AuditEntry[] }

const storage = new AsyncLocalStorage<RequestAuditContext>()
const persisted = new WeakSet<object>()

export function markAuditRowPersisted(row: AuditEntry): void {
  persisted.add(row)
}

export function isAuditRowPersisted(row: AuditEntry): boolean {
  return persisted.has(row)
}

/** Runs `fn` with a fresh audit collector; returns the collector so rows can be flushed. */
export async function runWithRequestAudit<T>(
  fn: () => Promise<T> | T
): Promise<{ value: T; rows: AuditEntry[] } | { error: unknown; rows: AuditEntry[] }> {
  const ctx: RequestAuditContext = { rows: [] }
  try {
    const value = await storage.run(ctx, fn)
    return { value, rows: ctx.rows }
  } catch (error) {
    return { error, rows: ctx.rows }
  }
}

/** Rows collected so far by the current request (empty outside a request). */
export function currentRequestAuditRows(): readonly AuditEntry[] {
  return storage.getStore()?.rows ?? []
}

/**
 * The spine audit log. An Array (every existing `store.audit.push/filter/length` call keeps
 * working) whose push also records the row in the current request's collector and evicts
 * already-persisted rows beyond AUDIT_LOG_CAPACITY.
 */
export class AuditLog extends Array<AuditEntry> {
  static get [Symbol.species](): ArrayConstructor {
    return Array
  }

  constructor(private readonly capacity: number = AUDIT_LOG_CAPACITY) {
    super()
  }

  override push(...rows: AuditEntry[]): number {
    super.push(...rows)
    const ctx = storage.getStore()
    if (ctx) ctx.rows.push(...rows)
    this.evictPersisted()
    return this.length
  }

  /**
   * Replace the contents in place (review R2 N2): the log object — and with it per-request
   * collection and the bound — survives a sync. Rows are not re-collected by any request.
   */
  replaceAll(rows: readonly AuditEntry[]): void {
    this.length = 0
    for (let i = 0; i < rows.length; i += 10_000) {
      Array.prototype.push.apply(this, rows.slice(i, i + 10_000) as AuditEntry[])
    }
    this.evictPersisted()
  }

  private evictPersisted(): void {
    let evict = 0
    while (this.length - evict > this.capacity) {
      const row = this[evict]
      if (!row || !persisted.has(row)) break
      evict += 1
    }
    if (evict > 0) this.splice(0, evict)
  }
}
