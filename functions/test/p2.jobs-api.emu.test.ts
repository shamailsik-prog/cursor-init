import { randomUUID } from "node:crypto"
import { Timestamp } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { adminDb } from "../src/admin"
import { jobRuntime } from "../src/p2/dispatch"
import type { DiagnosticPayload } from "../src/p2/diagnostic"
import { jobsRef, type JobSpec } from "../src/p2/enqueue"
import type { JobView } from "../src/p2/view"
import { ApiError, apiErrorOf, expectKind, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import {
  FakeClock,
  T0,
  diagCount,
  diagSpec,
  enqueueAt,
  installTestHandlers,
  jobAuditRows,
  jobEvents,
  readJob,
  removeTestHandlers,
  testDeps,
} from "./jobs"

/**
 * The job API (spec P3-10..P3-13) through the HTTP router: GET listJobs and getJob, POST
 * retryFailedJob and cancelJob, on the router's injected clock, with the in-process dispatcher
 * standing in for Cloud Tasks.
 */

type Member = { uid: string; token: string }
type Firm = {
  firmId: string
  M: string
  P: Member
  A: Member
  C: Member
  intern: Member
  accounts: Member
  client: Member
  /** A partner who is not a member of M, cleared confidential. */
  P2: Member
}
type List = { items: JobView[]; nextCursor: string | null }

const clock = new FakeClock(T0)
const atClock = { now: () => clock.now() }
const listApi = viaApi<List>("listJobs", atClock)
const getApi = viaApi<JobView>("getJob", atClock)
const retryApi = viaApi<JobView>("retryFailedJob", atClock)
const cancelApi = viaApi<JobView>("cancelJob", atClock)

const NOTE = "Requeued after the upstream fix landed."
const CANCEL_NOTE = "Cancelled: superseded by a newer request."

const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })

async function member(firmId: string, role: string, clearance?: string): Promise<Member> {
  const { uid, token } = await mintIdToken(claims(firmId, role, clearance))
  return { uid, token }
}

async function join(matterId: string, firmId: string, uid: string): Promise<void> {
  await adminDb().collection("matter_members").doc(`${matterId}_${uid}`).set({ firmId, matterId, userId: uid, createdAt: Timestamp.fromMillis(T0) })
}

async function seedFirm(): Promise<Firm> {
  const firmId = uniq("jobs-api-firm")
  // A high per-user limit: every call of a test runs in one rate window of the fixed clock.
  await adminDb().collection("firms").doc(firmId).set({ name: "Jobs API Firm", plan: "internal", rateLimits: { general: 1000 } })
  const M = uniq("jm")
  await adminDb().collection("matters").doc(M).set({ firmId, title: "Jobs Matter", classification: "internal", stage: "intake", status: "open", createdAt: Timestamp.fromMillis(T0) })
  const f: Firm = {
    firmId,
    M,
    P: await member(firmId, "partner"),
    A: await member(firmId, "associate"),
    C: await member(firmId, "clerk"),
    intern: await member(firmId, "intern"),
    accounts: await member(firmId, "accounts"),
    client: await member(firmId, "client"),
    P2: await member(firmId, "partner", "confidential"),
  }
  for (const m of [f.P, f.A, f.C]) await join(M, firmId, m.uid)
  return f
}

const as = (who: Member, firmId: string, data: Record<string, unknown>, headers?: Record<string, string>) =>
  ({ token: who.token, data: { firmId, ...data }, ...(headers ? { headers } : {}) }) as never

const getJob = (f: Firm, who: Member, data: Record<string, unknown>) => getApi(as(who, f.firmId, data))
const list = (f: Firm, who: Member, data: Record<string, unknown>) => listApi(as(who, f.firmId, data))
const retry = (f: Firm, who: Member, data: Record<string, unknown>, headers?: Record<string, string>) => retryApi(as(who, f.firmId, data, headers))
const cancel = (f: Firm, who: Member, data: Record<string, unknown>) => cancelApi(as(who, f.firmId, data))

