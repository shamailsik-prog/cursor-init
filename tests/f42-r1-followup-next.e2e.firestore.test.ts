/**
 * Audit F42, the R1 follow-up (spec section 11), on the Next side: the routes entered the production way (Firebase auth,
 * Firestore persistence, no test-database injection, so the F02 Functions authority path in front of the Next core),
 * over the Auth and Firestore emulators. Each check has its control (the same read before the tombstone, or of a live
 * matter), so a probe whose control fails is inconclusive, not a pass.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { GET as committeeGet } from "@/app/api/p1/committee-brain/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
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
})
