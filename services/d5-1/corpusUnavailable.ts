/**
 * Why research could not read its corpus (audit FA-D5-003, spec R10). Every failure to read the corpus is one of these:
 * a source that is not configured or is misconfigured, the network, the database's answer, a login that can do more than
 * read the research relations, a corpus that breaks its contract or is stale, or a corpus too large to load whole. The
 * court-ops route answers it as 503 `corpus_unavailable`, never as an empty list: an empty list means only that nothing
 * matched. This module has no imports, so the source seam and the Postgres adapter share it without a cycle.
 */
export const CORPUS_UNAVAILABLE_REASONS = Object.freeze([
  "not_configured",
  "misconfigured",
  "unreachable",
  "timeout",
  "auth",
  "tls",
  "permission",
  "schema_missing",
  "contract_missing",
  "stale",
  "wrong_role",
  "row_cap",
  "inconsistent",
  "busy",
  "error",
] as const)
export type CorpusUnavailableReason = (typeof CORPUS_UNAVAILABLE_REASONS)[number]

/** The public code and message of the 503 the court-ops route answers. The reason is logged, never returned. */
export const CORPUS_UNAVAILABLE_CODE = "corpus_unavailable"
export const CORPUS_UNAVAILABLE_MESSAGE = "research corpus unavailable"

/** The one error a research source throws when it cannot answer. Its message is the reason token only. */
export class CorpusUnavailableError extends Error {
  readonly reason: CorpusUnavailableReason

  constructor(reason: CorpusUnavailableReason) {
    super(`corpus_unavailable:${reason}`)
    this.name = "CorpusUnavailableError"
    this.reason = reason
  }
}
