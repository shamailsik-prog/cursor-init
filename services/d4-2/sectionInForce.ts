/**
 * The in-force statute rule (Q03 / F05 D5). One copy. The corpus adapter re-exports it
 * and turns SectionHistoryInconsistentError into AuthorityUnavailableError so the gate
 * still fails closed. This module imports nothing from Cloud Functions.
 */

export const MIN_VERSION_CONFIDENCE = 0.5

export type SectionVersionRow = {
  versionNo: number
  effectiveFrom: string
  effectiveTo: string | null
  text: string
  versionConfidence: number | null
}

/** The history breaks the version contract. Callers must not pick a text. */
export class SectionHistoryInconsistentError extends Error {
  readonly reason = "inconsistent" as const

  constructor() {
    super("section_history_inconsistent")
    this.name = "SectionHistoryInconsistentError"
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Ruling 4, NaN-safe: a finite confidence above 0.5 and at most 1. */
export function versionUsable(confidence: number | null): boolean {
  return typeof confidence === "number" && confidence > MIN_VERSION_CONFIDENCE && confidence <= 1
}

/**
 * The one version in force on `asAtDate` (effectiveFrom <= date < effectiveTo, an open range running on), or null.
 * `rows` come ordered by effectiveFrom, then versionNo. A history that breaks the contract (a reversed or empty range,
 * an overlap, an open range that is not last, version numbers out of order, a malformed date) throws
 * SectionHistoryInconsistentError: the caller must not pick a text from it.
 */
export function coveringVersion(rows: readonly SectionVersionRow[], asAtDate: string): SectionVersionRow | null {
  for (const [i, row] of rows.entries()) {
    if (!ISO_DATE.test(row.effectiveFrom) || (row.effectiveTo !== null && !ISO_DATE.test(row.effectiveTo))) {
      throw new SectionHistoryInconsistentError()
    }
    if (row.effectiveTo !== null && row.effectiveTo <= row.effectiveFrom) throw new SectionHistoryInconsistentError()
    const next = rows[i + 1]
    if (next) {
      if (row.effectiveTo === null || row.effectiveTo > next.effectiveFrom) throw new SectionHistoryInconsistentError()
      if (next.versionNo <= row.versionNo) throw new SectionHistoryInconsistentError()
    }
  }
  const covering = rows.filter((r) => r.effectiveFrom <= asAtDate && (r.effectiveTo === null || asAtDate < r.effectiveTo))
  if (covering.length > 1) throw new SectionHistoryInconsistentError()
  return covering[0] ?? null
}
