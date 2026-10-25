import { randomUUID } from "node:crypto"
import { Timestamp, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { MATTER_TOMBSTONES, isTombstoneFor } from "@/platform/retention/tombstone"
import { adminDb } from "../admin"
import { prepareAlert, raiseAlertBestEffort, stageAlert } from "../alerts/raise"
import { commitFailedSpec, deadLetterSpec } from "../alerts/specs"
import { errorCode, logFailure } from "../log"
import { stageJobAudit, stageJobAuditSync } from "./audit"
import { CLOCK_SKEW_TOLERANCE_MS, DISPATCH_GRACE_MS, JOB_ENGINE, JOB_LEASE_MS, MAX_ATTEMPTS, MAX_FENCED_STEPS, MAX_LOG_ENTRIES, RETRY_DELAYS_MS } from "./constants"
import type { JobDeps, JobTask } from "./dispatch"
import { areValidRefs, jobsRef, stageJobUpdate, type FencedStepRecord, type JobLogEntry, type JobLogEvent, type JobRow } from "./enqueue"
import { JobError, LeaseLostError, sanitizeError, type SanitizedError } from "./errors"
import { stageJobDeadLetteredEvent, stageJobFailedEvent } from "./jobEvents"
import { handlerFor, type JobHandler, type JobResult } from "./registry"

/**
 * The P2 worker (spec P3-3, P3-6, P3-7, P3-9, P3-18). One delivery of task `{ jobId, seq }`:
 *
 * 1. Claim (one transaction): drop unless the row is an engine row, `seq <= dispatchSeq` and the
 *    row is due (`queued`/`failed` with `nextAttemptAt <= now + 2 s`) or its lease has expired.
 *    Otherwise take a fresh lease (600 s) and count the attempt; a reclaim at attempt 4 dead-letters.
 *    The seq is not an exclusive ticket (Task 4 fix round, I-1): an older task that arrives after a
 *    newer dispatch may still claim, so a backed-up queue cannot starve a job by superseding its
 *    queued task. Single-runner safety comes from the claim transaction and the lease, not the seq:
 *    whichever task claims first takes the lease, and every later task finds the row running with
 *    a live lease (or finished) and is dropped. A task whose seq is ahead of `dispatchSeq` was
 *    never dispatched by this row's history and is dropped.
 * 2. Run the handler, raced against the handler budget (`handler_timeout`, retryable).
 * 3. Commit (one transaction): re-read; if this claim's fence no longer holds, write nothing.
 *    Otherwise `done` with the handler's `apply`, or `failed` / `dead_lettered` (`stageFailure`).
 *    An `apply` that throws while staging, or whose staged writes Firestore rejects only when the
 *    transaction commits (a non-transient gRPC code such as ALREADY_EXISTS from `tx.create` on an
 *    existing doc, `isRejectedWrite`), is recorded as the retryable `internal` failure by a second,
 *    fenced commit that writes nothing of the handler's result (Codex P1 / O-42). A transient commit
 *    error (ABORTED, UNAVAILABLE, DEADLINE_EXCEEDED, ...) is logged by code and rethrown: the row
 *    stays `running` and lease recovery (the sweeper's query B) re-runs the attempt.
 * 4. After commit: dispatch the retry at `nextAttemptAt`, or raise the dead-letter alert.
 *
 * The worker never re-dispatches a dropped task: recovery belongs to the sweeper (P3-8).
 *
 * `runFenced(stepId, fn)` records each committed step on the row (`fencedSteps`), so a step that
 * committed before a crash, a failure or a manual requeue is skipped on every later attempt.
 *
 * A handler that overruns its budget is not cancelled: it keeps running until it settles, and
 * until the failure commit lands its fence still holds, so a late `runFenced` step can commit (once:
 * the retry finds it recorded and skips it). That is inside the at-least-once model (handlers are idempotent, L8148);
 * an AbortSignal on `ctx` is the later fix.
 */

export type TaskOutcome = "dropped" | "done" | "failed" | "dead_lettered" | "lease_lost"

type SeamContext = { jobId: string; owner: string }

/** Test hooks between claim and commit (spec §7), set in a test and deleted in `finally`. */
export const jobWorkerTestSeam: {
  afterClaim?: (c: SeamContext) => Promise<void>
  afterHandler?: (c: SeamContext) => Promise<void>
  /**
   * Before each finish-commit transaction: `fallback` is false for the first commit and true for
   * the failure commit after a rejected write. A throw here stands in for that transaction rejecting.
   */
  beforeCommit?: (c: SeamContext & { fallback: boolean }) => Promise<void>
} = {}

const at = (ms: number) => Timestamp.fromMillis(ms)

/** Appends a log entry, keeping the last `MAX_LOG_ENTRIES` (also used by the retry and cancel routes). */
export function appendLog(row: Pick<JobRow, "logs">, event: JobLogEvent, attempt: number, now: number, code?: string): JobLogEntry[] {
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
 * `dispatchSeq + 1` (the caller dispatches after commit), `sweepAt` one dispatch grace after it is
 * due and `redispatches` 0 (P3-34, P3-35). Otherwise → `dead_lettered` with `sweepAt` null (the
 * caller raises the alert after commit). Both stage `job.failed`, and the dead-letter also
 * `job.deadLettered`, plus the system audit row and (audit F43) the durable `job.dead_lettered` alert, read first.
 * Call it after the transaction's own reads and before any write.
 */
export async function stageFailure(tx: Transaction, ref: DocumentReference, row: JobRow, err: SanitizedError, now: number): Promise<"failed" | "dead_lettered"> {
  return (await stageFailureAndAlert(tx, ref, row, err, now)).status as "failed" | "dead_lettered"
}

/** Whether a failed attempt is retried automatically (P3-7). Shared by the transition and its dead-letter alert, so they cannot disagree. */
function willRetry(row: JobRow, err: SanitizedError): boolean {
  return !err.permanent && row.attempts < MAX_ATTEMPTS
}

/**
 * `stageFailureRow` and, for a dead letter, its alert (audit F43, spec R9): the alert is read here (after the caller's
 * read of the row, before any write) and written with the transition, so it commits if and only if the dead letter does.
 */
async function stageFailureAndAlert(tx: Transaction, ref: DocumentReference, row: JobRow, err: SanitizedError, now: number): Promise<JobRow> {
  const alert = willRetry(row, err) ? null : await prepareAlert(tx, deadLetterSpec(ref.id, row.firmId, row.jobType, err.code, row.totalAttempts))
  const next = stageFailureRow(tx, ref, row, err, now)
  if (alert !== null) stageAlert(tx, alert, now)
  return next
}

/** The transition of `stageFailure` alone (writes only), returning the post-transition row (for the after-commit dispatch or alert). */
function stageFailureRow(tx: Transaction, ref: DocumentReference, row: JobRow, err: SanitizedError, now: number): JobRow {
  const lastError = { code: err.code, message: err.message }
  const retry = willRetry(row, err)
  // Only read on a retry, where attempts is 1..3 and the delay exists.
  const due = retry ? now + RETRY_DELAYS_MS[Math.max(0, row.attempts - 1)] : now
  const next: JobRow = retry
    ? {
        ...row,
        status: "failed",
        lastError,
        nextAttemptAt: at(due),
        dispatchSeq: row.dispatchSeq + 1,
        dispatchedAt: at(now),
        sweepAt: at(due + DISPATCH_GRACE_MS),
        redispatches: 0,
        lease: null,
        updatedAt: at(now),
        logs: appendLog(row, "failed", row.attempts, now, err.code),
      }
    : {
        ...row,
        status: "dead_lettered",
        lastError,
        nextAttemptAt: null,
        sweepAt: null,
        lease: null,
        updatedAt: at(now),
        finishedAt: at(now),
        logs: appendLog(row, "dead_lettered", row.attempts, now, err.code),
      }
  stageJobUpdate(tx, ref, {
    status: next.status,
    lastError: next.lastError,
    nextAttemptAt: next.nextAttemptAt,
    dispatchSeq: next.dispatchSeq,
    dispatchedAt: next.dispatchedAt,
    sweepAt: next.sweepAt,
    ...(retry ? { redispatches: 0 } : {}),
    lease: null,
    updatedAt: next.updatedAt,
    finishedAt: next.finishedAt,
    logs: next.logs,
  })
  stageJobFailedEvent(tx, ref.id, next, err.code, now)
  if (!retry) stageJobDeadLetteredEvent(tx, ref.id, next, err.code, now)
  // Synchronous and unguarded: a staging failure throws and aborts the caller's transaction, so a
  // transition never commits without its audit row (P3-18).
  stageJobAuditSync(tx, auditSubject(ref.id, row), retry ? "job.fail" : "job.dead_letter", err.code)
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
  // Any task this row has dispatched (seq <= dispatchSeq) may claim; the claim's lease makes it single-runner.
  if (!row || row.engine !== JOB_ENGINE || !(seq <= row.dispatchSeq)) return false
  if (row.status === "queued" || row.status === "failed") {
    // The attempt cap is enforced here, the only place a handler starts (P3-8 storm bound 1).
    if (!(row.attempts < MAX_ATTEMPTS)) return false
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
      return ended(await stageFailureAndAlert(tx, ref, row, err, now), err.code)
    }
    const owner = randomUUID()
    const claimed: JobRow = {
      ...row,
      status: "running",
      attempts: row.attempts + 1,
      totalAttempts: row.totalAttempts + 1,
      lease: { owner, expiresAt: at(now + JOB_LEASE_MS) },
      // The sweeper's next look is the lease's expiry (query B, P3-34).
      sweepAt: at(now + JOB_LEASE_MS),
      redispatches: 0,
      startedAt: at(now),
      updatedAt: at(now),
      logs: appendLog(row, reclaim ? "reclaimed" : "claimed", row.attempts + 1, now),
    }
    stageJobUpdate(tx, ref, {
      status: claimed.status,
      attempts: claimed.attempts,
      totalAttempts: claimed.totalAttempts,
      lease: claimed.lease,
      sweepAt: claimed.sweepAt,
      redispatches: 0,
      startedAt: claimed.startedAt,
      updatedAt: claimed.updatedAt,
      logs: claimed.logs,
    })
    await stageJobAudit(tx, auditSubject(ref.id, row), "job.start", reclaim ? "lease_expired_reclaim" : "ok")
    return { kind: "claimed", row: claimed, owner }
  })
}

