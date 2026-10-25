/**
 * Audit F42, the R1 follow-up (spec section 11), on the Next side: the routes entered the production way (Firebase auth,
 * Firestore persistence, no test-database injection, so the F02 Functions authority path in front of the Next core),
 * over the Auth and Firestore emulators. Each check has its control (the same read before the tombstone, or of a live
 * matter), so a probe whose control fails is inconclusive, not a pass.
 */
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { GET as documentsGet } from "@/app/api/d1/documents/route"
import { POST as draftsPost } from "@/app/api/d4/drafts/route"
import { GET as committeeGet } from "@/app/api/p1/committee-brain/route"
import { getDocumentTypes } from "@/lib/foundation-data"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import { resolveCommitteeScope } from "@/platform/p5/committeeScope"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { seedFirmARuntimeRecords } from "@/tests/helpers/firestore-runtime-seed"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"

requireAuthFirestoreEmulators("F42 R1 follow-up Next e2e")

const TIMEOUT = 120_000
const TITLE = "F42R1 Next confidential title Bilal v Crown"

type Verifier = (token: string) => Promise<{ uid: string } & Record<string, unknown>>
type SessionSeams = { setIdTokenVerifierForTests?: (verifier: Verifier | null) => void }
type Actor = { firmId: string; uid: string; token: string }

function useEmulatorVerifier(on: boolean): void {
  const seam = (session as unknown as SessionSeams).setIdTokenVerifierForTests
  seam?.(on ? async (token) => (await adminAuth().verifyIdToken(token, true)) as Awaited<ReturnType<Verifier>> : null)
}

function restartAll(): void {
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
  session.resetSessionStateForTests()
  resetProductionFirestoreForTests()
}

// Every firm, auth user and row this file creates, deleted in afterAll (FA-F42-R1-015).
const created: Array<{ collection: string; id: string }> = []
const authUsers: string[] = []

async function provisionFirm(): Promise<string> {
  const ref = adminDb().collection("firms").doc()
  await ref.create({ name: `F42R1 firm ${ref.id}`, dataResidency: "PK", plan: "internal" })
  created.push({ collection: "firms", id: ref.id })
  return ref.id
}

async function provisionUser(firmId: string, role: "partner" | "clerk"): Promise<Actor> {
  const uid = adminDb().collection("users").doc().id
  const email = `${uid.toLowerCase()}@example.test`
  const password = "emulator-pass-123"
  await adminAuth().createUser({ uid, email, password })
  authUsers.push(uid)
  await adminAuth().setCustomUserClaims(uid, { firmId, role, clearanceLevel: "internal" })
  await adminDb().collection("users").doc(uid).set({ id: uid, firmId, role, clearanceLevel: "internal", active: true })
  created.push({ collection: "users", id: uid })
  const res = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  if (!res.ok) throw new Error(`emulator sign-in failed: ${res.status}`)
  return { firmId, uid, token: ((await res.json()) as { idToken: string }).idToken }
}

async function put(collection: string, id: string, data: Record<string, unknown>): Promise<string> {
  await adminDb().collection(collection).doc(id).set(data)
  created.push({ collection, id })
  return id
}

async function seedMatter(firmId: string, title: string, memberIds: string[]): Promise<string> {
  const id = adminDb().collection("matters").doc().id
  await put("matters", id, { firmId, clientId: `f42r1-client-${firmId}`, title, courtId: "SHC", caseNumber: null, caseNumberStatus: "pending", status: "live", classification: "internal" })
  for (const userId of memberIds) await put("matter_members", `${id}_${userId}`, { matterId: id, userId, firmId })
  return id
}

async function seedDocument(firmId: string, matterId: string, uploadedBy: string): Promise<string> {
  const id = adminDb().collection("documents").doc().id
  await put("documents", id, {
    id, firmId, matterId, contentHash: "c".repeat(64), sourceChannel: "web", classification: "internal",
    storagePath: `fs://${firmId}/documents/${id}/v1`, isImmutable: true, byteSize: 10, mimeType: "application/pdf", objectVersion: 1, uploadedBy, objectBytesStatus: "missing",
  })
  return id
}

async function tombstone(firmId: string, matterId: string): Promise<void> {
  await put("matter_tombstones", matterId, { firmId, matterId, requestId: `f42r1-${matterId}`, classification: "internal", tombstonedAt: Timestamp.now(), requestedBy: "p1", approvedBy: "p2", membersRevoked: 0, policyVersion: "test", purgeCompletedAt: null })
}

