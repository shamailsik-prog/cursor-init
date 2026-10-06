// Review round 4 brute probe as a regression test: code points substituted or inserted at 9
// positions of an overruled citation must never give an OK gate result once they pass the
// charset layer. CI covers every block where look-alikes, symbols, digits and punctuation live;
// CITATION_BRUTE_FULL=1 runs every code point U+0080..U+10FFFF (the reviewer's full sweep).
import { it, expect } from "vitest"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"
import { extractCitations } from "@/services/d4-2/citations"
import { asciiDigit } from "@/services/d4-2/citationFold"
import { newStore } from "@/platform/spine/store"
import { seedJudgment, seedTreatment, verifyCitations } from "@/services/d4-2/draftingIntelligence"

const FULL = process.env.CITATION_BRUTE_FULL === "1"

function plainReading(ch: string): string | null {
  if (/^\p{N}$/u.test(ch)) return ch.normalize("NFKD").replace(/\p{Nd}/gu, (d) => asciiDigit(d.codePointAt(0) ?? 0))
  if (/^[\p{M}\p{Cf}]$/u.test(ch)) return ""
  if (/^\p{Z}$/u.test(ch)) return " "
  return null
}
// [start, end] inclusive
const CI_RANGES: Array<[number, number]> = [
  [0x0080, 0x07ff], // Latin-1 .. Arabic, NKo
  [0x0900, 0x0dff], // Indic digits
  [0x1d00, 0x1dbf], // phonetic extensions (small capitals, modifier letters)
  [0x1e00, 0x1fff], // Latin extended additional, Greek extended
  [0x2000, 0x2bff], // punctuation, super/subscripts, letterlike, number forms, arrows, math, enclosed, box, dingbats
  [0x2c60, 0x2c7f], // Latin extended-C
  [0x2e00, 0x2e7f], // supplemental punctuation
  [0x3000, 0x303f], // CJK punctuation
  [0xa720, 0xa7ff], // Latin extended-D (ꜱ)
  [0xab30, 0xabbf], // Latin extended-E, Cherokee supplement
  [0xfb00, 0xfdff], // alphabetic presentation forms, Arabic presentation forms-A
  [0xfe00, 0xffff], // variation selectors, small/fullwidth forms, specials
  [0x1d400, 0x1d7ff], // mathematical alphanumerics
  [0x1f100, 0x1f1ff], // enclosed alphanumeric supplement (🅲)
  [0x1f700, 0x1f77f], // alchemical symbols
  [0x1fb00, 0x1fbff], // legacy computing (🯴)
  [0xe0000, 0xe01ef], // tags, variation selectors supplement
]
const TEMPLATES: Array<[string, (c: string) => string]> = [
  ["replace C", (c) => `Relying on 2019 S${c}MR 1234.`],
  ["replace M", (c) => `Relying on 2019 SC${c}R 1234.`],
  ["insert in reporter", (c) => `Relying on 2019 SC${c}MR 1234.`],
  ["insert in page", (c) => `Relying on 2019 SCMR 12${c}34.`],
  ["replace page digit 3", (c) => `Relying on 2019 SCMR 12${c}4.`],
  ["replace year digit 0", (c) => `Relying on 2${c}19 SCMR 1234.`],
  ["replace space before page", (c) => `Relying on 2019 SCMR${c}1234.`],
  ["after page", (c) => `Relying on 2019 SCMR 1234${c}.`],
  ["before year", (c) => `Relying on ${c}2019 SCMR 1234.`],
]

it(`brute force: ${FULL ? "every code point" : "look-alike blocks"} x 9 positions never evades the gate`, () => {
  const store = newStore()
  seedJudgment(store, "j-larger", "L", "larger", "2025 SCMR 999")
  seedJudgment(store, "j-over", "O", "single", "2019 SCMR 1234")
  seedTreatment(store, "j-larger", "j-over", "overruled", "larger")
  for (const d of ["2019 SCMR 1", "2019 SCMR 12", "2019 SCMR 123", "2019 SCMR 234", "2019 SCMR 34", "2019 SCMR 4", "2019 SCMR 12345", "2019 SCMR 124", "2019 SCMR 134", "2019 SCMR 1204", "2001 SCMR 1234", "2019 SCR 1234", "2019 CLC 1234", "2019 SCMR 2"]) {
    seedJudgment(store, "d-" + d, d, "full", d)
  }
  const ranges: Array<[number, number]> = FULL ? [[0x80, 0x10ffff]] : CI_RANGES
  const evasions: string[] = []
  let checked = 0
  for (const [lo, hi] of ranges) {
    for (let cp = lo; cp <= hi; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const ch = String.fromCodePoint(cp)
      for (const [name, template] of TEMPLATES) {
        const check = checkDraftCharset(template(ch))
        if (!check.ok) continue
        checked += 1
        const res = verifyCitations(store, extractCitations(check.normalised))
        if (res.status !== "OK") continue
        // An OK result is an evasion unless it is a faithful reading: the character has a plain
        // reading (a number form reads as its digits, a mark or format character as nothing, a
        // blank as a space) and that plain text gives the same findings — "S²MR" reads as "S2MR"
        // (nothing), "SC\u0300R" / "SC\u00a0R" as SCR, "12٠4" as page 1204 (the reviewer's
        // "not deceptive" classes). Letters, symbols and punctuation have no plain reading here:
        // any OK result for them (R4-1: "S∁MR") is an evasion.
        const plain = plainReading(ch)
        const faithful =
          plain !== null &&
          JSON.stringify(verifyCitations(store, extractCitations(template(plain))).findings) === JSON.stringify(res.findings)
        if (!faithful) evasions.push(`${name} U+${cp.toString(16).toUpperCase()} -> ${JSON.stringify(res.findings)}`)
      }
    }
  }
  console.log(`brute force: ${checked} charset-accepted variants checked, ${evasions.length} evasions`)
  expect(evasions.slice(0, 20)).toEqual([])
}, 7_200_000)
