import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import { residualPII } from "@/platform/p1/residualPII"

/**
 * Audit F15, re-audit round 5 (FAIL 9/10), MEDIUM-1: the Urdu "X کا / کی / کے رہائشی" (resident of X, the place
 * before the word) was not counted, though "کا رہنے والا" and "کا باشندہ" are (R4-3). Spec ruling R6-1. The inputs are
 * the re-auditor's (r5-res5); every name is invented.
 */

const ZERO = { id_digits: 0, labelled_identifier: 0, address: 0, kinship_name: 0 }
const minimised = (masked: string) => assertMinimised({ body: masked, metadata: { purpose: "committee-brain" } }, [])

describe("R6-1: Urdu کا / کی / کے رہائشی with the place before it counts as an address", () => {
  it.each([
    ["masculine", "ملزم قلوو ٹاؤن کا رہائشی ہے۔"],
    ["a witness statement", "گواہ نے بیان دیا کہ میں قلوو ٹاؤن لاہور کا رہائشی ہوں۔"],
    ["feminine", "مسماۃ نورا قلوو پورہ کی رہائشی ہے۔"],
    ["plural", "ملزمان کوٹ قلوو کے رہائشی ہیں۔"],
  ])("counts: %s", (_label, text) => {
    expect(residualPII(text).address).toBeGreaterThan(0)
    expect(minimised(maskOutboundPII(text).masked)).toBe(false)
  })

  it.each([
    // the same guards as کا رہنے والا: اسی / اپنے before the place, and a whole-country place
    ["اسی علاقے کا رہائشی", "وہ بھی اسی علاقے کا رہائشی ہے۔"],
    ["اپنے گاؤں کا رہائشی", "گواہ اپنے گاؤں کا رہائشی ہے۔"],
    ["پاکستان کا رہائشی", "وہ پاکستان کا رہائشی ہے۔"],
    // رہائشی as the adjective "residential" (R3-5) is unchanged
    ["رہائشی علاقہ", "یہ رہائشی علاقہ ہے اور یہاں دکانیں نہیں ہیں۔"],
  ])("passes: %s", (_label, text) => {
    expect(residualPII(text)).toEqual(ZERO)
    expect(minimised(maskOutboundPII(text).masked)).toBe(true)
  })
})
