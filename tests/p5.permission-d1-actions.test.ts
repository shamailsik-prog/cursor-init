import { describe, expect, it } from "vitest"
import { D1_ACTIONS, decide, isD1Action, type DecisionCaller } from "@/platform/p5/permissionDecision"

const ROLES = ["partner", "associate", "clerk", "intern", "accounts", "client"] as const
type Role = (typeof ROLES)[number]

const P: Role[] = ["partner"]
const PA: Role[] = ["partner", "associate"]
const PAC: Role[] = ["partner", "associate", "clerk"]
const STAFF: Role[] = ["partner", "associate", "clerk", "intern"]

const MATRIX: Record<string, Role[]> = {
  "client.register": PAC,
  "client.read": STAFF,
  "matter.open": PA,
  "conflict.run": PA,
  "conflict.resolve_review": PA,
  "conflict.waive": P,
  "conflict.read_trail": PA,
  "firm.set_numbering": P,
  "matter.read": STAFF,
  "matter.advance_stage": PA,
  "matter.close": P,
}
const MATTER_LEVEL = ["matter.read", "matter.advance_stage", "matter.close"]

const caller = (role: Role): DecisionCaller => ({
  role,
  firmId: "f1",
  clearanceLevel: "privileged-restricted",
})
const matter = { firmId: "f1", classification: "confidential" }

describe("D1 permission actions", () => {
  it("exports the 11 actions and a guard", () => {
    expect([...D1_ACTIONS].sort()).toEqual(Object.keys(MATRIX).sort())
    expect(isD1Action("conflict.run")).toBe(true)
    expect(isD1Action("research")).toBe(false)
  })

  for (const [action, allowed] of Object.entries(MATRIX)) {
    for (const role of ROLES) {
      const ok = allowed.includes(role)
      it(`${action} by ${role} -> ${ok ? "allow" : "deny"}`, () => {
        const m = MATTER_LEVEL.includes(action) ? matter : undefined
        const d = decide(caller(role), action, m, true)
        expect(d.allow).toBe(ok)
        if (!ok) {
          const expected =
            role === "client" ? "client-denied" : role === "accounts" ? "accounts-register-only" : "role-not-permitted"
          expect(d.reason).toBe(expected)
        }
      })
    }
  }

  it("matter-level actions deny not-member, clearance, cross-firm and a missing matter", () => {
    for (const action of MATTER_LEVEL) {
      expect(decide(caller("partner"), action, matter, false)).toEqual({
        allow: false,
        reason: "not-member",
      })
      expect(decide({ ...caller("partner"), clearanceLevel: "internal" }, action, matter, true)).toEqual({
        allow: false,
        reason: "clearance",
      })
      expect(decide(caller("partner"), action, { firmId: "f2", classification: "internal" }, true).reason).toBe(
        "cross-firm",
      )
      expect(decide(caller("partner"), action, null, true).reason).toBe("cross-firm")
      expect(decide(caller("partner"), action, undefined, true).allow).toBe(false)
    }
  })

  it("a client under own_matters scope is denied", () => {
    expect(
      decide(caller("associate"), "client.read", undefined, false, {
        scope: "own_matters",
      }).reason,
    ).toBe("client-denied")
  })

  it("null caller denies no-user", () => {
    expect(decide(null, "conflict.run", undefined, false).reason).toBe("no-user")
  })
})
