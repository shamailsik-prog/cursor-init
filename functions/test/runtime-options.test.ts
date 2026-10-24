import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const LAYER_FLAGS = ["CORE_ENABLED", "LEGACY_GOVERNANCE_CHAINS", "L17_2_ENABLED"]
const RUNTIME_ACCOUNT = "sikander-functions@"
// FA-D3C-002: p1CorpusEmbedding's caller is the corpus service in a separate cloud project (L17.12 step 65), so internal
// ingress cannot reach it; it is ALLOW_ALL, IAM-private (invoker "private") and verifies its OIDC caller in code.
const HTTP_ALLOW_ALL = ["api", "health", "p1CorpusEmbedding"] as const

describe("F32 runtime options on every export", () => {
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
    vi.resetModules()
  })

  // Audit F34 adds p1TraceExportReconciler and FA-D3C-002 adds p1CorpusEmbedding: 16 exports.
  it("pins memory, concurrency, identity, caps and ingress on all 16 exports", async () => {
    vi.resetModules()
    const index = (await import("../src/index")) as unknown as Record<
      string,
      {
        __endpoint?: {
          availableMemoryMb?: number | null
          concurrency?: number | null
          minInstances?: number | null
          maxInstances?: number | null
          serviceAccountEmail?: string | null
          timeoutSeconds?: number | null
          ingressSettings?: string | null
          httpsTrigger?: unknown
          taskQueueTrigger?: { invoker?: string[] }
        }
      }
    >
    const names = Object.keys(index).sort()
    expect(names).toEqual([
      "api",
      "auditOutboxReconciler",
      "d1AutoConfirmTick",
      "d1ConflictClientWritten",
      "d1ConflictIndexChunkWritten",
      "d1ConflictPartyWritten",
      "d1ConflictReindexTick",
      "health",
      "jobSweeper",
      "jobWorker",
      "ocrLegacySweep",
      "onEventCreated",
      "onJobCreated",
      "p1CorpusEmbedding",
      "p1ReservationReconciler",
      "p1TraceExportReconciler",
      "retentionApplyTick",
      "retentionDeletionWatch",
    ])

    for (const name of names) {
      const e = index[name].__endpoint
      expect(e, name).toBeDefined()
      expect([name, e!.availableMemoryMb], name).toEqual([name, 256])
      expect([name, e!.concurrency], name).toEqual([name, 1])
      expect([name, e!.minInstances], name).toEqual([name, 0])
      expect([name, e!.maxInstances], name).not.toEqual([name, null])
      expect([name, e!.serviceAccountEmail], name).toEqual([name, RUNTIME_ACCOUNT])
      expect([name, e!.timeoutSeconds], name).not.toEqual([name, null])
      if ((HTTP_ALLOW_ALL as readonly string[]).includes(name)) {
        if (name === "health" || name === "p1CorpusEmbedding") expect([name, e!.ingressSettings]).toEqual([name, "ALLOW_ALL"])
      } else {
        expect([name, e!.ingressSettings], name).toEqual([name, "ALLOW_INTERNAL_ONLY"])
      }
    }

    expect(index.jobWorker.__endpoint!.taskQueueTrigger!.invoker).toEqual([RUNTIME_ACCOUNT])
    expect((index.p1CorpusEmbedding.__endpoint!.httpsTrigger as { invoker?: string[] }).invoker).toEqual(["private"])
  })
})
