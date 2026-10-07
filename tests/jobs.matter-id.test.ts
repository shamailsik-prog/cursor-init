// Review round 1, finding 2: jobs never carried matterId, so the R-2 jobs rule never applied.
import { describe, expect, it } from "vitest"
import { newStore } from "@/platform/spine/store"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import {
  applyJobMatterBackfill,
  planJobMatterBackfill,
  type JobMatterBackfillStore,
} from "@/platform/persistence/jobMatterBackfill"

describe("jobs carry the document's matterId", () => {
  it("uploadDocument writes matterId on the OCR job (matter and loose vault)", () => {
    const store = newStore()
    const inMatter = uploadDocument(store, {
      firmId: "firmA", matterId: "m1", bytes: Buffer.from("a"), sourceChannel: "web",
      classification: "privileged", idempotencyKey: "k1",
    })
    const loose = uploadDocument(store, {
      firmId: "firmA", matterId: null, bytes: Buffer.from("b"), sourceChannel: "bulk",
      classification: "confidential", idempotencyKey: "k2",
    })
    expect(store.jobs.find((j) => j.documentId === inMatter.docId)?.matterId).toBe("m1")
    expect(store.jobs.find((j) => j.documentId === loose.docId)?.matterId).toBeNull()
  })
})

describe("backfill plan for legacy job rows (scripts/backfill-job-matter-ids.ts)", () => {
  const docs = new Map<string, { firmId: string; matterId: string | null }>([
    ["d1", { firmId: "firmA", matterId: "m1" }],
    ["d2", { firmId: "firmA", matterId: null }],
    ["dB", { firmId: "firmB", matterId: "mB" }],
  ])
  const lookup = async (id: string) => docs.get(id) ?? null

  it("fills matterId from the job's document; skips rows that already have it; reports orphans", async () => {
    const plan = await planJobMatterBackfill(
      [
        { id: "j1", firmId: "firmA", documentId: "d1" },
        { id: "j2", firmId: "firmA", documentId: "d2" },
        { id: "j3", firmId: "firmA", documentId: "d1", matterId: "m1" },
        { id: "j4", firmId: "firmA", documentId: "gone" },
      ],
      lookup
    )
    expect(plan.updates).toEqual([
      { id: "j1", matterId: "m1" },
      { id: "j2", matterId: null },
    ])
    expect(plan.alreadySet).toEqual(["j3"])
    expect(plan.orphans).toEqual(["j4"])
  })

  it("is idempotent: applying the plan and re-planning yields no updates", async () => {
    const rows: Array<{ id: string; firmId: string; documentId: string; matterId?: string | null }> = [
      { id: "j1", firmId: "firmA", documentId: "d1" },
      { id: "j2", firmId: "firmA", documentId: "d2" },
    ]
    const first = await planJobMatterBackfill(rows, lookup)
    for (const u of first.updates) {
      const row = rows.find((r) => r.id === u.id)
      if (row) row.matterId = u.matterId
    }
    const second = await planJobMatterBackfill(rows, lookup)
    expect(second.updates).toEqual([])
    expect(second.alreadySet).toEqual(["j1", "j2"])
  })
})

// Final audit F7: firm mismatch is an orphan, each update re-checks matterId in a
// transaction, and every applied run appends one summary audit row.
describe("backfill hardening (final audit F7)", () => {
  const docs = new Map<string, { firmId: string; matterId: string | null }>([
    ["d1", { firmId: "firmA", matterId: "m1" }],
    ["dB", { firmId: "firmB", matterId: "mB" }],
  ])
  const lookup = async (id: string) => docs.get(id) ?? null

  it("a job pointing at another firm's document is an orphan, never given that firm's matterId", async () => {
    const plan = await planJobMatterBackfill([{ id: "job1", firmId: "firmA", documentId: "dB" }], lookup)
    expect(plan.updates).toEqual([])
    expect(plan.orphans).toEqual(["job1"])
  })

  it("a job or document without a firmId is an orphan (the firm cannot be checked)", async () => {
    const plan = await planJobMatterBackfill(
      [{ id: "job1", documentId: "d1" }],
      lookup
    )
    expect(plan.updates).toEqual([])
    expect(plan.orphans).toEqual(["job1"])
  })

  function fakeStore(jobs: Map<string, { matterId?: string | null }>) {
    const audit: Array<Record<string, unknown>> = []
    const store: JobMatterBackfillStore = {
      async setMatterIdIfUnset(jobId, matterId) {
        const job = jobs.get(jobId)
        if (!job || job.matterId !== undefined) return false
        job.matterId = matterId
        return true
      },
      async appendAudit(row) {
        audit.push(row)
      },
    }
    return { store, audit }
  }

  it("applies only rows whose matterId is still unset, and appends one summary audit row per run", async () => {
    const jobs = new Map<string, { matterId?: string | null }>([["j1", {}], ["j2", {}]])
    const plan = await planJobMatterBackfill(
      [
        { id: "j1", firmId: "firmA", documentId: "d1" },
        { id: "j2", firmId: "firmA", documentId: "d1" },
        { id: "j3", firmId: "firmA", documentId: "dB" },
      ],
      lookup
    )
    // j2 gets its matterId from elsewhere between plan and apply
    jobs.get("j2")!.matterId = "m_other"
    const { store, audit } = fakeStore(jobs)
    const result = await applyJobMatterBackfill(store, plan, { runId: "run1", now: 5 })
    expect(result.applied).toEqual(["j1"])
    expect(result.skipped).toEqual(["j2"])
    expect(jobs.get("j1")?.matterId).toBe("m1")
    expect(jobs.get("j2")?.matterId).toBe("m_other")
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      action: "job_matter_backfill",
      at: 5,
      appliedJobIds: ["j1"],
      skippedJobIds: ["j2"],
      orphanJobIds: ["j3"],
    })
    expect(String(audit[0]?.reason)).toContain("1 applied")
  })
})