const call = async (handler: (r: Request) => Promise<Response>, a: Actor, path: string) => {
  const res = await handler(new Request(`http://127.0.0.1${path}`, { method: "GET", headers: { Authorization: `Bearer ${a.token}`, "X-Firm-Id": a.firmId } }))
  return { status: res.status, text: await res.text() }
}
const post = async (handler: (r: Request) => Promise<Response>, a: Actor, path: string, body: unknown, key: string) => {
  const res = await handler(
    new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { Authorization: `Bearer ${a.token}`, "X-Firm-Id": a.firmId, "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) })
  )
  return { status: res.status, text: await res.text() }
}

afterAll(async () => {
  if (!HAS_AUTH_FIRESTORE_EMULATORS) return
  for (let i = 0; i < created.length; i += 400) {
    const batch = adminDb().batch()
    for (const { collection, id } of created.slice(i, i + 400)) batch.delete(adminDb().collection(collection).doc(id))
    await batch.commit()
  }
  for (const uid of authUsers) await adminAuth().deleteUser(uid).catch(() => undefined)
}, TIMEOUT)

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F42 R1 follow-up: the Next routes", () => {
  let partner: Actor
  let deleted: string
  let live: string

  beforeEach(async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    restartAll()
    useEmulatorVerifier(true)
    const firmId = await provisionFirm()
    partner = await provisionUser(firmId, "partner")
    deleted = await seedMatter(firmId, TITLE, [partner.uid])
    live = await seedMatter(firmId, "F42R1 live matter", [partner.uid])
  }, TIMEOUT)

  afterEach(() => {
    useEmulatorVerifier(false)
    vi.unstubAllEnvs()
    restartAll()
  })

  it("FA-F42-R1-002: a legacy committee output (no matterId) whose document is tombstoned or gone is not served to its author", async () => {
    const deletedDoc = await seedDocument(partner.firmId, deleted, partner.uid)
    const liveDoc = await seedDocument(partner.firmId, live, partner.uid)
    const legacy = async (tag: string, documentIds: string[]) => {
      const id = adminDb().collection("committee_outputs").doc().id
      await put("committee_outputs", id, {
        id, firmId: partner.firmId, actorId: partner.uid, classification: "internal", documentIds, purpose: "case_summary", blocked: false, text: `${tag} ${TITLE} legacy AI answer`,
        outbound: { body: "masked", metadata: { classification: "internal", provider: "x", purpose: "case_summary" } }, createdAt: Date.now(),
      })
    }
    await legacy("OF-DELETED", [deletedDoc])
    await legacy("OF-GONE", ["f42r1-purged-document"])
    await legacy("OF-LIVE", [liveDoc])
    await legacy("NO-DOCUMENTS", [])
    const list = () => call(committeeGet, partner, `/api/p1/committee-brain?actorId=${partner.uid}&limit=50&cursor=0`)
    const before = await list()
    expect(before.status).toBe(200)
    // Control: before the tombstone the author reads the output of the (still live) matter's document.
    expect(before.text).toContain("OF-DELETED")
    await tombstone(partner.firmId, deleted)
    const after = await list()
    expect(after.status).toBe(200)
    expect(after.text).not.toContain("OF-DELETED")
    expect(after.text).not.toContain("OF-GONE")
    expect(after.text).toContain("OF-LIVE")
    expect(after.text).toContain("NO-DOCUMENTS")
  }, TIMEOUT)

  it("FA-F42-R1-010: resolveCommitteeScope on its own, with the matter cached in-process, refuses the tombstoned matter (no route sync)", async () => {
    const docId = await seedDocument(partner.firmId, deleted, partner.uid)
    // Warm the in-process caches the way a route does: the documents GET syncs the firm's matters into the store.
    await call(documentsGet, partner, `/api/d1/documents?userId=${partner.uid}&docId=${docId}`)
    const store = getRuntimeStore()
    const repos = await getRuntimeRepositories(store)
    const actor = store.users.get(partner.uid)!
    // Control: the matter is cached and, before the tombstone, the scope resolves.
    expect(store.matters.has(deleted)).toBe(true)
    await expect(resolveCommitteeScope(store, repos, actor, { matterId: deleted })).resolves.toMatchObject({ matterId: deleted })
    await tombstone(partner.firmId, deleted)
    const outcome = (input: { matterId: string; documentIds?: string[] }) =>
      resolveCommitteeScope(store, repos, actor, input).then(() => "RESOLVED", (e: { status?: number; message?: string }) => `${e.status} ${e.message}`)
    expect(await outcome({ matterId: deleted })).toBe("404 unknown matter")
    expect(store.matters.has(deleted)).toBe(false)
    expect(await outcome({ matterId: deleted, documentIds: [docId] })).toBe("404 unknown matter")
    // A live matter of the firm still resolves.
    expect(await outcome({ matterId: live })).toBe("RESOLVED")
  }, TIMEOUT)

  it("FA-F42-R1-001: a same-key replay of a compose answered 200 before the tombstone is refused 403 matter_deleted after it (F02 path)", async () => {
    const key = randomUUID()
    const body = { action: "compose", actorId: partner.uid, matterId: deleted, templateId: getDocumentTypes()[0]!.id, title: TITLE, body: `${TITLE} body text`, classification: "internal", citedJudgmentIds: [], temporalCitations: [] }
    const first = await post(draftsPost, partner, "/api/d4/drafts", body, key)
    expect(first.status).toBeLessThan(300)
    // Control: before the tombstone the key replays (reused).
    const again = await post(draftsPost, partner, "/api/d4/drafts", body, key)
    expect(again.status).toBeLessThan(300)
    expect(again.text).toContain('"reused":true')
    await tombstone(partner.firmId, deleted)
    const fresh = await post(draftsPost, partner, "/api/d4/drafts", body, randomUUID())
    const replay = await post(draftsPost, partner, "/api/d4/drafts", body, key)
    expect(fresh.status).toBe(403)
    expect(replay.status).toBe(403)
    expect(replay.text).toContain("matter_deleted")
    expect(replay.text).not.toContain(TITLE)
  }, TIMEOUT)
})

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F42 R1 follow-up: the Next durable idempotency store on its own (the core without the F02 frame)", () => {
  // The local insecure-dev mode (tests/setup/auth-mode.ts) with Firestore persistence and no bearer: the core runs
  // directly, so its own durable store (platform/http/durableIdempotency.ts) answers the replay.
  const savedMode = process.env.SIKANDER_PERSISTENCE_MODE
  let matterId = ""
  const keys: string[] = []

  beforeEach(async () => {
    process.env.GCLOUD_PROJECT ??= "demo-sikander"
    process.env.FIREBASE_PROJECT_ID ??= process.env.GCLOUD_PROJECT
    restartAll()
    process.env.SIKANDER_PERSISTENCE_MODE = "firestore"
    await seedFirmARuntimeRecords()
    matterId = adminDb().collection("matters").doc().id
    await put("matters", matterId, { id: matterId, firmId: "firmA", clientId: "client_a", title: TITLE, courtId: "SHC", caseNumber: null, caseNumberStatus: "pending", status: "live", classification: "internal" })
    await put("matter_members", `${matterId}_partner_a`, { matterId, userId: "partner_a", firmId: "firmA" })
  }, TIMEOUT)

  afterEach(async () => {
    if (savedMode === undefined) delete process.env.SIKANDER_PERSISTENCE_MODE
    else process.env.SIKANDER_PERSISTENCE_MODE = savedMode
    restartAll()
    for (const c of ["drafts", "draft_versions", "draft_gate_results"]) {
      const snap = await adminDb().collection(c).where("matterId", "==", matterId).get()
      await Promise.all(snap.docs.map((d) => d.ref.delete()))
    }
  }, TIMEOUT)

  it("FA-F42-R1-001: the core's own replay of a stored compose is refused 403 matter_deleted once the matter is tombstoned", async () => {
    const key = randomUUID()
    keys.push(key)
    const body = { action: "compose", actorId: "partner_a", matterId, templateId: getDocumentTypes()[0]!.id, title: TITLE, body: `${TITLE} body text`, classification: "internal", citedJudgmentIds: [], temporalCitations: [] }
    const send = () => draftsPost(new Request("http://127.0.0.1/api/d4/drafts", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }))
    const first = await send()
    expect(first.status).toBeLessThan(300)
    const again = await send()
    expect(((await again.json()) as { reused?: boolean }).reused).toBe(true)
    await tombstone("firmA", matterId)
    const replay = await send()
    const text = await replay.text()
    expect(replay.status).toBe(403)
    expect(text).toContain("matter_deleted")
    expect(text).not.toContain(TITLE)
  }, TIMEOUT)
})
