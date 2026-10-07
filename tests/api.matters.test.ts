import { afterEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/d1/matters/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/d1/matters", {
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
  return GET(new Request(`http://127.0.0.1/api/d1/matters?${params.toString()}`))
}

describe("POST/GET /api/d1/matters", () => {
  it("creates a matter and reuses idempotent responses for same key+payload", async () => {
    const payload = {
      action: "create",
      actorId: "partner_a",
      firmId: "firmA",
      clientId: "client_a",
      title: "SHC constitutional petition",
      courtId: "SHC",
      classification: "confidential",
      memberUserIds: ["clerk_a"],
    }
    const first = await post(payload, "a0f0672d-c6da-4796-ba71-b7d95dd2d99b")
    const second = await post(payload, "a0f0672d-c6da-4796-ba71-b7d95dd2d99b")
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { reused: boolean; result: { matter: { id: string } } }
    const b = (await second.json()) as { reused: boolean; result: { matter: { id: string } } }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(a.result.matter.id).toBe(b.result.matter.id)
  })

  it("rejects key reuse with different payload", async () => {
    const key = "6ce72984-f1e8-4e8b-aa01-116a45d1c34f"
    const first = await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "client_a",
        title: "Matter one",
        courtId: "SHC",
        classification: "internal",
      },
      key
    )
    const second = await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "client_a",
        title: "Matter two",
        courtId: "SHC",
        classification: "internal",
      },
      key
    )
    expect(first.status).toBe(200)
    expect(second.status).toBe(422) // idempotency_key_reused (final audit F4: functions semantics)
  })

  it("lists matters with limit/cursor pagination and tenant membership scoping", async () => {
    await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "client_a",
        title: "Matter A",
        courtId: "SHC",
        classification: "internal",
        memberUserIds: ["clerk_a"],
      },
      "68ca0177-760f-4a8a-a349-8d91e2cc4dd4"
    )
    await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "client_a",
        title: "Matter B",
        courtId: "SHC",
        classification: "internal",
        memberUserIds: ["clerk_a"],
      },
      "f2fb7e68-3fdb-4f2b-b1ae-8f70ff1769fb"
    )

    const pageOne = await get(new URLSearchParams({ userId: "clerk_a", limit: "1", cursor: "0" }))
    expect(pageOne.status).toBe(200)
    const one = (await pageOne.json()) as {
      items: Array<{ id: string }>
      nextCursor: string | null
      total: number
    }
    expect(one.items).toHaveLength(1)
    expect(one.total).toBe(2)
    expect(one.nextCursor).toBe("1")

    const pageTwo = await get(new URLSearchParams({ userId: "clerk_a", limit: "1", cursor: "1" }))
    const two = (await pageTwo.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(two.items).toHaveLength(1)
    expect(two.nextCursor).toBeNull()
  })

  it("keeps firm data isolated in list responses", async () => {
    const createdA = await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "client_a",
        title: "Firm A only matter",
        courtId: "SHC",
        classification: "internal",
      },
      "2b3033e2-a7cc-438e-93b5-2a8e3ec2433e"
    )
    expect(createdA.status).toBe(200)
    const createdAJson = (await createdA.json()) as { result: { matter: { id: string } } }
    const matterAId = createdAJson.result.matter.id

    // Matter creation requires a known client identity in the firm; seed firm B's client.
    getRuntimeStore().users.set("client_b", {
      id: "client_b",
      firmId: "firmB",
      role: "client",
      clearanceLevel: "internal",
    })
    const createdB = await post(
      {
        action: "create",
        actorId: "partner_b",
        firmId: "firmB",
        clientId: "client_b",
        title: "Firm B only matter",
        courtId: "LHC",
        classification: "internal",
      },
      "042cb8fc-c14a-41e8-9d7a-e45258e07f6f"
    )
    expect(createdB.status).toBe(200)
    const createdBJson = (await createdB.json()) as { result: { matter: { id: string } } }
    const matterBId = createdBJson.result.matter.id

    const listA = await get(new URLSearchParams({ userId: "partner_a", limit: "10", cursor: "0" }))
    expect(listA.status).toBe(200)
    const listAJson = (await listA.json()) as { items: Array<{ id: string }> }
    expect(listAJson.items.some((item) => item.id === matterAId)).toBe(true)
    expect(listAJson.items.some((item) => item.id === matterBId)).toBe(false)
  })

  it("records case numbers and keeps REJECT for malformed numbers", async () => {
    const create = await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "client_a",
        title: "Case recording matter",
        courtId: "SHC",
        classification: "internal",
      },
      "b5c59859-7667-4e1f-bfea-3188eac89e53"
    )
    const created = (await create.json()) as { result: { matter: { id: string } } }
    const matterId = created.result.matter.id

    const ok = await post(
      {
        action: "record_case_number",
        actorId: "partner_a",
        matterId,
        courtId: "SHC",
        raw: "C.P. No. D-1234 of 2025",
      },
      "3222a8a4-efbd-4728-b7bb-d212b64955ac"
    )
    const okJson = (await ok.json()) as {
      result: { result: { status: string; canonical?: string } }
    }
    expect(okJson.result.result.status).toBe("OK")
    expect(okJson.result.result.canonical).toBe("CP D-1234/2025")

    const bad = await post(
      {
        action: "record_case_number",
        actorId: "partner_a",
        matterId,
        courtId: "SHC",
        raw: "CP 1234",
      },
      "2a7f3448-b2f0-44db-b89e-8e3dcefc81b2"
    )
    const badJson = (await bad.json()) as { result: { result: { status: string } } }
    expect(badJson.result.result.status).toBe("REJECT")
  })

  it("rejects cross-firm and low-privilege matter writes", async () => {
    const crossFirm = await post(
      {
        action: "create",
        actorId: "partner_b",
        firmId: "firmA",
        clientId: "client_a",
        title: "Cross firm",
        courtId: "SHC",
        classification: "internal",
      },
      "a115359e-7fed-43eb-8171-38f68dcf5d89"
    )
    expect(crossFirm.status).toBe(400)

    const clientDenied = await post(
      {
        action: "create",
        actorId: "client_a",
        firmId: "firmA",
        clientId: "client_a",
        title: "Client cannot open",
        courtId: "SHC",
        classification: "internal",
      },
      "a8a71f9f-0357-4f29-8e72-c236e5600a4f"
    )
    expect(clientDenied.status).toBe(400)
  })

  it("rejects create when client identity belongs to another firm", async () => {
    const crossFirmClient = await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "partner_b",
        title: "Invalid cross-firm client link",
        courtId: "SHC",
        classification: "internal",
      },
      "3ca4ea75-7f8a-48f6-b356-6ed0fb2609c9"
    )
    expect(crossFirmClient.status).toBe(400)
    const json = (await crossFirmClient.json()) as { error: string }
    expect(json.error).toBe("cross-firm client denied")

    const nonClientIdentity = await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "associate_a",
        title: "Invalid non-client identity link",
        courtId: "SHC",
        classification: "internal",
      },
      "ec8656a9-c58e-4acc-aa2e-37bb2b64188b"
    )
    expect(nonClientIdentity.status).toBe(400)
    const nonClientJson = (await nonClientIdentity.json()) as { error: string }
    expect(nonClientJson.error).toBe("clientId must reference a client user")
  })

  it("denies confirm and case-number writes for non-members", async () => {
    const create = await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "client_a",
        title: "Membership scoped matter",
        courtId: "SHC",
        classification: "internal",
      },
      "73130bb2-a066-4ff1-9243-41e56f8503a2"
    )
    expect(create.status).toBe(200)
    const created = (await create.json()) as { result: { matter: { id: string } } }
    const matterId = created.result.matter.id

    const confirmDenied = await post(
      {
        action: "confirm_engagement",
        actorId: "associate_a",
        matterId,
      },
      "94f7f2d4-97cf-4190-a78d-7f6f47d19859"
    )
    expect(confirmDenied.status).toBe(400)
    const confirmJson = (await confirmDenied.json()) as { error: string }
    expect(confirmJson.error).toBe("actor is not a member of this matter")

    const caseNoDenied = await post(
      {
        action: "record_case_number",
        actorId: "associate_a",
        matterId,
        courtId: "SHC",
        raw: "C.P. No. D-1234 of 2025",
      },
      "6975535f-8ea2-4f8b-b91d-f6f4a8b6e8d4"
    )
    expect(caseNoDenied.status).toBe(400)
    const caseNoJson = (await caseNoDenied.json()) as { error: string }
    expect(caseNoJson.error).toBe("actor is not a member of this matter")
  })

  it("writes audit entries for create + confirm + case number operations", async () => {
    const create = await post(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "client_a",
        title: "Audit trail matter",
        courtId: "SHC",
        classification: "internal",
      },
      "0daf8ea2-047f-45ba-a6cc-c525eb7f8c49"
    )
    const created = (await create.json()) as { result: { matter: { id: string } } }
    const matterId = created.result.matter.id

    const confirm = await post(
      {
        action: "confirm_engagement",
        actorId: "partner_a",
        matterId,
      },
      "9debd22b-ecf2-4d18-9892-c2ff8ebce254"
    )
    expect(confirm.status).toBe(200)

    const caseNo = await post(
      {
        action: "record_case_number",
        actorId: "partner_a",
        matterId,
        courtId: "SHC",
        raw: "C.P. No. D-1234 of 2025",
      },
      "4f744fec-e35f-46b8-b03b-52d656843b75"
    )
    expect(caseNo.status).toBe(200)

    const store = getRuntimeStore()
    const actions = store.audit.map((entry) => entry.action)
    expect(actions).toContain("matter_create")
    expect(actions).toContain("matter_confirm_engagement")
    expect(actions).toContain("matter_record_case_number")
  })
})
