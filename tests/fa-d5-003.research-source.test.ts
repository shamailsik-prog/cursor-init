import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "@/app/api/d2/court-ops/route"
import { newStore, type SpineStore } from "@/platform/spine/store"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { seedJudgment, seedTreatment } from "@/services/d4-2/draftingIntelligence"

/**
 * FA-D5-003 at the research seam (spec R6, R7, R10, R13, R14), without a database:
 * - which source research reads: Postgres by default, the in-memory store only when explicitly selected outside a
 *   hosted runtime, and an unconfigured or misconfigured source fails closed as `corpus_unavailable`;
 * - the court-ops route answers that as 503, never as an empty list (on main: 200 with `research: []`);
 * - P5 runs before the corpus is read;
 * - the shared ranking over a corpus whose judgments carry several citations, and the Postgres verdict rule.
 * The new modules are loaded dynamically, so on main each test fails at its assertion rather than the file failing to load.
 */

type CorpusUnavailable = Error & { reason: string }
type Doc = { id: string; title: string; citations: readonly string[]; benchType: "single" | "division" | "full" | "larger" }
type Corpus = {
  embeddingModel: string
  embeddingDim: string
  documents: readonly Doc[]
  storedVectors: ReadonlyArray<{ model: string; dim: number }>
  vectors: ReadonlyMap<string, readonly number[]> | null
  verdicts(ids: readonly string[]): ReadonlyMap<string, string>
}
type Source = { load(plan: (meta: { embeddingModel: string; embeddingDim: string }) => { vectors: boolean }): Promise<Corpus> }
type SourceModule = {
  CorpusUnavailableError: new (reason: string) => CorpusUnavailable
  activeResearchSource(store: SpineStore, env?: Record<string, string | undefined>): Source
  memoryResearchSource(store: SpineStore): Source
  resetResearchSourceForTests(): Promise<void>
  noteCorpusUnavailable(reason: string, now?: number): boolean
}
type ResearchModule = {
  searchResearch(source: Source, query: unknown): Promise<{ items: Array<Record<string, unknown>>; k: number; mode: string }>
}
type WhatsAppModule = {
  handleWhatsApp(store: SpineStore, userId: string, command: string, research?: Source): Promise<{ ok: boolean; denied?: boolean; research?: Array<Record<string, unknown>> }>
}
type VerdictModule = {
  researchVerdicts(
    benchById: ReadonlyMap<string, Doc["benchType"]>,
    overrulings: ReadonlyArray<{ treatedId: string; recordedBench: Doc["benchType"]; treatingBench: Doc["benchType"] }>,
    pending: ReadonlySet<string>
  ): (ids: readonly string[]) => ReadonlyMap<string, string>
}

const spec = (name: string) => name
const sourceModule = async () => (await import(/* @vite-ignore */ spec("@/services/d5-1/researchCorpus"))) as SourceModule
const researchModule = async () => (await import(/* @vite-ignore */ spec("@/services/d5-1/research"))) as unknown as ResearchModule
const whatsappModule = async () => (await import(/* @vite-ignore */ spec("@/services/d2-1/whatsapp"))) as unknown as WhatsAppModule
const verdictModule = async () => (await import(/* @vite-ignore */ spec("@/platform/corpus/pgResearchCorpus"))) as unknown as VerdictModule

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return String((e as { reason?: unknown }).reason ?? `threw ${(e as Error).name}: ${(e as Error).message}`)
  }
  return "loaded"
}

const keyword = () => ({ vectors: false })

function bailStore(): SpineStore {
  const store = newStore()
  seedJudgment(store, "j-1", "Bail after arrest under section 497 CrPC", "single", "2099 SCMR 4101")
  seedJudgment(store, "j-2", "Khula decree with dower returned", "single", "2099 CLC 4102")
  seedJudgment(store, "j-larger", "Larger bench reference", "larger", "PLD 2099 SC 4900")
  seedTreatment(store, "j-larger", "j-1", "overruled", "larger")
  return store
}

