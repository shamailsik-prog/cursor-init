/**
 * FA-DATA-003 and FA-D5-003 on real Postgres 16 + pgvector: what `corpus_reader` and the research reader can read, which
 * rows the research views show, and the research reader's own bounds (its role allowlist, row caps and statement timeout).
 *
 * - FA-DATA-003: on main a `corpus_reader` login reads `v_source_provenance` (every provenance row) and the
 *   `corpus_embeddings` base table (every vector, of every judgment and section, under any classification or review state).
 * - FA-D5-003: research reads only published rows, as a login that can read nothing else (spec R2, R3, R9, R11).
 *
 * The corpus is published by the F19 CLI as a corpus_writer member; states a publication cannot produce are forced by the
 * superuser (F05 spec ruling 2). Spec: docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  DIM,
  FA_D5_003_BATCH,
  FA_D5_003_SUITE,
  LIVE_MODEL,
  type ResearchDb,
  createResearchDb,
  insertEmbeddings,
  insertUnpublishedJudgment,
  judgmentIds,
} from "@/tests/helpers/fa-d5-003-corpus"
import { loadTruthCorpus, truthSource } from "@/tests/helpers/fa-d5-003-scale"

const NINE_PROMOTED_VIEWS = [
  "v_citation", "v_court", "v_judge", "v_judgment", "v_instrument", "v_statute", "v_statute_section",
  "v_statute_section_version", "v_treatment",
]
// 006 (FA-D5-003 R1, spec R20) adds the term index's two views.
const RESEARCH_READABLE = [
  "corpus_metadata", "v_authority_citation", "v_authority_pending_adverse", "v_authority_treatment", "v_research_embedding",
  "v_research_judgment", "v_research_pending", "v_research_term",
]
const AUTHORITY_READABLE = [
  "corpus_metadata", "v_authority_citation", "v_authority_pending_adverse", "v_authority_section_version", "v_authority_treatment",
]

type ReaderSource = {
  load(plan: (meta: { embeddingModel: string; embeddingDim: string }) => { vectors: boolean }): Promise<{
    embeddingModel: string
    embeddingDim: string
    documents: ReadonlyArray<{ id: string; title: string; citations: readonly string[]; benchType: string }>
    storedVectors: Iterable<{ model: string; dim: number }>
    vectors: ReadonlyMap<string, readonly number[]> | null
  }>
  end(): Promise<void>
}
type ReaderModule = {
  PgResearchCorpus: new (
    config: unknown,
    opts?: {
      maxPending?: number
      maxCited?: number
      maxSignatures?: number
      maxSemantic?: number
      statementTimeoutMs?: number
      sessionOptions?: string
    }
  ) => ReaderSource
}
type SearchModule = {
  searchResearch(source: unknown, query: unknown): Promise<{ items: Array<Record<string, unknown>>; k: number; mode: string }>
}
const searchModule = async () => (await import("@/services/d5-1/research")) as unknown as SearchModule
type ConfigModule = { readCorpusReaderConfig(env: Record<string, string | undefined>, production?: boolean): { ok: boolean; config?: unknown; reason?: string } }

/** The branch's Postgres adapter (absent on main: the import fails and so does the test). */
async function reader(): Promise<ReaderModule> {
  const spec = "@/platform/corpus/pgResearchCorpus"
  return (await import(/* @vite-ignore */ spec)) as ReaderModule
}

async function configFor(url: string): Promise<unknown> {
  const mod = (await import("@/functions/src/d4/corpusReaderConfig")) as ConfigModule
  const r = mod.readCorpusReaderConfig({ SIKANDER_CORPUS_READER_URL: url, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" }, false)
  if (!r.ok) throw new Error(`config refused: ${r.reason}`)
  return r.config
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return String((e as { reason?: unknown }).reason ?? (e as Error).message)
  }
  return "loaded"
}

let db: ResearchDb
let J: Record<string, string> = {}
const D: Record<string, string> = {}
let hidden: Record<string, string> = {}
let tmp = ""

async function asLogin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function sqlstate(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return String((e as { code?: unknown }).code)
  }
  return "SUCCEEDED"
}

/** A batch of eleven otherwise-visible judgments, one per visibility defect forced below. */
function defectBatch(): string {
  const items = Array.from({ length: 11 }, (_, i) => ({
    kind: "judgment",
    item_key: `j-defect-${String(i + 1).padStart(2, "0")}`,
    trust: { level: "trusted", confidence: 0.95 },
    provenance: {
      source_name: "fa-d5-003-defect-fixture",
      source_url: `https://fa-d5-003.example.invalid/defect/${i + 1}`,
      raw_storage_key: null,
      fetched_at: "2099-03-04T05:06:07Z",
      content_hash: `${(0x40 + i).toString(16)}`.repeat(32),
      extraction_method: "manual",
      extractor_version: "fa-d5-003-fixture-1",
    },
    citations: [{ text: `2099 SCMR ${3700 + i}` }],
    case_title: `Defect zqdefect${i + 1} judgment`,
    bench_type: "DB",
    decision_date: "2099-03-01",
    full_text: "Synthetic FA-D5-003 defect fixture; no real authority.",
  }))
  const file = path.join(tmp, "defects.json")
  writeFileSync(file, JSON.stringify({ format: "corpus-publication-batch/1", batch_key: "curated/fa-d5-003-defects-2099", source_kind: "curated", items }))
  return file
}

