/**
 * The research corpus reader (audit FA-D5-003, closes FA-D2WA-001; spec R2, R6-R12, and §7 R19-R31 for the re-audit's
 * R1-001 to R1-003): D5 research's view of the firm's published Annex A corpus on Postgres, for the court-ops core in the
 * Next process. It reads only eight relations, as a login that is a member of `corpus_research_reader` (005) and, for
 * CONNECT only, `corpus_clients`, and of nothing else:
 * - `v_research_judgment` and `v_research_embedding` (005): the judgments and vectors visible under 004's rule
 *   (promoted, a bench, public, a finished publication, complete provenance);
 * - `v_research_term` and `v_research_pending` (006): the pre-folded terms of the visible judgments' titles and visible
 *   citations, and the visible judgments whose terms are not (yet) in the index;
 * - `v_authority_citation`, `v_authority_treatment`, `v_authority_pending_adverse` (004): their citations, overrulings and
 *   pending overrulings, as the F05 gate reads them;
 * - `corpus_metadata`: the publication contract, `last_refresh`, the live embedding model and dimension.
 *
 * One search is one snapshot: a pooled connection, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, the role check
 * (R11, R31), the metadata check (R12), the caller's plan (it validates a query vector against the live model), the
 * corpus lock (R29), then the candidate set (R19): every judgment that can reach the whole-corpus top k, with the whole
 * corpus's IDF statistics, never the whole corpus. Then the shared ranking picks the top k, their treatments are read
 * (R26), and `COMMIT`. The answer equals `rankResearchCorpus` over the whole visible corpus:
 * - keyword (R24): judgments are grouped by the set of query terms they hold (their signature). One statement counts
 *   each group (the document frequencies are the sums) and returns its first k members by (distinct-term count, id),
 *   the ranking's tie-break; every member of a group scores the same, so the groups are ranked here and the k slots
 *   filled from those lists: whole groups, then the first members of the group that overflows. Only those are loaded.
 *   The judgments the index has not caught up with (pending) are loaded and folded here; the R4a candidates (every
 *   number of a cited key) are loaded and checked by the citation parser;
 * - vector and blend (R25): pgvector's cosine bounds each vector judgment's score within ±ε (ε = 5e-4, 2.7 times the
 *   float32 error bound for 1,536 dimensions), and every judgment whose upper bound reaches the k-th best lower bound is
 *   loaded with its vector and scored here; the rest provably score below k loaded judgments.
 * Every statement is this module's constant; its parameters are the query's terms, ids, bounds and the live model. Every
 * statement is bounded by `statement_timeout`; every candidate set by a per-query bound read as `LIMIT bound + 1`: over a
 * bound the search fails as `row_cap` (or `unindexed` for the pending set), never with a truncated answer (R27). A loaded
 * judgment whose terms disagree with the index is `inconsistent`, never a silently different answer.
 *
 * It fails closed: anything it cannot read throws CorpusUnavailableError with a reason token (a driver error, classified as
 * the F05 reader classifies it; a login that can do more than read the eight relations; a corpus that breaks its contract,
 * its lock, is stale, or is over a bound). A query the search refuses (the caller's plan throws a PublicError) passes
 * through unchanged. A programming error in this file is not wrapped: it fails the request.
 */
import pg from "pg"
import { PENDING_OVERRULING } from "@/functions/src/d4/authorityPending"
import type { CorpusReaderConfig } from "@/functions/src/d4/corpusReaderConfig"
import { verdictFromTreatments, type Bench, type CitationVerdict, type TreatmentFact } from "@/services/d4-2/citationVerdict"
import { CorpusUnavailableError, type CorpusUnavailableReason } from "@/services/d5-1/corpusUnavailable"
import {
  EMBEDDING_DIM,
  KEYWORD_WEIGHT,
  SEMANTIC_WEIGHT,
  rankResearchCorpus,
  researchCitedCitation,
  researchDocumentTerms,
  researchIdf,
  researchKeywordScore,
  researchLockProblem,
  researchMode,
  researchRawScore,
  researchRoundScore,
  type PreparedResearchQuery,
  type ResearchCorpus,
  type ResearchCorpusMeta,
  type ResearchDocument,
  type ResearchLoadPlan,
  type ResearchSource,
} from "@/services/d5-1/research"

/**
 * Per-query bounds (R27): judgments the index has not caught up with, loaded whole; R4a candidates (judgments holding
 * every number of a cited key), loaded whole; signature groups, each read as its count and its first k member ids (a
 * query of t terms has at most 2^t − 1 signatures, with and without a vector: 4,096 holds every query of up to 11
 * terms, and a longer one is refused only when more combinations than that occur in the corpus).
 */
