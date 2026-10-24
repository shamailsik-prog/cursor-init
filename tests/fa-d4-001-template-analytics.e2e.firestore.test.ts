// Audit FA-D4-001 (MEDIUM): `draft_template_analytics/{id}` was keyed `template:${templateId}`, with no firm. Firm B
// composes (or searches) template T, then firm A does the same through the real D4 drafts route: A's write lands on the
// one shared document and B's row is overwritten (or, on an older main, incremented by A while still stamped B).
//
// These tests drive the real POST /api/d4/drafts (compose) and GET /api/d4/drafts?view=templates&q= (template search)
// in production mode: firebase auth with emulator ID tokens, SIKANDER_PERSISTENCE_MODE=firestore, the configured
// Firestore (the emulator, no test-database injection), so every request goes through withSession, the F02 Functions
// router (bearer, X-Firm-Id, matter permission) and then the Next core. Rows are found by (firmId, templateId), not by
// document id, so the same assertions run on main (shared id) and on the fix (firm-qualified id).
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as draftsGet, POST as draftsPost } from "@/app/api/d4/drafts/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { getDocumentTypes } from "@/lib/foundation-data"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"

requireAuthFirestoreEmulators("FA-D4-001 template analytics e2e")

const E2E_TIMEOUT_MS = 120_000
const COLLECTION = "draft_template_analytics"

type Verifier = (token: string) => Promise<{ uid: string } & Record<string, unknown>>
type SessionSeams = { setIdTokenVerifierForTests?: (verifier: Verifier | null) => void }

function useEmulatorVerifier(on: boolean): void {
  const seam = (session as unknown as SessionSeams).setIdTokenVerifierForTests
  seam?.(on ? async (token) => (await adminAuth().verifyIdToken(token, true)) as Awaited<ReturnType<Verifier>> : null)
}

function restart(): void {
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
  session.resetSessionStateForTests()
  resetProductionFirestoreForTests()
}

type Actor = { firmId: string; uid: string; token: string; matterId: string }

async function provisionFirm(): Promise<string> {
  const ref = adminDb().collection("firms").doc()
  await ref.create({ name: `FA-D4-001 firm ${ref.id}`, dataResidency: "PK", plan: "internal" })
  return ref.id
}

/** A partner of a new firm, signed in on the Auth emulator, and a matter of that firm the partner is a member of. */
async function provisionActor(): Promise<Actor> {
  const firmId = await provisionFirm()
  const uid = adminDb().collection("users").doc().id
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
  if (!res.ok) throw new Error(`emulator sign-in failed: ${res.status} ${await res.text()}`)
  const { idToken } = (await res.json()) as { idToken: string }
  const matterId = `fad4-${randomUUID().slice(0, 8)}`
  const batch = adminDb().batch()
  batch.set(adminDb().collection("matters").doc(matterId), {
    id: matterId,
    firmId,
    clientId: `fad4-client-${firmId}`,
    title: `FA-D4-001 matter ${matterId}`,
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "live",
    classification: "internal",
  })
  batch.set(adminDb().collection("matter_members").doc(`${matterId}_${uid}`), { matterId, userId: uid, firmId })
  await batch.commit()
  return { firmId, uid, token: idToken, matterId }
}

function headers(actor: Actor, extra?: Record<string, string>): HeadersInit {
  return { Authorization: `Bearer ${actor.token}`, "X-Firm-Id": actor.firmId, ...extra }
}

