import { describe, expect, it } from "vitest"
import { PublicError } from "@/platform/http/publicError"
import { newStore, type SpineStore } from "@/platform/spine/store"
import { seedJudgment, seedTreatment } from "@/services/d4-2/draftingIntelligence"
import * as research from "@/services/d5-1/research"

/**
 * FA-D5-001 / FA-D5-002 at the D5-1 boundary: `searchCorpus` takes a validated query and returns ranked, bounded,
 * scored hits; `changeEmbeddingModel` needs confirmation and cannot leave the stored vectors behind. The inputs no
 * user route carries today (k, a query vector and its model) are exercised here; the WhatsApp path is in
 * tests/fa-d5.research-search.e2e.test.ts. Synthetic corpus, citations dated 2099.
 * Spec: docs/superpowers/specs/2026-10-18-fa-d5-research-search-design.md (R2, R4-R6, R8, R12).
 */

const LIVE = "text-embedding-3-small"
const DIM = 1536

// Called through loose types so the file also runs, and fails, against main's signatures (RED).
type Search = (store: SpineStore, query: unknown) => { items: Array<Record<string, unknown>>; k: number; mode: string }
type Switch = (store: SpineStore, next: unknown, opts?: unknown) => { previous: string; model: string }
const searchCorpus = research.searchCorpus as unknown as Search
const changeEmbeddingModel = research.changeEmbeddingModel as unknown as Switch

function unit(i: number): number[] {
  const v = new Array<number>(DIM).fill(0)
  v[i] = 1
  return v
}

function vec(parts: Record<number, number>): number[] {
  const v = new Array<number>(DIM).fill(0)
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x
  return v
}

function addJudgment(store: SpineStore, id: string, title: string, citation: string, vector?: number[], bench: "single" | "larger" = "single") {
  seedJudgment(store, id, title, bench, citation)
  if (vector) store.embeddings.push({ entityId: id, model: LIVE, vector })
}

/** N judgments about bail, each with its own unit vector. */
function bailCorpus(n: number): SpineStore {
  const store = newStore()
  for (let i = 0; i < n; i++) addJudgment(store, `j-${String(i).padStart(3, "0")}`, `Bail petition synthetic case ${i}`, `2099 SCMR ${1000 + i}`, unit(i))
  return store
}

function refusal(fn: () => unknown): PublicError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(PublicError)
    return err as PublicError
  }
  throw new Error("expected a refusal")
}

describe("searchCorpus: k is bounded (default 10, at most 50)", () => {
  it("defaults to 10 and honours 1 and 50", () => {
    const store = bailCorpus(60)
    const dflt = searchCorpus(store, { text: "bail" })
    expect(dflt.k).toBe(10)
    expect(dflt.items).toHaveLength(10)
    expect(searchCorpus(store, { text: "bail", k: 1 }).items).toHaveLength(1)
    expect(searchCorpus(store, { text: "bail", k: 50 }).items).toHaveLength(50)
    expect(research.RESEARCH_DEFAULT_K).toBe(10)
    expect(research.RESEARCH_MAX_K).toBe(50)
  })

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 51, 1e9, "10", null, true])("refuses k = %s", (k) => {
    const store = bailCorpus(3)
    expect(refusal(() => searchCorpus(store, { text: "bail", k })).message).toBe("research k must be an integer from 1 to 50")
  })
})

