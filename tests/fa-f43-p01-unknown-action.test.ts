/**
 * FA-F43-R1-P01 (spec docs/superpowers/specs/2026-10-24-fa-f43-p01-unknown-action-deny-design.md): the shared P5 table
 * (platform/p5/permissionDecision.ts `decide`, evaluated by the Next.js and the Cloud Functions checkPermission) ended in
 * `allow("ok")`, so an action no row knew was allowed to every role but accounts, and the Next routes' committee actions
 * were allowed to an intern and a client. The table now ends in `deny("unknown-action")` and decides the Next routes'
 * actions with explicit rows (spec R2).
 *
 * On main 5840d3d the unknown-action cases, the committee rows, the accounts register rows and the DECIDE_ACTIONS list
 * fail; the research, draft, normalise_case_number, list_matters and alert rows pass on both (they pin what is kept).
 */
import { describe, expect, it } from "vitest"
import * as table from "@/platform/p5/permissionDecision"
import { decide, type DecisionCaller, type PermissionDecision } from "@/platform/p5/permissionDecision"
import { checkPermission } from "@/platform/p5/checkPermission"
import { newStore, type Role } from "@/platform/spine/store"

const ROLES = ["partner", "associate", "clerk", "intern", "accounts", "client"] as const
const NOT_ACCOUNTS = ["partner", "associate", "clerk", "intern", "client"] as const
type R = (typeof ROLES)[number]

/** Strings no row decides: a stand-in a test once used, look-alikes of real actions, and Object.prototype keys. */
const UNKNOWN = [
  "fa_f43_unknown.action",
  "read",
  "read_matter",
  "read_firm",
  "alert.list",
  "Research",
  "research ",
  "",
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
]

const MATTER = { firmId: "f1", classification: "confidential" }
const caller = (role: R): DecisionCaller => ({ role, firmId: "f1", clearanceLevel: "privileged-restricted" })
const ok: PermissionDecision = { allow: true, reason: "ok" }
const no = (reason: string): PermissionDecision => ({ allow: false, reason })

describe("FA-F43-R1-P01: an action no table knows is refused", () => {
  it.each(UNKNOWN)("%j is unknown-action for partner, associate, clerk, intern and client, with or without a matter", (action) => {
    for (const role of NOT_ACCOUNTS) {
      expect([role, decide(caller(role), action, undefined, false)]).toEqual([role, no("unknown-action")])
      expect([role, decide(caller(role), action, MATTER, true)]).toEqual([role, no("unknown-action")])
      expect([role, decide(caller(role), action, MATTER, false)]).toEqual([role, no("unknown-action")])
      expect([role, decide(caller(role), action, MATTER, true, { scope: "own_matters" })]).toEqual([role, no("unknown-action")])
    }
  })

  it("accounts keep accounts-register-only, and no caller is no-user", () => {
    for (const action of UNKNOWN) {
      expect(decide(caller("accounts"), action, MATTER, true)).toEqual(no("accounts-register-only"))
      expect(decide(null, action, MATTER, true)).toEqual(no("no-user"))
    }
  })

  it.each(NOT_ACCOUNTS)("the Next.js checkPermission refuses a %s and writes the deny row", (role) => {
    const store = newStore()
    store.users.set("u1", { id: "u1", firmId: "f1", role: role as Role, clearanceLevel: "privileged-restricted" })
    store.matters.set("m1", {
      id: "m1",
      firmId: "f1",
      clientId: "c1",
      title: "t",
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      status: "live",
      classification: "confidential",
    })
    store.members.set(store.memberKey("m1", "u1"), { matterId: "m1", userId: "u1", firmId: "f1" })
    expect(checkPermission(store, "u1", "fa_f43_unknown.action", "m1")).toEqual(no("unknown-action"))
    expect(checkPermission(store, "u1", "fa_f43_unknown.action")).toEqual(no("unknown-action"))
    const rows = store.audit.filter((r) => r.action === "permission_check")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ actorId: "u1", firmId: "f1", target: "m1", reason: "deny:fa_f43_unknown.action:unknown-action" })
    expect(rows[1]).toMatchObject({ target: "fa_f43_unknown.action", reason: "deny:fa_f43_unknown.action:unknown-action" })
  })
})

