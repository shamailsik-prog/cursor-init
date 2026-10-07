// Review round 3 (review-secgaps-r3.md; probes secrev3/extract3 + gate3) pinned as regressions.
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { newStore } from "@/platform/spine/store"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { extractCitations, isUnrecognisedRef as isSuspect } from "@/services/d4-2/citations"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"
import { seedJudgment, seedTreatment, verifyCitations } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"


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
    // R4 fuzz: tag fragments glued to letters next to numbers are markup residue — fail-closed suspects
    ["2019 SC<b>MR</b> 1234", null],
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

describe("N12: statute exclusion only when the word immediately before No. is a statute word", () => {
  it.each([
    "First Appeal from Order No. 12 of 2019",
    "Rules Suo Motu Case No. 4 of 2010",
    "Act Human Rights Case No. 4 of 2010",
    "Election Petition No. 12 of 2019",
    "Order No. 7 of 2018",
  ])("%j is a case reference (UNVERIFIED)", (text) => {
    const refs = extractCitations(text)
    expect(refs.length, text).toBeGreaterThan(0)
    expect(refs.every(isSuspect)).toBe(true)
  })
  it.each([
    "The Companies Act No. 5 of 2017 applies.",
    "Ordinance No. 12 of 2019 was promulgated.",
    "Punjab Rules No. 3 of 2015",
    "Regulations No. 2 of 2020",
    "S.R.O. No. 1243 of 2019",
    "Notification No. 4 of 2021",
    "Order-in-Council No. 9 of 1950",
  ])("%j is a statute reference (excluded)", (text) => {
    expect(extractCitations(text)).toEqual([])
  })
  it("a disguised reported citation is still caught", () => {
    expect(extractCitations("Act No. 2019 SCMR 1234")).toContain("2019 SCMR 1234")
  })
})

