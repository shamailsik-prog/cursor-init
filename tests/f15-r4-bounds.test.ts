import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import { residualPII } from "@/platform/p1/residualPII"

/**
 * Audit F15, re-audit round 3 (FAIL 8/10): the round-4 additions stay linear. R4-1 runs main's patterns on the raw text
 * too; R4-2 walks further after a kinship cue; R4-3 reads the word before an Urdu residence phrase and up to six words
 * after a residence verb. Each case runs what callP1 runs for a rank 3 body (mask, residual counts, then
 * assertMinimised's mask re-run and residual check) on a 100,000-character body and must finish within BOUND_MS. The
 * cue lists of both modules are also run by tests/f15-r2-bounds.test.ts.
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

const build = (head: string, filler: string) =>
  `${head}${filler.repeat(Math.ceil((LENGTH - head.length - 1) / filler.length))}`.slice(0, LENGTH - 1) + "x"
const repeat = (unit: string) => unit.repeat(Math.ceil(LENGTH / unit.length)).slice(0, LENGTH)
const ending = (filler: string, tail: string) => filler.repeat(Math.ceil((LENGTH - tail.length) / filler.length)).slice(0, LENGTH - tail.length) + tail

describe("R4: a cue after or before 100,000 characters, and a start at every repetition", () => {
  it.each([
    // R4-1: main's patterns on the raw text, with Unicode glue
    ["a zero-width CNIC glue, repeated", repeat("\u200B3520212345671 ")],
    ["a ligature after a bracketed phone, repeated", repeat("(371) 6656495\uFB01")],
    ["PK and NBSPs", build("PK36", "\u00A0")],
    ["NTN and NBSPs", build("NTN", "\u00A0")],
    ["passport and combining marks", build("passport", "\u0301")],
    ["an email local part of 100,000 dots and letters", build("a", ".a")],
    ["an email glue, repeated", repeat("\uFF41K9@x9.Org\uFE0F")],
    // R4-2: the kinship walk
    ["son of the, repeated", repeat("son of the ")],
    ["son of the deceased driver, repeated", repeat("son of the deceased driver ")],
    ["son of an absconding accused, repeated", repeat("son of an absconding accused ")],
    ["Urdu kinship cue and a role, repeated", repeat("ولد ملزم ")],
    ["Urdu kinship cue and an ordinal, repeated", repeat("زوجہ اول ")],
    // R4-3: residence
    ["Urdu residence phrase after 100,000 letters", ending("ا", " کا رہنے والا")],
    ["Urdu residence phrase, repeated", repeat("قلوو کا رہنے والا ")],
    ["Urdu باشندہ, repeated", repeat("کا باشندہ ")],
    ["lives with his parents at, repeated", repeat("lives with his parents at ")],
    ["living at and letters (the re-auditor's slowest)", build("living at", "a")],
    ["resident of Pakistan and of, repeated", repeat("resident of Pakistan and of ")],
    ["r/o Punjab Colony, repeated", repeat("r/o Punjab Colony ")],
    ["House No. 12 of the, repeated", repeat("House No. 12 of the ")],
    ["residents of Kot, repeated", repeat("residents of Kot ")],
  ])(
    "%s",
    (_label, body) => {
      expect(rankThreeWork(body)).toBeLessThan(BOUND_MS)
    },
    120_000
  )
})
