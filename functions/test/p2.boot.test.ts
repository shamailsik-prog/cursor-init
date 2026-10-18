import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SUBSCRIBERS } from "../src/p2/fanout"
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
    expect(Object.keys(index).sort()).toEqual(["api", "auditOutboxReconciler", "d1AutoConfirmTick", "d1ConflictReindexTick", "health", "jobSweeper", "jobWorker", "onEventCreated", "onJobCreated", "p1ReservationReconciler"])
    for (const n of ["onJobCreated", "onEventCreated", "jobWorker", "jobSweeper"]) expect([n, index[n].__endpoint.region]).toEqual([n, ["asia-south1"]])
    expect(index.onJobCreated.__endpoint.eventTrigger).toMatchObject({
      eventType: "google.cloud.firestore.document.v1.created",
      eventFilterPathPatterns: { document: "jobs/{jobId}" },
    })
    expect(index.onEventCreated.__endpoint.eventTrigger).toMatchObject({
      eventType: "google.cloud.firestore.document.v1.created",
      eventFilterPathPatterns: { document: "events/{eventId}" },
      retry: true,
    })
    expect(index.jobWorker.__endpoint).toMatchObject({
      timeoutSeconds: 300,
      taskQueueTrigger: {
        retryConfig: { maxAttempts: 3, minBackoffSeconds: 10, maxBackoffSeconds: 60 },
        rateLimits: { maxConcurrentDispatches: 10, maxDispatchesPerSecond: 5 },
      },
    })
    expect([index.d1AutoConfirmTick.__endpoint.region, index.d1AutoConfirmTick.__endpoint.scheduleTrigger]).toEqual([["asia-south1"], expect.objectContaining({ schedule: "15 2 * * *", timeZone: "Asia/Karachi" })])
    // O-43 (P3-51): a failed daily tick is retried by the scheduler; the runs are idempotent per firm and day.
    expect(index.d1AutoConfirmTick.__endpoint.scheduleTrigger).toMatchObject({ retryConfig: { retryCount: 3, minBackoffSeconds: 60, maxBackoffSeconds: 600 } })
    // Audit F37: the daily conflict name index reconciliation tick, after auto-confirm, with the same retry.
    expect([index.d1ConflictReindexTick.__endpoint.region, index.d1ConflictReindexTick.__endpoint.scheduleTrigger]).toEqual([["asia-south1"], expect.objectContaining({ schedule: "35 2 * * *", timeZone: "Asia/Karachi" })])
    expect(index.d1ConflictReindexTick.__endpoint.scheduleTrigger).toMatchObject({ retryConfig: { retryCount: 3, minBackoffSeconds: 60, maxBackoffSeconds: 600 } })
    // The sweeper sets no retry count: the next minute's sweep is its retry.
    expect(index.jobSweeper.__endpoint.scheduleTrigger).not.toMatchObject({ retryConfig: { retryCount: expect.anything() } })
    expect(index.jobSweeper.__endpoint.scheduleTrigger).toMatchObject({ schedule: "every 1 minutes" })
    // Pinned below the one-minute schedule, not left to the platform default.
    expect(index.jobSweeper.__endpoint.timeoutSeconds).toBe(45)
    // Audit F07, F08: the P1 lease reconciler follows the sweeper's pattern: every minute, in asia-south1, a pinned
    // 45 s timeout, no retry count (the next minute's run is its retry), and no HTTP or callable trigger.
    expect(index.p1ReservationReconciler.__endpoint).toMatchObject({ region: ["asia-south1"], timeoutSeconds: 45, scheduleTrigger: { schedule: "every 1 minutes" } })
    expect(index.p1ReservationReconciler.__endpoint.scheduleTrigger).not.toMatchObject({ retryConfig: { retryCount: expect.anything() } })
    expect([index.p1ReservationReconciler.__endpoint.httpsTrigger, index.p1ReservationReconciler.__endpoint.callableTrigger]).toEqual([undefined, undefined])
    // Audit F11: the audit-outbox reconciler follows the same pattern.
    expect(index.auditOutboxReconciler.__endpoint).toMatchObject({ region: ["asia-south1"], timeoutSeconds: 45, scheduleTrigger: { schedule: "every 1 minutes" } })
    expect(index.auditOutboxReconciler.__endpoint.scheduleTrigger).not.toMatchObject({ retryConfig: { retryCount: expect.anything() } })
    expect([index.auditOutboxReconciler.__endpoint.httpsTrigger, index.auditOutboxReconciler.__endpoint.callableTrigger]).toEqual([undefined, undefined])
    // The worker stays IAM-private (only Cloud Tasks, with OIDC, may invoke it): firebase-functions
    // does not verify the caller itself, so an invoker set here or globally (e.g. "public") must fail.
    expect(index.jobWorker.__endpoint.taskQueueTrigger).not.toHaveProperty("invoker")
    for (const n of ["onJobCreated", "onEventCreated", "jobWorker", "jobSweeper"]) {
      expect([n, index[n].__endpoint.httpsTrigger, index[n].__endpoint.callableTrigger]).toEqual([n, undefined, undefined])
    }
    expect([...JOB_HANDLERS.keys()]).toEqual(["platform.diagnostic", "d1.unmerge.links", "d1.unmerge.checks", "d1.autoconfirm", "d1.conflict.reindex"])
    expect(SUBSCRIBERS).toEqual([])
  })

  it("the router builds with every layer flag off and serves exactly the four /api/platform/jobs routes (P2 is CORE, L8456)", async () => {
    // Loaded after the flags are off, so a flag read at module load or route building would show here.
    vi.resetModules()
    const { ROUTES, createRouter } = await import("../src/http/router")
    expect(() => createRouter(ROUTES)).not.toThrow()
    const jobs = ROUTES.filter((r) => r.path.startsWith("/api/platform/jobs/")).map((r) => `${r.method} ${r.path} ${r.kind}`)
    expect(jobs.sort()).toEqual(
      [
        "GET /api/platform/jobs/listJobs general",
        "GET /api/platform/jobs/getJob general",
        "POST /api/platform/jobs/retryFailedJob general",
        "POST /api/platform/jobs/cancelJob general",
      ].sort()
    )
  })
})
