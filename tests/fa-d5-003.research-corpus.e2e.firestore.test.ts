/**
 * FA-D5-003 (closes FA-D2WA-001), end to end through the production route: WhatsApp `/research <query>` as
 * `POST /api/d2/court-ops {action: "whatsapp_command"}` on production persistence (Firestore and Auth emulators, no
 * test-injected database), so the request takes #106's path: `withSession` → `withF02Authority` → the in-process Functions
 * router (bearer, `X-Firm-Id`, rate limit, idempotency) → the Next core. Every response is checked for
 * `x-authority-path: functions`.
 *
 * The corpus is real Postgres 16 + pgvector, published the way an operator publishes it: the F19 publication CLI as a
 * corpus_writer member. The research login is a member of corpus_research_reader and nothing else.
 *
 * On main the Next core searches the empty in-memory read model: every query answers 200 `[]`, whatever Annex A holds, and
 * a missing or unreachable corpus looks exactly like "nothing matched".
 * Spec: docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md. Synthetic data only (2099).
 */
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as courtOpsPost } from "@/app/api/d2/court-ops/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS } from "@/tests/helpers/emulator-require"
import {
  FA_D5_003_BATCH,
  FA_D5_003_SUITE,
  LIVE_MODEL,
  type PublishSummary,
  type ResearchDb,
  createResearchDb,
  insertEmbeddings,
  insertUnpublishedJudgment,
  judgmentIds,
} from "@/tests/helpers/fa-d5-003-corpus"

if (FA_D5_003_SUITE && !HAS_AUTH_FIRESTORE_EMULATORS) {
  throw new Error("the FA-D5-003 e2e needs the Auth and Firestore emulators: run it with `npm run test:fa-d5-003`")
}

const SLOW = 120_000
const AUTHORITY_HEADER = "x-authority-path"
const RESEARCH_ENV = [
  "SIKANDER_RESEARCH_CORPUS",
  "SIKANDER_CORPUS_RESEARCH_READER_URL",
  "SIKANDER_CORPUS_RESEARCH_READER_CA",
  "SIKANDER_CORPUS_MAX_STALENESS_HOURS",
] as const

type Hit = { n: number; entityId: string; title: string; citation: string | null; treatment: string; score: number }
type Actor = { firmId: string; uid: string; token: string }
type Sent = { status: number; body: unknown; text: string; authority: string | null }

type Verifier = (token: string) => Promise<{ uid: string } & Record<string, unknown>>
type SessionSeams = { setIdTokenVerifierForTests?: (verifier: Verifier | null) => void }

function useEmulatorVerifier(on: boolean): void {
  const seam = (session as unknown as SessionSeams).setIdTokenVerifierForTests
  seam?.(on ? async (token) => (await adminAuth().verifyIdToken(token, true)) as Awaited<ReturnType<Verifier>> : null)
}

/** The research source's pools and memo, when the module exists (it does not on main). */
async function resetResearchSource(): Promise<void> {
  const spec = "@/services/d5-1/researchCorpus"
  try {
    const mod = (await import(/* @vite-ignore */ spec)) as { resetResearchSourceForTests?: () => Promise<void> }
    await mod.resetResearchSourceForTests?.()
  } catch {
    // main: no research source module
  }
}

function restart(): void {
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
  session.resetSessionStateForTests()
  resetProductionFirestoreForTests()
}

async function provisionFirm(): Promise<string> {
  const ref = adminDb().collection("firms").doc()
  await ref.create({ name: `FA-D5-003 firm ${ref.id}`, dataResidency: "PK", plan: "internal", rateLimits: { general: 1000 } })
  return ref.id
}

async function provisionUser(firmId: string, role: "partner" | "clerk" | "client"): Promise<Actor> {
  const uid = adminDb().collection("users").doc().id
  const email = `${uid.toLowerCase()}@example.test`
  const password = "emulator-pass-123"
  await adminAuth().createUser({ uid, email, password })
  await adminAuth().setCustomUserClaims(uid, { firmId, role, clearanceLevel: "internal" })
  await adminDb().collection("users").doc(uid).set({ id: uid, firmId, role, clearanceLevel: "internal", active: true })
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST is required")
  const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  if (!res.ok) throw new Error(`emulator sign-in failed: ${res.status} ${await res.text()}`)
  const { idToken } = (await res.json()) as { idToken: string }
  return { firmId, uid, token: idToken }
}

