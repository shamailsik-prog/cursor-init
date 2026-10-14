/**
 * The authority port (spec P4-3): what the gate needs to know about the corpus, and nothing else. Calls carry only
 * a canonical citation, a judgment id or a section key, never a matter id or party data (L19.11 #3).
 *
 * Which store the gate runs on (audit F05, plan Task 8): a test's store when one is set; otherwise the firm's promoted
 * Annex A corpus (PgAuthorityStore) when the environment configures a corpus reader (readCorpusReaderConfig, D8);
 * otherwise EMPTY_AUTHORITY_STORE: no judgment, no history, so every citation is UNVERIFIED and every temporal check
 * UNAVAILABLE, and the partner override carries the load. An adapter that cannot answer throws
 * AuthorityUnavailableError, which the gate reads the same way.
 */
import { logger } from "firebase-functions"
import { normaliseCitation } from "@/services/d4-2/citations"
import type { Bench, TreatmentFact } from "@/services/d4-2/citationVerdict"
import { PgAuthorityStore } from "./corpusAuthorityStore"
import { readCorpusReaderConfig } from "./corpusReaderConfig"

export { AUTHORITY_UNAVAILABLE_REASONS, AuthorityUnavailableError, type AuthorityUnavailableReason } from "./authorityErrors"

/**
 * The port's contract, which every adapter (the O-59 corpus connector included) must meet; the O-59 parity test asserts
 * it against the adapter's real rows:
 * - a bench (`benchType`, `treatingJudgmentBench`, `recordedTreatingBench`) is one of the lowercase `Bench` values
 *   `"single"`, `"division"`, `"full"`, `"larger"` (or null where the type allows it);
 * - a treatment `kind` is lowercase, as the corpus records it: `"overruled"`, `"followed"`, `"applied"`, ... The verdict
 *   rule (`verdictFromTreatments`) counts only a kind that is exactly `"overruled"`, so an adapter that returned
 *   `"Overruled"` would turn an overruled judgment VERIFIED. The adapter normalises; the rule does not.
 */
export interface AuthorityStore {
  /** The judgment whose citation normalises to `canonical`, or null. */
  findJudgment(canonical: string): Promise<{ judgmentId: string; benchType: Bench } | null>
  /** Every recorded treatment of the judgment, each with its lowercase `kind` (`"overruled"`, `"followed"`, ...). */
  listTreatments(judgmentId: string): Promise<TreatmentFact[]>
  /** The text of the section in force on `asAtDate` in `jurisdiction`, or "no_history" when the store has none. */
  getSectionAsAt(sectionId: string, asAtDate: string, jurisdiction: string): Promise<{ text: string } | "no_history">
}

/** The production adapter until O-59: it knows nothing, so the gate fails closed. */
export const EMPTY_AUTHORITY_STORE: AuthorityStore = Object.freeze({
  async findJudgment() {
    return null
  },
  async listTreatments() {
    return []
  },
  async getSectionAsAt() {
    return "no_history" as const
  },
})

type SectionVersion = { sectionId: string; jurisdiction: string; effectiveFrom: string; effectiveTo: string | null; text: string }

/** For tests and local use. Dates are YYYY-MM-DD strings, compared as strings (as the Next.js SpineStore does). */
export class InMemoryAuthorityStore implements AuthorityStore {
  private readonly judgments = new Map<string, { citation: string; bench: Bench }>()
  private readonly treatments: { treatingId: string; treatedId: string; kind: string; recordedTreatingBench: Bench }[] = []
  private readonly versions: SectionVersion[] = []

  addJudgment(id: string, citation: string, bench: Bench): void {
    this.judgments.set(id, { citation, bench })
  }

  addTreatment(treatingId: string, treatedId: string, kind: string, recordedTreatingBench: Bench): void {
    this.treatments.push({ treatingId, treatedId, kind, recordedTreatingBench })
  }

  addSectionVersion(sectionId: string, jurisdiction: string, effectiveFrom: string, effectiveTo: string | null, text: string): void {
    this.versions.push({ sectionId, jurisdiction, effectiveFrom, effectiveTo, text })
  }

  async findJudgment(canonical: string): Promise<{ judgmentId: string; benchType: Bench } | null> {
    for (const [judgmentId, j] of this.judgments) {
      if (normaliseCitation(j.citation) === canonical) return { judgmentId, benchType: j.bench }
    }
    return null
  }

  async listTreatments(judgmentId: string): Promise<TreatmentFact[]> {
    return this.treatments
      .filter((t) => t.treatedId === judgmentId)
      .map((t) => ({
        kind: t.kind,
        treatingJudgmentBench: this.judgments.get(t.treatingId)?.bench ?? null,
        recordedTreatingBench: t.recordedTreatingBench,
      }))
  }

  async getSectionAsAt(sectionId: string, asAtDate: string, jurisdiction: string): Promise<{ text: string } | "no_history"> {
    // Same rule as getSectionAsAt in services/d4-2/draftingIntelligence.ts, plus the jurisdiction (E-39(1)).
    const hit = this.versions.find((v) => {
      if (v.sectionId !== sectionId || v.jurisdiction !== jurisdiction) return false
      if (asAtDate < v.effectiveFrom) return false
      if (v.effectiveTo && asAtDate >= v.effectiveTo) return false
      return true
    })
    return hit ? { text: hit.text } : "no_history"
  }
}

let testStore: AuthorityStore | null = null

/** Test-only override of the authority store; null restores the empty one. */
export function setAuthorityStoreForTests(s: AuthorityStore | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setAuthorityStoreForTests is test-only")
  testStore = s
}

/** The corpus store for the current configuration (one at a time; a new configuration ends the previous pool). */
let corpus: { key: string; store: PgAuthorityStore } | null = null
/** The not-configured reasons already logged by this process (D16: once per reason). */
const notConfiguredLogged = new Set<string>()

/**
 * The store the gate runs against, in order: a test's; the corpus store when the environment configures a valid
 * reader (memoised per configuration); else the empty one, logging `d4.authority_not_configured {reason}` once per
 * reason. The log carries the reason token only, never the URL or a credential.
 */
export function activeAuthorityStore(): AuthorityStore {
  if (testStore) return testStore
  const configured = readCorpusReaderConfig(process.env)
  if (configured.ok) {
    if (corpus?.key !== configured.config.key) {
      const previous = corpus
      corpus = { key: configured.config.key, store: new PgAuthorityStore(configured.config) }
      if (previous) void previous.store.end().catch(() => undefined)
    }
    return corpus.store
  }
  if (!notConfiguredLogged.has(configured.reason)) {
    notConfiguredLogged.add(configured.reason)
    logger.warn("d4.authority_not_configured", { reason: configured.reason })
  }
  return EMPTY_AUTHORITY_STORE
}

/** Test-only: end the corpus store's pool and forget it, its cached state, and the not-configured log. */
export async function resetCorpusAuthorityStoreForTests(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("resetCorpusAuthorityStoreForTests is test-only")
  const previous = corpus
  corpus = null
  notConfiguredLogged.clear()
  if (previous) await previous.store.end()
}
