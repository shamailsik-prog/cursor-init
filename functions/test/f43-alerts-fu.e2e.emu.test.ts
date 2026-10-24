import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { runAlertChecker } from "../src/alerts/checker"
import { runAlertEscalator } from "../src/alerts/escalator"
import type { AlertSpec } from "../src/alerts/model"
import { alertOpsTestSeam } from "../src/alerts/ops"
import { raiseAlert } from "../src/alerts/raise"
import { firmConfigRef, platformConfigRef } from "../src/p1/config"
import { callP1, p1TestSeam, type P1Request } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { setP1TransportForTests } from "../src/p1/transport"
import type { JobDispatcher, JobTask } from "../src/p2/dispatch"
import { jobsRef } from "../src/p2/enqueue"
import { onJobCreatedCore } from "../src/p2/functions"
import { sweep } from "../src/p2/sweeper"
import { viaApi } from "./api"
import { budgetSpentAfterFirstPage } from "./checkerClock"
import { EMULATORS, mintIdToken } from "./emu"
import { deleteFirmData } from "./firmCleanup"
import { FakeClock, diagSpec, enqueueAt, newFirm, sweepOrigins, testDeps } from "./jobs"

/**
 * Audit F43 R1 (re-audit of #120 at 55cc8a4), end to end over the Firestore and Auth emulators: the real sweeper with
 * a queue that accepts tasks and never delivers them, the real HTTP router, the real escalator, checker and `callP1`.
 *
 * - FA-F43-R1-002 (MEDIUM): an acknowledged alert absorbed every later recurrence (count only: no page, no
 *   escalation). Spec R18: an acknowledgment holds for four hours; a raise after that opens a new episode at level 0.
 * - FA-F43-R1-005: the ladder ended silently at level 2. Spec R21: level 2 re-pages every critical window.
 * - FA-F43-R1-006: noise. Spec R22: a derived condition no longer observed is cleared and does not escalate; R23: a
 *   kill-switch alert stays at level 0; R24: a platform kill switch is one alert under the platform subject.
 *
 * Clock origins are thirteen hundred years before the P2 suites' (`sweepOrigins(1300)`), so this file's sweeps,
 * checks and escalations see only its own rows.
 */

const nextOrigin = sweepOrigins(1300)
const MIN = 60_000
const HOUR = 60 * MIN
/** Spec R18 (unit-pinned in f43-alerts.unit.test.ts as ACK_HOLD_MS). */
const HOLD = 4 * HOUR
const LONG = { timeout: 120_000 }
const PLATFORM = "__platform__"