const fenceHolds = (row: JobRow | undefined, owner: string): row is JobRow => row?.status === "running" && row.lease?.owner === owner

const STEP_ID = /^[A-Za-z0-9_-]{1,100}$/
const RESERVED_ID = /^__.*__$/

/** A `runFenced` step id: 1 to 100 of `[A-Za-z0-9_-]` (a plain field-path segment), not reserved `__..__`. */
export function isValidStepId(stepId: unknown): stepId is string {
  return typeof stepId === "string" && STEP_ID.test(stepId) && !RESERVED_ID.test(stepId)
}

/**
 * The claim's fence check in `tx`, shared by `runFenced` and `checkFence`: re-reads the job and throws
 * `LeaseLostError` unless it is still `running` under this claim's lease owner. Returns the row it read.
 */
async function readFenced(tx: Transaction, ref: DocumentReference, owner: string): Promise<JobRow> {
  const snap = await tx.get(ref)
  const row = snap.exists ? (snap.data() as JobRow) : undefined
  if (!fenceHolds(row, owner)) throw new LeaseLostError()
  return row
}

/**
 * `checkFence(tx)` for this claim: the same fence check in the caller's transaction, recording no step,
 * so an effect that needs no step of its own still commits only while the claim holds (audit F38).
 */
function checkFenceFor(ref: DocumentReference, owner: string) {
  return async (tx: Transaction): Promise<void> => {
    await readFenced(tx, ref, owner)
  }
}