async function compose(actor: Actor, templateId: string): Promise<{ status: number; body: unknown }> {
  const res = await draftsPost(
    new Request("http://127.0.0.1/api/d4/drafts", {
      method: "POST",
      headers: headers(actor, { "content-type": "application/json", "idempotency-key": randomUUID() }),
      body: JSON.stringify({
        action: "compose",
        actorId: actor.uid,
        matterId: actor.matterId,
        templateId,
        title: "Analytics draft",
        body: "Body",
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      }),
    })
  )
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function searchTemplates(actor: Actor, query: string): Promise<{ status: number; body: unknown }> {
  const res = await draftsGet(
    new Request(
      `http://127.0.0.1/api/d4/drafts?view=templates&actorId=${actor.uid}&q=${encodeURIComponent(query)}&limit=10&cursor=0`,
      { headers: headers(actor) }
    )
  )
  return { status: res.status, body: await res.json().catch(() => null) }
}

type StoredRow = { docId: string; data: Record<string, unknown> }

/** The analytics rows stamped with this firm and template, whatever their document id. */
async function rowsOf(firmId: string, templateId: string): Promise<StoredRow[]> {
  const snap = await adminDb()
    .collection(COLLECTION)
    .where("firmId", "==", firmId)
    .where("templateId", "==", templateId)
    .get()
  return snap.docs.map((d) => ({ docId: d.id, data: d.data() }))
}

/** Distinct catalog templates per test, from the end of the catalog, so no other suite shares their rows. */
function template(offset: number): string {
  const types = getDocumentTypes()
  const picked = types[types.length - 1 - offset]
  if (!picked) throw new Error("template catalog too small")
  return picked.id
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("FA-D4-001: template analytics are per firm through the D4 drafts route", { timeout: E2E_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    restart()
    useEmulatorVerifier(true)
  })

  afterEach(() => {
    useEmulatorVerifier(false)
    vi.unstubAllEnvs()
    restart()
  })

  it("firm A's compose with template T leaves firm B's analytics row as B wrote it", async () => {
    const T = template(0)
    const [a, b] = [await provisionActor(), await provisionActor()]
    const byB = await compose(b, T)
    expect(byB.status, JSON.stringify(byB.body)).toBe(200)
    const [before] = await rowsOf(b.firmId, T)
    expect(before?.data).toMatchObject({ firmId: b.firmId, templateId: T, composeCount: 1 })

    const byA = await compose(a, T)
    expect(byA.status, JSON.stringify(byA.body)).toBe(200)

    const afterB = await rowsOf(b.firmId, T)
    expect(afterB.map((r) => r.data)).toEqual([before!.data])
    expect(afterB.map((r) => r.docId)).toEqual([`template:${b.firmId}:${T}`])
    const afterA = await rowsOf(a.firmId, T)
    expect(afterA.map((r) => r.data.composeCount)).toEqual([1])
    expect(afterA.map((r) => r.docId)).toEqual([`template:${a.firmId}:${T}`])
  })

  it("firm A's template search for T leaves firm B's analytics row as B wrote it", async () => {
    const T = template(1)
    const [a, b] = [await provisionActor(), await provisionActor()]
    expect((await compose(b, T)).status).toBe(200)
    const [before] = await rowsOf(b.firmId, T)
    expect(before?.data).toMatchObject({ firmId: b.firmId, composeCount: 1, templateSearchCount: 0 })

    const searched = await searchTemplates(a, T)
    expect(searched.status, JSON.stringify(searched.body)).toBe(200)

    expect((await rowsOf(b.firmId, T)).map((r) => r.data)).toEqual([before!.data])
    const afterA = await rowsOf(a.firmId, T)
    expect(afterA.map((r) => ({ composeCount: r.data.composeCount, templateSearchCount: r.data.templateSearchCount }))).toEqual([
      { composeCount: 0, templateSearchCount: 1 },
    ])
    expect(afterA.map((r) => r.docId)).toEqual([`template:${a.firmId}:${T}`])
  })

  it("concurrent composes from two firms keep one row per firm with every compose counted", async () => {
    const T = template(2)
    const [a, b] = [await provisionActor(), await provisionActor()]
    const results = await Promise.all([a, b, a, b, a, b].map((actor) => compose(actor, T)))
    expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body))).toEqual([200, 200, 200, 200, 200, 200])
    for (const actor of [a, b]) {
      const rows = await rowsOf(actor.firmId, T)
      expect(rows.map((r) => ({ id: r.docId, composeCount: r.data.composeCount }))).toEqual([
        { id: `template:${actor.firmId}:${T}`, composeCount: 3 },
      ])
    }
  })

  it("a legacy `template:T` row is never read or written by a compose", async () => {
    const T = template(3)
    const a = await provisionActor()
    const legacy = adminDb().collection(COLLECTION).doc(`template:${T}`)
    const legacyRow = {
      id: `template:${T}`,
      firmId: a.firmId,
      templateId: T,
      templateName: "Legacy",
      templatePosture: "legacy",
      templateCategory: "legacy",
      composeCount: 7,
      templateSearchCount: 2,
      lastComposedAt: 1,
      lastTemplateSearchAt: 1,
      lastTemplateSearchQuery: "legacy",
      updatedAt: 1,
    }
    await legacy.set(legacyRow)
    try {
      expect((await compose(a, T)).status).toBe(200)
      expect((await legacy.get()).data()).toEqual(legacyRow)
      const canonical = (await adminDb().collection(COLLECTION).doc(`template:${a.firmId}:${T}`).get()).data()
      expect(canonical).toMatchObject({ firmId: a.firmId, templateId: T, composeCount: 1, templateSearchCount: 0 })
      // The Firestore repository the route reads through lists and gets only the firm-qualified row.
      const repo = createFirestoreRepositories(adminDb() as never).draftTemplateAnalytics
      expect((await repo.listByFirm(a.firmId)).map((r) => [r.id, r.composeCount])).toEqual([[`template:${a.firmId}:${T}`, 1]])
      expect(await repo.get(`template:${T}`, a.firmId)).toBeNull()
    } finally {
      await legacy.delete()
    }
  })

  it("a compose and a search refuse (409) to write over a row at the firm's own id that is stamped with another firm", async () => {
    const T = template(4)
    const [a, b] = [await provisionActor(), await provisionActor()]
    const ref = adminDb().collection(COLLECTION).doc(`template:${a.firmId}:${T}`)
    const foreign = {
      id: ref.id,
      firmId: b.firmId,
      templateId: T,
      templateName: "Foreign",
      templatePosture: "foreign",
      templateCategory: "foreign",
      composeCount: 5,
      templateSearchCount: 0,
      lastComposedAt: 1,
      lastTemplateSearchAt: null,
      lastTemplateSearchQuery: null,
      updatedAt: 1,
    }
    await ref.set(foreign)
    const res = await compose(a, T)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect((res.body as { error?: { code?: string } }).error?.code).toBe("template_analytics_refused")
    expect((await ref.get()).data()).toEqual(foreign)
    const searched = await searchTemplates(a, T)
    expect(searched.status, JSON.stringify(searched.body)).toBe(409)
    expect((searched.body as { error?: { code?: string } }).error?.code).toBe("template_analytics_refused")
    expect((await ref.get()).data()).toEqual(foreign)
  })
})
