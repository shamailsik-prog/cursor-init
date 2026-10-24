import type { DocumentReference, DocumentSnapshot, Firestore, QueryDocumentSnapshot, Transaction } from "firebase-admin/firestore"
import {
  AUDIT_DEAD_LETTER_COLLECTION,
  AUDIT_LOG_COLLECTION,
  AUDIT_OUTBOX_ALERT_AGE_MS,
  AUDIT_OUTBOX_COLLECTION,
  AUDIT_OUTBOX_GRACE_MS,
  AUDIT_OUTBOX_MAX_ATTEMPTS,
  checkStagedRow,
  jsonCopy,
  millisOf,
  parseOutboxEntry,
  recoveredAuditRow,
  recoveredAuditRowId,
  type StoredDeadLetter,
} from "@/platform/persistence/auditOutboxContract"

/**
 * Audit F11: the audit-outbox reconciler, run every minute by `auditOutboxReconciler` (./auditOutboxReconciler.ts), the
 * scheduling pattern of `p1ReservationReconciler` and the P2 `jobSweeper`: a pinned timeout below the one-minute schedule
 * and a wall-clock budget that ends a run between entries.
 *
 * The Next process stages one `audit_outbox` entry with each effect write of a request, in that write's own commit
 * (platform/persistence/auditOutbox.ts), and deletes the request's entries once the request reached its audited end (a
 * 2xx, every claim completed, its action rows flushed: spec ruling 18). An entry still there after AUDIT_OUTBOX_GRACE_MS
 * belongs to a request that died, whose flush failed, or that stopped short of that end. For each one, oldest first, in
 * its own transaction that re-reads it:
 *
 * - a malformed entry, or one with no firm, is dead-lettered whole (spec ruling 7, 15);
 * - every staged row that is a well-formed audit row of the entry's firm is created in `audit_log` under its own id,
 *   unless a row with that id exists: the log is insert-only, and the request's own copy wins (ruling 6);
 * - the recovered row (`aud_outbox_<entryId>`, ruling 2) is created, unless it exists;
 * - every other staged row (malformed, or of another firm: never published into that firm's log) goes to
 *   `audit_dead_letter` under the entry's firm;
 * - the entry is deleted.
 * Every id is deterministic and every create is conditional on a read in the same transaction, and the entry is deleted
 * there too, so the publication happens once however many runs race (they serialise on the entry document).
 *
 * Failures (ruling 7, P1 re-audit R2-D1 parity): a store fault a later run may not meet (contention, ABORTED,
 * UNAVAILABLE and the rest of P1's retryable set) is retried by the next run and never counted. Any other failure
 * counts on the entry (`attempts`); at AUDIT_OUTBOX_MAX_ATTEMPTS the entry is dead-lettered whole (`publish_failed`).
 *
 * The backlog (ruling 9): after each run the oldest entry's age is measured. While it is at least
 * AUDIT_OUTBOX_ALERT_AGE_MS, every run logs `audit.outbox_backlog_stale` at ERROR (the log-based alert policy fires on
 * it, as P2's `job.deadLettered`); the run that sees it back under the threshold logs `audit.outbox_backlog_cleared`.
 * The state is kept in `platform/auditOutboxBacklog` (server-only). Logs carry ids and codes, never row content.
 *
 * The sweep (review round 1, ruling 19): the pass above and the backlog queries reach an entry only through a Firestore
 * Timestamp `stagedAt` (a range filter matches one value type). An entry whose `stagedAt` is missing, null, a number, a
 * string, a map or any other non-Timestamp value, or a Timestamp more than AUDIT_OUTBOX_MAX_FUTURE_MS ahead, would never
 * be published, dead-lettered or counted. Each run therefore first reads one page of the outbox by document id, after a
 * cursor kept in `platform/auditOutboxSweepCursor`, and dead-letters every such entry whole (`entry_malformed`) in a
 * transaction that re-reads it. The cursor moves only past entries the run handled, stays on the last handled one when
 * the budget runs out, and wraps to the start after a short or empty page. An entry it cannot dead-letter is kept on the
 * cursor document's pending list, retried each run, and counted as `unreadable`, which fires the backlog alert while it
 * is above zero. A run reads at most the pending list and one page: SWEEP_PENDING_MAX + SWEEP_PAGE_SIZE entries.
 *
 * Spec: docs/superpowers/specs/2026-10-18-f11-atomic-request-audit-design.md.
 */

