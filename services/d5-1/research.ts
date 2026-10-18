import type { Judgment, SpineStore } from "@/platform/spine/store"
import { PublicError } from "@/platform/http/publicError"
import { normaliseDraftText } from "@/services/d4-2/citations"
import type { CitationVerdict } from "@/services/d4-2/citationVerdict"
import { verifyCitations } from "@/services/d4-2/draftingIntelligence"

/**
 * D5-1 research search (Module 18 `search`; audit FA-D5-001, FA-D5-002). Case-law search over the in-app corpus
 * read model (`store.judgments`, `store.embeddings`, `store.treatments`, the model the Next citation gate reads):
 * a validated query in, the top k judgments out, ranked and scored, each with its Module 33 treatment.
 * Rulings: docs/superpowers/specs/2026-10-18-fa-d5-research-search-design.md (R1-R13).
 *
 * - Keyword leg: the IDF-weighted share of the query's distinct terms found in a judgment's title or citation.
 * - Semantic leg: cosine between a caller-supplied query vector and the stored 1536-d vector (P1 has no embedding
 *   operation yet, so no in-app caller supplies one: R3).
 * - Both legs: 0.6 semantic + 0.4 keyword (Module 18). Scores are in [0, 1]; only a score above 0 is a hit.
 * Every refusal is a PublicError with a fixed message (a clean 400 at any route) that never echoes the query.
 * Callers own the P5 `research` check (L19.10: "P5.checkPermission then D5-1"), as for verifyCitations.
 */

/** The corpus vector dimension (Annex A `vector(1536)`, corpus_metadata.embedding_dim; G-0 [8]). */
export const EMBEDDING_DIM = 1536
export const RESEARCH_DEFAULT_K = 10
export const RESEARCH_MAX_K = 50
export const RESEARCH_QUERY_MAX_CHARS = 500

const SEMANTIC_WEIGHT = 0.6
const KEYWORD_WEIGHT = 0.4

/** Dropped from queries and documents: they carry no legal meaning and would dilute the coverage score. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "in", "is", "of", "on", "or", "the", "to", "v", "vs", "versus",
  "was", "with",
])

/** An embedding model id: provider-style names such as `text-embedding-3-small` or `openai/text-embedding-3-large`. */
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,100}$/

export type ResearchQuery = {
  /** Keyword query, at most RESEARCH_QUERY_MAX_CHARS after whitespace collapse. */
  text?: string
  /** Query vector under the live corpus model, EMBEDDING_DIM finite numbers, not all zero. */
  embedding?: { model: string; vector: readonly number[] }
  /** How many hits, 1 to RESEARCH_MAX_K; RESEARCH_DEFAULT_K when absent. */
  k?: number
}

export type ResearchHit = {
  entityId: string
  title: string
  citation: string | null
  benchType: Judgment["benchType"]
  /** Relevance in (0, 1], to 6 decimals. */
  score: number
  /** Module 33 verdict from the recorded treatments (Module 18: treatment surfaced with results). */
  treatment: CitationVerdict
}

export type ResearchResult = { items: ResearchHit[]; k: number; mode: "keyword" | "semantic" | "blended" }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Search terms of `text`: folded like the citation gate (NFKD, marks dropped, every decimal digit to ASCII), lowercased. */
function termsOf(text: string): string[] {
  const out: string[] = []
  for (const match of normaliseDraftText(text).toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0]
    if (STOP_WORDS.has(term)) continue
    // A lone letter ("s" of "s. 302") is noise; a lone digit is not ("PLD 2099 SC 1").
    if (term.length < 2 && !/^\p{N}$/u.test(term)) continue
    out.push(term)
  }
  return out
}

const judgmentTerms = new WeakMap<Judgment, { key: string; terms: ReadonlySet<string> }>()

/** The distinct terms of a judgment's title and citation, cached per row (recomputed if the row's text changes). */
function termsOfJudgment(judgment: Judgment): ReadonlySet<string> {
  const key = `${judgment.title}\u0000${judgment.citation ?? ""}`
  const cached = judgmentTerms.get(judgment)
  if (cached?.key === key) return cached.terms
  const terms = new Set(termsOf(`${judgment.title} ${judgment.citation ?? ""}`))
  judgmentTerms.set(judgment, { key, terms })
  return terms
}

