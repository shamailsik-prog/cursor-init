/**
 * The corpus adapter for the draft gate (audit F05; spec §6, PR 3): an AuthorityStore over the firm's promoted Annex A
 * corpus on Postgres. It reads only 004's views (v_authority_citation, v_authority_treatment,
 * v_authority_section_version, v_authority_pending_adverse) and corpus_metadata, as a corpus_reader member (ruling 13),
 * through a small pool. Calls carry only a canonical citation, a judgment id or a section key (L19.11 #3).
 *
 * It fails closed. Anything it cannot answer throws AuthorityUnavailableError, which the gate reads as UNVERIFIED /
 * TEMPORAL_UNAVAILABLE, never OK:
 * - a driver error;
 * - data that breaks the contract (D5).
 * An overruling still pending review, or hidden by the visibility rules (ruling 3, D2), is not a failure: it is
 * reported as PENDING_OVERRULING, an overruling of unknown bench (#51 R1 D-1).
 * Questions it can refuse without the database (a non-canonical citation, a non-UUID section, an unmapped
 * jurisdiction, a malformed date; D18) answer "not found" / "no_history" directly.
 *
 * Every failure except one about the data opens a breaker for BREAKER_OPEN_MS (D9), so a gate over many citations
 * costs one connect timeout, and logs `d4.authority_unavailable {reason}` once per opening (D16), with no driver text.
 *
 * Dates travel as text (D10): DATE columns are selected as `::text` and compared as YYYY-MM-DD strings, so the process
 * time zone cannot shift a statute's effective date.
 */
import { logger } from "firebase-functions"
import pg from "pg"
import { normaliseCitation } from "@/services/d4-2/citations"
import type { Bench, TreatmentFact } from "@/services/d4-2/citationVerdict"
import type { AuthorityStore } from "./authority"
import { AuthorityUnavailableError, type AuthorityUnavailableReason } from "./authorityErrors"
import { PENDING_OVERRULING } from "./authorityPending"
import type { CorpusReaderConfig } from "./corpusReaderConfig"

/** A section version is usable only above this confidence (ruling 4: strictly greater than 0.5). */
export const MIN_VERSION_CONFIDENCE = 0.5
/** Pool and timing (D9). */
export const POOL_MAX = 3
export const CONNECT_TIMEOUT_MS = 3000
export const STATEMENT_TIMEOUT_MS = 5000
export const IDLE_TIMEOUT_MS = 10000
export const STATE_TTL_MS = 30000
export const BREAKER_OPEN_MS = 30000
/** A last_refresh this far in the future is not trusted (D19). */
export const FUTURE_SKEW_MS = 5 * 60 * 1000
/** The publication contract this reader understands (corpus_metadata.publication_contract, F19 D30). */
export const PUBLICATION_CONTRACT = "1"
export const APPLICATION_NAME = "sikander-d4-authority"

