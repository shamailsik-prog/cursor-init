// Review round 1, finding 2: jobs never carried matterId, so the R-2 jobs rule never applied.
import { describe, expect, it } from "vitest"
import { newStore } from "@/platform/spine/store"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { planJobMatterBackfill } from "@/platform/persistence/jobMatterBackfill"

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
  const docs = new Map<string, { matterId: string | null }>([
    ["d1", { matterId: "m1" }],
    ["d2", { matterId: null }],
  ])
  const lookup = async (id: string) => docs.get(id) ?? null

  it("fills matterId from the job's document; skips rows that already have it; reports orphans", async () => {
    const plan = await planJobMatterBackfill(
      [
        { id: "j1", documentId: "d1" },
        { id: "j2", documentId: "d2" },
        { id: "j3", documentId: "d1", matterId: "m1" },
        { id: "j4", documentId: "gone" },
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
    const rows: Array<{ id: string; documentId: string; matterId?: string | null }> = [
      { id: "j1", documentId: "d1" },
      { id: "j2", documentId: "d2" },
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
