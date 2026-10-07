import { afterEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/d1/clients/route"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/d1/clients", {
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
  return GET(new Request(`http://127.0.0.1/api/d1/clients?${params.toString()}`))
}

describe("POST/GET /api/d1/clients", () => {
  it("creates client entities and reuses idempotent responses", async () => {
    const payload = {
      action: "create",
      actorId: "partner_a",
      firmId: "firmA",
      canonicalName: "Ali Raza",
      cnic: "42201-1234567-8",
      phone: "+923001112233",
      classification: "internal",
    }
    const first = await post(payload, "4b12c9e4-9c91-4ee8-a911-af9fd5cf6e0c")
    const second = await post(payload, "4b12c9e4-9c91-4ee8-a911-af9fd5cf6e0c")
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { reused: boolean; result: { entity: { id: string } } }
    const b = (await second.json()) as { reused: boolean; result: { entity: { id: string } } }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(a.result.entity.id).toBe(b.result.entity.id)
  })

  it("rejects same key with different payload", async () => {
    const key = "a4d7501c-f08f-4f4e-a5b1-48a0ecde2435"
    const first = await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        canonicalName: "First",
        cnic: "4220112345678",
        phone: "+923001112233",
        classification: "internal",
      },
      key
    )
    const second = await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        canonicalName: "Second",
        cnic: "4220112345679",
        phone: "+923001112234",
        classification: "internal",
      },
      key
    )
    expect(first.status).toBe(200)
    expect(second.status).toBe(422) // idempotency_key_reused (final audit F4: functions semantics)
  })

  it("lists entities with pagination and enforces clearance filter", async () => {
    await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        canonicalName: "Client One",
        cnic: "4220112345601",
        phone: "+923001112201",
        classification: "internal",
      },
      "f8b8f90a-9e8d-4220-a63f-cc0a3c1f9ea5"
    )
    await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        canonicalName: "Client Two",
        cnic: "4220112345602",
        phone: "+923001112202",
        classification: "internal",
      },
      "6ec582db-c9f7-4314-ae01-0dc875830b5f"
    )
    await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        canonicalName: "Privileged Client",
        cnic: "4220112345603",
        phone: "+923001112203",
        classification: "privileged",
      },
      "a4ca7a6c-a95c-4c08-ab6e-e1f083769437"
    )

    const pageOne = await get(new URLSearchParams({ userId: "clerk_a", limit: "1", cursor: "0" }))
    expect(pageOne.status).toBe(200)
    const one = (await pageOne.json()) as {
      items: Array<{ id: string; classification: string }>
      total: number
      nextCursor: string | null
    }
    expect(one.total).toBe(2)
    expect(one.items).toHaveLength(1)
    expect(one.nextCursor).toBe("1")

    const pageTwo = await get(new URLSearchParams({ userId: "clerk_a", limit: "1", cursor: "1" }))
    const two = (await pageTwo.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(two.items).toHaveLength(1)
    expect(two.nextCursor).toBeNull()
  })

  it("persists conflict candidate links for matching CNIC values", async () => {
    const first = await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        canonicalName: "Same CNIC A",
        cnic: "4220112345699",
        phone: "+923001112299",
        classification: "internal",
      },
      "e76dc45a-aa0c-4eb5-9f8b-2a9d16755935"
    )
    const firstJson = (await first.json()) as { result: { entity: { id: string } } }

    await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        canonicalName: "Same CNIC B",
        cnic: "4220112345699",
        phone: "+923001112288",
        classification: "internal",
      },
      "3d4ec539-bf5f-410b-95c4-bf06c7b12ca4"
    )

    const check = await post(
      {
        action: "conflict_check",
        actorId: "partner_a",
        firmId: "firmA",
        entityId: firstJson.result.entity.id,
      },
      "3490a3d1-b473-4f13-a53d-778228bc87f8"
    )
    expect(check.status).toBe(200)
    const checkJson = (await check.json()) as {
      result: { result: { status: string; identityBasis?: string } }
    }
    expect(checkJson.result.result.status).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(checkJson.result.result.identityBasis).toBe("cnic")
  })

  it("rejects cross-firm, low-clearance, and client-role operations", async () => {
    const crossFirm = await post(
      {
        action: "create",
        actorId: "partner_b",
        firmId: "firmA",
        canonicalName: "Cross Firm",
        cnic: "4220112300001",
        phone: "+923001110001",
        classification: "internal",
      },
      "54f7f8ce-ee1d-4c43-bcdf-ef958d9539f9"
    )
    expect(crossFirm.status).toBe(400)

    const lowClearance = await post(
      {
        action: "create",
        actorId: "clerk_a",
        firmId: "firmA",
        canonicalName: "Too Sensitive",
        cnic: "4220112300002",
        phone: "+923001110002",
        classification: "privileged-restricted",
      },
      "111c548d-c554-42f4-a4ca-aac11ca4d760"
    )
    expect(lowClearance.status).toBe(403)

    const clientDenied = await post(
      {
        action: "create",
        actorId: "client_a",
        firmId: "firmA",
        canonicalName: "Client Actor",
        cnic: "4220112300003",
        phone: "+923001110003",
        classification: "internal",
      },
      "8b9797f9-1e81-4c5b-a62b-c11bc95cf4e6"
    )
    expect(clientDenied.status).toBe(400)
  })
})
