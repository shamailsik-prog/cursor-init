// Review round 6 follow-ups (review-secgaps-r6.md): F-1..F-5 and the fn7 probe.
import { describe, expect, it } from "vitest"
import { extractCitations, isUnrecognisedRef as isSuspect } from "@/services/d4-2/citations"
import { ownCaseReferenceMatcher } from "@/services/d4-1/drafts"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"

const blocked = (refs: string[]) => refs.length > 0 && refs.every(isSuspect)

describe("F-1: a court name in the clause defeats the FIR-sense مقدمہ exclusion", () => {
  it.each([
    "سپریم کورٹ کے مقدمہ نمبر ۱۲ بابت ۲۰۱۹ زیر دفعہ ۳۰۲ میں قرار دیا گیا",
    "سپریم کورٹ کے مقدمہ نمبر ۱۲ بابت ۲۰۱۹ میں جو تھانہ صدر سے متعلق تھا قرار دیا گیا",
    "تھانہ صدر کے حوالے سے لاہور ہائی کورٹ کے مقدمہ نمبر ۱۲ بابت ۲۰۱۹ میں قرار دیا گیا",
    "عدالت عظمیٰ کے مقدمہ نمبر 12 بابت 2019 زیر دفعہ 302",
    "Supreme Court کے مقدمہ نمبر 12 بابت 2019 زیر دفعہ 302",
  ])("%j is a suspect", (text) => {
    expect(blocked(extractCitations(text)), JSON.stringify(extractCitations(text))).toBe(true)
  })
  it("the FIR case without a court name stays excluded (corpus passage)", () => {
    expect(extractCitations("مقدمہ نمبر 123 سال 2024 زیر دفعہ 302 ت پ تھانہ صدر لاہور میں درج ہوا۔")).toEqual([])
  })
})

describe("F-2: own-case court check knows seat cities, benches and apex phrases, over the whole sentence", () => {
  const shc = { isOwnCaseReference: ownCaseReferenceMatcher({ courtId: "SHC", caseNumber: "CP 12/2019" }) }
  it.each([
    "The learned Lahore bench in C.P. No. 12 of 2019 held that …",
    "In Islamabad C.P. No. 12 of 2019 the court held …",
    "In LHC C.P. No. 12 of 2019 it was held …",
    "The Supreme Court of Pakistan, in its detailed judgment in C.P. No. 12 of 2019, held …",
    "The apex court in C.P. No. 12 of 2019 held …",
    "In C.P. No. 12 of 2019 the Honourable Supreme Court held …",
    "The Hon'ble Supreme Court, after hearing both sides at length over several dates, in C.P. No. 12 of 2019 held …",
    "The Multan bench in C.P. No. 12 of 2019 held …",
    "The Peshawar High Court at Abbottabad in C.P. No. 12 of 2019 held …",
    "The bench at D.I. Khan in C.P. No. 12 of 2019 held …",
    "The learned bench at Quetta in C.P. No. 12 of 2019 held …",
    "عدالت عظمیٰ نے C.P. No. 12 of 2019 میں قرار دیا",
  ])("SHC matter, other court: %j is not exempted", (text) => {
    expect(blocked(extractCitations(text, shc)), JSON.stringify(extractCitations(text, shc))).toBe(true)
  })
  it.each([
    "This Honourable Sindh High Court in C.P. No. 12 of 2019 …",
    "The Hyderabad bench of this Court in C.P. No. 12 of 2019 …",
    "IN THE HIGH COURT OF SINDH AT KARACHI\nC.P. No. 12 of 2019",
    "C.P. No. 12 of 2019 was heard at Sukkur.",
    "C.P. No. 12 of 2019",
  ])("SHC matter, own court or no court: %j stays exempted", (text) => {
    expect(extractCitations(text, shc)).toEqual([])
  })
  it("a city seating both a High Court and the district courts does not block either tier; a city seating only another tier does", () => {
    const dsj = { isOwnCaseReference: ownCaseReferenceMatcher({ courtId: "DSJ_KHI", caseNumber: "SUIT 812/2025" }) }
    expect(extractCitations("IN THE COURT OF SENIOR CIVIL JUDGE, KARACHI (SOUTH)\nSuit No. 812 of 2025", dsj)).toEqual([])
    expect(blocked(extractCitations("The Sukkur bench in Suit No. 812 of 2025 held", dsj))).toBe(true)
    const lhc = { isOwnCaseReference: ownCaseReferenceMatcher({ courtId: "LHC", caseNumber: "CRM 456/2025" }) }
    expect(extractCitations("IN THE COURT OF SESSIONS JUDGE, LAHORE\nBail Application No. 456 of 2025", lhc)).toEqual([])
  })
})

describe("F-3: more spelled-out reporter names (checked against REPORTER_TOKENS: SCR, KLR, GBLR, PTCL)", () => {
  it.each([
    ["Relying on 2019 Supreme Court Reports 100.", "2019 SCR 100"],
    ["Relying on 2001 Karachi Law Reports 1.", "2001 KLR 1"],
    ["Relying on 2019 Gilgit-Baltistan Law Reports 5.", "2019 GBLR 5"],
    ["Relying on 2019 Gilgit Baltistan Law Reports 5.", "2019 GBLR 5"],
    ["Relying on 2019 Pakistan Tax & Corporate Law 1234.", "2019 PTCL 1234"],
    ["Relying on 2019 Pakistan Tax and Corporate Law 1234.", "2019 PTCL 1234"],
    ["Relying on 2019 Supreme Court\nMonthly Review 1234.", "2019 SCMR 1234"],
  ])("%j -> %s", (text, citation) => {
    expect(extractCitations(text)).toContain(citation)
  })
})

describe("F-4: a sentence starting with a numeral after a citation is prose; ambiguous pages stay closed", () => {
  it.each([
    ["Reliance is placed on 2015 SCMR 100. 5 witnesses were examined.", ["2015 SCMR 100"]],
    ["See 2015 SCMR 100.  12 days later the order was passed.", ["2015 SCMR 100"]],
    ["See PLD 2010 SC 1. 3 of the 5 grounds fail.", ["PLD 2010 SC 1"]],
    ["See 2015 SCMR 100. 2 Witnesses were examined.", ["2015 SCMR 100"]],
    ["See 2015 SCMR 100. 5. The next point.", ["2015 SCMR 100"]],
  ])("%j", (text, expected) => {
    expect(extractCitations(text)).toEqual(expected)
  })
  it.each([
    "Relying on 2019 PCrLJ\r\n4. 4 for the proposition.",
    "Relying on 2019 PCrLJ 4.\n4 a < b for the proposition.",
    "see 2019 SCMR 12. 34 for that",
    "see 2019 SCMR 12.  34",
    "see 2019 SCMR 12. 34 the case",
  ])("%j stays ambiguous", (text) => {
    expect(blocked(extractCitations(text)), JSON.stringify(extractCitations(text))).toBe(true)
  })
})

describe("F-5: × between two capitalised tokens reads as 'versus' and is allowed", () => {
  it.each(["The parties are ABC × XYZ in this matter.", "Muhammad Akram × The State", "M/s Engro Fertilizers PLC × NADRA"])("%j is accepted", (text) => {
    expect(checkDraftCharset(text).ok).toBe(true)
  })
  it.each(["Item ⊤ SECP filing", "Clause (a) ∣ ABC", "AB ⋁ CD", "2018 × LC 789", "ABC×XYZ", "2018 \u{1f74c} LC 789"])("contrived symbol forms stay refused: %j", (text) => {
    expect(checkDraftCharset(text).ok).toBe(false)
  })
})
