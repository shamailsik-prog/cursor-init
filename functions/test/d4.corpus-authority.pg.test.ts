import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pg from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { normaliseCitation } from "@/services/d4-2/citations"
import { AuthorityUnavailableError } from "../src/d4/authority"
import { PgAuthorityStore, annexJurisdiction, coveringVersion, versionUsable, type SectionVersionRow } from "../src/d4/corpusAuthorityStore"
import { readCorpusReaderConfig, type CorpusReaderConfig } from "../src/d4/corpusReaderConfig"
import { CORPUS_FIXTURES, type CorpusDb, type PublishSummary, createCorpusDb } from "./corpusPg"

/**
 * The F05 corpus adapter (plan Tasks 6 and 7) against real Postgres: one database for this file, Annex A 001 -> 003
 * -> 004, seeded through the publication CLI as a corpus_writer member, read as a corpus_reader login. Runs only in
 * `npm run test:f05-authority` (F05_AUTHORITY_SUITE=1, D14). Fixtures follow P4-13 (2099, "Test Act 2099").
 */

type GoldenCase = { id: string; raw: string; parts: Record<string, string | null> | null; python: string; canonical: string | null }
const GOLDEN: GoldenCase[] = JSON.parse(fs.readFileSync(path.join(CORPUS_FIXTURES, "citation-canonical-golden.json"), "utf8")).cases
const MATCHED = GOLDEN.filter((c) => c.python === "match" && c.parts && c.canonical)

const PROVENANCE = {
  source_name: "f05-adapter-fixture",
  source_url: "https://f05.example.invalid/adapter",
  raw_storage_key: null,
  fetched_at: "2099-01-02T03:04:05Z",
  content_hash: "ad".repeat(32),
  extraction_method: "manual",
  extractor_version: "f05-adapter-1",
}
const trusted = { level: "trusted", confidence: 0.95 }
const S5_V1 = "Section 5 as enacted: thirty days."
const S5_V2 = "Section 5 as amended: sixty days."

let db: CorpusDb
const stores: PgAuthorityStore[] = []
/** Judgment id by canonical citation (the golden judgments) and by item key (the treatment fixtures). */
const byCanonical = new Map<string, string>()
const byItem = new Map<string, string>()
let S5 = ""
let S6 = ""

function writeBatch(doc: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f05-adapter-"))
  const file = path.join(dir, "batch.json")
  fs.writeFileSync(file, JSON.stringify(doc))
  return file
}

const judgmentIds = (summary: PublishSummary) =>
  new Map(summary.items.filter((o) => o.entity_type === "judgment" && o.entity_id).map((o) => [o.item_key, o.entity_id as string]))

function readerConfig(overrides: Record<string, string | undefined> = {}): CorpusReaderConfig {
  const r = readCorpusReaderConfig({ SIKANDER_CORPUS_READER_URL: db.readerUrl, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24", ...overrides }, false)
  if (!r.ok) throw new Error(`reader config: ${r.reason}`)
  return r.config
}

function store(config: CorpusReaderConfig = readerConfig()): PgAuthorityStore {
  const s = new PgAuthorityStore(config)
  stores.push(s)
  return s
}

beforeAll(async () => {
  db = await createCorpusDb("adapter")
  // One division-bench judgment per distinct canonical key the Python builder produces from the golden parts.
  const seen = new Set<string>()
  const golden = MATCHED.filter((c) => !seen.has(c.canonical as string) && seen.add(c.canonical as string))
  const judgment = (key: string, citations: unknown[], bench: string) => ({
    kind: "judgment", item_key: key, trust: trusted, provenance: PROVENANCE, citations,
    case_title: `F05 adapter ${key} v. The State 2099`, bench_type: bench, full_text: `Synthetic F05 adapter fixture ${key}.`,
  })
  const treatment = (key: string, treating: string, treated: string, kind: string, confidence: number) => ({
    kind: "treatment", item_key: key, trust: trusted, provenance: PROVENANCE, treating: { item_key: treating }, treated: { item_key: treated },
    treatment: kind, passage_anchor: null, treating_bench_type: "larger", confidence,
  })
  const history = (key: string, section: string, kind: string, versions: unknown[]) => ({
    kind: "statute_section_history", item_key: key, trust: trusted, provenance: PROVENANCE,
    statute: { name: "Test Act 2099", short_name: "TA 2099", year_enacted: 2099, jurisdiction: "Federal", status: null },
    section: { section_number: section, chapter: "I", current_title: `Test section ${section}` }, history: kind, versions,
  })
  const version = (no: number, from: string, to: string | null, text: string, confidence: number) => ({
    version_no: no, effective_from: from, effective_to: to, title: null, text, version_confidence: confidence,
  })
  const summary = await db.publish(
    writeBatch({
      format: "corpus-publication-batch/1",
      batch_key: "curated/f05-adapter-2099",
      source_kind: "curated",
      items: [
        ...golden.map((c, i) => judgment(`g-${i}`, [{ parts: c.parts }], "division")),
        judgment("t-larger", [{ text: "2099 SCMR 9901" }], "Larger Bench"),
        judgment("t-full", [{ text: "2099 SCMR 9902" }], "FB"),
        judgment("t-overruled", [{ text: "2099 SCMR 9903" }], "DB"),
        judgment("t-followed", [{ text: "2099 SCMR 9904" }], "DB"),
        judgment("t-pending", [{ text: "2099 SCMR 9905" }], "DB"),
        treatment("tr-overruled", "t-larger", "t-overruled", "Overruled", 0.9),
        treatment("tr-followed", "t-full", "t-followed", "followed", 0.9),
        treatment("tr-pending", "t-larger", "t-pending", "overruled", 0.6),
        history("h-5", "5", "amendment_history", [version(1, "2099-01-01", "2099-07-01", S5_V1, 0.9), version(2, "2099-07-01", null, S5_V2, 0.9)]),
        history("h-6", "6", "current_text_only", [version(1, "2099-01-01", null, "Section 6 current text.", 0.5)]),
      ],
    })
  )
  const ids = judgmentIds(summary)
  golden.forEach((c, i) => byCanonical.set(c.canonical as string, ids.get(`g-${i}`) ?? ""))
  for (const [k, v] of ids) byItem.set(k, v)
  const section = async (n: string) =>
    (await db.admin.query("SELECT ss.id::text AS id FROM statute_section ss JOIN statute s ON s.id = ss.statute_id WHERE s.name = 'Test Act 2099' AND ss.section_number = $1", [n])).rows[0].id as string
  S5 = await section("5")
  S6 = await section("6")
}, 240_000)

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.end()))
})