/** Entries read per page, and the pages a run may read (at most 500 entries a minute). */
export const RECONCILE_PAGE_SIZE = 100
export const RECONCILE_MAX_PAGES = 5
/** One run's wall-clock budget, checked before each page and each entry. */
export const RECONCILE_BUDGET_MS = 30_000
/** The function's timeout: below the one-minute schedule, so runs never overlap. */
export const RECONCILER_TIMEOUT_SECONDS = 45
export const BACKLOG_STATE_COLLECTION = "platform"
export const BACKLOG_STATE_DOC = "auditOutboxBacklog"
/** The sweep (ruling 19): entries read per run by document id, its cursor, and the entries it keeps retrying. */
export const SWEEP_PAGE_SIZE = 200
export const SWEEP_PENDING_MAX = 100
export const SWEEP_CURSOR_DOC = "auditOutboxSweepCursor"
/** A `stagedAt` further ahead than this is not a clock's skew: the entry would wait that long unseen (ruling 19). */
export const AUDIT_OUTBOX_MAX_FUTURE_MS = 24 * 3_600_000
/** Firestore's earliest timestamp: a lower bound that restricts a `stagedAt` range to timestamps. */
const EARLIEST_TIMESTAMP = new Date("0001-01-01T00:00:00Z")

if (!(RECONCILE_BUDGET_MS + 10_000 <= RECONCILER_TIMEOUT_SECONDS * 1000)) {
  throw new Error(`audit outbox budget (${RECONCILE_BUDGET_MS} ms) must end at least 10 s before the reconciler timeout (${RECONCILER_TIMEOUT_SECONDS} s)`)
}

export type ReconcileLog = {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

export type ReconcileDeps = {
  /** The Admin Firestore. */
  db: Firestore
  /** The clock that decides the grace and the backlog age (default `Date.now`). */
  now?: () => number
  /** The wall clock of the run's budget (default `Date.now`). */
  clock?: () => number
  log?: ReconcileLog
  /** The sweep's page and pending list (defaults SWEEP_PAGE_SIZE, SWEEP_PENDING_MAX); tests shrink them. */
  sweepPageSize?: number
  sweepPendingMax?: number
}

export type Backlog = {
  firing: boolean
  /** `fired` on the run that started the alert, `cleared` on the run that ended it. */
  transition: "fired" | "cleared" | null
  /** Age of the oldest entry, null when the outbox is empty. */
  oldestAgeMs: number | null
  /** Entries past the grace. */
  stale: number
  /** Entries the sweep found with no usable `stagedAt` and could not dead-letter (ruling 19). */
  unreadable: number
}

export type ReconcileResult = {
  /** Entries published (their rows created or found, the recovered row created, the entry deleted). */
  published: string[]
  /** Entries dead-lettered whole. */
  deadLettered: string[]
  /** Entries left for the next run after a retryable failure (not counted). */
  deferred: string[]
  /** Entries whose non-retryable failure was counted. */
  counted: string[]
  rowsPublished: number
  rowsSuperseded: number
  rowsDeadLettered: number
  backlog: Backlog
}

const consoleLog: ReconcileLog = {
  info: (message, data) => console.info(message, data ?? {}),
  warn: (message, data) => console.warn(message, data ?? {}),
  error: (message, data) => console.error(message, data ?? {}),
}

/** The P1 lease reconciler's retryable set (functions/src/p1/gateway.ts RETRYABLE_COMMIT_CODES), plus gax's 409. */
const RETRYABLE_CODES: ReadonlySet<number> = new Set([10, 409, 1, 2, 4, 13, 14, 16, 8])
const DEAD_TRANSACTION = /Transaction is invalid or closed|transaction has expired/i

/** A store fault a later run may not meet (P1 re-audit R2-D1). */
export function isRetryableReconcileError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : ""
  if (typeof code === "number") return RETRYABLE_CODES.has(code) || (code === 3 && DEAD_TRANSACTION.test(message))
  if (typeof code === "string") return ["aborted", "unavailable", "deadline-exceeded", "resource-exhausted", "internal", "cancelled", "unknown"].includes(code.toLowerCase())
  return false
}

