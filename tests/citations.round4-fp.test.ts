// Review round 4: targeted false-positive fixes. Authorities must still fail closed.
import { describe, expect, it } from "vitest"
import courtsSeed from "@/data/courts.json"
import { loadCourts, normalise } from "@/core/case-number-normaliser"
import { extractCitations } from "@/services/d4-2/citations"
import { ownCaseReferenceMatcher } from "@/services/d4-1/drafts"

const courts = loadCourts(courtsSeed as never)

const isSuspect = (ref: string) => ref.startsWith("UNRECOGNISED: ")

describe("FP1: a non-authority prefix immediately before No. is not a case reference", () => {
  it.each([
    "That FIR No. 45 of 2024 was registered at Police Station Gulberg.",
    "In FIR No. 123/2025 dated 10.01.2025 under Sections 302, 324 PPC.",
    "Challan No. 12 of 2024 was submitted.",
    "Mutation No. 4567 of 2018 was sanctioned.",
    "Khasra No. 123 of 2019 and Khewat No. 45 of 2019.",
    "Cheque No. 00412345 of 2023 was dishonoured.",
    "Letter No. 118 of 2024 was received.",
    "CNIC No. 42101 of 2020",
    "Plot No. 12 of 2015, Account No. 4 of 2019, Receipt No. 7 of 2021, Invoice No. 3 of 2022",
    "Notice No. 5 of 2024 and Memo No. 9 of 2023",
    "ایف آئی آر نمبر ۴۵ بابت ۲۰۲۴ تھانہ گلبرگ میں درج کی گئی۔",
    "چالان نمبر 12 بابت 2024",
    "انتقال نمبر 4567 بابت 2018",
    "خسرہ نمبر 123 بابت 2019",
  ])("%j", (text) => {
    expect(extractCitations(text)).toEqual([])
  })
  it("case references and disguises still fail closed", () => {
    for (const text of [
      "Criminal Appeal No. 45 of 2024",
      "Civil Petition No. 1234 of 2019",
      "First Appeal from Order No. 12 of 2019",
      "FIR Criminal Appeal No. 45 of 2024",
      "سی پی نمبر ۱۲ بابت ۲۰۱۹",
    ]) {
      const refs = extractCitations(text)
      expect(refs.length, text).toBeGreaterThan(0)
      expect(refs.every(isSuspect)).toBe(true)
    }
    expect(extractCitations("FIR No. 2019 SCMR 1234")).toContain("2019 SCMR 1234")
  })
})

describe("FP2: own case number — wider district/sessions and High Court prefixes; raw match", () => {
  it.each([
    ["SHC", "Suit No. 812 of 2025", "IN THE COURT OF SENIOR CIVIL JUDGE, KARACHI (SOUTH)\nSuit No. 812 of 2025\nMuhammad Aslam ... Plaintiff"],
    ["IHC", "Writ Petition No. 1234 of 2025", "IN THE ISLAMABAD HIGH COURT, ISLAMABAD\nWrit Petition No. 1234 of 2025\nCONSTITUTIONAL PETITION UNDER ARTICLE 199"],
    ["LHC", "Bail Application No. 456 of 2025", "IN THE COURT OF SESSIONS JUDGE, LAHORE\nBail Application No. 456 of 2025\nIn FIR No. 123/2025 dated 10.01.2025"],
    ["IHC", "Crl. Misc. No. 77 of 2025", "Crl. Misc. No. 77 of 2025"],
    ["DSJ_KHI", "Crl. Misc. No. 12 of 2025", "Crl. Misc. No. 12 of 2025"],
    ["DSJ_KHI", "Civil Revision No. 5 of 2024", "Civil Revision No. 5 of 2024"],
    ["DSJ_KHI", "Bail Appln. No. 9 of 2025", "Bail Appln. No. 9 of 2025"],
    ["FAMILY_KHI", "Family Suit No. 210 of 2025", "Family Suit No. 210 of 2025"],
  ])("%s %s heading is the matter's own case once recorded", (courtId, raw, body) => {
    const result = normalise(raw, courtId, courts)
    expect(result.status, JSON.stringify(result)).not.toBe("REJECT")
    const canonical = result.status === "REJECT" ? null : result.canonical
    expect(extractCitations(body, { isOwnCaseReference: ownCaseReferenceMatcher({ courtId, caseNumber: canonical }) })).toEqual([])
  })
  it("raw match: a reference the normaliser cannot parse matches a recorded number written the same way", () => {
    const matcher = ownCaseReferenceMatcher({ courtId: "LHC", caseNumber: "TAX REF 12/2024" })
    expect(extractCitations("Tax Ref. No. 12 of 2024", { isOwnCaseReference: matcher })).toEqual([])
    // another number in the same form is still a suspect
    expect(extractCitations("Tax Ref. No. 13 of 2024", { isOwnCaseReference: matcher }).every(isSuspect)).toBe(true)
    expect(extractCitations("Tax Ref. No. 13 of 2024", { isOwnCaseReference: matcher }).length).toBe(1)
  })
  it("other parties' case numbers still fail closed", () => {
    const matcher = ownCaseReferenceMatcher({ courtId: "LHC", caseNumber: "CRM 456/2025" })
    const refs = extractCitations("Bail Application No. 457 of 2025", { isOwnCaseReference: matcher })
    expect(refs.length).toBe(1)
    expect(refs.every(isSuspect)).toBe(true)
  })
})
