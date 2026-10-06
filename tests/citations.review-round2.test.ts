// Review round 2, N1 (Critical): the 80-string evasion matrix from secrev2/extract2.probe.test.ts
// and the end-to-end gate probes from secrev2/gate2.probe.test.ts, pinned as regressions.
// Contract per string: every extracted ref is either exactly the authority written
// ("2019 SCMR 1234", "PLD 2019 SC 123", …) or an UNRECOGNISED suspect (UNVERIFIED) — never a
// different authority and never silently nothing when a reporter token is present.
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { newStore } from "@/platform/spine/store"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { extractCitations } from "@/services/d4-2/citations"
import { seedJudgment, seedTreatment, verifyCitations } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

const MATRIX2: Array<[string, string]> = [
  ["combining acute (composes)", "2019 SĆMR 1234"],
  ["combining long stroke", "2019 S̶CMR 1234"],
  ["CGJ U+034F in reporter (invisible Mn)", "2019 SC͏MR 1234"],
  ["CGJ U+034F in page", "2019 SCMR 1͏234"],
  ["VS16 U+FE0F in reporter", "2019 SCM️R 1234"],
  ["VS16 in year", "20️19 SCMR 1234"],
  ["Khmer inherent vowel U+17B4", "2019 SC឴MR 1234"],
  ["Mongolian FVS U+180B", "2019 SC᠋MR 1234"],
  ["fullwidth digits", "２０１９ SCMR １２３４"],
  ["fullwidth letters", "2019 ＳＣＭＲ 1234"],
  ["math bold digits", "\u{1D7D0}\u{1D7CE}\u{1D7CF}\u{1D7D7} SCMR 1234"],
  ["NBSP", "2019 SCMR 1234"],
  ["narrow NBSP", "2019 SCMR 1234"],
  ["thin space", "2019 SCMR 1234"],
  ["ideographic space", "2019　SCMR　1234"],
  ["braille blank U+2800 as space", "2019⠀SCMR⠀1234"],
  ["hangul filler U+3164 as space", "2019ㅤSCMRㅤ1234"],
  ["soft hyphen", "2019 SC­MR 1234"],
  ["RLM/LRM", "2019 ‏SCMR‎ 1234"],
  ["RLO override", "2019 ‮RMCS‬ 1234"],
  ["Urdu digits year+page", "۲۰۱۹ SCMR ۱۲۳۴"],
  ["Urdu digits page only", "2019 SCMR ۱۲۳۴"],
  ["Arabic-Indic digits", "٢٠١٩ SCMR ١٢٣٤"],
  ["Devanagari digits", "२०१९ SCMR 1234"],
  ["PLD Urdu digits", "PLD ۲۰۱۹ SC ۱۲۳"],
  ["SC MR", "2019 SC MR 1234"],
  ["S C M R.", "2019 S. C. M. R. 1234"],
  ["OCR glued PLD2019SC123", "PLD2019SC123"],
  ["OCR glued lowercase", "2019scmr1234"],
  ["OCR glued pld lowercase", "pld2019sc123"],
  ["glued page only", "2019 SCMR1234"],
  ["O for 0 in year", "2O19 SCMR 1234"],
  ["l for 1 in year", "20l9 SCMR 1234"],
  ["en dash page", "2019 SCMR–1234"],
  ["non-breaking hyphen page", "2019 SCMR‑1234"],
  ["minus sign page", "2019 SCMR−1234"],
  ["en dash PLD", "PLD 2019 SC–123"],
  ["split line", "2019 SCMR\n1234"],
  ["split line hyphenated reporter", "2019 SC-\nMR 1234"],
  ["markdown bold year+reporter", "**2019 SCMR** 1234"],
  ["markdown italic reporter", "2019 *SCMR* 1234"],
  ["markdown underscore reporter", "2019 _SCMR_ 1234"],
  ["markdown link", "[2019 SCMR 1234](http://x)"],
  ["html italic", "2019 <i>SCMR</i> 1234"],
  ["html nbsp entity", "2019&nbsp;SCMR&nbsp;1234"],
  ["footnote marker", "2019 SCMR[^1] 1234"],
  ["footnote split", "2019 SCMR[1]\n\n[1]: 1234"],
  ["in URL", "https://pakistanlawsite.com/2019SCMR1234"],
  ["in URL dashed", "see https://x.pk/2019-SCMR-1234"],
  ["quoted", "“2019 SCMR 1234”"],
  ["page keyword", "2019 SCMR page 1234"],
  ["at page", "2019 SCMR at page 1234"],
  ["comma page", "2019 SCMR, 1234"],
  ["colon page", "2019 SCMR: 1234"],
  ["year apostrophe", "'19 SCMR 1234"],
  ["year after", "SCMR 2019 1234"],
  ["volume style", "SCMR (2019) Vol. 1, p. 1234"],
  ["PLD Lahore High Court Lahore", "PLD 2019 Lahore High Court Lahore 123"],
  ["AIR", "AIR 1950 SC 124"],
  ["case title only", "Benazir Bhutto v. Federation of Pakistan"],
  ["supreme court case number unicode", "C.P. No. 12 of 2019"],
  ["C.P. No. Urdu digits", "C.P. No. ۱۲ of ۲۰۱۹"],
  ["C.P.No.12/2019 glued", "C.P.No.12/2019"],
  ["CPLA", "CPLA No. 12-K of 2019"],
  ["Crl.P.L.A.", "Crl.P.L.A. No. 12 of 2019"],
  ["Civil Appeal", "Civil Appeal No. 12 of 2019"],
  ["ICA", "I.C.A. No. 12 of 2019"],
  ["Writ petition no", "Writ Petition No. 1234 of 2019"],
  ["Const.P.", "Const. P. No. 12 of 2019"],
  ["Suo Motu Case", "Suo Motu Case No. 4 of 2010"],
  ["Human Rights Case", "Human Rights Case No. 4 of 2010"],
  ["Criminal Original", "Crl. Original Petition No. 4 of 2010"],
  ["Review Petition", "Civil Review Petition No. 4 of 2010"],
  ["Writ Petition with Urdu numerals? n/a; W.P. dash year", "W.P. No. 1234-2019"],
  ["dotted year", "2019. SCMR 1234"],
]

