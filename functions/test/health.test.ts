import { afterEach, describe, expect, it, vi } from "vitest"
import type { Verdict } from "../src/health"

function mockRes() {
  const res = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}

describe("health contract report (F32 R9)", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it("responds 200 with status ok, region and contract verdicts when all checks pass", async () => {
    const { createHealthHandler } = await import("../src/health")
    const handler = createHealthHandler({
      env: { SIKANDER_INGRESS_SETTINGS: "ALLOW_INTERNAL_AND_GCLB", TRUSTED_PROXY_HOPS: "1", FIREBASE_CONFIG: '{"locationId":"asia-south1"}' },
      deployed: true,
      metadata: async () => ({ region: "asia-south1", serviceAccount: "sikander-functions@demo.iam.gserviceaccount.com" }),
      now: () => 0,
    })
    const res = mockRes()
    await handler({} as never, res as never)
    expect(res.status).toHaveBeenCalledWith(200)
    const body = res.json.mock.calls[0]?.[0] as { status: string; region: string; contract: Record<string, Verdict> }
    expect(body.status).toBe("ok")
    expect(body.region).toBe("asia-south1")
    for (const v of Object.values(body.contract)) expect(["ok", "violated", "unknown"]).toContain(v)
    expect(Object.values(body.contract).every((v) => v === "ok")).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/iam\.gserviceaccount|locationId/)
  })

  it("responds 503 unhealthy when any contract check is violated", async () => {
    const { createHealthHandler } = await import("../src/health")
    const handler = createHealthHandler({
      env: { SIKANDER_INGRESS_SETTINGS: "ALLOW_INTERNAL_AND_GCLB", TRUSTED_PROXY_HOPS: "1", FIREBASE_CONFIG: '{"locationId":"us-central1"}' },
      deployed: true,
      metadata: async () => ({ region: "asia-south1", serviceAccount: "sikander-functions@demo.iam.gserviceaccount.com" }),
      now: () => 0,
    })
    const res = mockRes()
    await handler({} as never, res as never)
    expect(res.status).toHaveBeenCalledWith(503)
    const body = res.json.mock.calls[0]?.[0] as { status: string; contract: Record<string, Verdict> }
    expect(body.status).toBe("unhealthy")
    expect(body.contract.database_location).toBe("violated")
  })

  it("treats unknown metadata as non-failing", async () => {
    const { createHealthHandler } = await import("../src/health")
    const handler = createHealthHandler({
      env: {},
      deployed: false,
      metadata: async () => ({}),
      now: () => 0,
    })
    const res = mockRes()
    await handler({} as never, res as never)
    expect(res.status).toHaveBeenCalledWith(200)
    const body = res.json.mock.calls[0]?.[0] as { contract: Record<string, Verdict> }
    expect(body.contract.region).toBe("unknown")
    expect(body.contract.runtime_identity).toBe("unknown")
  })

  it("caches the metadata probe for five minutes", async () => {
    const { createHealthHandler } = await import("../src/health")
    const metadata = vi.fn(async () => ({ region: "asia-south1", serviceAccount: "sikander-functions@x.iam.gserviceaccount.com" }))
    const handler = createHealthHandler({
      env: { FIREBASE_CONFIG: '{"locationId":"asia-south1"}' },
      deployed: false,
      metadata,
      now: () => 0,
    })
    const res1 = mockRes()
    const res2 = mockRes()
    await handler({} as never, res1 as never)
    await handler({} as never, res2 as never)
    expect(metadata).toHaveBeenCalledTimes(1)
  })

  it("times out a hanging metadata probe within 500 ms", async () => {
    vi.useFakeTimers()
    const { createHealthHandler } = await import("../src/health")
    const handler = createHealthHandler({
      env: {},
      deployed: false,
      metadata: () => new Promise(() => undefined),
      now: () => 0,
    })
    const res = mockRes()
    const p = handler({} as never, res as never)
    await vi.advanceTimersByTimeAsync(600)
    await p
    const body = res.json.mock.calls[0]?.[0] as { contract: Record<string, Verdict> }
    expect(body.contract.region).toBe("unknown")
    vi.useRealTimers()
  })
})