const ANNEX_A_JURISDICTIONS = ["Federal", "Sindh", "Punjab", "KP", "Balochistan", "ICT", "GB", "AJK"] as const
export type AnnexJurisdiction = (typeof ANNEX_A_JURISDICTIONS)[number]
const BENCHES: ReadonlySet<string> = new Set<Bench>(["single", "division", "full", "larger"])
const TREATMENT_KINDS: ReadonlySet<string> = new Set(["followed", "applied", "distinguished", "doubted", "overruled", "per_incuriam", "referred"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const unavailable = (reason: AuthorityUnavailableReason) => new AuthorityUnavailableError(reason)
const isBench = (value: unknown): value is Bench => typeof value === "string" && BENCHES.has(value)

/**
 * The Annex A jurisdiction for an R11 gate code: the value whose upper-case form equals the code, and nothing else
 * (D3). PK, SD, KPK, ISLAMABAD, or a mixed-case "Federal", map to nothing (ruling 6).
 */
export function annexJurisdiction(code: string): AnnexJurisdiction | null {
  return ANNEX_A_JURISDICTIONS.find((j) => j.toUpperCase() === code) ?? null
}

/** Ruling 4, NaN-safe (D4): a finite confidence above 0.5 and at most 1. */
export function versionUsable(confidence: number | null): boolean {
  return typeof confidence === "number" && confidence > MIN_VERSION_CONFIDENCE && confidence <= 1
}

export type SectionVersionRow = { versionNo: number; effectiveFrom: string; effectiveTo: string | null; text: string; versionConfidence: number | null }

/**
 * The one version in force on `asAtDate` (effectiveFrom <= date < effectiveTo, an open range running on), or null.
 * `rows` come ordered by effectiveFrom, then versionNo. A history that breaks the contract (a reversed or empty range,
 * an overlap, an open range that is not last, version numbers out of order, a malformed date) throws `inconsistent`
 * (D5): the gate must not pick a text from it.
 */
export function coveringVersion(rows: readonly SectionVersionRow[], asAtDate: string): SectionVersionRow | null {
  for (const [i, row] of rows.entries()) {
    if (!ISO_DATE.test(row.effectiveFrom) || (row.effectiveTo !== null && !ISO_DATE.test(row.effectiveTo))) throw unavailable("inconsistent")
    if (row.effectiveTo !== null && row.effectiveTo <= row.effectiveFrom) throw unavailable("inconsistent")
    const next = rows[i + 1]
    if (next) {
      if (row.effectiveTo === null || row.effectiveTo > next.effectiveFrom) throw unavailable("inconsistent")
      if (next.versionNo <= row.versionNo) throw unavailable("inconsistent")
    }
  }
  const covering = rows.filter((r) => r.effectiveFrom <= asAtDate && (r.effectiveTo === null || asAtDate < r.effectiveTo))
  if (covering.length > 1) throw unavailable("inconsistent")
  return covering[0] ?? null
}

const CITATION_SQL = "SELECT judgment_id::text AS id, bench_type FROM public.v_authority_citation WHERE citation_text = $1"
// One statement, so the pending check and the treatments come from one snapshot (D11).
const TREATMENTS_SQL = `SELECT 'pending' AS k, NULL::text AS kind, NULL::text AS recorded, NULL::text AS treating
  FROM public.v_authority_pending_adverse WHERE treated_judgment_id = $1::uuid
UNION ALL
SELECT 'treatment', treatment, treating_bench_type, treating_judgment_bench
  FROM public.v_authority_treatment WHERE treated_judgment_id = $1::uuid`
const SECTIONS_SQL = `SELECT version_no, effective_from::text AS effective_from, effective_to::text AS effective_to, text, version_confidence
  FROM public.v_authority_section_version WHERE section_id = $1::uuid AND jurisdiction = $2
 ORDER BY effective_from, version_no`
// The session first (D7): a role check reads no table, so a writer or superuser login is wrong_role, not a permission
// error on corpus_metadata. Then the corpus metadata the reader needs (F19 D30, D19).
const ROLE_SQL = `SELECT pg_has_role('corpus_reader', 'USAGE') AS reader,
       coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), true) AS superuser,
       pg_has_role('corpus_writer', 'MEMBER') OR pg_has_role('corpus_declassify', 'MEMBER') AS writer,
       current_setting('transaction_read_only') AS read_only`
const METADATA_SQL = `SELECT (SELECT value FROM public.corpus_metadata WHERE key = 'publication_contract') AS contract,
       (SELECT value FROM public.corpus_metadata WHERE key = 'last_refresh') AS last_refresh`
const LAST_REFRESH = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/

/** corpus_metadata.last_refresh (D30: YYYY-MM-DDTHH:MI:SS.ffffffZ, UTC) in epoch ms, or null if it is not exactly that. */
export function parseLastRefresh(value: unknown): number | null {
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

const SQLSTATE_REASONS: Readonly<Record<string, AuthorityUnavailableReason>> = {
  "42501": "permission",
  "28P01": "auth",
  "28000": "auth",
  "57014": "timeout",
  "42P01": "schema_missing",
  "42703": "schema_missing",
  "3D000": "schema_missing",
  "57P01": "unreachable",
  "57P02": "unreachable",
  "57P03": "unreachable",
}
const NODE_REASONS: Readonly<Record<string, AuthorityUnavailableReason>> = {
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
const TIMEOUT_MESSAGES = /^(timeout expired|timeout exceeded when trying to connect|Connection terminated due to connection timeout|Query read timeout)$/
const TLS_MESSAGES = /^The server does not support SSL connections$/

/**
 * The reason for a driver error (D6), from its SQLSTATE or Node code, or from node-pg's own timeout and TLS messages.
 * Total: anything else is "error". Only the reason ever leaves the adapter, never the error itself.
 */
export function classifyPgError(err: unknown): AuthorityUnavailableReason {
  if (err instanceof AuthorityUnavailableError) return err.reason
  if (err === null || typeof err !== "object") return "error"
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (typeof code === "string") {
    if (SQLSTATE_REASONS[code]) return SQLSTATE_REASONS[code]
    if (/^08[0-9A-Z]{3}$/.test(code)) return "unreachable"
    if (NODE_REASONS[code]) return NODE_REASONS[code]
    if (TLS_CODES.test(code)) return "tls"
  }
  if (typeof message === "string") {
    if (TIMEOUT_MESSAGES.test(message)) return "timeout"
    if (TLS_MESSAGES.test(message)) return "tls"
  }
  return "error"
}

/** Reasons that describe the data, not the connection: they do not open the breaker. */
const DATA_REASONS: ReadonlySet<AuthorityUnavailableReason> = new Set(["pending_review", "inconsistent", "circuit_open"])

export class PgAuthorityStore implements AuthorityStore {
  private readonly pool: pg.Pool
  private readonly now: () => number
  private readonly maxStalenessMs: number
  private stateCheckedAt: number | null = null
  private openUntil = 0

  /**
   * `deps.now` is the clock (tests move it). `deps.sessionOptions` replaces the session's startup options; it exists
   * only so a test can prove that a session which is not read-only is refused (D7). Selection never passes it.
   */
  constructor(config: CorpusReaderConfig, deps: { now?: () => number; sessionOptions?: string } = {}) {
    this.now = deps.now ?? Date.now
    this.maxStalenessMs = config.maxStalenessHours * 3600_000
    // Field by field (D8): nothing from the URL beyond these reaches the driver.
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
      options: deps.sessionOptions ?? "-c default_transaction_read_only=on",
      statement_timeout: STATEMENT_TIMEOUT_MS,
      query_timeout: STATEMENT_TIMEOUT_MS + 1000,
    })
    // An idle client's error (the server went away) must not crash the process; the next query reports it.
    this.pool.on("error", () => undefined)
  }

  async end(): Promise<void> {
    await this.pool.end()
  }

  async findJudgment(canonical: string): Promise<{ judgmentId: string; benchType: Bench } | null> {
    // D18: the lookup is exact equality on the canonical key, so a non-canonical input can only miss.
    if (normaliseCitation(canonical) !== canonical) return null
    return this.guarded(async () => {
      const rows = await this.query<{ id: string; bench_type: unknown }>(CITATION_SQL, [canonical])
      if (rows.length === 0) return null
      if (rows.length > 1 || !isBench(rows[0].bench_type)) throw unavailable("inconsistent")
      return { judgmentId: rows[0].id, benchType: rows[0].bench_type }
    })
  }

  async listTreatments(judgmentId: string): Promise<TreatmentFact[]> {
    return this.guarded(async () => {
      // Only an id this store returned can be asked about; anything else breaks the contract (D5).
      if (!UUID.test(judgmentId)) throw unavailable("inconsistent")
      const rows = await this.query<{ k: string; kind: unknown; recorded: unknown; treating: unknown }>(TREATMENTS_SQL, [judgmentId])
      const facts: TreatmentFact[] = rows
        .filter((r) => r.k !== "pending")
        .map((r) => {
          if (typeof r.kind !== "string" || !TREATMENT_KINDS.has(r.kind) || !isBench(r.recorded) || !isBench(r.treating)) {
            throw unavailable("inconsistent")
          }
          return { kind: r.kind, treatingJudgmentBench: r.treating, recordedTreatingBench: r.recorded }
        })
      // An overruling the reader cannot show (ruling 3, D2) is reported, never hidden, and never hides another
      // (#51 R1 D-1, P4-2): with a qualifying overruling the verdict stays OVERRULED, without one it is UNVERIFIED.
      if (rows.some((r) => r.k === "pending")) facts.push({ ...PENDING_OVERRULING })
      return facts
    })
  }

  async getSectionAsAt(sectionId: string, asAtDate: string, jurisdiction: string): Promise<{ text: string } | "no_history"> {
    const annex = annexJurisdiction(jurisdiction)
    if (!UUID.test(sectionId) || !ISO_DATE.test(asAtDate) || annex === null) return "no_history"
    return this.guarded(async () => {
      const rows = await this.query<{ version_no: unknown; effective_from: unknown; effective_to: unknown; text: unknown; version_confidence: unknown }>(
        SECTIONS_SQL,
        [sectionId, annex]
      )
      const versions = rows.map((r): SectionVersionRow => {
        if (
          typeof r.version_no !== "number" ||
          typeof r.effective_from !== "string" ||
          (r.effective_to !== null && typeof r.effective_to !== "string") ||
          typeof r.text !== "string" ||
          (r.version_confidence !== null && typeof r.version_confidence !== "number")
        ) {
          throw unavailable("inconsistent")
        }
        return { versionNo: r.version_no, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, text: r.text, versionConfidence: r.version_confidence }
      })
      const hit = coveringVersion(versions, asAtDate)
      return hit && versionUsable(hit.versionConfidence) ? { text: hit.text } : "no_history"
    })
  }

  /**
   * The breaker (D9). While it is open every call throws circuit_open without connecting. Any other failure except
   * one about the data (pending_review, inconsistent) opens it for BREAKER_OPEN_MS and logs the reason once (D16).
   */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (this.now() < this.openUntil) throw unavailable("circuit_open")
    try {
      return await fn()
    } catch (e) {
      const error = e instanceof AuthorityUnavailableError ? e : unavailable(classifyPgError(e))
      if (!DATA_REASONS.has(error.reason)) {
        this.openUntil = this.now() + BREAKER_OPEN_MS
        this.stateCheckedAt = null
        logger.warn("d4.authority_unavailable", { reason: error.reason })
      }
      throw error
    }
  }

  /** One read, after the corpus state check; every driver error becomes AuthorityUnavailableError. */
  private async query<R>(sql: string, params: unknown[]): Promise<R[]> {
    await this.checkState()
    return (await this.run(sql, params)).rows as R[]
  }

  private async run(sql: string, params: unknown[]): Promise<pg.QueryResult> {
    try {
      return await this.pool.query(sql, params)
    } catch (e) {
      throw unavailable(classifyPgError(e))
    }
  }

  /**
   * The session and the corpus, cached for STATE_TTL_MS (D7, D19): a corpus_reader that is neither a superuser nor a
   * corpus_writer or corpus_declassify member, in a read-only session (wrong_role otherwise); publication contract
   * '1' and a well-formed last_refresh (contract_missing otherwise); and a last_refresh no older than the configured
   * staleness and at most FUTURE_SKEW_MS ahead (stale otherwise).
   */
  private async checkState(): Promise<void> {
    const at = this.now()
    if (this.stateCheckedAt !== null && at - this.stateCheckedAt < STATE_TTL_MS) return
    const role = (await this.run(ROLE_SQL, [])).rows[0] as { reader: unknown; superuser: unknown; writer: unknown; read_only: unknown } | undefined
    if (!role || role.reader !== true || role.superuser !== false || role.writer !== false || role.read_only !== "on") throw unavailable("wrong_role")
    const meta = (await this.run(METADATA_SQL, [])).rows[0] as { contract: unknown; last_refresh: unknown } | undefined
    if (meta?.contract !== PUBLICATION_CONTRACT) throw unavailable("contract_missing")
    const refreshed = parseLastRefresh(meta.last_refresh)
    if (refreshed === null) throw unavailable("contract_missing")
    const wall = Date.now()
    if (refreshed - wall > FUTURE_SKEW_MS || wall - refreshed > this.maxStalenessMs) throw unavailable("stale")
    this.stateCheckedAt = at
  }
}