describe("searchCorpus: hostile queries are refused with fixed messages", () => {
  it.each([["text-embedding-3-small"], [null], [[]], [42], [{}], [{ k: 5 }]])("refuses query %j (not an object with text or embedding)", (query) => {
    expect(refusal(() => searchCorpus(bailCorpus(3), query)).message).toBe("research query must be an object with text or embedding")
  })

  it.each([42, { q: "bail" }, ["bail"]])("refuses non-string text %j", (text) => {
    expect(refusal(() => searchCorpus(bailCorpus(3), { text })).message).toBe("research query text must be a string")
  })

  it.each(["", "   ", "the of v", "...;;", "​​"])("refuses text with no search terms %j", (text) => {
    expect(refusal(() => searchCorpus(bailCorpus(3), { text })).message).toBe("research query has no search terms")
  })

  it("refuses text over 500 characters after whitespace collapse, without echoing it", () => {
    const text = `bail ${"zqxmarker ".repeat(60)}`
    const err = refusal(() => searchCorpus(bailCorpus(3), { text }))
    expect(err.message).toBe("research query exceeds 500 characters")
    expect(err.message).not.toContain("zqxmarker")
    // 500 characters exactly is accepted.
    const exact = `bail ${"z".repeat(495)}`
    expect(exact.length).toBe(500)
    expect(searchCorpus(bailCorpus(3), { text: exact }).items.length).toBeGreaterThan(0)
  })

  it("refuses a query embedding under another model (wrong embedding model), and accepts the live one", () => {
    const store = bailCorpus(3)
    const err = refusal(() => searchCorpus(store, { embedding: { model: "text-embedding-3-large", vector: unit(0) } }))
    expect(err.message).toBe("search refuses: embedding_model mismatch")
    // Positive control: the same vector under the live model is searched (main refuses every query object).
    expect(searchCorpus(store, { embedding: { model: LIVE, vector: unit(0) } }).items.map((h) => h.entityId)).toEqual(["j-000"])
  })

  it.each([3, 1535, 1537, 0])("refuses a query vector of dimension %i (wrong dimension)", (n) => {
    const err = refusal(() => searchCorpus(bailCorpus(3), { embedding: { model: LIVE, vector: new Array(n).fill(0.5) } }))
    expect(err.message).toBe("search refuses: embedding_dim mismatch")
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, "0.5"])("refuses a query vector holding %s", (bad) => {
    const vector: unknown[] = unit(1)
    vector[7] = bad
    expect(refusal(() => searchCorpus(bailCorpus(3), { embedding: { model: LIVE, vector } })).message).toBe(
      "research embedding vector must hold finite numbers"
    )
  })

  it("refuses a zero query vector", () => {
    expect(refusal(() => searchCorpus(bailCorpus(3), { embedding: { model: LIVE, vector: new Array(DIM).fill(0) } })).message).toBe(
      "research embedding vector must not be zero"
    )
  })

  it.each([
    ["no vector", { model: LIVE }],
    ["no model", { vector: unit(0) }],
    ["a string", "vec"],
    ["a numeric model", { model: 7, vector: unit(0) }],
    ["a string vector", { model: LIVE, vector: "1,2" }],
  ])(
    "refuses a malformed embedding (%s)",
    (_label, embedding) => {
      expect(refusal(() => searchCorpus(bailCorpus(3), { embedding })).message).toBe("research embedding must name a model and carry a vector")
    }
  )
})

describe("searchCorpus: the corpus integrity lock (G1-10) covers both legs", () => {
  it("refuses when corpus_metadata.embedding_dim is not 1536", () => {
    const store = bailCorpus(3)
    store.corpusMetadata.embedding_dim = "768"
    expect(refusal(() => searchCorpus(store, { text: "bail" })).message).toBe("search refuses: embedding_dim mismatch")
  })

  it("refuses when a stored row is under another model, or of another length", () => {
    const a = bailCorpus(3)
    a.embeddings.push({ entityId: "j-000", model: "text-embedding-3-large", vector: unit(0) })
    expect(refusal(() => searchCorpus(a, { text: "bail" })).message).toBe("search refuses: embedding_model mismatch")
    const b = bailCorpus(3)
    b.embeddings.push({ entityId: "j-000", model: LIVE, vector: [1, 2, 3] })
    expect(refusal(() => searchCorpus(b, { text: "bail" })).message).toBe("search refuses: embedding_dim mismatch")
  })

  it("refuses to score a non-finite stored vector; a text-only search does not read vectors", () => {
    const store = bailCorpus(3)
    store.embeddings[1].vector[5] = Number.NaN
    expect(refusal(() => searchCorpus(store, { embedding: { model: LIVE, vector: unit(0) } })).message).toBe(
      "search refuses: stored vector is not finite"
    )
    expect(searchCorpus(store, { text: "bail" }).items).toHaveLength(3)
  })

  it("an empty corpus answers an empty list, not an error", () => {
    expect(searchCorpus(newStore(), { text: "bail" })).toMatchObject({ items: [], k: 10, mode: "keyword" })
  })
})

