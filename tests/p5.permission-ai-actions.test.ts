import { describe, expect, it } from "vitest"
import { AI_ACTIONS, decide, isAiAction, type DecisionCaller } from "@/platform/p5/permissionDecision"

// P3-70, P3-71, P3-66: the AI actions of the shared decision table.
const ROLES = ["partner", "associate", "clerk", "intern", "accounts", "client"] as const
type Role = (typeof ROLES)[number]

const P: Role[] = ["partner"]
const PAC: Role[] = ["partner", "associate", "clerk"]

const MATRIX: Record<string, Role[]> = { "ai.call": PAC, "ai.usage.read": P, "ai.budget.set": P, "ai.kill_switch.set": P }

const caller = (role: Role): DecisionCaller => ({ role, firmId: "f1", clearanceLevel: "privileged-restricted" })
const matter = { firmId: "f1", classification: "confidential" }

describe("AI permission actions (P3-70, P3-71, P3-66)", () => {
  it("exports the 4 AI actions", () => {
    expect([...AI_ACTIONS].sort()).toEqual(Object.keys(MATRIX).sort())
    expect(isAiAction("ai.call")).toBe(true)
    expect(isAiAction("ai.platform_kill_switch.set")).toBe(false)
    expect(isAiAction("job.read")).toBe(false)
    expect(isAiAction("constructor")).toBe(false)
  })

  it("the role table for the three firm-level actions, 6 roles each", () => {
    for (const action of ["ai.usage.read", "ai.budget.set", "ai.kill_switch.set"]) {
      for (const role of ROLES) {
        expect([action, role, decide(caller(role), action, undefined, false)]).toEqual([
          action,
          role,
          MATRIX[action]!.includes(role)
            ? { allow: true, reason: "ok" }
            : {
                allow: false,
                reason: role === "client" ? "client-denied" : role === "accounts" ? "accounts-register-only" : "role-not-permitted",
              },
        ])
      }
    }
  })

  it("ai.call is matter-level: cross-firm, not-member, clearance, then the role", () => {
    expect(decide(caller("associate"), "ai.call", { firmId: "f2", classification: "internal" }, true)).toEqual({ allow: false, reason: "cross-firm" })
    expect(decide(caller("associate"), "ai.call", null, true)).toEqual({ allow: false, reason: "cross-firm" })
    expect(decide(caller("partner"), "ai.call", matter, false)).toEqual({ allow: false, reason: "not-member" })
    expect(decide({ ...caller("clerk"), clearanceLevel: "internal" }, "ai.call", matter, true)).toEqual({ allow: false, reason: "clearance" })
    expect(decide(caller("partner"), "ai.call", { firmId: "f1", classification: "bogus" }, true)).toEqual({ allow: false, reason: "clearance" })
    for (const role of PAC) expect(decide(caller(role), "ai.call", matter, true)).toEqual({ allow: true, reason: "ok" })
    expect(decide(caller("intern"), "ai.call", matter, true)).toEqual({ allow: false, reason: "role-not-permitted" })
  })

  it("ai.call names no matter: fails closed, even for a partner", () => {
    expect(decide(caller("partner"), "ai.call", undefined, false)).toEqual({ allow: false, reason: "cross-firm" })
    expect(decide(caller("partner"), "ai.call", undefined, true)).toEqual({ allow: false, reason: "cross-firm" })
  })

  it("a client or an own_matters scope is denied every AI action; accounts keep accounts-register-only", () => {
    for (const action of AI_ACTIONS) {
      expect(decide(caller("partner"), action, matter, true, { scope: "own_matters" })).toEqual({ allow: false, reason: "client-denied" })
      expect(decide(caller("client"), action, matter, true)).toEqual({ allow: false, reason: "client-denied" })
      expect(decide(caller("accounts"), action, matter, true)).toEqual({ allow: false, reason: "accounts-register-only" })
    }
  })

  it("no caller is no-user", () => {
    for (const action of AI_ACTIONS) expect(decide(null, action, matter, true)).toEqual({ allow: false, reason: "no-user" })
  })
})
