// FA-F13-034: the matter-shape dry-run must name each row and the fields it would add, not only the counts.
import { describe, expect, it } from "vitest"

describe("F13 FA-F13-034: matter-shape dry-run names rows", () => {
  it("prints the counts line and one line per planned, complete, malformed and orphan row", async () => {
    const mod = await import("@/platform/persistence/matterShapeBackfill")
    const plan = {
      matters: [{ id: "m1", patch: { stage: "pre_filing", matterNo: null } }],
      members: [
        {
          id: "m1_u1",
          patch: { classification: "__matter_classification__", addedBy: null },
          matterId: "m1",
          firmId: "firmA",
          userId: "u1",
        },
      ],
      complete: ["matters/m9"],
      malformed: ["matters/bad"],
      orphans: ["matter_members/orphan"],
    }
    expect(mod.formatMatterShapeBackfillDryRun(plan)).toBe(
      [
        "[backfill-matter-shapes] DRY-RUN: 1 matters and 1 members to complete, 1 already complete, 1 malformed, 1 orphaned (left as they are)",
        "[backfill-matter-shapes] matters/m1 stage,matterNo",
        "[backfill-matter-shapes] matter_members/m1_u1 classification,addedBy",
        "[backfill-matter-shapes] complete matters/m9",
        "[backfill-matter-shapes] malformed matters/bad",
        "[backfill-matter-shapes] orphan matter_members/orphan",
      ].join("\n")
    )
  })
})