// Review round 3: the reviewer's extract3 probe matrix, every string pinned. Each is refused by
// the charset layer (422 unsupported_characters), or reads as exactly the expected authority, or
// is fail-closed (UNRECOGNISED suspects only). The false-positive strings must yield nothing.
const PROBE3_CASES: Array<[string, string]> = [
  // confusables surviving NFKD
  ["Latin small capitals ꜱᴄᴍʀ", "2019 ꜱᴄᴍʀ 1234"],
  ["small caps P L D", "ᴘʟᴅ 2019 SC 123"],
  ["Cherokee capitals ᏚᏟᎷᎡ", "2019 ᏚᏟᎷᎡ 1234"],
  ["Cherokee small ꮪꮯꮇꭱ", "2019 ꮪꮯꮇꭱ 1234"],
  ["Greek Omicron in year", "2Ο19 SCMR 1234"],
  ["Greek Mu split token lower spaced", "2019 s c μ r 1234"],
  ["Greek+Cyrillic all non-Latin 'ЅСΜR'?", "2019 ЅСΜR 1234"],
  ["Cyrillic all-but-R separate tokens", "2019 ЅСМ R 1234"],
  ["Cyrillic PLD-ish Р L D", "Р L D 2019 SC 123"],
  ["Cyrillic Р + Latin LD spaced dotted", "Р. L. D. 2019 S.C. 123"],
  ["Latin letter dental click ǀ glue", "2019 ǀSCMRǀ 1234"],
  ["Latin alveolar click ǃ glue", "2019 SCMRǃ 1234"],
  // spacing modifier letters (not marks)
  ["modifier small caps ˢᶜᴹᴿ", "2019 ˢᶜᴹᴿ 1234"],
  ["modifier colon ː separators", "2019ːSCMRː1234"],
  ["modifier apostrophe in page", "2019 SCMR 12ʼ34"],
  ["modifier letter ʹ U+02B9 between digits", "2019 SCMR 1ʹ234"],
  // NFKD-unchanged lookalikes
  ["Cyrillic Ze as 3 in page", "2019 SCMR 12З4"],
  ["Latin small l as 1 in page", "2019 SCMR l234"],
  ["counting rod digits (No, not Nd)", "2019 SCMR \u{1D361}\u{1D362}\u{1D363}\u{1D364}"],
  ["superscripts page", "2019 SCMR ¹²³⁴"],
  ["circled digits page", "2019 SCMR ①②③④"],
  ["dingbat negative circled digits", "2019 SCMR ❶❷❸❹"],
  // variation selectors / tags / bidi / mongolian / soft hyphen
  ["VS17 (E0100) in page", "2019 SCMR 12\u{E0100}34"],
  ["tag chars in reporter", "2019 SC\u{E0041}\u{E0042}MR 1234"],
  ["tag chars in page", "2019 SCMR 12\u{E0030}34"],
  ["RLO reversed whole citation", "‮4321 RMCS 9102‬"],
  ["RLO reversed page only", "2019 SCMR ‮4321‬"],
  ["RLI isolate + reversed", "⁧4321 RMCS 9102⁩"],
  ["Mongolian FVS in page", "2019 SCMR 12᠋34"],
  ["Mongolian vowel sep U+180E in page", "2019 SCMR 12᠎34"],
  ["soft hyphen inside reporter", "2019 SC­MR 1234"],
  ["soft hyphen in page", "2019 SCMR 12­34"],
  // HTML entities
  ["&#83;CMR", "2019 &#83;CMR 1234"],
  ["&#x53;CMR", "2019 &#x53;CMR 1234"],
  ["&#83CMR no semicolon", "2019 &#83CMR 1234"],
  ["&amp;#83;CMR double encoded", "2019 &amp;#83;CMR 1234"],
  ["&amp; in body", "PLD 2019 SC (AJ&amp;K) 1"],
  ["entity &minus; page", "2019 SCMR&minus;1234"],
  ["entity in page digits", "2019 SCMR 12&#51;4"],
  ["html comment long", "2019 SC<!-- " + "x".repeat(90) + " -->MR 1234"],
  // Markdown links
  ["md link text", "[2019 SCMR 1234](https://x.pk)"],
  ["md link split", "[2019 SCMR](https://x.pk) 1234"],
  ["md link url only", "see [the judgment](https://pakistanlawsite.com/2019SCMR1234)"],
  ["md autolink", "<https://x.pk/2019-SCMR-1234>"],
  ["md image alt", "![2019 SCMR 1234](a.png)"],
  // year after page
  ["SCMR 1234 (2019)", "SCMR 1234 (2019)"],
  ["SCMR page 1234 of 2019", "SCMR page 1234 of 2019"],
  ["PLD SC 123 of 2019", "PLD SC 123 of 2019"],
  ["CLC 789 Lahore 2018", "CLC 789 Lahore 2018"],
  // Urdu script
  ["Urdu reporter name", "۲۰۱۹ ایس سی ایم آر ۱۲۳۴"],
  ["Urdu PLD", "پی ایل ڈی ۲۰۱۹ سپریم کورٹ ۱۲۳"],
  ["Urdu C.P. no", "سی پی نمبر ۱۲ بابت ۲۰۱۹"],
  // pinpoint / thousands
  ["pinpoint", "2019 SCMR 1234, 1240"],
  ["thousands comma", "2019 SCMR 1,234"],
  ["thousands period", "2019 SCMR 1.234"],
  ["Arabic thousands sep U+066C", "2019 SCMR 1٬234"],
  ["apostrophe thousands", "2019 SCMR 1'234"],
  ["PLD thousands comma", "PLD 2019 SC 1,234"],
  // statute disguise
  ["FAO spelled out", "First Appeal from Order No. 12 of 2019"],
  ["Rules + Suo Motu", "Rules Suo Motu Case No. 4 of 2010"],
  ["Election Petition", "Election Petition No. 12 of 2019"],
  ["Act-prefixed HRC", "Act Human Rights Case No. 4 of 2010"],
  ["Ordinance disguise", "Ordinance No. 12 of 2019 (Lahore High Court)"],
  ["Act No. disguising reported", "Act No. 2019 SCMR 1234"],
  // false-positive checks for stricter fallback
  ["FP: company PLC with number", "Engro Fertilizers PLC paid Rs. 5 million"],
  ["FP: ptd ltd", "XYZ (Pvt.) Ltd. and PTD 5 others"],
  ["FP: section", "section 302 PPC read with 34 PPC"],
  ["FP: CLC as acronym", "the CLC committee met on 5 May"],
  ["FP: YLR", "employee no. 4 of YLR division"],
]
type Probe3Expectation = string[] | "suspect-or-refused" | "blocked" | "found"
const PROBE3_EXPECTED: Record<string, Probe3Expectation> = {
  "Latin small capitals ꜱᴄᴍʀ": "suspect-or-refused",
  "small caps P L D": "suspect-or-refused",
  "Cherokee capitals ᏚᏟᎷᎡ": "suspect-or-refused",
  "Cherokee small ꮪꮯꮇꭱ": "suspect-or-refused",
  "Greek Omicron in year": "suspect-or-refused",
  "Greek Mu split token lower spaced": "suspect-or-refused",
  "Greek+Cyrillic all non-Latin 'ЅСΜR'?": "suspect-or-refused",
  "Cyrillic all-but-R separate tokens": "suspect-or-refused",
  "Cyrillic PLD-ish Р L D": "suspect-or-refused",
  "Cyrillic Р + Latin LD spaced dotted": "suspect-or-refused",
  "Latin letter dental click ǀ glue": "suspect-or-refused",
  "Latin alveolar click ǃ glue": "suspect-or-refused",
  "modifier small caps ˢᶜᴹᴿ": ["2019 SCMR 1234"],
  "modifier colon ː separators": "suspect-or-refused",
  "modifier apostrophe in page": "suspect-or-refused",
  "modifier letter ʹ U+02B9 between digits": "suspect-or-refused",
  "Cyrillic Ze as 3 in page": "suspect-or-refused",
  "Latin small l as 1 in page": "suspect-or-refused",
  "counting rod digits (No, not Nd)": "suspect-or-refused",
  // R5-2: superscript / circled digits are footnote markers, not page digits: ambiguous
  "superscripts page": "suspect-or-refused",
  // R5-2: superscript / circled digits are footnote markers, not page digits: ambiguous
  "circled digits page": "suspect-or-refused",
  "dingbat negative circled digits": "suspect-or-refused",
  "VS17 (E0100) in page": "suspect-or-refused",
  "tag chars in reporter": "suspect-or-refused",
  "tag chars in page": "suspect-or-refused",
  "RLO reversed whole citation": "suspect-or-refused",
  "RLO reversed page only": "suspect-or-refused",
  "RLI isolate + reversed": "suspect-or-refused",
  "Mongolian FVS in page": "suspect-or-refused",
  "Mongolian vowel sep U+180E in page": "suspect-or-refused",
  // R4 FP5: the soft hyphen between letters is a paste artefact, dropped, so the reporter is read (and gated)
  "soft hyphen inside reporter": ["2019 SCMR 1234"],
  "soft hyphen in page": "suspect-or-refused",
  "&#83;CMR": ["2019 SCMR 1234"],
  "&#x53;CMR": ["2019 SCMR 1234"],
  "&#83CMR no semicolon": ["2019 SCMR 1234"],
  "&amp;#83;CMR double encoded": ["2019 SCMR 1234"],
  "&amp; in body": "found",
  "entity &minus; page": "suspect-or-refused",
  "entity in page digits": "suspect-or-refused",
  "html comment long": "blocked",
  "md link text": ["2019 SCMR 1234"],
  "md link split": "suspect-or-refused",
  "md link url only": "suspect-or-refused",
  "md autolink": "suspect-or-refused",
  "md image alt": ["2019 SCMR 1234"],
  "SCMR 1234 (2019)": "suspect-or-refused",
  "SCMR page 1234 of 2019": "suspect-or-refused",
  "PLD SC 123 of 2019": "suspect-or-refused",
  "CLC 789 Lahore 2018": "suspect-or-refused",
  "Urdu reporter name": "suspect-or-refused",
  "Urdu PLD": "suspect-or-refused",
  "Urdu C.P. no": "suspect-or-refused",
  "pinpoint": ["2019 SCMR 1234"],
  "thousands comma": "suspect-or-refused",
  "thousands period": "suspect-or-refused",
  "Arabic thousands sep U+066C": "suspect-or-refused",
  "apostrophe thousands": "suspect-or-refused",
  "PLD thousands comma": "suspect-or-refused",
  "FAO spelled out": "suspect-or-refused",
  "Rules + Suo Motu": "suspect-or-refused",
  "Election Petition": "suspect-or-refused",
  "Act-prefixed HRC": "suspect-or-refused",
  "Ordinance disguise": [],
  "Act No. disguising reported": ["2019 SCMR 1234"],
  "FP: company PLC with number": [],
  "FP: ptd ltd": [],
  "FP: section": [],
  "FP: CLC as acronym": [],
  "FP: YLR": [],
}
describe("review round 3 extract3 probe matrix", () => {
  it("covers every probe string", () => {
    expect(PROBE3_CASES).toHaveLength(Object.keys(PROBE3_EXPECTED).length)
  })
  it.each(PROBE3_CASES)("%s", (label, text) => {
    const expected = PROBE3_EXPECTED[label]
    const check = checkDraftCharset(text)
    if (expected === "suspect-or-refused") {
      if (!check.ok) return
      const refs = extractCitations(check.normalised)
      expect(refs.length, text).toBeGreaterThan(0)
      expect(refs.every(isSuspect), JSON.stringify(refs)).toBe(true)
      return
    }
    expect(check.ok, text).toBe(true)
    if (!check.ok) return
    const refs = extractCitations(check.normalised)
    if (expected === "blocked") {
      expect(refs.length, text).toBeGreaterThan(0)
      expect(refs.includes("2019 SCMR 1234") || refs.every(isSuspect), JSON.stringify(refs)).toBe(true)
    } else if (expected === "found") {
      expect(refs.length, text).toBeGreaterThan(0)
    } else {
      expect(refs).toEqual(expected)
    }
  })
})