afterAll(async () => {
  await db?.drop()
}, 120_000)

describe("F05 adapter helpers (pure)", () => {
  it("annexJurisdiction maps upper-case codes by equality only (D3, ruling 6)", () => {
    expect(["FEDERAL", "SINDH", "PUNJAB", "KP", "BALOCHISTAN", "ICT", "GB", "AJK"].map(annexJurisdiction)).toEqual([
      "Federal", "Sindh", "Punjab", "KP", "Balochistan", "ICT", "GB", "AJK",
    ])
    for (const code of ["PK", "SD", "KPK", "ISLAMABAD", "Federal", "federal", "Sindh", " FEDERAL", "FEDERAL ", ""]) {
      expect(annexJurisdiction(code), code).toBeNull()
    }
  })

  it("versionUsable is strictly above 0.5 and NaN-safe (D4, ruling 4)", () => {
    expect([0.5, 0.5000001, 1, 1.0000001, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null].map(versionUsable)).toEqual([
      false, true, true, false, false, false, false, false, false, false,
    ])
  })

  it("coveringVersion picks the one version with from <= date < to; each inconsistency throws inconsistent (D5)", () => {
    const v = (versionNo: number, effectiveFrom: string, effectiveTo: string | null, text = `v${versionNo}`): SectionVersionRow => ({
      versionNo, effectiveFrom, effectiveTo, text, versionConfidence: 0.9,
    })
    const rows = [v(1, "2099-01-01", "2099-07-01"), v(2, "2099-07-01", null)]
    expect(coveringVersion(rows, "2098-12-31")).toBeNull()
    expect(coveringVersion(rows, "2099-01-01")?.versionNo).toBe(1)
    expect(coveringVersion(rows, "2099-06-30")?.versionNo).toBe(1)
    expect(coveringVersion(rows, "2099-07-01")?.versionNo).toBe(2)
    expect(coveringVersion(rows, "2150-01-01")?.versionNo).toBe(2)
    expect(coveringVersion([v(1, "2099-01-01", "2099-03-01")], "2099-03-01")).toBeNull()
    expect(coveringVersion([], "2099-03-01")).toBeNull()
    for (const [name, bad] of [
      ["reversed range", [v(1, "2099-07-01", "2099-01-01")]],
      ["empty range", [v(1, "2099-07-01", "2099-07-01")]],
      ["overlap", [v(1, "2099-01-01", "2099-08-01"), v(2, "2099-07-01", null)]],
      ["open range not last", [v(1, "2099-01-01", null), v(2, "2099-07-01", null)]],
      ["version numbers out of order", [v(2, "2099-01-01", "2099-07-01"), v(1, "2099-07-01", null)]],
      ["not a date", [v(1, "2099-1-1", null)]],
    ] as const) {
      expect(() => coveringVersion(bad, "2099-07-15"), name).toThrow(AuthorityUnavailableError)
      try {
        coveringVersion(bad, "2099-07-15")
      } catch (e) {
        expect((e as AuthorityUnavailableError).reason, name).toBe("inconsistent")
      }
    }
  })
})

