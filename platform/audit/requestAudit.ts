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

/** First retry after this long; doubles per attempt up to AUDIT_RETRY_BACKOFF_MAX_MS (R3 N13). */
export const AUDIT_RETRY_BACKOFF_BASE_MS = 1_000
export const AUDIT_RETRY_BACKOFF_MAX_MS = 5 * 60_000

const deadLettered = new WeakSet<object>()
/** Rows a flush is sending right now: other concurrent flushes skip them (R3 N13). */
const inFlight = new WeakSet<object>()

export function isAuditRowInFlight(row: AuditEntry): boolean {
  return inFlight.has(row)
}

export function beginAuditFlight(rows: readonly AuditEntry[]): void {
  for (const row of rows) inFlight.add(row)
}

export function endAuditFlight(rows: readonly AuditEntry[]): void {
  for (const row of rows) inFlight.delete(row)
}

/** A dead-lettered row with why and when; written to the durable audit_dead_letter repository. */
export type AuditDeadLetter = { row: AuditEntry; reason: string; deadLetteredAt: number }
export type DeadLetterWriter = (letter: AuditDeadLetter) => Promise<void>

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
  private readonly nextAttemptAt = new WeakMap<object, number>()
  /**
   * Cache of dead-letters not yet confirmed written to the durable repository (R4-6: each one is
   * written at the moment it is dead-lettered; a failed write stays here for the next flush).
   */
  private readonly pendingDeadLetters: AuditDeadLetter[] = []
  private deadLetterWriter: DeadLetterWriter | null = null
  private readonly writingDeadLetters = new Set<AuditDeadLetter>()
  private readonly deadLetterWrites = new Set<Promise<void>>()

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

  /**
   * Rows to re-send now: queued, not persisted or dead-lettered meanwhile, not being sent by
   * another flush, and past their backoff window (R3 N13).
   */
  pendingRetries(now: number = Date.now()): AuditEntry[] {
    this.dequeue((row) => persisted.has(row) || deadLettered.has(row))
    return this.retryQueue.filter((row) => !inFlight.has(row) && (this.nextAttemptAt.get(row) ?? 0) <= now)
  }

  /** A row was persisted: it leaves the queue. */
  settled(row: AuditEntry): void {
    this.dequeue((queued) => queued === row)
  }

  /**
   * A persist attempt failed. One attempt per backoff window (the in-flight set guarantees a row
   * is sent by one flush at a time, and pendingRetries withholds it until the window passes);
   * after MAX_FLUSH_ATTEMPTS windows it is dead-lettered.
   */
  recordFailure(row: AuditEntry, error: unknown, now: number = Date.now()): void {
    const attempts = (this.attempts.get(row) ?? 0) + 1
    this.attempts.set(row, attempts)
    if (attempts >= MAX_FLUSH_ATTEMPTS) {
      this.dequeue((queued) => queued === row)
      this.deadLetter(row, `failed ${attempts} persist attempts: ${String(error).slice(0, 200)}`)
      return
    }
    const backoff = Math.min(AUDIT_RETRY_BACKOFF_BASE_MS * 2 ** (attempts - 1), AUDIT_RETRY_BACKOFF_MAX_MS)
    this.nextAttemptAt.set(row, now + backoff)
    this.enqueueForRetry([row])
  }

  /** Where dead-letters are written durably (the runtime store wires its audit_dead_letter repo). */
  setDeadLetterWriter(writer: DeadLetterWriter | null): void {
    this.deadLetterWriter = writer
  }

  hasDeadLetterWriter(): boolean {
    return this.deadLetterWriter !== null
  }

  /** Cached dead-letters not being written right now, oldest first (removed from the cache). */
  takeDeadLetters(): AuditDeadLetter[] {
    const taken = this.pendingDeadLetters.filter((letter) => !this.writingDeadLetters.has(letter))
    this.removePending(taken)
    return taken
  }

  /** Letters the caller could not write go back in front (oldest first). */
  requeueDeadLetters(letters: readonly AuditDeadLetter[]): void {
    this.pendingDeadLetters.unshift(...letters)
    // bounded like the retry queue: over capacity, the *oldest* unwritten dead-letters are only
    // logged (R4-6: this used pop(), which dropped the newest)
    while (this.pendingDeadLetters.length > this.retryCapacity) {
      const dropped = this.pendingDeadLetters.shift()
      if (dropped) console.error("[audit] dead-letter could not be stored durably", JSON.stringify(dropped))
    }
  }

  /** Waits for the dead-letter writes in flight. */
  async settleDeadLetterWrites(): Promise<void> {
    while (this.deadLetterWrites.size > 0) await Promise.all([...this.deadLetterWrites])
  }

  /** Writes every cached dead-letter (oldest first) through the writer; failures stay cached. */
  async flushDeadLetters(): Promise<void> {
    await this.settleDeadLetterWrites()
    for (const letter of [...this.pendingDeadLetters]) this.writeDeadLetter(letter)
    await this.settleDeadLetterWrites()
  }

  private removePending(letters: readonly AuditDeadLetter[]): void {
    for (const letter of letters) {
      const at = this.pendingDeadLetters.indexOf(letter)
      if (at >= 0) this.pendingDeadLetters.splice(at, 1)
    }
  }

  private writeDeadLetter(letter: AuditDeadLetter): void {
    const writer = this.deadLetterWriter
    if (!writer || this.writingDeadLetters.has(letter)) return
    this.writingDeadLetters.add(letter)
    const write: Promise<void> = writer(letter)
      .then(
        () => this.removePending([letter]),
        (err: unknown) => {
          console.error("[audit] dead-letter write failed; kept for the next flush", String(err).slice(0, 200))
        }
      )
      .finally(() => {
        this.writingDeadLetters.delete(letter)
        this.deadLetterWrites.delete(write)
      })
    this.deadLetterWrites.add(write)
  }

  /** Permanently unpersistable: logged (the dead-letter), then free to be trimmed. */
  deadLetter(row: AuditEntry, reason: string): void {
    if (deadLettered.has(row)) return
    deadLettered.add(row)
    console.error("[audit] dead-letter: audit row could not be persisted (full row -> audit_dead_letter)", {
      reason,
      id: row.id ?? null,
      firmId: row.firmId ?? null,
      action: row.action,
      actorId: row.actorId,
      target: row.target,
      at: row.at ?? null,
    })
    const letter: AuditDeadLetter = { row, reason, deadLetteredAt: Date.now() }
    this.pendingDeadLetters.push(letter)
    // R4-6: durable at the moment of dead-lettering, not at the next flush
    this.writeDeadLetter(letter)
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
