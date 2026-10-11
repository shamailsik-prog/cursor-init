/**
 * The authority port (spec P4-3): what the gate needs to know about the corpus, and nothing else. Calls carry only
 * a canonical citation, a judgment id or a section key, never a matter id or party data (L19.11 #3).
 *
 * Production runs on EMPTY_AUTHORITY_STORE until the corpus connector exists (O-59): no judgment, no history, so
 * every citation is UNVERIFIED and every temporal check UNAVAILABLE, and the partner override carries the load.
 * Tests inject an InMemoryAuthorityStore through setAuthorityStoreForTests.
 */
import { normaliseCitation } from "@/services/d4-2/citations"
import type { Bench, TreatmentFact } from "@/services/d4-2/citationVerdict"

export interface AuthorityStore {
  /** The judgment whose citation normalises to `canonical`, or null. */
  findJudgment(canonical: string): Promise<{ judgmentId: string; benchType: Bench } | null>
  /** Every recorded treatment of the judgment (overruled, followed, ...). */
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

/** The store the gate runs against: a test's, else the empty one. */
export function activeAuthorityStore(): AuthorityStore {
  return testStore ?? EMPTY_AUTHORITY_STORE
}