describe("research source selection (R13)", () => {
  afterEach(async () => {
    await (await sourceModule()).resetResearchSourceForTests()
  })

  it.each([
    ["nothing configured", { NODE_ENV: "test" }, "not_configured"],
    ["postgres selected, no URL", { NODE_ENV: "test", SIKANDER_RESEARCH_CORPUS: "postgres" }, "not_configured"],
    ["a malformed URL", { NODE_ENV: "test", SIKANDER_CORPUS_RESEARCH_READER_URL: "mysql://u:p@127.0.0.1/db", SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" }, "misconfigured"],
    ["no staleness bound", { NODE_ENV: "test", SIKANDER_CORPUS_RESEARCH_READER_URL: "postgres://u:p@127.0.0.1:5/db" }, "misconfigured"],
    ["plaintext to a remote host", { NODE_ENV: "test", SIKANDER_CORPUS_RESEARCH_READER_URL: "postgres://u:p@corpus.example.invalid/db", SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" }, "misconfigured"],
    ["plaintext in production", { NODE_ENV: "production", SIKANDER_CORPUS_RESEARCH_READER_URL: "postgres://u:p@127.0.0.1:5/db", SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" }, "misconfigured"],
    ["an unknown source", { NODE_ENV: "test", SIKANDER_RESEARCH_CORPUS: "sqlite" }, "misconfigured"],
    ["memory in production", { NODE_ENV: "production", SIKANDER_RESEARCH_CORPUS: "memory" }, "misconfigured"],
    ["memory with NODE_ENV unset", { SIKANDER_RESEARCH_CORPUS: "memory" }, "misconfigured"],
    ["memory on Vercel", { NODE_ENV: "development", SIKANDER_RESEARCH_CORPUS: "memory", VERCEL: "1" }, "misconfigured"],
    ["memory on Cloud Run", { NODE_ENV: "test", SIKANDER_RESEARCH_CORPUS: "memory", K_SERVICE: "svc" }, "misconfigured"],
    ["memory in a Functions process", { NODE_ENV: "test", SIKANDER_RESEARCH_CORPUS: "memory", FUNCTION_TARGET: "api" }, "misconfigured"],
    ["memory with FIREBASE_CONFIG", { NODE_ENV: "test", SIKANDER_RESEARCH_CORPUS: "memory", FIREBASE_CONFIG: "{}" }, "misconfigured"],
    ["memory on App Engine", { NODE_ENV: "test", SIKANDER_RESEARCH_CORPUS: "memory", GAE_SERVICE: "x" }, "misconfigured"],
    ["memory with VERCEL_ENV", { NODE_ENV: "test", SIKANDER_RESEARCH_CORPUS: "memory", VERCEL_ENV: "preview" }, "misconfigured"],
  ])("%s: the load fails closed as corpus_unavailable (%s)", async (_label, env, reason) => {
    const mod = await sourceModule()
    const err = await (async () => {
      try {
        await mod.activeResearchSource(bailStore(), env).load(keyword)
      } catch (e) {
        return e
      }
      return null
    })()
    expect(err).toBeInstanceOf(mod.CorpusUnavailableError)
    expect((err as CorpusUnavailable).reason).toBe(reason)
    // The message is the reason token only: no URL, password or host.
    expect((err as Error).message).toBe(`corpus_unavailable:${reason}`)
  })

  it.each([
    ["test", { NODE_ENV: "test", SIKANDER_RESEARCH_CORPUS: "memory" }],
    ["development, spelled loosely", { NODE_ENV: "development", SIKANDER_RESEARCH_CORPUS: " Memory " }],
  ])("memory selected explicitly in %s reads the runtime store", async (_label, env) => {
    const mod = await sourceModule()
    const corpus = await mod.activeResearchSource(bailStore(), env).load(keyword)
    expect(corpus.documents.map((d) => d.id).sort()).toEqual(["j-1", "j-2", "j-larger"])
  })

  it("logs the reason at most once per reason per 30 s", async () => {
    const mod = await sourceModule()
    expect(mod.noteCorpusUnavailable("unreachable", 1_000_000)).toBe(true)
    expect(mod.noteCorpusUnavailable("unreachable", 1_029_999)).toBe(false)
    expect(mod.noteCorpusUnavailable("stale", 1_029_999)).toBe(true)
    expect(mod.noteCorpusUnavailable("unreachable", 1_030_000)).toBe(true)
  })
})

describe("the court-ops route answers an unavailable corpus as 503, never an empty list (R10)", () => {
  const send = (command: string, key: string) =>
    POST(
      new Request("http://127.0.0.1/api/d2/court-ops", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ action: "whatsapp_command", actorId: "associate_a", command }),
      })
    )

  beforeEach(() => {
    vi.stubEnv("SIKANDER_RESEARCH_CORPUS", "")
    vi.stubEnv("SIKANDER_CORPUS_RESEARCH_READER_URL", "")
    const store = getRuntimeStore()
    seedJudgment(store, "j-route", "Bail under section 497 CrPC", "single", "2099 SCMR 4201")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetRuntimeStoreForTests()
  })

  it("no reader configured: 503 corpus_unavailable", async () => {
    const res = await send("/research bail 497", "5d0f9a8e-0d5c-4c39-9f37-2f2a8d6f0e01")
    const body = (await res.json()) as { code?: string; error?: string; result?: unknown }
    expect([res.status, body.code, body.error]).toEqual([503, "corpus_unavailable", "research corpus unavailable"])
    expect(body.result).toBeUndefined()
  })

  it("the in-memory store selected explicitly: 200 with the hit", async () => {
    vi.stubEnv("SIKANDER_RESEARCH_CORPUS", "memory")
    const res = await send("/research bail 497", "5d0f9a8e-0d5c-4c39-9f37-2f2a8d6f0e02")
    const body = (await res.json()) as { result?: { result?: { research?: Array<{ entityId: string }> } } }
    expect(res.status).toBe(200)
    expect(body.result?.result?.research?.map((h) => h.entityId)).toEqual(["j-route"])
  })

  it("a client is 403 before any corpus read, configured or not", async () => {
    const res = await POST(
      new Request("http://127.0.0.1/api/d2/court-ops", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "5d0f9a8e-0d5c-4c39-9f37-2f2a8d6f0e03" },
        body: JSON.stringify({ action: "whatsapp_command", actorId: "client_a", command: "/research bail" }),
      })
    )
    expect(res.status).toBe(403)
  })
})

describe("handleWhatsApp reads research through a source, after P5 (R14)", () => {
  it("a denied caller costs no corpus read; an allowed one gets the source's ranked hits; a failure propagates", async () => {
    const { handleWhatsApp } = await whatsappModule()
    const { memoryResearchSource, CorpusUnavailableError } = await sourceModule()
    const store = getRuntimeStore()
    store.users.set("intern_a", { id: "intern_a", firmId: "firmA", role: "intern", clearanceLevel: "internal", active: true })
    seedJudgment(store, "j-wa", "Bail under section 497", "single", "2099 SCMR 4301")
    let loads = 0
    const counting: Source = {
      load: async (plan) => {
        loads += 1
        return memoryResearchSource(store).load(plan)
      },
    }
    try {
      expect(await handleWhatsApp(store, "client_a", "/research bail", counting)).toEqual({ ok: false, denied: true })
      expect(await handleWhatsApp(store, "intern_a", "/research bail", counting)).toEqual({ ok: false, denied: true })
      expect(loads).toBe(0)
      const ok = await handleWhatsApp(store, "associate_a", "/research bail", counting)
      expect(loads).toBe(1)
      expect(ok).toMatchObject({ ok: true, research: [{ n: 1, entityId: "j-wa", citation: "2099 SCMR 4301", treatment: "VERIFIED" }] })
      const failing: Source = { load: async () => Promise.reject(new CorpusUnavailableError("unreachable")) }
      expect(await reasonOf(handleWhatsApp(store, "associate_a", "/research bail", failing))).toBe("unreachable")
    } finally {
      resetRuntimeStoreForTests()
    }
  })
})

describe("one ranking for both sources (R6): judgments with several citations", () => {
  const corpus: Corpus = {
    embeddingModel: "text-embedding-3-small",
    embeddingDim: "1536",
    documents: [
      { id: "a", title: "Bail on further inquiry", citations: ["2099 SCMR 4401", "PLD 2099 SC 4402"], benchType: "division" },
      { id: "b", title: "Bail refused for want of grounds", citations: ["2099 SCMR 4403"], benchType: "division" },
      { id: "c", title: "Khula decree", citations: [], benchType: "single" },
    ],
    storedVectors: [],
    vectors: null,
    verdicts: (ids) => new Map(ids.map((id) => [id, id === "b" ? "OVERRULED" : "VERIFIED"])),
  }
  const source: Source = { load: async (plan) => (plan({ embeddingModel: corpus.embeddingModel, embeddingDim: corpus.embeddingDim }), corpus) }

  it("R4a matches any citation of a judgment and shows the one cited", async () => {
    const { searchResearch } = await researchModule()
    const second = await searchResearch(source, { text: "PLD 2099 SC 4402" })
    expect(second.items[0]).toMatchObject({ entityId: "a", citation: "PLD 2099 SC 4402", score: 1 })
    const first = await searchResearch(source, { text: "2099 SCMR 4401" })
    expect(first.items[0]).toMatchObject({ entityId: "a", citation: "2099 SCMR 4401", score: 1 })
  })

  it("keyword terms cover every citation; without R4a the first citation is shown; no citation reads null", async () => {
    const { searchResearch } = await researchModule()
    const byNumber = await searchResearch(source, { text: "4402" })
    expect(byNumber.items.map((h) => [h.entityId, h.citation])).toEqual([["a", "2099 SCMR 4401"]])
    const khula = await searchResearch(source, { text: "khula" })
    expect(khula.items).toEqual([{ entityId: "c", title: "Khula decree", citation: null, benchType: "single", score: 1, treatment: "VERIFIED" }])
    const bail = await searchResearch(source, { text: "bail" })
    expect(bail.items.find((h) => h.entityId === "b")?.treatment).toBe("OVERRULED")
  })

  it("a query the search refuses is refused before the corpus is read", async () => {
    const { searchResearch } = await researchModule()
    let loads = 0
    const counting: Source = { load: async (plan) => ((loads += 1), source.load(plan)) }
    await expect(searchResearch(counting, { text: "the of v" })).rejects.toThrow("research query has no search terms")
    await expect(searchResearch(counting, { text: "bail", k: 0 })).rejects.toThrow("research k must be an integer from 1 to 50")
    expect(loads).toBe(0)
  })

  it("a query vector is checked against the corpus's live model, and the vectors are loaded only for it", async () => {
    const { searchResearch } = await researchModule()
    const plans: boolean[] = []
    const watching: Source = { load: async (plan) => (plans.push(plan({ embeddingModel: corpus.embeddingModel, embeddingDim: "1536" }).vectors), corpus) }
    await searchResearch(watching, { text: "bail" })
    await expect(searchResearch(watching, { embedding: { model: "text-embedding-3-large", vector: [1] } })).rejects.toThrow(
      "search refuses: embedding_model mismatch"
    )
    expect(plans).toEqual([false])
  })
})

describe("the Postgres verdict rule (R7): the F05 facts through Module 33", () => {
  it("OVERRULED by a larger bench, UNVERIFIED while an overruling is pending, and a pending one never hides a qualifying one", async () => {
    const { researchVerdicts } = await verdictModule()
    const bench = new Map<string, Doc["benchType"]>([["d", "division"], ["p", "division"], ["both", "division"], ["v", "single"], ["weak", "full"]])
    const verdicts = researchVerdicts(
      bench,
      [
        { treatedId: "d", recordedBench: "larger", treatingBench: "larger" },
        { treatedId: "both", recordedBench: "larger", treatingBench: "larger" },
        { treatedId: "weak", recordedBench: "division", treatingBench: "division" },
      ],
      new Set(["p", "both"])
    )
    expect(Object.fromEntries([...verdicts(["d", "p", "both", "v", "weak"]).entries()])).toEqual({
      d: "OVERRULED",
      p: "UNVERIFIED",
      both: "OVERRULED",
      v: "VERIFIED",
      weak: "UNVERIFIED",
    })
  })
})
