/**
 * FA-D5-003-R1-001 (HIGH), end to end through the production route at a realistic corpus size (spec §7, R19-R27, R35).
 *
 * WhatsApp `/research <query>` as `POST /api/d2/court-ops {action: "whatsapp_command"}` on production persistence
 * (Firestore and Auth emulators, real ID tokens, F02 dispatch asserted by `x-authority-path: functions`), against real
 * Postgres 16 + pgvector holding 25,000+ visible judgments: the FA-D5-003 fixture published by the F19 CLI, plus a bulk
 * load written by the superuser and indexed by the F19 `index-terms` CLI (spec R21).
 *
 * Every answer must equal `rankResearchCorpus` over the whole visible corpus (read as the superuser through the same
 * views), and the latency budget (R35) must hold: the reader's, per search against this Postgres, and a sanity bound on
 * the route, whose own work (token verification, Firestore idempotency and audit writes on the emulators) is measured
 * with its floor (a query that matches nothing) but is not this finding's. On main every request is 503 `corpus_unavailable` (`row_cap`):
 * the reader loads the whole corpus and refuses anything over 20,000 judgments, for every firm.
 * Synthetic data only (2099).
 */
import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as courtOpsPost } from "@/app/api/d2/court-ops/route"
import { readCorpusReaderConfig } from "@/functions/src/d4/corpusReaderConfig"
import { PgResearchCorpus } from "@/platform/corpus/pgResearchCorpus"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { searchResearch, type ResearchCorpus } from "@/services/d5-1/research"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { deleteFirmRows } from "@/tests/helpers/firm-cleanup"
import { HAS_AUTH_FIRESTORE_EMULATORS } from "@/tests/helpers/emulator-require"
import { FA_D5_003_BATCH, FA_D5_003_SUITE, type ResearchDb, createResearchDb } from "@/tests/helpers/fa-d5-003-corpus"
import { loadTruthCorpus, seedScaleCorpus, truthSource, type ScaleCounts } from "@/tests/helpers/fa-d5-003-scale"

if (FA_D5_003_SUITE && !HAS_AUTH_FIRESTORE_EMULATORS) {
  throw new Error("the FA-D5-003 scale e2e needs the Auth and Firestore emulators: run it with `npm run test:fa-d5-003`")
}

const SLOW = 600_000
/** At least 25,000 visible judgments (the brief), the fixture's included. */
const BULK = 25_000
const RESEARCH_ENV = [
  "SIKANDER_RESEARCH_CORPUS",
  "SIKANDER_CORPUS_RESEARCH_READER_URL",
  "SIKANDER_CORPUS_RESEARCH_READER_CA",
  "SIKANDER_CORPUS_MAX_STALENESS_HOURS",
] as const
/** The reader's latency budget for one keyword search at 25,000+ visible judgments (spec R35). */
const READER_MEDIAN_MS = 300
const READER_MAX_MS = 1000
/** The route's sanity bound (spec R35): far under the 5 s statement timeout, whatever the emulators and the host add. */
const ROUTE_MEDIAN_MS = 1000
const ROUTE_MAX_MS = 3000

type Hit = { n: number; entityId: string; title: string; citation: string | null; treatment: string; score: number }
type Actor = { firmId: string; uid: string; token: string }
type Sent = { status: number; body: unknown; text: string; authority: string | null; ms: number }
type Verifier = (token: string) => Promise<{ uid: string } & Record<string, unknown>>

function useEmulatorVerifier(on: boolean): void {
  const seam = (session as unknown as { setIdTokenVerifierForTests?: (v: Verifier | null) => void }).setIdTokenVerifierForTests
  seam?.(on ? async (token) => (await adminAuth().verifyIdToken(token, true)) as Awaited<ReturnType<Verifier>> : null)
}

async function resetResearchSource(): Promise<void> {
  const mod = (await import("@/services/d5-1/researchCorpus")) as { resetResearchSourceForTests?: () => Promise<void> }
  await mod.resetResearchSourceForTests?.()
}

function restart(): void {
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
  session.resetSessionStateForTests()
  resetProductionFirestoreForTests()
}

/** The firms and auth users this suite creates, deleted in afterAll (audit F42: an emulator e2e deletes its firms). */
const createdFirms: string[] = []
const createdUids: string[] = []