describe("character references without ';' and long HTML comments (browsers render both)", () => {
  it.each(["2019 &#83CMR 1234", "2019 S&#67MR 1234"])("%j reads as 2019 SCMR 1234", (text) => {
    expect(extractCitations(text)).toContain("2019 SCMR 1234")
  })
  it("'2019&nbspSCMR 1234' is never silent (exact or fail-closed)", () => {
    const refs = extractCitations("2019&nbspSCMR 1234")
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.includes("2019 SCMR 1234") || refs.every(isSuspect), JSON.stringify(refs)).toBe(true)
  })
  it("a numeric reference without ';' inside the page makes it ambiguous", () => {
    const refs = extractCitations("2019 SCMR 12&#51 4")
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.every(isSuspect)).toBe(true)
  })
  it.each([
    "2019 SC<!-- " + "x".repeat(90) + " -->MR 1234",
    "2019 SC<!--" + "y".repeat(500) + "-->MR 1234",
    "2019 SCMR 12<!-- " + "x".repeat(90) + " -->34",
  ])("long comment %#", (text) => {
    const refs = extractCitations(text)
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.includes("2019 SCMR 1234") || refs.every(isSuspect), JSON.stringify(refs)).toBe(true)
  })
})

// Review round 3, gate3 probe: every evasion body through the real compose route is a 422 —
// refused by the charset layer (unsupported_characters) or blocked by the citation gate.
describe("review round 3 gate3 probe: compose never accepts an evasion body", () => {
  afterEach(() => resetRuntimeStoreForTests())
  let n = 0
  const key = () => `00000000-0000-4000-8333-${String(++n).padStart(12, "0")}`
  function setup() {
    const store = getRuntimeStore()
    const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
    for (const u of ["partner_a", "associate_a", "clerk_a"]) addMember(store, m.id, u, "firmA")
    seedJudgment(store, "j-old", "Old", "single", "2019 SCMR 1234")
    seedJudgment(store, "j-new", "New", "larger", "2021 SCMR 1")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")
    return { store, matterId: m.id }
  }
  // the fuzz test's exact request shape (no citedJudgmentIds / temporalCitations)
  const compose = (matterId: string, body: string) =>
    DRAFTS(new Request("http://127.0.0.1/api/d4/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify({ action: "compose", actorId: "associate_a", matterId, templateId: getDocumentTypes()[0]!.id, title: "x", body, classification: "internal" }),
    }))

  it("control: a clean body is 200 and the plain overruled citation is 422 (the property is not vacuous)", async () => {
    const { matterId } = setup()
    expect((await compose(matterId, "Relying on nothing at all.")).status).toBe(200)
    expect((await compose(matterId, "Relying on 2019 SCMR 1234.")).status).toBe(422)
  })

  it.each([
    "Relying on <2019 SCMR 1234>.",
    "Relying on 2019 SCMR 1234 <emphasis supplied>.",
    "Where loss < 5% the rule in 2019 SCMR 1234 applies; where > 5% it does not.",
    "Relying on 2019 SCMR ‮4321‬.",
    "Relying on ‮4321 RMCS 9102‬.",
    "Relying on 2019 ꜱᴄᴍʀ 1234.",
    "Relying on 2019 ꮪꮯꮇꭱ 1234.",
    "Relying on 2019 SCMR 1,234.",
    "Relying on ۲۰۱۹ ایس سی ایم آر ۱۲۳۴.",
    "Relying on First Appeal from Order No. 12 of 2019.",
    "Relying on 2019 &#83CMR 1234.",
    "Relying on 2019 SC<!-- " + "x".repeat(90) + " -->MR 1234.",
  ])("%j is 422", async (body) => {
    const { matterId } = setup()
    const res = await compose(matterId, body)
    expect(res.status).toBe(422)
  })

  it("thousands comma and an RLO page never resolve to a different VERIFIED authority", () => {
    const { store } = setup()
    seedJudgment(store, "j-one", "Page one", "full", "2019 SCMR 1")
    seedJudgment(store, "j-4321", "P4321", "full", "2019 SCMR 4321")
    const thousands = verifyCitations(store, extractCitations("see 2019 SCMR 1,234"))
    expect(thousands.findings.some((f) => f.status === "VERIFIED")).toBe(false)
    expect(checkDraftCharset("see 2019 SCMR ‮4321‬").ok).toBe(false)
  })
})

