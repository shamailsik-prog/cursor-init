import { normaliseDraftText } from "@/services/d4-2/citations"

/**
 * D5-1 research search terms (audit FA-D5-001, FA-D5-003 R1). One definition for the query, the in-memory corpus and
 * the Postgres corpus's pre-folded term index (postgres/ddl/006_research_terms.sql), which the corpus service writes
 * with its Python restatement (corpus_service/scraper/publication/research_terms.py). The golden
 * tests/fixtures/corpus/research-terms-golden.json is generated from this function only (`npm run
 * corpus:research-terms-golden`) and pins the Python fold to it. Spec:
 * docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md §7, R20-R23.
 *
 * A text's terms: folded like the citation gate (NFKD, marks and ignorables dropped, every decimal digit to ASCII,
 * markup stripped, hyphenated line breaks joined), lower-cased, runs of letters and numbers, stop words dropped, a lone
 * letter dropped and a lone digit kept.
 */

/** Dropped from queries and documents: they carry no legal meaning and would dilute the coverage score. */
export const RESEARCH_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "in", "is", "of", "on", "or", "the", "to", "v", "vs", "versus",
  "was", "with",
])

/** The search terms of `text`, in order, repeats kept. */
export function researchTermsOf(text: string): string[] {
  const out: string[] = []
  for (const match of normaliseDraftText(text).toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0]
    if (RESEARCH_STOP_WORDS.has(term)) continue
    // A lone letter ("s" of "s. 302") is noise; a lone digit is not ("PLD 2099 SC 1").
    if (term.length < 2 && !/^\p{N}$/u.test(term)) continue
    out.push(term)
  }
  return out
}
