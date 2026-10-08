import { randomUUID } from "node:crypto"
import { Timestamp, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminDb } from "../admin"
import { logFailure } from "../log"
import { stageJobAudit } from "./audit"
import { CLOCK_SKEW_TOLERANCE_MS, JOB_ENGINE, JOB_LEASE_MS, MAX_ATTEMPTS, MAX_LOG_ENTRIES, MAX_REFS, RETRY_DELAYS_MS } from "./constants"
import type { JobDeps, JobTask } from "./dispatch"
import { isSafeRef, jobsRef, type JobLogEntry, type JobLogEvent, type JobRow } from "./enqueue"
import { JobError, LeaseLostError, sanitizeError, type SanitizedError } from "./errors"
import { stageJobDeadLetteredEvent, stageJobFailedEvent } from "./jobEvents"
import { handlerFor, type JobHandler, type JobResult } from "./registry"

/**
 * The P2 worker (spec P3-3, P3-6, P3-7, P3-9, P3-18). One delivery of task `{ jobId, seq }`:
 *
 * 1. Claim (one transaction): drop unless the row is an engine row, `seq == dispatchSeq` and the
 *    row is due (`queued`/`failed` with `nextAttemptAt <= now + 2 s`) or its lease has expired.
 *    Otherwise take a fresh lease (600 s) and count the attempt; a reclaim at attempt 4 dead-letters.
 * 2. Run the handler, raced against the handler budget (`handler_timeout`, retryable).
 * 3. Commit (one transaction): re-read; if this claim's fence no longer holds, write nothing.
 *    Otherwise `done` with the handler's `apply`, or `failed` / `dead_lettered` (`stageFailure`).
 * 4. After commit: dispatch the retry at `nextAttemptAt`, or raise the dead-letter alert.
 *
 * The worker never re-dispatches a dropped task: recovery belongs to the sweeper (P3-8).
 */

export type TaskOutcome = "dropped" | "done" | "failed" | "dead_lettered" | "lease_lost"

type SeamContext = { jobId: string; owner: string }

/** Test hooks between claim and commit (spec §7), set in a test and deleted in `finally`. */
export const jobWorkerTestSeam: {
  afterClaim?: (c: SeamContext) => Promise<void>
  afterHandler?: (c: SeamContext) => Promise<void>
} = {}

const at = (ms: number) => Timestamp.fromMillis(ms)

/** Appends a log entry, keeping the last `MAX_LOG_ENTRIES`. */
function appendLog(row: Pick<JobRow, "logs">, event: JobLogEvent, attempt: number, now: number, code?: string): JobLogEntry[] {
  const entry: JobLogEntry = code === undefined ? { at: at(now), event, attempt } : { at: at(now), event, attempt, code }
  return [...(Array.isArray(row.logs) ? row.logs : []), entry].slice(-MAX_LOG_ENTRIES)
}

function auditSubject(id: string, row: JobRow) {
  return { id, firmId: row.firmId, classification: row.classification, createdBy: row.createdBy }
}

/**
 * Stages the end of a failed attempt (shared with the sweeper's `lease_expired` dead-letter).
 * `row` is the row as read in `tx`, its `attempts` counting the attempt that failed. A retryable
 * error below `MAX_ATTEMPTS` → `failed`, due after `RETRY_DELAYS_MS[attempts - 1]`, with
 * `dispatchSeq + 1` (the caller dispatches after commit). Otherwise → `dead_lettered` (the caller
 * raises the alert after commit). Both stage `job.failed`, and the dead-letter also
 * `job.deadLettered`, plus the system audit row. Writes only; the caller has done its reads.
 */
export function stageFailure(tx: Transaction, ref: DocumentReference, row: JobRow, err: SanitizedError, now: number): "failed" | "dead_lettered" {
  return stageFailureRow(tx, ref, row, err, now).status as "failed" | "dead_lettered"
}

/** `stageFailure`, returning the post-transition row (for the after-commit dispatch or alert). */
function stageFailureRow(tx: Transaction, ref: DocumentReference, row: JobRow, err: SanitizedError, now: number): JobRow {
  const lastError = { code: err.code, message: err.message }
  const retry = !err.permanent && row.attempts < MAX_ATTEMPTS
  const next: JobRow = retry
    ? {
        ...row,
        status: "failed",
        lastError,
        nextAttemptAt: at(now + RETRY_DELAYS_MS[Math.max(0, row.attempts - 1)]),
        dispatchSeq: row.dispatchSeq + 1,
        dispatchedAt: at(now),
        lease: null,
        updatedAt: at(now),
        logs: appendLog(row, "failed", row.attempts, now, err.code),
      }
    : {
        ...row,
        status: "dead_lettered",
        lastError,
        nextAttemptAt: null,
        lease: null,
        updatedAt: at(now),
        finishedAt: at(now),
        logs: appendLog(row, "dead_lettered", row.attempts, now, err.code),
      }
  tx.update(ref, {
    status: next.status,
    lastError: next.lastError,
    nextAttemptAt: next.nextAttemptAt,
    dispatchSeq: next.dispatchSeq,
    dispatchedAt: next.dispatchedAt,
    lease: null,
    updatedAt: next.updatedAt,
    finishedAt: next.finishedAt,
    logs: next.logs,
  })
  stageJobFailedEvent(tx, ref.id, next, err.code, now)
  if (!retry) stageJobDeadLetteredEvent(tx, ref.id, next, err.code, now)
  // appendAudit stages its tx.create synchronously, before its first await, so the row is in this
  // transaction when stageJobAudit returns; the promise only reports a (programming) error.
  stageJobAudit(tx, auditSubject(ref.id, row), retry ? "job.fail" : "job.dead_letter", err.code).catch((e: unknown) =>
    logFailure("job audit staging failed", e)
  )
  return next
}