type Alert = DocumentData & { id: string }
const alertsOf = async (firmId: string): Promise<Alert[]> =>
  (await adminDb().collection("ops_alerts").where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const alertDoc = async (id: string): Promise<Alert> => ({ id, ...(await adminDb().collection("ops_alerts").doc(id).get()).data() })
const pagesOf = async (alertId: string): Promise<Alert[]> =>
  (await adminDb().collection("ops_alert_notifications").where("alertId", "==", alertId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const notesOf = async (alertId: string): Promise<Alert[]> =>
  (await adminDb().collection("notifications").where("alertId", "==", alertId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const millis = (t: unknown) => (t instanceof Timestamp ? t.toMillis() : null)
const pageIds = async (alertId: string) => (await pagesOf(alertId)).map((p) => p.id).sort()

/**
 * Deletes the platform-subject alerts and their pages. (`deleteFirmData` cannot: it pages by document id from the firm
 * id, and Firestore refuses `__platform__` as a cursor value because ids matching `__.*__` are reserved; which is also
 * why no firm can ever have that id, spec R24.)
 */
async function deletePlatformAlerts(): Promise<void> {
  // Every collection: the alert, its pages, and the audit row of an operator's action on it.
  for (const col of await adminDb().listCollections()) {
    const snap = await col.where("firmId", "==", PLATFORM).select().get()
    if (snap.size === 0) continue
    const batch = adminDb().batch()
    for (const d of snap.docs) batch.delete(d.ref)
    await batch.commit()
  }
}

/** Cloud Tasks that accepts every task and never delivers one (a paused queue, an unreachable worker). */
class BlackHoleQueue implements JobDispatcher {
  calls: JobTask[] = []
  async dispatch(task: JobTask): Promise<void> {
    this.calls.push(task)
  }
}

type Delivered = { id: string; level: number }
type EscalatorRun = { escalated: string[]; delivered: string[]; repaged?: string[] }

describe.skipIf(!EMULATORS)("audit F43 R1: recurrence after acknowledgment, the last level, and noise (e2e)", () => {
  let T0: number
  const firms: string[] = []
  const uids: string[] = []
  let delivered: Delivered[]
  const notifier = { deliver: async (p: Delivered) => void delivered.push({ id: p.id, level: p.level }) }
  const escalate = (ms: number): Promise<EscalatorRun> => runAlertEscalator({ now: () => ms, notifier: notifier as never }) as Promise<EscalatorRun>

  const firm = async (): Promise<string> => {
    const f = await newFirm()
    firms.push(f)
    return f
  }
  const operator = async () => {
    const op = await mintIdToken({ platformAdmin: true })
    uids.push(op.uid)
    return op
  }

  beforeEach(async () => {
    T0 = nextOrigin()
    delivered = []
    await adminDb().collection("platform").doc("opsAlertChecker").delete()
  })

  afterEach(async () => {
    delete alertOpsTestSeam.now
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    setProviderConfigForTests(null)
    for (const k of Object.keys(p1TestSeam)) delete (p1TestSeam as Record<string, unknown>)[k]
    await platformConfigRef().delete()
    // Job rows first, with one targeted query: rows dated centuries back must not outlive the test (other suites' sweeps).
    for (const f of firms) {
      const jobs = await jobsRef().where("firmId", "==", f).select().get()
      if (jobs.size > 0) {
        const batch = adminDb().batch()
        for (const d of jobs.docs) batch.delete(d.ref)
        await batch.commit()
      }
    }
    // Each test's alerts go with it: an open alert left behind would be escalated by the next test's escalator run.
    await deleteFirmData(firms.splice(0), uids.splice(0))
  }, 300_000)

  afterAll(async () => {
    await deletePlatformAlerts()
    await adminDb().collection("platform").doc("opsAlertChecker").delete()
  }, 300_000)

  it("R1-002: an acknowledged stall that recurs within four hours is counted; after four hours the recurrence opens episode 2 with a level-0 page", LONG, async () => {
    const clock = new FakeClock(T0)
    const firmId = await firm()
    const op = await operator()
    const queue = new BlackHoleQueue()
    const d = { ...testDeps(clock), dispatcher: queue }
    const { jobId } = await enqueueAt(diagSpec(firmId, { behaviour: "succeed" }), T0)
    await onJobCreatedCore(jobId, (await jobsRef().doc(jobId).get()).data(), d)
    // Three sweeper re-dispatches without a claim (30, 60, 120 s backoff): the queue is not delivering.
    for (const at of [T0 + 30_000, T0 + 90_000, T0 + 210_000]) {
      clock.set(at)
      await sweep(d)
    }
    const [alert, ...more] = await alertsOf(firmId)
    expect(more).toEqual([])
    expect(alert).toMatchObject({ condition: "job.dispatch_stalled", state: "open", episode: 1, level: 0, count: 1 })
    expect((await escalate(T0 + 211_000)).delivered).toEqual([`${alert.id}_e1_l0`])

    // The operator acknowledges at T0 + 5 minutes, through the real router.
    const ACK = T0 + 5 * MIN
    alertOpsTestSeam.now = () => ACK
    await viaApi("operatorAlertAction")({ token: op.token, data: { alertId: alert.id, action: "acknowledge" } } as never)
    expect(await alertDoc(alert.id)).toMatchObject({ state: "acknowledged", escalateAt: null })

    // Within the hold the queue is still broken: the sweeper re-dispatches and raises again; the alert counts it.
    clock.set(ACK + HOUR)
    expect((await sweep(d)).stalled).toEqual([jobId])
    const held = await alertDoc(alert.id)
    expect([held.state, held.episode, held.count, held.totalCount, held.level, held.escalateAt]).toEqual(["acknowledged", 1, 2, 2, 0, null])
    expect(await pageIds(alert.id)).toEqual([`${alert.id}_e1_l0`])
    const quiet = await escalate(ACK + 2 * HOUR)
    expect([quiet.escalated, quiet.delivered]).toEqual([[], []])

    // Four hours after the acknowledgment the recurrence is a new incident: episode 2, level 0, a fresh deadline, a page.
    clock.set(ACK + HOLD)
    expect((await sweep(d)).stalled).toEqual([jobId])
    const reopened = await alertDoc(alert.id)
    expect(reopened).toMatchObject({ state: "open", episode: 2, level: 0, ownerRole: "operator", count: 1, totalCount: 3, acknowledgedAt: null, acknowledgedBy: null, escalations: [] })
    expect([millis(reopened.firstSeenAt), millis(reopened.escalateAt)]).toEqual([ACK + HOLD, ACK + HOLD + 30 * MIN])
    expect(await pageIds(alert.id)).toEqual([`${alert.id}_e1_l0`, `${alert.id}_e2_l0`].sort())
    expect((await escalate(ACK + HOLD + MIN)).delivered).toEqual([`${alert.id}_e2_l0`])
    // And it escalates again if nobody acknowledges the new episode.
    expect((await escalate(ACK + HOLD + 30 * MIN)).escalated).toEqual([alert.id])
    // The acknowledgment of episode 1 stays in the alert's history.
    expect(reopened.actions.map((a: DocumentData) => [a.action, a.role, millis(a.at)])).toEqual([["acknowledge", "operator", ACK]])
  })

  it("R1-002 boundary: a raise 4 h − 1 ms after the acknowledgment is counted; at exactly 4 h it reopens", LONG, async () => {
    const firmId = await firm()
    const op = await operator()
    const spec: AlertSpec = { condition: "job.queue_age", firmId, subjectKey: "jobType:platform.diagnostic", ref: null, severity: "high", detail: { waiting: 1 } }
    const { id } = await raiseAlert(spec, T0)
    const ACK = T0 + MIN
    alertOpsTestSeam.now = () => ACK
    await viaApi("operatorAlertAction")({ token: op.token, data: { alertId: id, action: "acknowledge" } } as never)
    expect((await raiseAlert(spec, ACK + HOLD - 1)).staged).toBe("counted")
    expect(await alertDoc(id)).toMatchObject({ state: "acknowledged", episode: 1, count: 2 })
    expect((await raiseAlert(spec, ACK + HOLD)).staged).toBe("reopened")
    expect(await alertDoc(id)).toMatchObject({ state: "open", episode: 2, count: 1, level: 0 })
    expect(await pageIds(id)).toEqual([`${id}_e1_l0`, `${id}_e2_l0`].sort())
  })

  it("R1-005: at level 2 the escalator re-pages the firm administrator and the on-call channel every critical window until someone acknowledges", LONG, async () => {
    const firmId = await firm()
    const founder = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
    uids.push(founder.uid)
    await adminDb().collection("platform_onboarding").doc(founder.uid).set({ firmId, at: Timestamp.fromMillis(T0) })
    const spec: AlertSpec = { condition: "job.queue_age", firmId, subjectKey: "jobType:platform.diagnostic", ref: null, severity: "high", detail: { waiting: 1 } }
    const { id } = await raiseAlert(spec, T0)
    expect((await escalate(T0 + 30 * MIN)).escalated).toEqual([id])
    expect((await escalate(T0 + 45 * MIN)).escalated).toEqual([id])
    const l2 = await alertDoc(id)
    expect([l2.level, l2.ownerRole, l2.severity, millis(l2.escalateAt)]).toEqual([2, "firm_admin", "critical", T0 + 60 * MIN])

    // One critical window later, unacknowledged: one re-page of level 2 (not a step: the ladder has no level 3).
    const early = await escalate(T0 + 60 * MIN - 1)
    expect([early.escalated, early.repaged]).toEqual([[], []])
    const [r1, r1b] = await Promise.all([escalate(T0 + 60 * MIN), escalate(T0 + 60 * MIN)])
    expect([...r1.escalated, ...r1b.escalated]).toEqual([])
    expect([...(r1.repaged ?? []), ...(r1b.repaged ?? [])]).toEqual([id])
    const after1 = await alertDoc(id)
    expect([after1.level, after1.repages, millis(after1.escalateAt), after1.escalations.length]).toEqual([2, 1, T0 + 75 * MIN, 2])
    const page1 = (await pagesOf(id)).find((p) => p.id === `${id}_e1_l2_r1`)
    expect(page1).toMatchObject({ level: 2, ownerRole: "firm_admin", severity: "critical", targets: expect.arrayContaining([{ kind: "oncall" }, { kind: "user", uid: founder.uid }]) })
    expect(delivered.map((p) => p.id)).toContain(`${id}_e1_l2_r1`)
    expect((await notesOf(id)).map((n) => n.id).sort()).toEqual([`${id}_e1_l1_${founder.uid}`, `${id}_e1_l2_${founder.uid}`, `${id}_e1_l2_r1_${founder.uid}`].sort())

    // Long after, a single re-page (the next deadline is computed from now, so no catch-up burst).
    const late = await escalate(T0 + 10 * HOUR)
    expect(late.repaged).toEqual([id])
    expect([(await alertDoc(id)).repages, millis((await alertDoc(id)).escalateAt)]).toEqual([2, T0 + 10 * HOUR + 15 * MIN])

    // The firm administrator acknowledges: the re-pages stop.
    await viaApi("acknowledgeAlert", { now: () => T0 + 10 * HOUR + MIN })({ token: founder.token, data: { firmId, alertId: id } } as never)
    const quiet = await escalate(T0 + 30 * HOUR)
    expect([quiet.escalated, quiet.repaged]).toEqual([[], []])
    expect(await pageIds(id)).toEqual([`${id}_e1_l0`, `${id}_e1_l1`, `${id}_e1_l2`, `${id}_e1_l2_r1`, `${id}_e1_l2_r2`].sort())
    await adminDb().collection("platform_onboarding").doc(founder.uid).delete()
  })

  it("R1-006a: a derived condition the checker no longer observes is cleared and does not escalate; observed again, it resumes", LONG, async () => {
    const firmId = await firm()
    const saga = adminDb().collection("merge_events").doc(`${firmId}_me1`)
    await saga.set({ firmId, unmerge: { status: "in_progress", startedAt: Timestamp.fromMillis(T0) } })
    await runAlertChecker({ now: () => T0 + 61 * MIN, passes: ["sagas"] })
    const [alert] = (await alertsOf(firmId)).filter((a) => a.condition === "saga.age")
    expect(alert).toMatchObject({ state: "open", level: 0, count: 1 })
    expect(millis(alert.escalateAt)).toBe(T0 + 91 * MIN)

    // The un-merge finishes: the next complete pass no longer observes it, and clears the alert.
    await saga.update({ "unmerge.status": "done" })
    await runAlertChecker({ now: () => T0 + 66 * MIN, passes: ["sagas"] })
    const cleared = await alertDoc(alert.id)
    expect([cleared.state, millis(cleared.clearedAt), cleared.escalateAt, cleared.count]).toEqual(["open", T0 + 66 * MIN, null, 1])
    // The partners' worklist shows it open and cleared.
    const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
    uids.push(partner.uid)
    const list = await viaApi<{ items: Array<Record<string, unknown>> }>("listAlerts", { now: () => T0 + 67 * MIN })({ token: partner.token, data: { firmId } } as never)
    expect(list.items.map((i) => [i.alertId, i.state, i.clearedAt, i.escalateAt])).toEqual([[alert.id, "open", new Date(T0 + 66 * MIN).toISOString(), null]])
    // Past its old deadline the escalator leaves it alone.
    expect((await escalate(T0 + 2 * HOUR)).escalated).toEqual([])
    expect((await alertDoc(alert.id)).level).toBe(0)

    // The saga sticks again: counted, no longer cleared, and a deadline at its level again.
    await saga.update({ "unmerge.status": "in_progress" })
    await runAlertChecker({ now: () => T0 + 3 * HOUR, passes: ["sagas"] })
    const resumed = await alertDoc(alert.id)
    expect([resumed.state, resumed.clearedAt, resumed.count, resumed.episode, millis(resumed.escalateAt)]).toEqual(["open", null, 2, 1, T0 + 3 * HOUR + 30 * MIN])
    expect((await escalate(T0 + 3 * HOUR + 30 * MIN)).escalated).toEqual([alert.id])
  })

  it("R1-006a: a run that reads only part of a query clears nothing", LONG, async () => {
    const busy = await firm()
    const firmId = await firm()
    // 100 older stuck sagas of another firm fill the first page; this firm's saga sorts after them.
    const rows = Array.from({ length: 100 }, (_, i) => adminDb().collection("merge_events").doc(`${busy}_me${String(i).padStart(3, "0")}`))
    for (let i = 0; i < rows.length; i += 50) {
      const batch = adminDb().batch()
      rows.slice(i, i + 50).forEach((ref, k) => batch.set(ref, { firmId: busy, unmerge: { status: "in_progress", startedAt: Timestamp.fromMillis(T0 + i + k) } }))
      await batch.commit()
    }
    await adminDb().collection("merge_events").doc(`${firmId}_me1`).set({ firmId, unmerge: { status: "in_progress", startedAt: Timestamp.fromMillis(T0 + 10 * MIN) } })
    await runAlertChecker({ now: () => T0 + 71 * MIN, passes: ["sagas"] })
    const [alert] = (await alertsOf(firmId)).filter((a) => a.condition === "saga.age")
    expect(alert).toMatchObject({ state: "open", count: 1 })

    // The next run's budget is spent after its first page (the other firm's 100 sagas): this firm's saga is not
    // observed, but the pass did not read the whole query, so the alert is not cleared.
    await adminDb().collection("platform").doc("opsAlertChecker").delete()
    const budget = budgetSpentAfterFirstPage()
    try {
      await runAlertChecker({ now: () => T0 + 76 * MIN, passes: ["sagas"], wallClock: budget.wallClock })
    } finally {
      budget.restore()
    }
    const after = await alertDoc(alert.id)
    expect([after.clearedAt ?? null, millis(after.escalateAt)]).toEqual([null, T0 + 101 * MIN])
  })

  it("R1-006b: a kill-switch alert stays at level 0 (no deadline, never escalated), and an acknowledgment holds while the switch stays on", LONG, async () => {
    const T = Date.parse("2001-02-10T10:00:00.000Z")
    const firmId = await firm()
    const op = await operator()
    setProviderConfigForTests(null)
    setP1TransportForTests({ send: async () => ({ text: "REPLY", inputTokens: 1000, outputTokens: 500 }) })
    await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: 1_000_000_000, killSwitch: { disableAll: true, disabledModels: [], reason: "Partner stopped AI." } })
    const req: P1Request = { firmId, actorId: "uid-1", matterId: "matter-1", jobId: null, taskType: "committee", classification: "internal", body: "Draft.", purpose: "committee-brain" }
    expect((await callP1(req, { now: () => T })).blockReason).toBe("kill_switch_firm")
    const [alert, ...more] = await alertsOf(firmId)
    expect(more).toEqual([])
    expect(alert).toMatchObject({ condition: "ai.kill_switch_blocked", subjectKey: "killSwitch:firm", state: "open", level: 0, escalateAt: null })
    expect((await escalate(T + 24 * HOUR)).escalated).toEqual([])
    expect(await alertDoc(alert.id)).toMatchObject({ level: 0, ownerRole: "operator" })

    alertOpsTestSeam.now = () => T + 24 * HOUR
    await viaApi("operatorAlertAction")({ token: op.token, data: { alertId: alert.id, action: "acknowledge" } } as never)
    expect((await callP1(req, { now: () => T + 24 * HOUR + 2 * HOLD })).blockReason).toBe("kill_switch_firm")
    expect(await alertDoc(alert.id)).toMatchObject({ state: "acknowledged", episode: 1, count: 2 })
    expect(await pageIds(alert.id)).toEqual([`${alert.id}_e1_l0`])
  })

  it("R1-006c: a platform kill switch is one alert under the platform subject, written once: calls refused in two firms leave it as it is", LONG, async () => {
    const T = Date.parse("2001-02-11T10:00:00.000Z")
    await deletePlatformAlerts()
    const a = await firm()
    const b = await firm()
    setProviderConfigForTests(null)
    setP1TransportForTests({ send: async () => ({ text: "REPLY", inputTokens: 1000, outputTokens: 500 }) })
    for (const f of [a, b]) await firmConfigRef(f).set({ monthlyBudgetMicroUsd: 1_000_000_000 })
    await platformConfigRef().set({ killSwitch: { disableAll: true, disabledModels: [], reason: "Operator stop." } })
    const req = (firmId: string): P1Request => ({ firmId, actorId: "uid-1", matterId: "matter-1", jobId: null, taskType: "committee", classification: "internal", body: "Draft.", purpose: "committee-brain" })
    expect((await callP1(req(a), { now: () => T })).blockReason).toBe("kill_switch_platform")
    expect((await callP1(req(b), { now: () => T + 1_000 })).blockReason).toBe("kill_switch_platform")
    expect((await callP1(req(a), { now: () => T + 2_000 })).blockReason).toBe("kill_switch_platform")
    expect([await alertsOf(a), await alertsOf(b)]).toEqual([[], []])
    const [alert, ...more] = await alertsOf(PLATFORM)
    expect(more).toEqual([])
    expect(alert).toMatchObject({ condition: "ai.kill_switch_blocked", subjectKey: "killSwitch:platform", ref: "platform/p1", state: "open", level: 0, count: 1, escalateAt: null })
    expect([millis(alert.firstSeenAt), millis(alert.lastSeenAt)]).toEqual([T, T])
    expect(await pageIds(alert.id)).toEqual([`${alert.id}_e1_l0`])
    expect(JSON.stringify(alert)).not.toContain("Operator stop")
    // No partner of either firm sees or acts on it; the operator does.
    const partner = await mintIdToken({ firmId: a, role: "partner", clearanceLevel: "privileged-restricted" })
    uids.push(partner.uid)
    const route = { now: () => T + 31 * MIN }
    expect((await viaApi<{ items: unknown[] }>("listAlerts", route)({ token: partner.token, data: { firmId: a } } as never)).items).toEqual([])
    await expect(viaApi("acknowledgeAlert", route)({ token: partner.token, data: { firmId: a, alertId: alert.id } } as never)).rejects.toMatchObject({ status: 404, code: "not_found" })
    const op = await operator()
    alertOpsTestSeam.now = () => T + 31 * MIN
    await viaApi("operatorAlertAction")({ token: op.token, data: { alertId: alert.id, action: "acknowledge" } } as never)
    expect(await alertDoc(alert.id)).toMatchObject({ state: "acknowledged", acknowledgedBy: { uid: op.uid, role: "operator" } })
    // While the switch stays on, the acknowledgment holds (spec R23): a refused call hours later writes nothing.
    expect((await callP1(req(b), { now: () => T + 10 * HOUR })).blockReason).toBe("kill_switch_platform")
    expect(await alertDoc(alert.id)).toMatchObject({ state: "acknowledged", episode: 1, count: 1 })
    await deletePlatformAlerts()
  })
})
