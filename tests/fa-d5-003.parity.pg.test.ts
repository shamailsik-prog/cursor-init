/**
 * FA-D5-003-R1-001 (HIGH): the Postgres research reader against `rankResearchCorpus` over the WHOLE visible corpus, in
 * keyword, vector and blend modes, at 25,000+ visible judgments on real Postgres 16 + pgvector (spec §7, R19-R25, R28).
 *
 * The candidate set the reader ranks must hold every judgment of the true top k, with whole-corpus statistics, so every
 * answer (hits, order, scores to 6 decimals, citations, treatments) must equal the ranking of the whole corpus read as the
 * superuser through the same views. The corpus includes rows the index has not caught up with (written by the superuser
 * after `index-terms`, a retitled judgment, a title outside the fold domain), dense vectors, multi-citation judgments,
 * overrulings, pending overrulings and `followed` treatments; and a `declassify()` that changes what research may read
 * without a publication (R28: nothing is cached by `last_refresh`).
 *
 * On main every search is `row_cap`: the reader loads the whole corpus and refuses anything over 20,000 judgments.
 * Synthetic data only (2099).
 */
import fs from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readCorpusReaderConfig } from "@/functions/src/d4/corpusReaderConfig"
import { PgResearchCorpus } from "@/platform/corpus/pgResearchCorpus"
import { searchResearch, type ResearchCorpus } from "@/services/d5-1/research"
import { FA_D5_003_BATCH, FA_D5_003_SUITE, LIVE_MODEL, type ResearchDb, createResearchDb } from "@/tests/helpers/fa-d5-003-corpus"
import {
  SCALE_VOCABULARY,
  denseVector,
  loadTruthCorpus,
  rng,
  seedScaleCorpus,
  truthSource,
  type ScaleCounts,
} from "@/tests/helpers/fa-d5-003-scale"

const SLOW = 900_000
const BULK = 25_000
const VECTORS = 2_000

type Query = { text?: string; embedding?: { model: string; vector: number[] }; k?: number }

function sourceFor(url: string): PgResearchCorpus {
  const c = readCorpusReaderConfig({ SIKANDER_CORPUS_READER_URL: url, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" }, false)
  if (!c.ok) throw new Error(`config ${c.reason}`)
  return new PgResearchCorpus(c.config)
}

const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    (r) => JSON.stringify(r),
    (e: { reason?: string; message?: string }) => `E:${e.reason ?? e.message}`
  )

let db: ResearchDb
let truth: ResearchCorpus
let counts: ScaleCounts
let pgSource: PgResearchCorpus
const storedVectors: number[][] = []
const citationsOf: string[] = []

function keywordQueries(): Query[] {
  const next = rng(424242)
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]
  const out: Query[] = []
  for (let i = 0; i < 120; i += 1) {
    const words = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(SCALE_VOCABULARY))
    if (next() < 0.25) words.push(String(Math.floor(next() * 600)))
    out.push({ text: words.join(" "), k: next() < 0.5 ? undefined : 1 + Math.floor(next() * 50) })
  }
  for (let i = 0; i < 40; i += 1) {
    const c = pick(citationsOf)
    const variant = next() < 0.3 ? c.replace("SCMR", "S.C.M.R.") : c
    out.push({ text: next() < 0.5 ? variant : `${pick(SCALE_VOCABULARY)} ${variant}`, k: 1 + Math.floor(next() * 20) })
  }
  out.push(
    { text: "bail", k: 50 },
    { text: "section", k: 50 },
    { text: "2099" },
    { text: "under section 497 crpc bail arrest", k: 50 },
    { text: "PLD 2099 SC 3202" },
    { text: "2099 SCMR 3102 bail" },
    { text: "ضمانت bail" },
    { text: "muhammad" },
    { text: "zqpending bail" },
    { text: "zqretitled custody" },
    { text: "zqdomain arrest" },
    { text: "zqnothing at all" }
  )
  return out
}

