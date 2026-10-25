import type { Judgment, SpineStore } from "@/platform/spine/store"
import { PublicError } from "@/platform/http/publicError"
import { analyseCitations, normaliseCitation, normaliseDraftText } from "@/services/d4-2/citations"
import type { CitationVerdict } from "@/services/d4-2/citationVerdict"
import { verifyCitations } from "@/services/d4-2/draftingIntelligence"

/**
 * D5-1 research search (Module 18 `search`; audit FA-D5-001, FA-D5-002, FA-D5-003). Case-law search over a corpus read
 * model: a validated query in, the top k judgments out, ranked and scored, each with its Module 33 treatment.
 * Rulings: docs/superpowers/specs/2026-10-18-fa-d5-research-search-design.md (R1-R13) and, for the corpus it reads,
 * docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md (R6-R8).
 *
 * The corpus is a `ResearchCorpus`: in production the published Annex A corpus, loaded in one snapshot by a
 * `ResearchSource` (services/d5-1/researchCorpus.ts, platform/corpus/pgResearchCorpus.ts); in tests and local
 * development, when explicitly selected, the in-app read model (`store.judgments`, `store.embeddings`,
 * `store.treatments`, `storeResearchCorpus`). Both are ranked by the one function below, so they cannot drift.
 *
 * - Keyword leg: the IDF-weighted share of the query's distinct terms found in a judgment's title or citations.
 * - Semantic leg: cosine between a caller-supplied query vector and the stored 1536-d vector (P1 has no embedding
 *   operation yet, so no in-app caller supplies one: R3).
 * - Both legs: 0.6 semantic + 0.4 keyword (Module 18). Scores are in [0, 1]; only a score above 0 is a hit.
 * - A judgment one of whose citations the query text names (read by the citation gate's parser) scores 1 and ranks
 *   ahead of other score-1 hits: the authority asked for, not another sharing its numbers (R4a). The hit then shows
 *   that citation; otherwise its first.
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
  /** The citation the query named (R4a), else the judgment's first; null when it has none. */
  citation: string | null
  benchType: Judgment["benchType"]
  /** Relevance in (0, 1], to 6 decimals. */
  score: number
  /** Module 33 verdict from the recorded treatments (Module 18: treatment surfaced with results). */
  treatment: CitationVerdict
}

export type ResearchResult = { items: ResearchHit[]; k: number; mode: "keyword" | "semantic" | "blended" }

/** One judgment as research ranks it: its title and every citation it may be found by. */
export type ResearchDocument = {
  id: string
  title: string
  citations: readonly string[]
  benchType: Judgment["benchType"]
}

/** corpus_metadata as research reads it. */
export type ResearchCorpusMeta = { embeddingModel: string; embeddingDim: string }

/** Whole-corpus inverse document frequency (FA-D5-003-R1-001): document frequencies from the published term index. */
export type ResearchWholeCorpusIdf = { judgmentCount: number; docFreq: ReadonlyMap<string, number> }

/** A corpus read model in one snapshot (spec R6-R8). */
export type ResearchCorpus = ResearchCorpusMeta & {
  documents: readonly ResearchDocument[]
  /** The (model, dimension) of the stored vectors search could read, in a stable order: the corpus lock reads them. */
  storedVectors: Iterable<{ model: string; dim: number }>
  /** The first stored vector of each entity, when the load asked for vectors (a query with an embedding); else null. */
  vectors: ReadonlyMap<string, readonly number[]> | null
  /** The Module 33 verdict of each judgment id asked about. */
  verdicts(ids: readonly string[]): ReadonlyMap<string, CitationVerdict>
  /** When set, keyword IDF uses these corpus-wide counts instead of the loaded document sample (R6 scale). */
  wholeCorpusIdf?: ResearchWholeCorpusIdf
}

/** Called once per load with the snapshot's metadata: validates a query vector, and says whether vectors are needed. */
export type ResearchLoadPlan = (meta: ResearchCorpusMeta) => { vectors: boolean }

/** Where research reads its corpus: one snapshot per load. A failure to read it throws CorpusUnavailableError. */
export type ResearchSource = {
  load(plan: ResearchLoadPlan): Promise<ResearchCorpus>
  /** Indexed Postgres path: candidates, whole-corpus IDF, treatments for the top k only (FA-D5-003-R1-001). */
  searchPrepared?(prepared: PreparedResearchQuery): Promise<ResearchResult>
}

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

const documentTerms = new WeakMap<ResearchDocument, { key: string; terms: ReadonlySet<string> }>()

/** The distinct terms of a judgment's title and citations, cached per row (recomputed if the row's text changes). */
function termsOfDocument(doc: ResearchDocument): ReadonlySet<string> {
  const key = `${doc.title}\u0000${doc.citations.join("\u0001")}`
  const cached = documentTerms.get(doc)
  if (cached?.key === key) return cached.terms
  const terms = new Set(termsOf(`${doc.title} ${doc.citations.join(" ")}`))
  documentTerms.set(doc, { key, terms })
  return terms
}

const isNumberTerm = (term: string) => /^\p{N}+$/u.test(term)

