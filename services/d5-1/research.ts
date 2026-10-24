import type { Judgment, SpineStore } from "@/platform/spine/store"
import { PublicError } from "@/platform/http/publicError"
import { analyseCitations, normaliseCitation } from "@/services/d4-2/citations"
import type { CitationVerdict } from "@/services/d4-2/citationVerdict"
import { verifyCitations } from "@/services/d4-2/draftingIntelligence"
import { CorpusUnavailableError } from "@/services/d5-1/corpusUnavailable"
import { researchTermsOf } from "@/services/d5-1/researchTerms"

/**
 * D5-1 research search (Module 18 `search`; audit FA-D5-001, FA-D5-002, FA-D5-003). Case-law search over a corpus read
 * model: a validated query in, the top k judgments out, ranked and scored, each with its Module 33 treatment.
 * Rulings: docs/superpowers/specs/2026-10-18-fa-d5-research-search-design.md (R1-R13) and, for the corpus it reads,
 * docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md (R6-R8, and §7 R19-R34).
 *
 * The corpus is a `ResearchCorpus`: in production the published Annex A corpus, read in one snapshot by a
 * `ResearchSource` (services/d5-1/researchCorpus.ts, platform/corpus/pgResearchCorpus.ts); in tests and local
 * development, when explicitly selected, the in-app read model (`store.judgments`, `store.embeddings`,
 * `store.treatments`, `storeResearchCorpus`). Both are ranked by the one function below, so they cannot drift. The
 * in-memory corpus is the whole read model; the Postgres one is a candidate set that holds every judgment of the
 * whole-corpus top k, with the whole corpus's IDF statistics (`stats`, R19), so the ranking is the same.
 *
 * - Keyword leg: the IDF-weighted share of the query's distinct terms found in a judgment's title or citations (each
 *   text folded on its own, R23).
 * - Semantic leg: cosine between a caller-supplied query vector and the stored 1536-d vector (P1 has no embedding
 *   operation yet, so no in-app caller supplies one: R3).
 * - Both legs: 0.6 semantic + 0.4 keyword (Module 18). Scores are in [0, 1]; only a score above 0 is a hit.
 * - A judgment one of whose citations the query text names (read by the citation gate's parser) scores 1 and ranks
 *   ahead of other score-1 hits: the authority asked for, not another sharing its numbers (R4a). The hit then shows
 *   that citation; otherwise its first.
 * Every refusal of the caller's query is a PublicError with a fixed message (a clean 400 at any route) that never echoes
 * the query. A corpus the search cannot trust (its integrity lock broken) is CorpusUnavailableError (503, R30).
 * Callers own the P5 `research` check (L19.10: "P5.checkPermission then D5-1"), as for verifyCitations.
 */

/** The corpus vector dimension (Annex A `vector(1536)`, corpus_metadata.embedding_dim; G-0 [8]). */
export const EMBEDDING_DIM = 1536
export const RESEARCH_DEFAULT_K = 10
export const RESEARCH_MAX_K = 50
export const RESEARCH_QUERY_MAX_CHARS = 500

export const SEMANTIC_WEIGHT = 0.6
export const KEYWORD_WEIGHT = 0.4

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
  /** The citation the query named (R4a), else the judgment's first; null when it has none. */
  citation: string | null
  benchType: Judgment["benchType"]
  /** Relevance in (0, 1], to 6 decimals. */
  score: number
  /** Module 33 verdict from the recorded treatments (Module 18: treatment surfaced with results). */
  treatment: CitationVerdict
}

export type ResearchMode = "keyword" | "semantic" | "blended"
export type ResearchResult = { items: ResearchHit[]; k: number; mode: ResearchMode }

/** One judgment as research ranks it: its title and every citation it may be found by. */
export type ResearchDocument = {
  id: string
  title: string
  citations: readonly string[]
  benchType: Judgment["benchType"]
}

/** corpus_metadata as research reads it. */
export type ResearchCorpusMeta = { embeddingModel: string; embeddingDim: string }

/**
 * Whole-corpus IDF statistics (R19): the number of judgments research may read, and the document frequency of each
 * query term among them. Given when `documents` is a candidate set rather than the whole corpus.
 */
export type ResearchStats = { documents: number; df: ReadonlyMap<string, number> }