describe("PgAuthorityStore lookups (F05 plan Task 6)", () => {
  it("findJudgment matches the canonical key exactly, for every golden case the Python builder keys", async () => {
    const s = store()
    expect(MATCHED.length).toBeGreaterThan(40)
    for (const c of MATCHED) {
      const canonical = c.canonical as string
      expect(normaliseCitation(canonical), c.id).toBe(canonical)
      expect(await s.findJudgment(canonical), c.id).toEqual({ judgmentId: byCanonical.get(canonical), benchType: "division" })
      // The store matches the canonical key only: the draft's own spelling is the gate's job (Review Focus 4).
      if (c.raw !== canonical) expect(await s.findJudgment(c.raw), `${c.id} raw`).toBeNull()
      // A near miss is a miss.
      const nearMiss = canonical.replace(/(\d+)(\D*)$/, (_, page: string, rest: string) => `${Number(page) + 1}${rest}`)
      expect(nearMiss).not.toBe(canonical)
      if (!byCanonical.has(nearMiss)) expect(await s.findJudgment(nearMiss), `${c.id} near miss`).toBeNull()
    }
  })

  it("listTreatments returns lowercase kinds and the treating judgment's own bench", async () => {
    const s = store()
    expect(await s.listTreatments(byItem.get("t-overruled") as string)).toEqual([
      { kind: "overruled", treatingJudgmentBench: "larger", recordedTreatingBench: "larger" },
    ])
    expect(await s.listTreatments(byItem.get("t-followed") as string)).toEqual([
      { kind: "followed", treatingJudgmentBench: "full", recordedTreatingBench: "larger" },
    ])
    expect(await s.listTreatments(byItem.get("t-larger") as string)).toEqual([])
  })

  it("listTreatments throws pending_review for a quarantined overruling (ruling 3)", async () => {
    await expect(store().listTreatments(byItem.get("t-pending") as string)).rejects.toMatchObject({ name: "AuthorityUnavailableError", reason: "pending_review" })
  })

  it("listTreatments throws inconsistent for a judgment id that is not a UUID, and never returns [] on failure (D5)", async () => {
    const s = store()
    for (const id of ["j_101", "", "not-a-uuid", `${randomUUID()}x`]) {
      await expect(s.listTreatments(id), id).rejects.toMatchObject({ name: "AuthorityUnavailableError", reason: "inconsistent" })
    }
    await db.admin.query("ALTER VIEW public.v_authority_treatment RENAME TO v_authority_treatment_gone")
    try {
      await expect(store().listTreatments(byItem.get("t-overruled") as string)).rejects.toBeInstanceOf(AuthorityUnavailableError)
    } finally {
      await db.admin.query("ALTER VIEW public.v_authority_treatment_gone RENAME TO v_authority_treatment")
    }
  })

  it("getSectionAsAt: amendment boundaries, unmapped and PK codes, non-UUID ids and the 0.5 version give the expected text or no_history", async () => {
    const s = store()
    const at = (date: string, code = "FEDERAL", id = S5) => s.getSectionAsAt(id, date, code)
    expect(await at("2098-12-31")).toBe("no_history")
    expect(await at("2099-01-01")).toEqual({ text: S5_V1 })
    expect(await at("2099-06-30")).toEqual({ text: S5_V1 })
    expect(await at("2099-07-01")).toEqual({ text: S5_V2 })
    expect(await at("2150-01-01")).toEqual({ text: S5_V2 })
    for (const code of ["PK", "SINDH", "Federal", "federal", "FED"]) expect(await at("2099-08-01", code), code).toBe("no_history")
    for (const id of ["test_act_s5", S5.toUpperCase().replace(/-/g, ""), ""]) expect(await at("2099-08-01", "FEDERAL", id), id).toBe("no_history")
    for (const date of ["2099-8-1", "01/08/2099", "2099-08-01T00:00:00Z"]) expect(await at(date), date).toBe("no_history")
    expect(await at("2099-08-01", "FEDERAL", S6)).toBe("no_history")
    expect(await at("2099-08-01", "FEDERAL", randomUUID())).toBe("no_history")
  })

  it("dates do not move with the process time zone (Review Focus 2)", async () => {
    const saved = process.env.TZ
    const raw = new pg.Client({ connectionString: db.urlAs() })
    await raw.connect()
    try {
      const shifts: string[] = []
      for (const tz of ["UTC", "Asia/Karachi", "America/Los_Angeles"]) {
        process.env.TZ = tz
        // Control: node-pg's own DATE parser does move with the zone, so the zone change is live.
        shifts.push(((await raw.query("SELECT '2099-07-01'::date AS d")).rows[0].d as Date).toISOString())
        const s = store()
        expect(await s.getSectionAsAt(S5, "2099-07-01", "FEDERAL"), tz).toEqual({ text: S5_V2 })
        expect(await s.getSectionAsAt(S5, "2099-06-30", "FEDERAL"), tz).toEqual({ text: S5_V1 })
      }
      expect(new Set(shifts).size).toBe(3)
    } finally {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
      await raw.end()
    }
  })
})
