// Review round 4: targeted false-positive fixes. Authorities must still fail closed.
import { describe, expect, it } from "vitest"
import { extractCitations } from "@/services/d4-2/citations"

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
