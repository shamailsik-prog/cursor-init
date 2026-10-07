// Review round 5 (review-secgaps-r5.md): R5-1..R5-5 and the fn5 / fn6 / gate5 probes.
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { newStore } from "@/platform/spine/store"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { extractCitations } from "@/services/d4-2/citations"
import { ownCaseReferenceMatcher } from "@/services/d4-1/drafts"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"
import { seedJudgment, seedTreatment, verifyCitations } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

const isSuspect = (ref: string) => ref.startsWith("UNRECOGNISED: ")
afterEach(() => resetRuntimeStoreForTests())
let n = 0
const key = () => `00000000-0000-4000-8555-${String(++n).padStart(12, "0")}`

function composeSetup() {
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
  return m.id
}
const compose = (matterId: string, body: string) =>
  DRAFTS(new Request("http://127.0.0.1/api/d4/drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
    body: JSON.stringify({ action: "compose", actorId: "associate_a", matterId, templateId: getDocumentTypes()[0]!.id, title: "x", body, classification: "internal", citedJudgmentIds: [], temporalCitations: [] }),
  }))

describe("R5-1: acronym reporters with citation filler (court names, at page, brackets) are detected", () => {
  it.each([
    "Relying on 2018 CLC Lahore 789.",
    "Relying on 2018 CLC Karachi 789.",
    "Relying on 2018 CLC at page 789.",
    "Relying on CLC (2018) 789.",
    "Relying on 2018 YLR Lahore 789.",
    "Relying on 2019 PLC at page 77.",
    "Relying on 2019 PTCL at page 1234.",
  ])("the seven probe strings: %j composes with 422", async (body) => {
    expect((await compose(composeSetup(), body)).status).toBe(422)
  })
  it.each([
    "Relying on 2018 CLC\n789.",
    "Relying on 2019 SCMR at page 1234.",
    "Relying on 2018 CLC (Lah.) 789.",
    "Relying on 2018 CLC Lah. 789.",
    "Relying on PTCL (2019) 1234.",
    "Relying on 2019 PTCL p. 1234.",
    "Relying on 2019 PTCL vol. 2 1234.",
    "Relying on PTCL 2019 Vol. 1 page 1234.",
    "Relying on 2018 CLC Lahore High Court 789.",
    "Relying on 2018 CLC, at p. 789.",
  ])("gate5 / fn5 acronym forms: %j composes with 422", async (body) => {
    expect((await compose(composeSetup(), body)).status).toBe(422)
  })
  it("prose with an acronym, a year and a number but ordinary words between stays clean", () => {
    for (const text of [
      "4. That in 2019 Engro Fertilizers PLC entered into a supply agreement with the Plaintiff for 500 metric tons.",
      "The 2022 PTCL bill of Rs. 4,500 was disputed.",
      "The CLC committee of the Board met on 5 May 2024 and approved 3 resolutions.",
      "In 2021 PTCL Ltd. disconnected 2 lines.",
    ]) {
      expect(extractCitations(text), text).toEqual([])
    }
  })
})

describe("R5-2: a superscript / subscript / circled digit glued to a digit run makes the number ambiguous", () => {
  function fn6Store() {
    const store = newStore()
    seedJudgment(store, "L", "L", "larger", "2025 SCMR 999")
    seedJudgment(store, "over", "O", "single", "2019 SCMR 123")
    seedTreatment(store, "L", "over", "overruled", "larger")
    seedJudgment(store, "v1234", "V", "full", "2019 SCMR 1234")
    seedJudgment(store, "v1", "V", "full", "2019 SCMR 1")
    return store
  }
  it.each([
    "Relying on 2019 SCMR 123⁴.",
    "Relying on 2019 SCMR 123¹ and others.",
    "Relying on 2019 SCMR 123₄.",
    "Relying on 2019 SCMR 123④.",
    "Relying on 2019 SCMR 12³34.",
    "Relying on 2019² SCMR 123.",
  ])("fn6 footnote probe %j: never OK, never VERIFIED", (body) => {
    const check = checkDraftCharset(body)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.normalised).toContain(body.replace("Relying on ", "").slice(0, 4)) // stored as written
    const res = verifyCitations(fn6Store(), extractCitations(check.normalised))
    expect(res.status).not.toBe("OK")
    expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
  })
  it("other-script and fullwidth digits still fold faithfully", () => {
    expect(extractCitations("2019 SCMR ١٢٣٤")).toEqual(["2019 SCMR 1234"])
    expect(extractCitations("2019 SCMR １２３４")).toEqual(["2019 SCMR 1234"])
  })
})

describe("R5-2: a marker before the number taints it too", () => {
  it("'2019 SCMR ⁴123' is a suspect", () => {
    const refs = extractCitations("2019 SCMR ⁴123")
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.every(isSuspect)).toBe(true)
  })
})

