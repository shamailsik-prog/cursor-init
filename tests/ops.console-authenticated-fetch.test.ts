import { describe, expect, it, vi } from "vitest"
import { executeConsoleApiCall } from "@/lib/console/execute-console-api-call"

describe("operator console authenticated fetch", () => {
  it("sends Authorization Bearer and X-Firm-Id on Next API calls", async () => {
    let capturedUrl = ""
    let capturedInit: RequestInit | undefined
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input)
      capturedInit = init
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    await executeConsoleApiCall(
      { idToken: "test-jwt-token", firmId: "firmA" },
      {
        method: "GET",
        path: "/api/d2/ops-reporting",
        query: { actorId: "partner_a", limit: 1 },
      },
      { fetchImpl }
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(capturedUrl).toContain("/api/d2/ops-reporting")
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get("Authorization")).toBe("Bearer test-jwt-token")
    expect(headers.get("X-Firm-Id")).toBe("firmA")
  })

  it("routes committee brain POST to Functions with the same auth headers", async () => {
    let capturedInit: RequestInit | undefined
    const functionsFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ result: { blocked: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const result = await executeConsoleApiCall(
      { idToken: "brain-token", firmId: "firmA" },
      {
        method: "POST",
        path: "/api/p1/committee-brain",
        body: {
          actorId: "partner_a",
          body: "test",
          classification: "internal",
          purpose: "ops-audit",
          partyNames: ["A"],
        },
      },
      { functionsFetchImpl: functionsFetch }
    )
    expect(result.transport).toBe("functions")
    expect(functionsFetch).toHaveBeenCalledTimes(1)
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get("Authorization")).toBe("Bearer brain-token")
    expect(headers.get("X-Firm-Id")).toBe("firmA")
    expect(headers.get("Idempotency-Key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })

  it("operator console path: missing Bearer yields unauthorized (FA-F02-003)", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (!headers.get("Authorization")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const result = await executeConsoleApiCall(
      { idToken: null, firmId: "firmA" },
      {
        method: "GET",
        path: "/api/d2/ops-reporting",
        query: { actorId: "partner_a", limit: 1 },
      },
      { fetchImpl }
    )
    expect(result.status).toBe(401)
    expect(result.ok).toBe(false)
    expect(fetchImpl).toHaveBeenCalled()
  })

  it("rejects invalid committee-brain payloads without calling Next fetch", async () => {
    const nextFetch = vi.fn(async () => new Response("{}", { status: 200 }))
    const result = await executeConsoleApiCall(
      { idToken: "brain-token", firmId: "firmA" },
      {
        method: "POST",
        path: "/api/p1/committee-brain",
        body: { body: 42, classification: "internal" },
      },
      { fetchImpl: nextFetch, functionsFetchImpl: vi.fn() }
    )
    expect(result.status).toBe(400)
    expect(result.transport).toBe("functions")
    expect(nextFetch).not.toHaveBeenCalled()
  })
})