// Found by the round-3 fuzz extension (item 10).
describe("fuzz round 3: closing punctuation glued between digits; stray punctuation inside an Urdu reporter", () => {
  it.each(["see 2019 SCMR 12>34", "see <- 2018 CLC 7>89", "see 2019 SCMR 12)34", "see 2019 SCMR 12;34", "see 2019 SCMR 12!34", "see 2018 CLC 7\t\u201989", "see 2019 SCMR 12 ,34", "see 2019 SCMR 12 .34"])(
    "%j never resolves to a shorter page",
    (text) => {
      const store = newStore()
      seedJudgment(store, "j-12", "Twelve", "full", "2019 SCMR 12")
      seedJudgment(store, "j-7", "Seven", "full", "2018 CLC 7")
      const res = verifyCitations(store, extractCitations(text))
      expect(res.status).toBe("UNVERIFIED")
      expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
    }
  )
  it("'2019 SCMR 1234) and' and '(2019 SCMR 1234)' still read page 1234", () => {
    expect(extractCitations("(2019 SCMR 1234) and")).toEqual(["2019 SCMR 1234"])
  })
  it.each([
    "۲ ۰۱۹‒ ایس سی ایم >آر ۱۲۳۴",
    "۲۰۱۹ ایس *سی* ایم آر ۱۲۳۴",
    "۲۰۱۹ ایس<سی ایم آر ۱۲۳۴",
    // a dash or blank inside a letter name
    "2019⸻ای‑س سی ایم\r\nآر 1234",
    "پ⹀ی ایل\nڈی ۲۰۱۰ Lahore ۵",
    "۲۰۱۹⸺پی سی ―آر ایل ج ے ۴۴",
  ])("Urdu reporter with stray punctuation between letter names %# is a suspect", (text) => {
    const refs = extractCitations(text)
    expect(refs.length, JSON.stringify(refs)).toBeGreaterThan(0)
    expect(refs.every(isSuspect)).toBe(true)
  })
})