function parseK(k: unknown): number {
  if (k === undefined) return RESEARCH_DEFAULT_K
  if (typeof k !== "number" || !Number.isSafeInteger(k) || k < 1 || k > RESEARCH_MAX_K) {
    throw new PublicError(`research k must be an integer from 1 to ${RESEARCH_MAX_K}`)
  }
  return k
}

function parseText(text: unknown): string[] {
  if (typeof text !== "string") throw new PublicError("research query text must be a string")
  const collapsed = text.replace(/\s+/gu, " ").trim()
  // Refused, never truncated: a cut query is a different question.
  if (collapsed.length > RESEARCH_QUERY_MAX_CHARS && [...collapsed].length > RESEARCH_QUERY_MAX_CHARS) {
    throw new PublicError(`research query exceeds ${RESEARCH_QUERY_MAX_CHARS} characters`)
  }
  const terms = [...new Set(termsOf(collapsed))]
  if (terms.length === 0) throw new PublicError("research query has no search terms")
  return terms
}

/** The query vector scaled to unit length (scaling first, so huge finite values cannot overflow the norm). */
function parseEmbedding(store: SpineStore, embedding: unknown): number[] {
  if (!isRecord(embedding) || typeof embedding.model !== "string" || !Array.isArray(embedding.vector)) {
    throw new PublicError("research embedding must name a model and carry a vector")
  }
  if (embedding.model !== store.corpusMetadata.embedding_model) throw new PublicError("search refuses: embedding_model mismatch")
  const vector: unknown[] = embedding.vector
  if (vector.length !== EMBEDDING_DIM) throw new PublicError("search refuses: embedding_dim mismatch")
  let max = 0
  for (const x of vector) {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new PublicError("research embedding vector must hold finite numbers")
    max = Math.max(max, Math.abs(x))
  }
  if (max === 0) throw new PublicError("research embedding vector must not be zero")
  const scaled = (vector as number[]).map((x) => x / max)
  const norm = Math.sqrt(scaled.reduce((sum, x) => sum + x * x, 0))
  return scaled.map((x) => x / norm)
}

/**
 * Why the stored vectors cannot serve `model`, or null: a row under another model, or not EMBEDDING_DIM long.
 * The one rule behind both the search lock (G1-10) and the model-switch guard (FA-D5-002), so "may search" and
 * "may switch" cannot drift apart.
 */
function storedVectorsProblem(store: SpineStore, model: string): "embedding_model mismatch" | "embedding_dim mismatch" | null {
  for (const row of store.embeddings) {
    if (row.model !== model) return "embedding_model mismatch"
    if (!Array.isArray(row.vector) || row.vector.length !== EMBEDDING_DIM) return "embedding_dim mismatch"
  }
  return null
}

/** Cosine of a unit query vector and a stored vector; a stored zero vector scores 0. */
function cosine(unitQuery: readonly number[], stored: readonly number[]): number {
  let max = 0
  for (const x of stored) {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new PublicError("search refuses: stored vector is not finite")
    max = Math.max(max, Math.abs(x))
  }
  if (max === 0) return 0
  let dot = 0
  let norm2 = 0
  for (let i = 0; i < stored.length; i++) {
    const x = stored[i] / max
    dot += unitQuery[i] * x
    norm2 += x * x
  }
  return Math.min(1, Math.max(-1, dot / Math.sqrt(norm2)))
}

