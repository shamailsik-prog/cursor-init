import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { firmConfigRef, monthRef, platformConfigRef } from "../src/p1/config"
import { costMicroUsd } from "../src/p1/costTable"
import { RESERVATION_LEASE_MS, callP1, p1TestSeam, type P1Request } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { setP1TransportForTests } from "../src/p1/transport"
import { EMULATORS, uniq } from "./emu"
import { deleteFirmData } from "./firmCleanup"

/**
 * Audit F43 (HIGH, 2026-10-13), the P1 routes, end to end through the real `callP1` with a stub Gateway transport over
 * the Firestore emulator. On main a failed reservation or attempt record is a WARN line (`p1.reservation_failed`,
 * `p1.attempt_record_failed`), a budget crossing writes `ai_budget_alerts` and a WARN line (`p1.budget_threshold`)
 * that no policy matches, a kill-switch block writes its usage row only, and a failed settlement leaves a held
 * reservation that nothing tracks. The correction: an `ops_alerts` document for each, written in the commit
 * transaction of the call that observed it, and `ai.reservation_unresolved` derived by the checker.
 *
 * The clock is 2001 (PKT month 2001-03): far before every other P1 suite's, so the checker's reservation pass sees
 * only this file's reservations; each test deletes its firm's documents afterwards.
 */

const T = Date.parse("2001-03-10T10:00:00.000Z")
const MONTH = "2001-03"
const OPUS = "anthropic/claude-opus-5.5"
const BUDGET = 1_000_000_000
/** The stub reply's charge: 1,000 tokens in, 500 out. */
const REPLY_COST = costMicroUsd(OPUS, 1000, 500)!
/** Cleanup scans every collection of the shared emulator; under load that can exceed the 10 s hook default. */
const CLEANUP_TIMEOUT_MS = 120_000

const CHECKER = ["..", "src", "alerts", "checker"].join("/")
type CheckerModule = { runAlertChecker: (o: { now: () => number; passes?: string[] }) => Promise<{ raised: string[] }> }
const checker = async (): Promise<CheckerModule> => (await import(/* @vite-ignore */ CHECKER)) as CheckerModule

