/**
 * Audit F42 (Firestore + Auth emulators, production persistence, no test-database injection): the Next domain routes,
 * entered the production way (the Functions authority path, then the Next core over Firestore), refuse or omit a
 * tombstoned matter at once, before any purge has run; and a member whose access is revoked no longer finds the
 * matter in the reporting search.
 *
 * On main: the tombstoned matter is still listed by GET /api/d1/matters, still has a search row, its documents are
 * still listed and readable, a matter-named read is answered, and the revoked member still sees the matter in search.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { GET as mattersGet } from "@/app/api/d1/matters/route"
import { GET as documentsGet } from "@/app/api/d1/documents/route"
import { GET as reportingGet } from "@/app/api/d1/reporting/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"

requireAuthFirestoreEmulators("F42 tombstone Next e2e")

const TIMEOUT = 120_000
/** The collection platform/retention/tombstone.ts names (written out, so this file also runs, RED, on main). */
const MATTER_TOMBSTONES = "matter_tombstones"

type Verifier = (token: string) => Promise<{ uid: string } & Record<string, unknown>>
type SessionSeams = { setIdTokenVerifierForTests?: (verifier: Verifier | null) => void }
type Actor = { firmId: string; uid: string; token: string }

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

async function provisionFirm(): Promise<string> {
  const ref = adminDb().collection("firms").doc()
  await ref.create({ name: `F42 firm ${ref.id}`, dataResidency: "PK", plan: "internal" })
  return ref.id
}

async function provisionUser(firmId: string, role: "partner" | "clerk"): Promise<Actor> {
  const uid = adminDb().collection("users").doc().id
  const email = `${uid.toLowerCase()}@example.test`
  const password = "emulator-pass-123"
  await adminAuth().createUser({ uid, email, password })
  await adminAuth().setCustomUserClaims(uid, { firmId, role, clearanceLevel: "internal" })
  await adminDb().collection("users").doc(uid).set({ id: uid, firmId, role, clearanceLevel: "internal", active: true })
  const res = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  if (!res.ok) throw new Error(`emulator sign-in failed: ${res.status}`)
  return { firmId, uid, token: ((await res.json()) as { idToken: string }).idToken }
}

async function seedMatter(firmId: string, title: string, memberIds: string[]): Promise<string> {
  const id = adminDb().collection("matters").doc().id
  const batch = adminDb().batch()
  batch.set(adminDb().collection("matters").doc(id), {
    firmId,
    clientId: `f42-client-${firmId}`,
    title,
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "live",
    classification: "internal",
  })
  for (const userId of memberIds) {
    batch.set(adminDb().collection("matter_members").doc(`${id}_${userId}`), { matterId: id, userId, firmId })
  }
  await batch.commit()
  return id
}

async function seedDocument(firmId: string, matterId: string, uploadedBy: string): Promise<string> {
  const id = adminDb().collection("documents").doc().id
  await adminDb().collection("documents").doc(id).set({
    id,
    firmId,
    matterId,
    contentHash: "b".repeat(64),
    sourceChannel: "web",
    classification: "internal",
    storagePath: `fs://${firmId}/documents/${id}/v1`,
    isImmutable: true,
    byteSize: 10,
    mimeType: "application/pdf",
    objectVersion: 1,
    uploadedBy,
    objectBytesStatus: "missing",
  })
  return id
}

/** What the approval writes first: the tombstone. Memberships are left in place to prove the tombstone alone refuses. */
async function tombstone(firmId: string, matterId: string): Promise<void> {
  await adminDb().collection(MATTER_TOMBSTONES).doc(matterId).set({
    firmId,
    matterId,
    requestId: `f42-${matterId}`,
    classification: "internal",
    tombstonedAt: Timestamp.now(),
    requestedBy: "p1",
    approvedBy: "p2",
    membersRevoked: 0,
    policyVersion: "test",
    purgeCompletedAt: null,
  })
}

