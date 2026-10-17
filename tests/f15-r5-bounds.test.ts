import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import { residualPII } from "@/platform/p1/residualPII"

/**
 * Audit F15, re-audit round 4 (FAIL 7/10): the round-5 shapes stay linear. R5-1: a run of joined emails was quadratic
 * in time and memory (48,000 characters: 37.9 s and 4.2 GB in the re-auditor's run), because every "@" restarted a
 * chain to the end of the run. R5-2 walks up to eight words after a kinship cue, R5-3 reads up to ten words after a
 * residence verb and adds new cues. Each case runs what callP1 runs for a rank 3 body (mask, residual counts, then
 * assertMinimised's mask re-run and residual check) on a 100,000-character body and must finish within BOUND_MS; the
 * email runs must also leave the heap within HEAP_MB of where it started.
 */

const BOUND_MS = 1_500
const HEAP_MB = 256
const LENGTH = 100_000
const NAMES = ["Tariq Zarvani", "Qalvo Traders (Private) Limited", "طارق زروانی"]

function rankThreeWork(body: string): number {
  const started = performance.now()
  const masked = maskOutboundPII(body, { partyNames: NAMES }).masked
  residualPII(masked)
  assertMinimised({ body: masked, metadata: { purpose: "committee-brain" } }, NAMES)
  return performance.now() - started
}

const repeat = (unit: string) => unit.repeat(Math.ceil(LENGTH / unit.length)).slice(0, LENGTH)

describe("R5-1: runs of joined emails at 100,000 characters", () => {
  it.each([
    ["a@b.pk. repeated", repeat("a@b.pk.")],
    ["a.b@c.de. repeated", repeat("a.b@c.de.")],
    ["a@b.pk- repeated", repeat("a@b.pk-")],
    ["a@b.pk_ repeated", repeat("a@b.pk_")],
    ["tariq1990@qalvo.pk. repeated", repeat("tariq1990@qalvo.pk.")],
  ])(
    "%s: within the bound, and the heap stays within its limit",
    (_label, body) => {
      const heapBefore = process.memoryUsage().heapUsed
      expect(rankThreeWork(body)).toBeLessThan(BOUND_MS)
      expect((process.memoryUsage().heapUsed - heapBefore) / 2 ** 20).toBeLessThan(HEAP_MB)
    },
    120_000
  )
})

describe("R5-2 and R5-3: the round-5 cues, repeated", () => {
  it.each([
    ["son of the then, repeated", repeat("son of the then ")],
    ["son of a sitting, repeated", repeat("son of a sitting ")],
    ["son of none other than, repeated", repeat("son of none other than ")],
    ["a table cell s/o, repeated", repeat("| s/o ")],
    ["hails from, repeated", repeat("hails from ")],
    ["belongs to Kot, repeated", repeat("belongs to Kot ")],
    ["settled at, repeated", repeat("settled at ")],
    ["residence at, repeated", repeat("residence at ")],
    ["Address of accused:, repeated", repeat("Address of accused: ")],
    ["C/o, repeated", repeat("C/o ")],
    ["lives with ten words at, repeated", repeat("lives with his widowed mother and his two unmarried sisters at ")],
    ["Urdu رہائش پذیر, repeated", repeat("رہائش پذیر ")],
    ["Urdu مقیم, repeated", repeat("مقیم ")],
    ["Urdu سکونت پذیر after بمقام, repeated", repeat("بمقام قلوو سکونت پذیر ")],
  ])(
    "%s",
    (_label, body) => {
      expect(rankThreeWork(body)).toBeLessThan(BOUND_MS)
    },
    120_000
  )
})
