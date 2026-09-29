import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const RULES = readFileSync("firestore.rules", "utf8")
const RULES_TEST_SOURCE = readFileSync("tests/firestore.rules.test.ts", "utf8")

const DEDICATED_VIEW_MIN = 485
const DEDICATED_VIEW_MAX = 530

function extractQuotedArray(source: string, marker: string): readonly string[] {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`missing array marker: ${marker}`)
  const bracket = source.indexOf("[", start)
  const end = source.indexOf("] as const", bracket)
  if (end < 0) throw new Error(`missing ] as const for ${marker}`)
  const block = source.slice(bracket, end)
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

function dedicatedRulePathsByView(rules: string, view: number): string[] {
  const re = new RegExp(`match /([^/]+_view${view})/\\{id\\}`, "g")
  return [...rules.matchAll(re)].map((m) => m[1])
}

function viewNumberFromPath(path: string): number | null {
  const m = path.match(/_view(\d+)$/)
  return m ? Number(m[1]) : null
}

const jobE = extractQuotedArray(
  RULES_TEST_SOURCE,
  "TB_ACK_RECON_PD_FREEZE_SEAL_DEDICATED_VIEW_COLLECTIONS"
)
const denyWritePaths = extractQuotedArray(RULES_TEST_SOURCE, "const denyWritePaths = [")

describe("lattice dedicated _view collections — static invariants (485–530)", () => {
  it("Job E list is strictly ascending by view number", () => {
    const views = jobE.map((p) => viewNumberFromPath(p))
    expect(views.every((v) => v !== null)).toBe(true)
    for (let i = 1; i < views.length; i++) {
      expect(views[i]!).toBeGreaterThan(views[i - 1]!)
    }
  })

  it.each(
    Array.from(
      { length: DEDICATED_VIEW_MAX - DEDICATED_VIEW_MIN + 1 },
      (_, i) => DEDICATED_VIEW_MIN + i
    )
  )("view %i dedicated collection alignment", (view) => {
    const rulePaths = dedicatedRulePathsByView(RULES, view)
    if (rulePaths.length === 0) {
      return
    }
    expect(rulePaths).toHaveLength(1)
    const canonical = rulePaths[0]!

    const jobMatches = jobE.filter((p) => p.endsWith(`_view${view}`))
    const denyMatches = denyWritePaths.filter((p) => p.endsWith(`_view${view}`))

    expect(jobMatches).toEqual([canonical])
    expect(denyMatches).toEqual([canonical])
  })
})