describe("fuzz round 3 (seed sweep): thousands marks before junk or odd blanks, angles before digits, Common-script letter tokens", () => {
  it.each([
    "see 2019 SCMR 123’<b>⸻4",
    "see 2019 PCrLJ 4,—4",
    "see 2018 CLC 7.⹝8,9",
    "see 2018 CLC\n7, &nbsp;89",
    "see 2018 CLC 7,  89",
    "see 2019 SCMR 12’  34",
    "see 2019 SCmR 1’\t234",
    "see 2019 SCMR  1'   2&nbsp;34",
    "see 2018\r\nClC 7 <89",
    "see 2019 scmR 1> 234a < b",
  ])("%j never resolves to a shorter page", (text) => {
    const store = newStore()
    for (const [id, cite] of [["a", "2019 SCMR 1"], ["b", "2019 SCMR 12"], ["c", "2019 SCMR 123"], ["d", "2019 PCrLJ 4"], ["e", "2018 CLC 7"]] as const) {
      seedJudgment(store, id, cite, "full", cite)
    }
    const res = verifyCitations(store, extractCitations(text))
    expect(res.status).toBe("UNVERIFIED")
    expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
  })
  it("ordinary forms still read exactly: pinpoint, citation lists, a numbered next paragraph", () => {
    expect(extractCitations("2019 SCMR 1234, 1240")).toEqual(["2019 SCMR 1234"])
    expect(extractCitations("2019 SCMR 1234; 2020 SCMR 56")).toEqual(["2019 SCMR 1234", "2020 SCMR 56"])
    expect(extractCitations("as held in 2019 SCMR 1234.\n\n5. The next issue")).toEqual(["2019 SCMR 1234"])
    expect(extractCitations("(2019 SCMR 1234) 5 cases")).toEqual(["2019 SCMR 1234"])
  })
  it("a token of Common-script letters (math alphanumerics) with a confusable symbol is refused", () => {
    expect(checkDraftCharset("Relying on 201 8 \u{1d4d2}\u{1d473}\u{1f74c} 789").ok).toBe(false)
  })
})

