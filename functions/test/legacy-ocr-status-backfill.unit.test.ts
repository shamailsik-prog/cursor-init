import { describe, expect, it } from "vitest"
import { planLegacyOcrStatusBackfill } from "@/platform/persistence/legacyOcrStatusBackfill"

describe("legacyOcrStatusBackfill", () => {
  it("stamps only legacy upload rows that still lack ocrStatus", () => {
    const plan = planLegacyOcrStatusBackfill([
      { id: "legacy", data: { jobType: "ocr", firmId: "f1", documentId: "d1" } },
      { id: "queued", data: { jobType: "ocr", firmId: "f1", ocrStatus: "queued" } },
      { id: "engine", data: { jobType: "d3.ocr", engine: "p2", firmId: "f1" } },
    ])
    expect(plan.stamp).toEqual([{ id: "legacy", patch: { ocrStatus: "queued" } }])
    expect(plan.complete).toEqual(["jobs/queued", "jobs/engine"])
  })
})
