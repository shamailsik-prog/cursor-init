import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { jobRuntime, type JobDispatcher, type JobTask } from "../src/p2/dispatch"
import { jobsRef } from "../src/p2/enqueue"
import { onJobCreatedCore } from "../src/p2/functions"
import { sweep } from "../src/p2/sweeper"
import { jobWorkerTestSeam } from "../src/p2/worker"
import { viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { deleteFirmData } from "./firmCleanup"
import { FakeClock, diagSpec, enqueueAt, newFirm, readJob, sweepOrigins, testDeps } from "./jobs"

/**
 * Audit F43 (HIGH, 2026-10-13) "Logs are used as alert delivery without proved escalation", the P2 routes, end to end
 * over the Firestore and Auth emulators: the real create-trigger core, the real sweeper, the real worker (in-process
 * Cloud Tasks stand-in, fake clock), the real HTTP router.
 *
 * On main each injected fault produces log lines only: `job dispatch failed` (forever, the row stays queued and never
 * dead-letters), `job.deadLettered`, `job commit failed`. Nothing durable says anyone must act. The correction: an
 * `ops_alerts` document per condition and subject, written in the state change's own transaction (dead letter) or
 * derived from the rows' durable state by the sweeper or the checker (stall, queue age, saga age), plus one page in
 * the outbox per episode and level.
 *
 * Clock origins are a thousand years before the other P2 suites' (`sweepOrigins(1000)`), so this file's sweeps and
 * checks see only its own rows; each test deletes its firm's documents afterwards, so no other suite's sweep sees them.
 */

const nextOrigin = sweepOrigins(1000)
/** Cleanup scans every collection of the shared emulator; under load that can exceed the 10 s hook default. */
const CLEANUP_TIMEOUT_MS = 120_000

/**
 * Deletes the firm's job rows first, with one targeted query: rows dated a thousand years back would be due in every
 * other sweeper suite's sweep, so they must not outlive the test even if the generic cleanup after them fails.
 */
async function dropJobs(firmId: string): Promise<void> {
  const snap = await jobsRef().where("firmId", "==", firmId).select().get()
  const batch = adminDb().batch()
  for (const d of snap.docs) batch.delete(d.ref)
  if (snap.size > 0) await batch.commit()
}

/** Loaded through a computed specifier, so this file runs (and fails on behaviour) on a tree without the module. */
const CHECKER = ["..", "src", "alerts", "checker"].join("/")
type CheckerModule = { runAlertChecker: (o: { now: () => number; passes?: string[] }) => Promise<{ raised: string[] }> }
const checker = async (): Promise<CheckerModule> => (await import(/* @vite-ignore */ CHECKER)) as CheckerModule

type Alert = DocumentData & { id: string }
const alertsOf = async (firmId: string, condition?: string): Promise<Alert[]> =>
  (await adminDb().collection("ops_alerts").where("firmId", "==", firmId).get()).docs
    .map((d): Alert => ({ id: d.id, ...d.data() }))
    .filter((a) => condition === undefined || a.condition === condition)
const pagesOf = async (alertId: string): Promise<Alert[]> =>
  (await adminDb().collection("ops_alert_notifications").where("alertId", "==", alertId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const millis = (t: unknown) => (t instanceof Timestamp ? t.toMillis() : null)

/** Cloud Tasks that refuses every enqueue (the audit's failure scenario: dispatch stays broken). */
class BrokenQueue implements JobDispatcher {
  calls: JobTask[] = []
  async dispatch(task: JobTask): Promise<void> {
    this.calls.push(task)
    throw Object.assign(new Error("queue refused the task"), { code: "functions/unavailable" })
  }
}

/** Firestore's stored size of a document (name, fields, 32 bytes overhead), per the documented size rules. */
function valueSize(v: unknown): number {
  if (v === null || v === undefined || typeof v === "boolean") return 1
  if (typeof v === "number" || v instanceof Timestamp) return 8
  if (typeof v === "string") return Buffer.byteLength(v, "utf8") + 1
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + valueSize(x), 0)
  return Object.entries(v as Record<string, unknown>).reduce((n, [k, x]) => n + Buffer.byteLength(k, "utf8") + 1 + valueSize(x), 0)
}
const docSize = (path: string, data: DocumentData) => path.split("/").reduce((n, s) => n + Buffer.byteLength(s, "utf8") + 1, 16) + valueSize(data) + 32

describe.skipIf(!EMULATORS)("audit F43: P2 faults raise durable alerts (e2e)", () => {
  let T0: number
  let clock: FakeClock
  let firmId: string
  const uids: string[] = []

  beforeEach(async () => {
    T0 = nextOrigin()
    clock = new FakeClock(T0)
    firmId = await newFirm()
  })

  afterEach(async () => {
    delete jobWorkerTestSeam.beforeCommit
    delete jobRuntime.deps
    await dropJobs(firmId)
    await deleteFirmData([firmId], uids.splice(0))
  }, CLEANUP_TIMEOUT_MS)

  it("the audit scenario: dispatch stays broken, the job never dead-letters, and the third sweeper re-dispatch raises one job.dispatch_stalled alert", async () => {
    const queue = new BrokenQueue()
    const d = { ...testDeps(clock), dispatcher: queue }
    const { jobId } = await enqueueAt(diagSpec(firmId, { behaviour: "succeed" }), T0)
    // The create trigger's dispatch fails: logged and swallowed (main's behaviour, unchanged).
    await onJobCreatedCore(jobId, (await jobsRef().doc(jobId).get()).data(), d)

    // Re-dispatches 1 and 2 (backoff 30 s, then 60 s): still under the threshold.
    for (const at of [T0 + 30_000, T0 + 90_000]) {
      clock.set(at)
      expect((await sweep(d)).dispatched).not.toContain(jobId)
    }
    expect(await alertsOf(firmId)).toEqual([])

    // Re-dispatch 3 (after 120 s): the queue has refused the job three times without a claim.
    clock.set(T0 + 210_000)
    await sweep(d)
    const row = await readJob(jobId)
    expect(row).toMatchObject({ status: "queued", redispatches: 3, attempts: 0 })
    const [alert, ...more] = await alertsOf(firmId)
    expect(more).toEqual([])
    expect(alert).toMatchObject({
      condition: "job.dispatch_stalled",
      firmId,
      subjectKey: "jobType:platform.diagnostic",
      ref: `jobs/${jobId}`,
      state: "open",
      level: 0,
      ownerRole: "operator",
      severity: "high",
      episode: 1,
      count: 1,
    })
    expect(alert.detail).toMatchObject({ jobs: 1, maxRedispatches: 3 })
    expect([millis(alert.firstSeenAt), millis(alert.escalateAt)]).toEqual([T0 + 210_000, T0 + 210_000 + 30 * 60_000])
    const pages = await pagesOf(alert.id)
    expect(pages.map((p) => [p.id, p.level, p.status, p.targets])).toEqual([[`${alert.id}_e1_l0`, 0, "pending", [{ kind: "oncall" }]]])

    // Re-dispatch 4 (after 240 s): the same alert counts it; no second document and no second page (dedupe).
    clock.set(T0 + 450_000)
    await sweep(d)
    const again = await alertsOf(firmId)
    expect(again.map((a) => [a.id, a.count, millis(a.lastSeenAt), a.detail.maxRedispatches])).toEqual([[alert.id, 2, T0 + 450_000, 4]])
    expect(await pagesOf(alert.id)).toHaveLength(1)
    // The job never dead-lettered: only the stall says anything is wrong.
    expect((await readJob(jobId)).status).toBe("queued")
    expect(queue.calls.length).toBe(5)
  })

  it("a handler that always fails dead-letters through the real worker, and the dead-letter transaction writes one job.dead_lettered alert with codes only", async () => {
    const d = testDeps(clock)
    const { jobId } = await enqueueAt(diagSpec(firmId, { behaviour: "fail_times", failTimes: 4, marker: "PRIVILEGED-MARKER-TEXT" }), T0)
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
    // The retries the worker scheduled (1 s, 5 s, 25 s), each delivered when due.
    for (const at of [T0 + 1_000, T0 + 6_000, T0 + 31_000]) await d.dispatcher.drainDue(at)
    const row = await readJob(jobId)
    expect(row).toMatchObject({ status: "dead_lettered", attempts: 4 })

    const alerts = await alertsOf(firmId)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      condition: "job.dead_lettered",
      subjectKey: `job:${jobId}`,
      ref: `jobs/${jobId}`,
      state: "open",
      level: 0,
      ownerRole: "operator",
      severity: "high",
      count: 1,
      detail: { jobType: "platform.diagnostic", code: "diag_failure", attempts: 4 },
    })
    // Same transaction as the dead letter: the alert's first sighting is the job's finish time.
    expect(millis(alerts[0].firstSeenAt)).toBe(millis(row.finishedAt))
    expect(JSON.stringify(alerts[0])).not.toContain("PRIVILEGED-MARKER-TEXT")
    expect(await pagesOf(alerts[0].id)).toHaveLength(1)
    // The existing after-commit log hook still fires (the durable alert is added, not substituted).
    expect(d.alerts).toEqual([expect.objectContaining({ jobId, code: "diag_failure", attempts: 4 })])
  })

  it("two jobs dead-lettered are two alerts (one per subject), and a job dead-lettered again after a manual retry is the same alert, counted, with no second page", async () => {
    const d = testDeps(clock)
    const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
    uids.push(partner.uid)
    const a = (await enqueueAt(diagSpec(firmId, { behaviour: "permanent" }, { createdBy: partner.uid }), T0)).jobId
    const b = (await enqueueAt(diagSpec(firmId, { behaviour: "permanent" }), T0)).jobId
    expect(await d.dispatcher.deliver({ jobId: a, seq: 0 }, T0)).toBe("dead_lettered")
    expect(await d.dispatcher.deliver({ jobId: b, seq: 0 }, T0)).toBe("dead_lettered")
    const two = await alertsOf(firmId, "job.dead_lettered")
    expect(two.map((x) => x.subjectKey).sort()).toEqual([`job:${a}`, `job:${b}`].sort())

    // The route's after-commit dispatch goes to the in-process queue (it is recorded, not delivered).
    jobRuntime.deps = d
    const retry = viaApi<{ status: string }>("retryFailedJob", { now: () => clock.now() })
    clock.set(T0 + 60_000)
    expect((await retry({ token: partner.token, data: { firmId, jobId: a, note: "Requeued after the cause was fixed." } } as never)).status).toBe("queued")
    const seq = (await readJob(a)).dispatchSeq
    expect(await d.dispatcher.deliver({ jobId: a, seq }, T0 + 60_000)).toBe("dead_lettered")

    const after = (await alertsOf(firmId, "job.dead_lettered")).find((x) => x.subjectKey === `job:${a}`)!
    expect(after).toMatchObject({ state: "open", episode: 1, count: 2, totalCount: 2 })
    expect(millis(after.lastSeenAt)).toBe(T0 + 60_000)
    expect(await pagesOf(after.id)).toHaveLength(1)
  })

  it("the sweeper's lease-expired dead letter (query B, attempt 4) writes the alert in its transaction", async () => {
    const d = testDeps(clock)
    const { jobId } = await enqueueAt(diagSpec(firmId, { behaviour: "succeed" }), T0)
    await jobsRef()
      .doc(jobId)
      .update({ status: "running", attempts: 4, totalAttempts: 4, lease: { owner: "dead", expiresAt: Timestamp.fromMillis(T0 + 600_000) }, sweepAt: Timestamp.fromMillis(T0 + 600_000) })
    clock.set(T0 + 600_000)
    expect((await sweep(d)).deadLettered).toEqual([jobId])
    const alerts = await alertsOf(firmId)
    expect(alerts.map((x) => [x.condition, x.subjectKey, x.detail.code, millis(x.firstSeenAt)])).toEqual([["job.dead_lettered", `job:${jobId}`, "lease_expired", T0 + 600_000]])
  })

  it("transaction coupling: a dead letter whose commit is refused writes no alert and no page; the same dead letter that commits writes both", async () => {
    const d = testDeps(clock)
    const seedExpired = async (padBytes: number | null) => {
      const { jobId } = await enqueueAt(diagSpec(firmId, { behaviour: "succeed" }), T0)
      const ref = jobsRef().doc(jobId)
      await ref.update({ status: "running", attempts: 4, totalAttempts: 4, lease: { owner: "dead", expiresAt: Timestamp.fromMillis(T0 + 600_000) }, sweepAt: Timestamp.fromMillis(T0 + 600_000) })
      if (padBytes !== null) {
        // Fill the row to `padBytes` under Firestore's 1 MiB limit: the dead-letter update (lastError, a log entry and
        // finishedAt, about 100 bytes more) then pushes it over, so the commit is refused after every write is staged.
        const data = (await ref.get()).data()!
        const pad = 1_048_576 - docSize(ref.path, { ...data, pad: "" }) - padBytes
        await ref.update({ pad: "x".repeat(pad) })
      }
      return jobId
    }
    const refused = await seedExpired(30)
    clock.set(T0 + 600_000)
    const r1 = await sweep(d)
    expect(r1.deadLettered).not.toContain(refused)
    expect((await readJob(refused)).status).toBe("running")
    expect(await alertsOf(firmId)).toEqual([])
    expect((await adminDb().collection("ops_alert_notifications").where("firmId", "==", firmId).get()).size).toBe(0)

    // Control: the same row without the padding dead-letters, and its alert and page commit with it.
    const committed = await seedExpired(null)
    clock.set(T0 + 600_001)
    expect((await sweep(d)).deadLettered).toEqual([committed])
    expect((await alertsOf(firmId)).map((x) => x.subjectKey)).toEqual([`job:${committed}`])
  })

  it("the worker's commit fails: the row stays running and one job.commit_failed alert is raised for the firm and job type", async () => {
    const d = testDeps(clock)
    const { jobId } = await enqueueAt(diagSpec(firmId, { behaviour: "succeed" }), T0)
    jobWorkerTestSeam.beforeCommit = async ({ fallback }) => {
      // A transient store error on the finish commit (UNAVAILABLE): logged by code and rethrown on main.
      if (!fallback) throw Object.assign(new Error("store unavailable"), { code: 14 })
    }
    await expect(d.dispatcher.deliver({ jobId, seq: 0 }, T0)).rejects.toMatchObject({ code: 14 })
    expect((await readJob(jobId)).status).toBe("running")
    const alerts = await alertsOf(firmId)
    expect(alerts.map((x) => [x.condition, x.subjectKey, x.ref, x.state, x.severity, x.count])).toEqual([
      ["job.commit_failed", "jobType:platform.diagnostic", `jobs/${jobId}`, "open", "high", 1],
    ])
    expect(alerts[0].detail).toMatchObject({ code: "unavailable" })
  })

  it("queue age: a job never dispatched (no trigger, no sweeper) is found by the checker once it has waited 15 minutes", async () => {
    const { jobId } = await enqueueAt(diagSpec(firmId, { behaviour: "succeed" }), T0)
    const stuck = (await enqueueAt(diagSpec(firmId, { behaviour: "succeed" }), T0 + 60_000)).jobId
    await jobsRef()
      .doc(stuck)
      .update({ status: "running", attempts: 1, totalAttempts: 1, lease: { owner: "dead", expiresAt: Timestamp.fromMillis(T0 + 60_000) }, sweepAt: Timestamp.fromMillis(T0 + 60_000) })
    const { runAlertChecker } = await checker()
    await runAlertChecker({ now: () => T0 + 15 * 60_000 - 1, passes: ["jobs"] })
    expect(await alertsOf(firmId)).toEqual([])

    await runAlertChecker({ now: () => T0 + 15 * 60_000, passes: ["jobs"] })
    const [alert, ...more] = await alertsOf(firmId)
    expect(more).toEqual([])
    expect(alert).toMatchObject({ condition: "job.queue_age", subjectKey: "jobType:platform.diagnostic", ref: `jobs/${jobId}`, state: "open", severity: "high", count: 1 })
    expect(alert.detail).toMatchObject({ waiting: 1, oldestAgeMs: 15 * 60_000 })

    // Fifteen minutes past the stuck lease too: both rows counted, the oldest still named; one document.
    await runAlertChecker({ now: () => T0 + 16 * 60_000, passes: ["jobs"] })
    const later = await alertsOf(firmId)
    expect(later.map((x) => [x.id, x.count, x.ref, x.detail.waiting, x.detail.oldestAgeMs])).toEqual([[alert.id, 2, `jobs/${jobId}`, 2, 16 * 60_000]])
  })
})