export const RESEARCH_MAX_PENDING = 2_000
export const RESEARCH_MAX_CITED = 2_000
export const RESEARCH_MAX_GROUPS = 4_096
/** Vector judgments whose score bound can reach the top k, loaded with their vectors (R25). */
export const RESEARCH_MAX_SEMANTIC = 1_000
/**
 * |cos_pgvector − cos| ≤ 2γ/(1−γ) + 5e-7 ≈ 1.84e-4 for 1,536-d float32 vectors (γ = n·u/(1−n·u), u = 2^-24: pgvector 0.6
 * sums the dot product and both norms in float32), so 5e-4 is 2.7 times the bound (R25).
 */
export const SEMANTIC_EPSILON = 5e-4
/** Two raw scores this far apart can round (6 decimals) to the same score; and the least raw score that rounds above 0. */
const SCORE_SLACK = 1e-6
const HIT_FLOOR = 5e-7
/** Distinct models a sane corpus can hold; more breaks the contract. */
const MAX_MODELS = 100
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

/** The eight relations the research login may read, all in schema public, and nothing else (R2, R11, R20, R31). */
export const RESEARCH_READABLE: readonly string[] = [
  "v_research_judgment",
  "v_research_embedding",
  "v_research_term",
  "v_research_pending",
  "v_authority_citation",
  "v_authority_treatment",
  "v_authority_pending_adverse",
  "corpus_metadata",
]

