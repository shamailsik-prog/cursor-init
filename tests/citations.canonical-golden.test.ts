/**
 * Audit F19: citation canonical golden shared by TypeScript and Python.
 *
 * tests/fixtures/corpus/citation-canonical-golden.json pins the canonical citation keys the
 * corpus publication (corpus_service/scraper/publication/citations.py) must store, to the keys
 * the gate reads with `normaliseCitation` (services/d4-2/citations.ts). The `canonical` field is
 * generated here, never by hand and never by Python:
 *
 *   npm run corpus:citation-golden    (UPDATE_CITATION_GOLDEN=1: rewrite `canonical`, then check)
 *
 * In check mode (the unit suite) this fails if any `canonical` differs from
 * `normaliseCitation(raw)`, so a change to citations.ts that moves a key forces a regeneration,
 * and the corpus-service pytest then re-checks Python against the regenerated file.
 *
 * Every citation is synthetic (year 2099); no real authority is named.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { normaliseCitation } from "@/services/d4-2/citations"

const GOLDEN = path.join(process.cwd(), "tests", "fixtures", "corpus", "citation-canonical-golden.json")
const UPDATE = process.env.UPDATE_CITATION_GOLDEN === "1"
const FORMAT = "citation-canonical-golden/1"

// The court canonicals of services/d4-2/citations.ts (COURTS, :58-73); mirrored by
// corpus_service/scraper/publication/vocabulary.py COURT_CANONICALS.
const COURT_CANONICALS = [
  "SC", "FSC", "Lahore", "Sindh", "Peshawar", "Quetta", "Islamabad", "AJ&K", "GB",
  "Civil", "Criminal", "Tax", "Revenue",
] as const

type Parts = {
  reporter: string
  year: string
  page: string
  court: string | null
  series: string | null
  note: string | null
}

type GoldenCase = {
  id: string
  raw: string
  parts: Parts | null
  python: "match" | "none"
  canonical: string | null
}

type GoldenDoc = {
  format: string
  generatedBy: string
  note: string
  cases: GoldenCase[]
}

function readGolden(): GoldenDoc {
  return JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as GoldenDoc
}

function load(): GoldenDoc {
  const doc = readGolden()
  if (UPDATE) {
    for (const c of doc.cases) c.canonical = normaliseCitation(c.raw)
    fs.writeFileSync(GOLDEN, JSON.stringify(doc, null, 2) + "\n")
    return readGolden()
  }
  return doc
}

const YEARS = /(?:19|20)\d\d/g
const yearsIn = (s: string) => s.match(YEARS) ?? []
const head = (canonical: string) => canonical.replace(/ \d+(?: \([^()]*\))?$/, "").replace(/\(.*$/, "")

describe("citation canonical golden (F19 parity with corpus_service)", () => {
  const doc = load()

  it("has the declared format and only synthetic 2099 citations", () => {
    expect(doc.format).toBe(FORMAT)
    expect(doc.cases.length).toBeGreaterThan(30)
    for (const c of doc.cases) {
      if (c.raw !== "") {
        expect(c.raw, c.id).toContain("2099")
        expect(yearsIn(c.raw).every((y) => y === "2099"), c.id).toBe(true)
      }
      if (c.parts) expect(c.parts.year, c.id).toBe("2099")
      if (c.canonical !== null) expect(yearsIn(c.canonical), c.id).toEqual(["2099"])
    }
  })

  it("has unique ids", () => {
    const ids = doc.cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("canonical is exactly normaliseCitation(raw) for every case", () => {
    const drift = doc.cases
      .filter((c) => normaliseCitation(c.raw) !== c.canonical)
      .map((c) => ({ id: c.id, golden: c.canonical, now: normaliseCitation(c.raw) }))
    expect(drift, "regenerate with `npm run corpus:citation-golden`").toEqual([])
  })

  it("every canonical key is a fixed point of normaliseCitation (the reader relies on this)", () => {
    for (const c of doc.cases) {
      if (c.canonical !== null) expect(normaliseCitation(c.canonical), c.id).toBe(c.canonical)
    }
  })

  it("python must be none wherever TypeScript reads no citation", () => {
    for (const c of doc.cases) {
      expect(["match", "none"], c.id).toContain(c.python)
      if (c.canonical === null) expect(c.python, c.id).toBe("none")
      if (c.parts !== null) expect(c.canonical, c.id).not.toBeNull()
    }
  })

  it("covers every court canonical, the Karachi and Quetta aliases, and both sub-series positions", () => {
    const canonicals = doc.cases.flatMap((c) => (c.canonical === null ? [] : [c.canonical]))
    for (const court of COURT_CANONICALS) {
      expect(
        canonicals.some((k) => head(k).split(" ").includes(court) || k.includes(`(${court})`)),
        court,
      ).toBe(true)
    }
    const byId = new Map(doc.cases.map((c) => [c.id, c]))
    expect(doc.cases.some((c) => /Karachi/.test(c.raw) && c.canonical?.includes("Sindh"))).toBe(true)
    expect(doc.cases.some((c) => /Balochistan|Quetta/.test(c.raw) && c.canonical?.includes("Quetta"))).toBe(true)
    const lead = byId.get("plc-series-lead")
    const trail = byId.get("plc-series-trail")
    const plain = byId.get("plc-plain")
    expect(lead?.raw).toMatch(/\(.+\) \d+$/)
    expect(trail?.raw).toMatch(/\d+ \(.+\)$/)
    expect(lead?.canonical).toBe(trail?.canonical)
    expect(lead?.canonical).not.toBe(plain?.canonical)
  })
})