async function provisionPartner(): Promise<Actor> {
  const ref = adminDb().collection("firms").doc()
  createdFirms.push(ref.id)
  await ref.create({ name: `FA-D5-003 scale firm ${ref.id}`, dataResidency: "PK", plan: "internal", rateLimits: { general: 10_000 } })
  const firmId = ref.id
  const uid = adminDb().collection("users").doc().id
  createdUids.push(uid)
  const email = `${uid.toLowerCase()}@example.test`
  const password = "emulator-pass-123"
  await adminAuth().createUser({ uid, email, password })
  await adminAuth().setCustomUserClaims(uid, { firmId, role: "partner", clearanceLevel: "internal" })
  await adminDb().collection("users").doc(uid).set({ id: uid, firmId, role: "partner", clearanceLevel: "internal", active: true })
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST is required")
  const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  if (!res.ok) throw new Error(`emulator sign-in failed: ${res.status}`)
  const { idToken } = (await res.json()) as { idToken: string }
  return { firmId, uid, token: idToken }
}

async function research(actor: Actor, query: string, key: string = randomUUID()): Promise<Sent> {
  const started = performance.now()
  const res = await courtOpsPost(
    new Request("http://127.0.0.1/api/d2/court-ops", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${actor.token}`,
        "X-Firm-Id": actor.firmId,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ action: "whatsapp_command", actorId: actor.uid, command: `/research ${query}` }),
    })
  )
  const text = await res.text()
  const ms = performance.now() - started
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { status: res.status, body, text, authority: res.headers.get("x-authority-path"), ms }
}

const hitsOf = (res: Sent): Hit[] =>
  (res.body as { result?: { result?: { research?: Hit[] } } } | null)?.result?.result?.research ?? []

function setResearchEnv(values: Partial<Record<(typeof RESEARCH_ENV)[number], string | undefined>>): void {
  for (const name of RESEARCH_ENV) {
    const value = values[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

/** What the route must answer: the whole-corpus ranking, as handleWhatsApp numbers it. */
async function expected(truth: ResearchCorpus, query: string): Promise<Hit[]> {
  const r = await searchResearch(truthSource(truth), { text: query })
  return r.items.map((h, i) => ({ n: i + 1, entityId: h.entityId, title: h.title, citation: h.citation, treatment: h.treatment, score: h.score }))
}

/** Queries that cut the corpus every way a WhatsApp user would: broad, flagship, specific, R4a by either reporter, a miss. */
const QUERIES: readonly string[] = [
  "bail",
  "bail 497 crpc",
  "Bail under section 497 CrPC",
  "custody minor guardian",
  "appeal revision writ petition tax",
  "khula dower nikah divorce maintenance",
  "section 123",
  `PLD 2099 SC ${100_000 + 4321}`,
  `2099 S.C.M.R. ${100_000 + 2468}`,
  "PLD 2099 SC 3202",
  "ضمانت",
  "muhammad bail",
  "zqnothingmatchesthis",
]

const saved: Record<string, string | undefined> = {}
let db: ResearchDb
let truth: ResearchCorpus
let counts: ScaleCounts
let partner: Actor

describe.runIf(FA_D5_003_SUITE)("FA-D5-003 R1-001: /research over 25,000+ visible judgments through the production route", () => {
  beforeAll(async () => {
    for (const n of RESEARCH_ENV) saved[n] = process.env[n]
    db = await createResearchDb("scale")
    // The fixture (hidden rows, treatments, pending overrulings), published by the F19 CLI; it stamps corpus_metadata.
    await db.publish(FA_D5_003_BATCH)
    counts = await seedScaleCorpus(db.admin, { judgments: BULK, vectors: 200, seed: 20261024 })
    const indexed = await db.indexTerms()
    if (indexed) expect([indexed.pending_titles, indexed.pending_citations]).toEqual([0, 0])
    truth = await loadTruthCorpus(db.admin, false)
    if (process.env.FA_D5_003_EVIDENCE) {
      fs.appendFileSync(process.env.FA_D5_003_EVIDENCE, `scale e2e corpus: ${JSON.stringify(counts)} index: ${JSON.stringify(indexed)}\n`)
    }
  }, SLOW)

  afterAll(async () => {
    try {
      const { remaining } = await deleteFirmRows({ firmIds: createdFirms, uids: createdUids })
      expect(remaining).toBe(0)
      expect((await adminAuth().getUsers(createdUids.map((uid) => ({ uid })))).users).toEqual([])
    } finally {
      setResearchEnv(saved)
      await resetResearchSource()
      await db?.drop()
    }
  }, SLOW)

  beforeEach(async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.GCLOUD_PROJECT ?? "demo-fa-d5-003-fu")
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-fa-d5-003-fu")
    setResearchEnv({ SIKANDER_CORPUS_RESEARCH_READER_URL: db.researchUrl, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" })
    await resetResearchSource()
    restart()
    useEmulatorVerifier(true)
    partner = await provisionPartner()
  }, SLOW)

  afterEach(() => {
    useEmulatorVerifier(false)
    vi.unstubAllEnvs()
    restart()
  })

  it("the corpus is over every old cap: 25,000+ visible judgments, 37,500+ citations, 20,000+ treatment rows", () => {
    expect(counts.judgments).toBeGreaterThanOrEqual(BULK)
    expect(truth.documents.length).toBe(counts.judgments)
    expect(counts.citations).toBeGreaterThan(37_500)
    expect(counts.overrulings + counts.pending).toBeGreaterThan(14_000)
  })

  it("every answer equals the ranking over the whole visible corpus (top k, scores, citations, treatments)", async () => {
    const got: Record<string, unknown> = {}
    const want: Record<string, unknown> = {}
    for (const q of QUERIES) {
      const res = await research(partner, q)
      expect(res.authority, q).toBe("functions")
      got[q] = { status: res.status, hits: hitsOf(res) }
      want[q] = { status: 200, hits: await expected(truth, q) }
    }
    expect(got).toEqual(want)
    // The queries are not vacuous: broad ones fill k, R4a puts the cited authority first, the miss is empty.
    const w = want as Record<string, { hits: Hit[] }>
    expect(w.bail.hits).toHaveLength(10)
    expect(w[`PLD 2099 SC ${100_000 + 4321}`].hits[0]).toMatchObject({ score: 1, citation: `PLD 2099 SC ${100_000 + 4321}` })
    expect(w.zqnothingmatchesthis.hits).toEqual([])
    expect(new Set(Object.values(w).flatMap((x) => x.hits.map((h) => h.treatment)))).toEqual(new Set(["OVERRULED", "UNVERIFIED", "VERIFIED"]))
  }, SLOW)

  it(`keyword latency: the reader median ≤ ${READER_MEDIAN_MS} ms, max ≤ ${READER_MAX_MS} ms; the route median ≤ ${ROUTE_MEDIAN_MS} ms, max ≤ ${ROUTE_MAX_MS} ms (spec R35)`, async () => {
    const c = readCorpusReaderConfig({ SIKANDER_CORPUS_READER_URL: db.researchUrl, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" }, false)
    if (!c.ok) throw new Error(`config ${c.reason}`)
    const reader = new PgResearchCorpus(c.config)
    const stats = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b)
      return { median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] }
    }
    try {
      // One warm-up of each path (pool connect, module load), then three rounds of every query on each.
      expect((await research(partner, "warm up bail")).status).toBe(200)
      await searchResearch(reader, { text: "warm up bail" })
      const route: number[] = []
      const own: number[] = []
      const perQuery: Record<string, { route: number[]; reader: number[] }> = {}
      for (let round = 0; round < 3; round += 1) {
        for (const q of QUERIES) {
          const res = await research(partner, q)
          expect(res.status, q).toBe(200)
          const started = performance.now()
          await searchResearch(reader, { text: q })
          const ms = performance.now() - started
          route.push(res.ms)
          own.push(ms)
          const entry = (perQuery[q] ??= { route: [], reader: [] })
          entry.route.push(Math.round(res.ms))
          entry.reader.push(Math.round(ms))
        }
      }
      const r = stats(route)
      const o = stats(own)
      const floor = stats(perQuery.zqnothingmatchesthis.route).median
      const line =
        `scale e2e latency (${counts.judgments} judgments, ${own.length} searches per path): ` +
        `reader median_ms=${o.median.toFixed(0)} p90_ms=${o.p90.toFixed(0)} max_ms=${o.max.toFixed(0)}; ` +
        `route median_ms=${r.median.toFixed(0)} p90_ms=${r.p90.toFixed(0)} max_ms=${r.max.toFixed(0)} floor_ms=${floor.toFixed(0)} ` +
        `per_query=${JSON.stringify(perQuery)}`
      console.info(line)
      if (process.env.FA_D5_003_EVIDENCE) fs.appendFileSync(process.env.FA_D5_003_EVIDENCE, `${line}\n`)
      expect(o.median).toBeLessThanOrEqual(READER_MEDIAN_MS)
      expect(o.max).toBeLessThanOrEqual(READER_MAX_MS)
      expect(r.median).toBeLessThanOrEqual(ROUTE_MEDIAN_MS)
      expect(r.max).toBeLessThanOrEqual(ROUTE_MAX_MS)
    } finally {
      await reader.end()
    }
  }, SLOW)
})