describe("fuzz round 3 (wide sweep): bare angles never pair into a fake tag; marks before markup; exotic pinpoint blanks", () => {
  const seeded = () => {
    const store = newStore()
    for (const [id, cite] of [["a", "2019 SCMR 1"], ["b", "2019 SCMR 12"], ["c", "2019 SCMR 123"], ["d", "2019 PCrLJ 4"], ["e", "2018 CLC 7"]] as const) {
      seedJudgment(store, id, cite, "full", cite)
    }
    seedJudgment(store, "j-larger", "Larger", "larger", "2025 SCMR 999")
    for (const [id, cite] of [["o1", "2019 SCMR 1234"], ["o2", "2019 PCrLJ 44"], ["o3", "2018 CLC 789"]] as const) {
      seedJudgment(store, id, cite, "single", cite)
      seedTreatment(store, "j-larger", id, "overruled", "larger")
    }
    return store
  }
  it.each([
    'where loss < 5% 2019 SCM<span class="c">R >1234 x',
    '-> 20<19 PCr<span class="c">LJ **44** and > 5% x',
    '2٬01<8 <sp〰an class="c">CLC</span> 789 c > d x',
    "<- 2019 S<i>CMR 1234 c > d.",
    "see 2019 SCMR 1>–2 34",
    "see 2019 PCrlj 4>٬4",
    "see 2019 scmR 123>﹣4",
    "see 2019 SCMR 1>'234.",
    "see 2019\nSCMR\r\n123\n>4.",
    'see 2019 PCrLJ 4,<span class="c">4',
    'see 2018 CLC 7,<span class="c">89',
    "see 2019 SCMR 1,<i>234-",
    "see 2019\nSCMR\n1.&nbsp;234",
    "see 2018 CLC\n7, 89",
    "see 2019 PCrLJ 4, 4",
    // a dash or blank right after "<" (not a tag to a browser, junk that hides the reporter)
    'see 2018 <-sPAn CLAsS="C">Clc</spAN> 7\'89',
    "see 2019 <\u2005 I>Scmr</I> 123-4",
  ])("%j is never OK and never VERIFIED", (text) => {
    const check = checkDraftCharset(text)
    if (!check.ok) return
    const res = verifyCitations(seeded(), extractCitations(check.normalised))
    expect(res.status).not.toBe("OK")
    expect(res.findings.some((f) => f.status === "VERIFIED"), JSON.stringify(res)).toBe(false)
  })
  it("a math-alphanumeric Greek letter (compatibility form of a disallowed script) is refused; µ is allowed", () => {
    expect(checkDraftCharset("２0<19 _\u{1d6b8}_ CrLJ \u{1fbf4}4").ok).toBe(false)
    expect(checkDraftCharset("a dose of 5 µg per day").ok).toBe(true)
  })
  it("prose angles and real pinpoints are unaffected", () => {
    expect(extractCitations("where loss < 5% the rule in 2019 SCMR 1234 applies; where > 5% it does not")).toEqual(["2019 SCMR 1234"])
    expect(extractCitations("2019 SCMR 1234, 1240")).toEqual(["2019 SCMR 1234"])
    // R4 fuzz: tags glued to the reporter are markup residue; still never silent (fail-closed)
    const tagged = extractCitations("2019 <b>SCMR</b> 1234")
    expect(tagged.length).toBeGreaterThan(0)
    expect(tagged.includes("2019 SCMR 1234") || tagged.every(isSuspect)).toBe(true)
  })
})

