import { Timestamp, type DocumentReference, type Query, type QueryDocumentSnapshot, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { logFailure } from "../log"
import { DISPATCH_GRACE_MS, JOB_ENGINE, MAX_ATTEMPTS, MAX_CLOCK_SKEW_MS, MAX_REDISPATCH_BACKOFF_MS, SWEEP_LIMIT, SWEEP_MAX_PAGES, redispatchBackoffMs } from "./constants"
import type { JobDeps } from "./dispatch"
import { jobsRef, stageJobUpdate, type JobRow } from "./enqueue"
import { JobError, sanitizeError } from "./errors"
import { stageFailure } from "./worker"

/**
 * The sweeper (spec P3-8, P3-34..P3-36), the engine's safety net, run every minute by `jobSweeper`.
 *
 * - Query A: a `queued` or `failed` row due at least `DISPATCH_GRACE_MS` ago whose dispatch was
 *   lost (a lost trigger, a failed after-commit dispatch) is re-dispatched with `seq + 1`.
 * - Query B: a `running` row whose lease has expired (its worker died) is re-dispatched so the
 *   worker reclaims it with `attempts + 1`, or dead-lettered with `lease_expired` at attempt 4.
 *
 * `sweepAt` (P3-34). Every status change writes `sweepAt`, the earliest time the sweeper may act on
 * the row: enqueue and a manual requeue now + `DISPATCH_GRACE_MS`, a scheduled retry `nextAttemptAt`
 * + the grace, a claim the lease's `expiresAt`, a sweeper re-dispatch now + its backoff, a finished
 * row null. Query A is `status in [queued, failed] and sweepAt <= now`, query B `status == running
 * and sweepAt <= now`, both ordered by `sweepAt`. So a query returns only rows the sweeper can act
 * on, and a row it acts on moves its `sweepAt` past `now` and leaves the result set: rows declined
 * at the head of the order can no longer hide the rows behind them (O-36's head-of-line block).
 * `sweepAt` only decides what a query returns; the per-row re-read (`lostDispatch`,
 * `expiredLease`, `redispatchable`) stays the authority.
 *
 * Query A' (clock skew). A sweep on a clock running ahead stamps `sweepAt` ahead too, which would
 * hide the row from correct sweeps until true time caught up. No writer on a correct clock sets a
 * `queued` or `failed` row's `sweepAt` more than `MAX_REDISPATCH_BACKOFF_MS` ahead (enqueue and
 * requeue + 30 s, a retry at most + 55 s, a re-dispatch at most + 600 s), so after query A the
 * sweep also reads `status in [queued, failed] and sweepAt > now + MAX_REDISPATCH_BACKOFF_MS`, and
 * query A's re-read, whose skew rule distrusts a `dispatchedAt` more than `MAX_CLOCK_SKEW_MS`
 * ahead, decides each row. A stamp from a clock running ahead so delays a row by at most
 * `MAX_CLOCK_SKEW_MS + MAX_REDISPATCH_BACKOFF_MS` (15 min), not by the clock's whole lead. (A
 * claim on a clock running ahead stamps a late lease expiry, and so a late `sweepAt`, for query B,
 * exactly as the lease alone did before P3-34.)
 *
 * Re-dispatch backoff (P3-35). A re-dispatch is allowed only `redispatchBackoffMs(redispatches)`
 * after the row's last dispatch: 30 s for a row the sweeper has not yet re-dispatched, then 60 s,
 * 120 s, ... capped at `MAX_REDISPATCH_BACKOFF_MS` (600 s), unless `dispatchedAt` lies more than
 * `MAX_CLOCK_SKEW_MS` ahead (a stamp from a clock running ahead is not trusted). The transaction
 * stamps `dispatchedAt = now`, bumps `dispatchSeq` and `redispatches`, and sets `sweepAt = now +
 * the new backoff`, so concurrent sweeps dispatch a job once and a row waiting behind a backed-up
 * queue gets a few tasks an hour rather than one a minute; the dispatch happens after commit. A
 * claim, a scheduled retry and a manual requeue reset `redispatches` to 0. Query B applies the
 * same rule to its re-dispatch (P3-8 storm bound 3; without it, a second concurrent sweep would
 * re-read the still-expired lease and dispatch again). Its dead-letter at attempt 4 is not backed
 * off: it fires as soon as the lease has expired (`sweepAt` equals the expiry).
 *
 * Paging (P3-36). Each query runs up to `SWEEP_MAX_PAGES` pages of `SWEEP_LIMIT` rows. A page is
 * re-queried, not cursored, because the rows acted on have left the result set. The loop stops on
 * a short page, after the last page, or when a page dispatched and dead-lettered nothing (every
 * row lost its race), so a sweep cannot spin. A row is settled at most once per sweep.
 *
 * A re-dispatch adds a task; it does not cancel the earlier ones. The worker lets any task with
 * `seq <= dispatchSeq` claim a claimable row (Task 4 fix round, I-1), so in a backed-up queue the
 * oldest task still runs the job when it arrives, and the newer ones then find it running or
 * finished and are dropped. The claim's lease, not the seq, keeps the job single-runner.
 *
 * Each query runs on its own: a failed query is logged and the sweep goes on to the next one, so
 * a query A fault (an index still building, a transient store error) never skips query B.
 */

export type SweepResult = { dispatched: string[]; deadLettered: string[] }

const at = (ms: number) => Timestamp.fromMillis(ms)
const millis = (t: unknown): number | null => (t instanceof Timestamp ? t.toMillis() : null)

/** The row's sweeper re-dispatch count; a row written before P3-35 has none and counts 0. */
const redispatchesOf = (row: JobRow): number => (typeof row.redispatches === "number" ? row.redispatches : 0)

/** The re-dispatch backoff (P3-35): `redispatchBackoffMs`, unless a test has set `sweepTestSeam.backoffMs`. */
const backoffMs = (redispatches: number): number => sweepTestSeam.backoffMs?.(redispatches) ?? redispatchBackoffMs(redispatches)

/** Whether the row's last dispatch is old enough (its backoff, P3-35), or untrustworthy enough, to dispatch again. */
function redispatchable(row: JobRow, now: number): boolean {
  const last = millis(row.dispatchedAt)
  if (last === null) return true
  return last <= now - backoffMs(redispatchesOf(row)) || last > now + MAX_CLOCK_SKEW_MS
}

/** Query A's re-read: still an engine row, queued or failed, due past the grace, and re-dispatchable. */
function lostDispatch(row: JobRow | undefined, now: number): row is JobRow {
  if (!row || row.engine !== JOB_ENGINE || (row.status !== "queued" && row.status !== "failed")) return false
  const due = millis(row.nextAttemptAt)
  return due !== null && due <= now - DISPATCH_GRACE_MS && redispatchable(row, now)
}

/** Query B's re-read: still an engine row, running, with an expired lease. */
function expiredLease(row: JobRow | undefined, now: number): row is JobRow {
  if (!row || row.engine !== JOB_ENGINE || row.status !== "running" || row.lease === null || typeof row.lease !== "object") return false
  const expires = millis(row.lease.expiresAt)
  return expires !== null && expires <= now
}

type RowAction = { kind: "none" } | { kind: "dispatch"; seq: number } | { kind: "dead_letter"; row: JobRow }

/** Stages the re-dispatch bookkeeping: `dispatchSeq + 1`, `dispatchedAt = now`, `redispatches + 1`, `sweepAt = now + backoff`. */
function stageRedispatch(tx: Transaction, ref: DocumentReference, row: JobRow, now: number): RowAction {
  const seq = row.dispatchSeq + 1
  const redispatches = redispatchesOf(row) + 1
  stageJobUpdate(tx, ref, { dispatchSeq: seq, dispatchedAt: at(now), redispatches, sweepAt: at(now + backoffMs(redispatches)), updatedAt: at(now) })
  return { kind: "dispatch", seq }
}

async function sweepLostDispatch(ref: DocumentReference, deps: JobDeps): Promise<RowAction> {
  return adminDb().runTransaction(async (tx): Promise<RowAction> => {
    const now = deps.clock()
    const snap = await tx.get(ref)
    const row = snap.exists ? (snap.data() as JobRow) : undefined
    if (!lostDispatch(row, now)) return { kind: "none" }
    return stageRedispatch(tx, ref, row, now)
  })
}

async function sweepExpiredLease(ref: DocumentReference, deps: JobDeps): Promise<RowAction> {
  return adminDb().runTransaction(async (tx): Promise<RowAction> => {
    const now = deps.clock()
    const snap = await tx.get(ref)
    const row = snap.exists ? (snap.data() as JobRow) : undefined
    if (!expiredLease(row, now)) return { kind: "none" }
    if (row.attempts >= MAX_ATTEMPTS) {
      // The attempt that lost its lease was the round's last: dead-letter (P3-7 events, audit; alert after commit).
      stageFailure(tx, ref, row, sanitizeError(new JobError("lease_expired", { permanent: true })), now)
      return { kind: "dead_letter", row }
    }
    if (!redispatchable(row, now)) return { kind: "none" }
    return stageRedispatch(tx, ref, row, now)
  })
}

/** Runs one row's transaction, then its after-commit dispatch or alert. A failure is logged and the sweep goes on. */
async function settle(ref: DocumentReference, step: (ref: DocumentReference) => Promise<RowAction>, deps: JobDeps, out: SweepResult): Promise<void> {
  let action: RowAction
  try {
    action = await step(ref)
  } catch (err) {
    logFailure("job sweep failed", err)
    return
  }
  if (action.kind === "dispatch") {
    try {
      await deps.dispatcher.dispatch({ jobId: ref.id, seq: action.seq })
      out.dispatched.push(ref.id)
    } catch (err) {
      // The row is stamped; a sweep after its backoff (sweepAt) tries again.
      logFailure("job dispatch failed", err)
    }
  } else if (action.kind === "dead_letter") {
    out.deadLettered.push(ref.id)
    const { row } = action
    try {
      await deps.alert.deadLettered({ jobId: ref.id, jobType: row.jobType, firmId: row.firmId, attempts: row.totalAttempts, code: "lease_expired" })
    } catch (err) {
      logFailure("job alert failed", err)
    }
  }
}

/** The sweep's queries: A (lost dispatch), A' as "skew" (a lost dispatch stamped by a clock running ahead), B (expired lease). */
export type SweepQueryName = "A" | "skew" | "B"

/**
 * Test hooks (spec §7), set in a test and deleted in `finally`: `beforeQuery` runs before each query
 * page; `backoffMs` replaces `redispatchBackoffMs` (the P3-37 load test's control run forces the
 * fixed grace with it). Unset in production.
 */
export const sweepTestSeam: { beforeQuery?: (name: SweepQueryName) => Promise<void>; backoffMs?: (redispatches: number) => number } = {}

const actedOn = (out: SweepResult): number => out.dispatched.length + out.deadLettered.length

/**
 * Runs one query in pages (P3-36) and settles each row it returns that this sweep has not yet
 * settled. A row whose queried snapshot already fails `qualifies` is skipped without a
 * transaction (the transaction's re-read stays the authority for every row it does open). Stops on
 * a short page, after `SWEEP_MAX_PAGES`, or on a page that acted on no row. A failed page is
 * logged and ends the query.
 */
async function sweepQuery(
  name: SweepQueryName,
  query: Query,
  qualifies: (row: JobRow | undefined, now: number) => boolean,
  step: (ref: DocumentReference) => Promise<RowAction>,
  deps: JobDeps,
  out: SweepResult,
  settled: Set<string>
): Promise<void> {
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    let docs: QueryDocumentSnapshot[]
    try {
      await sweepTestSeam.beforeQuery?.(name)
      docs = (await query.get()).docs
    } catch (err) {
      logFailure("job sweep failed", err)
      return
    }
    const before = actedOn(out)
    for (const doc of docs) {
      if (settled.has(doc.ref.path)) continue
      settled.add(doc.ref.path)
      if (!qualifies(doc.data() as JobRow, deps.clock())) continue
      await settle(doc.ref, step, deps, out)
    }
    if (docs.length < SWEEP_LIMIT || actedOn(out) === before) return
  }
}