const BENCHES: ReadonlySet<string> = new Set<Bench>(["single", "division", "full", "larger"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isBench = (value: unknown): value is Bench => typeof value === "string" && BENCHES.has(value)
const unavailable = (reason: CorpusUnavailableReason) => new CorpusUnavailableError(reason)

// The F05 reader's classification of a driver error (functions/src/d4/corpusAuthorityStore.ts classifyPgError, plan D6),
// restated here because that module is not a pure Functions module the Next runtime may import (audit F18). A parity test
// (tests/fa-d5-003.research-source.test.ts) holds the two equal over every code and message they know.
const SQLSTATE_REASONS: Readonly<Record<string, CorpusUnavailableReason>> = {
  "42501": "permission",
  "28P01": "auth",
  "28000": "auth",
  "57014": "timeout",
  "42P01": "schema_missing",
  "42703": "schema_missing",
  "3D000": "schema_missing",
  // undefined_object: the role 005 creates (corpus_research_reader) is not there.
  "42704": "schema_missing",
  "57P01": "unreachable",
  "57P02": "unreachable",
  "57P03": "unreachable",
}
const NODE_REASONS: Readonly<Record<string, CorpusUnavailableReason>> = {
  ECONNREFUSED: "unreachable",
  ENOTFOUND: "unreachable",
  EHOSTUNREACH: "unreachable",
  ENETUNREACH: "unreachable",
  ECONNRESET: "unreachable",
  EPIPE: "unreachable",
  EAI_AGAIN: "unreachable",
  ETIMEDOUT: "timeout",
}
const TLS_CODES = /^(ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_(VERIFY|GET)_|CERT_|ERR_OSSL_)/
const TIMEOUT_MESSAGES = /^(timeout expired|Connection terminated due to connection timeout|Query read timeout)$/
// pg-pool's message when a call waited connectionTimeoutMillis in its queue: every connection was in use (F05 D24).
const POOL_BUSY_MESSAGE = "timeout exceeded when trying to connect"
const TLS_MESSAGES = /^The server does not support SSL connections$/

/** The reason for a driver error, from its SQLSTATE or Node code, or node-pg's own timeout and TLS messages; else "error". */
export function classifyResearchPgError(err: unknown): CorpusUnavailableReason {
  if (err instanceof CorpusUnavailableError) return err.reason
  if (err === null || typeof err !== "object") return "error"
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (typeof code === "string") {
    if (SQLSTATE_REASONS[code]) return SQLSTATE_REASONS[code]
    if (/^08[0-9A-Z]{3}$/.test(code)) return "unreachable"
    if (NODE_REASONS[code]) return NODE_REASONS[code]
    if (TLS_CODES.test(code)) return "tls"
  }
  if (typeof message === "string") {
    if (message === POOL_BUSY_MESSAGE) return "busy"
    if (TIMEOUT_MESSAGES.test(message)) return "timeout"
    if (TLS_MESSAGES.test(message)) return "tls"
  }
  return "error"
}
const driverReason = classifyResearchPgError

const LAST_REFRESH = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/

/** corpus_metadata.last_refresh (F19 D30: YYYY-MM-DDTHH:MI:SS.ffffffZ, UTC) in epoch ms, or null (F05's parser, restated). */
export function parseResearchLastRefresh(value: unknown): number | null {
  if (typeof value !== "string") return null
  const m = LAST_REFRESH.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
  const ms = Date.UTC(y, mo - 1, d, h, mi, s, Math.floor(Number(m[7]) / 1000))
  const back = new Date(ms)
  // A 30 February or a 25th hour does not round-trip.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) {
    return null
  }
  return ms
}

// R11, F05 D7's allowlist under the research role, with R31's scope. The session first: a role check reads no table, so
// a writer or superuser login is wrong_role, not a permission error on corpus_metadata.
// - It must inherit corpus_research_reader (005's role).
// - Membership is an allowlist: corpus_research_reader and, for CONNECT only, corpus_clients, and no other role.
//   pg_has_role(..., 'MEMBER') is transitive and ignores INHERIT and SET, so a SET-only grant, a chain through another
//   role, the database's owner and every predefined role (pg_read_all_data, ...) all count.
// - No membership of the login, or of a role it is a member of, may be held WITH ADMIN OPTION (R31): a login that can
//   hand its role to others is more than a reader.
// - No role it is a member of, itself included, may be a superuser or hold CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS.
// - In every schema but pg_catalog, information_schema, the TOAST schemas and other sessions' temporary schemas (R31),
//   it must hold no write privilege on any relation, and neither USAGE nor UPDATE on any sequence (has_sequence_privilege
//   raises on anything that is not a sequence, and the planner may test a qual before relkind = 'S', so a CASE fixes the
//   order); and it must be able to SELECT (the table or any column) no relation but the eight of RESEARCH_READABLE in
//   schema public.
// - The session must be read-only by default, not only inside this load's READ ONLY transaction.
// A database without 005 has no corpus_research_reader: pg_has_role raises 42704, which is schema_missing.
const CHECKED_NAMESPACE = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
                  AND NOT pg_catalog.pg_is_other_temp_schema(n.oid)`
const ROLE_SQL = `SELECT pg_has_role('corpus_research_reader', 'USAGE') AS reader,
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                WHERE pg_has_role(current_user, r.oid, 'MEMBER')
                  AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)) AS elevated,
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                WHERE r.rolname NOT IN (current_user, 'corpus_research_reader', 'corpus_clients')
                  AND pg_has_role(current_user, r.oid, 'MEMBER')) AS other_role,
       EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                WHERE m.admin_option AND pg_has_role(current_user, m.member, 'MEMBER')) AS admin,
       EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE ${CHECKED_NAMESPACE} AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                  AND (has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                       OR has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES')))
         OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                     WHERE ${CHECKED_NAMESPACE}
                       AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'USAGE,UPDATE') ELSE false END) AS writes,
       EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE ${CHECKED_NAMESPACE} AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                  AND NOT (c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]))
                  AND has_any_column_privilege(c.oid, 'SELECT')) AS reads_more,
       current_setting('default_transaction_read_only') AS session_read_only,
       current_setting('transaction_read_only') AS read_only`
const METADATA_SQL = `SELECT (SELECT value FROM public.corpus_metadata WHERE key = 'publication_contract') AS contract,
       (SELECT value FROM public.corpus_metadata WHERE key = 'last_refresh') AS last_refresh,
       (SELECT value FROM public.corpus_metadata WHERE key = 'embedding_model') AS embedding_model,
       (SELECT value FROM public.corpus_metadata WHERE key = 'embedding_dim') AS embedding_dim`
// The corpus lock (R8, R29): the models of the vectors research can read (no vector is read), and the dimension their
// column declares (pgvector enforces it on every write). Only an unconstrained column needs the per-row scan.
const MODELS_SQL = `SELECT model FROM public.v_research_embedding GROUP BY model ORDER BY model COLLATE "C" LIMIT $1`
const DECLARED_DIM_SQL = `SELECT a.atttypmod AS dim FROM pg_catalog.pg_attribute a
 WHERE a.attrelid = 'public.v_research_embedding'::regclass AND a.attname = 'embedding' AND NOT a.attisdropped`
const VECTOR_SHAPES_SQL = `SELECT model, vector_dims(embedding) AS dim
  FROM public.v_research_embedding
 GROUP BY model, vector_dims(embedding)
 ORDER BY model COLLATE "C", 2
 LIMIT $1`
// Whole-corpus N for the IDF (R19, R28: read in this snapshot, never cached).
const COUNT_SQL = `SELECT count(*)::int AS n FROM public.v_research_judgment`
const PENDING_SQL = `SELECT judgment_id::text AS id FROM public.v_research_pending LIMIT $1`
// Visible judgments by id, with their visible citations in byte order (C collation), one row per judgment.
const DOCUMENTS_SQL = `SELECT j.judgment_id::text AS id, j.case_title AS title, j.bench_type,
       coalesce(array_agg(c.citation_text ORDER BY c.citation_text COLLATE "C") FILTER (WHERE c.citation_text IS NOT NULL),
                '{}'::text[]) AS citations
  FROM public.v_research_judgment j
  LEFT JOIN (SELECT judgment_id, citation_text FROM public.v_authority_citation WHERE judgment_id = ANY ($1::uuid[])) c
    ON c.judgment_id = j.judgment_id
 WHERE j.judgment_id = ANY ($1::uuid[])
 GROUP BY j.judgment_id, j.case_title, j.bench_type`
const VECTORS_SQL = `SELECT judgment_id::text AS id, embedding::text AS v
  FROM public.v_research_embedding
 WHERE model = $1 AND judgment_id = ANY ($2::uuid[])`
// Each indexed judgment holding a query term, but those excluded ($2: pending, cited), as its signature: the 1-based
// positions of the query terms it holds, ascending, joined by commas.
const signatureCte = (size: string) => `m AS (
  SELECT t.judgment_id,
         array_to_string(array_agg(DISTINCT array_position($1::text[], t.term) ORDER BY array_position($1::text[], t.term)), ',') AS sig${size}
    FROM public.v_research_term t
   WHERE t.term = ANY ($1::text[]) AND NOT (t.judgment_id = ANY ($2::uuid[]))
   GROUP BY t.judgment_id)`
const SIGNATURE_CTE = signatureCte("")
// With each judgment's size (every term row of a judgment carries the same one).
const SIZED_SIGNATURE_CTE = signatureCte(",\n         max(t.size) AS size")
// In blend mode ($3), the judgments with a vector of the live model ($4): the semantic statement scores those.
const VECTOR_CTE = `v AS (SELECT DISTINCT e.judgment_id FROM public.v_research_embedding e WHERE $3::boolean AND e.model = $4)`
// The signature groups (R24b): each signature, with or without a vector, its member count (the document frequencies are
// the sums) and, for a group without a vector, its first $6 (k) members by size, then id, the ranking's tie-break
// (v_research_term carries each judgment's size). A group holding every number of a cited key ($7: each key's term
// positions) lists all its members, up to $8 (the R4a bound + 1), with or without a vector: they are the R4a
// candidates. A member without a size (the index broke its contract) sorts first, so it is seen. No other member is read.
const GROUPS_SQL = `WITH ${SIZED_SIGNATURE_CTE}, ${VECTOR_CTE},
g AS (
  SELECT m.sig, (v.judgment_id IS NOT NULL) AS vec, count(*)::int AS n,
         array_agg(m.judgment_id ORDER BY m.size NULLS FIRST, m.judgment_id) AS ids,
         array_agg(m.size ORDER BY m.size NULLS FIRST, m.judgment_id) AS sizes
    FROM m LEFT JOIN v ON v.judgment_id = m.judgment_id
   GROUP BY 1, 2
   LIMIT $5)