/** A corpus read model in one snapshot (spec R6-R8, R19, R34). */
export type ResearchCorpus = ResearchCorpusMeta & {
  /** The whole corpus (in memory), or a candidate set holding every judgment of the whole-corpus top k (Postgres). */
  documents: readonly ResearchDocument[]
  /** Whole-corpus statistics when `documents` is a candidate set; absent or null when it is the whole corpus. */
  stats?: ResearchStats | null
  /** The (model, dimension) of the stored vectors search could read, in a stable order: the corpus lock reads them. */
  storedVectors: Iterable<{ model: string; dim: number }>
  /** The first stored vector of each entity, when the load asked for vectors (a query with an embedding); else null. */
  vectors: ReadonlyMap<string, readonly number[]> | null
  /** The Module 33 verdict of each judgment id asked about (read in the same snapshot; the Postgres source has read them). */
  verdicts(ids: readonly string[]): ReadonlyMap<string, CitationVerdict> | Promise<ReadonlyMap<string, CitationVerdict>>
}

/**
 * What a source needs to read for one query (R34): whether to read vectors, and the query itself, so a source that does
 * not read the whole corpus can choose its candidates. Sources that read everything ignore `query` and `unit`.
 */
export type ResearchLoadRequest = { vectors: boolean; query?: PreparedResearchQuery; unit?: readonly number[] | null }

/** Called once per load with the snapshot's metadata: validates a query vector against the live model. */
export type ResearchLoadPlan = (meta: ResearchCorpusMeta) => ResearchLoadRequest

/** Where research reads its corpus: one snapshot per load. A failure to read it throws CorpusUnavailableError. */
export type ResearchSource = { load(plan: ResearchLoadPlan): Promise<ResearchCorpus> }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const documentTerms = new WeakMap<ResearchDocument, { key: string; terms: ReadonlySet<string> }>()

/**
 * The distinct terms of a judgment (R23): its title's and each citation's, each text folded on its own, as the term
 * index stores them. Cached per row (recomputed if the row's text changes).
 */
export function researchDocumentTerms(doc: ResearchDocument): ReadonlySet<string> {
  const key = `${doc.title}\u0000${doc.citations.join("\u0001")}`
  const cached = documentTerms.get(doc)
  if (cached?.key === key) return cached.terms
  const terms = new Set(researchTermsOf(doc.title))
  for (const citation of doc.citations) for (const term of researchTermsOf(citation)) terms.add(term)
  documentTerms.set(doc, { key, terms })
  return terms
}

const isNumberTerm = (term: string) => /^\p{N}+$/u.test(term)

/** A citation the query names (R4a): its canonical key, and the number terms a judgment's citation must carry. */
export type QueryCitation = { canonical: string; numbers: string[] }
type CitationEntry = { citation: string; numbers: ReadonlySet<string>; canonical?: string | null }

const documentCitations = new WeakMap<ResearchDocument, { key: string; entries: CitationEntry[] }>()

/**
 * The citation of `doc` that is `cited`, or null (R4a). Only a citation that carries every number of `cited` reaches
 * the citation parser (normaliseCitation, the gate's rule), so a corpus full of titles that mention the numbers costs no
 * parsing. Both steps are cached per row, recomputed if its citations change.
 */
function citedCitation(doc: ResearchDocument, cited: QueryCitation): string | null {
  const key = doc.citations.join("\u0001")
  let entry = documentCitations.get(doc)
  if (!entry || entry.key !== key) {
    entry = { key, entries: doc.citations.map((citation) => ({ citation, numbers: new Set(researchTermsOf(citation).filter(isNumberTerm)) })) }
    documentCitations.set(doc, entry)
  }
  for (const c of entry.entries) {
    if (!cited.numbers.every((n) => c.numbers.has(n))) continue
    if (c.canonical === undefined) c.canonical = normaliseCitation(c.citation)
    if (c.canonical === cited.canonical) return c.citation
  }
  return null
}

/** The first of the query's cited keys `doc` carries (R4a), or null. */
export function researchCitedCitation(doc: ResearchDocument, citations: readonly QueryCitation[]): string | null {
  for (const c of citations) {
    const cited = citedCitation(doc, c)
    if (cited !== null) return cited
  }
  return null
}

function parseK(k: unknown): number {
  if (k === undefined) return RESEARCH_DEFAULT_K
  if (typeof k !== "number" || !Number.isSafeInteger(k) || k < 1 || k > RESEARCH_MAX_K) {
    throw new PublicError(`research k must be an integer from 1 to ${RESEARCH_MAX_K}`)
  }
  return k
}

