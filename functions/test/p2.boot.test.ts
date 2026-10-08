import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { JOB_HANDLERS } from "../src/p2/registry"

// The job runtime boots like the router (L18 §9.1 rule 4): every layer flag off, no network. The
// flags are the ones d1.boot.test.ts sets.
const LAYER_FLAGS = ["CORE_ENABLED", "LEGACY_GOVERNANCE_CHAINS", "L17_2_ENABLED"]

type Endpoint = {
  region?: string[]
  timeoutSeconds?: number
  eventTrigger?: Record<string, unknown>
  taskQueueTrigger?: Record<string, unknown>
  scheduleTrigger?: Record<string, unknown>
  httpsTrigger?: unknown
  callableTrigger?: unknown
}

describe("P2 boot (P3-5, P3-8)", () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const f of LAYER_FLAGS) {
      saved[f] = process.env[`SIKANDER_FLAG_${f}`]
      process.env[`SIKANDER_FLAG_${f}`] = "false"
    }
  })
  afterEach(() => {
    for (const f of LAYER_FLAGS) {
      if (saved[f] === undefined) delete process.env[`SIKANDER_FLAG_${f}`]
      else process.env[`SIKANDER_FLAG_${f}`] = saved[f]
    }
  })

  it("the index exports api, health and the job runtime functions, each in asia-south1 with its trigger kind", async () => {
    vi.resetModules()
    const index = (await import("../src/index")) as unknown as Record<string, { __endpoint: Endpoint }>
    expect(Object.keys(index).sort()).toEqual(["api", "health", "jobSweeper", "jobWorker", "onJobCreated"])
    for (const n of ["onJobCreated", "jobWorker", "jobSweeper"]) expect([n, index[n].__endpoint.region]).toEqual([n, ["asia-south1"]])
    expect(index.onJobCreated.__endpoint.eventTrigger).toMatchObject({
      eventType: "google.cloud.firestore.document.v1.created",
      eventFilterPathPatterns: { document: "jobs/{jobId}" },
    })
    expect(index.jobWorker.__endpoint).toMatchObject({
      timeoutSeconds: 300,
      taskQueueTrigger: {
        retryConfig: { maxAttempts: 3, minBackoffSeconds: 10, maxBackoffSeconds: 60 },
        rateLimits: { maxConcurrentDispatches: 10, maxDispatchesPerSecond: 5 },
      },
    })
    expect(index.jobSweeper.__endpoint.scheduleTrigger).toMatchObject({ schedule: "every 1 minutes" })
    // The worker stays IAM-private (only Cloud Tasks, with OIDC, may invoke it): firebase-functions
    // does not verify the caller itself, so an invoker set here or globally (e.g. "public") must fail.
    expect(index.jobWorker.__endpoint.taskQueueTrigger).not.toHaveProperty("invoker")
    for (const n of ["onJobCreated", "jobWorker", "jobSweeper"]) {
      expect([n, index[n].__endpoint.httpsTrigger, index[n].__endpoint.callableTrigger]).toEqual([n, undefined, undefined])
    }
    expect([...JOB_HANDLERS.keys()]).toEqual(["platform.diagnostic"])
  })
})
