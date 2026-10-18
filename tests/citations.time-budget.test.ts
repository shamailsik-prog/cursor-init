// SEC-1 (final security audit): the citation gate and the charset check ran in super-linear time
// on attacker-shaped drafts (18 KB of "S.C.M.R. " took 15 s; a 22 KB preflight blocked the
// event loop for 19 s). Both are now linear, and a draft body is capped at
// MAX_DRAFT_BODY_CHARS (500,000) before any analysis. This file is the regression gate:
//   1. worst-case inputs at the cap finish in under 2 s each on CI-class hardware (asserted
//      at 3 s to allow for noise);
//   2. the linear scanners that replace two regexes return exactly what the regexes return.
import { describe, expect, it } from "vitest"
import { analyseCitations, LINEAR_SCANNERS_FOR_TESTS } from "@/services/d4-2/citations"
import { checkDraftCharset, MAX_DRAFT_BODY_CHARS } from "@/services/d4-2/draftCharset"
import { foldDraftText } from "@/services/d4-2/citationFold"
import { ownCaseReferenceMatcher } from "@/services/d4-1/drafts"

const BUDGET_MS = 3000

/** `unit` repeated to exactly the body cap. */
function atCap(unit: string): string {
  return unit.repeat(Math.ceil(MAX_DRAFT_BODY_CHARS / unit.length)).slice(0, MAX_DRAFT_BODY_CHARS)
}

// The audit's probes first, then the shapes that were slow in the profile of each detector.
const PATHOLOGICAL: ReadonlyArray<readonly [string, string]> = [
  ["S.C.M.R. (audit probe)", "S.C.M.R. "],
  ["No. (audit probe)", "No. "],
  ["a (audit probe)", "a "],
  ["case reference", "C.P. No. 12 of 2019 "],
  ["the matter's own case number", "Suit No. 812 of 2025 "],
  ["own case number with a court named", "In the Sindh High Court, Suit No. 812 of 2025 "],
  ["own case number beside glued court words", "xBHC xLahore High Courtx Suit No. 812 of 2025 "],
  ["type words before No.", "No. No. No. No. No. No. No. 1 of 2019 "],
  ["glued case reference", "Crl.P.L.A.No.5/2019 "],
  ["acronym reporter then number", "CLC 12 "],
  ["year then acronym reporter", "2019 CLC "],
  ["acronym in prose", "Qalvo PLC entered into 500 "],
  ["reporter, year, court", "PLD 2019 SC "],
  ["Urdu number word", "نمبر "],
  ["Urdu case reference", "مقدمہ نمبر 12 سال 2019 "],
  ["capitals", "ABC "],
  ["dotted letters", "1 . "],
  ["markup", "<b>"],
  ["entities", "&#"],
  ["glued digits", "1"],
  ["long capital run", "X"],
]

describe("SEC-1: linear time at the body cap", () => {
  const ownCase = ownCaseReferenceMatcher({ courtId: "SHC", caseNumber: "SUIT 812/2025" })

  for (const [name, unit] of PATHOLOGICAL) {
    it(`analyseCitations: ${name}`, () => {
      const body = atCap(unit)
      const started = performance.now()
      analyseCitations(body, { isOwnCaseReference: ownCase })
      expect(performance.now() - started).toBeLessThan(BUDGET_MS)
    }, 60_000)

    it(`checkDraftCharset: ${name}`, () => {
      const body = atCap(unit)
      const started = performance.now()
      checkDraftCharset(body)
      expect(performance.now() - started).toBeLessThan(BUDGET_MS)
    }, 60_000)
  }
})

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VOCAB = [
  "No", "No.", "Nos.", "No.5", "Crl.", "C.P.", "P.L.A.", "Crl.P.L.A.No.", "Civil", "Petition", "Suit", "case", "appeal",
  "bail", "writ", "original", "Reference", "Act", "FIR", "A&B", "AB&C.", "S.C.", "x.y.z.", "abcd.", "ABCDEFGHIJ", "In",
  "the", "of", "/", "-", "-K", "K", "5", "12", "123", "2019", "2020", "1999", "۔", ".", ",", "(", ")", "\n",
  "نمبر", "مقدمہ", "بابت", "سال", "سن", "آف", "تھانہ", "صدر", "ا.ب", "ایف", "Ünïcode", "𝐀𝐁",
]

function sample(rng: () => number): string {
  const parts: string[] = []
  const n = 1 + Math.floor(rng() * 16)
  for (let i = 0; i < n; i += 1) {
    parts.push(VOCAB[Math.floor(rng() * VOCAB.length)] ?? "")
    const r = rng()
    parts.push(r < 0.6 ? " " : r < 0.8 ? "" : r < 0.9 ? "   " : "\n")
  }
  return foldDraftText(parts.join("")).text
}

describe("SEC-1: the linear scanners equal the regexes they replace", () => {
  for (const [name, { scan, regex }] of Object.entries(LINEAR_SCANNERS_FOR_TESTS)) {
    it(name, () => {
      const rng = mulberry32(20261007)
      for (let i = 0; i < 20_000; i += 1) {
        const text = sample(rng)
        const expected = [...text.matchAll(regex)].map((m) => ({ index: m.index ?? 0, raw: m[0] }))
        expect(scan(text), JSON.stringify(text)).toEqual(expected)
      }
    }, 120_000)
  }
})
