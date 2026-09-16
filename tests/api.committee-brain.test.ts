import { afterEach, describe, expect, it } from "vitest"
import { POST } from "@/app/api/p1/committee-brain/route"
import { setTransportForTests } from "@/platform/p1/internalAICaller"

afterEach(() => {
  setTransportForTests(null)
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
          body: "hello",
          classification: "public",
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  it("refuses unknown classification", async () => {
    const res = await post({
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
})