async function whatsapp(actor: Actor, command: string, key: string = randomUUID()): Promise<Sent> {
  const res = await courtOpsPost(
    new Request("http://127.0.0.1/api/d2/court-ops", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${actor.token}`,
        "X-Firm-Id": actor.firmId,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ action: "whatsapp_command", actorId: actor.uid, command }),
    })
  )
  const text = await res.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { status: res.status, body, text, authority: res.headers.get(AUTHORITY_HEADER) }
}

const research = (actor: Actor, query: string, key?: string) => whatsapp(actor, `/research ${query}`, key)

function hitsOf(res: Sent): Hit[] {
  const body = res.body as { result?: { result?: { research?: Hit[] } } } | null
  return body?.result?.result?.research ?? []
}

/** The public code of a refusal: `{error: {code}}` through the Functions router, `{code}` from the core. */
function codeOf(res: Sent): string | undefined {
  const body = res.body as { code?: unknown; error?: unknown } | null
  if (body && typeof body.error === "object" && body.error !== null) return (body.error as { code?: string }).code
  return typeof body?.code === "string" ? body.code : undefined
}

function setResearchEnv(values: Partial<Record<(typeof RESEARCH_ENV)[number], string | undefined>>): void {
  for (const name of RESEARCH_ENV) {
    const value = values[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

let db: ResearchDb
let published: PublishSummary
let J: Record<string, string> = {}
let hidden: Record<string, string> = {}
let partner: Actor
let clerk: Actor
let client: Actor
const savedEnv: Record<string, string | undefined> = {}

const VISIBLE_RELEVANT = [
  "j-bail-01", "j-bail-02", "j-bail-03", "j-bail-04", "j-bail-05", "j-bail-06", "j-bail-07", "j-bail-08", "j-bail-09",
  "j-bail-10", "j-bail-11", "j-crpc-12", "j-pending",
]

describe.runIf(FA_D5_003_SUITE)("FA-D5-003: /research reads the published Annex A corpus through the production route", () => {
  beforeAll(async () => {
    for (const name of RESEARCH_ENV) savedEnv[name] = process.env[name]
    db = await createResearchDb("e2e")
    published = await db.publish(FA_D5_003_BATCH)
    J = judgmentIds(published)
    // Hidden by a reclassification after publication (an upgrade; the guard ignores classification-only updates).
    await db.admin.query("UPDATE judgment SET classification = 'privileged' WHERE id = $1", [J["j-privileged"]])
    hidden = {
      "j-review": J["j-review"],
      "j-noprov": J["j-noprov"],
      "j-nobench": J["j-nobench"],
      "j-privileged": J["j-privileged"],
      "j-superuser": await insertUnpublishedJudgment(db.admin, "Bail zqsuperuser section 497 hidden", "2099 SCMR 3605", "none"),
      "j-unfinished": await insertUnpublishedJudgment(db.admin, "Bail zqunfinished section 497 hidden", "2099 SCMR 3606", "unfinished"),
    }
    // Vectors under the live model for every judgment, hidden ones included: the G1-10 lock is live.
    await insertEmbeddings(db.admin, [...Object.values(J), ...Object.values(hidden).filter((id) => id !== undefined)])
  }, 300_000)

  afterAll(async () => {
    setResearchEnv(savedEnv)
    await resetResearchSource()
    await db?.drop()
  }, 120_000)

  beforeEach(async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-fa-d5-003")
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "demo-fa-d5-003")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-fa-d5-003")
    setResearchEnv({
      SIKANDER_CORPUS_RESEARCH_READER_URL: db.researchUrl,
      SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24",
    })
    await resetResearchSource()
    restart()
    useEmulatorVerifier(true)
    const firmId = await provisionFirm()
    partner = await provisionUser(firmId, "partner")
    clerk = await provisionUser(firmId, "clerk")
    client = await provisionUser(firmId, "client")
  }, SLOW)

  afterEach(() => {
    useEmulatorVerifier(false)
    vi.unstubAllEnvs()
    restart()
  })

  it("the fixture publishes as research expects (precondition)", () => {
    const decided = Object.fromEntries(
      published.items
        .filter((o) => o.entity_type === "judgment" || o.entity_type === "treatment")
        .map((o) => [o.item_key, [o.decision, o.reason]])
    )
    expect(decided).toMatchObject({
      "j-bail-01": ["promoted", null],
      "j-bail-02": ["promoted", null],
      "j-larger": ["promoted", null],
      "j-pending": ["promoted", null],
      "j-review": ["quarantined", "review_source"],
      "j-noprov": ["rejected", "provenance_incomplete"],
      "j-nobench": ["quarantined", "missing_bench"],
      "j-privileged": ["promoted", null],
      "t-overruled": ["promoted", null],
      "t-pending": ["quarantined", "treatment_uncertain"],
    })
  })

  it("returns the published authorities for the query, ranked, capped at 10, numbered, each with its treatment", async () => {
    const res = await research(clerk, "bail 497 CrPC")
    expect(res.authority).toBe("functions")
    expect(res.status).toBe(200)
    const hits = hitsOf(res)
    expect(hits).toHaveLength(10)
    expect(hits.map((h) => h.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const relevant = VISIBLE_RELEVANT.map((k) => J[k])
    for (const h of hits) {
      expect(relevant).toContain(h.entityId)
      expect(h.score).toBeGreaterThan(0)
      expect(h.score).toBeLessThanOrEqual(1)
    }
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
    // The two judgments carrying every query term come first, at full coverage.
    expect(hits.slice(0, 2).map((h) => h.entityId).sort()).toEqual([J["j-bail-01"], J["j-bail-02"]].sort())
    expect(hits.slice(0, 2).map((h) => h.score)).toEqual([1, 1])
    expect(hits[2].score).toBeLessThan(1)
    // Module 33 treatment from the corpus: a larger bench overruled j-bail-01.
    const one = hits.find((h) => h.entityId === J["j-bail-01"])
    expect(one).toMatchObject({ citation: "2099 SCMR 3101", treatment: "OVERRULED" })
    expect(one?.title).toBe("Bail after arrest under section 497 CrPC refused for want of reasonable grounds")
    expect(hits.find((h) => h.entityId === J["j-bail-02"])?.treatment).toBe("VERIFIED")
    expect(Object.keys(hits[0]).sort()).toEqual(["citation", "entityId", "n", "score", "title", "treatment"])
  }, SLOW)

  it("an overruling held for review leaves the authority UNVERIFIED, never VERIFIED", async () => {
    const hits = hitsOf(await research(partner, "narcotics trafficking"))
    expect(hits[0]).toMatchObject({ entityId: J["j-pending"], treatment: "UNVERIFIED" })
  }, SLOW)

  it("ranks the authority whose citation the query names first, by any of its published citations (R4a)", async () => {
    const byFirst = hitsOf(await research(partner, "2099 SCMR 3107"))
    expect(byFirst[0]).toMatchObject({ n: 1, entityId: J["j-bail-07"], citation: "2099 SCMR 3107", score: 1 })
    expect(byFirst.slice(1).every((h) => h.score < 1)).toBe(true)
    const bySecond = hitsOf(await research(partner, "PLD 2099 SC 3202"))
    expect(bySecond[0]).toMatchObject({ entityId: J["j-bail-02"], citation: "PLD 2099 SC 3202", score: 1 })
  }, SLOW)

  it("never returns an unpublished, quarantined, rejected, bench-less or privileged judgment, whatever the query names", async () => {
    const markers = ["zqreview", "zqnoprov", "zqnobench", "zqprivileged", "zqsuperuser", "zqunfinished"]
    const broad = await research(clerk, `bail 497 ${markers.join(" ")}`)
    expect(broad.status).toBe(200)
    const ids = hitsOf(broad).map((h) => h.entityId)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of Object.values(hidden)) expect(ids).not.toContain(id)
    for (const marker of markers) {
      const res = await research(clerk, marker)
      expect([marker, res.status, hitsOf(res)]).toEqual([marker, 200, []])
    }
    for (const citation of ["2099 SCMR 3601", "2099 SCMR 3602", "2099 SCMR 3603", "2099 SCMR 3604", "2099 SCMR 3605", "2099 SCMR 3606"]) {
      const hits = hitsOf(await research(clerk, citation))
      expect(hits.some((h) => Object.values(hidden).includes(h.entityId))).toBe(false)
      expect(hits.every((h) => h.score < 1)).toBe(true)
    }
    // Control: a visible judgment found by its own words.
    expect(hitsOf(await research(clerk, "custody minors"))[0]?.entityId).toBe(J["j-larger"])
  }, SLOW)

  it("a query that matches nothing is 200 with an empty list", async () => {
    const res = await research(clerk, "zqnothingmatches")
    expect(res.authority).toBe("functions")
    expect([res.status, hitsOf(res)]).toEqual([200, []])
  }, SLOW)

  it("the corpus lock covers the vectors research can read: another model on a visible judgment refuses, on a hidden one does not", async () => {
    await db.admin.query(
      `INSERT INTO corpus_embeddings (entity_type, entity_id, model, classification_rank, embedding)
       SELECT 'judgment', $1, 'text-embedding-3-large', 0, embedding FROM corpus_embeddings WHERE entity_id = $1 AND model = $2`,
      [hidden["j-review"], LIVE_MODEL]
    )
    try {
      const ok = await research(clerk, "bail 497")
      expect([ok.status, hitsOf(ok).length > 0]).toEqual([200, true])
      await db.admin.query(
        `INSERT INTO corpus_embeddings (entity_type, entity_id, model, classification_rank, embedding)
         SELECT 'judgment', $1, 'text-embedding-3-large', 0, embedding FROM corpus_embeddings WHERE entity_id = $1 AND model = $2`,
        [J["j-bail-03"], LIVE_MODEL]
      )
      // The core's PublicError ("search refuses: embedding_model mismatch") is a 400; the Functions router keeps only
      // its public code. A refusal, not an empty list and not a 503.
      const refused = await research(clerk, "bail 497")
      expect(refused.authority).toBe("functions")
      expect([refused.status, codeOf(refused), hitsOf(refused)]).toEqual([400, "request_failed", []])
    } finally {
      await db.admin.query("DELETE FROM corpus_embeddings WHERE model = 'text-embedding-3-large'")
    }
    const back = await research(clerk, "bail 497")
    expect([back.status, hitsOf(back).length > 0]).toEqual([200, true])
  }, SLOW)

  describe("a corpus research cannot read is 503 corpus_unavailable, never an empty list", () => {
    const expectUnavailable = (res: Sent) => {
      expect(res.authority).toBe("functions")
      expect([res.status, codeOf(res)]).toEqual([503, "corpus_unavailable"])
      expect(hitsOf(res)).toEqual([])
      // No driver text, host, database or login leaves the server.
      for (const secretish of [db.name, db.researchUser, "55651", "ECONNREFUSED", "password", "postgres"]) {
        expect(res.text).not.toContain(secretish)
      }
    }

    it("no reader configured", async () => {
      setResearchEnv({ SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" })
      await resetResearchSource()
      expectUnavailable(await research(clerk, "bail 497"))
    }, SLOW)

    it("the database is unreachable", async () => {
      const url = new URL(db.researchUrl)
      url.port = "1"
      setResearchEnv({ SIKANDER_CORPUS_RESEARCH_READER_URL: url.toString(), SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" })
      await resetResearchSource()
      expectUnavailable(await research(clerk, "bail 497"))
    }, SLOW)

    it("the login can read more than the research views (a corpus_reader member)", async () => {
      const login = await db.createLogin("fad5x")
      const role = await db.admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'corpus_research_reader'")
      if (role.rowCount === 1) await db.admin.query(`GRANT corpus_research_reader TO "${login.user}"`)
      await db.admin.query(`GRANT corpus_reader TO "${login.user}"`)
      setResearchEnv({ SIKANDER_CORPUS_RESEARCH_READER_URL: login.url, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" })
      await resetResearchSource()
      expectUnavailable(await research(clerk, "bail 497"))
    }, SLOW)

    it("the corpus is stale", async () => {
      const before = await db.admin.query("SELECT value FROM corpus_metadata WHERE key = 'last_refresh'")
      await db.admin.query("UPDATE corpus_metadata SET value = '2000-01-01T00:00:00.000000Z' WHERE key = 'last_refresh'")
      try {
        expectUnavailable(await research(clerk, "bail 497"))
      } finally {
        await db.admin.query("UPDATE corpus_metadata SET value = $1 WHERE key = 'last_refresh'", [before.rows[0].value])
      }
    }, SLOW)

    it("the in-memory store selected on a hosted runtime", async () => {
      vi.stubEnv("VERCEL", "1")
      setResearchEnv({ SIKANDER_RESEARCH_CORPUS: "memory" })
      await resetResearchSource()
      expectUnavailable(await research(clerk, "bail 497"))
    }, SLOW)

    it("the same Idempotency-Key answers once the corpus is back: a 503 is not stored as the reply", async () => {
      const key = randomUUID()
      setResearchEnv({ SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" })
      await resetResearchSource()
      expectUnavailable(await research(clerk, "bail 497 CrPC", key))
      setResearchEnv({ SIKANDER_CORPUS_RESEARCH_READER_URL: db.researchUrl, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" })
      await resetResearchSource()
      const retried = await research(clerk, "bail 497 CrPC", key)
      expect(retried.status).toBe(200)
      expect(hitsOf(retried)).toHaveLength(10)
    }, SLOW)
  })

  it("P5 still runs first: a client is 403 without a corpus read, even with no reader configured", async () => {
    setResearchEnv({ SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" })
    await resetResearchSource()
    const res = await research(client, "bail 497")
    expect(res.status).toBe(403)
    expect(hitsOf(res)).toEqual([])
  }, SLOW)
})
