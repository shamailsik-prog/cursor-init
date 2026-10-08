import { FieldValue, type DocumentData, type DocumentReference, type Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import type { JobDeps, JobDispatcher, JobTask } from "../src/p2/dispatch"
import type { DiagnosticPayload } from "../src/p2/diagnostic"
import { enqueueJob, jobsRef, type EnqueueResult, type JobRow, type JobSpec } from "../src/p2/enqueue"
import { JobError } from "../src/p2/errors"
import type { DeadLetterInfo } from "../src/p2/jobEvents"
import { jobTestSeam, type JobHandler } from "../src/p2/registry"
import { runJobTask, type TaskOutcome } from "../src/p2/worker"
import { uniq } from "./emu"

/** Shared helpers for the P2 job-engine emulator suites (spec §7). */

/** The suites' fixed clock origin. */
export const T0 = Date.parse("2026-10-08T09:00:00Z")

const YEAR_MS = 365 * 86_400_000

/**
 * Clock origins for tests that run the sweeper. `sweep` reads every job in the emulator, and the
 * rows other suites leave at `T0` would be due in its window and come first in its order (limit
 * 100). Each call returns an origin one year earlier than the last, starting `yearsBack` years
 * before `T0`, so no row an earlier test wrote is due in a later test's sweep. Give each file its
 * own `yearsBack` (module state starts over per file).
 */
export function sweepOrigins(yearsBack: number): () => number {
  let next = T0 - yearsBack * YEAR_MS
  return () => {
    const origin = next
    next -= YEAR_MS
    return origin
  }
}

/** A `platform.diagnostic` spec: a fresh key, label internal, firm-level, created by the system. */
export function diagSpec(firmId: string, payload: DiagnosticPayload, over: Partial<JobSpec> = {}): JobSpec {
  return {
    firmId,
    jobType: "platform.diagnostic",
    classification: "internal",
    matterId: null,
    payload: { ...payload },
    idempotencyKey: uniq("k"),
    createdBy: "system",
    ...over,
  }
}

/** Enqueues one spec in its own transaction at `now`. */
export function enqueueAt(spec: JobSpec, now: number): Promise<EnqueueResult> {
  return adminDb().runTransaction((tx) => enqueueJob(tx, spec, { now }))
}

/** The job row with its document updateTime (to prove a reuse wrote nothing). */
export async function readJob(jobId: string): Promise<JobRow & { updateTime: Timestamp }> {
  const snap = await jobsRef().doc(jobId).get()
  if (!snap.exists) throw new Error(`no job ${jobId}`)
  return { ...(snap.data() as JobRow), updateTime: snap.updateTime! }
}

/** The audit_log rows whose target is the job, oldest first. */
export async function jobAuditRows(jobId: string): Promise<DocumentData[]> {
  const snap = await adminDb().collection("audit_log").where("target", "==", `jobs/${jobId}`).orderBy("occurredAt").get()
  return snap.docs.map((d) => d.data())
}

/** A fresh firm document. */
export async function newFirm(): Promise<string> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "Jobs Firm", plan: "internal" })
  return firmId
}

/** A settable clock for `JobDeps.clock` (spec §7: injected clocks, no sleeps). */
export class FakeClock {
  private ms: number

  constructor(ms: number) {
    this.ms = ms
  }

  now(): number {
    return this.ms
  }

  set(ms: number): void {
    this.ms = ms
  }

  advance(ms: number): void {
    this.ms += ms
  }
}

type RecordedTask = JobTask & { scheduleAt: number | null }

/**
 * Cloud Tasks stand-in (spec §7): records every dispatch, dedupes by task id `${jobId}-${seq}`
 * as Cloud Tasks does, and delivers on demand by calling `runJobTask` with the test's deps.
 */
export class InProcessDispatcher implements JobDispatcher {
  readonly tasks: RecordedTask[] = []
  private readonly ids = new Set<string>()
  private readonly delivered = new Set<string>()

  constructor(
    private readonly clock: FakeClock,
    private readonly deps: () => JobDeps
  ) {}

  async dispatch(task: JobTask, opts: { scheduleAt?: number } = {}): Promise<void> {
    const id = `${task.jobId}-${task.seq}`
    if (this.ids.has(id)) return
    this.ids.add(id)
    this.tasks.push({ jobId: task.jobId, seq: task.seq, scheduleAt: opts.scheduleAt ?? null })
  }

  /** Delivers `task` now, or at `at` (the clock is set to `at` first). */
  deliver(task: JobTask, at?: number): Promise<TaskOutcome> {
    if (at !== undefined) this.clock.set(at)
    this.delivered.add(`${task.jobId}-${task.seq}`)
    return runJobTask({ jobId: task.jobId, seq: task.seq }, this.deps())
  }

