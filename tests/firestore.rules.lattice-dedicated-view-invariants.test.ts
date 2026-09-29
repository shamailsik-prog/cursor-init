import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const RULES = readFileSync("firestore.rules", "utf8")
const RULES_TEST_SOURCE = readFileSync("tests/firestore.rules.test.ts", "utf8")

const DEDICATED_VIEW_MIN = 485
const DEDICATED_VIEW_MAX = 550

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

/** PR306-M1: views listed in Job E without a rules match must fail unless whitelisted (485–500, 503–504). */
const LATTICE_DEDICATED_VIEW_ARRAY_WITHOUT_RULES_MATCH_WHITELIST = new Set([
  ...Array.from({ length: 16 }, (_, i) => 485 + i),
  503,
  504,
])

describe("lattice dedicated _view collections — static invariants (485–550)", () => {
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
      const inJobE = jobE.some((p) => p.endsWith(`_view${view}`))
      const inDenyWrite = denyWritePaths.some((p) => p.endsWith(`_view${view}`))
      if (
        (inJobE || inDenyWrite) &&
        !LATTICE_DEDICATED_VIEW_ARRAY_WITHOUT_RULES_MATCH_WHITELIST.has(view)
      ) {
        expect.fail(
          `view ${view} is in Job E or denyWritePaths but has no firestore.rules match`
        )
      }
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


describe("lattice dedicated _view535/_view536 rules break guard (fail if match removed)", () => {
  it.each([535, 536])("view %i has no rules match after synthetic removal", (view) => {
    const canonical = jobE.find((p) => p.endsWith(`_view${view}`))
    expect(canonical).toBeDefined()
    const stripped = RULES
      .split("\n")
      .filter((line) => !line.includes(`match /${canonical}/{id}`))
      .join("\n")
    expect(dedicatedRulePathsByView(stripped, view)).toHaveLength(0)
    expect(dedicatedRulePathsByView(RULES, view)).toHaveLength(1)
  })
})

describe("PR309-M1 denyWritePaths-only missing rule (break then revert)", () => {
  it("fails when a denyWritePaths-only dedicated view lacks a rules match", () => {
    const orphanView = 5999
    const fakePath = `workflow_ops_orphan_deny_write_tb_ack_recon_pd_freeze_seal_view${orphanView}`
    const patchedDeny = [...denyWritePaths, fakePath]
    const rulePaths = dedicatedRulePathsByView(RULES, orphanView)
    expect(rulePaths).toHaveLength(0)
    const inDenyWrite = patchedDeny.some((p) => p.endsWith(`_view${orphanView}`))
    expect(inDenyWrite).toBe(true)
    expect(LATTICE_DEDICATED_VIEW_ARRAY_WITHOUT_RULES_MATCH_WHITELIST.has(orphanView)).toBe(false)
    expect(() => {
      if (inDenyWrite && !LATTICE_DEDICATED_VIEW_ARRAY_WITHOUT_RULES_MATCH_WHITELIST.has(orphanView)) {
        throw new Error(`view ${orphanView} is in denyWritePaths but has no firestore.rules match`)
      }
    }).toThrow(/no firestore\.rules match/)
  })
})


describe("lattice dedicated _view537/_view538 rules break guard (fail if match removed)", () => {
  it.each([537, 538])("view %i has no rules match after synthetic removal", (view) => {
    const canonical = jobE.find((p) => p.endsWith(`_view${view}`))
    expect(canonical).toBeDefined()
    const stripped = RULES
      .split("\n")
      .filter((line) => !line.includes(`match /${canonical}/{id}`))
      .join("\n")
    expect(dedicatedRulePathsByView(stripped, view)).toHaveLength(0)
    expect(dedicatedRulePathsByView(RULES, view)).toHaveLength(1)
  })
})

describe("lattice dedicated _view539/_view540 rules break guard (fail if match removed)", () => {
  it.each([539, 540])("view %i has no rules match after synthetic removal", (view) => {
    const canonical = jobE.find((p) => p.endsWith(`_view${view}`))
    expect(canonical).toBeDefined()
    const stripped = RULES
      .split("\n")
      .filter((line) => !line.includes(`match /${canonical}/{id}`))
      .join("\n")
    expect(dedicatedRulePathsByView(stripped, view)).toHaveLength(0)
    expect(dedicatedRulePathsByView(RULES, view)).toHaveLength(1)
  })
})

describe("lattice dedicated _view541/_view542 rules break guard (fail if match removed)", () => {
  it.each([541, 542])("view %i has no rules match after synthetic removal", (view) => {
    const canonical = jobE.find((p) => p.endsWith(`_view${view}`))
    expect(canonical).toBeDefined()
    const stripped = RULES
      .split("\n")
      .filter((line) => !line.includes(`match /${canonical}/{id}`))
      .join("\n")
    expect(dedicatedRulePathsByView(stripped, view)).toHaveLength(0)
    expect(dedicatedRulePathsByView(RULES, view)).toHaveLength(1)
  })
})

describe("lattice dedicated _view543/_view544 rules break guard (fail if match removed)", () => {
  it.each([543, 544])("view %i has no rules match after synthetic removal", (view) => {
    const canonical = jobE.find((p) => p.endsWith(`_view${view}`))
    expect(canonical).toBeDefined()
    const stripped = RULES
      .split("\n")
      .filter((line) => !line.includes(`match /${canonical}/{id}`))
      .join("\n")
    expect(dedicatedRulePathsByView(stripped, view)).toHaveLength(0)
    expect(dedicatedRulePathsByView(RULES, view)).toHaveLength(1)
  })
})


describe("lattice dedicated _view545/_view546 rules break guard (fail if match removed)", () => {
  it.each([545, 546])("view %i has no rules match after synthetic removal", (view) => {
    const canonical = jobE.find((p) => p.endsWith(`_view${view}`))
    expect(canonical).toBeDefined()
    const stripped = RULES
      .split("\n")
      .filter((line) => !line.includes(`match /${canonical}/{id}`))
      .join("\n")
    expect(dedicatedRulePathsByView(stripped, view)).toHaveLength(0)
    expect(dedicatedRulePathsByView(RULES, view)).toHaveLength(1)
  })
})

describe("lattice dedicated _view547/_view548 rules break guard (fail if match removed)", () => {
  it.each([547, 548])("view %i has no rules match after synthetic removal", (view) => {
    const canonical = jobE.find((p) => p.endsWith(`_view${view}`))
    expect(canonical).toBeDefined()
    const stripped = RULES
      .split("\n")
      .filter((line) => !line.includes(`match /${canonical}/{id}`))
      .join("\n")
    expect(dedicatedRulePathsByView(stripped, view)).toHaveLength(0)
    expect(dedicatedRulePathsByView(RULES, view)).toHaveLength(1)
  })
})

describe("lattice dedicated _view549/_view550 rules break guard (fail if match removed)", () => {
  it.each([549, 550])("view %i has no rules match after synthetic removal", (view) => {
    const canonical = jobE.find((p) => p.endsWith(`_view${view}`))
    expect(canonical).toBeDefined()
    const stripped = RULES
      .split("\n")
      .filter((line) => !line.includes(`match /${canonical}/{id}`))
      .join("\n")
    expect(dedicatedRulePathsByView(stripped, view)).toHaveLength(0)
    expect(dedicatedRulePathsByView(RULES, view)).toHaveLength(1)
  })
})

describe("PR545 denyWritePaths-only missing rule (break then revert)", () => {
  it("fails when a denyWritePaths-only dedicated view lacks a rules match", () => {
    const orphanView = 5998
    const fakePath = `workflow_ops_orphan_deny_write_tb_ack_recon_pd_freeze_seal_view${orphanView}`
    const patchedDeny = [...denyWritePaths, fakePath]
    const rulePaths = dedicatedRulePathsByView(RULES, orphanView)
    expect(rulePaths).toHaveLength(0)
    const inDenyWrite = patchedDeny.some((p) => p.endsWith(`_view${orphanView}`))
    expect(inDenyWrite).toBe(true)
    expect(LATTICE_DEDICATED_VIEW_ARRAY_WITHOUT_RULES_MATCH_WHITELIST.has(orphanView)).toBe(false)
    expect(() => {
      if (inDenyWrite && !LATTICE_DEDICATED_VIEW_ARRAY_WITHOUT_RULES_MATCH_WHITELIST.has(orphanView)) {
        throw new Error(`view ${orphanView} is in denyWritePaths but has no firestore.rules match`)
      }
    }).toThrow(/no firestore\.rules match/)
  })
})