describe("searchCorpus: ranking", () => {
  it("keyword: idf-weighted coverage; a distinctive term outranks a common one; misses are not hits", () => {
    const store = newStore()
    for (let i = 0; i < 8; i++) addJudgment(store, `j-state-${i}`, `The State versus accused number ${i}`, `2099 PCrLJ ${10 + i}`)
    addJudgment(store, "j-497", "Bail under section 497 CrPC", "2099 SCMR 497")
    addJudgment(store, "j-khula", "Khula decree", "2099 CLC 1")
    const out = searchCorpus(store, { text: "state 497" })
    expect(out.mode).toBe("keyword")
    expect(out.items[0]).toMatchObject({ entityId: "j-497", title: "Bail under section 497 CrPC", citation: "2099 SCMR 497", benchType: "single" })
    expect(out.items).toHaveLength(9)
    // Strictly above, not a tie-break: one match each, but "497" is rare and "state" is in eight judgments.
    expect(out.items[1].score as number).toBeLessThan(out.items[0].score as number)
    expect(out.items.map((h) => h.entityId)).not.toContain("j-khula")
    const scores = out.items.map((h) => h.score as number)
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i])
    expect(scores.every((s) => s > 0 && s < 1)).toBe(true)
  })

  it("semantic: the k nearest by cosine, in order; orthogonal judgments are not hits", () => {
    const store = bailCorpus(20)
    const out = searchCorpus(store, { embedding: { model: LIVE, vector: vec({ 4: 1, 9: 0.5, 2: 0.25 }) }, k: 5 })
    expect(out.mode).toBe("semantic")
    expect(out.items.map((h) => h.entityId)).toEqual(["j-004", "j-009", "j-002"])
    const norm = Math.sqrt(1 + 0.25 + 0.0625)
    expect(out.items[0].score).toBeCloseTo(1 / norm, 5)
    expect(out.items[1].score).toBeCloseTo(0.5 / norm, 5)
  })

  it("a similarity too small to show at 6 decimals is not a hit: no returned score is 0", () => {
    const store = bailCorpus(20)
    const out = searchCorpus(store, { embedding: { model: LIVE, vector: vec({ 4: 1, 9: 1e-7 }) }, k: 5 })
    expect(out.items.map((h) => h.entityId)).toEqual(["j-004"])
    expect(out.items.every((h) => (h.score as number) > 0)).toBe(true)
  })

  it("blended: 0.6 semantic + 0.4 keyword; strong on both legs beats strong on one", () => {
    const store = newStore()
    addJudgment(store, "j-both", "Bail on further inquiry", "2099 SCMR 1", unit(0))
    addJudgment(store, "j-sem", "Khula decree", "2099 CLC 2", vec({ 0: 1, 1: 0.2 }))
    addJudgment(store, "j-kw", "Bail on further inquiry refused", "2099 SCMR 3", unit(2))
    const out = searchCorpus(store, { text: "bail further inquiry", embedding: { model: LIVE, vector: unit(0) } })
    expect(out.mode).toBe("blended")
    expect(out.items.map((h) => h.entityId)).toEqual(["j-both", "j-sem", "j-kw"])
    expect(out.items[0].score).toBeCloseTo(1, 5)
    expect(out.items[1].score).toBeCloseTo(0.6 / Math.sqrt(1.04), 5)
    expect(out.items[2].score).toBeCloseTo(0.4, 5)
  })

  it("ties go to the more specific judgment, then to the lower id", () => {
    const store = newStore()
    addJudgment(store, "j-b", "Bail granted", "2099 SCMR 2")
    addJudgment(store, "j-c", "Bail granted on the facts of a long and winding case", "2099 SCMR 3")
    addJudgment(store, "j-a", "Bail granted", "2099 SCMR 4")
    expect(searchCorpus(store, { text: "bail" }).items.map((h) => h.entityId)).toEqual(["j-a", "j-b", "j-c"])
  })

  it("an embedding of an entity that is not a judgment is never a hit", () => {
    const store = bailCorpus(2)
    store.embeddings.push({ entityId: "section-ppc-302", model: LIVE, vector: unit(5) })
    expect(searchCorpus(store, { embedding: { model: LIVE, vector: unit(5) } }).items).toEqual([])
  })

  it("surfaces each hit's Module 33 treatment", () => {
    const store = newStore()
    addJudgment(store, "j-old", "Bail jurisprudence restated", "2099 SCMR 10")
    addJudgment(store, "j-new", "Larger bench on custody", "PLD 2099 SC 11", undefined, "larger")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")
    addJudgment(store, "j-ok", "Bail refused", "2099 SCMR 12")
    const out = searchCorpus(store, { text: "bail" })
    expect(Object.fromEntries(out.items.map((h) => [h.entityId, h.treatment]))).toEqual({ "j-old": "OVERRULED", "j-ok": "VERIFIED" })
  })
})