/** A loggable code: the SDK's code, never the message. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === "string") return code
  if (typeof code === "number" && Number.isInteger(code)) return `grpc_${code}`
  return "unknown"
}

function outboxRef(db: Firestore, id: string): DocumentReference {
  return db.collection(AUDIT_OUTBOX_COLLECTION).doc(id)
}

function auditRef(db: Firestore, id: string): DocumentReference {
  return db.collection(AUDIT_LOG_COLLECTION).doc(id)
}

function letterRef(db: Firestore, id: string): DocumentReference {
  return db.collection(AUDIT_DEAD_LETTER_COLLECTION).doc(id)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** The letter that dead-letters an entry whole: its rows and metadata kept, and the recovered row it would have made. */
function wholeEntryLetter(entryId: string, data: unknown, reason: string, nowMs: number): StoredDeadLetter & Record<string, unknown> {
  const raw = isRecord(data) ? data : {}
  const firmId = typeof raw.firmId === "string" && raw.firmId !== "" ? raw.firmId : undefined
  const effectPaths = Array.isArray(raw.effectPaths) ? raw.effectPaths.filter((p): p is string => typeof p === "string") : []
  const rows = Array.isArray(raw.rows) ? raw.rows : []
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null)
  const row = recoveredAuditRow(
    entryId,
    {
      firmId: firmId ?? null,
      actorId: str(raw.actorId),
      route: str(raw.route),
      requestAction: str(raw.requestAction),
      operationId: str(raw.operationId),
      requestId: str(raw.requestId),
      effectPaths,
      rows,
      stagedAt: raw.stagedAt,
    },
    nowMs
  )
  const { rows: _rows, ...metadata } = raw
  return jsonCopy({
    row,
    reason,
    deadLetteredAt: nowMs,
    ...(firmId === undefined ? {} : { firmId }),
    source: "audit_outbox" as const,
    outboxId: entryId,
    rows,
    entry: { ...metadata, stagedAt: Number.isFinite(millisOf(raw.stagedAt)) ? millisOf(raw.stagedAt) : null },
  })
}

type Published = { kind: "gone" } | { kind: "dead_lettered"; reason: string; firmId: string | null } | {
  kind: "published"
  firmId: string
  rows: number
  superseded: number
  letters: Array<{ index: number; reason: string }>
}

/** One entry, in one transaction: publish it, or dead-letter it whole when it cannot be read. */
async function publishEntry(db: Firestore, entryId: string, nowMs: number): Promise<Published> {
  const ref = outboxRef(db, entryId)
  return db.runTransaction(async (tx: Transaction): Promise<Published> => {
    const snap = (await tx.get(ref)) as DocumentSnapshot
    if (!snap.exists) return { kind: "gone" }
    const parsed = parseOutboxEntry(snap.data())
    if (!parsed.ok) {
      tx.set(letterRef(db, `outbox_${entryId}`), wholeEntryLetter(entryId, snap.data(), parsed.reason, nowMs))
      tx.delete(ref)
      const firmId = snap.get("firmId")
      return { kind: "dead_lettered", reason: parsed.reason, firmId: typeof firmId === "string" ? firmId : null }
    }
    const entry = parsed.entry
    const checks = entry.rows.map((row) => checkStagedRow(row, entry.firmId))
    const publishable: Array<Record<string, unknown> & { id: string }> = []
    const seen = new Set<string>()
    for (const check of checks) {
      if (check.ok && !seen.has(check.row.id)) {
        seen.add(check.row.id)
        publishable.push(check.row)
      }
    }
    const refs = [...publishable.map((row) => auditRef(db, row.id)), auditRef(db, recoveredAuditRowId(entryId))]
    const existing = await tx.getAll(...refs)
    let rows = 0
    let superseded = 0
    publishable.forEach((row, i) => {
      if (existing[i]!.exists) {
        superseded += 1
        return
      }
      tx.create(refs[i]!, jsonCopy(row))
      rows += 1
    })
    if (!existing[existing.length - 1]!.exists) tx.create(refs[refs.length - 1]!, recoveredAuditRow(entryId, entry, nowMs))
    const letters: Array<{ index: number; reason: string }> = []
    checks.forEach((check, index) => {
      if (check.ok) return
      letters.push({ index, reason: check.reason })
      const letter: StoredDeadLetter = {
        row: entry.rows[index] ?? null,
        reason: check.reason,
        deadLetteredAt: nowMs,
        firmId: entry.firmId,
        source: "audit_outbox",
        outboxId: entryId,
      }
      tx.set(letterRef(db, `outbox_${entryId}_${index}`), jsonCopy(letter))
    })
    tx.delete(ref)
    return { kind: "published", firmId: entry.firmId, rows, superseded, letters }
  })
}

