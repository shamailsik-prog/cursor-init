import fs from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Bench, TreatmentFact } from "@/services/d4-2/citationVerdict"
import { InMemoryAuthorityStore, type AuthorityStore } from "../src/d4/authority"
import { PgAuthorityStore } from "../src/d4/corpusAuthorityStore"
import { readCorpusReaderConfig } from "../src/d4/corpusReaderConfig"
import { CORPUS_FIXTURES, type CorpusDb, createCorpusDb } from "./corpusPg"

/**
 * O-59 parity (F05 plan Task 9, D17): the Pg store and the in-memory store, both built from one fixture, answer every
 * query on its grid alike. Every item promotes except one overruling held for review (#51 R1 D-1), which the in-memory
 * store records with addPendingOverruling. The Pg store is seeded through the publication CLI. The in-memory
 * store is built from the same JSON, using the ids, canonical citation texts and section ids the superuser reads back.
 * Runs only in `npm run test:f05-authority` (F05_AUTHORITY_SUITE=1, D14).
 */

type Item = { kind: string; item_key: string; [k: string]: unknown }
const PARITY_BATCH = path.join(CORPUS_FIXTURES, "parity-batch.f05.json")
const FIXTURE: { items: Item[] } = JSON.parse(fs.readFileSync(PARITY_BATCH, "utf8"))
type GoldenCase = { raw: string; canonical: string | null; python: string }
const GOLDEN: GoldenCase[] = JSON.parse(fs.readFileSync(path.join(CORPUS_FIXTURES, "citation-canonical-golden.json"), "utf8")).cases
/** The gate's R11 codes the grid asks with: the two the fixture holds, an unmapped one and two mixed-case spellings. */
const CODES = ["FEDERAL", "PUNJAB", "PK", "federal", "Punjab"]

let db: CorpusDb
let pgStore: PgAuthorityStore
const mem = new InMemoryAuthorityStore()
const citations: string[] = []
const judgmentIds: string[] = []
const sections: Array<{ id: string; dates: string[] }> = []

const sortTreatments = (facts: TreatmentFact[]) => [...facts].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  db = await createCorpusDb("parity")
  const summary = await db.publish(PARITY_BATCH)
  const decisions = summary.items.filter((o) => ["judgment", "treatment", "statute_section"].includes(o.entity_type)).map((o) => [o.item_key, o.decision])
  expect(decisions.filter(([, d]) => d !== "promoted")).toEqual([["pt-6", "quarantined"]])
  const promoted = new Set(decisions.filter(([, d]) => d === "promoted").map(([k]) => k))
  const idOf = new Map(summary.items.filter((o) => o.entity_type === "judgment").map((o) => [o.item_key, o.entity_id as string]))

  // Judgments: their benches and canonical citation texts, as published.
  const rows = (await db.admin.query("SELECT j.id::text AS id, j.bench_type, c.citation_text FROM judgment j JOIN citation c ON c.judgment_id = j.id ORDER BY 3")).rows
  for (const r of rows as Array<{ id: string; bench_type: Bench; citation_text: string }>) {
    mem.addJudgment(r.id, r.citation_text, r.bench_type)
    citations.push(r.citation_text)
    if (!judgmentIds.includes(r.id)) judgmentIds.push(r.id)
  }
  // Treatments: from the JSON, with the Pg ids. One the publication held for review is a pending overruling.
  for (const t of FIXTURE.items.filter((i) => i.kind === "treatment")) {
    const treating = idOf.get((t.treating as { item_key: string }).item_key) as string
    const treated = idOf.get((t.treated as { item_key: string }).item_key) as string
    if (promoted.has(t.item_key)) mem.addTreatment(treating, treated, t.treatment as string, t.treating_bench_type as Bench)
    else if (t.treatment === "overruled") mem.addPendingOverruling(treated)
  }
  // Section versions: from the JSON, under the Pg section ids and the upper-case code of the statute's jurisdiction.
  for (const h of FIXTURE.items.filter((i) => i.kind === "statute_section_history")) {
    const statute = h.statute as { name: string; jurisdiction: string }
    const number = (h.section as { section_number: string }).section_number
    const id = (await db.admin.query(
      "SELECT ss.id::text AS id FROM statute_section ss JOIN statute s ON s.id = ss.statute_id WHERE s.name = $1 AND ss.section_number = $2",
      [statute.name, number]
    )).rows[0].id as string
    const dates = new Set<string>()
    for (const v of h.versions as Array<{ effective_from: string; effective_to: string | null; text: string }>) {
      mem.addSectionVersion(id, statute.jurisdiction.toUpperCase(), v.effective_from, v.effective_to, v.text)
      for (const d of [v.effective_from, v.effective_to]) if (d) [dayBefore(d), d].forEach((x) => dates.add(x))
    }
    sections.push({ id, dates: [...dates].sort() })
  }
  const config = readCorpusReaderConfig({ SIKANDER_CORPUS_READER_URL: db.readerUrl, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" }, false)
  if (!config.ok) throw new Error(config.reason)
  pgStore = new PgAuthorityStore(config.config)
}, 240_000)

afterAll(async () => {
  await pgStore?.end()
  await db?.drop()
}, 120_000)

describe("O-59 parity (F05 plan Task 9, D17)", () => {
  it("O-59 parity: the Pg store and the in-memory store answer every query on the parity fixture alike", async () => {
    const stores: Record<"pg" | "mem", AuthorityStore> = { pg: pgStore, mem }
    const ask = async <T>(q: (s: AuthorityStore) => Promise<T>) => ({ pg: await q(stores.pg), mem: await q(stores.mem) })

    expect(citations.length).toBeGreaterThanOrEqual(6)
    // Every fixture citation, in its canonical form and in each golden raw spelling of it.
    const forms = new Set<string>(citations)
    for (const c of GOLDEN) if (c.canonical && forms.has(c.canonical)) forms.add(c.raw)
    // Golden spellings of the fixture's own keys (PLD 2099 Sindh 12 / Karachi / Kar.) are in the grid as well.
    for (const raw of ["PLD 2099 Karachi 42", "PLD 2099 Kar. 42", "PLD 2099 Lah. 41", "2099 PLC (C.S.) 46", "2099 S.C.M.R. 4301", "pld 2099 sc 44"]) forms.add(raw)
    let found = 0
    for (const form of forms) {
      const answer = await ask((s) => s.findJudgment(form))
      expect(answer.pg, form).toEqual(answer.mem)
      if (answer.pg) found += 1
    }
    expect(found).toBe(citations.length)

    let facts = 0
    for (const id of judgmentIds) {
      const answer = await ask((s) => s.listTreatments(id))
      expect(sortTreatments(answer.pg), id).toEqual(sortTreatments(answer.mem))
      facts += answer.pg.length
    }
    // Five promoted treatments and the one pending overruling.
    expect(facts).toBe(FIXTURE.items.filter((i) => i.kind === "treatment").length)

    let texts = 0
    for (const { id, dates } of sections) {
      for (const date of dates) {
        for (const code of CODES) {
          const answer = await ask((s) => s.getSectionAsAt(id, date, code))
          expect(answer.pg, `${id} ${date} ${code}`).toEqual(answer.mem)
          if (answer.pg !== "no_history") texts += 1
        }
      }
    }
    expect(texts).toBeGreaterThan(5)
  })
})
