// Review round 3 (review-secgaps-r3.md; probes secrev3/extract3 + gate3) pinned as regressions.
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { newStore } from "@/platform/spine/store"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { extractCitations } from "@/services/d4-2/citations"
import { seedJudgment, seedTreatment, verifyCitations } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

const isSuspect = (ref: string) => ref.startsWith("UNRECOGNISED: ")

describe("N9: thousands separators make the page ambiguous; the ', 1240' pinpoint stays", () => {
  it.each(["see 2019 SCMR 1,234", "see 2019 SCMR 1.234", "see 2019 SCMR 1'234", "see 2019 SCMR 1’234", "see 2019 SCMR 1٬234", "see 2019 SCMR 1 234", "see PLD 2019 SC 1,234"])(
    "%j never resolves to page 1",
    (text) => {
      const store = newStore()
      seedJudgment(store, "j-one", "Page one", "full", "2019 SCMR 1")
      seedJudgment(store, "j-pld", "PLD one", "full", "PLD 2019 SC 1")
      const res = verifyCitations(store, extractCitations(text))
      expect(res.status).toBe("UNVERIFIED")
      expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
    }
  )
  it("pinpoint: '2019 SCMR 1234, 1240' is page 1234", () => {
    expect(extractCitations("2019 SCMR 1234, 1240")).toEqual(["2019 SCMR 1234"])
  })
  it("any glued junk after the page is ambiguous ('1<b>234', '1/2', '1#234')", () => {
    for (const text of ["2019 SCMR 1<b>234", "2019 SCMR 1#234", "2019 SCMR 1~234"]) {
      expect(extractCitations(text).every(isSuspect), text).toBe(true)
    }
  })
})