/** Enqueues a diagnostic job on M (by default) created by the firm's partner, at `at`. */
async function job(f: Firm, over: Partial<JobSpec> = {}, at = T0, payload: DiagnosticPayload = { behaviour: "succeed" }): Promise<string> {
  return (await enqueueAt(diagSpec(f.firmId, payload, { matterId: f.M, createdBy: f.P.uid, ...over }), at)).jobId
}

async function setJob(jobId: string, fields: Record<string, unknown>): Promise<void> {
  await jobsRef().doc(jobId).update(fields)
}

async function deadLetter(jobId: string): Promise<void> {
  await setJob(jobId, {
    status: "dead_lettered",
    lastError: { code: "diag_failure", message: "Diagnostic failure (planned)." },
    nextAttemptAt: null,
    finishedAt: Timestamp.fromMillis(T0),
  })
}

const ids = (page: List) => page.items.map((v) => v.jobId)

describe.skipIf(!EMULATORS)("P2 jobs API (P3-10..P3-13)", () => {
  let d: ReturnType<typeof testDeps>

  beforeEach(() => {
    clock.set(T0)
    d = testDeps(clock)
    jobRuntime.deps = d
    installTestHandlers()
  })
  afterEach(() => {
    delete jobRuntime.deps
    removeTestHandlers()
    vi.restoreAllMocks()
  })

  it("getJob: partner, associate, clerk members read the full view; intern, accounts, client are refused", async () => {
    const f = await seedFirm()
    const jobId = await job(f)
    for (const who of [f.P, f.A, f.C]) {
      const view = await getJob(f, who, { jobId })
      expect(view).toMatchObject({
        jobId,
        jobType: "platform.diagnostic",
        matterId: f.M,
        classification: "internal",
        status: "queued",
        attempts: 0,
        maxAttempts: 4,
        manualRetries: 0,
        maxManualRetries: 3,
        retryable: false,
        cancellable: true,
        createdBy: f.P.uid,
        createdAt: new Date(T0).toISOString(),
        inputRefs: [],
        outputRefs: [],
        logs: [expect.objectContaining({ event: "enqueued", at: new Date(T0).toISOString() })],
      })
      for (const key of ["payload", "payloadHash", "idempotencyKey", "lease"]) expect(view).not.toHaveProperty(key)
    }
    const refusals: Array<[Member, string]> = [
      [f.intern, "role_not_permitted"],
      [f.accounts, "accounts_register_only"],
      [f.client, "client_denied"],
    ]
    for (const [who, code] of refusals) expectKind(await apiErrorOf(getJob(f, who, { jobId })), "permission-denied", code)
    expectKind(await apiErrorOf(getJob(f, f.P, { jobId: "a/b" })), "invalid-argument", "invalid_query")
    expectKind(await apiErrorOf(getJob(f, f.P, {})), "invalid-argument", "invalid_query")
    expectKind(await apiErrorOf(getJob(f, f.P, { jobId: "jmissing" })), "not-found", "not_found")
  })

  it("a non-member partner sees the restricted view and cannot retry or cancel (403 not_member)", async () => {
    const f = await seedFirm()
    const dead = await job(f)
    await deadLetter(dead)
    const v = await getJob(f, f.P2, { jobId: dead })
    expect(v).toMatchObject({ jobId: dead, matterId: "restricted", status: "dead_lettered", retryable: true, lastError: { code: "diag_failure" } })
    for (const key of ["logs", "inputRefs", "outputRefs", "payload", "idempotencyKey", "lease"]) expect(v).not.toHaveProperty(key)
    expect(JSON.stringify(v)).not.toContain(f.M)
    const before = await readJob(dead)
    expectKind(await apiErrorOf(retry(f, f.P2, { jobId: dead, note: NOTE })), "permission-denied", "not_member")
    expectKind(await apiErrorOf(cancel(f, f.P2, { jobId: dead, note: CANCEL_NOTE })), "permission-denied", "not_member")
    expect((await readJob(dead)).updateTime.isEqual(before.updateTime)).toBe(true)
    // A non-member associate or clerk does not see the job at all.
    const outsider = await member(f.firmId, "associate")
    expectKind(await apiErrorOf(getJob(f, outsider, { jobId: dead })), "not-found", "not_found")
    expectKind(await apiErrorOf(retry(f, outsider, { jobId: dead, note: NOTE })), "not-found", "not_found")
  })

  it("firm-level jobs are partner-only; a job above the caller's clearance is 404", async () => {
    const f = await seedFirm()
    const firmLevel = await job(f, { matterId: null })
    expect(await getJob(f, f.P, { jobId: firmLevel })).toMatchObject({ jobId: firmLevel, matterId: null, logs: [expect.objectContaining({ event: "enqueued" })] })
    expect((await getJob(f, f.P2, { jobId: firmLevel })).matterId).toBeNull()
    for (const who of [f.A, f.C]) expectKind(await apiErrorOf(getJob(f, who, { jobId: firmLevel })), "not-found", "not_found")

    const priv = await job(f, { classification: "privileged" })
    const lowAssociate = await member(f.firmId, "associate", "internal")
    await join(f.M, f.firmId, lowAssociate.uid)
    expectKind(await apiErrorOf(getJob(f, lowAssociate, { jobId: priv })), "not-found", "not_found")
    expectKind(await apiErrorOf(getJob(f, f.P2, { jobId: priv })), "not-found", "not_found")
    expect((await getJob(f, f.A, { jobId: priv })).classification).toBe("privileged")
    // The same member associate reads an internal job on M.
    expect((await getJob(f, lowAssociate, { jobId: await job(f) })).matterId).toBe(f.M)
  })

  it("listJobs: the firm queue (partner) and a matter's jobs (members), newest first, filtered and paginated with omitted rows", async () => {
    const f = await seedFirm()
    const j: string[] = []
    for (let i = 0; i < 5; i++) j.push(await job(f, i === 3 ? { classification: "privileged" } : {}, T0 + i))

    // The firm queue as a confidential non-member partner: restricted rows, the privileged one omitted
    // (a scan of `limit` rows per page, so a page may be short).
    const page1 = await list(f, f.P2, { limit: "2" })
    expect(ids(page1)).toEqual([j[4]])
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await list(f, f.P2, { limit: "2", cursor: page1.nextCursor })
    expect(ids(page2)).toEqual([j[2], j[1]])
    const page3 = await list(f, f.P2, { limit: "2", cursor: page2.nextCursor })
    expect(ids(page3)).toEqual([j[0]])
    expect(page3.nextCursor).toBeNull()
    for (const v of [...page1.items, ...page2.items, ...page3.items]) {
      expect(v.matterId).toBe("restricted")
      for (const key of ["logs", "inputRefs", "outputRefs", "payload", "idempotencyKey", "lease"]) expect(v).not.toHaveProperty(key)
    }

    // A row of the transitional Next.js writer (no engine marker) is never listed.
    await jobsRef().doc(uniq("legacy")).set({ firmId: f.firmId, jobType: "ocr", matterId: f.M, classification: "internal", createdAt: Timestamp.fromMillis(T0 + 10) })
    // The firm queue as a member partner: every engine row, full, without logs.
    const queue = await list(f, f.P, {})
    expect(ids(queue)).toEqual([j[4], j[3], j[2], j[1], j[0]])
    expect(queue.nextCursor).toBeNull()
    expect(queue.items.every((v) => v.matterId === f.M && Array.isArray(v.inputRefs) && !("logs" in v))).toBe(true)

    // A matter's jobs as a member: full rows only, the ones above the caller's clearance omitted.
    const confAssociate = await member(f.firmId, "associate", "confidential")
    await join(f.M, f.firmId, confAssociate.uid)
    expect(ids(await list(f, confAssociate, { matterId: f.M }))).toEqual([j[4], j[2], j[1], j[0]])
    expect(ids(await list(f, f.C, { matterId: f.M }))).toEqual([j[4], j[3], j[2], j[1], j[0]])
    // The non-member partner may read the firm queue but not the matter's list.
    expectKind(await apiErrorOf(list(f, f.P2, { matterId: f.M })), "permission-denied", "not_member")
    expectKind(await apiErrorOf(list(f, f.A, {})), "permission-denied", "role_not_permitted")
    expectKind(await apiErrorOf(list(f, f.C, {})), "permission-denied", "role_not_permitted")
    expectKind(await apiErrorOf(list(f, f.intern, {})), "permission-denied", "role_not_permitted")
    // job.read naming a matter: the matter gate (membership) comes before the role table.
    expectKind(await apiErrorOf(list(f, f.intern, { matterId: f.M })), "permission-denied", "not_member")
    await join(f.M, f.firmId, f.intern.uid)
    expectKind(await apiErrorOf(list(f, f.intern, { matterId: f.M })), "permission-denied", "role_not_permitted")
    expectKind(await apiErrorOf(list(f, f.client, { matterId: f.M })), "permission-denied", "client_denied")
    const other = await seedFirm()
    expectKind(await apiErrorOf(list(f, f.P, { matterId: other.M })), "permission-denied", "cross_firm")
    const outsider = await member(f.firmId, "associate")
    expectKind(await apiErrorOf(list(f, outsider, { matterId: f.M })), "permission-denied", "not_member")

    // Filters narrow the list.
    await deadLetter(j[1])
    expect(ids(await list(f, f.P, { status: "dead_lettered" }))).toEqual([j[1]])
    expect(ids(await list(f, f.P, { matterId: f.M, status: "queued" }))).toEqual([j[4], j[3], j[2], j[0]])
    const saga = await job(f, { jobType: "test.saga" }, T0 + 20, {} as DiagnosticPayload)
    expect(ids(await list(f, f.P, { jobType: "test.saga" }))).toEqual([saga])
    expect(ids(await list(f, f.P, { matterId: f.M, status: "dead_lettered", jobType: "platform.diagnostic" }))).toEqual([j[1]])

    for (const q of [{ status: "x" }, { jobType: "a/b" }, { matterId: "a/b" }]) expectKind(await apiErrorOf(list(f, f.P, q)), "invalid-argument", "invalid_query")
    expectKind(await apiErrorOf(list(f, f.P, { limit: "0" })), "invalid-argument", "invalid_limit")
    expectKind(await apiErrorOf(list(f, f.P, { cursor: "!!" })), "invalid-argument", "invalid_cursor")
    const badKey = Buffer.from(JSON.stringify({ sortKey: "x.y", id: "j" })).toString("base64url")
    expectKind(await apiErrorOf(list(f, f.P, { cursor: badKey })), "invalid-argument", "invalid_cursor")
  })

  it("retryFailedJob requeues a dead-lettered job, keeps lastError, dispatches, and stops after 3", async () => {
    const f = await seedFirm()
    const dead = await job(f)
    await deadLetter(dead)
    const prevSeq = (await readJob(dead)).dispatchSeq
    clock.set(T0 + 60_000)
    expect(await retry(f, f.A, { jobId: dead, note: NOTE })).toMatchObject({
      jobId: dead,
      status: "queued",
      attempts: 0,
      manualRetries: 1,
      lastError: { code: "diag_failure" },
      retryable: false,
      logs: expect.arrayContaining([expect.objectContaining({ event: "requeued" })]),
    })
    const row = await readJob(dead)
    expect(row.requeues).toEqual([expect.objectContaining({ by: f.A.uid, role: "associate", note: NOTE })])
    expect(row.dispatchSeq).toBe(prevSeq + 1)
    expect(row.nextAttemptAt?.toMillis()).toBe(T0 + 60_000)
    expect(row.dispatchedAt.toMillis()).toBe(T0 + 60_000)
    expect(row.finishedAt).toBeNull()
    expect(row.logs.at(-1)).toMatchObject({ event: "requeued", attempt: 0 })
    expect(d.dispatcher.tasks.at(-1)).toEqual({ jobId: dead, seq: prevSeq + 1, scheduleAt: null })
    // The requeued task runs the job.
    expect(await d.dispatcher.deliver({ jobId: dead, seq: prevSeq + 1 }, T0 + 60_000)).toBe("done")
    expect(await diagCount(f.firmId, dead)).toBe(1)
    expectKind(await apiErrorOf(retry(f, f.P, { jobId: dead, note: NOTE })), "failed-precondition", "job_not_dead_lettered")

    await setJob(dead, { status: "dead_lettered", manualRetries: 3 })
    expectKind(await apiErrorOf(retry(f, f.P, { jobId: dead, note: NOTE })), "failed-precondition", "retry_limit_reached")
    await setJob(dead, { manualRetries: 2 })
    expectKind(await apiErrorOf(retry(f, f.A, { jobId: dead, note: "x".repeat(19) })), "invalid-argument", "note_too_short")
    expectKind(await apiErrorOf(retry(f, f.A, { jobId: dead, note: `   ${"y".repeat(19)}   ` })), "invalid-argument", "note_too_short")
    expectKind(await apiErrorOf(retry(f, f.A, { jobId: "a/b", note: NOTE })), "invalid-argument", "invalid_query")
    expectKind(await apiErrorOf(retry(f, f.A, { jobId: dead, note: 5 })), "invalid-argument", "invalid_query")
    expectKind(await apiErrorOf(retry(f, f.C, { jobId: dead, note: NOTE })), "permission-denied", "role_not_permitted")
    expectKind(await apiErrorOf(retry(f, f.intern, { jobId: dead, note: NOTE })), "permission-denied", "role_not_permitted")
    expect(await retry(f, f.P, { jobId: dead, note: NOTE })).toMatchObject({ status: "queued", manualRetries: 3, retryable: false })
  })

  it("retryFailedJob: a saga job type needs a partner", async () => {
    const f = await seedFirm()
    const sagaDead = await job(f, { jobType: "test.saga" }, T0, {} as DiagnosticPayload)
    await deadLetter(sagaDead)
    expectKind(await apiErrorOf(retry(f, f.A, { jobId: sagaDead, note: NOTE })), "permission-denied", "role_not_permitted")
    expect(await retry(f, f.P, { jobId: sagaDead, note: NOTE })).toMatchObject({ status: "queued", manualRetries: 1, cancellable: false })
    // A type no longer registered is treated like a saga: partner only.
    const gone = await job(f)
    await deadLetter(gone)
    await setJob(gone, { jobType: "gone.type" })
    expectKind(await apiErrorOf(retry(f, f.A, { jobId: gone, note: NOTE })), "permission-denied", "role_not_permitted")
    expect(await retry(f, f.P, { jobId: gone, note: NOTE })).toMatchObject({ status: "queued", manualRetries: 1 })
  })

  it("retryFailedJob replays the first answer for the same Idempotency-Key", async () => {
    const f = await seedFirm()
    const dead = await job(f)
    await deadLetter(dead)
    const k = randomUUID()
    const first = await retry(f, f.P, { jobId: dead, note: NOTE }, { "idempotency-key": k })
    const second = await retry(f, f.P, { jobId: dead, note: NOTE }, { "idempotency-key": k })
    // The router replays the stored body and marks it `reused: true` (http/idempotency.ts).
    expect(second).toEqual({ ...first, reused: true })
    const row = await readJob(dead)
    expect(row.manualRetries).toBe(1)
    expect(row.requeues).toHaveLength(1)
    expect(d.dispatcher.tasks.filter((t) => t.jobId === dead)).toHaveLength(1)
  })

  it("cancelJob: queued, failed and dead-lettered cancel; running, done, cancelled and saga types are refused", async () => {
    const f = await seedFirm()
    clock.set(T0 + 5_000)
    const q = await job(f)
    expect(await cancel(f, f.P, { jobId: q, note: CANCEL_NOTE })).toMatchObject({ jobId: q, status: "cancelled", cancellable: false, retryable: false })
    const row = await readJob(q)
    expect(row.cancellation).toMatchObject({ by: f.P.uid, role: "partner", note: CANCEL_NOTE })
    expect(row.cancellation?.at.toMillis()).toBe(T0 + 5_000)
    expect(row.lease).toBeNull()
    expect(row.nextAttemptAt).toBeNull()
    expect(row.finishedAt?.toMillis()).toBe(T0 + 5_000)
    expect(row.logs.at(-1)).toMatchObject({ event: "cancelled" })
    // A task delivered after the cancel is dropped.
    expect(await d.dispatcher.deliver({ jobId: q, seq: 0 }, T0 + 6_000)).toBe("dropped")
    expect(await diagCount(f.firmId, q)).toBe(0)
    expectKind(await apiErrorOf(cancel(f, f.P, { jobId: q, note: CANCEL_NOTE })), "failed-precondition", "job_finished")

    const failed = await job(f)
    await setJob(failed, { status: "failed", attempts: 1, totalAttempts: 1 })
    expect((await cancel(f, f.P, { jobId: failed, note: CANCEL_NOTE })).status).toBe("cancelled")
    const dead = await job(f)
    await deadLetter(dead)
    expect((await cancel(f, f.P, { jobId: dead, note: CANCEL_NOTE })).status).toBe("cancelled")
    expect((await readJob(dead)).lastError).toEqual({ code: "diag_failure", message: "Diagnostic failure (planned)." })

    const running = await job(f)
    await setJob(running, { status: "running", attempts: 1, lease: { owner: "w1", expiresAt: Timestamp.fromMillis(T0 + 600_000) } })
    expectKind(await apiErrorOf(cancel(f, f.P, { jobId: running, note: CANCEL_NOTE })), "failed-precondition", "job_running")
    const done = await job(f)
    await setJob(done, { status: "done" })
    expectKind(await apiErrorOf(cancel(f, f.P, { jobId: done, note: CANCEL_NOTE })), "failed-precondition", "job_finished")
    const saga = await job(f, { jobType: "test.saga" }, T0, {} as DiagnosticPayload)
    expectKind(await apiErrorOf(cancel(f, f.P, { jobId: saga, note: CANCEL_NOTE })), "failed-precondition", "job_not_cancellable")
    const gone = await job(f)
    await setJob(gone, { jobType: "gone.type" })
    expectKind(await apiErrorOf(cancel(f, f.P, { jobId: gone, note: CANCEL_NOTE })), "failed-precondition", "job_not_cancellable")

    const other = await job(f)
    for (const who of [f.A, f.C, f.intern]) expectKind(await apiErrorOf(cancel(f, who, { jobId: other, note: CANCEL_NOTE })), "permission-denied", "role_not_permitted")
    expectKind(await apiErrorOf(cancel(f, f.client, { jobId: other, note: CANCEL_NOTE })), "permission-denied", "client_denied")
    expectKind(await apiErrorOf(cancel(f, f.P, { jobId: other, note: "too short" })), "invalid-argument", "note_too_short")
    expectKind(await apiErrorOf(cancel(f, f.P, { jobId: other, note: ["x".repeat(30)] })), "invalid-argument", "invalid_query")
    expect((await readJob(other)).status).toBe("queued")
  })

  it("a parallel cancel and claim: exactly one wins", async () => {
    const f = await seedFirm()
    const jobId = await job(f)
    const [c, w] = await Promise.allSettled([cancel(f, f.P, { jobId, note: CANCEL_NOTE }), d.dispatcher.deliver({ jobId, seq: 0 }, T0)])
    const row = await readJob(jobId)
    const count = await diagCount(f.firmId, jobId)
    const cancelled = c.status === "fulfilled"
    expect(
      cancelled
        ? [row.status, (w as PromiseFulfilledResult<string>).value, count]
        : [row.status, ((c as PromiseRejectedResult).reason as ApiError).status, count]
    ).toEqual(cancelled ? ["cancelled", "dropped", 0] : ["done", 409, 1])
  })

  it("cross-firm: getJob, retryFailedJob and cancelJob on another firm's jobId answer 404 and change nothing; one idempotency key in two firms makes two jobs", async () => {
    const a = await seedFirm()
    const b = await seedFirm()
    const queued = await job(a)
    const dead = await job(a)
    await deadLetter(dead)
    const before = await Promise.all([readJob(queued), readJob(dead)])
    for (const who of [b.P, b.A, b.C]) {
      for (const jobId of [queued, dead]) {
        expectKind(await apiErrorOf(getJob(b, who, { jobId })), "not-found", "not_found")
        if (who !== b.C) expectKind(await apiErrorOf(retry(b, who, { jobId, note: NOTE })), "not-found", "not_found")
      }
    }
    for (const jobId of [queued, dead]) expectKind(await apiErrorOf(cancel(b, b.P, { jobId, note: CANCEL_NOTE })), "not-found", "not_found")
    // X-Firm-Id of firm A with a firm-B token.
    expectKind(await apiErrorOf(getApi(as(b.P, a.firmId, { jobId: dead }))), "permission-denied", "firm_mismatch")
    expectKind(await apiErrorOf(retryApi(as(b.P, a.firmId, { jobId: dead, note: NOTE }))), "permission-denied", "firm_mismatch")
    expectKind(await apiErrorOf(cancelApi(as(b.P, a.firmId, { jobId: queued, note: CANCEL_NOTE }))), "permission-denied", "firm_mismatch")
    expectKind(await apiErrorOf(listApi(as(b.P, a.firmId, {}))), "permission-denied", "firm_mismatch")
    const after = await Promise.all([readJob(queued), readJob(dead)])
    for (const [i, row] of after.entries()) expect(row.updateTime.isEqual(before[i].updateTime)).toBe(true)

    await job(b)
    const bList = await list(b, b.P, {})
    expect(bList.items).toHaveLength(1)
    expect(JSON.stringify(bList)).not.toContain(queued)
    expect(JSON.stringify(bList)).not.toContain(dead)
    expect(JSON.stringify(bList)).not.toContain(a.firmId)

    const inA = await enqueueAt(diagSpec(a.firmId, { behaviour: "succeed" }, { idempotencyKey: "shared" }), T0)
    const inB = await enqueueAt(diagSpec(b.firmId, { behaviour: "succeed" }, { idempotencyKey: "shared" }), T0)
    expect(inA.jobId).not.toBe(inB.jobId)
    expect([inA.reused, inB.reused]).toEqual([false, false])
    expect((await readJob(inA.jobId)).firmId).toBe(a.firmId)
    expect((await readJob(inB.jobId)).firmId).toBe(b.firmId)
  })

  it("poison: a raw error carrying a payload value never reaches lastError, logs, events, audit, alerts or the API", async () => {
    const f = await seedFirm()
    const marker = `poison-${randomUUID()}`
    const spies = (["info", "warn", "error", "log", "debug", "write"] as const).map((level) => vi.spyOn(logger, level).mockImplementation(() => undefined))
    const jobId = await job(f, {}, T0, { behaviour: "throw_raw", marker })
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
    let t = T0
    for (let i = 0; i < 6 && (await readJob(jobId)).status !== "dead_lettered"; i++) {
      t += 30_000
      await d.dispatcher.drainDue(t)
    }
    const row = await readJob(jobId)
    expect([row.status, row.totalAttempts]).toEqual(["dead_lettered", 4])
    expect(row.lastError).toEqual({ code: "internal", message: "The job failed with an internal error." })
    expect(d.alerts).toEqual([expect.objectContaining({ jobId, code: "internal", attempts: 4 })])

    const { payload: _payload, ...rowWithoutPayload } = row
    void _payload
    const events = await jobEvents(jobId)
    expect(Object.keys(events).length).toBeGreaterThan(0)
    const auditRows = await jobAuditRows(jobId)
    expect(auditRows.length).toBeGreaterThan(0)
    const viewed = await getJob(f, f.P, { jobId })
    const listed = await list(f, f.P, {})
    expect(ids(listed)).toContain(jobId)
    const sources = [rowWithoutPayload, row.lastError, row.logs, events, auditRows, d.alerts, spies.flatMap((s) => s.mock.calls), viewed, listed]
    expect(JSON.stringify(sources)).not.toContain(marker)
    // The marker is in the stored payload only (proves the probe is live).
    expect(JSON.stringify(row.payload)).toContain(marker)
  })
})
