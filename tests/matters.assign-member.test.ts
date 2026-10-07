// Review round 1, finding 6: R-2 "no role is exempt" — a partner cannot self-assign into a
// matter they are not a member of; a partner who is a member must add them.
import { afterEach, describe, expect, it } from "vitest"
import { POST as MATTERS } from "@/app/api/d1/matters/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

afterEach(() => resetRuntimeStoreForTests())
let n = 0
const key = () => `c6c6c6c6-0000-4000-8000-${String(++n).padStart(12, "0")}`
const post = (body: unknown) =>
  MATTERS(new Request("http://127.0.0.1/api/d1/matters", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() }, body: JSON.stringify(body) }))

function setup() {
  const store = getRuntimeStore()
  store.users.set("partner_x", { id: "partner_x", firmId: "firmA", role: "partner", clearanceLevel: "privileged-restricted" })
  const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
  addMember(store, m.id, "partner_a", "firmA")
  addMember(store, m.id, "associate_a", "firmA")
  return { store, matterId: m.id }
}

describe("POST /api/d1/matters add_member", () => {
  it("a non-member partner cannot add themselves: 403 self_assignment_forbidden", async () => {
    const { store, matterId } = setup()
    const res = await post({ action: "add_member", actorId: "partner_x", matterId, memberUserId: "partner_x" })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("self_assignment_forbidden")
    expect(store.members.has(store.memberKey(matterId, "partner_x"))).toBe(false)
  })

  it("a non-member partner cannot add someone else either", async () => {
    const { store, matterId } = setup()
    const res = await post({ action: "add_member", actorId: "partner_x", matterId, memberUserId: "clerk_a" })
    expect(res.status).toBe(403)
    expect(store.members.has(store.memberKey(matterId, "clerk_a"))).toBe(false)
  })

  it("only a partner member assigns; the assignment is audited", async () => {
    const { store, matterId } = setup()
    const byAssociate = await post({ action: "add_member", actorId: "associate_a", matterId, memberUserId: "clerk_a" })
    expect(byAssociate.status).toBe(403)
    const ok = await post({ action: "add_member", actorId: "partner_a", matterId, memberUserId: "partner_x" })
    expect(ok.status).toBe(200)
    expect(store.members.has(store.memberKey(matterId, "partner_x"))).toBe(true)
    expect(store.audit.some((row) => row.action === "matter_member_add" && row.actorId === "partner_a" && row.target === matterId)).toBe(true)
    const crossFirm = await post({ action: "add_member", actorId: "partner_a", matterId, memberUserId: "partner_b" })
    expect(crossFirm.status).toBeGreaterThanOrEqual(400)
  })
})

describe("assignee role validation (review R2 N5)", () => {
  it("client and accounts users cannot be assigned; a cross-firm user is unknown", async () => {
    const { store, matterId } = setup()
    store.users.set("accounts_x", { id: "accounts_x", firmId: "firmA", role: "accounts", clearanceLevel: "internal" })
    for (const userId of ["client_a", "accounts_x"]) {
      const res = await post({ action: "add_member", actorId: "partner_a", matterId, memberUserId: userId })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { code: string }).code).toBe("assignee_role_forbidden")
      expect(store.members.has(store.memberKey(matterId, userId))).toBe(false)
    }
    const cross = await post({ action: "add_member", actorId: "partner_a", matterId, memberUserId: "partner_b" })
    expect(cross.status).toBeGreaterThanOrEqual(400)
    expect(store.members.has(store.memberKey(matterId, "partner_b"))).toBe(false)
  })
})

describe("documents API: a client-role member reads no matter documents (review R2 N5)", () => {
  it("canReadDocument denies client role", async () => {
    const { canReadDocument } = await import("@/platform/p5/documentAccess")
    const { store, matterId } = setup()
    addMember(store, matterId, "client_a", "firmA")
    const user = store.users.get("client_a")
    if (!user) throw new Error("client missing")
    expect(canReadDocument(store, user, { firmId: "firmA", classification: "internal", matterId })).toBe(false)
  })
})
