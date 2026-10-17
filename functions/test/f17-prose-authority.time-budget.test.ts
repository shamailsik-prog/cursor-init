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
  // Re-audit round 2 (ruling R7b): the new families.
  ["possessives", "Qalvo's "],
  ["possessive cases", "Qalvo's case "],
  ["capitalised words before case", "Qalvo Nura Baz case "],
  ["In re", "In re "],
  ["In the matter of", "In the matter of "],
  ["Ex parte", "Ex parte "],
  ["names and supra", "Qalvo, supra "],
  ["bare supra and ibid", "supra ibid (ibid) "],
  ["names and a year", "Qalvo (2099) "],
  ["-v- and vrs.", "Qalvo -v- vrs. "],
  ["Urdu بمقابلہ", "قلوو بمقابلہ "],
  ["Urdu مقدمہ", "مقدمہ قلوو "],
  ["Urdu کیس", "قلوو کیس "],
  ["Urdu کے مقدمے", "قلوو کے مقدمے "],
  ["capital groups", "C.M. R.A. S.A. "],
  ["capital groups and a bracket", "W.P.(C) "],
  ["capital groups and a number", "Crl.P.L.A. 77/"],
  ["year-first case numbers", "No. 2099/"],
  ["bracketed volumes", "2099 (3) "],
  ["reporter-first volumes", "JT 2099 (3) "],
  ["US reports without a page", "550 U.S. "],
  ["federal reporters", "123 F.3d "],
  ["lower-case reporters", "(2099) 3 scc "],
  ["paragraphs and cues", "decision at para 7 "],
  ["paragraph marks", "¶ "],
  ["years near capitals", "2099 AB CD EF "],
  ["Urdu digits", "۲۰۹۹ "],
  ["full-width digits", "２０９９ "],
  ["zero-width characters", "​"],
  ["dashes", "C.A. 7–"],
  ["prefixes", "M/s Messrs Mst. "],
  ["brackets before connectors", "(a b) v "],
  ["unclosed brackets before connectors", "a b) v "],
  ["judgment in", "judgment in "],
  ["US short forms", "550 U.S. at "],
  ["volume-first reporters", "77 DLR "],
  ["neutral citations", "MANU/SC/"],
  ["Urdu titled cases", "مقدمہ بعنوان "],
]

/** The re-auditor's worst cases (prose4-head3.json), four times over: 256 KB. */
const WORST_256K: ReadonlyArray<readonly [string, string]> = [
  ["distinct case numbers past the cap", Array.from({ length: 24_000 }, (_, i) => `C.P. No. ${i} of 2099`).join(" ").slice(0, 4 * SIZE)],
  ["lower-case connectors", fill("a v ").repeat(4)],
  ["Urdu names", fill("قلوو بنام نورا ").repeat(4)],
  ["years and capitals", fill("(2099) 3 ABC ").repeat(4)],
  ["distinct possessive cases", Array.from({ length: 24_000 }, (_, i) => `Qalvo${i}'s case`).join(" ").slice(0, 4 * SIZE)],
  ["distinct reports past the cap", Array.from({ length: 24_000 }, (_, i) => `(2099) 3 SCC ${i}`).join(" ").slice(0, 4 * SIZE)],
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

  for (const [name, text] of WORST_256K) {
    it(`groundAnswer (unstructured, 256 KB): ${name}`, async () => {
      const started = performance.now()
      const g = await groundAnswer({ text, policy: null, partyNames: [] }, store())
      expect(performance.now() - started).toBeLessThan(BUDGET_MS)
      expect(g.status).toBe("unstructured")
    }, 60_000)
  }
})
