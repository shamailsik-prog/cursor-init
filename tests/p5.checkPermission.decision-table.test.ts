/**
 * P5 checkPermission: the full decision table, asserting the exact decision
 * (allow + reason) for every branch. Written against the surviving mutants of
 * `npm run mutation` (docs/audits/mutation-report.md): the route-level suites
 * only checked `allow`, and the layered denials (cross-firm, then membership,
 * then clearance) let a removed check hide behind the next one.
 */
import { describe, expect, it } from "vitest"
import { checkPermission, requireClearance, seedUser } from "@/platform/p5/checkPermission"
import { PublicError } from "@/platform/http/publicError"
import { newStore, type Matter, type Role, type User } from "@/platform/spine/store"
import type { Classification } from "@/platform/p1/types"

function matter(id: string, firmId: string, classification: Classification = "confidential"): Matter {
  return {
    id,
    firmId,
    clientId: "client_1",
    title: id,
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "live",
    classification,
  }
}

function setup(role: Role, clearanceLevel: Classification = "privileged") {
  const store = newStore()
  const user: User = { id: "u1", firmId: "firmA", role, clearanceLevel }
  store.users.set(user.id, user)
  store.matters.set("m_own", matter("m_own", "firmA"))
  store.members.set(store.memberKey("m_own", "u1"), { matterId: "m_own", userId: "u1", firmId: "firmA" })
  store.matters.set("m_unjoined", matter("m_unjoined", "firmA"))
  // A row that should never exist: firm B's matter with a membership for firm A's user.
  // It isolates the firm check from the membership check behind it.
  store.matters.set("m_other_firm", matter("m_other_firm", "firmB"))
  store.members.set(store.memberKey("m_other_firm", "u1"), { matterId: "m_other_firm", userId: "u1", firmId: "firmB" })
  store.matters.set("m_secret", matter("m_secret", "firmA", "privileged-restricted"))
  store.members.set(store.memberKey("m_secret", "u1"), { matterId: "m_secret", userId: "u1", firmId: "firmA" })
  return store
}