/** Dead-letters an entry whole after its counted failures (`publish_failed`); true when this run did it. */
async function deadLetterWhole(db: Firestore, entryId: string, reason: string, nowMs: number): Promise<boolean> {
  const ref = outboxRef(db, entryId)
  return db.runTransaction(async (tx: Transaction) => {
    const snap = (await tx.get(ref)) as DocumentSnapshot
    if (!snap.exists) return false
    tx.set(letterRef(db, `outbox_${entryId}`), wholeEntryLetter(entryId, snap.data(), reason, nowMs))
    tx.delete(ref)
    return true
  })
}

/** Measures the backlog and keeps the alert state (ruling 9). */
async function measureBacklog(db: Firestore, nowMs: number, swept: number | null, log: ReconcileLog): Promise<Backlog> {
  const outbox = db.collection(AUDIT_OUTBOX_COLLECTION)
  // The range keeps the order to timestamps: a null `stagedAt` sorts before every timestamp and would hide the oldest.
  const oldest = await outbox.where("stagedAt", ">=", EARLIEST_TIMESTAMP).orderBy("stagedAt").limit(1).get()
  const oldestMs = oldest.empty ? Number.NaN : millisOf(oldest.docs[0]!.get("stagedAt"))
  const oldestAgeMs = Number.isFinite(oldestMs) ? Math.max(0, nowMs - oldestMs) : null
  const stale = (await outbox.where("stagedAt", "<=", new Date(nowMs - AUDIT_OUTBOX_GRACE_MS)).count().get()).data().count
  const stateRef = db.collection(BACKLOG_STATE_COLLECTION).doc(BACKLOG_STATE_DOC)
  const previous = await stateRef.get()
  const wasFiring = previous.get("firing") === true
  // A run whose sweep failed keeps the last count: an entry it could not reach is not forgotten.
  const before = previous.get("unreadable")
  const unreadable = swept ?? (typeof before === "number" && Number.isSafeInteger(before) && before > 0 ? before : 0)
  const firing = (oldestAgeMs !== null && oldestAgeMs >= AUDIT_OUTBOX_ALERT_AGE_MS) || unreadable > 0
  const transition = firing && !wasFiring ? "fired" : !firing && wasFiring ? "cleared" : null
  const at = new Date(nowMs)
  await stateRef.set(
    {
      firing,
      oldestAgeMs,
      stale,
      unreadable,
      checkedAt: at,
      alertAgeMs: AUDIT_OUTBOX_ALERT_AGE_MS,
      ...(transition === "fired" ? { firedAt: at } : {}),
      ...(transition === "cleared" ? { clearedAt: at } : {}),
    },
    { merge: true }
  )
  if (firing) log.error("audit.outbox_backlog_stale", { oldestAgeMs, stale, unreadable, alertAgeMs: AUDIT_OUTBOX_ALERT_AGE_MS, event: "audit.outbox_backlog_stale" })
  if (transition === "cleared") log.info("audit.outbox_backlog_cleared", { oldestAgeMs, stale, unreadable })
  return { firing, transition, oldestAgeMs, stale, unreadable }
}

/**
 * True when the pass and the backlog queries can reach an entry with this `stagedAt` (ruling 19): a Firestore Timestamp
 * (the only stored value with a `toMillis` method) no further ahead than AUDIT_OUTBOX_MAX_FUTURE_MS. Anything else is swept.
 */
function reachableStagedAt(value: unknown, nowMs: number): boolean {
  if (!isRecord(value) || typeof value.toMillis !== "function") return false
  const ms = (value.toMillis as () => number)()
  return Number.isFinite(ms) && ms <= nowMs + AUDIT_OUTBOX_MAX_FUTURE_MS
}

type SweepOutcome = "dead_lettered" | "gone" | "reachable"

/** Dead-letters an entry the pass cannot reach, in a transaction that re-reads it. */
async function deadLetterUnreachable(db: Firestore, entryId: string, nowMs: number): Promise<SweepOutcome> {
  const ref = outboxRef(db, entryId)
  return db.runTransaction(async (tx: Transaction): Promise<SweepOutcome> => {
    const snap = (await tx.get(ref)) as DocumentSnapshot
    if (!snap.exists) return "gone"
    if (reachableStagedAt(snap.get("stagedAt"), nowMs)) return "reachable"
    tx.set(letterRef(db, `outbox_${entryId}`), wholeEntryLetter(entryId, snap.data(), "entry_malformed", nowMs))
    tx.delete(ref)
    return "dead_lettered"
  })
}