// Strings with no authority in them at all.
const NO_AUTHORITY = new Set(["Benazir Bhutto v. Federation of Pakistan"])
// The authorities the matrix strings are written as (everything else must be a suspect).
const WRITTEN = new Set(["2019 SCMR 1234", "PLD 2019 SC 123"])

describe("round-2 extractor matrix", () => {
  it.each(MATRIX2)("%s", (_label, input) => {
    const refs = extractCitations(input)
    if (NO_AUTHORITY.has(input)) {
      expect(refs).toEqual([])
      return
    }
    expect(refs.length, input).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(ref.startsWith("UNRECOGNISED: ") || WRITTEN.has(ref), `${input} -> ${ref}`).toBe(true)
    }
  })

  it("a CGJ (U+034F) inside the page is ambiguous: never the VERIFIED page-1 authority", () => {
    const store = newStore()
    seedJudgment(store, "j-one", "Page one", "full", "2019 SCMR 1")
    const res = verifyCitations(store, extractCitations("see 2019 SCMR 1\u034f234"))
    expect(res.status).toBe("UNVERIFIED")
    expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
  })
})

describe("round-2 gate evasion through /api/d4/drafts is closed", () => {
  afterEach(() => resetRuntimeStoreForTests())
  let n = 0
  const key = () => `e2e2e2e2-0000-4000-8000-${String(++n).padStart(12, "0")}`
  it.each([
    "Relying on 2019 SCMR 1234.",
    "Relying on 2019 SCMR\u20131234.",
    "Relying on 2019 SC\u034fMR 1234.",
    "Relying on 2019 SCM\ufe0fR 1234.",
    "Relying on \u06f2\u06f0\u06f1\u06f9 SCMR \u06f1\u06f2\u06f3\u06f4.",
    "Relying on 2019 *SCMR* 1234.",
    "Relying on 2019\u2800SCMR\u28001234.",
    "Relying on 2019 SCMR page 1234.",
    "Relying on Crl.P.L.A. No. 12 of 2019 and Suo Motu Case No. 4 of 2010.",
  ])("%j -> 422", async (body) => {
    const store = getRuntimeStore()
    const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
    for (const u of ["partner_a", "associate_a"]) addMember(store, m.id, u, "firmA")
    seedJudgment(store, "j-old", "Old", "single", "2019 SCMR 1234")
    seedJudgment(store, "j-new", "New", "larger", "2021 SCMR 1")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")
    const res = await DRAFTS(
      new Request("http://127.0.0.1/api/d4/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
        body: JSON.stringify({
          action: "compose", actorId: "associate_a", matterId: m.id, templateId: getDocumentTypes()[0]!.id,
          title: "x", body, classification: "internal", citedJudgmentIds: [], temporalCitations: [],
        }),
      })
    )
    expect(res.status).toBe(422)
  })
})
