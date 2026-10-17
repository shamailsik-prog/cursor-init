import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Audit F17, spec ruling 5: the versioned Urdu/English evaluation set for the committee answer, graded deterministically.
 * Every item's recorded response (synthetic: written for the set, never produced by a model) is masked as the route
 * masks an answer and graded by `groundAnswer` against an InMemoryAuthorityStore seeded from the set's own corpus; the
 * grounding must match the item's expected outcome exactly (status, advisory, claim counts, and every citation's ref,
 * status and source). The evaluation record (docs/evals/committee-brain-eval-record.json) must name this set and this run.
 *
 * The module is loaded dynamically, so this file reports each case as a failure before it exists.
 */

const ROOT = path.resolve(__dirname, "..", "..")
const SET_PATH = path.join(ROOT, "docs", "evals", "committee-brain-eval-set.json")
const RECORD_PATH = path.join(ROOT, "docs", "evals", "committee-brain-eval-record.json")
const raw = readFileSync(SET_PATH, "utf8")
const json = JSON.parse(raw) as { items: Array<{ id: string }> }

type Grade = { id: string; pass: boolean; problems: string[] }
type Mod = {
  EVAL_SET_RELATIVE_PATH: string
  EVAL_CATEGORIES: readonly string[]
  parseEvalSet: (value: unknown) => {
    version: string
    format: string
    responseOrigin: string
    corpus: { judgments: Array<{ id: string; citation: string }> }
    items: Array<{ id: string; language: string; category: string; live: { forbidClaimCitations: string[] } }>
  }
  gradeRecorded: (set: unknown) => Promise<{ passed: number; failed: number; items: Grade[] }>
}
const load = async (): Promise<Mod> => (await import("../src/p1/evalSet")) as unknown as Mod

describe("audit F17: the committee-brain evaluation set (spec ruling 5)", () => {
  it("is the versioned set at its documented path, synthetic, in the contract's purpose", async () => {
    const m = await load()
    expect(m.EVAL_SET_RELATIVE_PATH).toBe("docs/evals/committee-brain-eval-set.json")
    const set = m.parseEvalSet(json)
    expect([set.format, set.version, set.responseOrigin]).toEqual(["committee-brain-eval-set/1", "f17.1", "synthetic"])
  })

  it("has at least 40 items in English and Urdu, unique ids, and every required category", async () => {
    const m = await load()
    const set = m.parseEvalSet(json)
    expect(set.items.length).toBeGreaterThanOrEqual(40)
    expect(new Set(set.items.map((i) => i.id)).size).toBe(set.items.length)
    const count = (language: string) => set.items.filter((i) => i.language === language).length
    expect(count("en")).toBeGreaterThanOrEqual(15)
    expect(count("ur")).toBeGreaterThanOrEqual(15)
    for (const category of [
      "fabricated_case",
      "absent_citation",
      "wrong_reporter_or_year",
      "overruled",
      "pending_overruling",
      "misapplied_statute",
      "unstructured",
      "injection_verification_claim",
      "grounded_control",
      "partially_supported",
      "no_citation",
      "limitation_relevance",
    ]) {
      expect(m.EVAL_CATEGORIES, category).toContain(category)
      expect(set.items.some((i) => i.category === category), category).toBe(true)
      for (const language of ["en", "ur"]) {
        if (category === "limitation_relevance" && language === "ur") continue
        expect(set.items.some((i) => i.category === category && (i.language === language || i.language === "mixed")), `${category} ${language}`).toBe(true)
      }
    }
  })

  it("holds no invisible, bidi, private-use or surrogate character", () => {
    expect([...raw].filter((ch) => /[\p{Cf}\p{Co}\p{Cs}]/u.test(ch)).map((ch) => ch.codePointAt(0)!.toString(16))).toEqual([])
  })

  it("seeds a synthetic corpus only: every citation is of the year 2099", async () => {
    const set = (await load()).parseEvalSet(json)
    for (const j of set.corpus.judgments) expect(j.citation, j.id).toMatch(/\b2099\b/)
  })

  it("refuses a malformed set: an unknown key, a duplicate id, an unknown category", async () => {
    const m = await load()
    const base = JSON.parse(raw) as Record<string, unknown> & { items: Array<Record<string, unknown>> }
    expect(() => m.parseEvalSet({ ...base, extra: true })).toThrow()
    expect(() => m.parseEvalSet({ ...base, items: [...base.items, base.items[0]] })).toThrow(/duplicate/)
    expect(() => m.parseEvalSet({ ...base, items: [{ ...base.items[0], category: "vibes" }, ...base.items.slice(1)] })).toThrow()
  })

  it.each(json.items.map((i) => i.id))("%s: the recorded response grades exactly as expected", async (id) => {
    const m = await load()
    const report = await m.gradeRecorded(m.parseEvalSet(json))
    const grade = report.items.find((g) => g.id === id)
    expect(grade, id).toBeDefined()
    expect(grade!.problems, id).toEqual([])
    expect(grade!.pass).toBe(true)
  })

  it("the evaluation record names this set and this run's result", async () => {
    const m = await load()
    const report = await m.gradeRecorded(m.parseEvalSet(json))
    const record = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as {
      evalSet: { version: string; sha256: string; items: number }
      graded: { deterministic: { passed: number; failed: number } }
      result: string
    }
    expect(record.evalSet).toEqual({ path: "docs/evals/committee-brain-eval-set.json", version: "f17.1", sha256: createHash("sha256").update(raw, "utf8").digest("hex"), items: json.items.length })
    expect(record.graded.deterministic).toEqual({ passed: report.passed, failed: report.failed })
    expect([report.failed, record.result]).toEqual([0, "pass"])
  })
})