/**
 * A stuck un-merge saga through the real routes: two clients share a CNIC, an associate confirms the pair, a partner
 * un-merges it, and the saga's jobs are never dispatched. Run at the real clock (the d1 routes stamp their own rows),
 * so the checker runs with only its saga pass.
 */
describe.skipIf(!EMULATORS)("audit F43: a stuck un-merge saga raises saga.age (e2e)", () => {
  const clock = new FakeClock(Date.now())
  const route = { now: () => clock.now() }
  let firmId: string
  const uids: string[] = []

  afterEach(async () => {
    await deleteFirmData([firmId], uids.splice(0))
  }, CLEANUP_TIMEOUT_MS)

  it("an un-merge whose jobs never run is in progress for 60 minutes: one saga.age alert names the merge event", async () => {
    firmId = uniq("firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
    const claims = (role: string) => ({ firmId, role, clearanceLevel: "privileged-restricted" })
    const partner = await mintIdToken(claims("partner"))
    const associate = await mintIdToken(claims("associate"))
    uids.push(partner.uid, associate.uid)
    const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
    const cnic = "4210112345671"
    const a = await registerClient({ token: partner.token, data: { firmId, name: "Muhammad Ali", type: "individual", primaryMobile: "03035551234", classification: "internal", cnic } } as never)
    const b = await registerClient({ token: partner.token, data: { firmId, name: "Mohammad Ali Khan", type: "individual", primaryMobile: "03035554321", classification: "internal", cnic } } as never)
    const [left, right] = [a.entityId, b.entityId].sort()
    const linkId = `${firmId}_${left}_${right}_cnic`
    const note = "Same CNIC on both files, but they are two cousins."
    await viaApi("confirmMerge", route)({ token: associate.token, data: { firmId, linkId, note } } as never)
    const started = clock.now()
    const unmerged = await viaApi<{ mergeEventId: string; status: string }>("unmergeEntity", route)({ token: partner.token, data: { firmId, linkId, note } } as never)
    expect(unmerged.status).toBe("in_progress")

    const { runAlertChecker } = await checker()
    await runAlertChecker({ now: () => started + 60 * 60_000 - 1, passes: ["sagas"] })
    expect(await alertsOf(firmId)).toEqual([])
    await runAlertChecker({ now: () => started + 60 * 60_000, passes: ["sagas"] })
    const alerts = await alertsOf(firmId)
    expect(alerts.map((x) => [x.condition, x.subjectKey, x.ref, x.state, x.severity])).toEqual([
      ["saga.age", "sagaType:entity.unmerge", `merge_events/${unmerged.mergeEventId}`, "open", "high"],
    ])
    expect(alerts[0].detail).toMatchObject({ inProgress: 1, oldestAgeMs: 60 * 60_000 })
  })
})
