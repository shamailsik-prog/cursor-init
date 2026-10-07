// Review round 5 probes fn5 and gate5 (secrev5/repo/tests/sr5) as regression tests.
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { extractCitations, type AnalyseOptions, isUnrecognisedRef as isSuspect } from "@/services/d4-2/citations"
import { ownCaseReferenceMatcher } from "@/services/d4-1/drafts"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"
import { seedJudgment, seedTreatment } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

// "none": ruled non-authority, reads nothing; "blocked": suspects only; "refused": charset 422;
// a string: that exact citation is read (and then gated)
type Expect = "none" | "blocked" | "refused" | string
const shc: AnalyseOptions = { isOwnCaseReference: ownCaseReferenceMatcher({ courtId: "SHC", caseNumber: "CP 12/2019" }) }
const FN5: Array<[string, string, Expect, AnalyseOptions?]> = [
  ["FIR (Supreme Court)", "As held in FIR No. 12 of 2019 (Supreme Court), bail is a right.", "none"],
  ["Challan disguise", "The view taken in Challan No. 12 of 2019 by the Lahore High Court is binding.", "none"],
  ["Notice disguise", "Relying on Notice No. 12 of 2019 decided by the Supreme Court.", "none"],
  ["Civil Petition Notice No.", "Relying on Civil Petition Notice No. 12 of 2019.", "none"],
  ["Diary No.", "Relying on Diary No. 1234 of 2019 decided by the Supreme Court.", "none"],
  ["Letter + C.P.", "Relying on Letter C.P. No. 12 of 2019.", "blocked"],
  ["Urdu مقدمہ unreported SC", "سپریم کورٹ کے مقدمہ نمبر ۱۲ بابت ۲۰۱۹ میں قرار دیا گیا", "blocked"],
  ["Urdu اپیل", "سپریم کورٹ کی اپیل نمبر ۱۲ بابت ۲۰۱۹ میں قرار دیا گیا", "blocked"],
  ["FIR then reported", "FIR No. 12 of 2019 2019 SCMR 1234", "2019 SCMR 1234"],
  ["Notice glued reported", "Notice No. 2019 SCMR 1234", "2019 SCMR 1234"],
  ["own SHC CP 12/2019 vs Supreme Court C.P.", "The Supreme Court in C.P. No. 12 of 2019 held …", "blocked", shc],
  ["own: reported citation unaffected", "2019 SCMR 1234", "2019 SCMR 1234", { isOwnCaseReference: ownCaseReferenceMatcher({ courtId: "SC_PK", caseNumber: "2019 SCMR 1234" }) }],
  ["own raw: other court Crl. Misc.", "Lahore High Court Crl. Misc. No. 456 of 2025 held", "blocked", { isOwnCaseReference: ownCaseReferenceMatcher({ courtId: "SHC", caseNumber: "CRM 456/2025" }) }],
  ...(
    [
      ["2019 PTCL 1234", "2019 PTCL 1234"], ["2019 PTCL at page 1234", "blocked"], ["PTCL 1234 of 2019", "blocked"],
      ["(2019) PTCL 1234", "2019 PTCL 1234"], ["2019, PTCL 1234", "2019 PTCL 1234"], ["PTCL (2019) 1234", "blocked"],
      ["2019 P.T.C.L. 1234", "2019 PTCL 1234"], ["2019 PTCL p. 1234", "blocked"], ["2019 PTCL vol. 2 1234", "blocked"],
      ["PTCL 2019 Vol. 1 page 1234", "blocked"], ["2018 CLC at 789", "blocked"], ["CLC 789 (2018)", "blocked"],
      ["2018 C L C 789", "2018 CLC 789"], ["2018 CLC Lahore 789", "blocked"], ["2018 CLC - 789", "2018 CLC 789"],
      ["2018 CLC\n789", "2018 CLC 789"], ["2018 Civil Law Cases 789", "2018 CLC 789"],
      ["2019 Supreme Court Monthly Review 1234", "2019 SCMR 1234"], ["Pakistan Legal Decisions 2019 SC 123", "PLD 2019 SC 123"],
      ["2019 PLC (Labour) 77", "2019 PLC(LABOUR) 77"], ["2019 PLC at page 77", "blocked"],
    ] as Array<[string, Expect]>
  ).map(([b, e]): [string, string, Expect] => [`acronym/spelled: ${b}`, `Relying on ${b}.`, e]),
  ...(
    [
      ["shy inside SCMR", "2019 SC­MR 1234", "2019 SCMR 1234"], ["zwsp beside space before reporter", "2019 ​SCMR 1234", "2019 SCMR 1234"],
      ["zwsp inside reporter", "2019 SC​MR 1234", "2019 SCMR 1234"], ["VT splitting reporter", "2019 SC\u000bMR 1234", "2019 SCMR 1234"],
      ["FF between year and reporter", "2019\u000cSCMR 1234", "2019 SCMR 1234"], ["BOM mid-text", "2019 ﻿SCMR 1234", "refused"],
      ["ligature st in PTCL", "2019 PﬆCL 1234", "blocked"], ["shy between digits", "2019 SCMR 12­34", "refused"],
      ["zwsp beside space in page", "2019 SCMR ​1234", "2019 SCMR 1234"], ["zwsp between digit and space", "2019 SCMR 12​ 34", "blocked"],
    ] as Array<[string, string, Expect]>
  ).map(([l, b, e]): [string, string, Expect] => [`paste: ${l}`, `Relying on ${b}.`, e]),
  ...(
    [["2019 SCMR 1, 234", "blocked"], ["2019 SCMR 1, 2345", "blocked"], ["2015 SCMR 100, 105", "2015 SCMR 100"], ["2019 SCMR 12, 345", "blocked"], ["PLD 2019 SC 1, 234", "blocked"]] as Array<[string, Expect]>
  ).map(([b, e]): [string, string, Expect] => [`pinpoint: ${b}`, `Relying on ${b}.`, e]),
  ["<b>SCMR</b>", "Relying on 2019 <b>SCMR</b> 1234.", "blocked"],
]