type SweepState = { after: string; pending: string[] }

function sweepStateOf(data: unknown, pendingMax: number): SweepState {
  const raw = isRecord(data) ? data : {}
  const after = typeof raw.after === "string" ? raw.after : ""
  const pending = Array.isArray(raw.pending) ? raw.pending.filter((id): id is string => typeof id === "string" && id !== "") : []
  return { after, pending: [...new Set(pending)].slice(0, pendingMax) }
}

/**
 * The sweep (ruling 19). First it retries the pending entries (ones an earlier run could not dead-letter). Then it reads
 * the page of the outbox after the cursor, by document id, and dead-letters every entry the pass cannot reach.
 *
 * The cursor moves only past entries this run handled: dead-lettered, found gone or reachable, or kept on the pending
 * list after a failure. When the budget runs out, or the pending list is full, the run stops at that entry and the
 * cursor stays on the last handled id, so the next run starts with it. A page shorter than the page size (an empty one
 * included) that was handled to its end wraps the cursor to the start. A run reads the pending list and one page at most.
 */
async function sweepUnreachable(
  db: Firestore,
  now: () => number,
  spent: () => boolean,
  log: ReconcileLog,
  limits: { pageSize: number; pendingMax: number }
): Promise<{ deadLettered: string[]; unreadable: number }> {
  const stateRef = db.collection(BACKLOG_STATE_COLLECTION).doc(SWEEP_CURSOR_DOC)
  const state = sweepStateOf((await stateRef.get()).data(), limits.pendingMax)
  const deadLettered: string[] = []
  const pending: string[] = []
  const seen = new Set<string>()
  /** Tries one entry; false when it could be neither dead-lettered nor kept (the pending list is full). */
  const attempt = async (entryId: string): Promise<boolean> => {
    if (seen.has(entryId)) return true
    seen.add(entryId)
    try {
      if ((await deadLetterUnreachable(db, entryId, now())) === "dead_lettered") {
        deadLettered.push(entryId)
        log.error("audit.outbox_dead_lettered", { outboxId: entryId, reason: "entry_malformed", stage: "sweep", event: "audit.outbox_dead_lettered" })
      }
      return true
    } catch (err) {
      log.error("audit.outbox_reconcile_failed", { outboxId: entryId, code: codeOf(err), transient: isRetryableReconcileError(err), stage: "sweep", event: "audit.outbox_reconcile_failed" })
      if (pending.length >= limits.pendingMax) return false
      pending.push(entryId)
      return true
    }
  }

  for (const entryId of state.pending) {
    // Out of budget: the rest stay pending, untried.
    if (spent()) {
      if (!seen.has(entryId)) pending.push(entryId)
      seen.add(entryId)
      continue
    }
    await attempt(entryId)
  }

  let after = state.after
  // Entries met but not handled this run (at most one: the entry the run stopped at for a full pending list).
  let unhandled = 0
  if (!spent()) {
    const base = db.collection(AUDIT_OUTBOX_COLLECTION).orderBy("__name__").select("stagedAt").limit(limits.pageSize)
    const page = await (state.after === "" ? base : base.startAfter(state.after)).get()
    let handled = state.after
    let stopped = false
    for (const doc of page.docs) {
      if (spent()) {
        stopped = true
        break
      }
      if (!reachableStagedAt(doc.get("stagedAt"), now()) && !(await attempt(doc.id))) {
        unhandled = 1
        stopped = true
        break
      }
      handled = doc.id
    }
    after = stopped || page.size >= limits.pageSize ? handled : ""
  }
  const changed = after !== state.after || pending.length !== state.pending.length || pending.some((id, i) => id !== state.pending[i])
  if (changed) await stateRef.set({ after, pending, checkedAt: new Date(now()) })
  return { deadLettered, unreadable: pending.length + unhandled }
}

