/**
 * The research corpus reader (audit FA-D5-003, closes FA-D2WA-001; spec R2, R6-R12): D5 research's view of the firm's
 * published Annex A corpus on Postgres, for the court-ops core in the Next process. It reads only six relations, as a
 * login that is a member of `corpus_research_reader` (005) and, for CONNECT only, `corpus_clients`, and of nothing else:
 * - `v_research_judgment` and `v_research_embedding` (005): the judgments and vectors visible under 004's rule
 *   (promoted, a bench, public, a finished publication, complete provenance);
 * - `v_authority_citation`, `v_authority_treatment`, `v_authority_pending_adverse` (004): their citations, overrulings and
 *   pending overrulings, as the F05 gate reads them;
 * - `corpus_metadata`: the publication contract, `last_refresh`, the live embedding model and dimension.
 *
 * One load is one snapshot: a pooled connection, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, the role check (R11),
 * the metadata check (R12), the caller's plan (it validates a query vector against the live model), then the rows, then
 * `COMMIT`. The statements are this module's constants; their only parameters are row caps and the live model. Every
 * statement is bounded by `statement_timeout`, and every row set by a cap read as `LIMIT cap + 1`: over a cap the load fails
 * as `row_cap`, never with a truncated corpus (R9).
 *
 * It fails closed: anything it cannot read throws CorpusUnavailableError with a reason token (a driver error, classified as
 * the F05 reader classifies it; a login that can do more than read the six relations; a corpus that breaks its contract, is
 * stale, or is over a cap). A query the search refuses (the caller's plan throws a PublicError) passes through unchanged.
 * A programming error in this file is not wrapped: it fails the request.
 */
import pg from "pg"
import { PENDING_OVERRULING } from "@/functions/src/d4/authorityPending"
import { classifyPgError, parseLastRefresh } from "@/functions/src/d4/corpusAuthorityStore"
import type { CorpusReaderConfig } from "@/functions/src/d4/corpusReaderConfig"
import { verdictFromTreatments, type Bench, type CitationVerdict, type TreatmentFact } from "@/services/d4-2/citationVerdict"
import { CorpusUnavailableError, type CorpusUnavailableReason } from "@/services/d5-1/corpusUnavailable"
import {
  EMBEDDING_DIM,
  type ResearchCorpus,
  type ResearchCorpusMeta,
  type ResearchDocument,
  type ResearchLoadPlan,
  type ResearchSource,
} from "@/services/d5-1/research"

/** Row caps (R9): judgments (their citations aggregated per judgment), overruling and pending rows, vectors. */
export const RESEARCH_MAX_JUDGMENTS = 20_000
export const RESEARCH_MAX_TREATMENTS = 20_000
export const RESEARCH_MAX_VECTORS = 5_000
/** Distinct (model, dimension) pairs a sane corpus can hold; more breaks the contract. */
const MAX_VECTOR_SHAPES = 100
/** Pool and timing (R9), as the F05 reader's. */
export const POOL_MAX = 3
export const CONNECT_TIMEOUT_MS = 3000
export const STATEMENT_TIMEOUT_MS = 5000
export const IDLE_TIMEOUT_MS = 10000
/** A last_refresh this far in the future is not trusted (F05 D19). */
export const FUTURE_SKEW_MS = 5 * 60 * 1000
/** The publication contract this reader understands (corpus_metadata.publication_contract, F19 D30). */
export const PUBLICATION_CONTRACT = "1"
export const APPLICATION_NAME = "sikander-d5-research"

/** The six relations the research login may read, and nothing else (R2, R11). */
export const RESEARCH_READABLE: readonly string[] = [
  "v_research_judgment",
  "v_research_embedding",
  "v_authority_citation",
  "v_authority_treatment",
  "v_authority_pending_adverse",
  "corpus_metadata",
]

