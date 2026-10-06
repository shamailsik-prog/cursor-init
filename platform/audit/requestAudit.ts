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

/** Rows owed to the repository are retried at most this many times, then dead-lettered. */
export const MAX_FLUSH_ATTEMPTS = 5
/** Unpersisted rows waiting for a retry; overflow is dead-lettered (logged), never kept. */
export const RETRY_QUEUE_CAPACITY = 1_000

const deadLettered = new WeakSet<object>()

export function isAuditRowDeadLettered(row: AuditEntry): boolean {
  return deadLettered.has(row)
}

/**
 * The spine audit log. An Array (every existing `store.audit.push/filter/length` call keeps
 * working) whose push also records the row in the current request's collector (or, outside a
 * request, in the retry queue). Bounded (review R2 N4): beyond `capacity` it trims persisted and
 * dead-lettered rows from the head, skipping past rows still owed to the repository; those are
 * bounded separately by the retry queue's capacity. So the log never exceeds
 * capacity + retryCapacity (+ a small trim slack).
 */
export class AuditLog extends Array<AuditEntry> {
  static get [Symbol.species](): ArrayConstructor {
    return Array
  }

  /** Unpersisted rows owed to the repository, oldest first (drained by every request flush). */
  readonly retryQueue: AuditEntry[] = []
  private readonly attempts = new WeakMap<object, number>()

  constructor(
    private readonly capacity: number = AUDIT_LOG_CAPACITY,
    private readonly retryCapacity: number = RETRY_QUEUE_CAPACITY
  ) {
    super()
  }

  override push(...rows: AuditEntry[]): number {
    super.push(...rows)
    const ctx = storage.getStore()
    if (ctx) ctx.rows.push(...rows)
    else this.enqueueForRetry(rows)
    this.trim()
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
    this.trim()
  }

  /** Queue unpersisted rows for retry; overflow beyond the cap is dead-lettered (oldest first). */
  enqueueForRetry(rows: readonly AuditEntry[]): void {
    for (const row of rows) {
      if (persisted.has(row) || deadLettered.has(row) || this.retryQueue.includes(row)) continue
      this.retryQueue.push(row)
    }
    while (this.retryQueue.length > this.retryCapacity) {
      const oldest = this.retryQueue.shift()
      if (oldest) this.deadLetter(oldest, "retry queue full")
    }
  }

  /** Rows to re-send now: the queue minus anything persisted or dead-lettered meanwhile. */
  pendingRetries(): AuditEntry[] {
    this.dequeue((row) => persisted.has(row) || deadLettered.has(row))
    return [...this.retryQueue]
  }

  /** A row was persisted: it leaves the queue. */
  settled(row: AuditEntry): void {
    this.dequeue((queued) => queued === row)
  }

  /** A persist attempt failed: retry later, or dead-letter after MAX_FLUSH_ATTEMPTS. */
  recordFailure(row: AuditEntry, error: unknown): void {
    const attempts = (this.attempts.get(row) ?? 0) + 1
    this.attempts.set(row, attempts)
    if (attempts >= MAX_FLUSH_ATTEMPTS) {
      this.dequeue((queued) => queued === row)
      this.deadLetter(row, `failed ${attempts} persist attempts: ${String(error).slice(0, 200)}`)
      return
    }
    this.enqueueForRetry([row])
  }

  /** Permanently unpersistable: logged (the dead-letter), then free to be trimmed. */
  deadLetter(row: AuditEntry, reason: string): void {
    if (deadLettered.has(row)) return
    deadLettered.add(row)
    console.error("[audit] dead-letter: audit row could not be persisted", {
      reason,
      id: row.id ?? null,
      firmId: row.firmId ?? null,
      action: row.action,
      actorId: row.actorId,
      target: row.target,
      at: row.at ?? null,
    })
    this.trim()
  }

  private dequeue(predicate: (row: AuditEntry) => boolean): void {
    for (let i = this.retryQueue.length - 1; i >= 0; i -= 1) {
      const queued = this.retryQueue[i]
      if (queued && predicate(queued)) this.retryQueue.splice(i, 1)
    }
  }

  private trim(): void {
    const slack = Math.max(1, Math.floor(this.capacity / 10))
    if (this.length <= this.capacity + slack) return
    let excess = this.length - this.capacity
    const kept: AuditEntry[] = []
    for (const row of this) {
      if (excess > 0 && (persisted.has(row) || deadLettered.has(row))) {
        excess -= 1
        continue
      }
      kept.push(row)
    }
    this.length = 0
    for (let i = 0; i < kept.length; i += 10_000) {
      Array.prototype.push.apply(this, kept.slice(i, i + 10_000))
    }
  }
}