/** One sweep at `deps.clock()`: query A, then A' (skew), then query B. Returns the job ids it re-dispatched and dead-lettered. */
export async function sweep(deps: JobDeps): Promise<SweepResult> {
  const out: SweepResult = { dispatched: [], deadLettered: [] }
  const settled = new Set<string>()
  const now = deps.clock()
  const due = at(now)
  const waiting = () => jobsRef().where("status", "in", ["queued", "failed"])
  const lost = waiting().where("sweepAt", "<=", due).orderBy("sweepAt").limit(SWEEP_LIMIT)
  await sweepQuery("A", lost, lostDispatch, (ref) => sweepLostDispatch(ref, deps), deps, out, settled)
  const skewed = waiting().where("sweepAt", ">", at(now + MAX_REDISPATCH_BACKOFF_MS)).orderBy("sweepAt").limit(SWEEP_LIMIT)
  await sweepQuery("skew", skewed, lostDispatch, (ref) => sweepLostDispatch(ref, deps), deps, out, settled)
  const expired = jobsRef().where("status", "==", "running").where("sweepAt", "<=", due).orderBy("sweepAt").limit(SWEEP_LIMIT)
  await sweepQuery("B", expired, expiredLease, (ref) => sweepExpiredLease(ref, deps), deps, out, settled)
  return out
}