/** One reconciler run (see the module comment). */
export async function reconcileAuditOutbox(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { db } = deps
  const now = deps.now ?? Date.now
  const clock = deps.clock ?? Date.now
  const log = deps.log ?? consoleLog
  const started = clock()
  const spent = () => clock() - started >= RECONCILE_BUDGET_MS
  const result: ReconcileResult = {
    published: [],
    deadLettered: [],
    deferred: [],
    counted: [],
    rowsPublished: 0,
    rowsSuperseded: 0,
    rowsDeadLettered: 0,
    backlog: { firing: false, transition: null, oldestAgeMs: null, stale: 0, unreadable: 0 },
  }
  const tried = new Set<string>()

  const handle = async (doc: QueryDocumentSnapshot) => {
    const entryId = doc.id
    if (tried.has(entryId)) return
    tried.add(entryId)
    const nowMs = now()
    try {
      const outcome = await publishEntry(db, entryId, nowMs)
      if (outcome.kind === "gone") return
      if (outcome.kind === "dead_lettered") {
        result.deadLettered.push(entryId)
        log.error("audit.outbox_dead_lettered", { outboxId: entryId, firmId: outcome.firmId, reason: outcome.reason, event: "audit.outbox_dead_lettered" })
        return
      }
      result.published.push(entryId)
      result.rowsPublished += outcome.rows
      result.rowsSuperseded += outcome.superseded
      result.rowsDeadLettered += outcome.letters.length
      for (const letter of outcome.letters) {
        log.error("audit.outbox_row_dead_lettered", { outboxId: entryId, firmId: outcome.firmId, index: letter.index, reason: letter.reason, event: "audit.outbox_row_dead_lettered" })
      }
      log.info("audit.outbox_published", { outboxId: entryId, firmId: outcome.firmId, rows: outcome.rows, superseded: outcome.superseded })
    } catch (err) {
      const code = codeOf(err)
      if (isRetryableReconcileError(err)) {
        result.deferred.push(entryId)
        log.warn("audit.outbox_reconcile_failed", { outboxId: entryId, code, transient: true })
        return
      }
      const before = doc.get("attempts")
      const attempts = (typeof before === "number" && Number.isSafeInteger(before) && before >= 0 ? before : 0) + 1
      log.error("audit.outbox_reconcile_failed", { outboxId: entryId, code, transient: false, attempts, event: "audit.outbox_reconcile_failed" })
      try {
        if (attempts >= AUDIT_OUTBOX_MAX_ATTEMPTS) {
          if (await deadLetterWhole(db, entryId, "publish_failed", nowMs)) {
            result.deadLettered.push(entryId)
            log.error("audit.outbox_dead_lettered", { outboxId: entryId, firmId: doc.get("firmId") ?? null, reason: "publish_failed", code, event: "audit.outbox_dead_lettered" })
          }
          return
        }
        await outboxRef(db, entryId).update({ attempts, lastErrorCode: code, lastFailedAt: new Date(nowMs) })
        result.counted.push(entryId)
      } catch (bookkeeping) {
        log.error("audit.outbox_reconcile_failed", { outboxId: entryId, code: codeOf(bookkeeping), transient: isRetryableReconcileError(bookkeeping), stage: "bookkeeping", event: "audit.outbox_reconcile_failed" })
      }
    }
  }

  // The sweep first (ruling 19): its reads are bounded, and an entry the pass cannot reach is never left uncounted.
  let unreadable: number | null = null
  try {
    const swept = await sweepUnreachable(db, now, spent, log, {
      pageSize: deps.sweepPageSize ?? SWEEP_PAGE_SIZE,
      pendingMax: deps.sweepPendingMax ?? SWEEP_PENDING_MAX,
    })
    result.deadLettered.push(...swept.deadLettered)
    unreadable = swept.unreadable
  } catch (err) {
    log.error("audit.outbox_sweep_failed", { code: codeOf(err), transient: isRetryableReconcileError(err), event: "audit.outbox_sweep_failed" })
  }

  const cutoff = new Date(now() - AUDIT_OUTBOX_GRACE_MS)
  const stale = db.collection(AUDIT_OUTBOX_COLLECTION).where("stagedAt", "<=", cutoff).orderBy("stagedAt").limit(RECONCILE_PAGE_SIZE)
  let last: QueryDocumentSnapshot | undefined
  for (let pageNo = 0; pageNo < RECONCILE_MAX_PAGES && !spent(); pageNo += 1) {
    const page = await (last === undefined ? stale : stale.startAfter(last)).get()
    for (const doc of page.docs) {
      if (spent()) break
      await handle(doc)
    }
    if (page.size < RECONCILE_PAGE_SIZE) break
    last = page.docs[page.docs.length - 1]
  }
  if (spent()) log.warn("audit.outbox_budget_spent", { published: result.published.length, deadLettered: result.deadLettered.length })
  result.backlog = await measureBacklog(db, now(), unreadable, log)
  return result
}