type Alert = DocumentData & { id: string }
const alertsOf = async (firmId: string): Promise<Alert[]> =>
  (await adminDb().collection("ops_alerts").where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const pagesOf = async (alertId: string): Promise<Alert[]> =>
  (await adminDb().collection("ops_alert_notifications").where("alertId", "==", alertId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
const millis = (t: unknown) => (t instanceof Timestamp ? t.toMillis() : null)
const at = (ms: number) => ({ now: () => ms })

const req = (firmId: string): P1Request => ({
  firmId,
  actorId: "uid-1",
  matterId: "matter-1",
  jobId: null,
  taskType: "committee",
  classification: "internal",
  body: "Draft a reply to the notice.",
  purpose: "committee-brain",
})

function stubTransport(): void {
  setP1TransportForTests({ send: async () => ({ text: "REPLY", inputTokens: 1000, outputTokens: 500 }) })
}

function resetSeam(): void {
  for (const k of Object.keys(p1TestSeam)) delete (p1TestSeam as Record<string, unknown>)[k]
}

/** A non-retryable store error (INVALID_ARGUMENT): the reservation or the attempt record gives up at once. */
const refused = () => Object.assign(new Error("injected store refusal"), { code: 3 })

describe.skipIf(!EMULATORS)("audit F43: P1 faults raise durable alerts (e2e)", () => {
  let firmId: string

  async function seedFirm(cfg: Record<string, unknown> = {}, spentMicroUsd?: number): Promise<void> {
    await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BUDGET, ...cfg })
    if (spentMicroUsd !== undefined) await monthRef(firmId, MONTH).set({ firmId, monthKey: MONTH, spentMicroUsd })
  }

  beforeEach(async () => {
    vi.stubEnv("OPIK_BASE_URL", undefined)
    vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", undefined)
    setProviderConfigForTests(null)
    resetSeam()
    stubTransport()
    firmId = uniq("firm")
    // The checker resumes each query from a cursor in the shared emulator; start this test's runs from the oldest row.
    await adminDb().collection("platform").doc("opsAlertChecker").delete()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    setProviderConfigForTests(null)
    resetSeam()
    await platformConfigRef().delete()
    await deleteFirmData([firmId])
  }, CLEANUP_TIMEOUT_MS)

  it("a failed reservation and a failed attempt record are one ai.reservation_failed alert for the firm, counted, with one page", async () => {
    await seedFirm()
    p1TestSeam.reserveAttemptFailures = [refused()]
    const first = await callP1(req(firmId), at(T))
    expect([first.outcome, first.blockReason]).toEqual(["blocked", "reservation_failed"])
    const [alert, ...more] = await alertsOf(firmId)
    expect(more).toEqual([])
    expect(alert).toMatchObject({
      condition: "ai.reservation_failed",
      subjectKey: `firm:${firmId}`,
      ref: `ai_usage_logs/${first.usageLogId}`,
      state: "open",
      level: 0,
      ownerRole: "operator",
      severity: "high",
      count: 1,
    })
    expect(millis(alert.firstSeenAt)).toBe(T)

    p1TestSeam.attemptMarkFailures = [refused()]
    const second = await callP1(req(firmId), at(T + 1_000))
    expect([second.outcome, second.blockReason]).toEqual(["blocked", "reservation_failed"])
    const after = await alertsOf(firmId)
    expect(after.map((a) => [a.id, a.count, a.ref, millis(a.lastSeenAt)])).toEqual([[alert.id, 2, `ai_usage_logs/${second.usageLogId}`, T + 1_000]])
    expect(await pagesOf(alert.id)).toHaveLength(1)
  })

  it("a settlement that fails leaves spend reserved; the checker raises ai.reservation_unresolved ten minutes past the lease, and counts a quarantined record", async () => {
    await seedFirm()
    p1TestSeam.failCommit = true
    const r = await callP1(req(firmId), at(T))
    expect([r.outcome, r.accounting]).toEqual(["ok", "pending"])
    const lapse = T + RESERVATION_LEASE_MS
    const { runAlertChecker } = await checker()
    await runAlertChecker({ now: () => lapse + 10 * 60_000 - 1, passes: ["reservations"] })
    expect(await alertsOf(firmId)).toEqual([])

    await runAlertChecker({ now: () => lapse + 10 * 60_000, passes: ["reservations"] })
    const [alert, ...more] = await alertsOf(firmId)
    expect(more).toEqual([])
    expect(alert).toMatchObject({ condition: "ai.reservation_unresolved", subjectKey: `firm:${firmId}`, ref: `ai_reservations/${r.usageLogId}`, severity: "high", count: 1 })
    expect(alert.detail).toMatchObject({ unresolved: 1, quarantined: 0, oldestAgeMs: 10 * 60_000 })

    // The reconciler gave up on it (quarantine): still unresolved, now counted as quarantined.
    await adminDb().collection("ai_reservations").doc(r.usageLogId).update({ state: "reconcile_failed" })
    await runAlertChecker({ now: () => lapse + 20 * 60_000, passes: ["reservations"] })
    const later = await alertsOf(firmId)
    expect(later.map((a) => [a.id, a.count, a.detail.unresolved, a.detail.quarantined])).toEqual([[alert.id, 2, 1, 1]])
  })

  it("the 70 and 90 percent crossings each raise one ai.budget_threshold alert (warning, then high) in the call's commit", async () => {
    await seedFirm({}, 0.7 * BUDGET - REPLY_COST / 2)
    const r70 = await callP1(req(firmId), at(T))
    expect(r70.outcome).toBe("ok")
    await monthRef(firmId, MONTH).set({ spentMicroUsd: 0.9 * BUDGET - REPLY_COST / 2 }, { merge: true })
    const r90 = await callP1(req(firmId), at(T + 60_000))
    expect(r90.outcome).toBe("ok")
    const alerts = (await alertsOf(firmId)).sort((a, b) => String(a.subjectKey).localeCompare(String(b.subjectKey)))
    expect(alerts.map((a) => [a.condition, a.subjectKey, a.ref, a.severity, a.state, a.count, millis(a.firstSeenAt)])).toEqual([
      ["ai.budget_threshold", `budget:${MONTH}:70`, `ai_budget_alerts/${firmId}_${MONTH}_70`, "warning", "open", 1, T],
      ["ai.budget_threshold", `budget:${MONTH}:90`, `ai_budget_alerts/${firmId}_${MONTH}_90`, "high", "open", 1, T + 60_000],
    ])
    expect(alerts[0].detail).toMatchObject({ monthKey: MONTH, threshold: 70, budgetMicroUsd: BUDGET })
  })

  it("calls refused by the firm's or the platform's kill switch raise ai.kill_switch_blocked, one alert per switch", async () => {
    await seedFirm({ killSwitch: { disableAll: true, disabledModels: [], reason: "Partner stopped AI for the month." } })
    const a = await callP1(req(firmId), at(T))
    const b = await callP1(req(firmId), at(T + 1_000))
    expect([a.blockReason, b.blockReason]).toEqual(["kill_switch_firm", "kill_switch_firm"])
    await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BUDGET })
    await platformConfigRef().set({ killSwitch: { disableAll: true, disabledModels: [], reason: "Operator stop." } })
    const c = await callP1(req(firmId), at(T + 2_000))
    expect(c.blockReason).toBe("kill_switch_platform")
    const alerts = (await alertsOf(firmId)).sort((x, y) => String(x.subjectKey).localeCompare(String(y.subjectKey)))
    expect(alerts.map((x) => [x.condition, x.subjectKey, x.ref, x.severity, x.count])).toEqual([
      ["ai.kill_switch_blocked", "killSwitch:firm", `ai_config/${firmId}`, "warning", 2],
      ["ai.kill_switch_blocked", "killSwitch:platform", "platform/p1", "warning", 1],
    ])
    // No reason text (a partner's free text) is copied into the alert.
    expect(JSON.stringify(alerts)).not.toContain("Partner stopped")
  })

  it("transaction coupling: a crossing whose commit fails writes no alert; the same crossing that commits writes it", async () => {
    await seedFirm({}, 0.7 * BUDGET - REPLY_COST / 2)
    p1TestSeam.failCommit = true
    const failed = await callP1(req(firmId), at(T))
    expect(failed.accounting).toBe("pending")
    expect(await alertsOf(firmId)).toEqual([])
    expect((await adminDb().collection("ai_budget_alerts").doc(`${firmId}_${MONTH}_70`).get()).exists).toBe(false)

    p1TestSeam.failCommit = false
    const ok = await callP1(req(firmId), at(T + 1_000))
    expect(ok.accounting).toBe("settled")
    expect((await alertsOf(firmId)).map((a) => [a.condition, a.subjectKey])).toEqual([["ai.budget_threshold", `budget:${MONTH}:70`]])
  })
})
