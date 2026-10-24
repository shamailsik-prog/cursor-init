import { describe, expect, it } from "vitest"
import { decide } from "@/platform/p5/permissionDecision"

/**
 * Audit F43 (HIGH, 2026-10-13), the pure pieces: the alert document id (one per condition and subject), the owner
 * ladder and its order, the acknowledgment windows, the severity steps, the thresholds, the `detail` guard (codes,
 * ids and integers only: no restricted text), and the two P5 table rows the acknowledgment routes authorise with.
 *
 * The alert modules are loaded through a computed specifier, so this file also loads on a tree without them (main),
 * where the decision-table cases still run and fail on behaviour.
 */

type Model = typeof import("../src/alerts/model")
const MODEL = ["..", "src", "alerts", "model"].join("/")
const model = async (): Promise<Model> => (await import(/* @vite-ignore */ MODEL)) as Model

const caller = (role: string) => ({ role, firmId: "firm-a", clearanceLevel: "privileged-restricted" as const })

describe("audit F43: the alert model", () => {
  it("the alert id is one per condition, firm and subject: stable, and different when any of the three differs", async () => {
    const { alertIdFor } = await model()
    const id = alertIdFor("job.dead_lettered", "firm-a", "job:j1")
    expect(id).toMatch(/^a[0-9a-f]{40}$/)
    expect(alertIdFor("job.dead_lettered", "firm-a", "job:j1")).toBe(id)
    expect(new Set([id, alertIdFor("job.dead_lettered", "firm-a", "job:j2"), alertIdFor("job.commit_failed", "firm-a", "job:j1"), alertIdFor("job.dead_lettered", "firm-b", "job:j1")]).size).toBe(4)
    // The separator cannot be forged by a crafted subject: ("a", "b\0c") and ("a\0b", "c") differ.
    expect(alertIdFor("x", "a", "b\0c")).not.toBe(alertIdFor("x", "a\0b", "c"))
  })

  it("the owner ladder is operator, then partner, then firm administrator", async () => {
    const { OWNER_LADDER } = await model()
    expect(OWNER_LADDER).toEqual(["operator", "partner", "firm_admin"])
  })

  it("acknowledgment windows: critical 15 min, high 30 min, warning 4 h; severity steps up one at a time and stops at critical", async () => {
    const { ACK_WINDOW_MS, SEVERITIES, raiseSeverity, maxSeverity } = await model()
    expect(SEVERITIES).toEqual(["warning", "high", "critical"])
    expect(ACK_WINDOW_MS).toEqual({ critical: 15 * 60_000, high: 30 * 60_000, warning: 4 * 3_600_000 })
    expect([raiseSeverity("warning"), raiseSeverity("high"), raiseSeverity("critical")]).toEqual(["high", "critical", "critical"])
    expect([maxSeverity("warning", "high"), maxSeverity("critical", "high"), maxSeverity("high", "high")]).toEqual(["high", "critical", "high"])
  })

  it("thresholds: three sweeper re-dispatches, 15 min of waiting, a 60 min saga, 10 min past a reservation's lease", async () => {
    const m = await model()
    expect(m.DISPATCH_STALL_REDISPATCHES).toBe(3)
    expect(m.JOB_WAIT_ALERT_MS).toBe(15 * 60_000)
    expect(m.SAGA_AGE_ALERT_MS).toBe(60 * 60_000)
    expect(m.RESERVATION_UNRESOLVED_ALERT_MS).toBe(10 * 60_000)
  })

  it("R1 rulings: an acknowledgment holds 4 h; kill-switch alerts never escalate; the platform subject; re-page ids", async () => {
    const m = await model()
    // Spec R18 (FA-F43-R1-002): a raise 4 h or more after the acknowledgment opens a new episode.
    expect(m.ACK_HOLD_MS).toBe(4 * 3_600_000)
    // Spec R23: a kill switch is a deliberate act; every other condition escalates.
    expect(m.ALERT_CONDITIONS.filter((c) => !m.escalates(c))).toEqual(["ai.kill_switch_blocked"])
    // Spec R24: the platform subject is an id no firm can have (Firestore reserves ids matching __.*__).
    expect(m.PLATFORM_ALERT_FIRM).toBe("__platform__")
    expect(m.PLATFORM_ALERT_FIRM).toMatch(/^__.*__$/)
    // Spec R21: a level's own page keeps its id; each re-page of the last level has its own.
    expect([m.pageIdFor("a1", 2, 1), m.pageIdFor("a1", 2, 2, 0), m.pageIdFor("a1", 2, 2, 3)]).toEqual(["a1_e2_l1", "a1_e2_l2", "a1_e2_l2_r3"])
  })

  it("R1 rulings: the checker's raises get 5 s past the scan budget, and the run still ends 10 s before its timeout", async () => {
    const CHECKER = ["..", "src", "alerts", "checker"].join("/")
    const c = (await import(/* @vite-ignore */ CHECKER)) as Record<string, unknown>
    expect([c.CHECKER_BUDGET_MS, c.CHECK_RAISE_GRACE_MS]).toEqual([40_000, 5_000])
    expect(c.CHECK_PASSES).toEqual(["jobs", "sagas", "reservations"])
  })

  it("detail carries codes, ids and integers only: free text, nested values, non-integers and long strings are refused", async () => {
    const { assertSafeDetail } = await model()
    expect(() => assertSafeDetail({ jobType: "platform.diagnostic", code: "diag_failure", attempts: 4, ref: "jobs/j1:x" })).not.toThrow()
    expect(() => assertSafeDetail({})).not.toThrow()
    for (const bad of [
      { note: "Muhammad Ali v. State" },
      { code: "two words" },
      { nested: { a: 1 } },
      { list: ["a"] },
      { ratio: 0.5 },
      { big: Number.MAX_SAFE_INTEGER + 2 },
      { long: "x".repeat(129) },
      { empty: "" },
      { flag: true },
    ]) {
      expect(() => assertSafeDetail(bad as Record<string, unknown>), JSON.stringify(bad)).toThrow()
    }
    expect(() => assertSafeDetail(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i])))).toThrow()
  })
})

describe("audit F43: the P5 table rows for the alert routes (fail closed)", () => {
  it("alert.read and alert.ack are partner only; every other role is refused", () => {
    for (const action of ["alert.read", "alert.ack"]) {
      expect([action, decide(caller("partner"), action, undefined, false)]).toEqual([action, { allow: true, reason: "ok" }])
      for (const role of ["associate", "clerk", "intern"]) {
        expect([action, role, decide(caller(role), action, undefined, false)]).toEqual([action, role, { allow: false, reason: "role-not-permitted" }])
      }
      expect([action, decide(caller("client"), action, undefined, false)]).toEqual([action, { allow: false, reason: "client-denied" }])
      expect([action, decide(caller("partner"), action, undefined, false, { scope: "own_matters" })]).toEqual([action, { allow: false, reason: "client-denied" }])
      expect([action, decide(caller("accounts"), action, undefined, false)]).toEqual([action, { allow: false, reason: "accounts-register-only" }])
      expect([action, decide(null, action, undefined, false)]).toEqual([action, { allow: false, reason: "no-user" }])
    }
  })
})