describe("ellipsis after a citation stays ordinary prose", () => {
  it("'2019 SCMR 1234 ... 2019' and '2019 SCMR 1234... 5 cases' read page 1234", () => {
    expect(extractCitations("2019 SCMR 1234 ... 2019 was a year")).toEqual(["2019 SCMR 1234"])
    expect(extractCitations("2019 SCMR 1234... 5 cases")).toEqual(["2019 SCMR 1234"])
    // R6 F-4: a numeral-led sentence ("5 cases") after a citation is prose again; "4. 4 for …" stays ambiguous
    expect(extractCitations("2019 SCMR 1234.  5 cases")).toEqual(["2019 SCMR 1234"])
  })
})

describe("fuzz round 3 (41-seed sweep): single-letter confusables are not orthographic; exotic blank after a period", () => {
  it("thorn standing in for P is refused; multi-letter prototypes (Æ) stay allowed", () => {
    expect(checkDraftCharset("Relying on <b>2</b> 019 þC rlj 44").ok).toBe(false)
    expect(checkDraftCharset("Æsop and Café mañana").ok).toBe(true)
  })
  it("'12.\\u200a34' never resolves to page 12", () => {
    const store = newStore()
    seedJudgment(store, "b", "Twelve", "full", "2019 SCMR 12")
    const res = verifyCitations(store, extractCitations("see 2019 SCMR﹣ 12. 34."))
    expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
    expect(res.status).not.toBe("OK")
  })
})

describe("fuzz round 3 (fresh seeds): malformed end tags and junk inside entity-like runs", () => {
  const seeded = () => {
    const store = newStore()
    seedJudgment(store, "j-larger", "Larger", "larger", "2025 SCMR 999")
    seedJudgment(store, "o3", "2018 CLC 789", "single", "2018 CLC 789")
    seedTreatment(store, "j-larger", "o3", "overruled", "larger")
    seedJudgment(store, "e", "2018 CLC 78", "full", "2018 CLC 78")
    return store
  }
  it.each(['see 2018 <span class="c">cLC</span<> 78\n9', "see `2018` CL&n<bsp;C 789"])("%j is never OK and never VERIFIED", (text) => {
    const res = verifyCitations(seeded(), extractCitations(text))
    expect(res.status).not.toBe("OK")
    expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
  })
})
