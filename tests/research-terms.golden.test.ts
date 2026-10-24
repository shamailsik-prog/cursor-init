/**
 * FA-D5-003 R1 (spec R22): the research-terms golden shared by TypeScript and Python.
 *
 * tests/fixtures/corpus/research-terms-golden.json pins the corpus service's fold
 * (corpus_service/scraper/publication/research_terms.py), which writes the research term index, to the search's own
 * `researchTermsOf` (services/d5-1/researchTerms.ts). Its expected outputs are generated here, never by hand and never by
 * Python:
 *
 *   npm run corpus:research-terms-golden    (UPDATE_RESEARCH_TERMS_GOLDEN=1: rewrite `terms` and `blocks`, then check)
 *
 * Two pins: explicit cases (markup, references, comments, hyphenation, final sigma, digits of several scripts,
 * ligatures, ignorables, out-of-domain text), and an exhaustive sweep: for every code point of the declared `domain`
 * (the Python module's DOMAIN), in five contexts, one SHA-256 per 256-code-point block. In check mode (the unit suite)
 * this fails if the TypeScript fold moved; corpus_service/tests/test_research_terms.py checks Python against the file.
 * Synthetic text only.
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { researchTermsOf } from "@/services/d5-1/researchTerms"

const GOLDEN = path.join(process.cwd(), "tests", "fixtures", "corpus", "research-terms-golden.json")
const UPDATE = process.env.UPDATE_RESEARCH_TERMS_GOLDEN === "1"
const FORMAT = "research-terms-golden/1"

type GoldenCase = { id: string; text: string; python: "match" | "none"; terms: string[] | null }
type GoldenDoc = {
  format: string
  generatedBy: string
  note: string
  domain: Array<[number, number]>
  contexts: string[]
  blocks: Record<string, string>
  cases: GoldenCase[]
}

const read = (): GoldenDoc => JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as GoldenDoc

/** Every domain code point's outputs in the contexts, one digest per block of 256 code points. */
function sweepDigests(domain: ReadonlyArray<readonly [number, number]>, contexts: readonly string[]): Record<string, string> {
  const lines = new Map<string, string[]>()
  for (const [start, end] of domain) {
    for (let cp = start; cp <= end; cp += 1) {
      const ch = String.fromCodePoint(cp)
      const outs = contexts.map((c) => JSON.stringify(researchTermsOf(c.split("{}").join(ch))))
      const block = (cp >> 8).toString(16).padStart(4, "0")
      const list = lines.get(block) ?? []
      list.push(`${cp.toString(16)}\t${outs.join("\t")}\n`)
      lines.set(block, list)
    }
  }
  const out: Record<string, string> = {}
  for (const [block, list] of [...lines.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[block] = createHash("sha256").update(list.join(""), "utf8").digest("hex")
  }
  return out
}

function load(): GoldenDoc {
  const doc = read()
  if (UPDATE) {
    for (const c of doc.cases) c.terms = researchTermsOf(c.text)
    doc.blocks = sweepDigests(doc.domain, doc.contexts)
    fs.writeFileSync(GOLDEN, JSON.stringify(doc, null, 2) + "\n")
    return read()
  }
  return doc
}

describe("research-terms golden (FA-D5-003 R1: the corpus service's fold equals the search's)", () => {
  const doc = load()

  it("has the declared format, a non-trivial domain, five contexts and many cases", () => {
    expect(doc.format).toBe(FORMAT)
    expect(doc.contexts).toHaveLength(5)
    expect(doc.cases.length).toBeGreaterThan(40)
    const size = doc.domain.reduce((n, [a, b]) => n + (b - a + 1), 0)
    expect(size).toBeGreaterThan(7000)
    // Every domain code point is assigned in this runtime's Unicode, and none is a surrogate.
    for (const [a, b] of doc.domain) {
      for (let cp = a; cp <= b; cp += 1) {
        expect(cp >= 0xd800 && cp <= 0xdfff, cp.toString(16)).toBe(false)
        expect(/\p{Assigned}/u.test(String.fromCodePoint(cp)), cp.toString(16)).toBe(true)
      }
    }
  })

  it("every case's terms are researchTermsOf(text)", () => {
    for (const c of doc.cases) expect(c.terms, c.id).toEqual(researchTermsOf(c.text))
  })

  it("every block digest of the sweep is this runtime's", () => {
    expect(doc.blocks).toEqual(sweepDigests(doc.domain, doc.contexts))
  })
})