SELECT g.sig, g.vec, g.n,
       (CASE WHEN h.holds THEN g.ids[1:$8] WHEN NOT g.vec THEN g.ids[1:$6] END)::text[] AS ids,
       CASE WHEN h.holds THEN g.sizes[1:$8] WHEN NOT g.vec THEN g.sizes[1:$6] END AS sizes
  FROM g CROSS JOIN LATERAL (
    SELECT EXISTS (SELECT 1 FROM unnest($7::text[]) AS c(key)
                    WHERE string_to_array(g.sig, ',')::int[] @> string_to_array(c.key, ',')::int[]) AS holds) h`
// R4a candidates of a cited key with a number that is not a query term (a one-digit page, say): indexed, non-pending
// judgments holding every number of the key.
const CITED_SQL = `SELECT judgment_id::text AS id FROM public.v_research_term
 WHERE term = ANY ($1::text[]) AND NOT (judgment_id = ANY ($2::uuid[]))
 GROUP BY judgment_id HAVING count(DISTINCT term) = $3
 LIMIT $4`
// Vector candidates (R25). Every visible vector's cosine, scanned (MATERIALIZED: the HNSW index never orders it, so no
// vector is skipped), each with its keyword score; the k-th best lower bound over them and the exact scores of the
// keyword-only candidates ($10); and the vectors whose upper bound reaches it. A stored zero vector (NaN) is cosine 0.
const SEMANTIC_SQL = `WITH ${SIGNATURE_CTE},
d AS MATERIALIZED (
  SELECT e.judgment_id, e.embedding <=> $3::vector AS dist
    FROM public.v_research_embedding e
   WHERE e.model = $4 AND NOT (e.judgment_id = ANY ($2::uuid[]))),
w AS (SELECT sig, kw FROM unnest($5::text[], $6::float8[]) AS w(sig, kw)),
b AS (
  SELECT d.judgment_id, CASE WHEN d.dist = 'NaN'::float8 THEN 0::float8 ELSE 1::float8 - d.dist END AS cos,
         coalesce(w.kw, 0::float8) AS kw, m.sig
    FROM d LEFT JOIN m ON m.judgment_id = d.judgment_id LEFT JOIN w ON w.sig = m.sig),
lb AS (
  SELECT $7::float8 * greatest(0::float8, b.cos - $8::float8) + $9::float8 * b.kw AS l FROM b
  UNION ALL SELECT x FROM unnest($10::float8[]) AS x),
