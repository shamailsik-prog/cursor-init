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