/** The query's search terms and the canonical citations it names (R4a). */
function parseText(text: unknown): { terms: string[]; citations: QueryCitation[] } {
  if (typeof text !== "string") throw new PublicError("research query text must be a string")
  const collapsed = text.replace(/\s+/gu, " ").trim()
  // Refused, never truncated: a cut query is a different question.
  if (collapsed.length > RESEARCH_QUERY_MAX_CHARS && [...collapsed].length > RESEARCH_QUERY_MAX_CHARS) {
    throw new PublicError(`research query exceeds ${RESEARCH_QUERY_MAX_CHARS} characters`)
  }
  const terms = [...new Set(researchTermsOf(collapsed))]
  if (terms.length === 0) throw new PublicError("research query has no search terms")
  // Each citation's numbers prefilter candidates cheaply: reporter spellings vary ("S.C.M.R."), numbers do not.
  const citations = analyseCitations(collapsed).citations.map((canonical) => ({
    canonical,
    numbers: researchTermsOf(canonical).filter(isNumberTerm),
  }))
  return { terms, citations }
}

/** A query validated without the corpus: its shape, k and text. Its embedding waits for the corpus's live model. */
export type PreparedResearchQuery = {
  k: number
  text: { terms: string[]; citations: QueryCitation[] } | null
  embedding: unknown
}

/** Everything a query can be refused for before the corpus is read (so a refused query costs no corpus read). */
export function prepareResearchQuery(query: unknown): PreparedResearchQuery {
  if (!isRecord(query) || (query.text === undefined && query.embedding === undefined)) {
    throw new PublicError("research query must be an object with text or embedding")
  }
  const k = parseK(query.k)
  const text = query.text === undefined ? null : parseText(query.text)
  return { k, text, embedding: query.embedding }
}