describe("changeEmbeddingModel (FA-D5-002): confirmation and the re-embed guard", () => {
  it.each([[undefined], [{}], [{ confirmed: false }], [{ confirmed: "yes" }], [{ confirmed: 1 }]])("refuses without confirmation (%j)", (opts) => {
    const store = newStore()
    expect(refusal(() => changeEmbeddingModel(store, "text-embedding-3-large", opts)).message).toBe(
      "embedding model change refuses: confirmation required"
    )
    expect(store.corpusMetadata.embedding_model).toBe(LIVE)
  })

  it.each(["", "   ", "x".repeat(101), "bad model", "model\n", "m;drop", 42, null])("refuses the model id %j", (next) => {
    const store = newStore()
    expect(refusal(() => changeEmbeddingModel(store, next, { confirmed: true })).message).toBe("embedding model change refuses: invalid model id")
    expect(store.corpusMetadata.embedding_model).toBe(LIVE)
  })

  it("refuses a switch to the model already live", () => {
    expect(refusal(() => changeEmbeddingModel(newStore(), LIVE, { confirmed: true })).message).toBe("embedding model change refuses: model unchanged")
  })

  it("refuses a confirmed switch while stored vectors are under the old model, and search keeps working", () => {
    const store = bailCorpus(3)
    expect(refusal(() => changeEmbeddingModel(store, "text-embedding-3-large", { confirmed: true })).message).toBe(
      "embedding model change refuses: stored vectors are not under the new model; re-embed first"
    )
    expect(store.corpusMetadata.embedding_model).toBe(LIVE)
    expect(searchCorpus(store, { text: "bail" }).items).toHaveLength(3)
  })

  it("switches a confirmed, valid model on a corpus with no vectors", () => {
    const store = newStore()
    expect(changeEmbeddingModel(store, "text-embedding-3-large", { confirmed: true })).toEqual({ previous: LIVE, model: "text-embedding-3-large" })
    expect(store.corpusMetadata.embedding_model).toBe("text-embedding-3-large")
  })

  it("switches once the corpus side has re-embedded every vector under the new model, and that restores search", () => {
    const store = bailCorpus(3)
    for (const row of store.embeddings) row.model = "openai/text-embedding-3-large"
    expect(refusal(() => searchCorpus(store, { text: "bail" })).message).toBe("search refuses: embedding_model mismatch")
    expect(changeEmbeddingModel(store, "openai/text-embedding-3-large", { confirmed: true }).model).toBe("openai/text-embedding-3-large")
    expect(searchCorpus(store, { text: "bail" }).items).toHaveLength(3)
  })
})
