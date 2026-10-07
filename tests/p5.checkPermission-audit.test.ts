// Layer 18 §4.5: "checkPermission(userId, action, matterId?) ... returns allow/deny with
// reason; logs to auditPrivilegeAccess." One audit row per decision; fail closed when the
// audit write fails.
import { describe, expect, it } from "vitest"
import { newStore } from "@/platform/spine/store"
import { checkPermission, seedUser } from "@/platform/p5/checkPermission"
import { addMember, createMatter } from "@/services/d1-2/matters"

function setup() {
  const store = newStore()
  seedUser(store, { id: "p1", firmId: "firmA", role: "partner", clearanceLevel: "privileged" })
  seedUser(store, { id: "a1", firmId: "firmA", role: "associate", clearanceLevel: "privileged" })
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "c1",
    title: "Audit matter",
    courtId: "SHC",
    classification: "confidential",
  })
  addMember(store, matter.id, "p1", "firmA")
  return { store, matterId: matter.id }
}

const permissionRows = (store: ReturnType<typeof newStore>) =>
  store.audit.filter((row) => row.action === "permission_check")

describe("checkPermission audits every decision (L18 §4.5)", () => {
  it("appends exactly one audit row per allow and per deny, with the reason", () => {
    const { store, matterId } = setup()
    const before = permissionRows(store).length

    const allow = checkPermission(store, "p1", "draft", matterId)
    expect(allow).toEqual({ allow: true, reason: "ok" })
    expect(permissionRows(store)).toHaveLength(before + 1)
    expect(permissionRows(store).at(-1)).toMatchObject({
      action: "permission_check",
      actorId: "p1",
      firmId: "firmA",
      target: matterId,
      classification: "confidential",
      reason: "allow:draft:ok",
    })

    const deny = checkPermission(store, "a1", "draft", matterId)
    expect(deny).toEqual({ allow: false, reason: "not-member" })
    expect(permissionRows(store)).toHaveLength(before + 2)
    expect(permissionRows(store).at(-1)).toMatchObject({
      actorId: "a1",
      target: matterId,
      reason: "deny:draft:not-member",
    })

    checkPermission(store, "ghost", "list_matters")
    expect(permissionRows(store)).toHaveLength(before + 3)
    expect(permissionRows(store).at(-1)).toMatchObject({ actorId: "ghost", reason: "deny:list_matters:no-user" })
    expect(permissionRows(store).every((row) => typeof row.id === "string" && typeof row.at === "number")).toBe(true)
  })

  it("fails closed: an allow becomes deny audit_unavailable when the audit write fails", () => {
    const { store, matterId } = setup()
    Object.freeze(store.audit)
    expect(checkPermission(store, "p1", "draft", matterId)).toEqual({
      allow: false,
      reason: "audit_unavailable",
    })
    expect(checkPermission(store, "a1", "draft", matterId)).toEqual({
      allow: false,
      reason: "audit_unavailable",
    })
  })
})