/** Each defect hides one published judgment, forced as the superuser. */
const DEFECTS: ReadonlyArray<[string, string]> = [
  ["quarantined", "UPDATE judgment SET review_status = 'quarantined' WHERE id = $1"],
  ["internal classification", "UPDATE judgment SET classification = 'internal' WHERE id = $1"],
  ["no bench", "UPDATE judgment SET bench_type = NULL WHERE id = $1"],
  ["no publication", "UPDATE judgment SET publication_id = NULL WHERE id = $1"],
  ["no source", "UPDATE judgment SET source_id = NULL WHERE id = $1"],
  ["provenance without content hash", "UPDATE source_provenance SET content_hash = NULL WHERE id = (SELECT source_id FROM judgment WHERE id = $1)"],
  ["provenance without fetched_at", "UPDATE source_provenance SET fetched_at = NULL WHERE id = (SELECT source_id FROM judgment WHERE id = $1)"],
  ["provenance without extraction method", "UPDATE source_provenance SET extraction_method = NULL WHERE id = (SELECT source_id FROM judgment WHERE id = $1)"],
  ["provenance with a blank source name", "UPDATE source_provenance SET source_name = ' ' WHERE id = (SELECT source_id FROM judgment WHERE id = $1)"],
  ["provenance without url or storage key", "UPDATE source_provenance SET source_url = NULL, raw_storage_key = NULL WHERE id = (SELECT source_id FROM judgment WHERE id = $1)"],
  ["an unfinished publication", "UNFINISHED"],
]

