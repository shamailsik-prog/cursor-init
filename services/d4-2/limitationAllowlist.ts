/**
 * The period reader assesses a provision only when every sentence is one of:
 * the canonical reckoning, the canonical month-end, a neutral label clause,
 * or one quantity clause (optional label words, one cardinal, one day/month/year).
 * Anything else fails closed. These two sentences are the whole proviso allowlist.
 * They are engine fixtures.
 * [REQUIRES VERIFICATION] Published section 12(1) includes "prescribed for any suit, appeal or application,"
 * and does not match CANONICAL_RECKONING, so that gazetted sentence yields reckoning_unverified.
 * The canonical reckoning must be the lawyer-verified gazetted section 12(1) text.
 * [REQUIRES VERIFICATION] against the official gazette before either fixture is treated as that text.
 * Do not replace either sentence from an unsourced recollection of the Act.
 * Schedule-column contract: a First Schedule row that places a description column
 * or a time column beside the period is outside this grammar and refuses.
 * This engine has no contract that separates those columns.
 * [REQUIRES VERIFICATION] before any schedule row is wired.
 * An s.12 row applies the accrual-day exclusion only when every non-empty sentence
 * is the canonical reckoning or a neutral heading. A neutral heading is the fixture
 * label "Q11 FIXTURE", or a sentence whose words are all in NEUTRAL_WORDS.
 * Any other sentence yields reckoning_unverified and a null deadline.
 */
export const CANONICAL_RECKONING =
  "in computing the period of limitation the day from which such period is to be reckoned shall be excluded"

export const CANONICAL_MONTH_END =
  "if the corresponding date does not exist, the period expires on the last day of that month"

/** Words that may sit in the same clause as the quantity. */
export const QUANTITY_LABELS = new Set([
  "a",
  "an",
  "art",
  "article",
  "fixture",
  "for",
  "is",
  "limitation",
  "of",
  "period",
  "suit",
  "the",
])

/**
 * Words that may fill a clause that does not hold the quantity.
 * "over" is not one of them. The only allowed "over" is the exact phrase
 * "possession over the property", and only in a clause that does not hold the quantity.
 */
export const NEUTRAL_WORDS = new Set([
  ...QUANTITY_LABELS,
  "court",
  "file",
  "possession",
  "property",
  "read",
])

export const UNICODE_DASH = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/

const PROVISO_SHAPE =
  /excluded|reckoned|corresponding date|last day of that month|not apply|only if|in no case|hardly|rather than|\bunless\b|\bexcept\b|\bsave\b/i

export function normalizeSentence(sentence: string): string {
  return sentence
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/g, "")
    .trim()
    .toLowerCase()
}

export function isCanonicalReckoning(sentence: string): boolean {
  return normalizeSentence(sentence) === CANONICAL_RECKONING
}

export function isCanonicalMonthEnd(sentence: string): boolean {
  return normalizeSentence(sentence) === CANONICAL_MONTH_END
}

export function isCanonicalProviso(sentence: string): boolean {
  return isCanonicalReckoning(sentence) || isCanonicalMonthEnd(sentence)
}

/** A sentence that must be one of the two canonical provisos. Any other match refuses. */
export function provisoShaped(sentence: string): boolean {
  return PROVISO_SHAPE.test(normalizeSentence(sentence))
}

export function hasUnicodeDash(text: string): boolean {
  return UNICODE_DASH.test(text)
}

export function wordsOf(clause: string): string[] {
  return clause
    .toLowerCase()
    .replace(/[()[\]]/g, " ")
    .split(/[^a-z]+/)
    .filter((word) => word.length > 0)
}