/**
 * `runFenced(stepId, fn)` for this claim: one transaction that re-reads the job, checks the fence,
 * then skips `fn` if `stepId` is already in `fencedSteps` (committed by an earlier attempt, before a
 * crash or a failure), or runs `fn(tx)` and records `stepId` in the same commit. So a fenced effect
 * commits exactly once per job (P3-6). The record is never cleared: not on reclaim, retry or a
 * manual requeue (a saga resumes after its last committed step rather than repeating it).
 */
function runFencedFor(ref: DocumentReference, owner: string, attempt: number, now: () => number) {
  return async <T>(stepId: string, fn: (tx: Transaction) => Promise<T>): Promise<T | undefined> => {
    if (!isValidStepId(stepId)) throw new JobError("invalid_fenced_step", { permanent: true })
    return adminDb().runTransaction(async (tx) => {
      const row = await readFenced(tx, ref, owner)
      const steps: Record<string, FencedStepRecord> = row.fencedSteps && typeof row.fencedSteps === "object" ? row.fencedSteps : {}
      if (Object.hasOwn(steps, stepId)) return undefined
      if (Object.keys(steps).length >= MAX_FENCED_STEPS) throw new JobError("fenced_step_limit", { permanent: true })
      const value = await fn(tx)
      const record: FencedStepRecord = { at: at(now()), attempt }
      tx.update(ref, { [`fencedSteps.${stepId}`]: record })
      return value
    })
  }
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

/** Whether the job's matter has a tombstone of the job's firm (audit F42). A read failure throws (retryable). */
async function matterTombstoned(firmId: string, matterId: unknown): Promise<boolean> {
  if (typeof matterId !== "string" || matterId === "" || matterId.includes("/")) return false
  const snap = await adminDb().collection(MATTER_TOMBSTONES).doc(matterId).get()
  return isTombstoneFor(snap.data(), firmId, matterId)
}

async function runHandler(ref: DocumentReference, claimed: Claimed, deps: JobDeps): Promise<HandlerOutcome> {
  const { row, owner } = claimed
  const handler = handlerFor(row.jobType)
  try {
    if (!handler) throw new JobError("unknown_job_type", { permanent: true })
    let payload: unknown
    try {
      payload = handler.parse(row.payload)
    } catch {
      // The parse contract (P3-6): any rejection of the payload is the permanent invalid_payload.
      throw new JobError("invalid_payload", { permanent: true })
    }
    // Audit F42: a job of a tombstoned matter never runs, so nothing is written for the matter after its deletion.
    if (row.matterId !== null && (await matterTombstoned(row.firmId, row.matterId))) throw new JobError("matter_deleted", { permanent: true })
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
        runFenced: runFencedFor(ref, owner, row.attempts, deps.clock),
        checkFence: checkFenceFor(ref, owner),
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
    const fail = async (e: unknown): Promise<Ended> => {
      const err = sanitizeError(e, outcome.handler)
      return ended(await stageFailureAndAlert(tx, ref, row, err, now), err.code)
    }
    if (!outcome.ok) return fail(outcome.err)
    // A handler bug (bad refs, or a firm-level job's ref into a matter-bound collection: audit F14 R1-D3) is a
    // retryable internal error; nothing of the result is applied.
    const outputRefs = outcome.result.outputRefs ?? []
    if (!areValidRefs(outputRefs, typeof row.matterId === "string" ? row.matterId : null)) return fail(new JobError("internal"))
    try {
      outcome.result.apply?.(tx)
    } catch (err) {
      throw new ApplyFailed(err)
    }
    stageJobUpdate(tx, ref, {
      status: "done",
      lastError: null,
      outputRefs: [...outputRefs],
      lease: null,
      nextAttemptAt: null,
      sweepAt: null,
      updatedAt: at(now),
      finishedAt: at(now),
      logs: appendLog(row, "done", row.attempts, now),
    })
    await stageJobAudit(tx, auditSubject(ref.id, row), "job.done", "ok")
    return { kind: "done" }
  })
}