describe.runIf(FA_D5_003_SUITE)("FA-DATA-003 and the research reader on real Postgres", () => {
  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "fa-d5-003-"))
    db = await createResearchDb("grants")
    J = judgmentIds(await db.publish(FA_D5_003_BATCH))
    const defects = judgmentIds(await db.publish(defectBatch()))
    for (const [i, [label, sql]] of DEFECTS.entries()) {
      const id = defects[`j-defect-${String(i + 1).padStart(2, "0")}`]
      D[label] = id
      if (sql === "UNFINISHED") {
        const other = await insertUnpublishedJudgment(db.admin, "Defect scratch zqscratch", "2099 SCMR 3799", "unfinished")
        await db.admin.query("UPDATE judgment SET publication_id = (SELECT publication_id FROM judgment WHERE id = $2) WHERE id = $1", [id, other])
      } else {
        await db.admin.query(sql, [id])
      }
    }
    await db.admin.query("UPDATE judgment SET classification = 'privileged' WHERE id = $1", [J["j-privileged"]])
    hidden = {
      "j-review": J["j-review"],
      "j-noprov": J["j-noprov"],
      "j-nobench": J["j-nobench"],
      "j-privileged": J["j-privileged"],
      "j-superuser": await insertUnpublishedJudgment(db.admin, "Bail zqsuperuser section 497 hidden", "2099 SCMR 3605", "none"),
      "j-unfinished": await insertUnpublishedJudgment(db.admin, "Bail zqunfinished section 497 hidden", "2099 SCMR 3606", "unfinished"),
    }
    await insertEmbeddings(db.admin, [...Object.values(J), ...Object.values(hidden), ...Object.values(D)].filter(Boolean))
  }, 300_000)

  afterAll(async () => {
    await db?.drop()
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }, 120_000)

  describe("FA-DATA-003: corpus_reader", () => {
    it("a corpus_reader login can read neither unfiltered provenance nor the embeddings table", async () => {
      const login = await db.createLogin("fad5cr")
      await db.admin.query(`GRANT corpus_reader TO "${login.user}"`)
      const states = await asLogin(login.url, async (c) => ({
        provenance: await sqlstate(c.query("SELECT count(*) FROM public.v_source_provenance")),
        embeddings: await sqlstate(c.query("SELECT count(*) FROM public.corpus_embeddings")),
        embeddingIds: await sqlstate(c.query("SELECT entity_id FROM public.corpus_embeddings LIMIT 1")),
      }))
      expect(states).toEqual({ provenance: "42501", embeddings: "42501", embeddingIds: "42501" })
    })

    it("corpus_reader's grant snapshot is the nine promoted-only views and corpus_metadata, and no write", async () => {
      const r = await db.admin.query(
        `SELECT string_agg(c.relname, ',' ORDER BY c.relname) AS names,
                bool_or(has_table_privilege('corpus_reader', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS writes
           FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_any_column_privilege('corpus_reader', c.oid, 'SELECT')`
      )
      expect(r.rows[0]).toEqual({ names: ["corpus_metadata", ...NINE_PROMOTED_VIEWS].sort().join(","), writes: false })
    })

    it("G-0 still holds: corpus_reader reads every promoted-only view and no base table", async () => {
      const login = await db.createLogin("fad5cg")
      await db.admin.query(`GRANT corpus_reader TO "${login.user}"`)
      const result = await asLogin(login.url, async (c) => {
        const out: Record<string, string> = {}
        for (const v of NINE_PROMOTED_VIEWS) out[v] = await sqlstate(c.query(`SELECT count(*) FROM public.${v}`))
        out.judgment = await sqlstate(c.query("SELECT count(*) FROM public.judgment"))
        out.insert = await sqlstate(c.query("INSERT INTO public.corpus_metadata (key, value) VALUES ('fa-d5-003', 'x')"))
        return out
      })
      expect(result).toEqual({ ...Object.fromEntries(NINE_PROMOTED_VIEWS.map((v) => [v, "SUCCEEDED"])), judgment: "42501", insert: "42501" })
    })
  })

  describe("the research reader role", () => {
    it("corpus_research_reader logs in as nothing, holds no attribute or membership, and reads exactly eight relations", async () => {
      const role = await db.admin.query(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit,
                (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
                has_schema_privilege(r.oid, 'public', 'USAGE') AS schema_usage,
                has_schema_privilege(r.oid, 'public', 'CREATE') AS schema_create
           FROM pg_roles r WHERE rolname = 'corpus_research_reader'`
      )
      expect(role.rows).toEqual([{
        rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
        rolbypassrls: false, rolinherit: false, memberships: 0, schema_usage: true, schema_create: false,
      }])
      const readable = await db.admin.query(
        `SELECT string_agg(c.relname, ',' ORDER BY c.relname) AS names,
                bool_or(has_table_privilege('corpus_research_reader', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                        OR has_any_column_privilege('corpus_research_reader', c.oid, 'INSERT,UPDATE,REFERENCES')) AS writes
           FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_any_column_privilege('corpus_research_reader', c.oid, 'SELECT')`
      )
      expect(readable.rows[0]).toEqual({ names: RESEARCH_READABLE.join(","), writes: false })
    })

    it("the four research views are security_barrier, carry no provenance or text, and only corpus_research_reader reads them", async () => {
      const views = await db.admin.query(
        `SELECT c.relname, c.reloptions FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' AND c.relname LIKE 'v\\_research\\_%' ORDER BY 1`
      )
      expect(views.rows).toEqual([
        { relname: "v_research_embedding", reloptions: ["security_barrier=true"] },
        { relname: "v_research_judgment", reloptions: ["security_barrier=true"] },
        { relname: "v_research_pending", reloptions: ["security_barrier=true"] },
        { relname: "v_research_term", reloptions: ["security_barrier=true"] },
      ])
      const columns = await db.admin.query(
        `SELECT table_name, string_agg(column_name || ':' || udt_name, ',' ORDER BY ordinal_position) AS cols
           FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'v\\_research\\_%' GROUP BY 1 ORDER BY 1`
      )
      expect(Object.fromEntries(columns.rows.map((r) => [r.table_name, r.cols]))).toEqual({
        v_research_embedding: "judgment_id:uuid,model:text,embedding:vector",
        v_research_judgment: "judgment_id:uuid,case_title:text,bench_type:text",
        v_research_pending: "judgment_id:uuid",
        v_research_term: "judgment_id:uuid,term:text",
      })
      for (const view of ["v_research_judgment", "v_research_embedding", "v_research_term", "v_research_pending"]) {
        const p = await db.admin.query(
          `SELECT has_table_privilege('corpus_research_reader', $1, 'SELECT') AS research,
                  has_any_column_privilege('corpus_reader', $1, 'SELECT') AS corpus_reader,
                  has_any_column_privilege('corpus_authority_reader', $1, 'SELECT') AS gate_reader,
                  has_table_privilege('corpus_writer', $1, 'SELECT') AS writer,
                  has_table_privilege('corpus_declassify', $1, 'SELECT') AS declassify,
                  has_table_privilege('public', $1, 'SELECT') AS everyone`,
          [`public.${view}`]
        )
        expect({ view, ...p.rows[0] }).toEqual({
          view, research: true, corpus_reader: false, gate_reader: false, writer: false, declassify: false, everyone: false,
        })
      }
    })

    it("the F05 gate reader is unchanged: it reads its four views and corpus_metadata, nothing of research", async () => {
      const readable = await db.admin.query(
        `SELECT string_agg(c.relname, ',' ORDER BY c.relname) AS names FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_any_column_privilege('corpus_authority_reader', c.oid, 'SELECT')`
      )
      expect(readable.rows[0].names).toBe(AUTHORITY_READABLE.join(","))
    })

    it("the inventory lists the research views and 006's term index (41 relations, 13 routines), so provisioning keeps them with the superuser", async () => {
      const inv = await db.admin.query("SELECT count(*)::int AS n, bool_and(r::text <> '') AS ok, array_agg(r::text ORDER BY r::text) AS names FROM corpus_contract_relations() r")
      expect(inv.rows[0].n).toBe(41)
      expect(inv.rows[0].names).toEqual(
        expect.arrayContaining([
          "v_research_judgment", "v_research_embedding", "v_research_term", "v_research_pending", "research_title_term",
          "research_citation_term", "research_title_pending", "research_citation_pending",
        ])
      )
      const routines = await db.admin.query("SELECT count(*)::int AS n, array_agg(routine::text) AS names FROM corpus_contract_routines()")
      expect(routines.rows[0].n).toBe(13)
      expect(routines.rows[0].names).toContain("research_terms_mark_pending()")
    })

    it("the term index is the writer's to maintain and the research role's to read through its views only (spec R20)", async () => {
      const p = await db.admin.query(
        `SELECT c.relname,
                has_table_privilege('corpus_writer', c.oid, 'SELECT') AS w_select,
                has_table_privilege('corpus_writer', c.oid, 'INSERT') AS w_insert,
                has_table_privilege('corpus_writer', c.oid, 'DELETE') AS w_delete,
                has_table_privilege('corpus_writer', c.oid, 'UPDATE') AS w_update,
                has_any_column_privilege('corpus_research_reader', c.oid, 'SELECT') AS research,
                has_any_column_privilege('corpus_reader', c.oid, 'SELECT') AS corpus_reader,
                has_any_column_privilege('corpus_authority_reader', c.oid, 'SELECT') AS gate_reader,
                has_any_column_privilege('public', c.oid, 'SELECT') AS everyone
           FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'research\\_%' ORDER BY 1`
      )
      const deny = { research: false, corpus_reader: false, gate_reader: false, everyone: false, w_update: false }
      expect(p.rows).toEqual([
        { relname: "research_citation_pending", w_select: true, w_insert: false, w_delete: true, ...deny },
        { relname: "research_citation_term", w_select: true, w_insert: true, w_delete: true, ...deny },
        { relname: "research_title_pending", w_select: true, w_insert: false, w_delete: true, ...deny },
        { relname: "research_title_term", w_select: true, w_insert: true, w_delete: true, ...deny },
      ])
    })
  })

  describe("the research views show published rows only", () => {
    it("v_research_judgment lists exactly the published, public, benched, provenance-complete judgments", async () => {
      const shown = await asLogin(db.researchUrl, async (c) =>
        (await c.query("SELECT judgment_id::text AS id, case_title, bench_type FROM v_research_judgment")).rows
      )
      const ids = shown.map((r) => r.id)
      const visible = Object.entries(J).filter(([k]) => !Object.keys(hidden).includes(k)).map(([, id]) => id)
      expect(ids.sort()).toEqual([...visible].sort())
      for (const id of [...Object.values(hidden), ...Object.values(D)]) expect(ids).not.toContain(id)
      expect(shown.find((r) => r.id === J["j-larger"])).toMatchObject({ case_title: "Larger bench reference on custody of minors", bench_type: "larger" })
    })

    it("every visibility defect hides the judgment from research exactly as from the gate's citation view (parity)", async () => {
      const result = await asLogin(db.researchUrl, async (c) => {
        const out: Record<string, { research: number; gate: number }> = {}
        for (const [label, id] of Object.entries(D)) {
          out[label] = {
            research: (await c.query("SELECT count(*)::int AS n FROM v_research_judgment WHERE judgment_id = $1", [id])).rows[0].n,
            gate: (await c.query("SELECT count(*)::int AS n FROM v_authority_citation WHERE judgment_id = $1", [id])).rows[0].n,
          }
        }
        return out
      })
      expect(result).toEqual(Object.fromEntries(DEFECTS.map(([label]) => [label, { research: 0, gate: 0 }])))
      // Parity the other way: every judgment the gate can cite is a research judgment.
      const missing = await asLogin(db.researchUrl, async (c) =>
        (await c.query("SELECT count(*)::int AS n FROM v_authority_citation a WHERE NOT EXISTS (SELECT 1 FROM v_research_judgment r WHERE r.judgment_id = a.judgment_id)")).rows[0].n
      )
      expect(missing).toBe(0)
    })

    it("v_research_embedding shows a visible judgment's vector under rank 0 only: not a hidden judgment's, a restricted rank's or a section's", async () => {
      await db.admin.query(
        `INSERT INTO corpus_embeddings (entity_type, entity_id, model, classification_rank, embedding)
         SELECT 'judgment', $1::uuid, 'fa-d5-003-ranked', 1, embedding FROM corpus_embeddings WHERE entity_id = $1::uuid AND model = $3::text
         UNION ALL
         SELECT 'statute_section_version', $2::uuid, $3::text, 0, embedding FROM corpus_embeddings WHERE entity_id = $2::uuid AND model = $3::text`,
        [J["j-bail-04"], J["j-bail-05"], LIVE_MODEL]
      )
      try {
        const rows = await asLogin(db.researchUrl, async (c) =>
          (await c.query("SELECT judgment_id::text AS id, model, vector_dims(embedding) AS dims FROM v_research_embedding")).rows
        )
        const visible = Object.entries(J).filter(([k]) => !Object.keys(hidden).includes(k)).map(([, id]) => id)
        expect(rows.map((r) => r.id).sort()).toEqual([...visible].sort())
        expect(new Set(rows.map((r) => `${r.model}:${r.dims}`))).toEqual(new Set([`${LIVE_MODEL}:${DIM}`]))
      } finally {
        await db.admin.query("DELETE FROM corpus_embeddings WHERE model = 'fa-d5-003-ranked' OR entity_type = 'statute_section_version'")
      }
    })

    it("v_research_term holds exactly the visible judgments' terms, and v_research_pending the visible ones the index has not caught up with (spec R20)", async () => {
      const visible = Object.entries(J).filter(([k]) => !Object.keys(hidden).includes(k)).map(([, id]) => id)
      const read = () =>
        asLogin(db.researchUrl, async (c) => ({
          ids: (await c.query("SELECT DISTINCT judgment_id::text AS id FROM v_research_term")).rows.map((r) => r.id as string).sort(),
          hiddenTerms: (
            await c.query(
              `SELECT term FROM v_research_term
                WHERE term LIKE 'zq%' OR term IN ('3601', '3602', '3603', '3604', '3605', '3606', '3700', '3705', '3710')
                ORDER BY 1`
            )
          ).rows.map((r) => r.term as string),
          pending: (await c.query("SELECT judgment_id::text AS id FROM v_research_pending")).rows.map((r) => r.id as string),
        }))
      // The fixture was published by the F19 CLI, which indexed what it wrote; the superuser's hidden rows are pending but
      // not visible, and a defect hides a judgment's terms with it.
      expect(await read()).toEqual({ ids: [...visible].sort(), hiddenTerms: [], pending: [] })
      const planted = (
        await db.admin.query(
          `INSERT INTO judgment (case_title, bench_type, classification, source_id, review_status, publication_id)
           SELECT 'Zqplanted bail after arrest', 'division', 'public', source_id, 'promoted', publication_id FROM judgment WHERE id = $1
           RETURNING id::text AS id`,
          [J["j-bail-01"]]
        )
      ).rows[0].id as string
      try {
        // Written by the superuser, outside a publication: visible, and pending because nobody indexed it.
        const before = await read()
        expect(before.pending).toEqual([planted])
        expect(before.hiddenTerms).toEqual([])
        expect(await db.indexTerms()).toMatchObject({ pending_titles: 0, pending_citations: 0 })
        const after = await read()
        expect(after.pending).toEqual([])
        expect(after.ids).toContain(planted)
        expect(after.hiddenTerms).toEqual(["zqplanted"])
      } finally {
        await db.admin.query("DELETE FROM judgment WHERE id = $1", [planted])
      }
    })

    it("the research login can read nothing else: base tables, 001's views and the gate's section view are refused", async () => {
      const states = await asLogin(db.researchUrl, async (c) => ({
        judgment: await sqlstate(c.query("SELECT count(*) FROM judgment")),
        embeddings: await sqlstate(c.query("SELECT count(*) FROM corpus_embeddings")),
        provenance: await sqlstate(c.query("SELECT count(*) FROM v_source_provenance")),
        v_judgment: await sqlstate(c.query("SELECT count(*) FROM v_judgment")),
        sections: await sqlstate(c.query("SELECT count(*) FROM v_authority_section_version")),
        write: await sqlstate(c.query("INSERT INTO corpus_metadata (key, value) VALUES ('fa-d5-003', 'x')")),
        titleTerms: await sqlstate(c.query("SELECT count(*) FROM research_title_term")),
        citationTerms: await sqlstate(c.query("SELECT count(*) FROM research_citation_term")),
        pending: await sqlstate(c.query("SELECT count(*) FROM research_title_pending")),
      }))
      expect(states).toEqual({
        judgment: "42501", embeddings: "42501", provenance: "42501", v_judgment: "42501", sections: "42501", write: "42501",
        titleTerms: "42501", citationTerms: "42501", pending: "42501",
      })
    })
  })

  describe("the Postgres research reader (platform/corpus/pgResearchCorpus)", () => {
    const keywordPlan = () => ({ vectors: false })

    it("answers every mode as the whole published corpus ranks it, with each treatment verdict (spec R19-R26)", async () => {
      const { PgResearchCorpus } = await reader()
      const { searchResearch } = await searchModule()
      const store = new PgResearchCorpus(await configFor(db.researchUrl))
      const truth = await loadTruthCorpus(db.admin, true)
      const hot = (i: number) => {
        const v = new Array<number>(DIM).fill(0)
        v[i] = 1
        return { model: LIVE_MODEL, vector: v }
      }
      const queries: Array<Record<string, unknown>> = [
        { text: "bail 497" }, { text: "bail", k: 50 }, { text: "Bail under section 497 CrPC" }, { text: "PLD 2099 SC 3202" },
        { text: "2099 SCMR 3102" }, { text: "custody minors" }, { text: "zqnothing" }, { embedding: hot(0) },
        { embedding: hot(3), k: 3 }, { text: "bail", embedding: hot(1) }, { text: "khula dower", embedding: hot(12), k: 5 },
      ]
      try {
        const got: string[] = []
        const want: string[] = []
        for (const q of queries) {
          got.push(JSON.stringify(await searchResearch(store, q)))
          want.push(JSON.stringify(await searchResearch(truthSource(truth), q)))
        }
        expect(got).toEqual(want)
        const bail = await searchResearch(store, { text: "bail 497", k: 50 })
        const verdict = (key: string) => bail.items.find((h) => h.entityId === J[key])?.treatment
        expect([verdict("j-bail-01"), verdict("j-pending"), verdict("j-bail-02")]).toEqual(["OVERRULED", "UNVERIFIED", "VERIFIED"])
        expect(bail.items.find((h) => h.entityId === J["j-bail-02"])).toMatchObject({ citation: "2099 SCMR 3102" })
        // The lock reads the model set and the column's declared dimension (R29); the keyword-only load reads no vector.
        const corpus = await store.load(keywordPlan)
        expect(corpus).toMatchObject({ embeddingModel: LIVE_MODEL, embeddingDim: String(DIM), vectors: null })
        expect([...corpus.storedVectors]).toEqual([{ model: LIVE_MODEL, dim: DIM }])
      } finally {
        await store.end()
      }
    })

    it("a judgment with no visible citation reads citation null; a followed treatment by a larger bench reads VERIFIED (R1-004)", async () => {
      const { PgResearchCorpus } = await reader()
      const { searchResearch } = await searchModule()
      const a = db.admin
      const nocite = (
        await a.query(
          `INSERT INTO judgment (case_title, bench_type, classification, source_id, review_status, publication_id)
           SELECT 'Zqnocite visible judgment', 'division', 'public', source_id, 'promoted', publication_id FROM judgment WHERE id = $1
           RETURNING id::text AS id`,
          [J["j-bail-01"]]
        )
      ).rows[0].id as string
      await a.query(
        `INSERT INTO citation (judgment_id, citation_text, source_id, review_status, publication_id)
         SELECT $1, '2099 SCMR 3790', source_id, 'rejected', publication_id FROM judgment WHERE id = $2`,
        [nocite, J["j-bail-01"]]
      )
      await a.query(
        `INSERT INTO treatment (treating_judgment_id, treated_judgment_id, treatment, treating_bench_type, source_id, review_status, publication_id)
         SELECT $1, $2, 'followed', 'larger', source_id, 'promoted', publication_id FROM judgment WHERE id = $1`,
        [J["j-larger"], J["j-bail-03"]]
      )
      await db.indexTerms()
      const store = new PgResearchCorpus(await configFor(db.researchUrl))
      try {
        const found = await searchResearch(store, { text: "zqnocite" })
        expect(found.items).toEqual([expect.objectContaining({ entityId: nocite, citation: null, score: 1, treatment: "VERIFIED" })])
        const followed = await searchResearch(store, { text: "statutory delay third proviso" })
        expect(followed.items[0]).toMatchObject({ entityId: J["j-bail-03"], treatment: "VERIFIED" })
      } finally {
        await store.end()
        await a.query("DELETE FROM treatment WHERE treatment = 'followed' AND treated_judgment_id = $1", [J["j-bail-03"]])
        await a.query("DELETE FROM citation WHERE judgment_id = $1", [nocite])
        await a.query("DELETE FROM judgment WHERE id = $1", [nocite])
      }
    })

    it("a last_refresh an hour ahead is stale; a publication contract other than '1' is contract_missing (R1-004)", async () => {
      const { PgResearchCorpus } = await reader()
      const a = db.admin
      const orig = (await a.query("SELECT key, value FROM corpus_metadata WHERE key IN ('last_refresh', 'publication_contract')")).rows as Array<{ key: string; value: string }>
      const restore = async () => {
        for (const r of orig) await a.query("UPDATE corpus_metadata SET value = $2 WHERE key = $1", [r.key, r.value])
      }
      const d30 = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z")
      const cases: Array<[string, string, string, string]> = [
        ["an hour ahead", "last_refresh", d30(Date.now() + 60 * 60_000), "stale"],
        ["a minute ahead", "last_refresh", d30(Date.now() + 60_000), "loaded"],
        ["contract 2", "publication_contract", "2", "contract_missing"],
      ]
      const store = new PgResearchCorpus(await configFor(db.researchUrl))
      const out: Record<string, string> = {}
      try {
        for (const [label, key, value] of cases) {
          await restore()
          await a.query("UPDATE corpus_metadata SET value = $2 WHERE key = $1", [key, value])
          out[label] = await reasonOf(store.load(keywordPlan))
        }
      } finally {
        await restore()
        await store.end()
      }
      expect(out).toEqual(Object.fromEntries(cases.map(([label, , , want]) => [label, want])))
    })

    it("refuses a login that can do more than read the research relations (wrong_role), whatever the shape", async () => {
      const { PgResearchCorpus } = await reader()
      const shapes: Array<[string, (user: string) => string[]]> = [
        ["a member of corpus_reader", (u) => [`GRANT corpus_research_reader, corpus_reader TO "${u}"`]],
        ["a SET-only member of corpus_reader", (u) => [`GRANT corpus_research_reader TO "${u}"`, `GRANT corpus_reader TO "${u}" WITH INHERIT FALSE, SET TRUE`]],
        ["a member of the gate's role too", (u) => [`GRANT corpus_research_reader, corpus_authority_reader TO "${u}"`]],
        ["a member of pg_read_all_data", (u) => [`GRANT corpus_research_reader, pg_read_all_data TO "${u}"`]],
        ["a login with CREATEDB", (u) => [`GRANT corpus_research_reader TO "${u}"`, `ALTER ROLE "${u}" CREATEDB`]],
        ["a direct SELECT on judgment", (u) => [`GRANT corpus_research_reader TO "${u}"`, `GRANT SELECT ON judgment TO "${u}"`]],
        ["a column SELECT on source_provenance", (u) => [`GRANT corpus_research_reader TO "${u}"`, `GRANT SELECT (source_url) ON source_provenance TO "${u}"`]],
        ["a write on corpus_metadata", (u) => [`GRANT corpus_research_reader TO "${u}"`, `GRANT UPDATE ON corpus_metadata TO "${u}"`]],
        ["no research role at all", () => []],
        // FA-D5-003-R1-004: the audit's surviving mutants X08-X10.
        ["a login with BYPASSRLS", (u) => [`GRANT corpus_research_reader TO "${u}"`, `ALTER ROLE "${u}" BYPASSRLS`]],
        ["a SELECT on v_source_provenance", (u) => [`GRANT corpus_research_reader TO "${u}"`, `GRANT SELECT ON v_source_provenance TO "${u}"`]],
        ["a SELECT on the gate's v_authority_section_version", (u) => [`GRANT corpus_research_reader TO "${u}"`, `GRANT SELECT ON v_authority_section_version TO "${u}"`]],
        ["USAGE on a sequence in public", (u) => [`GRANT corpus_research_reader TO "${u}"`, `GRANT USAGE ON SEQUENCE corpus_publication_seq_seq TO "${u}"`]],
        // 006's base table, read directly rather than through v_research_term (absent on main: the grant is skipped there).
        ["a SELECT on the term table itself", (u) => [
          `GRANT corpus_research_reader TO "${u}"`,
          `DO $$ BEGIN IF to_regclass('public.research_title_term') IS NOT NULL THEN EXECUTE 'GRANT SELECT ON public.research_title_term TO "${u}"'; ELSE EXECUTE 'GRANT SELECT ON public.judgment TO "${u}"'; END IF; END $$`,
        ]],
      ]
      const reasons: Record<string, string> = {}
      for (const [label, grants] of shapes) {
        const login = await db.createLogin("fad5s")
        for (const sql of grants(login.user)) await db.admin.query(sql)
        const store = new PgResearchCorpus(await configFor(login.url))
        try {
          reasons[label] = await reasonOf(store.load(keywordPlan))
        } finally {
          await store.end()
        }
      }
      expect(reasons).toEqual(Object.fromEntries(shapes.map(([label]) => [label, "wrong_role"])))
      // Controls: the plain research login loads, and so does one that is also a member of corpus_clients (CONNECT only).
      const plain = new PgResearchCorpus(await configFor(db.researchUrl))
      const clientsLogin = await db.createLogin("fad5c")
      await db.admin.query(`GRANT corpus_research_reader TO "${clientsLogin.user}"`)
      const clientsRole = await db.admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'corpus_clients'")
      if (clientsRole.rowCount === 1) await db.admin.query(`GRANT corpus_clients TO "${clientsLogin.user}"`)
      const withClients = new PgResearchCorpus(await configFor(clientsLogin.url))
      try {
        expect([await reasonOf(plain.load(keywordPlan)), await reasonOf(withClients.load(keywordPlan))]).toEqual(["loaded", "loaded"])
      } finally {
        await plain.end()
        await withClients.end()
      }
      // A session that is not read-only is refused too.
      const store = new PgResearchCorpus(await configFor(db.researchUrl), { sessionOptions: "-c default_transaction_read_only=off" })
      try {
        expect(await reasonOf(store.load(keywordPlan))).toBe("wrong_role")
      } finally {
        await store.end()
      }
    })

    it("R1-003: a SELECT or INSERT in another schema, or the research role held WITH ADMIN OPTION, is wrong_role (spec R31)", async () => {
      const { PgResearchCorpus } = await reader()
      const shapes: Array<[string, (user: string) => string[]]> = [
        ["a SELECT on a table in another schema", (u) => [
          `GRANT corpus_research_reader TO "${u}"`, "CREATE SCHEMA IF NOT EXISTS fad5_side", "CREATE TABLE IF NOT EXISTS fad5_side.secret (x text)",
          `GRANT USAGE ON SCHEMA fad5_side TO "${u}"`, `GRANT SELECT ON fad5_side.secret TO "${u}"`,
        ]],
        ["an INSERT on a table in another schema", (u) => [
          `GRANT corpus_research_reader TO "${u}"`, "CREATE SCHEMA IF NOT EXISTS fad5_side", "CREATE TABLE IF NOT EXISTS fad5_side.secret (x text)",
          `GRANT USAGE ON SCHEMA fad5_side TO "${u}"`, `GRANT INSERT ON fad5_side.secret TO "${u}"`,
        ]],
        ["corpus_research_reader held WITH ADMIN OPTION", (u) => [`GRANT corpus_research_reader TO "${u}" WITH ADMIN OPTION`]],
      ]
      const reasons: Record<string, string> = {}
      try {
        for (const [label, grants] of shapes) {
          const login = await db.createLogin("fad5a")
          for (const sql of grants(login.user)) await db.admin.query(sql)
          const store = new PgResearchCorpus(await configFor(login.url))
          try {
            reasons[label] = await reasonOf(store.load(keywordPlan))
          } finally {
            await store.end()
          }
        }
      } finally {
        await db.admin.query("DROP SCHEMA IF EXISTS fad5_side CASCADE")
      }
      expect(reasons).toEqual(Object.fromEntries(shapes.map(([label]) => [label, "wrong_role"])))
    })

    it("over a per-query bound one search fails (row_cap, unindexed), never a truncated answer, and the next query is unaffected (spec R27)", async () => {
      const { PgResearchCorpus } = await reader()
      const { searchResearch } = await searchModule()
      const hot = (i: number) => {
        const v = new Array<number>(DIM).fill(0)
        v[i] = 1
        return { model: LIVE_MODEL, vector: v }
      }
      // Two visible judgments the index has not caught up with (written by the superuser, outside a publication).
      const planted: string[] = []
      for (const t of ["Zqbound one bail", "Zqbound two bail"]) {
        planted.push(
          (
            await db.admin.query(
              `INSERT INTO judgment (case_title, bench_type, classification, source_id, review_status, publication_id)
               SELECT $2, 'division', 'public', source_id, 'promoted', publication_id FROM judgment WHERE id = $1 RETURNING id::text AS id`,
              [J["j-bail-01"], t]
            )
          ).rows[0].id as string
        )
      }
      const cases: Array<[string, Record<string, number>, Record<string, unknown>, string]> = [
        ["pending over the bound", { maxPending: 1 }, { text: "bail" }, "unindexed"],
        ["pending at the bound", { maxPending: 2 }, { text: "bail" }, "answered"],
        ["R4a candidates over the bound", { maxCited: 0 }, { text: "PLD 2099 SC 3202" }, "row_cap"],
        ["R4a candidates at the bound", { maxCited: 1 }, { text: "PLD 2099 SC 3202" }, "answered"],
        ["signature groups over the bound", { maxSignatures: 1 }, { text: "bail 497 crpc" }, "row_cap"],
        ["signature groups at the bound, another query", { maxSignatures: 1 }, { text: "khula" }, "answered"],
        ["semantic candidates over the bound", { maxSemantic: 2 }, { embedding: hot(0) }, "row_cap"],
        ["semantic candidates within the bound", { maxSemantic: 100 }, { embedding: hot(0) }, "answered"],
      ]
      const out: Record<string, string> = {}
      try {
        for (const [label, opts, query] of cases) {
          const store = new PgResearchCorpus(await configFor(db.researchUrl), opts)
          try {
            out[label] = await searchResearch(store, query).then(
              (r) => (r.items.length > 0 ? "answered" : "empty"),
              (e: { reason?: string; message?: string }) => e.reason ?? `threw ${e.message}`
            )
          } finally {
            await store.end()
          }
        }
      } finally {
        await db.admin.query("DELETE FROM judgment WHERE id = ANY($1::uuid[])", [planted])
      }
      expect(out).toEqual(Object.fromEntries(cases.map(([label, , , want]) => [label, want])))
    })

    it("a statement that runs past the timeout fails as timeout", async () => {
      const { PgResearchCorpus } = await reader()
      const locker = new pg.Client({ connectionString: db.urlAs() })
      await locker.connect()
      await locker.query("BEGIN")
      await locker.query("LOCK TABLE judgment IN ACCESS EXCLUSIVE MODE")
      const store = new PgResearchCorpus(await configFor(db.researchUrl), { statementTimeoutMs: 400 })
      try {
        const started = Date.now()
        expect(await reasonOf(store.load(keywordPlan))).toBe("timeout")
        expect(Date.now() - started).toBeLessThan(5000)
      } finally {
        await locker.query("ROLLBACK")
        await locker.end()
        await store.end()
      }
    })

    it("a database without 005 is schema_missing, and an unreachable one is unreachable", async () => {
      const { PgResearchCorpus } = await reader()
      const bare = await db.createLogin("fad5b")
      // A member of the research role (roles are cluster-wide), on a database where 005 was never applied.
      const role = await db.admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'corpus_research_reader'")
      if (role.rowCount === 1) await db.admin.query(`GRANT corpus_research_reader TO "${bare.user}"`)
      const otherDb = `${db.name}_bare`
      await db.admin.query(`CREATE DATABASE "${otherDb}"`)
      try {
        const url = new URL(bare.url)
        url.pathname = `/${otherDb}`
        const store = new PgResearchCorpus(await configFor(url.toString()))
        try {
          expect(await reasonOf(store.load(keywordPlan))).toBe("schema_missing")
        } finally {
          await store.end()
        }
      } finally {
        await db.admin.query(`DROP DATABASE IF EXISTS "${otherDb}" WITH (FORCE)`)
      }
      const down = new URL(db.researchUrl)
      down.port = "1"
      const store = new PgResearchCorpus(await configFor(down.toString()))
      try {
        expect(await reasonOf(store.load(keywordPlan))).toBe("unreachable")
      } finally {
        await store.end()
      }
    })
  })
})
