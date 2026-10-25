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

const NINE_PROMOTED_VIEWS = [
  "v_citation", "v_court", "v_judge", "v_judgment", "v_instrument", "v_statute", "v_statute_section",
  "v_statute_section_version", "v_treatment",
]
const RESEARCH_READABLE = [
  "corpus_metadata", "v_authority_citation", "v_authority_pending_adverse", "v_authority_treatment", "v_research_embedding",
  "v_research_judgment", "corpus_research_term", "corpus_research_term_df",
]
const AUTHORITY_READABLE = [
  "corpus_metadata", "v_authority_citation", "v_authority_pending_adverse", "v_authority_section_version", "v_authority_treatment",
]

type ReaderModule = {
  PgResearchCorpus: new (
    config: unknown,
    opts?: { maxJudgments?: number; maxTreatments?: number; maxVectors?: number; statementTimeoutMs?: number; sessionOptions?: string }
  ) => {
    load(plan: (meta: { embeddingModel: string; embeddingDim: string }) => { vectors: boolean }): Promise<{
      embeddingModel: string
      embeddingDim: string
      documents: ReadonlyArray<{ id: string; title: string; citations: readonly string[]; benchType: string }>
      storedVectors: ReadonlyArray<{ model: string; dim: number }>
      vectors: ReadonlyMap<string, readonly number[]> | null
      verdicts(ids: readonly string[]): ReadonlyMap<string, string>
    }>
    end(): Promise<void>
  }
}
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

    it("the two research views are security_barrier, carry no provenance or text, and only corpus_research_reader reads them", async () => {
      const views = await db.admin.query(
        `SELECT c.relname, c.reloptions FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' AND c.relname LIKE 'v\\_research\\_%' ORDER BY 1`
      )
      expect(views.rows).toEqual([
        { relname: "v_research_embedding", reloptions: ["security_barrier=true"] },
        { relname: "v_research_judgment", reloptions: ["security_barrier=true"] },
      ])
      const columns = await db.admin.query(
        `SELECT table_name, string_agg(column_name || ':' || udt_name, ',' ORDER BY ordinal_position) AS cols
           FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'v\\_research\\_%' GROUP BY 1 ORDER BY 1`
      )
      expect(Object.fromEntries(columns.rows.map((r) => [r.table_name, r.cols]))).toEqual({
        v_research_embedding: "judgment_id:uuid,model:text,embedding:vector",
        v_research_judgment: "judgment_id:uuid,case_title:text,bench_type:text",
      })
      for (const view of ["v_research_judgment", "v_research_embedding"]) {
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

    it("the inventory lists both research views (35 relations), so provisioning keeps them with the superuser", async () => {
      const inv = await db.admin.query("SELECT count(*)::int AS n, bool_and(r::text <> '') AS ok, array_agg(r::text ORDER BY r::text) AS names FROM corpus_contract_relations() r")
      expect(inv.rows[0].n).toBe(35)
      expect(inv.rows[0].names).toEqual(expect.arrayContaining(["v_research_judgment", "v_research_embedding"]))
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

    it("the research login can read nothing else: base tables, 001's views and the gate's section view are refused", async () => {
      const states = await asLogin(db.researchUrl, async (c) => ({
        judgment: await sqlstate(c.query("SELECT count(*) FROM judgment")),
        embeddings: await sqlstate(c.query("SELECT count(*) FROM corpus_embeddings")),
        provenance: await sqlstate(c.query("SELECT count(*) FROM v_source_provenance")),
        v_judgment: await sqlstate(c.query("SELECT count(*) FROM v_judgment")),
        sections: await sqlstate(c.query("SELECT count(*) FROM v_authority_section_version")),
        write: await sqlstate(c.query("INSERT INTO corpus_metadata (key, value) VALUES ('fa-d5-003', 'x')")),
      }))
      expect(states).toEqual({ judgment: "42501", embeddings: "42501", provenance: "42501", v_judgment: "42501", sections: "42501", write: "42501" })
    })
  })

  describe("the Postgres research reader (platform/corpus/pgResearchCorpus)", () => {
    const keywordPlan = () => ({ vectors: false })

    it("loads the published corpus: documents with their citations, treatment verdicts and the stored vector pairs", async () => {
      const { PgResearchCorpus } = await reader()
      const store = new PgResearchCorpus(await configFor(db.researchUrl))
      try {
        const corpus = await store.load(keywordPlan)
        const visible = Object.entries(J).filter(([k]) => !Object.keys(hidden).includes(k)).map(([, id]) => id)
        expect(corpus.documents.map((d) => d.id).sort()).toEqual([...visible].sort())
        expect(corpus.documents.find((d) => d.id === J["j-bail-02"])).toMatchObject({
          title: "Post-arrest bail under section 497 CrPC granted on further inquiry",
          citations: ["2099 SCMR 3102", "PLD 2099 SC 3202"],
          benchType: "division",
        })
        expect(corpus).toMatchObject({ embeddingModel: LIVE_MODEL, embeddingDim: String(DIM), vectors: null })
        expect(corpus.storedVectors).toEqual([{ model: LIVE_MODEL, dim: DIM }])
        const v = corpus.verdicts([J["j-bail-01"], J["j-pending"], J["j-bail-02"]])
        expect(Object.fromEntries([...v.entries()])).toEqual({
          [J["j-bail-01"]]: "OVERRULED",
          [J["j-pending"]]: "UNVERIFIED",
          [J["j-bail-02"]]: "VERIFIED",
        })
        const withVectors = await store.load(() => ({ vectors: true }))
        expect(withVectors.vectors?.size).toBe(visible.length)
        expect(withVectors.vectors?.get(J["j-bail-01"])?.length).toBe(DIM)
      } finally {
        await store.end()
      }
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
      // A session that is not read-only is refused too.
      const store = new PgResearchCorpus(await configFor(db.researchUrl), { sessionOptions: "-c default_transaction_read_only=off" })
      try {
        expect(await reasonOf(store.load(keywordPlan))).toBe("wrong_role")
      } finally {
        await store.end()
      }
    })

    it("over a row cap the load fails as row_cap, never a truncated corpus", async () => {
      const { PgResearchCorpus } = await reader()
      const visible = Object.keys(J).filter((k) => !(k in hidden)).length
      const cases: Array<[string, { maxJudgments?: number; maxTreatments?: number; maxVectors?: number }, boolean, string]> = [
        ["judgments at the cap", { maxJudgments: visible }, false, "loaded"],
        ["judgments over the cap", { maxJudgments: visible - 1 }, false, "row_cap"],
        ["treatments over the cap", { maxTreatments: 1 }, false, "row_cap"],
        ["treatments at the cap", { maxTreatments: 2 }, false, "loaded"],
        ["vectors over the cap", { maxVectors: visible - 1 }, true, "row_cap"],
        ["vectors at the cap", { maxVectors: visible }, true, "loaded"],
        ["vectors over the cap, not loaded for a keyword query", { maxVectors: 1 }, false, "loaded"],
      ]
      const out: Record<string, string> = {}
      for (const [label, opts, vectors, _want] of cases) {
        const store = new PgResearchCorpus(await configFor(db.researchUrl), opts)
        try {
          out[label] = await reasonOf(store.load(() => ({ vectors })))
        } finally {
          await store.end()
        }
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
