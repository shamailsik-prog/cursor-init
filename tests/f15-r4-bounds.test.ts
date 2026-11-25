import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import { residualPII } from "@/platform/p1/residualPII"

/**
 * Audit F15, re-audit round 3 (FAIL 8/10): the round-4 additions stay linear. R4-1 runs main's patterns on the raw text
 * too; R4-2 walks further after a kinship cue; R4-3 reads the word before an Urdu residence phrase and up to six words
 * after a residence verb. Each case runs what callP1 runs for a rank 3 body (mask, residual counts, then
 * assertMinimised's mask re-run and residual check).
 *
 * Each shape is built at 25,000 and at 100,000 characters, then both are timed in this process. Linear work finishes in
 * about a quarter of the time, a ratio near SCALE. RATIO_LIMIT allows per-byte time to grow by MAX_GROWTH between those
 * lengths. The median of SAMPLES sets aside one cold or paused sample. SHORT_MS rejects a blow-up that is already
 * catastrophic at 25,000 characters, before the long call. FULL_MS is the backstop for the 100,000-character body.
 * GitHub-hosted runners have timed "Urdu باشندہ, repeated" at 1531-1548ms. A 1500ms wall on that single call fails when
 * the runner is a little slower. The ratio stays put when the whole process is slower.
 */

const FULL = 100_000
const SCALE = 4
const SHORT = FULL / SCALE
const MAX_GROWTH = 1.9
const RATIO_LIMIT = SCALE * MAX_GROWTH
const FULL_MS = 5_000
const SHORT_MS = 2_500
const SAMPLES = 3
const NAMES = ["Tariq Zarvani", "Qalvo Traders (Private) Limited", "طارق زروانی"]

function rankThreeWork(body: string): number {
  const started = performance.now()
  const masked = maskOutboundPII(body, { partyNames: NAMES }).masked
  residualPII(masked)
  assertMinimised({ body: masked, metadata: { purpose: "committee-brain" } }, NAMES)
  return performance.now() - started
}

const median = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function times(body: string, samples: number): number[] {
  const taken: number[] = []
  for (let i = 0; i < samples; i++) taken.push(rankThreeWork(body))
  return taken
}

function assertStaysLinear(label: string, make: (length: number) => string): void {
  const shortBody = make(SHORT)
  const shortProbe = rankThreeWork(shortBody)
  expect(shortProbe, `${label}: ${SHORT} characters took ${shortProbe.toFixed(0)}ms`).toBeLessThan(SHORT_MS)
  const shortMs = median([shortProbe, ...times(shortBody, SAMPLES - 1)])
  expect(shortMs, `${label}: median ${SHORT} characters took ${shortMs.toFixed(0)}ms`).toBeLessThan(SHORT_MS)

  const fullSamples = times(make(FULL), SAMPLES)
  const fullMs = median(fullSamples)
  const fullDetail = fullSamples.map((ms) => ms.toFixed(0)).join(", ")
  expect(fullMs, `${label}: median of [${fullDetail}] ms at ${FULL} characters`).toBeLessThan(FULL_MS)

  const ratio = fullMs / shortMs
  expect(
    ratio,
    `${label}: ${FULL} in ${fullMs.toFixed(0)}ms / ${SHORT} in ${shortMs.toFixed(0)}ms = ${ratio.toFixed(2)} (limit ${RATIO_LIMIT}, ${MAX_GROWTH}x linear)`
  ).toBeLessThan(RATIO_LIMIT)
}

const repeat = (unit: string) => (length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
const build = (head: string, filler: string) => (length: number) =>
  `${head}${filler.repeat(Math.ceil((length - head.length - 1) / filler.length))}`.slice(0, length - 1) + "x"
const ending = (filler: string, tail: string) => (length: number) =>
  filler.repeat(Math.ceil((length - tail.length) / filler.length)).slice(0, length - tail.length) + tail

describe("R4: a cue after or before 100,000 characters, and a start at every repetition, stays within a linear ratio", () => {
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
  ])("%s", (label, make) => assertStaysLinear(label, make), 120_000)
})
