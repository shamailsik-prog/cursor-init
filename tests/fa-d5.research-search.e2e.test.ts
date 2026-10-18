import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * FA-D5-001 / FA-D2WA-001 / FA-D5-002, end to end through the real user path: WhatsApp `/research <query>` as
 * `POST /api/d2/court-ops {action: "whatsapp_command"}`, through the real route handler and `withSession` in
 * Firebase mode (Bearer ID tokens; firebase-admin's verifyIdToken is the only mock, as in Gate G-2), so the caller is
 * the token's user and P5 `checkPermission` decides on the real users of two firms.
 *
 * On main the handler answers the constant `research: []` whatever the query and the corpus hold, and the embedding
 * model can be switched with no confirmation. The corpus is synthetic published law (citations dated 2099), loaded
 * straight into the runtime read model: no route loads the corpus (spec residual 5).
 * Spec: docs/superpowers/specs/2026-10-18-fa-d5-research-search-design.md.
 */

const verifyIdToken = vi.fn()
vi.mock("firebase-admin/app", () => ({
  getApps: () => [],
  initializeApp: () => ({ name: "fa-d5-test-app" }),
  applicationDefault: () => ({}),
}))
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }))

import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { resetSessionStateForTests } from "@/platform/p5/session"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import type { SpineStore } from "@/platform/spine/store"
import { seedJudgment, seedTreatment } from "@/services/d4-2/draftingIntelligence"
import { changeEmbeddingModel } from "@/services/d5-1/research"
import {
  FIRM_A,
  FIRM_A_USERS,
  FIRM_B_USERS,
  firmMarkers,
  post,
  seedFirm,
  send,
  tokenOf,
  user,
  type Call,
  type FirmSeed,
  type Sent,
} from "./g2/harness"

const LIVE_MODEL = "text-embedding-3-small"
const DIM = 1536

type Hit = { n: number; entityId: string; title: string; citation: string | null; treatment: string; score: number }

// ---------------------------------------------------------------------------
// Synthetic corpus (published law; no client or matter data; citations dated 2099)
// ---------------------------------------------------------------------------

/** Two judgments carry every term of "bail 497 CrPC"; thirteen more carry some; forty carry none. */
const BAIL_ALL = [
  ["j-2099-bail-01", "Bail after arrest under section 497 CrPC refused for want of reasonable grounds"],
  ["j-2099-bail-02", "Post-arrest bail under section 497 CrPC granted on further inquiry"],
] as const
const BAIL_SOME = [
  ["j-2099-bail-03", "Bail on statutory delay under the third proviso to section 497"],
  ["j-2099-bail-04", "Bail where the co-accused was released, section 497"],
  ["j-2099-bail-05", "Section 497 bail for a woman accused"],
  ["j-2099-bail-06", "Bail cancellation on misuse of the concession, section 497"],
  ["j-2099-bail-07", "Pre-arrest bail on mala fide grounds"],
  ["j-2099-bail-08", "Bail in a non-bailable offence of cheating"],
  ["j-2099-bail-09", "Bail refused in a narcotics trafficking case"],
  ["j-2099-bail-10", "Bail after charge framed in a murder trial"],
  ["j-2099-bail-11", "Bail granted to a juvenile offender"],
  ["j-2099-bail-12", "Bail and the rule of consistency among co-accused"],
  ["j-2099-bail-13", "Bail in a cyber crime matter"],
  ["j-2099-crpc-14", "Section 497 CrPC and the meaning of reasonable grounds"],
  ["j-2099-crpc-15", "Section 497 CrPC read with section 498"],
] as const
const RELEVANT = [...BAIL_ALL, ...BAIL_SOME].map(([id]) => id)
const KHULA = Array.from({ length: 40 }, (_, i) => [`j-2099-khula-${String(i).padStart(2, "0")}`, `Khula decree in a family suit with dower returned, synthetic case ${i}`] as const)
const LARGER = ["j-2099-larger-01", "Larger bench reference on custody of minors"] as const

const citationOf = (id: string, i: number) => (id.includes("khula") ? `2099 CLC ${200 + i}` : `2099 SCMR ${101 + i}`)