/** gRPC status names, for logging a store error by code only (never its message, which names doc paths). */
const GRPC_NAMES: Readonly<Record<number, string>> = {
  1: "cancelled",
  2: "unknown",
  3: "invalid_argument",
  4: "deadline_exceeded",
  5: "not_found",
  6: "already_exists",
  7: "permission_denied",
  8: "resource_exhausted",
  9: "failed_precondition",
  10: "aborted",
  11: "out_of_range",
  12: "unimplemented",
  13: "internal",
  14: "unavailable",
  15: "data_loss",
  16: "unauthenticated",
}

/** Transient gRPC codes: retrying the same writes may succeed, so the attempt is left to lease recovery. */
const TRANSIENT_GRPC: ReadonlySet<number> = new Set([1, 2, 4, 8, 10, 13, 14])

function grpcStatus(err: unknown): number | undefined {
  if (err instanceof JobError) return undefined
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === "number" && Number.isInteger(code) && code >= 1 && code <= 16 ? code : undefined
}

/**
 * Whether the finish transaction failed because Firestore rejected a staged write for good
 * (ALREADY_EXISTS, FAILED_PRECONDITION, INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED,
 * OUT_OF_RANGE, ...): committing the same writes again cannot succeed.
 */
function isRejectedWrite(err: unknown): boolean {
  const status = grpcStatus(err)
  return status !== undefined && !TRANSIENT_GRPC.has(status)
}