describe("R5-3: a ', n' pinpoint is accepted only when page <= pinpoint <= page + 150", () => {
  it.each([
    ["2015 SCMR 100, 105", ["2015 SCMR 100"]],
    ["2019 SCMR 1234, 1240", ["2019 SCMR 1234"]],
    ["2019 SCMR 1234, 1384", ["2019 SCMR 1234"]],
    ["2019 SCMR 1, 23", ["2019 SCMR 1"]],
    ["2019 SCMR 1, 1", ["2019 SCMR 1"]],
    ["Reliance is placed on PLD 2010 SC 1, 2015 SCMR 100, 2018 CLC 789 (Lahore) and 2020 YLR 222.", ["PLD 2010 SC 1", "2015 SCMR 100", "2018 CLC 789", "2020 YLR 222"]],
  ])("%j reads exactly", (text, expected) => {
    expect(extractCitations(text)).toEqual(expected)
  })
  it.each(["2019 SCMR 1, 234", "2019 SCMR 1, 2345", "2019 SCMR 12, 345", "PLD 2019 SC 1, 234", "2019 SCMR 1234, 1385", "2019 SCMR 1234, 1200"])(
    "%j is a suspect (implausible pinpoint)",
    (text) => {
      const refs = extractCitations(text)
      expect(refs.length).toBeGreaterThan(0)
      expect(refs.every(isSuspect), JSON.stringify(refs)).toBe(true)
    }
  )
})

describe("R5-4: residue of the non-authority exclusions", () => {
  it("Urdu مقدمہ (case) is no longer a blanket exclusion: an unreported Supreme Court case is a suspect", () => {
    const refs = extractCitations("سپریم کورٹ کے مقدمہ نمبر ۱۲ بابت ۲۰۱۹ میں قرار دیا گیا")
    expect(refs.length).toBe(1)
    expect(refs.every(isSuspect)).toBe(true)
  })
  it("... but the FIR sense (زیر دفعہ after it, or ایف آئی آر / تھانہ in the clause) stays excluded", () => {
    for (const text of [
      "مقدمہ نمبر 123 سال 2024 زیر دفعہ 302 ت پ تھانہ صدر لاہور میں درج ہوا۔",
      "تھانہ گلبرگ کا مقدمہ نمبر 45 بابت 2024",
      "ایف آئی آر کا مقدمہ نمبر 45 بابت 2024",
    ]) {
      expect(extractCitations(text), text).toEqual([])
    }
  })
  it("'Diary No.' stays excluded (kept by the ruling)", () => {
    expect(extractCitations("Relying on Diary No. 1234 of 2019 decided by the Supreme Court.")).toEqual([])
  })
  it("'Civil Petition Notice No.' is excluded only because Notice sits directly before No.", () => {
    expect(extractCitations("Relying on Civil Petition Notice No. 12 of 2019.")).toEqual([])
    const refs = extractCitations("Relying on Notice in Civil Petition No. 12 of 2019.")
    expect(refs.length).toBe(1)
    expect(refs.every(isSuspect)).toBe(true)
  })
})

describe("R5-4: the own-case exemption must also match the court", () => {
  const shc = { isOwnCaseReference: ownCaseReferenceMatcher({ courtId: "SHC", caseNumber: "CP 12/2019" }) }
  it("an explicit different court within 6 tokens means no exemption", () => {
    for (const text of [
      "The Supreme Court in C.P. No. 12 of 2019 held that bail is a right.",
      "In Lahore High Court C.P. No. 12 of 2019 it was held",
      "C.P. No. 12 of 2019 decided by the Islamabad High Court",
    ]) {
      const refs = extractCitations(text, shc)
      expect(refs.length, text).toBe(1)
      expect(refs.every(isSuspect)).toBe(true)
    }
  })
  it("the same court, or no court mentioned, keeps the exemption", () => {
    expect(extractCitations("IN THE HIGH COURT OF SINDH AT KARACHI\nC.P. No. 12 of 2019\nPetitioner", shc)).toEqual([])
    expect(extractCitations("Sindh High Court C.P. No. 12 of 2019", shc)).toEqual([])
    expect(extractCitations("C.P. No. 12 of 2019", shc)).toEqual([])
  })
  it("fn5: a reported citation is never exempted; another court's Crl. Misc. is a suspect", () => {
    expect(extractCitations("2019 SCMR 1234", { isOwnCaseReference: ownCaseReferenceMatcher({ courtId: "SC_PK", caseNumber: "2019 SCMR 1234" }) })).toEqual(["2019 SCMR 1234"])
    const refs = extractCitations("Lahore High Court Crl. Misc. No. 456 of 2025 held", { isOwnCaseReference: ownCaseReferenceMatcher({ courtId: "SHC", caseNumber: "CRM 456/2025" }) })
    expect(refs.length).toBe(1)
    expect(refs.every(isSuspect)).toBe(true)
  })
})