describe("review round 5 fn5 probe matrix", () => {
  it.each(FN5)("%s", (_label, body, expected, options) => {
    const check = checkDraftCharset(body)
    if (expected === "refused") {
      expect(check.ok).toBe(false)
      return
    }
    expect(check.ok).toBe(true)
    if (!check.ok) return
    const refs = extractCitations(check.normalised, options ?? {})
    if (expected === "none") expect(refs).toEqual([])
    else if (expected === "blocked") {
      expect(refs.length).toBeGreaterThan(0)
      expect(refs.every(isSuspect), JSON.stringify(refs)).toBe(true)
    } else expect(refs).toContain(expected)
  })
})

describe("review round 5 gate5 probe: compose", () => {
  afterEach(() => resetRuntimeStoreForTests())
  let n = 0
  const key = () => `00000000-0000-4000-8556-${String(++n).padStart(12, "0")}`
  it.each([
    "Relying on 2018 CLC Lahore 789.", "Relying on 2018 CLC at page 789.", "Relying on CLC (2018) 789.", "Relying on 2018 CLC\n789.",
    "Relying on 2018 Civil Law Cases 789.", "Relying on 2019 PLC at page 77.", "Relying on 2019 PTCL at page 1234.", "Relying on 2019 SCMR at page 1234.",
    "Relying on 2018 YLR Lahore 789.", "Relying on 2018 CLC (Lah.) 789.", "Relying on 2018 CLC Lah. 789.", "Relying on 2018 CLC Karachi 789.",
  ])("%j is 422", async (body) => {
    const store = getRuntimeStore()
    const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
    for (const u of ["partner_a", "associate_a", "clerk_a"]) addMember(store, m.id, u, "firmA")
    seedJudgment(store, "j-old", "Old", "single", "2019 SCMR 1234")
    seedJudgment(store, "j-new", "New", "larger", "2021 SCMR 1")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")
    for (const c of ["2018 CLC 789", "2019 PLC 77", "2019 PTCL 1234", "2018 YLR 789"]) {
      seedJudgment(store, "o-" + c, c, "single", c)
      seedTreatment(store, "j-new", "o-" + c, "overruled", "larger")
    }
    const res = await DRAFTS(new Request("http://127.0.0.1/api/d4/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify({ action: "compose", actorId: "associate_a", matterId: m.id, templateId: getDocumentTypes()[0]!.id, title: "x", body, classification: "internal", citedJudgmentIds: [], temporalCitations: [] }),
    }))
    expect(res.status).toBe(422)
  })
})