t AS (SELECT coalesce((SELECT l FROM lb ORDER BY l DESC OFFSET $11::int - 1 LIMIT 1), 0::float8) AS tlow)
SELECT b.judgment_id::text AS id, b.sig
  FROM b, t
 WHERE $7::float8 * least(1::float8, greatest(0::float8, b.cos + $8::float8)) + $9::float8 * b.kw
       >= greatest(t.tlow - $12::float8, $13::float8)
 LIMIT $14`
// Module 33 facts of the top k only (R26): their overrulings, and whether an overruling of them is pending or hidden.
const OVERRULINGS_SQL = `SELECT treated_judgment_id::text AS treated, treating_bench_type AS recorded, treating_judgment_bench AS treating
  FROM public.v_authority_treatment
 WHERE treatment = 'overruled' AND treated_judgment_id = ANY ($1::uuid[])`
const PENDING_ADVERSE_SQL = `SELECT treated_judgment_id::text AS treated
  FROM public.v_authority_pending_adverse WHERE treated_judgment_id = ANY ($1::uuid[])`

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
  maxPending?: number
  maxCited?: number
  maxGroups?: number
  maxSemantic?: number
  statementTimeoutMs?: number
  /** Replaces the session's startup options; only for a test that proves a session which is not read-only is refused. */
  sessionOptions?: string
}

/** A signature group: the query terms its members hold, whether they have a vector (blend mode), how many they are,
 * and (without a vector) its first k members by (size, id). */
type Group = { sig: string; positions: ReadonlySet<number>; vec: boolean; n: number; first: Array<{ id: string; size: number }> }

const bySizeThenId = (a: { id: string; size: number }, b: { id: string; size: number }) => a.size - b.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** A signature string ("1,3": the 1-based positions of the query terms held) as a set of 0-based term indexes. */
function positionsOf(sig: string): Set<number> {
  const out = new Set<number>()
  if (sig === "") return out
  for (const p of sig.split(",")) out.add(Number(p) - 1)
  return out
}

/** The signature of a loaded judgment, computed here from its own terms: the index's claim for it must equal this. */
function signatureOf(doc: ResearchDocument, terms: readonly string[]): string {
  const own = researchDocumentTerms(doc)
  const out: number[] = []
  terms.forEach((term, i) => {
    if (own.has(term)) out.push(i + 1)
  })
  return out.join(",")
}

export class PgResearchCorpus implements ResearchSource {
  private readonly pool: pg.Pool
  private readonly maxStalenessMs: number
  private readonly maxPending: number
  private readonly maxCited: number
  private readonly maxGroups: number
  private readonly maxSemantic: number

  constructor(config: CorpusReaderConfig, opts: PgResearchOptions = {}) {
    this.maxStalenessMs = config.maxStalenessHours * 3600_000
    this.maxPending = opts.maxPending ?? RESEARCH_MAX_PENDING
    this.maxCited = opts.maxCited ?? RESEARCH_MAX_CITED
    this.maxGroups = opts.maxGroups ?? RESEARCH_MAX_GROUPS
    this.maxSemantic = opts.maxSemantic ?? RESEARCH_MAX_SEMANTIC
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
      // Read-only by default (R11). No JIT: a search is a handful of short statements, and compiling one costs more than
      // running it (measured: ~170 ms of JIT on a 60 ms statement at 25,000 judgments).
      options: opts.sessionOptions ?? "-c default_transaction_read_only=on -c jit=off",
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
      const request = plan(meta)
      const storedVectors = await this.lockShapes(client)
      // R30: a corpus caught mid-migration is the corpus's state, not the caller's error.
      if (researchLockProblem({ ...meta, storedVectors }) !== null) throw unavailable("inconsistent")
      const query = request.query
      if (query === undefined) {
        // Nothing to rank (a caller that only checks the snapshot): the checks above are the whole load.
        await this.run(client, "COMMIT", [])
        committed = true
        return { ...meta, documents: [], stats: { documents: 0, df: new Map() }, storedVectors, vectors: request.vectors ? new Map() : null, verdicts: () => new Map() }
      }
      const corpus = await this.candidates(client, meta, storedVectors, query, request.unit ?? null)
      // Rank inside the snapshot, then read the top k's treatments in the same transaction (R26).
      const ranked = rankResearchCorpus(corpus, query, request.unit ?? null)
      const topIds = ranked.top.map((h) => h.doc.id)
      const verdicts = await this.verdictsOf(client, topIds, new Map(corpus.documents.map((d) => [d.id, d.benchType])))
      await this.run(client, "COMMIT", [])
      committed = true
      return {
        ...corpus,
        verdicts(ids) {
          const out = new Map<string, CitationVerdict>()
          for (const id of ids) {
            const v = verdicts.get(id)
            if (v === undefined) throw new Error("research: a verdict was asked for a judgment outside the snapshot's top k")
            out.set(id, v)
          }
          return out
        },
      }
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

  /** At most `bound` rows (read as LIMIT bound + 1); over it, `reason` (R27). */
  private async rowsUnder<R>(client: pg.PoolClient, sql: string, params: unknown[], bound: number, reason: CorpusUnavailableReason = "row_cap"): Promise<R[]> {
    const rows = (await this.run(client, sql, params)).rows as R[]
    if (rows.length > bound) throw unavailable(reason)
    return rows
  }

  private async checkRole(client: pg.PoolClient): Promise<void> {
    const role = (await this.run(client, ROLE_SQL, [RESEARCH_READABLE])).rows[0] as
      | { reader: unknown; elevated: unknown; other_role: unknown; admin: unknown; writes: unknown; reads_more: unknown; session_read_only: unknown; read_only: unknown }
      | undefined
    if (
      !role ||
      role.reader !== true ||
      role.elevated !== false ||
      role.other_role !== false ||
      role.admin !== false ||
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
    const refreshed = parseResearchLastRefresh(meta.last_refresh)
    if (refreshed === null) throw unavailable("contract_missing")
    const wall = Date.now()
    if (refreshed - wall > FUTURE_SKEW_MS || wall - refreshed > this.maxStalenessMs) throw unavailable("stale")
    if (typeof meta.embedding_model !== "string" || typeof meta.embedding_dim !== "string") throw unavailable("contract_missing")
    return { embeddingModel: meta.embedding_model, embeddingDim: meta.embedding_dim }
  }

  /** The (model, dimension) pairs of the readable vectors (R29). */
  private async lockShapes(client: pg.PoolClient): Promise<Array<{ model: string; dim: number }>> {
    const declared = (await this.run(client, DECLARED_DIM_SQL, [])).rows[0] as { dim: unknown } | undefined
    if (declared === undefined || typeof declared.dim !== "number") throw unavailable("inconsistent")
    if (declared.dim <= 0) {
      const rows = (await this.run(client, VECTOR_SHAPES_SQL, [MAX_MODELS + 1])).rows as Array<{ model: unknown; dim: unknown }>
      if (rows.length > MAX_MODELS) throw unavailable("inconsistent")
      return rows.map((r) => {
        if (typeof r.model !== "string" || typeof r.dim !== "number") throw unavailable("inconsistent")
        return { model: r.model, dim: r.dim }
      })
    }
    const rows = (await this.run(client, MODELS_SQL, [MAX_MODELS + 1])).rows as Array<{ model: unknown }>
    if (rows.length > MAX_MODELS) throw unavailable("inconsistent")
    return rows.map((r) => {
      if (typeof r.model !== "string") throw unavailable("inconsistent")
      return { model: r.model, dim: declared.dim as number }
    })
  }

  /** Loads the visible judgments `ids` (not yet in `into`) into `into`. */
  private async loadDocuments(client: pg.PoolClient, ids: readonly string[], into: Map<string, ResearchDocument>): Promise<void> {
    const wanted = [...new Set(ids)].filter((id) => !into.has(id))
    if (wanted.length === 0) return
    const rows = (await this.run(client, DOCUMENTS_SQL, [wanted])).rows as Array<{ id: unknown; title: unknown; bench_type: unknown; citations: unknown }>
    for (const r of rows) {
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
      into.set(r.id, { id: r.id, title: r.title ?? "", citations: r.citations as string[], benchType: r.bench_type })
    }
    // Every id came from a research view in this snapshot, so every one is visible: a missing row breaks the contract.
    if (wanted.some((id) => !into.has(id))) throw unavailable("inconsistent")
  }

  /** The candidate set (R19, R24, R25): every judgment that can reach the top k, and the whole corpus's statistics. */
  private async candidates(
    client: pg.PoolClient,
    meta: ResearchCorpusMeta,
    storedVectors: Array<{ model: string; dim: number }>,
    query: PreparedResearchQuery,
    unit: readonly number[] | null
  ): Promise<ResearchCorpus & { verdicts: () => Map<string, CitationVerdict> }> {
    const k = query.k
    const terms = query.text?.terms ?? []
    const citations = query.text?.citations ?? []
    const mode = researchMode(query.text !== null, unit !== null)
    const blend = mode === "blended"
    const docs = new Map<string, ResearchDocument>()

    const n = Number((await this.run(client, COUNT_SQL, [])).rows[0]?.n)
    if (!Number.isSafeInteger(n) || n < 0) throw unavailable("inconsistent")

    // (a) The visible judgments the index has not caught up with: loaded whole, folded here (R24a).
    const pending = (await this.rowsUnder<{ id: unknown }>(client, PENDING_SQL, [this.maxPending + 1], this.maxPending, "unindexed")).map((r) => {
      if (typeof r.id !== "string" || !UUID.test(r.id)) throw unavailable("inconsistent")
      return r.id
    })
    await this.loadDocuments(client, pending, docs)

    // (b) R4a (R24c): the indexed judgments holding every number of a cited key are loaded and checked by the citation
    // parser. A key whose numbers are all query terms is answered by the signature groups below (a group holding all its
    // numbers lists every member); any other key is asked of the index here, and its cited judgments are scored here
    // like the pending ones, so the groups leave them out.
    const termIndex = new Map(terms.map((t, i) => [t, i]))
    const keys: string[] = []
    const r4a = new Set<string>()
    for (const c of citations) {
      const numbers = [...new Set(c.numbers)]
      // A cited key always has a year and a page; without a number every judgment would be a candidate.
      if (numbers.length === 0) throw unavailable("row_cap")
      const at = numbers.map((num) => termIndex.get(num))
      if (at.every((p) => p !== undefined)) {
        keys.push([...new Set(at as number[])].sort((a, b) => a - b).map((p) => p + 1).join(","))
        continue
      }
      for (const r of await this.rowsUnder<{ id: unknown }>(client, CITED_SQL, [numbers, pending, numbers.length, this.maxCited + 1], this.maxCited)) {
        if (typeof r.id !== "string" || !UUID.test(r.id)) throw unavailable("inconsistent")
        r4a.add(r.id)
      }
      if (r4a.size > this.maxCited) throw unavailable("row_cap")
    }
    const holdsACitedKey = (doc: ResearchDocument) => {
      const own = researchDocumentTerms(doc)
      return citations.some((c) => c.numbers.every((num) => own.has(num)))
    }
    await this.loadDocuments(client, [...r4a], docs)
    for (const id of r4a) if (!holdsACitedKey(docs.get(id) as ResearchDocument)) throw unavailable("inconsistent")
    const cited = new Set<string>()
    if (citations.length > 0) {
      for (const doc of docs.values()) if (researchCitedCitation(doc, citations) !== null) cited.add(doc.id)
    }
    // Scored here, not from the groups: their own terms count toward the document frequencies.
    const outside = [...new Set([...pending, ...cited])]

    // (c) The signature groups of every other judgment holding a query term (R24b): counted, and their first k members
    // listed (all members, for a group holding a cited key's numbers). The document frequencies are the counts' sums plus
    // the outside judgments' own terms.
    const df = new Map<string, number>(terms.map((t) => [t, 0]))
    for (const id of outside) {
      const own = researchDocumentTerms(docs.get(id) as ResearchDocument)
      for (const t of terms) if (own.has(t)) df.set(t, (df.get(t) ?? 0) + 1)
    }
    const keySets = keys.map((key) => key.split(",").map((p) => Number(p) - 1))
    const groups: Group[] = []
    const candidates = new Set<string>()
    if (terms.length > 0) {
      const rows = await this.rowsUnder<{ sig: unknown; vec: unknown; n: unknown; ids: unknown; sizes: unknown }>(
        client,
        GROUPS_SQL,
        [terms, outside, blend, meta.embeddingModel, this.maxGroups + 1, k, keys, this.maxCited + 1],
        this.maxGroups
      )
      for (const r of rows) {
        if (typeof r.sig !== "string" || typeof r.vec !== "boolean" || typeof r.n !== "number" || !Number.isSafeInteger(r.n) || r.n <= 0) throw unavailable("inconsistent")
        const positions = positionsOf(r.sig)
        if (positions.size === 0 || [...positions].some((p) => !(Number.isInteger(p) && p >= 0 && p < terms.length))) throw unavailable("inconsistent")
        const holdsKey = keySets.some((key) => key.every((p) => positions.has(p)))
        const listed = holdsKey ? Math.min(r.n, this.maxCited + 1) : r.vec ? 0 : Math.min(r.n, k)
        const first: Array<{ id: string; size: number }> = []
        if (listed > 0) {
          const ids = r.ids
          const sizes = r.sizes
          if (!Array.isArray(ids) || !Array.isArray(sizes) || ids.length !== listed || sizes.length !== listed) throw unavailable("inconsistent")
          ids.forEach((id, i) => {
            const size = sizes[i] as unknown
            if (typeof id !== "string" || !UUID.test(id) || typeof size !== "number" || !Number.isSafeInteger(size)) throw unavailable("inconsistent")
            first.push({ id, size })
            if (holdsKey) candidates.add(id)
          })
        } else if (r.ids !== null || r.sizes !== null) {
          throw unavailable("inconsistent")
        }
        groups.push({ sig: r.sig, positions, vec: r.vec, n: r.n, first: r.vec ? [] : first })
        for (const p of positions) df.set(terms[p], (df.get(terms[p]) ?? 0) + r.n)
      }
    }
    if (r4a.size + candidates.size > this.maxCited) throw unavailable("row_cap")
    // The R4a candidates the groups listed: loaded and checked; the cited ones are taken out of their groups (R4a ranks
    // them), the others stay in theirs.
    await this.loadDocuments(client, [...candidates], docs)
    for (const id of candidates) {
      const doc = docs.get(id) as ResearchDocument
      if (!holdsACitedKey(doc)) throw unavailable("inconsistent")
      if (researchCitedCitation(doc, citations) !== null) cited.add(id)
    }
    const excluded = [...new Set([...pending, ...cited])]
    const idf = researchIdf(terms, n, (t) => df.get(t) ?? 0)
    const keywordOf = (positions: ReadonlySet<number>) => researchKeywordScore(idf, (t) => positions.has(t))

    // (d) The k slots (R24d): the keyword judgments (without a vector, in blend mode) by score, group by group. Every
    // member of a group scores the same, so whole groups fill the slots until one overflows; the members of the
    // overflowing score (one or more groups) are taken in tie-break order (fewer distinct terms, then id) from the
    // groups' first-k lists, which hold every member that can be taken.
    const byScore = new Map<number, Group[]>()
    for (const g of groups) {
      if (blend && g.vec) continue
      const score = researchRoundScore(researchRawScore(mode, false, 0, keywordOf(g.positions)))
      if (score <= 0) continue
      byScore.set(score, [...(byScore.get(score) ?? []), g])
    }
    const chosen: Array<{ id: string; size: number; sig: string; positions: ReadonlySet<number> }> = []
    for (const score of [...byScore.keys()].sort((a, b) => b - a)) {
      const room = k - chosen.length
      if (room <= 0) break
      const tied = byScore.get(score) as Group[]
      const members = tied.flatMap((g) => g.first.filter((m) => !cited.has(m.id)).map((m) => ({ ...m, sig: g.sig, positions: g.positions })))
      members.sort(bySizeThenId)
      chosen.push(...members.slice(0, room))
    }
    const exactRaw: number[] = []
    await this.loadDocuments(client, chosen.map((c) => c.id), docs)
    for (const c of chosen) {
      const doc = docs.get(c.id) as ResearchDocument
      // (e) The index's claim for this judgment must be what its own terms say (R24e).
      if (signatureOf(doc, terms) !== c.sig || researchDocumentTerms(doc).size !== c.size) throw unavailable("inconsistent")
      exactRaw.push(researchRawScore(mode, false, 0, keywordOf(c.positions)))
    }

    // (f) Vector candidates (R25): every vector judgment whose upper bound reaches the k-th best lower bound.
    if (unit !== null) {
      const sigs = [...new Set(groups.map((g) => g.sig))]
      const rows = await this.rowsUnder<{ id: unknown; sig: unknown }>(
        client,
        SEMANTIC_SQL,
        [
          terms,
          excluded,
          `[${unit.join(",")}]`,
          meta.embeddingModel,
          sigs,
          sigs.map((sig) => keywordOf(positionsOf(sig))),
          blend ? SEMANTIC_WEIGHT : 1,
          SEMANTIC_EPSILON,
          blend ? KEYWORD_WEIGHT : 0,
          exactRaw,
          k,
          SCORE_SLACK,
          HIT_FLOOR,
          this.maxSemantic + 1,
        ],
        this.maxSemantic
      )
      const claimed = rows.map((r) => {
        if (typeof r.id !== "string" || !UUID.test(r.id) || (r.sig !== null && typeof r.sig !== "string")) throw unavailable("inconsistent")
        return { id: r.id, sig: (r.sig as string | null) ?? "" }
      })
      await this.loadDocuments(client, claimed.map((c) => c.id), docs)
      for (const c of claimed) if (signatureOf(docs.get(c.id) as ResearchDocument, terms) !== c.sig) throw unavailable("inconsistent")
    }

    // Every candidate's vector, when the query has one: a candidate without its vector would score its semantic leg 0.
    let vectors: Map<string, readonly number[]> | null = null
    if (unit !== null) {
      vectors = new Map()
      const ids = [...docs.keys()]
      if (ids.length > 0) {
        for (const r of (await this.run(client, VECTORS_SQL, [meta.embeddingModel, ids])).rows as Array<{ id: unknown; v: unknown }>) {
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
          vectors.set(r.id, vector as number[])
        }
      }
    }

    return {
      ...meta,
      // In id order, so a load is deterministic (the ranking does not depend on it).
      documents: [...docs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      stats: { documents: n, df },
      storedVectors,
      vectors,
      verdicts: () => new Map<string, CitationVerdict>(),
    }
  }

  /** The Module 33 verdicts of the top k, read in this snapshot (R26). */
  private async verdictsOf(client: pg.PoolClient, ids: readonly string[], benchById: ReadonlyMap<string, Bench>): Promise<ReadonlyMap<string, CitationVerdict>> {
    if (ids.length === 0) return new Map()
    const overrulings: Array<{ treatedId: string; recordedBench: Bench; treatingBench: Bench }> = []
    for (const r of (await this.run(client, OVERRULINGS_SQL, [ids])).rows as Array<{ treated: unknown; recorded: unknown; treating: unknown }>) {
      if (typeof r.treated !== "string" || !isBench(r.recorded) || !isBench(r.treating)) throw unavailable("inconsistent")
      overrulings.push({ treatedId: r.treated, recordedBench: r.recorded, treatingBench: r.treating })
    }
    const pending = new Set<string>()
    for (const r of (await this.run(client, PENDING_ADVERSE_SQL, [ids])).rows as Array<{ treated: unknown }>) {
      if (typeof r.treated !== "string") throw unavailable("inconsistent")
      pending.add(r.treated)
    }
    return researchVerdicts(benchById, overrulings, pending)(ids)
  }
}