  /** Delivers, one at a time and in order, every recorded task not yet delivered whose time has come. */
  async drainDue(now: number): Promise<TaskOutcome[]> {
    const outcomes: TaskOutcome[] = []
    for (;;) {
      const due = this.tasks.find((t) => !this.delivered.has(`${t.jobId}-${t.seq}`) && (t.scheduleAt ?? -Infinity) <= now)
      if (!due) return outcomes
      outcomes.push(await this.deliver(due, now))
    }
  }
}

/** Worker deps for a test: the in-process dispatcher, the fake clock and a capturing alert. */
export function testDeps(
  clock: FakeClock,
  opts: { handlerBudgetMs?: number } = {}
): JobDeps & { dispatcher: InProcessDispatcher; alerts: DeadLetterInfo[] } {
  const alerts: DeadLetterInfo[] = []
  const deps: JobDeps & { dispatcher: InProcessDispatcher; alerts: DeadLetterInfo[] } = {
    dispatcher: new InProcessDispatcher(clock, () => deps),
    clock: () => clock.now(),
    alert: { deadLettered: (info) => void alerts.push(info) },
    handlerBudgetMs: opts.handlerBudgetMs ?? 240_000,
    alerts,
  }
  return deps
}

/** The `test.fenced` job's counter, written only through `runFenced`. */
export function fencedCounterRef(firmId: string, jobId: string): DocumentReference {
  return adminDb().collection("counters").doc(`${firmId}_jobfenced_${jobId}`)
}

/** Accepts any plain object; anything else is the permanent invalid_payload (the P3-6 parse contract). */
const anyObject = (payload: unknown): Record<string, unknown> => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new JobError("invalid_payload", { permanent: true })
  return payload as Record<string, unknown>
}

/** A saga-flagged test type that always succeeds (P3-12, P3-13 need one). */
export const sagaTestHandler: JobHandler<Record<string, unknown>> = {
  jobType: "test.saga",
  saga: true,
  errorCodes: {},
  parse: anyObject,
  run: async () => ({}),
}

/** A test type whose only effect is a fenced counter increment. */
export const fencedTestHandler: JobHandler<Record<string, unknown>> = {
  jobType: "test.fenced",
  saga: false,
  errorCodes: {},
  parse: anyObject,
  run: async (ctx) => {
    await ctx.runFenced(async (tx) => {
      tx.set(fencedCounterRef(ctx.job.firmId, ctx.job.id), { count: FieldValue.increment(1) }, { merge: true })
    })
    return {}
  },
}

/** The fan-out target (P3-15): accepts exactly `{ eventId: string }`, reads that event and succeeds. */
export const eventTestHandler: JobHandler<{ eventId: string }> = {
  jobType: "test.event",
  saga: false,
  errorCodes: {},
  parse: (payload) => {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new JobError("invalid_payload", { permanent: true })
    const keys = Object.keys(payload)
    const { eventId } = payload as Record<string, unknown>
    if (keys.length !== 1 || typeof eventId !== "string" || eventId === "") throw new JobError("invalid_payload", { permanent: true })
    return { eventId }
  },
  run: async (ctx) => {
    await adminDb().collection("events").doc(ctx.payload.eventId).get()
    return {}
  },
}

/** The scheduled-job test type (P3-16): accepts exactly `{ period: string }` and succeeds. */
export const scheduledTestHandler: JobHandler<{ period: string }> = {
  jobType: "test.scheduled",
  saga: false,
  errorCodes: {},
  parse: (payload) => {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new JobError("invalid_payload", { permanent: true })
    const keys = Object.keys(payload)
    const { period } = payload as Record<string, unknown>
    if (keys.length !== 1 || typeof period !== "string" || period === "") throw new JobError("invalid_payload", { permanent: true })
    return { period }
  },
  run: async () => ({}),
}

export function installTestHandlers(): void {
  for (const h of [sagaTestHandler, fencedTestHandler, eventTestHandler, scheduledTestHandler]) jobTestSeam.handlers.set(h.jobType, h as JobHandler)
}

export function removeTestHandlers(): void {
  for (const h of [sagaTestHandler, fencedTestHandler, eventTestHandler, scheduledTestHandler]) jobTestSeam.handlers.delete(h.jobType)
}

/** The diagnostic counter's `count` (0 when the doc is absent). */
export async function diagCount(firmId: string, jobId: string): Promise<number> {
  const snap = await adminDb().collection("counters").doc(`${firmId}_jobdiag_${jobId}`).get()
  return snap.exists ? Number(snap.get("count")) : 0
}

/** The job's `events` docs, keyed by doc id. */
export async function jobEvents(jobId: string): Promise<Record<string, DocumentData>> {
  const snap = await adminDb().collection("events").where("payload.jobId", "==", jobId).get()
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]))
}
