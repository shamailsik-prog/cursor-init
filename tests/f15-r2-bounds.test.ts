import { describe, expect, it } from "vitest"
import * as mask from "@/platform/p1/maskOutboundPII"
import { assertMinimised } from "@/platform/p1/providerPolicy"
import * as residual from "@/platform/p1/residualPII"

/**
 * Audit F15, re-audit round 1 (FAIL 6/10), MEDIUM-2: no input of the 100,000-character body cap may make the mask, the
 * residual check or assertMinimised super-linear. Spec ruling R2-2. Each case runs what callP1 runs for a rank 3 body
 * (mask, residual counts, then assertMinimised's mask re-run and residual check) and must finish within BOUND_MS.
 *
 * The cue lists come from the modules themselves (MASK_CUES, RESIDUAL_CUES), so a cue added later is covered with no
 * change here. They are read loosely so this file also runs against the code before the fix.
 */

const BOUND_MS = 1_500
const LENGTH = 100_000
const FILLERS = [" ", "\t", "\n", "\u00A0", ".", "-", "#", "7"]
const NAMES = ["Tariq Zarvani", "Qalvo Traders (Private) Limited", "طارق زروانی"]

function rankThreeWork(body: string): number {
  const started = performance.now()
  const masked = mask.maskOutboundPII(body, { partyNames: NAMES }).masked
  residual.residualPII(masked)
  assertMinimised({ body: masked, metadata: { purpose: "committee-brain" } }, NAMES)
  return performance.now() - started
}

const build = (cue: string, filler: string) => `${cue}${filler.repeat(Math.ceil((LENGTH - cue.length - 1) / filler.length))}x`.slice(0, LENGTH)

describe("R2-2: the re-auditor's slow inputs (13 to 20 s each before the fix)", () => {
  it.each([
    ["house + spaces", "house", " "],
    ["street + spaces", "street", " "],
    ["gali + spaces", "gali", " "],
    ["mohallah + newlines", "mohallah", "\n"],
    ["house + no-break spaces", "house", "\u00A0"],
    ["Urdu gali + spaces", "گلی", " "],
  ])(
    "%s",
    (_label, cue, filler) => {
      expect(rankThreeWork(build(cue, filler))).toBeLessThan(BOUND_MS)
    },
    120_000
  )
})

const cueList = (moduleExports: object, name: string): string[] => {
  const value = (moduleExports as Record<string, unknown>)[name]
  return Array.isArray(value) ? value.filter((c): c is string => typeof c === "string") : []
}
const CUES = [...new Set([...cueList(mask, "MASK_CUES"), ...cueList(residual, "RESIDUAL_CUES")])]

describe("R2-2: every cue of the mask and the residual detector, followed by 100,000 characters of each filler", () => {
  it("the modules export their cue lists", () => {
    expect(cueList(mask, "MASK_CUES").length).toBeGreaterThan(5)
    expect(cueList(residual, "RESIDUAL_CUES").length).toBeGreaterThan(40)
  })

  it.each(CUES.map((cue) => [cue]))(
    "cue %j",
    (cue) => {
      const slow: Array<{ filler: string; ms: number }> = []
      for (const filler of FILLERS) {
        const ms = rankThreeWork(build(cue, filler))
        if (ms >= BOUND_MS) slow.push({ filler: JSON.stringify(filler), ms: Math.round(ms) })
      }
      expect(slow).toEqual([])
    },
    120_000
  )
})