/** The query vector scaled to unit length (scaling first, so huge finite values cannot overflow the norm). */
export function parseResearchEmbedding(liveModel: string, embedding: unknown): number[] {
  if (!isRecord(embedding) || typeof embedding.model !== "string" || !Array.isArray(embedding.vector)) {
    throw new PublicError("research embedding must name a model and carry a vector")
  }
  if (embedding.model !== liveModel) throw new PublicError("search refuses: embedding_model mismatch")
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
 * Why the stored vectors cannot serve `model`, or null: a vector under another model, or not EMBEDDING_DIM long.
 * The one rule behind both the search lock (G1-10) and the model-switch guard (FA-D5-002), so "may search" and
 * "may switch" cannot drift apart.
 */
function storedVectorsProblem(
  stored: Iterable<{ model: string; dim: number }>,
  model: string
): "embedding_model mismatch" | "embedding_dim mismatch" | null {
  for (const row of stored) {
    if (row.model !== model) return "embedding_model mismatch"
    if (row.dim !== EMBEDDING_DIM) return "embedding_dim mismatch"
  }
  return null
}

/** The corpus integrity lock (G1-10): why a corpus caught mid-migration may not be searched, or null. */
export function researchLockProblem(corpus: ResearchCorpusMeta & { storedVectors: Iterable<{ model: string; dim: number }> }): string | null {
  if (Number(corpus.embeddingDim) !== EMBEDDING_DIM) return "embedding_dim mismatch"
  return storedVectorsProblem(corpus.storedVectors, corpus.embeddingModel)
}

/** The in-app read model's stored vectors as (model, dimension), read afresh on each pass; a non-array has no dimension. */
function storeVectorShapes(store: SpineStore): Iterable<{ model: string; dim: number }> {
  return {
    *[Symbol.iterator]() {
      for (const row of store.embeddings) yield { model: row.model, dim: Array.isArray(row.vector) ? row.vector.length : Number.NaN }
    },
  }
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

/** The mode a query ranks in. */
export function researchMode(hasText: boolean, hasVector: boolean): ResearchMode {
  return hasText && hasVector ? "blended" : hasText ? "keyword" : "semantic"
}

/** BM25 idf of each query term over `documents` judgments, always positive, so a term absent from the corpus still counts. */
export function researchIdf(terms: readonly string[], documents: number, df: (term: string) => number): number[] {
  return terms.map((term) => {
    const d = df(term)
    return Math.log(1 + (documents - d + 0.5) / (d + 0.5))
  })
}

/** The keyword leg: the IDF-weighted share of the query's terms a judgment holds (`holds(t)` for the t-th term). */
export function researchKeywordScore(idf: readonly number[], holds: (t: number) => boolean): number {
  let total = 0
  let matched = 0
  idf.forEach((w, t) => {
    total += w
    if (holds(t)) matched += w
  })
  return matched / total
}

/** A judgment's relevance before rounding: 1 for the cited authority (R4a), else its mode's mix of the two legs. */
export function researchRawScore(mode: ResearchMode, exact: boolean, semantic: number, keyword: number): number {
  return exact ? 1 : mode === "blended" ? SEMANTIC_WEIGHT * semantic + KEYWORD_WEIGHT * keyword : mode === "keyword" ? keyword : semantic
}

/** Rounded before the hit test, so a relevance too small to show at 6 decimals is not a hit that reads as 0. */
export function researchRoundScore(raw: number): number {
  return Math.round(raw * 1e6) / 1e6
}

/** One ranked judgment: its score, the citation the query named (R4a) and its distinct-term count (the tie-break). */
export type RankedResearchHit = { doc: ResearchDocument; score: number; cited: string | null; size: number }
export type RankedResearch = { k: number; mode: ResearchMode; top: RankedResearchHit[] }

/** Score, then the cited authority (R4a), then the more specific one (fewer distinct terms), then the id. */
export function compareRankedResearch(a: RankedResearchHit, b: RankedResearchHit): number {
  return (
    b.score - a.score ||
    Number(b.cited !== null) - Number(a.cited !== null) ||
    a.size - b.size ||
    (a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0)
  )
}

/**
 * The ranking (R6, R19): the corpus lock, both legs, R4a, the tie-breaks, the top k. With `stats` the IDF is the whole
 * corpus's, whatever subset `documents` is; without, `documents` is the whole corpus.
 */
export function rankResearchCorpus(corpus: ResearchCorpus, query: PreparedResearchQuery, unitQuery: readonly number[] | null): RankedResearch {
  const { k, text } = query
  const terms = text?.terms ?? null

  // The corpus integrity lock (G1-10): a corpus caught mid-migration serves neither leg.
  const problem = researchLockProblem(corpus)
  if (problem) throw new PublicError(`search refuses: ${problem}`)

  const mode = researchMode(terms !== null, unitQuery !== null)
  const documents = corpus.documents
  const docTerms = documents.map(researchDocumentTerms)
  const stats = corpus.stats ?? null

  const idf = researchIdf(
    terms ?? [],
    stats ? stats.documents : documents.length,
    stats ? (term) => stats.df.get(term) ?? 0 : (term) => docTerms.reduce((n, set) => n + (set.has(term) ? 1 : 0), 0)
  )

  // Only a judgment is a hit (R1); the first live-model row of each entity is its vector.
  if (unitQuery && corpus.vectors === null) throw new Error("research: the corpus was loaded without its vectors")
  const vectors = unitQuery ? corpus.vectors : null

  const scored: RankedResearchHit[] = []
  documents.forEach((doc, i) => {
    const keyword = terms ? researchKeywordScore(idf, (t) => docTerms[i].has(terms[t])) : 0
    let semantic = 0
    const stored = unitQuery ? vectors?.get(doc.id) : undefined
    if (unitQuery && stored) semantic = Math.max(0, cosine(unitQuery, stored))
    // R4a: the authority the query cites, by any of its citations.
    const cited = text !== null ? researchCitedCitation(doc, text.citations) : null
    const score = researchRoundScore(researchRawScore(mode, cited !== null, semantic, keyword))
    if (score > 0) scored.push({ doc, size: docTerms[i].size, score, cited })
  })

  scored.sort(compareRankedResearch)
  return { k, mode, top: scored.slice(0, k) }
}

/** The ranked top k as hits, each with its verdict. */
function researchResult(ranked: RankedResearch, verdicts: ReadonlyMap<string, CitationVerdict>): ResearchResult {
  return {
    k: ranked.k,
    mode: ranked.mode,
    items: ranked.top.map(({ doc, score, cited }) => ({
      entityId: doc.id,
      title: doc.title,
      citation: cited ?? doc.citations[0] ?? null,
      benchType: doc.benchType,
      score,
      treatment: verdicts.get(doc.id) ?? "UNVERIFIED",
    })),
  }
}

const storeDocuments = new WeakMap<Judgment, ResearchDocument>()

/** A judgment of the in-app read model as research ranks it (the same object while the judgment is unchanged). */
function documentOf(judgment: Judgment): ResearchDocument {
  const cached = storeDocuments.get(judgment)
  const citations = judgment.citation ? [judgment.citation] : []
  if (
    cached &&
    cached.id === judgment.id &&
    cached.title === judgment.title &&
    cached.benchType === judgment.benchType &&
    cached.citations.join("\u0001") === citations.join("\u0001")
  ) {
    return cached
  }
  const doc: ResearchDocument = { id: judgment.id, title: judgment.title, citations, benchType: judgment.benchType }
  storeDocuments.set(judgment, doc)
  return doc
}

/** The Next citation gate's verdicts over the in-app read model. */
function storeVerdicts(store: SpineStore, ids: readonly string[]): ReadonlyMap<string, CitationVerdict> {
  const out = new Map<string, CitationVerdict>()
  for (const finding of verifyCitations(store, ids).findings) {
    if (finding.judgmentId) out.set(finding.judgmentId, finding.status)
  }
  return out
}

/** The in-app read model as a research corpus: its judgments, stored vectors and the Next citation gate's verdicts. */
export function storeResearchCorpus(store: SpineStore, withVectors: boolean): ResearchCorpus {
  let vectors: Map<string, readonly number[]> | null = null
  if (withVectors) {
    vectors = new Map()
    for (const row of store.embeddings) if (!vectors.has(row.entityId)) vectors.set(row.entityId, row.vector)
  }
  return {
    embeddingModel: store.corpusMetadata.embedding_model,
    embeddingDim: store.corpusMetadata.embedding_dim,
    documents: [...store.judgments.values()].map(documentOf),
    storedVectors: storeVectorShapes(store),
    vectors,
    verdicts: (ids) => storeVerdicts(store, ids),
  }
}

/** Search over the in-app read model (synchronous; the tests and the in-memory source use it). */
export function searchCorpus(store: SpineStore, query: ResearchQuery): ResearchResult {
  const prepared = prepareResearchQuery(query)
  const unitQuery = prepared.embedding === undefined ? null : parseResearchEmbedding(store.corpusMetadata.embedding_model, prepared.embedding)
  const ranked = rankResearchCorpus(storeResearchCorpus(store, unitQuery !== null), prepared, unitQuery)
  return researchResult(ranked, storeVerdicts(store, ranked.top.map((h) => h.doc.id)))
}

/**
 * Search over any research source (R6, R19, R30, R34): the query is refused before the corpus is read when it can be; a
 * query vector is checked against the live model of the snapshot the source reads, which reads vectors only for it. A
 * corpus whose integrity lock is broken is the corpus's state, not the caller's error: 503 `inconsistent` (R30), never a
 * stored 400.
 */
export async function searchResearch(source: ResearchSource, query: unknown): Promise<ResearchResult> {
  const prepared = prepareResearchQuery(query)
  const vector: { unit: number[] | null; model: string | null } = { unit: null, model: null }
  const corpus = await source.load((meta) => {
    if (prepared.embedding !== undefined) {
      vector.unit = parseResearchEmbedding(meta.embeddingModel, prepared.embedding)
      vector.model = meta.embeddingModel
    }
    return { vectors: vector.unit !== null, query: prepared, unit: vector.unit }
  })
  // The vector was checked against the snapshot it is ranked over.
  if (vector.unit !== null && vector.model !== corpus.embeddingModel) throw new PublicError("search refuses: embedding_model mismatch")
  if (researchLockProblem(corpus) !== null) throw new CorpusUnavailableError("inconsistent")
  const ranked = rankResearchCorpus(corpus, prepared, vector.unit)
  return researchResult(ranked, await corpus.verdicts(ranked.top.map((h) => h.doc.id)))
}

/**
 * Switches the live embedding model (corpus_metadata.embedding_model). FA-D5-002: only on explicit confirmation,
 * to a well-formed id that differs from the live one, and never away from the stored vectors: while any stored
 * vector is not a EMBEDDING_DIM row under `nextModel` the switch is refused (re-embed first), so an in-app switch
 * can never leave search refusing. No route calls this yet; the operator route that does must make a partner-only
 * P5 check (spec R13). It acts on the in-app read model only: Annex A's live model is changed by the corpus side.
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
  if (storedVectorsProblem(storeVectorShapes(store), nextModel)) {
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