describe("checkPermission decision table", () => {
  it("denies an unknown user with no-user", () => {
    expect(checkPermission(newStore(), "ghost", "read", "m_own")).toEqual({ allow: false, reason: "no-user" })
  })

  it.each(["research", "draft"])("denies an intern %s with intern-channel-denied", (action) => {
    expect(checkPermission(setup("intern"), "u1", action, "m_own")).toEqual({
      allow: false,
      reason: "intern-channel-denied",
    })
  })

  // FA-F43-R1-P01: these cases used "read", an action no row knows, as a stand-in for a matter-level action; it fell
  // through to `allow ok`. They now use real rows (matter.read, research), and the stand-in is refused unknown-action.
  it("lets an intern read a matter they are a member of", () => {
    expect(checkPermission(setup("intern"), "u1", "matter.read", "m_own")).toEqual({ allow: true, reason: "ok" })
  })

  it.each(["research", "draft"])("denies a client %s with client-channel-denied", (action) => {
    expect(checkPermission(setup("client"), "u1", action, "m_own")).toEqual({
      allow: false,
      reason: "client-channel-denied",
    })
  })

  it.each(["research", "draft"])("denies %s under the own_matters scope for any role", (action) => {
    expect(checkPermission(setup("associate"), "u1", action, "m_own", { scope: "own_matters" })).toEqual({
      allow: false,
      reason: "client-channel-denied",
    })
  })

  it("answers list_matters for a client or the own_matters scope with client-own-matters", () => {
    expect(checkPermission(setup("client"), "u1", "list_matters")).toEqual({ allow: true, reason: "client-own-matters" })
    expect(checkPermission(setup("partner"), "u1", "list_matters", undefined, { scope: "own_matters" })).toEqual({
      allow: true,
      reason: "client-own-matters",
    })
  })

  it("answers list_matters for staff with ok, before any matter check", () => {
    // list_matters is a listing (scoped later by membership); a matterId on it is not checked.
    expect(checkPermission(setup("partner"), "u1", "list_matters", "m_other_firm")).toEqual({ allow: true, reason: "ok" })
    expect(checkPermission(setup("client"), "u1", "list_matters", "m_other_firm")).toEqual({
      allow: true,
      reason: "client-own-matters",
    })
  })

  it("refuses a client's other actions by their own rows, never by the default (it was: a member client may read)", () => {
    expect(checkPermission(setup("client"), "u1", "read", "m_unjoined")).toEqual({ allow: false, reason: "unknown-action" })
    expect(checkPermission(setup("client"), "u1", "read", "m_own")).toEqual({ allow: false, reason: "unknown-action" })
    expect(checkPermission(setup("client"), "u1", "matter.read", "m_own")).toEqual({ allow: false, reason: "client-denied" })
    expect(
      checkPermission(setup("associate"), "u1", "research", "m_unjoined", { scope: "own_matters" })
    ).toEqual({ allow: false, reason: "client-channel-denied" })
  })

  it("denies a matter that does not exist with cross-firm (no existence oracle)", () => {
    expect(checkPermission(setup("partner"), "u1", "research", "m_missing")).toEqual({ allow: false, reason: "cross-firm" })
  })

  it("denies another firm's matter with cross-firm even when a membership row exists", () => {
    expect(checkPermission(setup("partner"), "u1", "research", "m_other_firm")).toEqual({
      allow: false,
      reason: "cross-firm",
    })
  })

  it("denies a same-firm matter the user is not a member of with not-member", () => {
    expect(checkPermission(setup("partner"), "u1", "research", "m_unjoined")).toEqual({ allow: false, reason: "not-member" })
  })

  it("denies a member whose clearance is below the matter's with clearance", () => {
    expect(checkPermission(setup("partner", "privileged"), "u1", "research", "m_secret")).toEqual({
      allow: false,
      reason: "clearance",
    })
  })

  it("allows a member at exactly the matter's clearance", () => {
    expect(checkPermission(setup("partner", "privileged-restricted"), "u1", "research", "m_secret")).toEqual({
      allow: true,
      reason: "ok",
    })
    expect(checkPermission(setup("partner", "confidential"), "u1", "research", "m_own")).toEqual({ allow: true, reason: "ok" })
  })

  it("allows a firm-level action with no matter, and refuses one no row knows", () => {
    expect(checkPermission(setup("associate"), "u1", "research")).toEqual({ allow: true, reason: "ok" })
    expect(checkPermission(setup("associate"), "u1", "read")).toEqual({ allow: false, reason: "unknown-action" })
  })
})

describe("requireClearance", () => {
  const user = (clearanceLevel: Classification): User => ({ id: "u", firmId: "f", role: "partner", clearanceLevel })

  it("compares ranks: equal or higher passes, lower fails", () => {
    expect(requireClearance(user("confidential"), "confidential")).toBe(true)
    expect(requireClearance(user("privileged"), "confidential")).toBe(true)
    expect(requireClearance(user("internal"), "confidential")).toBe(false)
  })

  it("treats an unreadable stored label as privileged-restricted", () => {
    expect(requireClearance(user("privileged"), "bogus" as Classification)).toBe(false)
    expect(requireClearance(user("privileged-restricted"), "bogus" as Classification)).toBe(true)
  })
})

describe("seedUser", () => {
  it("stores a user with a valid clearance and returns it", () => {
    const store = newStore()
    const u: User = { id: "s1", firmId: "f", role: "clerk", clearanceLevel: "internal" }
    expect(seedUser(store, u)).toBe(u)
    expect(store.users.get("s1")).toEqual(u)
  })

  it("refuses a user without a classification, as a PublicError, and stores nothing", () => {
    const store = newStore()
    const bad = { id: "s2", firmId: "f", role: "clerk", clearanceLevel: "secret" } as unknown as User
    expect(() => seedUser(store, bad)).toThrow(PublicError)
    expect(() => seedUser(store, bad)).toThrow("artefact write omitted classification")
    expect(store.users.has("s2")).toBe(false)
  })
})