const BENCHES: ReadonlySet<string> = new Set<Bench>(["single", "division", "full", "larger"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isBench = (value: unknown): value is Bench => typeof value === "string" && BENCHES.has(value)
const unavailable = (reason: CorpusUnavailableReason) => new CorpusUnavailableError(reason)

/** The F05 classification of a driver error (D6), as a research reason. */
const DRIVER_REASONS: ReadonlySet<string> = new Set(["unreachable", "timeout", "auth", "tls", "permission", "schema_missing", "busy"])
function driverReason(err: unknown): CorpusUnavailableReason {
  const reason = classifyPgError(err)
  return DRIVER_REASONS.has(reason) ? (reason as CorpusUnavailableReason) : "error"
}

// R11, F05 D7's allowlist under the research role. The session first: a role check reads no table, so a writer or
// superuser login is wrong_role, not a permission error on corpus_metadata.
// - It must inherit corpus_research_reader (005's role).
// - Membership is an allowlist: corpus_research_reader and, for CONNECT only, corpus_clients, and no other role.
//   pg_has_role(..., 'MEMBER') is transitive and ignores INHERIT and SET, so a SET-only grant, a chain through another
//   role, the database's owner and every predefined role (pg_read_all_data, ...) all count.
// - No role it is a member of, itself included, may be a superuser or hold CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS.
// - It must hold no write privilege on any relation in schema public, and neither USAGE nor UPDATE on any sequence there
//   (has_sequence_privilege raises on anything that is not a sequence, and the planner may test a qual before relkind =
//   'S', so a CASE fixes the order).
// - It must be able to SELECT (the table or any column) no relation in schema public but RESEARCH_READABLE.
// - The session must be read-only by default, not only inside this load's READ ONLY transaction.
// A database without 005 has no corpus_research_reader: pg_has_role raises 42704, which is schema_missing.
const ROLE_SQL = `SELECT pg_has_role('corpus_research_reader', 'USAGE') AS reader,
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                WHERE pg_has_role(current_user, r.oid, 'MEMBER')
                  AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)) AS elevated,
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                WHERE r.rolname NOT IN (current_user, 'corpus_research_reader', 'corpus_clients')
                  AND pg_has_role(current_user, r.oid, 'MEMBER')) AS other_role,
       EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                  AND (has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                       OR has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES')))
         OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                     WHERE c.relnamespace = 'public'::regnamespace
                       AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'USAGE,UPDATE') ELSE false END) AS writes,
       EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                  AND c.relname <> ALL ($1::text[])
                  AND has_any_column_privilege(c.oid, 'SELECT')) AS reads_more,
       current_setting('default_transaction_read_only') AS session_read_only,
       current_setting('transaction_read_only') AS read_only`
const METADATA_SQL = `SELECT (SELECT value FROM public.corpus_metadata WHERE key = 'publication_contract') AS contract,
       (SELECT value FROM public.corpus_metadata WHERE key = 'last_refresh') AS last_refresh,
       (SELECT value FROM public.corpus_metadata WHERE key = 'embedding_model') AS embedding_model,
       (SELECT value FROM public.corpus_metadata WHERE key = 'embedding_dim') AS embedding_dim`
// Each visible judgment with its visible citations, in byte order (C collation), one row per judgment.
const DOCUMENTS_SQL = `SELECT j.judgment_id::text AS id, j.case_title AS title, j.bench_type,
       coalesce(array_agg(c.citation_text ORDER BY c.citation_text COLLATE "C") FILTER (WHERE c.citation_text IS NOT NULL),
                '{}'::text[]) AS citations
  FROM public.v_research_judgment j
  LEFT JOIN public.v_authority_citation c ON c.judgment_id = j.judgment_id
 GROUP BY j.judgment_id, j.case_title, j.bench_type
 ORDER BY j.judgment_id
 LIMIT $1`
// Only an overruling counts in the Module 33 rule; a pending or hidden one is reported, never absent (F05 D2, ruling 3).
const TREATMENTS_SQL = `SELECT k, treated, recorded, treating FROM (
  SELECT 'pending' AS k, treated_judgment_id::text AS treated, NULL::text AS recorded, NULL::text AS treating
    FROM public.v_authority_pending_adverse
  UNION ALL
  SELECT 'overruled', treated_judgment_id::text, treating_bench_type, treating_judgment_bench
    FROM public.v_authority_treatment WHERE treatment = 'overruled') t
 LIMIT $1`
const VECTOR_SHAPES_SQL = `SELECT model, vector_dims(embedding) AS dim
  FROM public.v_research_embedding
 GROUP BY model, vector_dims(embedding)
 ORDER BY model COLLATE "C", 2
 LIMIT $1`
const VECTORS_SQL = `SELECT judgment_id::text AS id, embedding::text AS v
  FROM public.v_research_embedding
 WHERE model = $1
 ORDER BY judgment_id
 LIMIT $2`

/**
 * The Module 33 verdicts of the published corpus (R7): each judgment's overrulings, with the treating judgment's bench
 * and the bench the record states, plus PENDING_OVERRULING when an overruling of it is pending or hidden: the F05 gate's
 * facts (PgAuthorityStore.listTreatments) through the shared rule, so a hidden overruling never reads as good law.
 */
export function researchVerdicts(
  benchById: ReadonlyMap<string, Bench>,
  overrulings: ReadonlyArray<{ treatedId: string; recordedBench: Bench; treatingBench: Bench }>,
  pending: ReadonlySet<string>
): (ids: readonly string[]) => ReadonlyMap<string, CitationVerdict> {
  const facts = new Map<string, TreatmentFact[]>()
  for (const o of overrulings) {
    const list = facts.get(o.treatedId) ?? []
    list.push({ kind: "overruled", treatingJudgmentBench: o.treatingBench, recordedTreatingBench: o.recordedBench })
    facts.set(o.treatedId, list)
  }
  return (ids) => {
    const out = new Map<string, CitationVerdict>()
    for (const id of ids) {
      const bench = benchById.get(id)
      if (!bench) continue
      const own = [...(facts.get(id) ?? [])]
      if (pending.has(id)) own.push({ ...PENDING_OVERRULING })
      out.set(id, verdictFromTreatments(bench, own))
    }
    return out
  }
}

export type PgResearchOptions = {
  maxJudgments?: number
  maxTreatments?: number
  maxVectors?: number
  statementTimeoutMs?: number
  /** Replaces the session's startup options; only for a test that proves a session which is not read-only is refused. */
  sessionOptions?: string
}

export class PgResearchCorpus implements ResearchSource {
  private readonly pool: pg.Pool
  private readonly maxStalenessMs: number
  private readonly maxJudgments: number
  private readonly maxTreatments: number
  private readonly maxVectors: number

  constructor(config: CorpusReaderConfig, opts: PgResearchOptions = {}) {
    this.maxStalenessMs = config.maxStalenessHours * 3600_000
    this.maxJudgments = opts.maxJudgments ?? RESEARCH_MAX_JUDGMENTS
    this.maxTreatments = opts.maxTreatments ?? RESEARCH_MAX_TREATMENTS
    this.maxVectors = opts.maxVectors ?? RESEARCH_MAX_VECTORS
    const statementTimeout = opts.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS
    // Field by field (F05 D8): nothing from the URL beyond these reaches the driver.
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: config.ca === null ? false : { ca: config.ca, rejectUnauthorized: true },
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      allowExitOnIdle: true,
      application_name: APPLICATION_NAME,
      options: opts.sessionOptions ?? "-c default_transaction_read_only=on",
      statement_timeout: statementTimeout,
      query_timeout: statementTimeout + 1000,
    })
    // An idle client's error (the server went away) must not crash the process; the next load reports it.
    this.pool.on("error", () => undefined)
  }

  async end(): Promise<void> {
    await this.pool.end()
  }

  async load(plan: ResearchLoadPlan): Promise<ResearchCorpus> {
    let client: pg.PoolClient
    try {
      client = await this.pool.connect()
    } catch (e) {
      throw unavailable(driverReason(e))
    }
    let committed = false
    try {
      await this.run(client, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", [])
      await this.checkRole(client)
      const meta = await this.checkMetadata(client)
      // The caller's plan may refuse the query (a PublicError): it passes through unchanged.
      const { vectors: wantVectors } = plan(meta)
      const { documents, benchById } = await this.documents(client)
      const verdicts = await this.verdicts(client, benchById)
      const storedVectors = await this.vectorShapes(client)
      const vectors = wantVectors ? await this.vectors(client, meta.embeddingModel) : null
      await this.run(client, "COMMIT", [])
      committed = true
      return { ...meta, documents, storedVectors, vectors, verdicts }
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined)
      // A connection that failed mid-load is destroyed, not returned to the pool.
      client.release(committed ? undefined : true)
    }
  }

  private async run(client: pg.PoolClient, sql: string, params: unknown[]): Promise<pg.QueryResult> {
    try {
      return await client.query(sql, params)
    } catch (e) {
      throw unavailable(driverReason(e))
    }
  }

  private async rowsUnder<R>(client: pg.PoolClient, sql: string, params: unknown[], cap: number): Promise<R[]> {
    const rows = (await this.run(client, sql, params)).rows as R[]
    if (rows.length > cap) throw unavailable("row_cap")
    return rows
  }

  private async checkRole(client: pg.PoolClient): Promise<void> {
    const role = (await this.run(client, ROLE_SQL, [RESEARCH_READABLE])).rows[0] as
      | { reader: unknown; elevated: unknown; other_role: unknown; writes: unknown; reads_more: unknown; session_read_only: unknown; read_only: unknown }
      | undefined
    if (
      !role ||
      role.reader !== true ||
      role.elevated !== false ||
      role.other_role !== false ||
      role.writes !== false ||
      role.reads_more !== false ||
      role.session_read_only !== "on" ||
      role.read_only !== "on"
    ) {
      throw unavailable("wrong_role")
    }
  }

  /** Publication contract '1', a well-formed and fresh last_refresh, and the live model and dimension (R12). */
  private async checkMetadata(client: pg.PoolClient): Promise<ResearchCorpusMeta> {
    const meta = (await this.run(client, METADATA_SQL, [])).rows[0] as
      | { contract: unknown; last_refresh: unknown; embedding_model: unknown; embedding_dim: unknown }
      | undefined
    if (meta?.contract !== PUBLICATION_CONTRACT) throw unavailable("contract_missing")
    const refreshed = parseLastRefresh(meta.last_refresh)
    if (refreshed === null) throw unavailable("contract_missing")
    const wall = Date.now()
    if (refreshed - wall > FUTURE_SKEW_MS || wall - refreshed > this.maxStalenessMs) throw unavailable("stale")
    if (typeof meta.embedding_model !== "string" || typeof meta.embedding_dim !== "string") throw unavailable("contract_missing")
    return { embeddingModel: meta.embedding_model, embeddingDim: meta.embedding_dim }
  }

  private async documents(client: pg.PoolClient): Promise<{ documents: ResearchDocument[]; benchById: Map<string, Bench> }> {
    const rows = await this.rowsUnder<{ id: unknown; title: unknown; bench_type: unknown; citations: unknown }>(
      client,
      DOCUMENTS_SQL,
      [this.maxJudgments + 1],
      this.maxJudgments
    )
    const benchById = new Map<string, Bench>()
    const documents = rows.map((r): ResearchDocument => {
      if (
        typeof r.id !== "string" ||
        !UUID.test(r.id) ||
        (r.title !== null && typeof r.title !== "string") ||
        !isBench(r.bench_type) ||
        !Array.isArray(r.citations) ||
        !r.citations.every((c) => typeof c === "string")
      ) {
        throw unavailable("inconsistent")
      }
      benchById.set(r.id, r.bench_type)
      return { id: r.id, title: r.title ?? "", citations: r.citations as string[], benchType: r.bench_type }
    })
    return { documents, benchById }
  }

  private async verdicts(client: pg.PoolClient, benchById: ReadonlyMap<string, Bench>): Promise<ResearchCorpus["verdicts"]> {
    const rows = await this.rowsUnder<{ k: unknown; treated: unknown; recorded: unknown; treating: unknown }>(
      client,
      TREATMENTS_SQL,
      [this.maxTreatments + 1],
      this.maxTreatments
    )
    const pending = new Set<string>()
    const overrulings: { treatedId: string; recordedBench: Bench; treatingBench: Bench }[] = []
    for (const r of rows) {
      if (typeof r.treated !== "string") throw unavailable("inconsistent")
      if (r.k === "pending") {
        pending.add(r.treated)
        continue
      }
      if (r.k !== "overruled" || !isBench(r.recorded) || !isBench(r.treating)) throw unavailable("inconsistent")
      overrulings.push({ treatedId: r.treated, recordedBench: r.recorded, treatingBench: r.treating })
    }
    return researchVerdicts(benchById, overrulings, pending)
  }

  private async vectorShapes(client: pg.PoolClient): Promise<Array<{ model: string; dim: number }>> {
    const rows = (await this.run(client, VECTOR_SHAPES_SQL, [MAX_VECTOR_SHAPES + 1])).rows as Array<{ model: unknown; dim: unknown }>
    if (rows.length > MAX_VECTOR_SHAPES) throw unavailable("inconsistent")
    return rows.map((r) => {
      if (typeof r.model !== "string" || typeof r.dim !== "number") throw unavailable("inconsistent")
      return { model: r.model, dim: r.dim }
    })
  }

  private async vectors(client: pg.PoolClient, model: string): Promise<Map<string, readonly number[]>> {
    const rows = await this.rowsUnder<{ id: unknown; v: unknown }>(client, VECTORS_SQL, [model, this.maxVectors + 1], this.maxVectors)
    const out = new Map<string, readonly number[]>()
    for (const r of rows) {
      if (typeof r.id !== "string" || typeof r.v !== "string") throw unavailable("inconsistent")
      let vector: unknown
      try {
        vector = JSON.parse(r.v)
      } catch {
        throw unavailable("inconsistent")
      }
      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIM || !vector.every((x) => typeof x === "number")) {
        throw unavailable("inconsistent")
      }
      out.set(r.id, vector as number[])
    }
    return out
  }
}
