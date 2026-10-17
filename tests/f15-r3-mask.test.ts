import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { detectionView } from "@/platform/p1/piiText"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import { residualPII } from "@/platform/p1/residualPII"

/**
 * Audit F15, re-audit round 2 (FAIL 7/10): the mask. Spec rulings R3-1 (unbounded CNIC, IBAN, NTN and passport
 * separators: everything main masked is masked again), R3-2 (mobile separators) and R3-7 (detection view, form-box and
 * grouped CNICs). Inputs are the re-auditor's (r2-mainregress, r2-sepregress, r2-smuggle, r2-misc). Every name is
 * invented; every number is synthetic.
 */

const ZERO = { id_digits: 0, labelled_identifier: 0, address: 0, kinship_name: 0 }
const minimised = (masked: string) => assertMinimised({ body: masked, metadata: { purpose: "committee-brain" } }, [])
const ANY_DIGIT = /\p{Nd}/u

describe("R3-1: every identifier main masked is masked again (the re-auditor's r2-mainregress and r2-sepregress)", () => {
  it.each([
    ["IBAN, four spaces between groups", "IBAN PK36    SCBL    0000    0011    2345    6702 on file", "IBAN [IBAN] on file"],
    ["IBAN, one space", "IBAN PK36 SCBL 0000 0011 2345 6702 on file", "IBAN [IBAN] on file"],
    ["NTN, colon and five spaces", "NTN:     1234567-8 on file", "[NTN] on file"],
    ["NTN, dash and four spaces", "NTN -    1234567-8 on file", "[NTN] on file"],
    ["passport, colon and five spaces", "Passport:     AB1234567 on file", "[PASSPORT] on file"],
    ["passport, lower case, dash and four spaces", "passport -    ab1234567 on file", "[PASSPORT] on file"],
    ["CNIC, five spaces", "CNIC 35202     1234567     1 on record", "CNIC [CNIC] on record"],
    ["CNIC, four line breaks", "CNIC\n35202\n\n\n\n1234567\n\n\n\n1", "CNIC\n[CNIC]"],
    ["CNIC, spaced dashes", "35202 -   1234567 -   1", "[CNIC]"],
    ["two mobiles", "Contact 0300-1234567 or 0300 1234567", "Contact [PHONE] or [PHONE]"],
    ["CNIC, four spaces", "CNIC 35202    1234567    1 on record", "CNIC [CNIC] on record"],
    ["CNIC wrapped over a line and indented", "CNIC 35202-\n      1234567-1 on record", "CNIC [CNIC] on record"],
    ["CNIC, space dash two spaces", "CNIC 35202 -  1234567 -  1 on record", "CNIC [CNIC] on record"],
    ["CNIC, four tabs", "CNIC 35202\t\t\t\t1234567\t\t\t\t1 on record", "CNIC [CNIC] on record"],
    ["CNIC, spaced dots", "CNIC 35202 . . 1234567 . . 1 on record", "CNIC [CNIC] on record"],
    ["CNIC in a table cell", "| CNIC | 35202      1234567      1 |", "| CNIC | [CNIC] |"],
    ["Urdu-digit CNIC, four spaces", "شناختی کارڈ ۳۵۲۰۲    ۱۲۳۴۵۶۷    ۱", "شناختی کارڈ [CNIC]"],
    // The ruling's wider class, [.\-\s_,/], is unbounded too: runs main's class did not hold.
    ["CNIC, four underscores", "CNIC 35202____1234567____1 on record", "CNIC [CNIC] on record"],
    ["CNIC, comma and spaces", "CNIC 35202 ,  1234567 ,  1 on record", "CNIC [CNIC] on record"],
    ["CNIC, spaced slashes", "CNIC 35202 / / 1234567 / / 1 on record", "CNIC [CNIC] on record"],
  ])("%s", (_label, text, expected) => {
    const masked = maskOutboundPII(text).masked
    expect(masked).toBe(expected)
    expect(ANY_DIGIT.test(masked)).toBe(false)
    expect(residualPII(masked)).toEqual(ZERO)
  })
})

