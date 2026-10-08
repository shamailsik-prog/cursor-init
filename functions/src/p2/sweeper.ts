import { Timestamp, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { logFailure } from "../log"
import { DISPATCH_GRACE_MS, JOB_ENGINE, MAX_ATTEMPTS, MAX_CLOCK_SKEW_MS, SWEEP_LIMIT } from "./constants"
import type { JobDeps } from "./dispatch"
import { jobsRef, type JobRow } from "./enqueue"
import { JobError, sanitizeError } from "./errors"
import { stageFailure } from "./worker"

/**
 * The sweeper (spec P3-8), the engine's safety net, run every minute by `jobSweeper`.
 *
 * - Query A: a `queued` or `failed` row due at least `DISPATCH_GRACE_MS` ago whose dispatch was
 *   lost (a lost trigger, a failed after-commit dispatch) is re-dispatched with `seq + 1`.
 * - Query B: a `running` row whose lease has expired (its worker died) is re-dispatched so the
 *   worker reclaims it with `attempts + 1`, or dead-lettered with `lease_expired` at attempt 4.
 *
 * Each row is re-read in its own transaction, and a row that no longer qualifies is left
 * unwritten. A re-dispatch is allowed only `DISPATCH_GRACE_MS` after the row's last dispatch
 * (storm bound 3), unless `dispatchedAt` lies more than `MAX_CLOCK_SKEW_MS` ahead: a stamp from a
 * clock running ahead is not trusted. The transaction stamps `dispatchedAt = now` and bumps
 * `dispatchSeq`, so concurrent sweeps dispatch a job once; the dispatch happens after commit.
 * Query B applies the same rule to its re-dispatch (P3-8 storm bound 3; without it, a second
 * concurrent sweep would re-read the still-expired lease and dispatch again).
 */

export type SweepResult = { dispatched: string[]; deadLettered: string[] }

const at = (ms: number) => Timestamp.fromMillis(ms)
const millis = (t: unknown): number | null => (t instanceof Timestamp ? t.toMillis() : null)

/** Whether the row's last dispatch is old enough (or untrustworthy enough) to dispatch again. */
function redispatchable(row: JobRow, now: number): boolean {
  const last = millis(row.dispatchedAt)
  if (last === null) return true
  return last <= now - DISPATCH_GRACE_MS || last > now + MAX_CLOCK_SKEW_MS
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

/** Stages the re-dispatch bookkeeping: `dispatchSeq + 1`, `dispatchedAt = now`. */
function stageRedispatch(tx: Transaction, ref: DocumentReference, row: JobRow, now: number): RowAction {
  const seq = row.dispatchSeq + 1
  tx.update(ref, { dispatchSeq: seq, dispatchedAt: at(now), updatedAt: at(now) })
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
      // The row is stamped; the next sweep after DISPATCH_GRACE_MS tries again.
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

/** One sweep at `deps.clock()`: query A, then query B. Returns the job ids it re-dispatched and dead-lettered. */
export async function sweep(deps: JobDeps): Promise<SweepResult> {
  const out: SweepResult = { dispatched: [], deadLettered: [] }
  const now = deps.clock()
  const due = await jobsRef()
    .where("status", "in", ["queued", "failed"])
    .where("nextAttemptAt", "<=", at(now - DISPATCH_GRACE_MS))
    .orderBy("nextAttemptAt")
    .limit(SWEEP_LIMIT)
    .get()
  for (const doc of due.docs) await settle(doc.ref, (ref) => sweepLostDispatch(ref, deps), deps, out)
  const expired = await jobsRef()
    .where("status", "==", "running")
    .where("lease.expiresAt", "<=", at(now))
    .orderBy("lease.expiresAt")
    .limit(SWEEP_LIMIT)
    .get()
  for (const doc of expired.docs) await settle(doc.ref, (ref) => sweepExpiredLease(ref, deps), deps, out)
  return out
}