function vectorQueries(withText: boolean): Query[] {
  const next = rng(withText ? 7777 : 5555)
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]
  const out: Query[] = []
  const text = () => (withText ? { text: Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(SCALE_VOCABULARY)).join(" ") } : {})
  for (let i = 0; i < 20; i += 1) out.push({ ...text(), embedding: { model: LIVE_MODEL, vector: denseVector(1000 + i) }, k: next() < 0.5 ? undefined : 1 + Math.floor(next() * 50) })
  for (let i = 0; i < 10; i += 1) out.push({ ...text(), embedding: { model: LIVE_MODEL, vector: pick(storedVectors) } })
  for (let i = 0; i < 10; i += 1) {
    const base = pick(storedVectors)
    out.push({ ...text(), embedding: { model: LIVE_MODEL, vector: base.map((x) => x + (next() - 0.5) * 0.4) }, k: 1 + Math.floor(next() * 50) })
  }
  return out
}

async function compare(queries: Query[], label: string): Promise<{ compared: number; diffs: string[]; ms: number[] }> {
  const diffs: string[] = []
  const ms: number[] = []
  for (const q of queries) {
    const want = await outcome(searchResearch(truthSource(truth), q))
    const started = performance.now()
    const got = await outcome(searchResearch(pgSource, q))
    ms.push(performance.now() - started)
    if (got !== want) diffs.push(`${label} ${q.text ?? "(vector)"} k=${q.k}\n  want ${want.slice(0, 400)}\n  got  ${got.slice(0, 400)}`)
  }
  ms.sort((a, b) => a - b)
  const line = `parity ${label}: queries=${queries.length} diffs=${diffs.length} median_ms=${ms[Math.floor(ms.length / 2)].toFixed(0)} max_ms=${ms[ms.length - 1].toFixed(0)}`
  console.info(line)
  if (process.env.FA_D5_003_EVIDENCE) fs.appendFileSync(process.env.FA_D5_003_EVIDENCE, `${line}\n`)
  return { compared: queries.length, diffs, ms }
}

async function plantJudgment(title: string, opts: { classification?: string; citation?: string } = {}): Promise<string> {
  const a = db.admin
  const pub = (await a.query("SELECT id::text AS id FROM corpus_publication WHERE finished_at IS NOT NULL ORDER BY seq DESC LIMIT 1")).rows[0].id as string
  const src = (
    await a.query(
      `INSERT INTO source_provenance (source_name, source_url, fetched_at, content_hash, extraction_method)
       VALUES ('fa-d5-003-parity', 'https://fa-d5-003.example.invalid/parity', '2099-06-07T08:09:10Z', $1, 'manual') RETURNING id::text AS id`,
      ["7".repeat(64)]
    )
  ).rows[0].id as string
  const id = (
    await a.query(
      `INSERT INTO judgment (case_title, bench_type, classification, source_id, review_status, publication_id)
       VALUES ($1, 'division', $2, $3, 'promoted', $4) RETURNING id::text AS id`,
      [title, opts.classification ?? "public", src, pub]
    )
  ).rows[0].id as string
  await a.query(
    `INSERT INTO citation (judgment_id, citation_text, source_id, review_status, publication_id) VALUES ($1, $2, $3, 'promoted', $4)`,
    [id, opts.citation ?? `2099 YLR ${700_000 + (planted += 1)}`, src, pub]
  )
  return id
}
let planted = 0

