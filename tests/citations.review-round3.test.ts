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

describe("N8: plain-text '<' and '>' never hide a citation (raw and markup-stripped scans are unioned)", () => {
  it.each([
    ["Relying on <2019 SCMR 1234>.", "2019 SCMR 1234"],
    ["Where loss < 5% the rule in 2019 SCMR 1234 applies; where > 5% it does not.", "2019 SCMR 1234"],
    ["<https://x.pk/2019-SCMR-1234>", null],
    ["Relying on 2019 SCMR 1234 <emphasis supplied>.", "2019 SCMR 1234"],
    ["2019 SC<b>MR</b> 1234", "2019 SCMR 1234"],
  ])("%j", (text, citation) => {
    const refs = extractCitations(text)
    expect(refs.length, text).toBeGreaterThan(0)
    if (citation) expect(refs).toContain(citation)
    else expect(refs.every(isSuspect)).toBe(true)
  })
})

describe("N10: script-agnostic shape detector (year, 1-6 short letter tokens, number)", () => {
  it.each([
    "2019 ꜱᴄᴍʀ 1234",
    "2019 ꮪꮯꮇꭱ 1234",
    "2019 ǀSCMRǀ 1234",
    "2019 SCMRǃ 1234",
    "۲۰۱۹ ایس سی ایم آر ۱۲۳۴",
    "2019 ZQX 77",
    "1999 A.B.C. 5",
  ])("%j is an UNVERIFIED suspect", (text) => {
    const refs = extractCitations(text)
    expect(refs.length, text).toBeGreaterThan(0)
    expect(refs.every(isSuspect), JSON.stringify(refs)).toBe(true)
  })
  it.each([
    "In 2019 he paid 5 lakh rupees.",
    "In 2019 the court held 3 hearings.",
    "On 12.03.2019 FIR No. 45 was registered.",
    "The 2019 budget allocated 300 million.",
  ])("ordinary prose %j is not a suspect", (text) => {
    expect(extractCitations(text)).toEqual([])
  })
})

describe("N11: citations written in Urdu script", () => {
  it.each([
    "۲۰۱۹ ایس سی ایم آر ۱۲۳۴",
    "ایس سی ایم آر ۲۰۱۹ ۱۲۳۴",
    "پی ایل ڈی ۲۰۱۹ سپریم کورٹ ۱۲۳",
    "پی.ایل.ڈی ۱۲۳ سال ۲۰۱۹",
    "سی پی نمبر ۱۲ بابت ۲۰۱۹",
    "رٹ پٹیشن نمبر ۱۲۳۴ آف ۲۰۱۹",
    "اپیل نمبر ۱۲/۲۰۱۹",
  ])("%j is an UNVERIFIED suspect", (text) => {
    const refs = extractCitations(text)
    expect(refs.length, text).toBeGreaterThan(0)
    expect(refs.every(isSuspect)).toBe(true)
  })
  it("ordinary Urdu prose with a number is not a suspect", () => {
    expect(extractCitations("میں نے ۱۲ کتابیں پڑھیں۔")).toEqual([])
  })
  it("the Urdu reporter table is generated from the Latin reporter list", async () => {
    const { URDU_REPORTER_SPELLINGS } = await import("@/services/d4-2/citations")
    expect(URDU_REPORTER_SPELLINGS.SCMR).toBe("ایس سی ایم آر")
    expect(URDU_REPORTER_SPELLINGS.PLD).toBe("پی ایل ڈی")
    expect(Object.keys(URDU_REPORTER_SPELLINGS).length).toBeGreaterThanOrEqual(15)
  })
})

describe("acronym reporter tokens need a 4-digit year within 4 tokens (review R3 item 6)", () => {
  it.each([
    "Engro Fertilizers PLC paid Rs. 5 million",
    "the CLC committee met on 5 May",
    "employee no. 4 of YLR division",
    "XYZ PTD 5 others",
    "the SCR unit filed 3 reports",
  ])("prose %j passes", (text) => {
    expect(extractCitations(text)).toEqual([])
  })
  it.each([
    ["2019 PLC 77", "2019 PLC 77"],
    ["2018 CLC 789", "2018 CLC 789"],
    ["2019 PLC page 77", null],
    ["PLC 77 of 2019", null],
    ["2018 C L C, 789", null],
    ["2019 NLR at 12", null],
  ])("real citation %j still blocks", (text, exact) => {
    const refs = extractCitations(text)
    expect(refs.length).toBeGreaterThan(0)
    if (exact) expect(refs).toEqual([exact])
    else expect(refs.every(isSuspect)).toBe(true)
  })
  it("distinctive tokens keep the any-digit trigger", () => {
    expect(extractCitations("see SCMR at 5").every(isSuspect)).toBe(true)
    expect(extractCitations("see SCMR at 5").length).toBeGreaterThan(0)
  })
})
