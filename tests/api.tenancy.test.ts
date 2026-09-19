import { afterEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/p5/tenancy/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/p5/tenancy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    })
  )
}

function get(params: URLSearchParams) {
  return GET(new Request(`http://127.0.0.1/api/p5/tenancy?${params.toString()}`))
}

function seedMatterMembership() {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Membership matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  return matter.id
}

describe("GET/POST /api/p5/tenancy", () => {
  it("builds session context and enforces firm scoping", async () => {
    const matterId = seedMatterMembership()
    const ok = await get(
      new URLSearchParams({
        view: "session",
        userId: "associate_a",
        firmId: "firmA",
      })
    )
    expect(ok.status).toBe(200)
    const okJson = (await ok.json()) as {
      session: { user: { id: string }; accessibleMatterIds: string[] }
    }
    expect(okJson.session.user.id).toBe("associate_a")
    expect(okJson.session.accessibleMatterIds).toContain(matterId)

    const denied = await get(
      new URLSearchParams({
        view: "session",
        userId: "associate_a",
        firmId: "firmB",
      })
    )
    expect(denied.status).toBe(400)
  })

  it("lists users and memberships for partner admins with pagination", async () => {
    const matterId = seedMatterMembership()
    const users = await get(
      new URLSearchParams({
        view: "users",
        actorId: "partner_a",
        firmId: "firmA",
        limit: "2",
        cursor: "0",
      })
    )
    expect(users.status).toBe(200)
    const usersJson = (await users.json()) as {
      items: Array<{ id: string }>
      total: number
      nextCursor: string | null
    }
    expect(usersJson.total).toBeGreaterThan(0)
    expect(usersJson.items.length).toBeLessThanOrEqual(2)

    const memberships = await get(
      new URLSearchParams({
        view: "memberships",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(memberships.status).toBe(200)
    const m = (await memberships.json()) as { items: Array<{ matterId: string }> }
    expect(m.items.some((row) => row.matterId === matterId)).toBe(true)
  })

  it("denies non-partner admin reads", async () => {
    seedMatterMembership()
    const denied = await get(
      new URLSearchParams({
        view: "users",
        actorId: "associate_a",
        firmId: "firmA",
        limit: "10",
        cursor: "0",
      })
    )
    expect(denied.status).toBe(400)
  })

  it("lists partner-admin audit entries and denies non-partner audit reads", async () => {
    const writeRes = await post(
      {
        action: "update_role",
        actorId: "partner_a",
        firmId: "firmA",
        targetUserId: "clerk_a",
        nextRole: "clerk",
        nextClearance: "internal",
        reason: "Audit list verification",
      },
      "bf379f5f-5e99-4f3b-9617-72d3f3c10f2d"
    )
    expect(writeRes.status).toBe(200)

    const auditRes = await get(
      new URLSearchParams({
        view: "audit",
        actorId: "partner_a",
        firmId: "firmA",
        limit: "10",
        cursor: "0",
      })
    )
    expect(auditRes.status).toBe(200)
    const auditJson = (await auditRes.json()) as {
      items: Array<{ action: string; target: string }>
      total: number
    }
    expect(auditJson.total).toBeGreaterThan(0)
    expect(
      auditJson.items.some(
        (row) => row.action === "tenant_update_role" && row.target === "clerk_a"
      )
    ).toBe(true)

    const deniedAudit = await get(
      new URLSearchParams({
        view: "audit",
        actorId: "associate_a",
        firmId: "firmA",
        limit: "10",
        cursor: "0",
      })
    )
    expect(deniedAudit.status).toBe(400)
  })

  it("blocks role escalation and cross-firm role changes", async () => {
    const promotePartner = await post(
      {
        action: "update_role",
        actorId: "partner_a",
        firmId: "firmA",
        targetUserId: "associate_a",
        nextRole: "partner",
        nextClearance: "privileged",
      },
      "24bfadbe-492f-42d6-aef6-8e9f30a140e8"
    )
    expect(promotePartner.status).toBe(400)

    const crossFirm = await post(
      {
        action: "update_role",
        actorId: "partner_a",
        firmId: "firmA",
        targetUserId: "partner_b",
        nextRole: "associate",
        nextClearance: "internal",
      },
      "8f7d3cff-979a-4f4d-b24f-11c1069f4208"
    )
    expect(crossFirm.status).toBe(400)
  })

  it("supports idempotent role updates and writes audit entries", async () => {
    const key = "fdf53787-4239-4cb4-ab6e-328eceb06484"
    const payload = {
      action: "update_role",
      actorId: "partner_a",
      firmId: "firmA",
      targetUserId: "clerk_a",
      nextRole: "clerk",
      nextClearance: "internal",
      reason: "Temporary reduced clearance",
    }
    const first = await post(payload, key)
    const second = await post(payload, key)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { reused: boolean; result: { user: { id: string } } }
    const b = (await second.json()) as { reused: boolean; result: { user: { id: string } } }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(a.result.user.id).toBe("clerk_a")

    const conflict = await post({ ...payload, nextClearance: "confidential" }, key)
    expect(conflict.status).toBe(409)

    const audit = getRuntimeStore().audit
    expect(audit.some((row) => row.action === "tenant_update_role" && row.target === "clerk_a")).toBe(
      true
    )
  })
})
