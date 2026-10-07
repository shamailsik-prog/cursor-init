// Review round 6 follow-ups (review-secgaps-r6.md): F-1..F-5 and the fn7 probe.
import { describe, expect, it } from "vitest"
import { extractCitations } from "@/services/d4-2/citations"
import { ownCaseReferenceMatcher } from "@/services/d4-1/drafts"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"

const isSuspect = (ref: string) => ref.startsWith("UNRECOGNISED: ")
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
