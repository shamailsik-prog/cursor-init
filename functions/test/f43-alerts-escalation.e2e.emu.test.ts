import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { decide } from "@/platform/p5/permissionDecision"
import { adminDb } from "../src/admin"
import type { AlertSpec } from "../src/alerts/model"
import { raiseAlert } from "../src/alerts/raise"
import { jobRuntime } from "../src/p2/dispatch"
import { ApiError, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { deleteFirmData } from "./firmCleanup"
import { FakeClock, diagSpec, enqueueAt, readJob, sweepOrigins, testDeps } from "./jobs"

/**
 * Audit F43 (HIGH, 2026-10-13): acknowledgment and escalation, end to end over the Firestore and Auth emulators. The
 * alert comes from a real dead letter (the real worker), the escalator runs its real core on a fake clock, and every
 * acknowledgment goes through the real HTTP router (P5 auth, the shared decision table, idempotency, one audit row).
 *
 * The ladder is operator (level 0), partner (level 1), firm administrator (level 2: the founding partner recorded by
 * onboardFirm in `platform_onboarding/{uid}`). A high alert waits 30 minutes for acknowledgment, then each step raises
 * the severity (critical: 15 minutes). On main there is no alert, no acknowledgment route and no escalator.
 *
 * Clock origins are eight hundred years before the other P2 suites' (`sweepOrigins(800)`), so the escalator's queries
 * (open alerts past their deadline, pages created by now) see only this file's documents.
 */

const nextOrigin = sweepOrigins(800)
const MIN = 60_000
/**
 * Hook timeouts. Cleanup scans every collection of the shared emulator, and setup mints five Auth-emulator users (on a
 * cold emulator the first round trips are slow); under load either can exceed the 10 s hook default.
 */
const CLEANUP_TIMEOUT_MS = 120_000
const SETUP_TIMEOUT_MS = 60_000
/** Each test drives several authenticated HTTP calls and escalator runs; on a cold or loaded emulator 15 s is too tight. */
const E2E_TIMEOUT_MS = 60_000

type OpsModule = { alertOpsTestSeam: { now?: () => number } }
const OPS = ["..", "src", "alerts", "ops"].join("/")
/** The operator route's clock (a firmless route gets no router clock): this file's fake clock while a test runs. */
async function useOperatorClock(clock: FakeClock): Promise<void> {
  ;((await import(/* @vite-ignore */ OPS)) as OpsModule).alertOpsTestSeam.now = () => clock.now()
}

type Notification = { id: string; alertId: string; firmId: string; level: number; episode: number; ownerRole: string; severity: string; targets: unknown[] }
type EscalatorModule = {
  runAlertEscalator: (o: { now: () => number; notifier: { deliver: (n: Notification) => Promise<void> } }) => Promise<{ escalated: string[]; delivered: string[] }>
}
const ESCALATOR = ["..", "src", "alerts", "escalator"].join("/")
const escalatorModule = async (): Promise<EscalatorModule> => (await import(/* @vite-ignore */ ESCALATOR)) as EscalatorModule

type Alert = DocumentData & { id: string }
const alertsOf = async (firmId: string): Promise<Alert[]> =>
  (await adminDb().collection("ops_alerts").where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const alertDoc = async (id: string): Promise<Alert> => ({ id, ...(await adminDb().collection("ops_alerts").doc(id).get()).data() })
const pagesOf = async (alertId: string): Promise<Alert[]> =>
  (await adminDb().collection("ops_alert_notifications").where("alertId", "==", alertId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const userNotes = async (alertId: string): Promise<Alert[]> =>
  (await adminDb().collection("notifications").where("alertId", "==", alertId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const millis = (t: unknown) => (t instanceof Timestamp ? t.toMillis() : null)
const sortTargets = (t: unknown[]) => [...(t as Array<{ kind: string; uid?: string }>)].sort((a, b) => `${a.kind}${a.uid ?? ""}`.localeCompare(`${b.kind}${b.uid ?? ""}`))
const apiError = async (p: Promise<unknown>): Promise<[number, string]> => {
  try {
    await p
  } catch (err) {
    if (err instanceof ApiError) return [err.status, err.code]
    throw err
  }
  throw new Error("expected an ApiError, the call succeeded")
}

type Member = { uid: string; token: string }

describe.skipIf(!EMULATORS)("audit F43: acknowledgment and escalation (e2e)", () => {
  let T0: number
  let clock: FakeClock
  let firmId: string
  let otherFirmId: string
  let founder: Member
  let partner2: Member
  let associate: Member
  let operator: Member
  let otherPartner: Member
  let notifier: { deliver: (n: Notification) => Promise<void> }
  let delivered: Notification[]
  const uids: string[] = []
  const route = () => ({ now: () => clock.now() })

  beforeEach(async () => {
    T0 = nextOrigin()
    clock = new FakeClock(T0)
    firmId = uniq("firm")
    otherFirmId = uniq("firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "Alert Firm", plan: "internal" })
    await adminDb().collection("firms").doc(otherFirmId).set({ name: "Other Firm", plan: "internal" })
    const member = async (fid: string, role: string): Promise<Member> => {
      const m = await mintIdToken({ firmId: fid, role, clearanceLevel: "privileged-restricted" })
      uids.push(m.uid)
      return m
    }
    founder = await member(firmId, "partner")
    partner2 = await member(firmId, "partner")
    associate = await member(firmId, "associate")
    otherPartner = await member(otherFirmId, "partner")
    // onboardFirm's FN-1 record: who onboarded (and so administers) the firm.
    await adminDb().collection("platform_onboarding").doc(founder.uid).set({ firmId, at: Timestamp.fromMillis(T0) })
    operator = await mintIdToken({ platformAdmin: true })
    uids.push(operator.uid)
    delivered = []
    notifier = { deliver: async (n) => void delivered.push(n) }
  }, SETUP_TIMEOUT_MS)

  afterEach(async () => {
    delete jobRuntime.deps
    await import(/* @vite-ignore */ OPS).then(
      (m: OpsModule) => delete m.alertOpsTestSeam.now,
      () => undefined
    )
    // Job rows first, with one targeted query: rows dated centuries back must not outlive the test (other suites' sweeps).
    const jobs = await adminDb().collection("jobs").where("firmId", "==", firmId).select().get()
    if (jobs.size > 0) {
      const batch = adminDb().batch()
      for (const d of jobs.docs) batch.delete(d.ref)
      await batch.commit()
    }
    await deleteFirmData([firmId, otherFirmId], uids.splice(0))
  }, CLEANUP_TIMEOUT_MS)

  /** A real dead letter at `at`: a diagnostic job whose handler fails permanently, through the real worker. */
  async function deadLetter(at = T0): Promise<{ alert: Alert; jobId: string }> {
    const d = testDeps(clock)
    const { jobId } = await enqueueAt(diagSpec(firmId, { behaviour: "permanent" }, { createdBy: founder.uid }), at)
    expect(await d.dispatcher.deliver({ jobId, seq: 0 }, at)).toBe("dead_lettered")
    const alerts = (await alertsOf(firmId)).filter((a) => a.subjectKey === `job:${jobId}`)
    expect(alerts).toHaveLength(1)
    return { alert: alerts[0], jobId }
  }

  // Eight escalator runs (two concurrent) and their reads: 14 s measured on a cold emulator.
  it("a missed deadline escalates exactly once per step: operator, then the firm's partners, then the founding partner, who is then re-paged each critical window (R1-005)", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { alert } = await deadLetter()
    expect(alert).toMatchObject({ level: 0, ownerRole: "operator", severity: "high", state: "open" })
    expect(millis(alert.escalateAt)).toBe(T0 + 30 * MIN)
    const { runAlertEscalator } = await escalatorModule()
    const run = (ms: number) => runAlertEscalator({ now: () => ms, notifier })

    // Before the deadline: nothing escalates; the raise's level-0 page is delivered (once).
    const r0 = await run(T0 + 30 * MIN - 1)
    expect(r0.escalated).toEqual([])
    expect(r0.delivered).toEqual([`${alert.id}_e1_l0`])

    // At the deadline, two escalators at once: one step, not two (the fenced re-read).
    const [ra, rb] = await Promise.all([run(T0 + 30 * MIN), run(T0 + 30 * MIN)])
    expect([...ra.escalated, ...rb.escalated]).toEqual([alert.id])
    const l1 = await alertDoc(alert.id)
    expect(l1).toMatchObject({ level: 1, ownerRole: "partner", severity: "critical", state: "open" })
    expect(millis(l1.escalateAt)).toBe(T0 + 45 * MIN)
    expect(l1.escalations.map((e: DocumentData) => [e.level, e.ownerRole, e.severity, millis(e.at)])).toEqual([[1, "partner", "critical", T0 + 30 * MIN]])
    // The firm's partners are told (not the associate, not another firm).
    const notes1 = (await userNotes(alert.id)).filter((n) => n.level === 1)
    expect(notes1.map((n) => n.userId).sort()).toEqual([founder.uid, partner2.uid].sort())
    expect(notes1.every((n) => n.firmId === firmId && n.kind === "ops_alert" && n.read === false && n.readAt === null && n.severity === "critical")).toBe(true)
    // A rerun at the same instant does nothing more.
    expect((await run(T0 + 30 * MIN)).escalated).toEqual([])

    // Fifteen minutes later (critical window): the founding partner, as firm administrator; then the ladder is spent.
    expect((await run(T0 + 45 * MIN)).escalated).toEqual([alert.id])
    const l2 = await alertDoc(alert.id)
    // FA-F43-R1-005 (spec R21): the last level keeps a deadline of one critical window, for its re-page.
    expect(l2).toMatchObject({ level: 2, ownerRole: "firm_admin", severity: "critical", state: "open" })
    expect(millis(l2.escalateAt)).toBe(T0 + 60 * MIN)
    expect((await userNotes(alert.id)).filter((n) => n.level === 2).map((n) => n.userId)).toEqual([founder.uid])
    // Hours later there is no level to step to: the escalator re-pages level 2 once, and records no further step.
    expect((await run(T0 + 10 * 60 * MIN)).escalated).toEqual([])
    expect((await alertDoc(alert.id)).escalations).toHaveLength(2)

    // Every page went to the notifier exactly once, in order, each naming its targets.
    expect(delivered.map((n) => [n.id, n.level, n.ownerRole])).toEqual([
      [`${alert.id}_e1_l0`, 0, "operator"],
      [`${alert.id}_e1_l1`, 1, "partner"],
      [`${alert.id}_e1_l2`, 2, "firm_admin"],
      [`${alert.id}_e1_l2_r1`, 2, "firm_admin"],
    ])
    expect(sortTargets(delivered[1].targets)).toEqual(sortTargets([{ kind: "oncall" }, { kind: "user", uid: founder.uid }, { kind: "user", uid: partner2.uid }]))
    expect(sortTargets(delivered[2].targets)).toEqual(sortTargets([{ kind: "oncall" }, { kind: "user", uid: founder.uid }]))
    expect((await pagesOf(alert.id)).map((p) => [p.id, p.status])).toEqual([
      [`${alert.id}_e1_l0`, "delivered"],
      [`${alert.id}_e1_l1`, "delivered"],
      [`${alert.id}_e1_l2`, "delivered"],
      [`${alert.id}_e1_l2_r1`, "delivered"],
    ])
  })

  it("a page whose delivery fails stays pending and the next run delivers it", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { alert } = await deadLetter()
    const { runAlertEscalator } = await escalatorModule()
    let fail = true
    const flaky = { deliver: async (n: Notification) => (fail ? Promise.reject(new Error("channel down")) : void delivered.push(n)) }
    expect((await runAlertEscalator({ now: () => T0 + MIN, notifier: flaky })).delivered).toEqual([])
    expect((await pagesOf(alert.id)).map((p) => p.status)).toEqual(["pending"])
    fail = false
    expect((await runAlertEscalator({ now: () => T0 + 2 * MIN, notifier: flaky })).delivered).toEqual([`${alert.id}_e1_l0`])
    expect((await runAlertEscalator({ now: () => T0 + 3 * MIN, notifier: flaky })).delivered).toEqual([])
  })

  it("a page another run has claimed is not delivered twice; a claim that lapsed (its run died) is delivered again", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { alert } = await deadLetter()
    const pageId = `${alert.id}_e1_l0`
    const { runAlertEscalator } = await escalatorModule()
    // The first delivery holds its claim until released, so the second run meets the page while it is claimed.
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const holding = {
      deliver: async (n: Notification) => {
        delivered.push(n)
        if (delivered.length === 1) await gate
      },
    }
    const first = runAlertEscalator({ now: () => T0 + MIN, notifier: holding })
    for (let i = 0; i < 200 && (await pagesOf(alert.id))[0]?.status !== "sending"; i++) await new Promise((r) => setTimeout(r, 25))
    expect((await pagesOf(alert.id))[0]?.status).toBe("sending")
    const second = await runAlertEscalator({ now: () => T0 + MIN, notifier: holding })
    release()
    expect([(await first).delivered, second.delivered]).toEqual([[pageId], []])
    expect(delivered.map((n) => n.id)).toEqual([pageId])

    // A run that claimed the page and died: once its claim lapses (2 minutes), the next run delivers it again.
    await adminDb().collection("ops_alert_notifications").doc(pageId).update({ status: "sending", claimedUntil: Timestamp.fromMillis(T0 + 3 * MIN) })
    expect((await runAlertEscalator({ now: () => T0 + 3 * MIN - 1, notifier })).delivered).toEqual([])
    expect((await runAlertEscalator({ now: () => T0 + 3 * MIN, notifier })).delivered).toEqual([pageId])
    expect(delivered.map((n) => n.id)).toEqual([pageId, pageId])
  })

  it("the operator acknowledges at level 0: escalation stops, the action is recorded and audited", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { alert } = await deadLetter()
    clock.set(T0 + MIN)
    await useOperatorClock(clock)
    const view = await viaApi<Record<string, unknown>>("operatorAlertAction", route())({ token: operator.token, data: { alertId: alert.id, action: "acknowledge" } } as never)
    expect(view).toMatchObject({ alertId: alert.id, state: "acknowledged", level: 0, escalateAt: null, acknowledgedBy: { uid: operator.uid, role: "operator" } })
    const stored = await alertDoc(alert.id)
    expect([stored.state, millis(stored.acknowledgedAt), stored.escalateAt]).toEqual(["acknowledged", T0 + MIN, null])
    expect(stored.actions.map((a: DocumentData) => [a.action, a.by, a.role, a.level, millis(a.at)])).toEqual([["acknowledge", operator.uid, "operator", 0, T0 + MIN]])
    const audit = (await adminDb().collection("audit_log").where("target", "==", `ops_alerts/${alert.id}`).get()).docs.map((d) => d.data())
    expect(audit.map((a) => [a.actorId, a.decision])).toEqual([[operator.uid, "allow"]])

    const { runAlertEscalator } = await escalatorModule()
    expect((await runAlertEscalator({ now: () => T0 + 10 * 60 * MIN, notifier })).escalated).toEqual([])
    expect(await alertDoc(alert.id)).toMatchObject({ level: 0, state: "acknowledged" })
  })

  it("the owning role: a partner may not act at level 0, may once it reaches the partners; an associate, another firm and a non-operator are refused", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { alert } = await deadLetter()
    const ack = viaApi("acknowledgeAlert", route())
    const list = viaApi<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>("listAlerts", route())
    // The partner worklist shows the alert from the start.
    const worklist = await list({ token: founder.token, data: { firmId } } as never)
    expect(worklist.items.map((i) => [i.alertId, i.condition, i.level, i.state])).toEqual([[alert.id, "job.dead_lettered", 0, "open"]])
    expect(await apiError(list({ token: associate.token, data: { firmId } } as never))).toEqual([403, "role_not_permitted"])
    expect((await list({ token: otherPartner.token, data: { firmId: otherFirmId } } as never)).items).toEqual([])

    expect(await apiError(ack({ token: founder.token, data: { firmId, alertId: alert.id } } as never))).toEqual([403, "alert_not_owner"])
    expect(await apiError(ack({ token: associate.token, data: { firmId, alertId: alert.id } } as never))).toEqual([403, "role_not_permitted"])
    expect(await apiError(ack({ token: otherPartner.token, data: { firmId: otherFirmId, alertId: alert.id } } as never))).toEqual([404, "not_found"])
    expect(await apiError(viaApi("operatorAlertAction", route())({ token: founder.token, data: { alertId: alert.id, action: "acknowledge" } } as never))).toEqual([403, "platform_admin_only"])
    expect(await alertDoc(alert.id)).toMatchObject({ state: "open", level: 0 })

    const { runAlertEscalator } = await escalatorModule()
    await runAlertEscalator({ now: () => T0 + 30 * MIN, notifier })
    clock.set(T0 + 31 * MIN)
    const view = await ack({ token: partner2.token, data: { firmId, alertId: alert.id } } as never)
    expect(view).toMatchObject({ state: "acknowledged", level: 1, acknowledgedBy: { uid: partner2.uid, role: "partner" } })
    expect(await apiError(ack({ token: founder.token, data: { firmId, alertId: alert.id } } as never))).toEqual([409, "alert_already_acknowledged"])
    expect((await runAlertEscalator({ now: () => T0 + 10 * 60 * MIN, notifier })).escalated).toEqual([])
    expect(await alertDoc(alert.id)).toMatchObject({ level: 1, state: "acknowledged" })
  })

  it("resolve closes the alert; a recurrence reopens it as a new episode at level 0 with a fresh page", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { alert, jobId } = await deadLetter()
    const { runAlertEscalator } = await escalatorModule()
    await runAlertEscalator({ now: () => T0 + 30 * MIN, notifier })
    clock.set(T0 + 40 * MIN)
    const resolve = viaApi<Record<string, unknown>>("resolveAlert", route())
    const view = await resolve({ token: founder.token, data: { firmId, alertId: alert.id } } as never)
    expect(view).toMatchObject({ state: "resolved", escalateAt: null, resolvedBy: { uid: founder.uid, role: "partner" } })
    expect(await apiError(resolve({ token: partner2.token, data: { firmId, alertId: alert.id } } as never))).toEqual([409, "alert_resolved"])
    expect(await apiError(viaApi("acknowledgeAlert", route())({ token: partner2.token, data: { firmId, alertId: alert.id } } as never))).toEqual([409, "alert_resolved"])
    expect((await runAlertEscalator({ now: () => T0 + 10 * 60 * MIN, notifier })).escalated).toEqual([])
    const closed = await viaApi<{ items: Array<Record<string, unknown>> }>("listAlerts", route())({ token: founder.token, data: { firmId, state: "open" } } as never)
    expect(closed.items).toEqual([])

    // The same job dead-letters again after a partner's retry: the alert reopens.
    const d = testDeps(clock)
    jobRuntime.deps = d
    clock.set(T0 + 50 * MIN)
    await viaApi("retryFailedJob", route())({ token: founder.token, data: { firmId, jobId, note: "Requeued after the cause was fixed." } } as never)
    expect(await d.dispatcher.deliver({ jobId, seq: (await readJob(jobId)).dispatchSeq }, T0 + 50 * MIN)).toBe("dead_lettered")
    const reopened = await alertDoc(alert.id)
    expect(reopened).toMatchObject({ state: "open", episode: 2, level: 0, ownerRole: "operator", severity: "high", count: 1, totalCount: 2, acknowledgedAt: null, resolvedAt: null, escalations: [] })
    expect([millis(reopened.firstSeenAt), millis(reopened.escalateAt)]).toEqual([T0 + 50 * MIN, T0 + 80 * MIN])
    expect((await pagesOf(alert.id)).map((p) => p.id).sort()).toEqual([`${alert.id}_e1_l0`, `${alert.id}_e1_l1`, `${alert.id}_e2_l0`])
  })

  it("the worklist pages newest first and filters by state", { timeout: E2E_TIMEOUT_MS }, async () => {
    const first = (await deadLetter(T0)).alert
    const second = (await deadLetter(T0 + MIN)).alert
    const list = viaApi<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>("listAlerts", route())
    const p1 = await list({ token: founder.token, data: { firmId, limit: "1" } } as never)
    expect(p1.items.map((i) => i.alertId)).toEqual([second.id])
    expect(p1.nextCursor).not.toBeNull()
    const p2 = await list({ token: founder.token, data: { firmId, limit: "1", cursor: p1.nextCursor } } as never)
    expect([p2.items.map((i) => i.alertId), p2.nextCursor]).toEqual([[first.id], null])
    expect(await apiError(list({ token: founder.token, data: { firmId, state: "closed" } } as never))).toEqual([400, "invalid_query"])
    // A view carries references, codes and counts, never a job payload.
    expect(Object.keys(p2.items[0]).sort()).toEqual(
      ["acknowledgedAt", "acknowledgedBy", "alertId", "condition", "count", "detail", "episode", "escalateAt", "firstSeenAt", "lastSeenAt", "level", "ownerRole", "ref", "resolvedAt", "resolvedBy", "severity", "state", "subjectKey", "totalCount"].sort()
    )
  })

  // FA-F43-R1-003: the auditor's probes PROBE-06, 08 and 09, kept as regression tests for code that was already right.

  /** A stall alert of this file's firm (high), raised directly: the raise path is the one the sweeper uses. */
  const stall = (subject = "jobType:platform.diagnostic"): AlertSpec => ({ condition: "job.dispatch_stalled", firmId, subjectKey: subject, ref: null, severity: "high", detail: { jobs: 1 } })

  it("a raise racing the escalator keeps its count, the step and the raised severity; a reopen is not stepped by the old deadline (PROBE-06)", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { id } = await raiseAlert(stall(), T0)
    const { runAlertEscalator } = await escalatorModule()
    await Promise.all([raiseAlert(stall(), T0 + 30 * MIN), runAlertEscalator({ now: () => T0 + 30 * MIN, notifier }), raiseAlert(stall(), T0 + 30 * MIN)])
    const raced = await alertDoc(id)
    expect([raced.count, raced.totalCount, raced.level, raced.severity, raced.state]).toEqual([3, 3, 1, "critical", "open"])
    // A raise after the step counts it and never lowers the escalated severity (the raise itself is high).
    await raiseAlert(stall(), T0 + 31 * MIN)
    expect(await alertDoc(id)).toMatchObject({ count: 4, level: 1, severity: "critical" })

    // Resolved, then a reopen and an escalator run concurrently, after the old deadline and before the new one.
    clock.set(T0 + 50 * MIN)
    await useOperatorClock(clock)
    await viaApi("operatorAlertAction", route())({ token: operator.token, data: { alertId: id, action: "resolve" } } as never)
    await Promise.all([raiseAlert(stall(), T0 + 50 * MIN), runAlertEscalator({ now: () => T0 + 50 * MIN, notifier })])
    const reopened = await alertDoc(id)
    expect([reopened.state, reopened.episode, reopened.level, reopened.count, millis(reopened.escalateAt)]).toEqual(["open", 2, 0, 1, T0 + 80 * MIN])
  })

  it("every role but an active partner of the firm is refused on both firm routes, and only a boolean platformAdmin claim reaches the operator route (PROBE-08)", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { id } = await raiseAlert(stall(), T0)
    const { runAlertEscalator } = await escalatorModule()
    await runAlertEscalator({ now: () => T0 + 30 * MIN, notifier }) // level 1: the partners' rung
    clock.set(T0 + 31 * MIN)
    const outcome: Record<string, unknown> = {}
    const attempt = async (key: string, p: Promise<unknown>) => {
      try {
        await p
        outcome[key] = "ok"
      } catch (err) {
        outcome[key] = err instanceof ApiError ? [err.status, err.code] : String(err)
      }
    }
    const member = async (role: string) => {
      const m = await mintIdToken({ firmId, role, clearanceLevel: "privileged-restricted" })
      uids.push(m.uid)
      return m
    }
    for (const role of ["associate", "clerk", "intern", "client", "accounts"]) {
      const m = await member(role)
      await attempt(`${role}.list`, viaApi("listAlerts", route())({ token: m.token, data: { firmId } } as never))
      await attempt(`${role}.ack`, viaApi("acknowledgeAlert", route())({ token: m.token, data: { firmId, alertId: id } } as never))
      await attempt(`${role}.resolve`, viaApi("resolveAlert", route())({ token: m.token, data: { firmId, alertId: id } } as never))
    }
    const inactive = await member("partner")
    await adminDb().collection("users").doc(inactive.uid).update({ active: false })
    await attempt("inactivePartner.list", viaApi("listAlerts", route())({ token: inactive.token, data: { firmId } } as never))
    await attempt("inactivePartner.ack", viaApi("acknowledgeAlert", route())({ token: inactive.token, data: { firmId, alertId: id } } as never))
    const demoted = await member("partner")
    await adminDb().collection("users").doc(demoted.uid).update({ role: "associate" })
    await attempt("demotedPartner.list", viaApi("listAlerts", route())({ token: demoted.token, data: { firmId } } as never))
    await attempt("demotedPartner.ack", viaApi("acknowledgeAlert", route())({ token: demoted.token, data: { firmId, alertId: id } } as never))
    await useOperatorClock(clock)
    const adminString = await mintIdToken({ platformAdmin: "true" })
    uids.push(adminString.uid)
    await attempt("platformAdminString.op", viaApi("operatorAlertAction", route())({ token: adminString.token, data: { alertId: id, action: "acknowledge" } } as never))
    const noClaims = await mintIdToken(null)
    uids.push(noClaims.uid)
    await attempt("noClaims.op", viaApi("operatorAlertAction", route())({ token: noClaims.token, data: { alertId: id, action: "acknowledge" } } as never))
    expect(Object.entries(outcome).filter(([, v]) => v === "ok")).toEqual([])
    expect(outcome["platformAdminString.op"]).toEqual([403, "platform_admin_only"])
    expect(await alertDoc(id)).toMatchObject({ state: "open", actions: [] })

    // The shared decision table: alert.read and alert.ack allow the partner only, scoped or not.
    const allowed: string[] = []
    for (const role of ["partner", "associate", "clerk", "intern", "client", "accounts", "unknown"]) {
      for (const action of ["alert.read", "alert.ack"]) {
        if (decide({ role, firmId, clearanceLevel: "privileged-restricted" }, action, undefined, false).allow) allowed.push(`${role}.${action}`)
        if (decide({ role, firmId, clearanceLevel: "privileged-restricted" }, action, undefined, false, { scope: "own_matters" }).allow) allowed.push(`${role}.${action}.scoped`)
      }
    }
    expect(allowed.filter((k) => !k.startsWith("partner."))).toEqual([])
    expect(allowed.filter((k) => !k.endsWith(".scoped"))).toEqual(["partner.alert.read", "partner.alert.ack"])
  })

  it("the ladder's targets: only the firm's active partners at level 1; level 2 falls back to them when the founder left the firm; never another firm's user (PROBE-09)", { timeout: E2E_TIMEOUT_MS }, async () => {
    const active = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
    uids.push(active.uid)
    // partner2 is deactivated; the founder moves to the other firm; planted onboarding rows point this firm at the
    // other firm's partner and at a user that does not exist.
    await adminDb().collection("users").doc(partner2.uid).update({ active: false })
    await adminDb().collection("users").doc(founder.uid).update({ firmId: otherFirmId })
    await adminDb().collection("platform_onboarding").doc(otherPartner.uid).set({ firmId })
    await adminDb().collection("platform_onboarding").doc(`ghost-${uniq("u")}`).set({ firmId })
    const { id } = await raiseAlert(stall(), T0)
    const { runAlertEscalator } = await escalatorModule()
    await runAlertEscalator({ now: () => T0 + 30 * MIN, notifier })
    await runAlertEscalator({ now: () => T0 + 45 * MIN, notifier })
    const notes = (await userNotes(id)).map((n) => [n.level, n.userId, n.firmId])
    expect(notes.sort()).toEqual(
      [
        [1, active.uid, firmId],
        [2, active.uid, firmId],
      ].sort()
    )
    const pages = await pagesOf(id)
    expect(pages.filter((p) => p.level === 2).map((p) => p.fallback)).toEqual(["partners"])
    expect(pages.filter((p) => p.level === 1).map((p) => p.fallback)).toEqual([null])
  })
})