const headers = (a: Actor) => ({ Authorization: `Bearer ${a.token}`, "X-Firm-Id": a.firmId })
const get = async (handler: (r: Request) => Promise<Response>, a: Actor, path: string) => {
  const res = await handler(new Request(`http://127.0.0.1${path}`, { headers: headers(a) }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const searchIds = async (a: Actor) => {
  const { status, body } = await get(reportingGet, a, `/api/d1/reporting?view=search&rowType=matter&actorId=${a.uid}&limit=50&cursor=0`)
  expect(status).toBe(200)
  return ((body.items ?? []) as Array<{ referenceId: string }>).map((i) => i.referenceId)
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F42: the Next routes refuse a tombstoned matter at once", () => {
  let partner: Actor
  let clerk: Actor
  let colleague: Actor
  let deleted: string
  let kept: string
  let deletedDoc: string
  let keptDoc: string

  beforeEach(async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    restart()
    useEmulatorVerifier(true)
    const firmId = await provisionFirm()
    partner = await provisionUser(firmId, "partner")
    clerk = await provisionUser(firmId, "clerk")
    colleague = await provisionUser(firmId, "clerk")
    deleted = await seedMatter(firmId, "F42 deleted matter", [partner.uid, clerk.uid])
    kept = await seedMatter(firmId, "F42 kept matter", [partner.uid, clerk.uid, colleague.uid])
    deletedDoc = await seedDocument(firmId, deleted, partner.uid)
    keptDoc = await seedDocument(firmId, kept, partner.uid)
  }, TIMEOUT)

  afterEach(() => {
    useEmulatorVerifier(false)
    vi.unstubAllEnvs()
    restart()
  })

  it("lists, searches and reads omit or refuse the tombstoned matter, and only it", async () => {
    // Before: both matters are visible (the control).
    const before = await get(mattersGet, partner, `/api/d1/matters?userId=${partner.uid}&limit=50&cursor=0`)
    expect(before.status).toBe(200)
    expect(JSON.stringify(before.body)).toContain(deleted)
    expect(await searchIds(partner)).toContain(deleted)

    await tombstone(partner.firmId, deleted)

    const matters = await get(mattersGet, partner, `/api/d1/matters?userId=${partner.uid}&limit=50&cursor=0`)
    expect(matters.status).toBe(200)
    expect(JSON.stringify(matters.body)).not.toContain(deleted)
    expect(JSON.stringify(matters.body)).toContain(kept)

    const search = await searchIds(partner)
    expect(search).not.toContain(deleted)
    expect(search).toContain(kept)

    const docs = await get(documentsGet, partner, `/api/d1/documents?userId=${partner.uid}&limit=50&cursor=0`)
    expect(docs.status).toBe(200)
    expect(JSON.stringify(docs.body)).not.toContain(deletedDoc)
    expect(JSON.stringify(docs.body)).toContain(keptDoc)

    const byId = await get(documentsGet, partner, `/api/d1/documents?userId=${partner.uid}&docId=${deletedDoc}`)
    expect([403, 404]).toContain(byId.status)

    const named = await get(documentsGet, partner, `/api/d1/documents?userId=${partner.uid}&matterId=${deleted}&limit=10&cursor=0`)
    expect(named.status).toBe(403)
    expect(named.body.error).toEqual({ code: "matter_deleted" })

    // The repository every Next route reads through: a row of the tombstoned matter reads as absent, the other matter's do not.
    const repo = createFirestoreRepositories(adminDb() as never)
    expect(await repo.matters.get(deleted, partner.firmId)).toBeNull()
    expect(await repo.documents.get(deletedDoc, partner.firmId)).toBeNull()
    expect(await repo.reportingIndex.get(`matter:${deleted}`, partner.firmId)).toBeNull()
    expect(await repo.members.get(deleted, partner.uid, partner.firmId)).toBeNull()
    expect(await repo.matters.get(kept, partner.firmId)).not.toBeNull()
    expect(await repo.documents.get(keptDoc, partner.firmId)).not.toBeNull()
    expect(await repo.reportingIndex.get(`matter:${kept}`, partner.firmId)).not.toBeNull()
  }, TIMEOUT)

  it("a revoked member no longer finds the matter in search; the remaining members still do", async () => {
    expect(await searchIds(clerk)).toContain(kept)
    // Revocation without deletion: the clerk's membership row is removed (as a partner member may, firestore.rules).
    await adminDb().collection("matter_members").doc(`${kept}_${clerk.uid}`).delete()
    expect(await searchIds(clerk)).not.toContain(kept)
    expect(await searchIds(colleague)).toContain(kept)
    // A staff member who was never a member does not see it either (R-2: membership is the access source).
    const outsider = await provisionUser(partner.firmId, "clerk")
    expect(await searchIds(outsider)).not.toContain(kept)
  }, TIMEOUT)
})
