import { describe, expect, it } from "vitest"
import { POST } from "@/app/api/g0/normalise/route"

function post(body: unknown, key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
  return POST(
    new Request("http://127.0.0.1/api/g0/normalise", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  )
}

describe("POST /api/g0/normalise", () => {
  it("normalises SHC C.P. No. D-1234 of 2025 to CP D-1234/2025", async () => {
    const res = await post({
      raw: "C.P. No. D-1234 of 2025",
      courtId: "SHC",
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      result: { status: string; canonical: string }
      reused: boolean
    }
    expect(json.result.status).toBe("OK")
    expect(json.result.canonical).toBe("CP D-1234/2025")
    expect(json.reused).toBe(false)
  })

  it("reuses the cached body for the same UUID v4 key and payload", async () => {
    const key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    const first = await post({ raw: "C.P. No. D-1234 of 2025", courtId: "SHC" }, key)
    const second = await post({ raw: "C.P. No. D-1234 of 2025", courtId: "SHC" }, key)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = await first.json()
    const b = await second.json()
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(b.result.canonical).toBe("CP D-1234/2025")
  })

  it("rejects reusing the same key for a different payload", async () => {
    const key = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    const first = await post({ raw: "C.P. No. D-1234 of 2025", courtId: "SHC" }, key)
    const second = await post({ raw: "Cr. Bail Appln. No. 456 of 2026", courtId: "SHC" }, key)
    expect(first.status).toBe(200)
    expect(second.status).toBe(422) // idempotency_key_reused (final audit F4: functions semantics)
    const json = (await second.json()) as { error: string }
    expect(json.error).toMatch(/different request payload/i)
  })

  it("rejects invalid JSON with 400 instead of throwing", async () => {
    const res = await post("{not-json", "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toMatch(/invalid JSON/i)
  })

  it("rejects a non-UUID idempotency key", async () => {
    const res = await post({ raw: "C.P. No. D-1234 of 2025", courtId: "SHC" }, "nope")
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toMatch(/UUID v4/)
  })
})