/** A one-hot vector per judgment, under the live model, so the corpus holds embeddings (the G1-10 lock is live). */
function oneHot(i: number): number[] {
  const v = new Array<number>(DIM).fill(0)
  v[i % DIM] = 1
  return v
}

function loadCorpus(store: SpineStore): void {
  store.judgments.clear()
  store.treatments = []
  store.embeddings = []
  store.corpusMetadata.embedding_model = LIVE_MODEL
  store.corpusMetadata.embedding_dim = String(DIM)
  const all = [...BAIL_ALL, ...BAIL_SOME, ...KHULA]
  all.forEach(([id, title], i) => {
    seedJudgment(store, id, title, "single", citationOf(id, id.includes("khula") ? i - 15 : i))
    store.embeddings.push({ entityId: id, model: LIVE_MODEL, vector: oneHot(i) })
  })
  seedJudgment(store, LARGER[0], LARGER[1], "larger", "PLD 2099 SC 900")
  store.embeddings.push({ entityId: LARGER[0], model: LIVE_MODEL, vector: oneHot(all.length) })
  // A larger bench overruled bail-01: research must surface that, not hide it.
  seedTreatment(store, LARGER[0], "j-2099-bail-01", "overruled", "larger")
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const WA = (command: string, extra: Record<string, unknown> = {}): Call => post("/api/d2/court-ops", { action: "whatsapp_command", command, ...extra })

async function research(as: string, query: string): Promise<Sent> {
  return send(user(as), WA(`/research ${query}`))
}

function hitsOf(res: Sent): Hit[] {
  const body = res.body as { result?: { result?: { research?: Hit[] } } }
  return body.result?.result?.research ?? []
}

const errorOf = (res: Sent) => (res.body as { error?: string }).error ?? ""

function installVerifier(): void {
  const table = new Map([...FIRM_A_USERS, ...FIRM_B_USERS].map((u) => [tokenOf(u.id), u]))
  verifyIdToken.mockReset()
  verifyIdToken.mockImplementation(async (token: string) => {
    const u = table.get(token)
    if (!u) throw new Error("invalid token")
    return { uid: u.id, firmId: u.firmId, role: u.role, clearanceLevel: u.clearanceLevel }
  })
}

let A: FirmSeed

beforeAll(async () => {
  vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
  vi.stubEnv("FIREBASE_PROJECT_ID", "demo-sikander")
  vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "memory")
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
  installVerifier()
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  for (const u of [...FIRM_A_USERS, ...FIRM_B_USERS]) {
    store.users.set(u.id, u)
    await repos.users.upsert(u)
  }
  // Firm A's client, matter, documents and tenancy rows, through the real routes (the G-2 seed): the leak markers.
  // The seed opens its matter through the frozen Next D1 write path (Erratum E-40), as G-2 does; the flag is on for
  // the seed only, and the research requests below run with the production default (off).
  vi.stubEnv("SIKANDER_FLAG_LEGACY_D1_NEXT_WRITES", "true")
  A = await seedFirm(FIRM_A, "alpha")
  vi.stubEnv("SIKANDER_FLAG_LEGACY_D1_NEXT_WRITES", "false")
}, 120_000)

beforeEach(() => {
  loadCorpus(getRuntimeStore())
})

afterAll(() => {
  vi.unstubAllEnvs()
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
})

// ---------------------------------------------------------------------------
// (a) + (b): the query drives bounded, ranked, permission-checked results
// ---------------------------------------------------------------------------

