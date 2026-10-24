/**
 * FA-D5-003 R1 (spec §7): a realistic-size synthetic corpus for the scale e2e and the parity suite, and the ground truth
 * they compare against: `rankResearchCorpus` over the whole visible corpus, read as the superuser through the same views.
 *
 * The rows are written by the superuser in bulk (generate_series), the way an operator back-fills a corpus, inside a
 * finished publication with complete provenance, so they are visible; the term index is then built by the F19 CLI
 * (`index-terms`, spec R21). Synthetic data only: the year 2099, invented titles, no real judgment, statute or party.
 */
import { randomUUID } from "node:crypto"
import pg from "pg"
import { researchVerdicts } from "@/platform/corpus/pgResearchCorpus"
import type { Bench } from "@/services/d4-2/citationVerdict"
import type { ResearchCorpus, ResearchDocument, ResearchSource } from "@/services/d5-1/research"
import { DIM, LIVE_MODEL } from "@/tests/helpers/fa-d5-003-corpus"

/** The words titles are made of: legal vocabulary, so queries hit thousands of judgments at once. */
export const SCALE_VOCABULARY: readonly string[] = [
  "bail", "arrest", "murder", "khula", "dower", "custody", "minor", "guardian", "rent", "ejectment", "tenant",
  "landlord", "specific", "performance", "contract", "limitation", "appeal", "revision", "writ", "constitutional",
  "petition", "service", "pension", "tax", "customs", "narcotics", "trafficking", "cheque", "dishonour", "inheritance",
  "succession", "partition", "preemption", "talb", "ishhad", "nikah", "divorce", "maintenance", "crpc", "ppc",
]

/** Citation numbers of the bulk rows start here, clear of every fixture citation (3101-3999). */
export const SCALE_CITATION_BASE = 100_000

export type ScaleCounts = { judgments: number; citations: number; overrulings: number; pending: number; vectors: number }

/** A deterministic generator (LCG), so a run is reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/**
 * Bulk-writes `judgments` visible judgments (one PLD citation each, an SCMR citation for every second one), overrulings,
 * pending overrulings, `followed` treatments, and `vectors` dense deterministic vectors under the live model. Every 997th
 * title carries an Urdu word and every 1,009th a name with a combining mark, so the fold is exercised through the index.
 */
