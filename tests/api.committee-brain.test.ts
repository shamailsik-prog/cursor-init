import { afterEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/p1/committee-brain/route"
import { setTransportForTests } from "@/platform/p1/internalAICaller"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

afterEach(() => {
  setTransportForTests(null)
  resetRuntimeStoreForTests()
})

function post(body: unknown, key = "dddddddd-dddd-4ddd-8ddd-dddddddddddd") {
  return POST(
    new Request("http://127.0.0.1/api/p1/committee-brain", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  )
}

describe("POST /api/p1/committee-brain", () => {
  it("requires Idempotency-Key", async () => {
    const res = await POST(
      new Request("http://127.0.0.1/api/p1/committee-brain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId: "partner_a",
          body: "hello",
          classification: "public",
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  it("reuses response only when key and payload match", async () => {
    const key = "11111111-1111-4111-8111-111111111111"
    const payload = {
      body: "hello",
      classification: "public",
      actorId: "partner_a",
      purpose: "summarise",
    }
    const first = await post(payload, key)
    const second = await post(payload, key)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { reused: boolean }
    const b = (await second.json()) as { reused: boolean }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
  })

  it("rejects reusing a key with a different payload", async () => {
    const key = "22222222-2222-4222-8222-222222222222"
    const first = await post(
      {
        body: "hello",
        classification: "public",
        actorId: "partner_a",
        purpose: "summarise",
      },
      key
    )
    const second = await post(
      {
        body: "hello again",
        classification: "public",
        actorId: "partner_a",
        purpose: "summarise",
      },
      key
    )
    expect(first.status).toBe(200)
    expect(second.status).toBe(409)
    const json = (await second.json()) as { error: string }
    expect(json.error).toMatch(/different request payload/i)
  })

  it("refuses unknown classification", async () => {
    const res = await post({
      actorId: "partner_a",
      body: "hello",
      classification: "super-secret",
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toMatch(/classification/)
  })

  it("returns a masked outbound payload and stays blocked without credentials", async () => {
    const cnic = "42101-1234567-1"
    const party = "Muhammad Ali Khan"
    const res = await post({
      body: `Counsel for ${party}, CNIC ${cnic}`,
      classification: "public",
      actorId: "partner_a",
      purpose: "summarise",
      partyNames: [party],
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      result: {
        blocked: boolean
        outbound: { body: string; metadata: { classification: string } }
        agent: string
      }
    }
    expect(json.result.blocked).toBe(true)
    expect(json.result.agent).toBe("sikander-ai")
    expect(json.result.outbound.body).not.toContain(cnic)
    expect(json.result.outbound.body).not.toContain(party)
    expect(json.result.outbound.metadata.classification).toBe("public")
  })

  it("blocks privileged without sending to a transport", async () => {
    let sent = false
    setTransportForTests({
      async send() {
        sent = true
        return { text: "no" }
      },
    })
    const res = await post(
      {
        actorId: "partner_a",
        body: "privileged memo",
        classification: "privileged",
      },
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { blocked: boolean } }
    expect(json.result.blocked).toBe(true)
    expect(sent).toBe(false)
  })

  it("lists persisted outputs with actor-bound firm and clearance filtering", async () => {
    const first = await post(
      {
        actorId: "partner_a",
        body: "internal summary",
        classification: "internal",
      },
      "b8f0d1f8-6b5c-4384-844a-1a6485daed74"
    )
    expect(first.status).toBe(200)
    const second = await post(
      {
        actorId: "partner_a",
        body: "privileged summary",
        classification: "privileged",
      },
      "f5fb869a-e344-4462-99f7-e0f0762ec8eb"
    )
    expect(second.status).toBe(200)

    const clerkList = await GET(
      new Request("http://127.0.0.1/api/p1/committee-brain?actorId=clerk_a&limit=10&cursor=0")
    )
    expect(clerkList.status).toBe(200)
    const clerkJson = (await clerkList.json()) as {
      items: Array<{ classification: string }>
      total: number
    }
    expect(clerkJson.total).toBe(1)
    expect(clerkJson.items[0]?.classification).toBe("internal")

    const partnerList = await GET(
      new Request("http://127.0.0.1/api/p1/committee-brain?actorId=partner_a&limit=10&cursor=0")
    )
    expect(partnerList.status).toBe(200)
    const partnerJson = (await partnerList.json()) as {
      items: Array<{ classification: string }>
      total: number
    }
    expect(partnerJson.total).toBe(2)
    expect(partnerJson.items.some((row) => row.classification === "privileged")).toBe(true)
  })
})
