import { describe, expect, it } from "vitest"
import {
  DOCTYPE_ACTIONS,
  DRAFT_ACTIONS,
  decide,
  isDocTypeAction,
  isDraftAction,
  type DecisionCaller,
} from "@/platform/p5/permissionDecision"

// P4-10: the D4 drafting actions of the shared decision table (Phase 4a).
const ROLES = ["partner", "associate", "clerk", "intern", "accounts", "client"] as const
type Role = (typeof ROLES)[number]

const P: Role[] = ["partner"]
const PAC: Role[] = ["partner", "associate", "clerk"]

const MATRIX: Record<string, Role[]> = {
  "draft.create": PAC,
  "draft.edit": PAC,
  "draft.gate": PAC,
  "draft.read": PAC,
  "draft.override": P,
  "draft.approve": P,
  "doctype.read": PAC,
}
const MATTER_LEVEL = ["draft.create", "draft.edit", "draft.gate", "draft.read", "draft.override", "draft.approve"]

const caller = (role: Role): DecisionCaller => ({ role, firmId: "f1", clearanceLevel: "privileged-restricted" })
const matter = { firmId: "f1", classification: "confidential" }
const ALL = [...DRAFT_ACTIONS, ...DOCTYPE_ACTIONS]

describe("draft permission actions (P4-10)", () => {
  it("exports the 6 draft actions and doctype.read", () => {
    expect([...DRAFT_ACTIONS].sort()).toEqual(MATTER_LEVEL.slice().sort())
    expect([...DOCTYPE_ACTIONS]).toEqual(["doctype.read"])
    expect(ALL.slice().sort()).toEqual(Object.keys(MATRIX).sort())
    for (const a of DRAFT_ACTIONS) expect(isDraftAction(a)).toBe(true)
    expect(isDraftAction("doctype.read")).toBe(false)
    expect(isDocTypeAction("doctype.read")).toBe(true)
    for (const bad of ["draft", "draft.finalise", "ai.call", "job.read", "constructor", "__proto__", ""]) {
      expect([bad, isDraftAction(bad), isDocTypeAction(bad)]).toEqual([bad, false, false])
    }
  })

  it("doctype.read is firm-level: the role table decides, no matter is named; an intern gets intern-channel-denied", () => {
    for (const role of ROLES) {
      const expected =
        role === "client"
          ? { allow: false, reason: "client-denied" }
          : role === "accounts"
            ? { allow: false, reason: "accounts-register-only" }
            : role === "intern"
              ? { allow: false, reason: "intern-channel-denied" }
              : { allow: true, reason: "ok" }
      expect([role, decide(caller(role), "doctype.read", undefined, false)]).toEqual([role, expected])
    }
  })

  it("the draft actions are matter-level: cross-firm, not-member, clearance, then the role", () => {
    for (const action of MATTER_LEVEL) {
      expect(decide(caller("associate"), action, { firmId: "f2", classification: "internal" }, true)).toEqual({ allow: false, reason: "cross-firm" })
      expect(decide(caller("associate"), action, null, true)).toEqual({ allow: false, reason: "cross-firm" })
      expect(decide(caller("partner"), action, matter, false)).toEqual({ allow: false, reason: "not-member" })
      expect(decide({ ...caller("clerk"), clearanceLevel: "internal" }, action, matter, true)).toEqual({ allow: false, reason: "clearance" })
      expect(decide(caller("partner"), action, { firmId: "f1", classification: "bogus" }, true)).toEqual({ allow: false, reason: "clearance" })
      expect(decide(caller("partner"), action, { firmId: "f1", classification: "constructor" }, true)).toEqual({ allow: false, reason: "clearance" })
    }
  })

  it("the role table for the matter-level actions, 6 roles each, for a cleared member", () => {
    for (const action of MATTER_LEVEL) {
      for (const role of ROLES) {
        const allowed = MATRIX[action]!.includes(role)
        const reason = role === "client" ? "client-denied" : role === "accounts" ? "accounts-register-only" : role === "intern" ? "intern-channel-denied" : "role-not-permitted"
        expect([action, role, decide(caller(role), action, matter, true)]).toEqual([action, role, allowed ? { allow: true, reason: "ok" } : { allow: false, reason }])
      }
    }
  })

  it("draft.override and draft.approve are partner only; an associate and a clerk member get role-not-permitted", () => {
    for (const action of ["draft.override", "draft.approve"]) {
      expect(decide(caller("partner"), action, matter, true)).toEqual({ allow: true, reason: "ok" })
      expect(decide(caller("associate"), action, matter, true)).toEqual({ allow: false, reason: "role-not-permitted" })
      expect(decide(caller("clerk"), action, matter, true)).toEqual({ allow: false, reason: "role-not-permitted" })
    }
  })

  it("a matter-level action names no matter: fails closed, even for a partner", () => {
    for (const action of MATTER_LEVEL) {
      expect(decide(caller("partner"), action, undefined, false)).toEqual({ allow: false, reason: "cross-firm" })
      expect(decide(caller("partner"), action, undefined, true)).toEqual({ allow: false, reason: "cross-firm" })
    }
  })

  it("a client or an own_matters scope is denied every action; accounts keep accounts-register-only", () => {
    for (const action of ALL) {
      expect(decide(caller("partner"), action, matter, true, { scope: "own_matters" })).toEqual({ allow: false, reason: "client-denied" })
      expect(decide(caller("client"), action, matter, true)).toEqual({ allow: false, reason: "client-denied" })
      expect(decide(caller("accounts"), action, matter, true)).toEqual({ allow: false, reason: "accounts-register-only" })
    }
  })

  it("no caller is no-user", () => {
    for (const action of ALL) expect(decide(null, action, matter, true)).toEqual({ allow: false, reason: "no-user" })
  })

  it("the legacy `draft` action is unchanged: an intern is intern-channel-denied, a client client-channel-denied", () => {
    expect(decide(caller("intern"), "draft", undefined, false)).toEqual({ allow: false, reason: "intern-channel-denied" })
    expect(decide(caller("client"), "draft", undefined, false)).toEqual({ allow: false, reason: "client-channel-denied" })
  })
})
