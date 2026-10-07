import { afterEach, describe, expect, it } from "vitest"
import { POST } from "@/app/api/d1/matters/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { newStore } from "@/platform/spine/store"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/d1/matters", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    })
  )
}

function createBody(overrides: Record<string, unknown>) {
  return {
    action: "create",
    actorId: "partner_a",
    firmId: "firmA",
    clientId: "client_a",
    title: "Member validation matter",
    courtId: "SHC",
    classification: "internal",
    ...overrides,
  }
}

function snapshot() {
  const store = getRuntimeStore()
  return {
    matters: store.matters.size,
    members: store.members.size,
    audit: store.audit.length,
    searchIndex: store.matterClientSearchIndex.size,
  }
}

describe("POST /api/d1/matters validates members before persisting", () => {
  it("rejects an unknown member user id and persists nothing", async () => {
    const before = snapshot()
    const res = await post(
      createBody({ memberUserIds: ["associate_a", "ghost_user"] }),
      "6d4f1f0e-4b1c-4f59-9d2c-2f5b0d1f7a01"
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe("unknown member user")
    expect(json.error).not.toContain("ghost_user")
    expect(snapshot()).toEqual(before)
  })

  it("rejects a cross-firm member without leaving an orphaned matter behind", async () => {
    const before = snapshot()
    const res = await post(
      createBody({ memberUserIds: ["partner_b"] }),
      "6d4f1f0e-4b1c-4f59-9d2c-2f5b0d1f7a02"
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    // Indistinguishable from a nonexistent id: no cross-firm existence oracle.
    expect(json.error).toBe("unknown member user")
    expect(snapshot()).toEqual(before)
  })

  it("gives a cross-firm member id and a nonexistent id identical responses", async () => {
    const before = snapshot()
    const crossFirm = await post(
      createBody({ memberUserIds: ["partner_b"] }),
      "6d4f1f0e-4b1c-4f59-9d2c-2f5b0d1f7a05"
    )
    const missing = await post(
      createBody({ memberUserIds: ["ghost_user"] }),
      "6d4f1f0e-4b1c-4f59-9d2c-2f5b0d1f7a06"
    )
    expect(crossFirm.status).toBe(missing.status)
    expect(await crossFirm.text()).toBe(await missing.text())
    expect(snapshot()).toEqual(before)
  })

  it("rejects an unknown client identity", async () => {
    const before = snapshot()
    const res = await post(
      createBody({ clientId: "ghost_client" }),
      "6d4f1f0e-4b1c-4f59-9d2c-2f5b0d1f7a03"
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe("unknown client")
    expect(snapshot()).toEqual(before)
  })

  it("still creates the matter when every member exists in the firm", async () => {
    const res = await post(
      createBody({ memberUserIds: ["associate_a", "clerk_a"] }),
      "6d4f1f0e-4b1c-4f59-9d2c-2f5b0d1f7a04"
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { matter: { id: string } } }
    const store = getRuntimeStore()
    for (const userId of ["partner_a", "associate_a", "clerk_a"]) {
      expect(store.members.has(store.memberKey(json.result.matter.id, userId))).toBe(true)
    }
  })
})

describe("addMember service", () => {
  it("rejects unknown user ids", () => {
    const store = newStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "Service matter",
      courtId: "SHC",
      classification: "internal",
    })
    expect(() => addMember(store, matter.id, "ghost_user", "firmA")).toThrow(/unknown user/)
    expect(store.members.size).toBe(0)
  })
})

// Final audit F1: matter create's memberUserIds runs the same assignee validation as
// assignMatterMember (R1 #6 / R2 N5) and writes one matter_member_add row per member.
describe("POST /api/d1/matters create seats members through the assignee rules", () => {
  function clerk() {
    const store = getRuntimeStore()
    return [...store.users.values()].find((u) => u.firmId === "firmA" && u.role === "clerk")!
  }

  it("refuses a client member with 403 assignee_role_forbidden and persists nothing", async () => {
    const actor = clerk()
    const before = snapshot()
    const res = await post(
      createBody({ actorId: actor.id, memberUserIds: ["client_a"] }),
      "6d4f1f0e-4b1c-4f59-9d2c-2f5b0d1f7b01"
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("assignee_role_forbidden")
    expect(snapshot()).toEqual(before)
  })

  it("refuses an accounts member with 403 assignee_role_forbidden and persists nothing", async () => {
    const store = getRuntimeStore()
    store.users.set("accounts_x", { id: "accounts_x", firmId: "firmA", role: "accounts", clearanceLevel: "internal" })
    const before = snapshot()
    const res = await post(
      createBody({ memberUserIds: ["associate_a", "accounts_x"] }),
      "6d4f1f0e-4b1c-4f59-9d2c-2f5b0d1f7b02"
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("assignee_role_forbidden")
    expect(snapshot()).toEqual(before)
  })

  it("lets a non-partner creator seat same-firm staff, and writes one matter_member_add row per member", async () => {
    const actor = clerk()
    const res = await post(
      createBody({ actorId: actor.id, memberUserIds: ["associate_a"] }),
      "6d4f1f0e-4b1c-4f59-9d2c-2f5b0d1f7b03"
    )
    expect(res.status).toBe(200)
    const matterId = ((await res.json()) as { result: { matter: { id: string } } }).result.matter.id
    const store = getRuntimeStore()
    const rows = store.audit.filter((r) => r.action === "matter_member_add" && r.target === matterId)
    expect(rows.map((r) => r.reason).sort()).toEqual([`added ${actor.id}`, "added associate_a"].sort())
    expect(rows.every((r) => r.actorId === actor.id)).toBe(true)
  })
})