export async function seedScaleCorpus(admin: pg.Client, opts: { judgments: number; vectors: number; seed: number }): Promise<ScaleCounts> {
  const pub = randomUUID()
  await admin.query(
    `INSERT INTO corpus_publication (id, batch_key, input_sha256, source_kind, actor_id, publisher_session_user,
       item_count, promoted_count, quarantined_count, updated_count, unchanged_count, rejected_count, finished_at)
     VALUES ($1, $2, $3, 'curated', 'fa-d5-003-scale', current_user, 0, 0, 0, 0, 0, 0, now())`,
    [pub, `curated/fa-d5-003-scale-${pub.slice(0, 8)}`, "5".repeat(64)]
  )
  const source = (
    await admin.query(
      `INSERT INTO source_provenance (source_name, source_url, fetched_at, content_hash, extraction_method, extractor_version)
       VALUES ('fa-d5-003-scale', 'https://fa-d5-003.example.invalid/scale', '2099-05-06T07:08:09Z', $1, 'manual', 'fa-d5-003-scale-1')
       RETURNING id::text AS id`,
      ["6".repeat(64)]
    )
  ).rows[0].id as string
  await admin.query("CREATE TEMP TABLE scale_j (rn int PRIMARY KEY, id uuid NOT NULL) ON COMMIT PRESERVE ROWS")
  await admin.query(
    `WITH w AS (SELECT $4::text[] AS w),
          ins AS (
       INSERT INTO judgment (case_title, bench_type, classification, source_id, review_status, publication_id)
       SELECT initcap(w[1 + (g * 7) % 40]) || ' ' || w[1 + (g * 13) % 40] || ' ' || w[1 + (g * 17) % 40]
                || ' under section ' || (g % 600) || ' ' || w[1 + (g * 19) % 40] || ' ' || w[1 + (g * 23) % 40]
                || CASE WHEN g % 997 = 0 THEN ' ضمانت' ELSE '' END
                || CASE WHEN g % 1009 = 0 THEN ' Muḥammad' ELSE '' END,
              (ARRAY['single', 'division', 'full', 'larger'])[1 + g % 4], 'public', $1::uuid, 'promoted', $2::uuid
         FROM generate_series(1, $3::int) g, w
       RETURNING id)
     INSERT INTO scale_j (rn, id) SELECT row_number() OVER (ORDER BY id), id FROM ins`,
    [source, pub, opts.judgments, SCALE_VOCABULARY]
  )
  await admin.query(
    `INSERT INTO citation (judgment_id, citation_text, source_id, review_status, publication_id)
     SELECT id, 'PLD 2099 SC ' || ($3::int + rn), $1::uuid, 'promoted', $2::uuid FROM scale_j`,
    [source, pub, SCALE_CITATION_BASE]
  )
  await admin.query(
    `INSERT INTO citation (judgment_id, citation_text, source_id, review_status, publication_id)
     SELECT id, '2099 SCMR ' || ($3::int + rn), $1::uuid, 'promoted', $2::uuid FROM scale_j WHERE rn % 2 = 0`,
    [source, pub, SCALE_CITATION_BASE]
  )
  // Overrulings by a larger bench (every 2nd judgment overrules its successor), pending ones (quarantined), and
  // `followed` treatments (Module 33 counts only an overruling).
  const n = opts.judgments
  await admin.query(
    `INSERT INTO treatment (treating_judgment_id, treated_judgment_id, treatment, treating_bench_type, source_id, review_status, publication_id)
     SELECT t.id, d.id, 'overruled', 'larger', $1::uuid, 'promoted', $2::uuid
       FROM scale_j t JOIN scale_j d ON d.rn = t.rn + 1 WHERE t.rn % 2 = 0 AND t.rn < $3::int`,
    [source, pub, n]
  )
  await admin.query(
    `INSERT INTO treatment (treating_judgment_id, treated_judgment_id, treatment, treating_bench_type, source_id, review_status, publication_id)
     SELECT t.id, d.id, 'overruled', 'single', $1::uuid, 'quarantined', $2::uuid
       FROM scale_j t JOIN scale_j d ON d.rn = t.rn + 3 WHERE t.rn % 7 = 0 AND t.rn + 3 <= $3::int`,
    [source, pub, n]
  )
  await admin.query(
    `INSERT INTO treatment (treating_judgment_id, treated_judgment_id, treatment, treating_bench_type, source_id, review_status, publication_id)
     SELECT t.id, d.id, 'followed', 'larger', $1::uuid, 'promoted', $2::uuid
       FROM scale_j t JOIN scale_j d ON d.rn = t.rn + 5 WHERE t.rn % 11 = 0 AND t.rn + 5 <= $3::int`,
    [source, pub, n]
  )
  // Dense vectors (components in [-0.5, 0.5)), deterministic, on the first `vectors` judgments in id order.
  const next = rng(opts.seed)
  const ids = (await admin.query("SELECT id::text AS id FROM scale_j WHERE rn <= $1 ORDER BY rn", [opts.vectors])).rows.map((r) => r.id as string)
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200)
    const texts = batch.map(() => `[${Array.from({ length: DIM }, () => (next() - 0.5).toFixed(6)).join(",")}]`)
    await admin.query(
      `INSERT INTO corpus_embeddings (entity_type, entity_id, model, classification_rank, embedding)
       SELECT 'judgment', u.id, $3, 0, u.v::vector FROM unnest($1::uuid[], $2::text[]) AS u(id, v)`,
      [batch, texts, LIVE_MODEL]
    )
  }
  await admin.query("DROP TABLE scale_j")
  await admin.query("ANALYZE")
  const counts = (
    await admin.query(
      `SELECT (SELECT count(*) FROM v_research_judgment)::int AS judgments,
              (SELECT count(*) FROM v_authority_citation)::int AS citations,
              (SELECT count(*) FROM v_authority_treatment WHERE treatment = 'overruled')::int AS overrulings,
              (SELECT count(*) FROM v_authority_pending_adverse)::int AS pending,
              (SELECT count(*) FROM v_research_embedding)::int AS vectors`
    )
  ).rows[0] as ScaleCounts
  return counts
}

