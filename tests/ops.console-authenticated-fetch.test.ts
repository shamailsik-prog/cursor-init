import { readFileSync } from "node:fs"
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

  it("keeps operator console call-site wiring for authenticated fetch", () => {
    const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")
    expect(source).toContain("executeConsoleApiCall")
    expect(source).toContain('path: "/api/d2/ops-reporting"')
  })
})