export function searchCorpus(store: SpineStore, query: ResearchQuery): ResearchResult {
  if (!isRecord(query) || (query.text === undefined && query.embedding === undefined)) {
    throw new PublicError("research query must be an object with text or embedding")
  }
  const k = parseK(query.k)
  const terms = query.text === undefined ? null : parseText(query.text)
  const unitQuery = query.embedding === undefined ? null : parseEmbedding(store, query.embedding)

  // The corpus integrity lock (G1-10): a corpus caught mid-migration serves neither leg.
  if (Number(store.corpusMetadata.embedding_dim) !== EMBEDDING_DIM) throw new PublicError("search refuses: embedding_dim mismatch")
  const problem = storedVectorsProblem(store, store.corpusMetadata.embedding_model)
  if (problem) throw new PublicError(`search refuses: ${problem}`)

  const mode: ResearchResult["mode"] = terms && unitQuery ? "blended" : terms ? "keyword" : "semantic"
  const judgments = [...store.judgments.values()]
  const docTerms = judgments.map(termsOfJudgment)

  // BM25 idf over the candidate judgments: always positive, so a term absent from the corpus still counts.
  const idf = (terms ?? []).map((term) => {
    const df = docTerms.reduce((n, set) => n + (set.has(term) ? 1 : 0), 0)
    return Math.log(1 + (judgments.length - df + 0.5) / (df + 0.5))
  })

  // Only a judgment is a hit (R1); the first live-model row of each entity is its vector.
  const vectors = new Map<string, readonly number[]>()
  if (unitQuery) for (const row of store.embeddings) if (!vectors.has(row.entityId)) vectors.set(row.entityId, row.vector)

  const scored: { judgment: Judgment; size: number; score: number }[] = []
  judgments.forEach((judgment, i) => {
    let keyword = 0
    if (terms) {
      let total = 0
      let matched = 0
      terms.forEach((term, t) => {
        total += idf[t]
        if (docTerms[i].has(term)) matched += idf[t]
      })
      keyword = matched / total
    }
    let semantic = 0
    const stored = unitQuery ? vectors.get(judgment.id) : undefined
    if (unitQuery && stored) semantic = Math.max(0, cosine(unitQuery, stored))
    const raw = mode === "blended" ? SEMANTIC_WEIGHT * semantic + KEYWORD_WEIGHT * keyword : mode === "keyword" ? keyword : semantic
    // Rounded before the hit test, so a relevance too small to show at 6 decimals is not a hit that reads as 0.
    const score = Math.round(raw * 1e6) / 1e6
    if (score > 0) scored.push({ judgment, size: docTerms[i].size, score })
  })

  // Score, then the more specific authority (fewer distinct terms), then the id: a deterministic order.
  scored.sort((a, b) => b.score - a.score || a.size - b.size || (a.judgment.id < b.judgment.id ? -1 : a.judgment.id > b.judgment.id ? 1 : 0))
  const top = scored.slice(0, k)

  const verdicts = new Map<string, CitationVerdict>()
  for (const finding of verifyCitations(store, top.map((h) => h.judgment.id)).findings) {
    if (finding.judgmentId) verdicts.set(finding.judgmentId, finding.status)
  }
  return {
    k,
    mode,
    items: top.map(({ judgment, score }) => ({
      entityId: judgment.id,
      title: judgment.title,
      citation: judgment.citation ?? null,
      benchType: judgment.benchType,
      score,
      treatment: verdicts.get(judgment.id) ?? "UNVERIFIED",
    })),
  }
}

/**
 * Switches the live embedding model (corpus_metadata.embedding_model). FA-D5-002: only on explicit confirmation,
 * to a well-formed id that differs from the live one, and never away from the stored vectors: while any stored
 * vector is not a EMBEDDING_DIM row under `nextModel` the switch is refused (re-embed first), so an in-app switch
 * can never leave search refusing. No route calls this yet; the operator route that does must make a partner-only
 * P5 check (spec R13).
 */
export function changeEmbeddingModel(
  store: SpineStore,
  nextModel: string,
  opts: { confirmed: boolean }
): { previous: string; model: string } {
  if (opts?.confirmed !== true) throw new PublicError("embedding model change refuses: confirmation required")
  if (typeof nextModel !== "string" || !MODEL_ID.test(nextModel)) throw new PublicError("embedding model change refuses: invalid model id")
  const previous = store.corpusMetadata.embedding_model
  if (nextModel === previous) throw new PublicError("embedding model change refuses: model unchanged")
  if (storedVectorsProblem(store, nextModel)) {
    throw new PublicError("embedding model change refuses: stored vectors are not under the new model; re-embed first")
  }
  store.corpusMetadata.embedding_model = nextModel
  return { previous, model: nextModel }
}

export function reembedCorpus(store: SpineStore, nextModel: string, confirmed: boolean) {
  if (!confirmed) {
    return { keptOld: true, model: store.embeddings[0]?.model ?? null }
  }
  store.reembedConfirmed = true
  for (const row of store.embeddings) {
    row.model = nextModel
  }
  store.corpusMetadata.embedding_model = nextModel
  return { keptOld: false, model: nextModel }
}