type Claimed = { kind: "claimed"; row: JobRow; owner: string }
/** An attempt that ended in failure: the post-transition row and the sanitised code. */
type Ended = { kind: "failed" | "dead_lettered"; next: JobRow; code: string }

function ended(next: JobRow, code: string): Ended {
  return { kind: next.status as Ended["kind"], next, code }
}

type ClaimResult = { kind: "dropped" } | Claimed | Ended

/** Whether this delivery may start an attempt (P3-6, P3-8 storm bound 2). */
function claimable(row: JobRow | undefined, seq: number, now: number): row is JobRow {
  if (!row || row.engine !== JOB_ENGINE || row.dispatchSeq !== seq) return false
  if (row.status === "queued" || row.status === "failed") {
    return row.nextAttemptAt instanceof Timestamp && row.nextAttemptAt.toMillis() <= now + CLOCK_SKEW_TOLERANCE_MS
  }
  if (row.status === "running") return row.lease !== null && row.lease.expiresAt instanceof Timestamp && row.lease.expiresAt.toMillis() <= now
  return false
}

async function claim(ref: DocumentReference, task: JobTask, deps: JobDeps): Promise<ClaimResult> {
  return adminDb().runTransaction(async (tx): Promise<ClaimResult> => {
    const now = deps.clock()
    const snap = await tx.get(ref)
    const row = snap.exists ? (snap.data() as JobRow) : undefined
    if (!claimable(row, task.seq, now)) return { kind: "dropped" }
    const reclaim = row.status === "running"
    if (reclaim && row.attempts >= MAX_ATTEMPTS) {
      const err = sanitizeError(new JobError("lease_expired"))
      return ended(stageFailureRow(tx, ref, row, err, now), err.code)
    }
    const owner = randomUUID()
    const claimed: JobRow = {
      ...row,
      status: "running",
      attempts: row.attempts + 1,
      totalAttempts: row.totalAttempts + 1,
      lease: { owner, expiresAt: at(now + JOB_LEASE_MS) },
      startedAt: at(now),
      updatedAt: at(now),
      logs: appendLog(row, reclaim ? "reclaimed" : "claimed", row.attempts + 1, now),
    }
    tx.update(ref, {
      status: claimed.status,
      attempts: claimed.attempts,
      totalAttempts: claimed.totalAttempts,
      lease: claimed.lease,
      startedAt: claimed.startedAt,
      updatedAt: claimed.updatedAt,
      logs: claimed.logs,
    })
    await stageJobAudit(tx, auditSubject(ref.id, row), "job.start", reclaim ? "lease_expired_reclaim" : "ok")
    return { kind: "claimed", row: claimed, owner }
  })
}

const fenceHolds = (row: JobRow | undefined, owner: string): row is JobRow => row?.status === "running" && row.lease?.owner === owner

/** Runs `fn` in a transaction that first re-reads the job and checks this claim's fence. */
function runFencedFor(ref: DocumentReference, owner: string) {
  return <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    adminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!fenceHolds(snap.exists ? (snap.data() as JobRow) : undefined, owner)) throw new LeaseLostError()
      return fn(tx)
    })
}

/** Races `work` against the budget; the timer is always cleared. */
async function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const overrun = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobError("handler_timeout")), budgetMs)
  })
  try {
    return await Promise.race([work, overrun])
  } finally {
    clearTimeout(timer)
  }
}

type HandlerOutcome = { ok: true; result: JobResult; handler: JobHandler } | { ok: false; err: unknown; handler: JobHandler | undefined }

async function runHandler(ref: DocumentReference, claimed: Claimed, deps: JobDeps): Promise<HandlerOutcome> {
  const { row, owner } = claimed
  const handler = handlerFor(row.jobType)
  try {
    if (!handler) throw new JobError("unknown_job_type", { permanent: true })
    const payload = handler.parse(row.payload)
    const result = await withinBudget(
      handler.run({
        job: {
          id: ref.id,
          firmId: row.firmId,
          jobType: row.jobType,
          classification: row.classification,
          matterId: row.matterId,
          attempt: row.attempts,
          totalAttempts: row.totalAttempts,
          traceId: row.traceId,
        },
        payload,
        now: deps.clock,
        runFenced: runFencedFor(ref, owner),
      }),
      deps.handlerBudgetMs
    )
    return { ok: true, result: result ?? {}, handler }
  } catch (err) {
    return { ok: false, err, handler }
  }
}

