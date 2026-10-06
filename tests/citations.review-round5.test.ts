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