describe("WhatsApp /research <query> through POST /api/d2/court-ops (FA-D2WA-001, FA-D5-001)", () => {
  it("returns the judgments relevant to the query, ranked by score, capped at 10, numbered, each with its treatment", async () => {
    const res = await research("clerk_a", "bail 497 CrPC")
    expect(res.status).toBe(200)
    const hits = hitsOf(res)
    // Fifteen judgments are relevant; the reply is capped at the default k of 10.
    expect(hits).toHaveLength(10)
    expect(hits.map((h) => h.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    for (const h of hits) {
      expect(RELEVANT).toContain(h.entityId)
      expect(h.title.toLowerCase()).toMatch(/bail|497|crpc/)
      expect(h.score).toBeGreaterThan(0)
      expect(h.score).toBeLessThanOrEqual(1)
    }
    expect(hits.some((h) => h.entityId.includes("khula") || h.entityId.includes("larger"))).toBe(false)
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
    // The two judgments carrying every query term come first, at full coverage.
    expect(hits.slice(0, 2).map((h) => h.entityId).sort()).toEqual(BAIL_ALL.map(([id]) => id).sort())
    expect(hits[0].score).toBe(1)
    expect(hits[1].score).toBe(1)
    expect(hits[2].score).toBeLessThan(1)
    // Module 18: treatment surfaced with the results (a larger bench overruled bail-01).
    expect(hits.find((h) => h.entityId === "j-2099-bail-01")?.treatment).toBe("OVERRULED")
    expect(hits.find((h) => h.entityId === "j-2099-bail-02")?.treatment).toBe("VERIFIED")
    expect(hits.find((h) => h.entityId === "j-2099-bail-01")?.citation).toBe("2099 SCMR 101")
  })

  it("answers a different query with a different result set: the reply is a function of the query", async () => {
    const khula = hitsOf(await research("associate_a", "khula dower"))
    expect(khula).toHaveLength(10)
    expect(khula.every((h) => h.entityId.includes("khula"))).toBe(true)
    const bail = hitsOf(await research("associate_a", "bail"))
    expect(bail.length).toBeGreaterThan(0)
    expect(bail.every((h) => RELEVANT.includes(h.entityId))).toBe(true)
  })

  it("ranks the judgment whose citation the query names first", async () => {
    const hits = hitsOf(await research("partner_a", "2099 SCMR 107"))
    expect(hits[0]).toMatchObject({ n: 1, entityId: "j-2099-bail-07", citation: "2099 SCMR 107", score: 1 })
    expect(hits.slice(1).every((h) => h.score < 1)).toBe(true)
  })

  it("folds Urdu (Extended Arabic-Indic) digits, so '۴۹۷' finds what '497' finds", async () => {
    const ascii = hitsOf(await research("partner_a", "bail 497"))
    const urdu = hitsOf(await research("partner_a", "bail ۴۹۷"))
    expect(ascii.length).toBeGreaterThan(0)
    expect(urdu).toEqual(ascii)
  })

  it("runs the P5 research check for the request, and audits it", async () => {
    const store = getRuntimeStore()
    const before = store.audit.filter((r) => r.action === "permission_check" && r.actorId === "clerk_a" && r.reason === "allow:research:ok").length
    const res = await research("clerk_a", "bail")
    expect(res.status).toBe(200)
    const after = store.audit.filter((r) => r.action === "permission_check" && r.actorId === "clerk_a" && r.reason === "allow:research:ok").length
    expect(after).toBe(before + 1)
  })
})

// ---------------------------------------------------------------------------
// (c): callers without the research permission stay denied
// ---------------------------------------------------------------------------

describe("callers without the research permission are denied (c)", () => {
  const DENIED = ["client_a", "intern_a", "accounts_a", "client_b", "intern_b", "accounts_b"]
  const QUERIES = ["bail 497 CrPC", "the of v", "x".repeat(600)]

  it.each(DENIED)("%s gets 403 and no corpus row, whatever the query", async (id) => {
    for (const q of QUERIES) {
      const res = await research(id, q)
      expect([id, q.slice(0, 12), res.status]).toEqual([id, q.slice(0, 12), 403])
      expect(errorOf(res)).toBe("permission denied")
      expect(hitsOf(res)).toEqual([])
      expect(res.text).not.toContain("j-2099-")
    }
  })
})

// ---------------------------------------------------------------------------
// (d): cross-firm isolation (G-2)
// ---------------------------------------------------------------------------

describe("cross-firm isolation (d)", () => {
  it("a firm-B partner who types firm A's matter title gets corpus hits only, and no firm-A identifier", async () => {
    const call = WA(`/research ${A.matterTitle} bail`)
    const res = await send(user("partner_b"), call)
    expect(res.status).toBe(200)
    const hits = hitsOf(res)
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) {
      expect(Object.keys(h).sort()).toEqual(["citation", "entityId", "n", "score", "title", "treatment"])
      expect(getRuntimeStore().judgments.has(h.entityId)).toBe(true)
    }
    // Every id-like field of every firm-A row in the store, plus its names; an echo of what the caller sent is not a leak.
    const sent = JSON.stringify(call)
    expect(firmMarkers(A).filter((m) => res.text.includes(m) && !sent.includes(m))).toEqual([])
  })

  it("a firm-B caller cannot borrow firm A's identity or firm header", async () => {
    const asFirmA = await send(user("partner_b"), { ...WA("/research bail"), firmHeader: FIRM_A })
    expect(asFirmA.status).toBe(403)
    expect(asFirmA.text).toContain("FIRM_MISMATCH")
    const asPartnerA = await send(user("partner_b"), WA("/research bail", { actorId: "partner_a" }))
    expect(asPartnerA.status).toBe(403)
    expect(asPartnerA.text).toContain("IDENTITY_MISMATCH")
  })
})

// ---------------------------------------------------------------------------
// (e): hostile inputs get a clean 4xx, never a 200 or a 5xx
// ---------------------------------------------------------------------------

describe("hostile queries get a clean 400 (e)", () => {
  it.each(["/research", "/research    "])("%j is outside the command grammar: 400", async (command) => {
    const res = await send(user("associate_a"), WA(command))
    expect(res.status).toBe(400)
    expect(errorOf(res)).toMatch(/unsupported command grammar/)
  })

  it.each(["...;;", "the of v", "  - , ."])("a query with no search terms (%j) is refused: 400", async (q) => {
    const res = await research("associate_a", q)
    expect(res.status).toBe(400)
    expect(errorOf(res)).toBe("research query has no search terms")
  })

  it("an over-long query is refused, not truncated: 400, and the error does not echo it", async () => {
    const q = `bail ${"zqxmarker ".repeat(60)}`
    expect(q.trim().length).toBeGreaterThan(500)
    const res = await research("associate_a", q)
    expect(res.status).toBe(400)
    expect(errorOf(res)).toBe("research query exceeds 500 characters")
    expect(res.text).not.toContain("zqxmarker")
  })

  it("a corpus whose live model changed while embeddings exist refuses the search (wrong embedding model): 400", async () => {
    // corpus_metadata lives in the corpus database (Annex A) and is changed there, out of band (G1-10).
    getRuntimeStore().corpusMetadata.embedding_model = "text-embedding-3-large"
    const res = await research("associate_a", "bail")
    expect(res.status).toBe(400)
    expect(errorOf(res)).toBe("search refuses: embedding_model mismatch")
    expect(hitsOf(res)).toEqual([])
  })

  it("a stored vector of the wrong dimension refuses the search: 400", async () => {
    getRuntimeStore().embeddings.push({ entityId: "j-2099-bail-03", model: LIVE_MODEL, vector: [0.1, 0.2, 0.3] })
    const res = await research("associate_a", "bail")
    expect(res.status).toBe(400)
    expect(errorOf(res)).toBe("search refuses: embedding_dim mismatch")
  })
})

// ---------------------------------------------------------------------------
// FA-D5-002 through the user path
// ---------------------------------------------------------------------------

describe("FA-D5-002: the live embedding model cannot be switched out from under research", () => {
  type Switch = (store: SpineStore, next: string, opts?: { confirmed?: unknown }) => unknown
  const change = changeEmbeddingModel as unknown as Switch

  it("an unconfirmed switch is refused and /research keeps answering with the same hits", async () => {
    const before = hitsOf(await research("clerk_a", "bail 497 CrPC"))
    expect(before).toHaveLength(10)
    const store = getRuntimeStore()
    expect(() => change(store, "text-embedding-3-large")).toThrow("embedding model change refuses: confirmation required")
    expect(store.corpusMetadata.embedding_model).toBe(LIVE_MODEL)
    const after = await research("clerk_a", "bail 497 CrPC")
    expect(after.status).toBe(200)
    expect(hitsOf(after)).toEqual(before)
  })

  it("a confirmed switch is refused while the stored vectors are under the old model (re-embed first)", async () => {
    const store = getRuntimeStore()
    expect(() => change(store, "text-embedding-3-large", { confirmed: true })).toThrow(
      "embedding model change refuses: stored vectors are not under the new model; re-embed first"
    )
    expect(store.corpusMetadata.embedding_model).toBe(LIVE_MODEL)
    expect((await research("clerk_a", "bail")).status).toBe(200)
  })
})
