import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import { residualPII } from "@/platform/p1/residualPII"

/**
 * Audit F15, re-audit round 2 (FAIL 7/10), ruling R3-1: the separators of the CNIC, IBAN, NTN, passport and mobile
 * patterns are unbounded again (as on main), and the linear-time claim must still hold. A separator class and the
 * digits after it are disjoint, so a separator run is consumed once per start, and a start sits only at a cue or at the
 * first digit of a run. Each case runs what callP1 runs for a rank 3 body (mask, residual counts, then
 * assertMinimised's mask re-run and residual check) on a 100,000-character body and must finish within BOUND_MS. The
 * cue and filler bound test of round 2 (tests/f15-r2-bounds.test.ts) covers every cue word; this file adds the shapes
 * whose separators R3-1 and R3-2 unbound, with their 100,000-character separator runs.
 */

const BOUND_MS = 1_500
const LENGTH = 100_000
const NAMES = ["Tariq Zarvani", "Qalvo Traders (Private) Limited", "طارق زروانی"]

function rankThreeWork(body: string): number {
  const started = performance.now()
  const masked = maskOutboundPII(body, { partyNames: NAMES }).masked
  residualPII(masked)
  assertMinimised({ body: masked, metadata: { purpose: "committee-brain" } }, NAMES)
  return performance.now() - started
}

/** `head`, then `filler` repeated to LENGTH, then "x" so no pattern can complete at the end. */
const build = (head: string, filler: string) =>
  `${head}${filler.repeat(Math.ceil((LENGTH - head.length - 1) / filler.length))}`.slice(0, LENGTH - 1) + "x"
/** `unit` repeated to LENGTH: a start at every repetition. */
const repeat = (unit: string) => unit.repeat(Math.ceil(LENGTH / unit.length)).slice(0, LENGTH)

const SEPARATOR_RUNS = [" ", "\t", "\n", "\u00A0", ".", "-", "_", ",", "/", ":", " / ", "/ ", " /", " - ", "--", "\u2028", "\u2800", "\u303F"]
const HEADS = [
  // CNIC: before the first and the second separator run
  "35202", "35202 1234567", "CNIC 35202",
  // IBAN: after the prefix, the check digits, the bank code and a group
  "PK", "PK36", "PK36 SCBL", "PK36 SCBL 0000",
  // NTN and passport labels, with and without No.
  "NTN", "NTN No", "N.T.N.", "passport", "Passport No.", "ppt.",
  // mobiles: after each prefix and after a group
  "0", "03", "0300", "+92", "+92 300", "0092", "92", "(0300)", "Mobile:", "Cell No.",
  // residence, address and parentage cues of round 3
  "residents of", "lives at", "address:", "Father's name", "ولدیت", "سکنائے", "House 12",
]

describe("R3-1/R3-2: a cue followed by a 100,000-character separator run", () => {
  it.each(HEADS.map((head) => [head]))(
    "head %j, every separator",
    (head) => {
      const slow: Array<{ separator: string; ms: number }> = []
      for (const separator of SEPARATOR_RUNS) {
        const ms = rankThreeWork(build(head, separator))
        if (ms >= BOUND_MS) slow.push({ separator: JSON.stringify(separator), ms: Math.round(ms) })
      }
      expect(slow).toEqual([])
    },
    120_000
  )
})

describe("R3-1/R3-2: a start at every repetition (100,000 characters)", () => {
  it.each([
    ["0 and a space", "0 "],
    ["03 and a slash with spaces", "03 / "],
    ["a digit and a spaced dash", "1 - "],
    ["a digit and a dash", "1-"],
    ["a digit and a space", "7 "],
    ["a CNIC head and a space", "35202 "],
    ["a CNIC head and its body", "35202 1234567 "],
    ["PK and check digits", "PK36 "],
    ["NTN and a colon", "NTN: "],
    ["passport and a dash", "passport - "],
    ["+92 and a space", "+92 "],
    ["a mobile one digit short", "0300 123456 "],
    ["a 13-digit run in boxes, one short", "3 5 2 0 2 - 1 2 3 4 5 6 - "],
    ["residents of village", "residents of village "],
    ["son of the said", "son of the said "],
    ["Urdu role nouns after a kinship cue", "زوجہ ملزم "],
  ])(
    "%s",
    (_label, unit) => {
      expect(rankThreeWork(repeat(unit))).toBeLessThan(BOUND_MS)
    },
    120_000
  )
})