describe.runIf(FA_D5_003_SUITE)("FA-D5-003 R1-001: Postgres research equals the whole-corpus ranking at 25,000+ judgments", () => {
  beforeAll(async () => {
    db = await createResearchDb("parity")
    await db.publish(FA_D5_003_BATCH)
    counts = await seedScaleCorpus(db.admin, { judgments: BULK, vectors: VECTORS, seed: 99 })
    // Outside the fold's domain (CJK and an emoji): the indexer must leave it pending; research folds it at query time.
    await plantJudgment("Zqdomain bail 保释 arrest 🙂 appeal")
    await db.indexTerms()
    // Written after the index ran: pending until the next index-terms, so research must fold them itself.
    for (let i = 0; i < 40; i += 1) await plantJudgment(`Zqpending ${SCALE_VOCABULARY[i % 40]} bail appeal ${i}`)
    // An indexed title changed afterwards: its stored terms are stale, so it is pending again.
    await db.admin.query(
      `UPDATE judgment SET case_title = case_title || ' zqretitled custody'
        WHERE id IN (SELECT judgment_id FROM v_research_judgment ORDER BY judgment_id LIMIT 5)`
    )
    for (const r of (await db.admin.query("SELECT embedding::text AS v FROM v_research_embedding ORDER BY judgment_id LIMIT 50")).rows) {
      storedVectors.push(JSON.parse(r.v as string) as number[])
    }
    const next = rng(31337)
    const all = (await db.admin.query("SELECT citation_text FROM v_authority_citation")).rows.map((r) => r.citation_text as string)
    for (let i = 0; i < 200; i += 1) citationsOf.push(all[Math.floor(next() * all.length)])
    truth = await loadTruthCorpus(db.admin, true)
    pgSource = sourceFor(db.researchUrl)
    if (process.env.FA_D5_003_EVIDENCE) fs.appendFileSync(process.env.FA_D5_003_EVIDENCE, `parity corpus: ${JSON.stringify(counts)} truth_documents=${truth.documents.length}\n`)
  }, SLOW)

  afterAll(async () => {
    await pgSource?.end()
    await db?.drop()
  }, SLOW)

  it("the corpus is over every old cap, and includes rows the index has not caught up with", () => {
    expect(truth.documents.length).toBeGreaterThanOrEqual(BULK + 40)
    expect(counts.vectors).toBe(VECTORS)
    expect(truth.documents.filter((d) => /^Zqpending /.test(d.title))).toHaveLength(40)
    expect(truth.documents.filter((d) => / zqretitled custody$/.test(d.title))).toHaveLength(5)
  })

  it("keyword mode: every answer equals the whole-corpus ranking", async () => {
    const r = await compare(keywordQueries(), "keyword")
    expect(r.diffs).toEqual([])
    expect(r.compared).toBeGreaterThan(150)
  }, SLOW)

  it("vector mode: every answer equals the whole-corpus ranking", async () => {
    const r = await compare(vectorQueries(false), "vector")
    expect(r.diffs).toEqual([])
  }, SLOW)

  it("blend mode: every answer equals the whole-corpus ranking", async () => {
    const r = await compare(vectorQueries(true), "blend")
    expect(r.diffs).toEqual([])
  }, SLOW)

  it("a declassify() changes what research reads without a publication: answers follow it at once (nothing cached by last_refresh)", async () => {
    const refresh = async () => (await db.admin.query("SELECT value FROM corpus_metadata WHERE key = 'last_refresh'")).rows[0].value as string
    const before = await refresh()
    // Internal judgments sharing broad terms: invisible now, so N and the df of "bail" and "appeal" exclude them.
    const ids: string[] = []
    for (let i = 0; i < 25; i += 1) ids.push(await plantJudgment(`Zqdeclass bail appeal custody ${i}`, { classification: "internal" }))
    await db.indexTerms()
    truth = await loadTruthCorpus(db.admin, true)
    const queries: Query[] = [{ text: "bail appeal" }, { text: "custody bail", k: 50 }, { text: "zqdeclass" }, { text: "appeal" }]
    expect((await compare(queries, "pre-declassify")).diffs).toEqual([])
    for (const id of ids) await db.admin.query("SELECT declassify($1::uuid, 'public', 'fa-d5-003-parity', 'synthetic declassification for the parity test')", [id])
    expect(await refresh()).toBe(before)
    truth = await loadTruthCorpus(db.admin, true)
    const after = await compare(queries, "post-declassify")
    expect(after.diffs).toEqual([])
    const zq = JSON.parse(await outcome(searchResearch(pgSource, { text: "zqdeclass" }))) as { items: unknown[] }
    expect(zq.items).toHaveLength(10)
  }, SLOW)

  it("a k of 50 over a broad term returns 50, ranked as the whole corpus ranks them", async () => {
    const got = JSON.parse(await outcome(searchResearch(pgSource, { text: "bail", k: 50 }))) as { items: Array<{ entityId: string }> }
    const want = JSON.parse(await outcome(searchResearch(truthSource(truth), { text: "bail", k: 50 }))) as { items: Array<{ entityId: string }> }
    expect(got.items).toHaveLength(50)
    expect(got).toEqual(want)
  }, SLOW)

  it("sizes stay exact: a promoted citation that is not visible, and citation writes after the index ran (spec R20, R24)", async () => {
    const a = db.admin
    const query = { text: "bail", k: 50 }
    const top = (JSON.parse(await outcome(searchResearch(truthSource(truth), query))) as { items: Array<{ entityId: string }> }).items.map((i) => i.entityId)
    expect(top).toHaveLength(50)
    const pub = (await a.query("SELECT id::text AS id FROM corpus_publication WHERE finished_at IS NOT NULL ORDER BY seq DESC LIMIT 1")).rows[0].id as string
    const broken = (
      await a.query(
        `INSERT INTO source_provenance (source_name, source_url, fetched_at, content_hash, extraction_method)
         VALUES ('fa-d5-003-parity', 'https://fa-d5-003.example.invalid/broken', '2099-06-07T08:09:10Z', '', 'manual') RETURNING id::text AS id`
      )
    ).rows[0].id as string
    // The 20 smallest bail judgments get a promoted citation research cannot see: 10 with incomplete provenance, 10
    // with none. The index counts promoted citations, so their stored sizes grow by the new terms; their visible
    // documents do not, so they must keep their places.
    for (let i = 0; i < 20; i += 1) {
      await a.query(
        `INSERT INTO citation (judgment_id, citation_text, source_id, review_status, publication_id) VALUES ($1, $2, $3, 'promoted', $4)`,
        [top[i], `2099 ZQH ${5000 + i}`, i < 10 ? broken : null, pub]
      )
    }
    await db.indexTerms()
    const stored = (await a.query("SELECT count(*)::int AS n FROM research_size s JOIN citation c ON c.judgment_id = s.judgment_id WHERE c.citation_text LIKE '2099 ZQH %'")).rows[0].n
    expect(stored).toBe(20)
    truth = await loadTruthCorpus(db.admin, true)
    const hidden: Query[] = [query, { text: "bail appeal", k: 50 }, { text: "zqh" }, { text: "2099 ZQH 5003" }, { text: "bail 2099", k: 50 }]
    expect((await compare(hidden, "hidden-citation")).diffs).toEqual([])
    // Citation writes after the index ran: a deleted citation, a citation moved to another judgment and a quarantined
    // one each mark their judgments pending, which research then folds itself.
    const visible = (await a.query("SELECT citation_text, judgment_id::text AS j FROM v_authority_citation WHERE judgment_id = ANY($1::uuid[]) ORDER BY 1", [top.slice(20, 26)])).rows as Array<{ citation_text: string; j: string }>
    expect(visible.length).toBeGreaterThanOrEqual(3)
    await a.query("DELETE FROM citation WHERE citation_text = $1", [visible[0].citation_text])
    await a.query("UPDATE citation SET judgment_id = $2 WHERE citation_text = $1", [visible[1].citation_text, top[30]])
    await a.query("UPDATE citation SET review_status = 'quarantined' WHERE citation_text = $1", [visible[2].citation_text])
    const pendingNow = (await a.query("SELECT count(*)::int AS n FROM research_title_pending")).rows[0].n as number
    expect(pendingNow).toBeGreaterThanOrEqual(3)
    truth = await loadTruthCorpus(db.admin, true)
    const written: Query[] = [query, { text: "bail appeal", k: 50 }, { text: visible[1].citation_text }, { text: visible[0].citation_text }]
    expect((await compare(written, "citation-writes")).diffs).toEqual([])
  }, SLOW)

  it("R4a puts the cited authority first even when 60 judgments outscore it on keywords, whether the key's numbers are query terms or not (spec R24b)", async () => {
    // 60 judgments hold three rare words the target lacks, so on keywords alone all 60 outrank it; R4a must still find it,
    // through the signature groups (numbers that are query terms) and through the index (a number glued to the reporter).
    for (let i = 0; i < 60; i += 1) await plantJudgment(`Zqrfour zqrfive zqrsix appeal ${i}`)
    const target = await plantJudgment("Zqrtarget custody", { citation: "2099 YLR 888888" })
    await db.indexTerms()
    truth = await loadTruthCorpus(db.admin, true)
    const queries: Query[] = [
      { text: "zqrfour zqrfive zqrsix 2099 YLR 888888" },
      { text: "zqrfour zqrfive zqrsix 2099 YLR 888888", k: 1 },
      { text: "zqrfour zqrfive zqrsix 2099YLR 888888" },
      { text: "zqrfour zqrfive zqrsix 2099YLR 888888", k: 1 },
    ]
    expect((await compare(queries, "r4a-outside-k")).diffs).toEqual([])
    for (const q of queries) {
      const got = JSON.parse(await outcome(searchResearch(pgSource, q))) as { items: Array<{ entityId: string; score: number; citation: string | null }> }
      expect(got.items[0], q.text).toMatchObject({ entityId: target, score: 1, citation: "2099 YLR 888888" })
    }
  }, SLOW)
})