const BENCHES: ReadonlySet<string> = new Set(["single", "division", "full", "larger"])

/**
 * The whole visible corpus as `rankResearchCorpus` takes it, read as the superuser through the research views (the same
 * visibility rule), with every overruling and pending overruling, and every visible vector when asked.
 */
export async function loadTruthCorpus(admin: pg.Client, withVectors: boolean): Promise<ResearchCorpus> {
  const meta = (
    await admin.query(
      `SELECT (SELECT value FROM corpus_metadata WHERE key = 'embedding_model') AS model,
              (SELECT value FROM corpus_metadata WHERE key = 'embedding_dim') AS dim`
    )
  ).rows[0] as { model: string; dim: string }
  const rows = (
    await admin.query(
      `SELECT j.judgment_id::text AS id, j.case_title AS title, j.bench_type,
              coalesce(array_agg(c.citation_text ORDER BY c.citation_text COLLATE "C") FILTER (WHERE c.citation_text IS NOT NULL), '{}') AS citations
         FROM v_research_judgment j LEFT JOIN v_authority_citation c ON c.judgment_id = j.judgment_id
        GROUP BY 1, 2, 3 ORDER BY 1`
    )
  ).rows as Array<{ id: string; title: string | null; bench_type: string; citations: string[] }>
  const documents: ResearchDocument[] = rows.map((r) => {
    if (!BENCHES.has(r.bench_type)) throw new Error(`truth: bench ${r.bench_type}`)
    return { id: r.id, title: r.title ?? "", citations: r.citations, benchType: r.bench_type as Bench }
  })
  const benchById = new Map(documents.map((d) => [d.id, d.benchType]))
  const overrulings = (
    await admin.query(
      `SELECT treated_judgment_id::text AS treated, treating_bench_type AS recorded, treating_judgment_bench AS treating
         FROM v_authority_treatment WHERE treatment = 'overruled'`
    )
  ).rows.map((r) => ({ treatedId: r.treated as string, recordedBench: r.recorded as Bench, treatingBench: r.treating as Bench }))
  const pending = new Set(
    (await admin.query("SELECT treated_judgment_id::text AS id FROM v_authority_pending_adverse")).rows.map((r) => r.id as string)
  )
  const storedVectors = (
    await admin.query("SELECT DISTINCT model, vector_dims(embedding) AS dim FROM v_research_embedding ORDER BY 1, 2")
  ).rows.map((r) => ({ model: r.model as string, dim: Number(r.dim) }))
  let vectors: Map<string, readonly number[]> | null = null
  if (withVectors) {
    vectors = new Map()
    for (const r of (await admin.query("SELECT judgment_id::text AS id, embedding::text AS v FROM v_research_embedding WHERE model = $1", [meta.model])).rows) {
      vectors.set(r.id as string, JSON.parse(r.v as string) as number[])
    }
  }
  return {
    embeddingModel: meta.model,
    embeddingDim: meta.dim,
    documents,
    storedVectors,
    vectors,
    verdicts: researchVerdicts(benchById, overrulings, pending),
  }
}

/** A source that answers the whole-corpus truth (what `searchResearch` over it returns is the ground truth). */
export function truthSource(corpus: ResearchCorpus): ResearchSource {
  return {
    async load(plan) {
      const { vectors } = plan({ embeddingModel: corpus.embeddingModel, embeddingDim: corpus.embeddingDim })
      return vectors ? corpus : { ...corpus, vectors: null }
    },
  }
}

/** A unit-free dense query vector, deterministic. */
export function denseVector(seed: number): number[] {
  const next = rng(seed)
  return Array.from({ length: DIM }, () => next() - 0.5)
}
