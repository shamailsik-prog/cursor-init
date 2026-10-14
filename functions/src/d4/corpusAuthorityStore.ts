/**
 * The corpus adapter for the draft gate (audit F05; spec §6, PR 3): an AuthorityStore over the firm's promoted Annex A
 * corpus on Postgres. It reads only 004's views (v_authority_citation, v_authority_treatment,
 * v_authority_section_version, v_authority_pending_adverse) and corpus_metadata, as a corpus_reader member (ruling 13),
 * through a small pool. Calls carry only a canonical citation, a judgment id or a section key (L19.11 #3).
 *
 * It fails closed. Anything it cannot answer throws AuthorityUnavailableError, which the gate reads as UNVERIFIED /
 * TEMPORAL_UNAVAILABLE, never OK:
 * - a driver error;
 * - data that breaks the contract (D5);
 * - an overruling still pending review (ruling 3, D2).
 * Questions it can refuse without the database (a non-canonical citation, a non-UUID section, an unmapped
 * jurisdiction, a malformed date; D18) answer "not found" / "no_history" directly.
 *
 * Dates travel as text (D10): DATE columns are selected as `::text` and compared as YYYY-MM-DD strings, so the process
 * time zone cannot shift a statute's effective date.
 */
import pg from "pg"
import { normaliseCitation } from "@/services/d4-2/citations"
import type { Bench, TreatmentFact } from "@/services/d4-2/citationVerdict"
import { AuthorityUnavailableError, type AuthorityStore, type AuthorityUnavailableReason } from "./authority"
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
const STATE_SQL = "SELECT (SELECT value FROM public.corpus_metadata WHERE key = 'publication_contract') AS contract"

export class PgAuthorityStore implements AuthorityStore {
  private readonly pool: pg.Pool
  private readonly now: () => number
  private stateCheckedAt: number | null = null

  constructor(config: CorpusReaderConfig, deps: { now?: () => number } = {}) {
    this.now = deps.now ?? Date.now
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
      options: "-c default_transaction_read_only=on",
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
    const rows = await this.query<{ id: string; bench_type: unknown }>(CITATION_SQL, [canonical])
    if (rows.length === 0) return null
    if (rows.length > 1 || !isBench(rows[0].bench_type)) throw unavailable("inconsistent")
    return { judgmentId: rows[0].id, benchType: rows[0].bench_type }
  }

  async listTreatments(judgmentId: string): Promise<TreatmentFact[]> {
    // Only an id this store returned can be asked about; anything else breaks the contract (D5).
    if (!UUID.test(judgmentId)) throw unavailable("inconsistent")
    const rows = await this.query<{ k: string; kind: unknown; recorded: unknown; treating: unknown }>(TREATMENTS_SQL, [judgmentId])
    if (rows.some((r) => r.k === "pending")) throw unavailable("pending_review")
    return rows.map((r) => {
      if (typeof r.kind !== "string" || !TREATMENT_KINDS.has(r.kind) || !isBench(r.recorded) || !isBench(r.treating)) {
        throw unavailable("inconsistent")
      }
      return { kind: r.kind, treatingJudgmentBench: r.treating, recordedTreatingBench: r.recorded }
    })
  }

  async getSectionAsAt(sectionId: string, asAtDate: string, jurisdiction: string): Promise<{ text: string } | "no_history"> {
    const annex = annexJurisdiction(jurisdiction)
    if (!UUID.test(sectionId) || !ISO_DATE.test(asAtDate) || annex === null) return "no_history"
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
  }

  /** One read, after the corpus state check; every driver error becomes AuthorityUnavailableError. */
  private async query<R>(sql: string, params: unknown[]): Promise<R[]> {
    await this.checkState()
    return (await this.run(sql, params)).rows as R[]
  }

  private async run(sql: string, params: unknown[]): Promise<pg.QueryResult> {
    try {
      return await this.pool.query(sql, params)
    } catch {
      throw unavailable("error")
    }
  }

  /** The corpus is one this reader understands: publication_contract '1'. Cached for STATE_TTL_MS. */
  private async checkState(): Promise<void> {
    const at = this.now()
    if (this.stateCheckedAt !== null && at - this.stateCheckedAt < STATE_TTL_MS) return
    const state = (await this.run(STATE_SQL, [])).rows[0] as { contract: unknown } | undefined
    if (state?.contract !== PUBLICATION_CONTRACT) throw unavailable("contract_missing")
    this.stateCheckedAt = at
  }
}