describe("R5-4: spelled-out reporter names resolve to their abbreviations", () => {
  it.each([
    ["Relying on 2018 Civil Law Cases 789.", "2018 CLC 789"],
    ["Relying on 2019 Supreme Court Monthly Review 1234.", "2019 SCMR 1234"],
    ["Relying on Pakistan Law Decisions 2019 Supreme Court 123.", "PLD 2019 SC 123"],
    ["Relying on Pakistan Legal Decisions 2019 SC 123.", "PLD 2019 SC 123"],
    ["Relying on 2020 Yearly Law Reporter 222.", "2020 YLR 222"],
    ["Relying on 2021 Monthly Law Digest 333.", "2021 MLD 333"],
    ["Relying on 2016 Pakistan Criminal Law Journal 44.", "2016 PCrLJ 44"],
    ["Relying on 2019 Pakistan Tax Decisions 66.", "2019 PTD 66"],
    ["Relying on 2019 Pakistan Labour Cases 77.", "2019 PLC 77"],
    ["Relying on 2019 Civil Law Decisions 55.", "2019 CLD 55"],
    ["Relying on Pakistan Law Journal 2015 SC 100.", "PLJ 2015 SC 100"],
    ["Relying on National Law Reporter 2001 Civil 12.", "NLR 2001 Civil 12"],
    ["Relying on 2018 civil law cases 789.", "2018 CLC 789"],
  ])("%j -> %s", (text, citation) => {
    expect(extractCitations(text)).toContain(citation)
  })
  it("an overruled authority cited by its spelled-out name is blocked", () => {
    const store = newStore()
    seedJudgment(store, "L", "L", "larger", "2025 SCMR 999")
    seedJudgment(store, "o", "O", "single", "2018 CLC 789")
    seedTreatment(store, "L", "o", "overruled", "larger")
    expect(verifyCitations(store, extractCitations("Relying on 2018 Civil Law Cases 789.")).blocked).toBe(true)
  })
  it("the phrases in ordinary prose without a citation shape are not citations", () => {
    expect(extractCitations("The Civil Law Cases series is published monthly.")).toEqual([])
  })
})

describe("R5-5: a numeric HTML entity that decodes to a disallowed character is refused", () => {
  it.each([
    "Relying on &#x202E;4321 RMCS 9102&#x202C;.",
    "Relying on 2019 SCMR &#x202e;4321&#x202c;.",
    "Relying on &#8238;4321 RMCS 9102&#8236;.",
    "Relying on &#8238 4321 RMCS 9102.",
    "Relying on 2019 SCMR 12&#x200B;34.",
    "Tag &#xE0041; here",
    "Greek &#x3BB; here",
    "Bell &#7; here",
  ])("%j -> unsupported_characters", (body) => {
    const check = checkDraftCharset(body)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.violations.some((v) => /entity/.test(v.reason))).toBe(true)
  })
  it("entities for allowed characters stay accepted", () => {
    for (const body of ["&#169; 2024 Engro", "&#65;BC", "AT&amp;T", "line&#10;break", "&#x0627;", "Rs.&#160;500"]) {
      expect(checkDraftCharset(body).ok, body).toBe(true)
    }
  })
  it("compose refuses it with 422 unsupported_characters", async () => {
    const res = await compose(composeSetup(), "Relying on &#x202E;4321 RMCS 9102&#x202C;.")
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe("unsupported_characters")
  })
})

// Found by the round-5 30-seed sweep (4000-4029).
describe("fuzz round 5: '4. 4' mid-line, and a stand-alone symbol look-alike beside an abbreviation", () => {
  it.each(["Relying on 2019 PCrLJ\r\n4. 4 for the proposition.", "see 2019 SCMR 12. 34 for that", "see 2019 SCMR 12.  34", "Relying on 2019 PCrLJ 4.\f4 a < b for the proposition.", "see 2019 SCMR 12.\n34 for that"])("%j never resolves to the shorter page", (text) => {
    const store = newStore()
    seedJudgment(store, "d4", "Four", "full", "2019 PCrLJ 4")
    seedJudgment(store, "d12", "Twelve", "full", "2019 SCMR 12")
    const check = checkDraftCharset(text)
    expect(check.ok).toBe(true)
    const res = verifyCitations(store, extractCitations(check.ok ? check.normalised : text))
    expect(res.status).not.toBe("OK")
    expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
  })
  it("enumerations, blank lines, newlines and ellipses after a citation stay prose", () => {
    for (const text of ["2019 SCMR 1234. 5. The next issue", "2019 SCMR 1234.\n\n5 cases", "2019 SCMR 1234.\n5) next", "2019 SCMR 1234... 5 cases", "2019 SCMR 1234. The 5 cases"]) {
      expect(extractCitations(text), text).toEqual(["2019 SCMR 1234"])
    }
  })
  it.each(["Relying on 2018 \u{1f74c}\nL〰C 78\u{1fbf9} for the proposition.", "2018 \u{1f74c} LC 789", "2019 SCM \u{1ccd7} 1234", "2019 ⊤CL 5", "2019 PLD∪ 5"])(
    "%j is refused (symbol look-alike of a letter beside an abbreviation)",
    (text) => {
      const check = checkDraftCharset(text)
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.violations.some((v) => /look-alike/.test(v.reason))).toBe(true)
    }
  )
  it("ordinary uses of those symbols stay accepted", () => {
    for (const text of ["5 × 10 metres", "Length × Width", "A ∪ B of the sets", "Name │ Address"]) {
      expect(checkDraftCharset(text).ok, text).toBe(true)
    }
  })
})
