import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  healthHandler,
  healthRuntime,
  livezHandler,
  readyzHandler,
  recordHealthCounts,
  resetHealthCache,
} from "../src/health"

function mockRes() {
  const res = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}

describe("F44 health, liveness and readiness handlers", () => {
  beforeEach(() => {
    resetHealthCache()
    delete healthRuntime.deps
  })

  afterEach(() => {
    resetHealthCache()
    delete healthRuntime.deps
    vi.restoreAllMocks()
  })

  it("/livez responds 200 with status ok and region asia-south1 without touching DB or queue", async () => {
    const probeFirestore = vi.fn(async () => {
      throw new Error("firestore should not be called on /livez")
    })
    const probeQueue = vi.fn(async () => {
      throw new Error("queue should not be called on /livez")
    })
    healthRuntime.deps = { probeFirestore, probeQueue }

    const res = mockRes()
    await healthHandler({ path: "/livez" } as never, res as never)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "ok", region: "asia-south1" })
    expect(probeFirestore).not.toHaveBeenCalled()
    expect(probeQueue).not.toHaveBeenCalled()

    const directRes = mockRes()
    livezHandler({} as never, directRes as never)
    expect(directRes.status).toHaveBeenCalledWith(200)
    expect(directRes.json).toHaveBeenCalledWith({ status: "ok", region: "asia-south1" })
  })

  it("/readyz responds 200 when Firestore and queue probes succeed and reuses cached counts within TTL", async () => {
    let now = 1_700_000_000_000
    const probeFirestore = vi.fn(async () => undefined)
    const probeQueue = vi.fn(async () => undefined)
    const readQueuedCount = vi.fn(async () => 7)
    healthRuntime.deps = {
      probeFirestore,
      probeQueue,
      readQueuedCount,
      clock: () => now,
      timeoutMs: 500,
      countsTtlMs: 30_000,
    }

    const res1 = mockRes()
    await healthHandler({ path: "/readyz" } as never, res1 as never)
    expect(res1.status).toHaveBeenCalledWith(200)
    expect(res1.json).toHaveBeenCalledWith({
      status: "ok",
      region: "asia-south1",
      db_connected: true,
      queue_ready: true,
      checks: { firestore: "ok", queue: "ok" },
      counts: { queuedJobs: 7 },
      counts_updated_at: new Date(1_700_000_000_000).toISOString(),
      counts_age_ms: 0,
      checked_at: new Date(1_700_000_000_000).toISOString(),
    })
    expect(readQueuedCount).toHaveBeenCalledTimes(1)

    now += 5_000
    const res2 = mockRes()
    await readyzHandler({ path: "/readyz" } as never, res2 as never)
    expect(res2.status).toHaveBeenCalledWith(200)
    expect(res2.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        db_connected: true,
        queue_ready: true,
        counts: { queuedJobs: 7 },
        counts_age_ms: 5_000,
      })
    )
    expect(readQueuedCount).toHaveBeenCalledTimes(1)
  })

  it("/readyz responds 503 when Firestore is unreachable and never leaks internal error details", async () => {
    recordHealthCounts({ queuedJobs: 3 }, 1_700_000_000_000)
    healthRuntime.deps = {
      probeFirestore: async () => {
        throw new Error("firestore://secret-credentials@internal-host:8080 connection refused")
      },
      probeQueue: async () => undefined,
      readQueuedCount: async () => 99,
      clock: () => 1_700_000_002_000,
      timeoutMs: 500,
      countsTtlMs: 30_000,
    }

    const res = mockRes()
    await healthHandler({ path: "/readyz" } as never, res as never)

    expect(res.status).toHaveBeenCalledWith(503)
    const payload = res.json.mock.calls[0][0]
    expect(payload).toEqual({
      status: "degraded",
      region: "asia-south1",
      db_connected: false,
      queue_ready: true,
      checks: { firestore: "unavailable", queue: "ok" },
      counts: { queuedJobs: 3 },
      counts_updated_at: new Date(1_700_000_000_000).toISOString(),
      counts_age_ms: 2_000,
      checked_at: new Date(1_700_000_002_000).toISOString(),
    })
    expect(JSON.stringify(payload)).not.toContain("secret-credentials")
    expect(JSON.stringify(payload)).not.toContain("internal-host")
  })

  it("/readyz responds 503 when queue probe fails or a dependency probe times out", async () => {
    const resQueueFail = mockRes()
    await readyzHandler({ path: "/readyz" } as never, resQueueFail as never, {
      probeFirestore: async () => undefined,
      probeQueue: async () => {
        throw new Error("queue down")
      },
      readQueuedCount: async () => 0,
      clock: () => 1_700_000_000_000,
      timeoutMs: 100,
    })
    expect(resQueueFail.status).toHaveBeenCalledWith(503)
    expect(resQueueFail.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "degraded",
        db_connected: true,
        queue_ready: false,
        checks: { firestore: "ok", queue: "unavailable" },
      })
    )

    const resTimeout = mockRes()
    await readyzHandler({ path: "/readyz" } as never, resTimeout as never, {
      probeFirestore: () => new Promise(() => undefined),
      probeQueue: async () => undefined,
      readQueuedCount: async () => 0,
      clock: () => 1_700_000_000_000,
      timeoutMs: 30,
    })
    expect(resTimeout.status).toHaveBeenCalledWith(503)
    expect(resTimeout.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "degraded",
        db_connected: false,
        queue_ready: true,
      })
    )
  })
})