describe("R3-2: mobile separators are unbounded; a slash counts only where it touches whitespace", () => {
  it.each([
    ["four spaces", "Contact Kamran on 0300    1234567 after the hearing.", "Contact Kamran on [PHONE] after the hearing."],
    ["two tabs", "Contact Kamran on 0300\t\t1234567 after the hearing.", "Contact Kamran on [PHONE] after the hearing."],
    ["space slash space", "Contact Kamran on 0300 / 1234567 after the hearing.", "Contact Kamran on [PHONE] after the hearing."],
    ["slash then space", "Contact Kamran on 0300/ 1234567 after the hearing.", "Contact Kamran on [PHONE] after the hearing."],
    ["space then slash", "Contact Kamran on 0300 /1234567 after the hearing.", "Contact Kamran on [PHONE] after the hearing."],
    ["spaced double dash", "Contact Kamran on 0300 -- 1234567 after the hearing.", "Contact Kamran on [PHONE] after the hearing."],
    ["colon", "Contact Kamran on 0300:1234567 after the hearing.", "Contact Kamran on [PHONE] after the hearing."],
    ["labelled, slash", "Mobile: 0300 / 1234567", "Mobile: [PHONE]"],
    ["labelled, four spaces", "Cell No. 0300    1234567", "Cell No. [PHONE]"],
    ["a line break and an indent", "Mobile\n0300\n  1234567", "Mobile\n[PHONE]"],
    ["+92 and four spaces", "Contact +92    300 1234567", "Contact [PHONE]"],
    ["four line separators (U+2028)", "Contact 0300\u2028\u2028\u2028\u20281234567 today", "Contact [PHONE] today"],
    ["after a date", "dated 01.02.2021 0300 1234567", "dated 01.02.2021 [PHONE]"],
    ["boxes", "Mobile 0 3 0 0 1 2 3 4 5 6 7", "Mobile [PHONE]"],
  ])("masks: %s", (_label, text, expected) => {
    const masked = maskOutboundPII(text).masked
    expect(masked).toBe(expected)
    expect(residualPII(masked)).toEqual(ZERO)
  })

  it.each([
    ["a date and a count, slashes", "On 03/01/2021 123 witnesses were examined."],
    ["a date and a count, dots", "On 03.01.2021 123 accused were present."],
    ["a date and a count, dashes", "On 03-01-2021 312 acres were attached."],
    ["a date and a time", "The hearing on 01.02.2021 10.30 a.m. was adjourned."],
    ["a time with a colon", "The occurrence took place at 03:30 a.m. on 12.03.2021."],
  ])("leaves alone: %s", (_label, text) => {
    expect(maskOutboundPII(text).masked).toBe(text)
    expect(residualPII(text)).toEqual(ZERO)
    expect(minimised(text)).toBe(true)
  })
})