/** A commit failure's code: the gRPC status name for a store error, else `errorCode`. */
function commitFailureCode(err: unknown): string {
  const status = grpcStatus(err)
  return status === undefined ? errorCode(err) : GRPC_NAMES[status]
}

/** Logs a commit failure by code only: the gRPC status name for a store error, else `errorCode`. */
function logCommitFailure(message: string, err: unknown, jobId?: string): void {
  const status = grpcStatus(err)
  if (status === undefined) return logFailure(message, err)
  logger.error(message, jobId === undefined ? { code: GRPC_NAMES[status] } : { jobId, code: GRPC_NAMES[status] })
}

/**
 * Commits the outcome. If the handler's result cannot be committed, a second commit (which
 * re-checks the fence) records a failure instead and writes nothing the handler staged:
 * - `apply` throws while staging → that error, sanitised;
 * - Firestore rejects a staged write at commit with a non-transient code → the retryable
 *   `internal`, exactly as an `apply` that throws a plain error (spec P3-7 amendment, O-42).
 * Any other failure (a transient store error, or the failure commit itself failing) is logged by
 * code and rethrown; the row stays `running` and the lease and sweeper query B recover it.
 */
async function commitOutcome(ref: DocumentReference, owner: string, outcome: HandlerOutcome, deps: JobDeps): Promise<CommitResult> {
  const seam = { jobId: ref.id, owner }
  const fallback = async (err: unknown): Promise<CommitResult> => {
    await jobWorkerTestSeam.beforeCommit?.({ ...seam, fallback: true })
    return commit(ref, owner, { ok: false, err, handler: outcome.handler }, deps)
  }
  try {
    let first: unknown
    try {
      await jobWorkerTestSeam.beforeCommit?.({ ...seam, fallback: false })
      return await commit(ref, owner, outcome, deps)
    } catch (err) {
      first = err
    }
    if (first instanceof ApplyFailed) return await fallback(first.original)
    // Only the handler's result can carry a rejected write; a failure commit that is rejected is not retried.
    if (outcome.ok && isRejectedWrite(first)) {
      logCommitFailure("job commit rejected", first, ref.id)
      return await fallback(new JobError("internal"))
    }
    throw first
  } catch (err) {
    // The row stays `running`: a redelivery is dropped, and the lease and sweeper query B recover it.
    logCommitFailure("job commit failed", err)
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
  // A LeaseLostError from the handler is not trusted on its own: the commit re-checks the fence, and
  // if it still holds the error is recorded (sanitised to internal) like any other failure.
  let result: CommitResult
  try {
    result = await commitOutcome(ref, claimed.owner, outcome, deps)
  } catch (err) {
    // Audit F43 (spec R8): the commit failed, so there is no transaction to share; a bounded raise of its own. The
    // row stays `running`, and lease recovery, `job.queue_age` and (at attempt 4) `job.dead_lettered` follow it.
    await raiseAlertBestEffort(commitFailedSpec(ref.id, claimed.row.firmId, claimed.row.jobType, commitFailureCode(err)), deps.clock())
    throw err
  }
  if (result.kind === "lease_lost") return leaseLost(ref.id, claimed.row.jobType)
  if (result.kind === "done") return "done"
  await afterCommit(ref.id, result, deps)
  return result.kind
}