type QueryCitation = { canonical: string; numbers: string[] }
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
    entry = { key, entries: doc.citations.map((citation) => ({ citation, numbers: new Set(termsOf(citation).filter(isNumberTerm)) })) }
    documentCitations.set(doc, entry)
  }
  for (const c of entry.entries) {
    if (!cited.numbers.every((n) => c.numbers.has(n))) continue
    if (c.canonical === undefined) c.canonical = normaliseCitation(c.citation)
    if (c.canonical === cited.canonical) return c.citation
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
  const terms = [...new Set(termsOf(collapsed))]
  if (terms.length === 0) throw new PublicError("research query has no search terms")
  // Each citation's numbers prefilter candidates cheaply: reporter spellings vary ("S.C.M.R."), numbers do not.
  const citations = analyseCitations(collapsed).citations.map((canonical) => ({
    canonical,
    numbers: termsOf(canonical).filter(isNumberTerm),
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

/** The ranking (R6): the corpus lock, both legs, R4a, the tie-breaks, the top k with their Module 33 treatment. */
export function rankResearchCorpus(corpus: ResearchCorpus, query: PreparedResearchQuery, unitQuery: readonly number[] | null): ResearchResult {
  const { k, text } = query
  const terms = text?.terms ?? null

  // The corpus integrity lock (G1-10): a corpus caught mid-migration serves neither leg.
  if (Number(corpus.embeddingDim) !== EMBEDDING_DIM) throw new PublicError("search refuses: embedding_dim mismatch")
  const problem = storedVectorsProblem(corpus.storedVectors, corpus.embeddingModel)
  if (problem) throw new PublicError(`search refuses: ${problem}`)

  const mode: ResearchResult["mode"] = terms && unitQuery ? "blended" : terms ? "keyword" : "semantic"
  const documents = corpus.documents
  const docTerms = documents.map(termsOfDocument)
  const corpusN = corpus.wholeCorpusIdf?.judgmentCount ?? documents.length

  // BM25 idf over the candidate judgments: always positive, so a term absent from the corpus still counts.
  const idf = (terms ?? []).map((term) => {
    const df =
      corpus.wholeCorpusIdf?.docFreq.get(term) ??
      docTerms.reduce((n, set) => n + (set.has(term) ? 1 : 0), 0)
    return Math.log(1 + (corpusN - df + 0.5) / (df + 0.5))
  })

  // Only a judgment is a hit (R1); the first live-model row of each entity is its vector.
  if (unitQuery && corpus.vectors === null) throw new Error("research: the corpus was loaded without its vectors")
  const vectors = unitQuery ? corpus.vectors : null

  const scored: { doc: ResearchDocument; size: number; score: number; cited: string | null }[] = []
  documents.forEach((doc, i) => {
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
    const stored = unitQuery ? vectors?.get(doc.id) : undefined
    if (unitQuery && stored) semantic = Math.max(0, cosine(unitQuery, stored))
    // R4a: the authority the query cites, by any of its citations.
    let cited: string | null = null
    if (text !== null) {
      for (const c of text.citations) {
        cited = citedCitation(doc, c)
        if (cited !== null) break
      }
    }
    const exact = cited !== null
    const raw = exact ? 1 : mode === "blended" ? SEMANTIC_WEIGHT * semantic + KEYWORD_WEIGHT * keyword : mode === "keyword" ? keyword : semantic
    // Rounded before the hit test, so a relevance too small to show at 6 decimals is not a hit that reads as 0.
    const score = Math.round(raw * 1e6) / 1e6
    if (score > 0) scored.push({ doc, size: docTerms[i].size, score, cited })
  })

  // Score, then the cited authority (R4a), then the more specific one (fewer distinct terms), then the id.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.cited !== null) - Number(a.cited !== null) ||
      a.size - b.size ||
      (a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0)
  )
  const top = scored.slice(0, k)

  const verdicts = corpus.verdicts(top.map((h) => h.doc.id))
  return {
    k,
    mode,
    items: top.map(({ doc, score, cited }) => ({
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
    verdicts(ids) {
      const out = new Map<string, CitationVerdict>()
      for (const finding of verifyCitations(store, ids).findings) {
        if (finding.judgmentId) out.set(finding.judgmentId, finding.status)
      }
      return out
    },
  }
}

/** Search over the in-app read model (synchronous; the tests and the in-memory source use it). */
export function searchCorpus(store: SpineStore, query: ResearchQuery): ResearchResult {
  const prepared = prepareResearchQuery(query)
  const unitQuery = prepared.embedding === undefined ? null : parseResearchEmbedding(store.corpusMetadata.embedding_model, prepared.embedding)
  return rankResearchCorpus(storeResearchCorpus(store, unitQuery !== null), prepared, unitQuery)
}

/**
 * Search over any research source (R6): the query is refused before the corpus is read when it can be; a query vector
 * is checked against the live model of the snapshot the source loads, which loads vectors only for it.
 */
export async function searchResearch(source: ResearchSource, query: unknown): Promise<ResearchResult> {
  const prepared = prepareResearchQuery(query)
  const vector: { unit: number[] | null; model: string | null } = { unit: null, model: null }
  if (prepared.text !== null && source.searchPrepared) {
    return source.searchPrepared(prepared)
  }
  const corpus = await source.load((meta) => {
    if (prepared.embedding !== undefined) {
      vector.unit = parseResearchEmbedding(meta.embeddingModel, prepared.embedding)
      vector.model = meta.embeddingModel
    }
    return { vectors: vector.unit !== null }
  })
  // The vector was checked against the snapshot it is ranked over.
  if (vector.unit !== null && vector.model !== corpus.embeddingModel) throw new PublicError("search refuses: embedding_model mismatch")
  return rankResearchCorpus(corpus, prepared, vector.unit)
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
