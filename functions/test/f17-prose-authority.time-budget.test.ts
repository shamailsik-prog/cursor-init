import { describe, expect, it } from "vitest"
import { InMemoryAuthorityStore } from "../src/d4/authority"
import { groundAnswer } from "../src/p1/grounding"
import { authorityMentions } from "../src/p1/proseAuthority"

/**
 * Audit F17, re-audit round (spec ruling R7a): the prose-authority detector runs over every prose field of every answer,
 * so it must be linear. In the style of tests/citations.time-budget.test.ts (SEC-1): 64 KB of each adversarial shape
 * (the prefixes each pattern anchors on, repeated without the tail that would complete it) finishes well inside the
 * budget, alone and through `groundAnswer` (an unstructured answer, whose whole text is scanned). A quadratic scan of
 * 64 KB takes minutes; the budget allows for a loaded CI machine.
 */

const BUDGET_MS = 2000
const SIZE = 64 * 1024

const fill = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE)

const ADVERSARIAL: ReadonlyArray<readonly [string, string]> = [
  ["bracketed years", "(2099) "],
  ["bracketed year, volume", "[2099] 1 "],
  ["bracketed year, reporter, no page", "(2099) 3 SCC "],
  ["year, reporter, no page", "2099 SCC "],
  ["reporter, year, no court", "AIR 2099 "],
  ["a verified citation, repeated", "PLD 2099 SC 101 "],
  ["distinct citations past the cap", "PLD 2099 SC 1 PLD 2099 SC 2 2099 SCMR 3 "],
  ["case-number types", "C.A. "],
  ["case numbers without a year", "C.A. 777/"],
  ["No.", "No. "],
  ["No. n of", "No. 7 of "],
  ["bare connectors", "v. "],
  ["names and connectors", "Qalvo v. "],
  ["capitalised words", "Qalvo "],
  ["Urdu connectors", "بنام "],
  ["Urdu names and connectors", "حارث بنام "],
  ["the ... case", "the Qalvo "],
  ["supra", "Qalvo (supra) "],
  ["page phrases", "at page "],
  ["page cues", "judgment "],
  ["cues and pages", "judgment at page 7 "],
  ["reported phrases", "reported at "],
  ["dotted capitals", "S.C.M.R. "],
  ["a capital run", "X"],
  ["spaced capitals", "A B C D "],
  ["digits", "1"],
  ["names bound to citations", "Qalvo v. Nura (PLD 2099 SC 101) and "],
]

const store = () => {
  const s = new InMemoryAuthorityStore()
  s.addJudgment("j-good", "PLD 2099 SC 101", "division")
  return s
}

describe("audit F17 R7a: the prose-authority detector is linear (64 KB adversarial text)", () => {
  for (const [name, unit] of ADVERSARIAL) {
    it(`authorityMentions: ${name}`, () => {
      const text = fill(unit)
      const started = performance.now()
      authorityMentions(text)
      expect(performance.now() - started).toBeLessThan(BUDGET_MS)
    }, 60_000)

    it(`groundAnswer (unstructured): ${name}`, async () => {
      const text = fill(unit)
      const started = performance.now()
      const g = await groundAnswer({ text, policy: null, partyNames: [] }, store())
      expect(performance.now() - started).toBeLessThan(BUDGET_MS)
      expect(g.status).toBe("unstructured")
    }, 60_000)
  }
})