/** Spec R2/R3: the ruled roles of each Next route action, and the reason every other role gets. */
const PAC: R[] = ["partner", "associate", "clerk"]
const NEXT_ROUTE: Record<string, { allowed: R[]; refused: Partial<Record<R, PermissionDecision>> }> = {
  research: { allowed: PAC, refused: { intern: no("intern-channel-denied"), client: no("client-channel-denied"), accounts: no("accounts-register-only") } },
  draft: { allowed: PAC, refused: { intern: no("intern-channel-denied"), client: no("client-channel-denied"), accounts: no("accounts-register-only") } },
  normalise_case_number: { allowed: [...PAC, "intern"], refused: { client: no("staff-only"), accounts: no("accounts-register-only") } },
  list_matters: { allowed: [...PAC, "intern"], refused: { client: { allow: true, reason: "client-own-matters" }, accounts: no("accounts-register-only") } },
  committee_brain: { allowed: PAC, refused: { intern: no("role-not-permitted"), client: no("client-denied"), accounts: no("accounts-register-only") } },
  committee_brain_read: { allowed: PAC, refused: { intern: no("role-not-permitted"), client: no("client-denied"), accounts: no("accounts-register-only") } },
}

describe("FA-F43-R1-P01: each Next route action keeps exactly its ruled roles", () => {
  it.each(Object.keys(NEXT_ROUTE))("%s: every role, on a matter the caller is a cleared member of", (action) => {
    const { allowed, refused } = NEXT_ROUTE[action]!
    for (const role of ROLES) {
      const expected = allowed.includes(role) ? ok : refused[role]
      expect(expected, `${action} ${role} has a ruling`).toBeDefined()
      const matter = action === "list_matters" ? undefined : MATTER
      expect([action, role, decide(caller(role), action, matter, matter !== undefined)]).toEqual([action, role, expected])
    }
  })

  it.each(["committee_brain", "committee_brain_read"])("%s must name a matter (fails closed), then passes the matter gate", (action) => {
    expect(decide(caller("partner"), action, undefined, false)).toEqual(no("cross-firm"))
    expect(decide(caller("partner"), action, undefined, true)).toEqual(no("cross-firm"))
    expect(decide(caller("partner"), action, null, true)).toEqual(no("cross-firm"))
    expect(decide(caller("clerk"), action, { firmId: "f2", classification: "public" }, true)).toEqual(no("cross-firm"))
    expect(decide(caller("clerk"), action, { ...MATTER, deleted: true }, true)).toEqual(no("matter-deleted"))
    expect(decide(caller("clerk"), action, MATTER, false)).toEqual(no("not-member"))
    expect(decide({ ...caller("associate"), clearanceLevel: "internal" }, action, MATTER, true)).toEqual(no("clearance"))
  })

  it.each(["committee_brain", "committee_brain_read"])("%s under the own_matters scope is client-denied", (action) => {
    for (const role of PAC) expect(decide(caller(role), action, MATTER, true, { scope: "own_matters" })).toEqual(no("client-denied"))
  })

  it.each(["research", "draft", "normalise_case_number"])("%s keeps the matter gate when a matter is named, and is firm-level without one", (action) => {
    expect(decide(caller("partner"), action, undefined, false)).toEqual(ok)
    expect(decide(caller("partner"), action, { firmId: "f2", classification: "public" }, true)).toEqual(no("cross-firm"))
    expect(decide(caller("partner"), action, null, true)).toEqual(no("cross-firm"))
    expect(decide(caller("partner"), action, MATTER, false)).toEqual(no("not-member"))
    expect(decide({ ...caller("clerk"), clearanceLevel: "internal" }, action, MATTER, true)).toEqual(no("clearance"))
    expect(decide(caller("clerk"), action, { firmId: "f1", classification: "bogus" }, true)).toEqual(no("clearance"))
  })

  it("list_matters is never matter-gated: a listing, scoped later by membership", () => {
    expect(decide(caller("partner"), "list_matters", { firmId: "f2", classification: "public" }, false)).toEqual(ok)
    expect(decide(caller("client"), "list_matters", { firmId: "f2", classification: "public" }, false)).toEqual({ allow: true, reason: "client-own-matters" })
    expect(decide(caller("associate"), "list_matters", undefined, false, { scope: "own_matters" })).toEqual({ allow: true, reason: "client-own-matters" })
  })
})

