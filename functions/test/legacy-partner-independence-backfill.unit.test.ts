import { describe, expect, it } from "vitest"
import {
  planLegacyPartnerIndependenceBackfill,
} from "@/platform/persistence/legacyPartnerIndependenceBackfill"

describe("legacyPartnerIndependenceBackfill", () => {
  const bootstrap = { founderUid: "F", firstFirmId: "firm1" }

  it("FA-F42-R1-006-003-001-002: missing flag without lineage stamps false", () => {
    const plan = planLegacyPartnerIndependenceBackfill([{ id: "L", data: { role: "partner", active: true, firmId: "firm1" } }], bootstrap)
    expect(plan.stamp).toEqual([{ id: "L", patch: { independentPartner: false } }])
  })

  it("bootstrap founder without flag stamps true", () => {
    const plan = planLegacyPartnerIndependenceBackfill(
      [{ id: "F", data: { role: "partner", active: true, firmId: "firm1" } }],
      bootstrap
    )
    expect(plan.stamp).toEqual([{ id: "F", patch: { independentPartner: true } }])
  })

  it("attested legacy partner without flag stamps true", () => {
    const plan = planLegacyPartnerIndependenceBackfill(
      [{ id: "Q", data: { role: "partner", active: true, firmId: "firm1", partnerAttestedBy: "F" } }],
      bootstrap
    )
    expect(plan.stamp).toEqual([{ id: "Q", patch: { independentPartner: true } }])
  })

  it("post-#163 createFirmUser shape is already explicit and skipped", () => {
    const plan = planLegacyPartnerIndependenceBackfill(
      [{ id: "R", data: { role: "partner", active: true, firmId: "firm1", independentPartner: false, createdBy: "F" } }],
      bootstrap
    )
    expect(plan.stamp).toEqual([])
    expect(plan.complete).toEqual(["users/R"])
  })

  it("explicit independentPartner true is skipped", () => {
    const plan = planLegacyPartnerIndependenceBackfill(
      [{ id: "G", data: { role: "partner", active: true, independentPartner: true } }],
      bootstrap
    )
    expect(plan.complete).toEqual(["users/G"])
  })
})