/** Thrown out of the commit transaction when a handler's `apply` fails, so nothing it staged commits. */
class ApplyFailed extends Error {
  constructor(readonly original: unknown) {
    super("apply_failed")
  }
}

type CommitResult = { kind: "lease_lost" } | { kind: "done" } | Ended

async function commit(ref: DocumentReference, owner: string, outcome: HandlerOutcome, deps: JobDeps): Promise<CommitResult> {
  return adminDb().runTransaction(async (tx): Promise<CommitResult> => {
    const now = deps.clock()
    const snap = await tx.get(ref)
    const row = snap.exists ? (snap.data() as JobRow) : undefined
    if (!fenceHolds(row, owner)) return { kind: "lease_lost" }
    const fail = (e: unknown) => {
      const err = sanitizeError(e, outcome.handler)
      return ended(stageFailureRow(tx, ref, row, err, now), err.code)
    }
    if (!outcome.ok) return fail(outcome.err)
    // A handler bug (bad refs) is a retryable internal error; nothing of the result is applied.
    const outputRefs = outcome.result.outputRefs ?? []
    if (!Array.isArray(outputRefs) || outputRefs.length > MAX_REFS || !outputRefs.every(isSafeRef)) return fail(new JobError("internal"))
    try {
      outcome.result.apply?.(tx)
    } catch (err) {
      throw new ApplyFailed(err)
    }
    tx.update(ref, {
      status: "done",
      outputRefs: [...outputRefs],
      lease: null,
      nextAttemptAt: null,
      updatedAt: at(now),
      finishedAt: at(now),
      logs: appendLog(row, "done", row.attempts, now),
    })
    await stageJobAudit(tx, auditSubject(ref.id, row), "job.done", "ok")
    return { kind: "done" }
  })
}

/** Commits the outcome; an `apply` that throws is committed as that error instead (nothing it staged). */
async function commitOutcome(ref: DocumentReference, owner: string, outcome: HandlerOutcome, deps: JobDeps): Promise<CommitResult> {
  try {
    try {
      return await commit(ref, owner, outcome, deps)
    } catch (err) {
      if (!(err instanceof ApplyFailed)) throw err
      return await commit(ref, owner, { ok: false, err: err.original, handler: outcome.handler }, deps)
    }
  } catch (err) {
    // The row stays `running`: a redelivery is dropped, and the lease and sweeper query B recover it.
    logFailure("job commit failed", err)
    throw err
  }
}

/** After commit: dispatch the scheduled retry, or raise the dead-letter alert. Failures are logged and swallowed. */
async function afterCommit(jobId: string, end: Ended, deps: JobDeps): Promise<void> {
  if (end.kind === "failed") {
    try {
      await deps.dispatcher.dispatch({ jobId, seq: end.next.dispatchSeq }, { scheduleAt: end.next.nextAttemptAt?.toMillis() })
    } catch (err) {
      // The sweeper re-dispatches the due row after DISPATCH_GRACE_MS (P3-8).
      logFailure("job dispatch failed", err)
    }
    return
  }
  try {
    await deps.alert.deadLettered({ jobId, jobType: end.next.jobType, firmId: end.next.firmId, attempts: end.next.totalAttempts, code: end.code })
  } catch (err) {
    logFailure("job alert failed", err)
  }
}

function leaseLost(jobId: string, jobType: string): "lease_lost" {
  logger.warn("job.lease_lost", { jobId, jobType })
  return "lease_lost"
}

/**
 * Handles one delivery of `task`. Throws only when a claim or commit transaction fails (a store
 * error); every other path resolves with its outcome.
 */
export async function runJobTask(task: JobTask, deps: JobDeps): Promise<TaskOutcome> {
  const ref = jobsRef().doc(task.jobId)
  const claimed = await claim(ref, task, deps)
  if (claimed.kind === "dropped") return "dropped"
  if (claimed.kind !== "claimed") {
    await afterCommit(ref.id, claimed, deps)
    return claimed.kind
  }
  const seam = { jobId: ref.id, owner: claimed.owner }
  await jobWorkerTestSeam.afterClaim?.(seam)
  const outcome = await runHandler(ref, claimed, deps)
  await jobWorkerTestSeam.afterHandler?.(seam)
  if (!outcome.ok && outcome.err instanceof LeaseLostError) return leaseLost(ref.id, claimed.row.jobType)
  const result = await commitOutcome(ref, claimed.owner, outcome, deps)
  if (result.kind === "lease_lost") return leaseLost(ref.id, claimed.row.jobType)
  if (result.kind === "done") return "done"
  await afterCommit(ref.id, result, deps)
  return result.kind
}