describe("FA-F43-R1-P01: the accounts register actions are accounts only (spec R5)", () => {
  it.each(["intimation_register", "record_accounts_entry"])("%s: role-not-permitted for every other role, accounts-register for accounts", (action) => {
    for (const role of NOT_ACCOUNTS) {
      expect([role, decide(caller(role), action, undefined, false)]).toEqual([role, no("role-not-permitted")])
      expect([role, decide(caller(role), action, MATTER, true)]).toEqual([role, no("role-not-permitted")])
    }
    expect(decide(caller("accounts"), action, undefined, false)).toEqual({ allow: true, reason: "accounts-register" })
    expect(decide(caller("accounts"), action, MATTER, false)).toEqual({ allow: true, reason: "accounts-register" })
  })
})

describe("FA-F43-R1-P01: alert.read and alert.ack (fixed on main by F43, #120) stay partner only", () => {
  it.each(["alert.read", "alert.ack"])("%s", (action) => {
    expect(decide(caller("partner"), action, undefined, false)).toEqual(ok)
    for (const role of ["associate", "clerk", "intern"] as const) expect(decide(caller(role), action, undefined, false)).toEqual(no("role-not-permitted"))
    expect(decide(caller("client"), action, undefined, false)).toEqual(no("client-denied"))
    expect(decide(caller("accounts"), action, undefined, false)).toEqual(no("accounts-register-only"))
  })
})

describe("FA-F43-R1-P01: DECIDE_ACTIONS is exactly what the table decides (spec R7)", () => {
  const listed = (): readonly string[] => (table as { DECIDE_ACTIONS?: readonly string[] }).DECIDE_ACTIONS ?? []
  const known = (action: string): boolean => (table as { isKnownAction?: (a: string) => boolean }).isKnownAction?.(action) ?? false

  it("lists every family once: 51 actions", () => {
    const actions = listed()
    expect(actions).toHaveLength(51)
    expect(new Set(actions).size).toBe(51)
    for (const family of [
      table.FIRM_ADMIN_ACTIONS,
      table.RETENTION_ACTIONS,
      table.D1_ACTIONS,
      table.JOB_ACTIONS,
      table.ALERT_ACTIONS,
      table.AI_ACTIONS,
      table.DRAFT_ACTIONS,
      table.DOCTYPE_ACTIONS,
    ]) {
      for (const action of family) expect(actions).toContain(action)
    }
    for (const action of [...Object.keys(NEXT_ROUTE), "intimation_register", "record_accounts_entry"]) expect(actions).toContain(action)
  })

  it("every listed action is decided by a row, never unknown-action, for every role and matter shape", () => {
    const actions = listed()
    expect(actions.length).toBeGreaterThan(0)
    for (const action of actions) {
      expect(known(action), action).toBe(true)
      for (const role of ROLES) {
        for (const [matter, member] of [[undefined, false], [MATTER, true], [MATTER, false], [null, false]] as const) {
          for (const extra of [undefined, { scope: "own_matters" as const }]) {
            const decision = decide(caller(role), action, matter, member, extra)
            expect([action, role, decision.reason === "unknown-action"]).toEqual([action, role, false])
          }
        }
      }
    }
  })

  it("isKnownAction refuses every unknown string", () => {
    expect(typeof (table as { isKnownAction?: unknown }).isKnownAction).toBe("function")
    for (const action of UNKNOWN) expect([action, known(action)]).toEqual([action, false])
  })
})
