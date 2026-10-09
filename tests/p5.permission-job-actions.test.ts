import { describe, expect, it } from "vitest"
import { JOB_ACTIONS, decide, isJobAction, type DecisionCaller } from "@/platform/p5/permissionDecision"

// P3-11: the job actions of the shared decision table.
const ROLES = ["partner", "associate", "clerk", "intern", "accounts", "client"] as const
type Role = (typeof ROLES)[number]

const P: Role[] = ["partner"]
const PA: Role[] = ["partner", "associate"]
const PAC: Role[] = ["partner", "associate", "clerk"]

const MATRIX: Record<string, Role[]> = { "job.read": PAC, "job.queue": P, "job.retry": PA, "job.cancel": P }

const caller = (role: Role): DecisionCaller => ({ role, firmId: "f1", clearanceLevel: "privileged-restricted" })
const matter = { firmId: "f1", classification: "confidential" }

describe("job permission actions (P3-11)", () => {
  it("exports the 4 job actions", () => {
    expect([...JOB_ACTIONS].sort()).toEqual(Object.keys(MATRIX).sort())
    expect(isJobAction("job.read")).toBe(true)
    expect(isJobAction("matter.read")).toBe(false)
  })

  it("the role table, 6 roles × 4 actions, firm-level", () => {
    for (const [action, allowed] of Object.entries(MATRIX)) {
      for (const role of ROLES) {
        expect([action, role, decide(caller(role), action, undefined, false)]).toEqual([
          action,
          role,
          allowed.includes(role)
            ? { allow: true, reason: "ok" }
            : {
                allow: false,
                reason: role === "client" ? "client-denied" : role === "accounts" ? "accounts-register-only" : "role-not-permitted",
              },
        ])
      }
    }
  })

  it("job.read with a matter: cross-firm, not-member, clearance, then the role", () => {
    expect(decide(caller("associate"), "job.read", { firmId: "f2", classification: "internal" }, true)).toEqual({ allow: false, reason: "cross-firm" })
    expect(decide(caller("associate"), "job.read", null, true)).toEqual({ allow: false, reason: "cross-firm" })
    expect(decide(caller("partner"), "job.read", matter, false)).toEqual({ allow: false, reason: "not-member" })
    expect(decide({ ...caller("clerk"), clearanceLevel: "internal" }, "job.read", matter, true)).toEqual({ allow: false, reason: "clearance" })
    expect(decide(caller("clerk"), "job.read", matter, true)).toEqual({ allow: true, reason: "ok" })
    expect(decide(caller("intern"), "job.read", matter, true)).toEqual({ allow: false, reason: "role-not-permitted" })
    expect(decide(caller("associate"), "job.read", matter, true, { scope: "own_matters" })).toEqual({ allow: false, reason: "client-denied" })
  })

  it("a client or an own_matters scope is denied every job action; accounts keep accounts-register-only", () => {
    for (const action of JOB_ACTIONS) {
      expect(decide(caller("partner"), action, undefined, false, { scope: "own_matters" })).toEqual({ allow: false, reason: "client-denied" })
      expect(decide(caller("client"), action, matter, true)).toEqual({ allow: false, reason: "client-denied" })
      expect(decide(caller("accounts"), action, matter, true)).toEqual({ allow: false, reason: "accounts-register-only" })
    }
  })
})