describe("R3-7: invisible and blank-looking separators, and CNICs in boxes or groups", () => {
  it.each([
    ["U+2800 (braille blank) is a space", "a\u2800b", "a b"],
    ["U+303F (ideographic half fill space) is a space", "a\u303Fb", "a b"],
    ["U+E000 (private use) is dropped", "a\uE000b", "ab"],
    ["U+F8FF (private use) is dropped", "a\uF8FFb", "ab"],
    ["U+F0000 (supplementary private use) is dropped", "a\u{F0000}b", "ab"],
  ])("detection view: %s", (_label, text, expected) => {
    expect(detectionView(text).text).toBe(expected)
  })

  it.each([
    ["a braille blank between groups", "Contact 0300\u28001234567 today", "Contact [PHONE] today"],
    ["an ideographic half fill space between groups", "Contact 0300\u303F1234567 today", "Contact [PHONE] today"],
    ["a private-use character between groups", "Contact 0300\uE0001234567 today", "Contact [PHONE] today"],
    ["a form-box CNIC", "CNIC 3 5 2 0 2 - 1 2 3 4 5 6 7 - 1", "CNIC [CNIC]"],
    ["a 4-4-4-1 CNIC", "CNIC 3520 2123 4567 1 on record.", "CNIC [CNIC] on record."],
    ["a 4-4-4-1 CNIC after an amount word", "the amount 3520 2123 4567 1 was noted", "the amount [CNIC] was noted"],
    ["a 4-4-4-1 CNIC after Rs", "Rs. 3520 2123 4567 1", "Rs. [CNIC]"],
    ["a 4-4-4-1 CNIC before /-", "3520 2123 4567 1/-", "[CNIC]/-"],
    ["a 4-4-4-1 CNIC after Diary No.", "Diary No. 3520 2123 4567 1", "Diary No. [CNIC]"],
    ["a 4-4-4-1 CNIC after khasra", "khasra 3520 2123 4567 1", "khasra [CNIC]"],
    ["a dashed 4-4-4-1 CNIC after case No.", "case No. 3520-2123-4567-1", "case No. [CNIC]"],
  ])("masks %s", (_label, text, expected) => {
    const masked = maskOutboundPII(text).masked
    expect(masked).toBe(expected)
    expect(residualPII(masked)).toEqual(ZERO)
  })

  it.each([
    "The years 2018 2019 2020 2021 were assessed together.",
    "Reliance is placed on PLD 2019 SC 123 and 2020 SCMR 456.",
    "On 12.03.2021, 13.03.2021 and 14.03.2021 the accused was absent.",
    "Between 01/01/2019 and 31/12/2020 no payment was made.",
    "FIR No. 1234/2021 dated 12.03.2021 under sections 302/324/34 PPC, P.S. Saddar.",
    "The period 12-03-2021 to 15-04-2022 is in issue.",
    "Sections 302 324 148 149 PPC were applied.",
    "Khasra Nos. 1234/1 1235/2 1236/3 were in dispute.",
    "The claim of Rs. 1,234,567,890/- was decreed.",
    "Exhibits P-1 to P-13 were tendered on 1-2-2021 and 3-2-2021.",
    "2019 SCMR 1234 and 2020 SCMR 5678 and 2021 SCMR 9012 were cited.",
    "Appeals 12 - 13 - 14 of 2021 were heard together.",
  ])("dates, citations and lists stay clean: %s", (text) => {
    expect(maskOutboundPII(text).masked).toBe(text)
    expect(residualPII(text)).toEqual(ZERO)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// R3-1: a differential test. Main's patterns (origin/main 0844ed8, platform/p1/maskOutboundPII.ts) are the oracle: on
// generated ASCII inputs the mask must never leave a letter or digit that main removed.
// ---------------------------------------------------------------------------------------------------------------------

/** Main's patterns, verbatim, in main's order (sequential replacement). */
const MAIN_PATTERNS: ReadonlyArray<readonly [token: string, re: RegExp]> = [
  ["[CNIC]", /\b\d{5}[.\-\s]+\d{7}[.\-\s]+\d\b/g],
  ["[CNIC]", /\b\d{13}\b/g],
  ["[PHONE]", /\(0?3\d{2}\)[.\s-]?\d{7}\b/g],
  ["[PHONE]", /(?:\+92|92|0)[.\s-]?3\d{2}[.\s-]?\d{7}\b/g],
  ["[EMAIL]", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ["[IBAN]", /\bPK\s*\d{2}\s*[A-Z]{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\b/gi],
  ["[NTN]", /\bNTN[:\s-]*\d{7}-\d\b/gi],
  ["[PASSPORT]", /\b(?:passport|ppt\.?)[:\s-]*[A-Z]{2}\d{7}\b/gi],
]
const mainMask = (text: string) => MAIN_PATTERNS.reduce((t, [token, re]) => t.replace(re, token), text)

const TOKENS = /\[(?:CNIC|PHONE|PARTY|EMAIL|IBAN|NTN|PASSPORT)\]/g
/** The letters and digits a masked text still carries, in order, tokens removed. */
const residue = (masked: string) => masked.replace(TOKENS, "").replace(/[^0-9A-Za-z]/g, "")
function isSubsequence(small: string, big: string): boolean {
  let j = 0
  for (const ch of small) {
    j = big.indexOf(ch, j)
    if (j < 0) return false
    j += 1
  }
  return true
}

/** A small seeded generator (mulberry32), so a failure is reproducible. */
function generator(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!
  const digits = (n: number) => Array.from({ length: n }, () => String(int(10))).join("")
  const letters = (n: number, from = "ABCDEFGHIJKLMNOPQRSTUVWXYZ") => Array.from({ length: n }, () => pick([...from])).join("")
  const run = (chars: readonly string[], min: number, max: number) =>
    Array.from({ length: min + int(max - min + 1) }, () => pick(chars)).join("")
  const casing = (word: string) => [...word].map((c) => (int(2) === 0 ? c.toLowerCase() : c.toUpperCase())).join("")
  return { int, pick, digits, letters, run, casing }
}

const MAIN_CNIC_SEP = [" ", "\t", "\n", "\r", ".", "-"]
const MAIN_PHONE_SEP = ["", " ", "\t", "\n", ".", "-"]
const MAIN_WS = [" ", "\t", "\n", "\r"]
const MAIN_LABEL_SEP = [":", " ", "\t", "\n", "-"]

function differentialInputs(count: number, seed: number): string[] {
  const g = generator(seed)
  const shapes: Array<() => string> = [
    () => `${g.digits(5)}${g.run(MAIN_CNIC_SEP, 1, 7)}${g.digits(7)}${g.run(MAIN_CNIC_SEP, 1, 7)}${g.digits(1)}`,
    () => g.digits(13),
    () => `${g.pick(["+92", "92", "0"])}${g.pick(MAIN_PHONE_SEP)}3${g.digits(2)}${g.pick(MAIN_PHONE_SEP)}${g.digits(7)}`,
    () => `(${g.pick(["0", ""])}3${g.digits(2)})${g.pick(MAIN_PHONE_SEP)}${g.digits(7)}`,
    () =>
      `${g.run([..."abcXYZ019._%+-"], 1, 8)}@${g.run([..."abcXYZ019.-"], 1, 8)}.${g.letters(2 + g.int(3), "abcdeXYZ")}`,
    () =>
      `${g.casing("PK")}${g.run(MAIN_WS, 0, 5)}${g.digits(2)}${g.run(MAIN_WS, 0, 5)}${g.letters(4, "ABCSLabcsl")}` +
      Array.from({ length: 4 }, () => `${g.run(MAIN_WS, 0, 5)}${g.digits(4)}`).join(""),
    () => `${g.casing("NTN")}${g.run(MAIN_LABEL_SEP, 0, 7)}${g.digits(7)}-${g.digits(1)}`,
    () => `${g.casing(g.pick(["passport", "ppt", "ppt."]))}${g.run(MAIN_LABEL_SEP, 0, 7)}${g.letters(2, "ABZabz")}${g.digits(7)}`,
    () => g.digits(1 + g.int(14)),
  ]
  const before = ["", "", "Client ", "x", "No. ", "(", "#", "1", "a-", "_", "+", "0", ": ", "\n"]
  const after = ["", "", " on file", ".", "x", "1", ")", "-", "_", "@", "-1", " 9", ",", "\n"]
  const inputs: string[] = []
  for (let i = 0; i < count; i++) {
    const parts = Array.from({ length: 1 + g.int(3) }, () => `${g.pick(before)}${g.pick(shapes)()}${g.pick(after)}`)
    inputs.push(parts.join(g.pick([" ", " and ", "\n", "", ", "])))
  }
  return inputs
}

describe("R3-1: differential against main's patterns (the oracle) on generated ASCII inputs", () => {
  it("the oracle is main's: it masks the shapes the generator draws", () => {
    expect(mainMask("CNIC 35202     1234567     1 on record")).toBe("CNIC [CNIC] on record")
    expect(mainMask("IBAN PK36    SCBL    0000    0011    2345    6702 on file")).toBe("IBAN [IBAN] on file")
    expect(mainMask("NTN:     1234567-8 on file")).toBe("[NTN] on file")
  })

  it.each([[20261016], [7], [424242]])("seed %i: 3,000 inputs, the mask never leaves a letter or digit main removed", (seed) => {
    const misses: Array<{ input: string; main: string; mask: string }> = []
    for (const input of differentialInputs(3_000, seed)) {
      const main = mainMask(input)
      const mask = maskOutboundPII(input).masked
      if (!isSubsequence(residue(mask), residue(main))) misses.push({ input, main, mask })
    }
    expect(misses.slice(0, 10)).toEqual([])
  })
})
