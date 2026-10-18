// Audit F12 (HIGH): the Next Firestore repositories read the entire collection and applied firmId in JavaScript
// (`getDocs(collection(...))`, 122 such scans in firestoreSpineRepositories.ts), so one request paid to read, and held
// in the server process, every tenant's rows. The fix queries `firmId` (and the matter / package field) in the
// database, pages with a stable cursor and validates rows.
//
// These tests drive the real GET /api/d1/matters route (production mode: firebase auth with an emulator ID token,
// Admin Firestore on the emulator) while another firm's rows sit in the same collections, and record every document
// that a Firestore query returned to the server process (firebase-admin's Query.prototype.get, which collection
// scans and filtered queries share). A scan returns the other firm's rows; a firm-scoped query never does.
// The identity rows here carry `id` (Next's own shape), so the route also answers on main, where F01's missing-id
// defect would otherwise stop the request before any listing.
import { randomUUID } from "node:crypto"
import { Query, type QuerySnapshot } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as mattersGet } from "@/app/api/d1/matters/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"

requireAuthFirestoreEmulators("F12 firm-scoped reads e2e")

/**
 * The first emulator ID-token verification also resolves firebase-admin's credentials (a metadata-server probe that
 * waits out its own timeouts off Google Cloud), which alone can exceed the suite's 15 s default on a loaded machine.
 */
const E2E_TIMEOUT_MS = 90_000

type Verifier = (token: string) => Promise<{ uid: string } & Record<string, unknown>>
type SessionSeams = { setIdTokenVerifierForTests?: (verifier: Verifier | null) => void }

/** The session's token-verifier seam (absent on main, where the production verifier accepted emulator tokens). */
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

type QueryRead = { collection: string; firmId: unknown }

/** Every document a Firestore query hands to this process while `fn` runs. */
async function recordQueryReads<T>(fn: () => Promise<T>): Promise<{ result: T; reads: QueryRead[] }> {
  const reads: QueryRead[] = []
  const original = Query.prototype.get
  const spy = vi.spyOn(Query.prototype, "get").mockImplementation(async function (this: Query) {
    const snap = (await original.call(this)) as QuerySnapshot
    for (const row of snap.docs) reads.push({ collection: row.ref.parent.id, firmId: row.get("firmId") })
    return snap
  })
  try {
    return { result: await fn(), reads }
  } finally {
    spy.mockRestore()
  }
}

type Provisioned = { firmId: string; uid: string; token: string }

async function provisionFirm(): Promise<string> {
  const ref = adminDb().collection("firms").doc()
  await ref.create({ name: `F12 firm ${ref.id}`, dataResidency: "PK", plan: "internal" })
  return ref.id
}

async function provisionUser(firmId: string, role: "partner" | "associate", clearanceLevel: string): Promise<Provisioned> {
  const uid = adminDb().collection("users").doc().id
  const email = `${uid.toLowerCase()}@example.test`
  const password = "emulator-pass-123"
  await adminAuth().createUser({ uid, email, password })
  await adminAuth().setCustomUserClaims(uid, { firmId, role, clearanceLevel })
  await adminDb().collection("users").doc(uid).set({ id: uid, firmId, role, clearanceLevel, active: true })
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

/** `count` matters of the firm, each with the given members, written in batches (Next's own matter shape). */
async function persistMatters(firmId: string, memberIds: string[], count: number): Promise<string[]> {
  const ids: string[] = []
  let batch = adminDb().batch()
  let staged = 0
  const flush = async () => {
    if (staged > 0) await batch.commit()
    batch = adminDb().batch()
    staged = 0
  }
  for (let i = 0; i < count; i += 1) {
    const id = `f12-${firmId}-${String(i).padStart(4, "0")}`
    ids.push(id)
    batch.set(adminDb().collection("matters").doc(id), {
      id,
      firmId,
      clientId: `f12-client-${firmId}`,
      title: `F12 matter ${i}`,
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      status: "live",
      classification: "internal",
    })
    staged += 1
    for (const userId of memberIds) {
      batch.set(adminDb().collection("matter_members").doc(`${id}_${userId}`), { matterId: id, userId, firmId })
      staged += 1
    }
    if (staged >= 400) await flush()
  }
  await flush()
  return ids
}

async function listMatters(user: Provisioned): Promise<{ status: number; body: { items?: Array<{ id: string }>; total?: number } }> {
  const res = await mattersGet(
    new Request(`http://127.0.0.1/api/d1/matters?userId=${user.uid}&limit=50&cursor=0`, {
      headers: { Authorization: `Bearer ${user.token}`, "X-Firm-Id": user.firmId },
    })
  )
  return { status: res.status, body: (await res.json()) as { items?: Array<{ id: string }>; total?: number } }
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F12: Next repositories read only the caller's firm", { timeout: E2E_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    restart()
    setFirestorePersistenceForTests(adminDb())
    useEmulatorVerifier(true)
  })

  afterEach(() => {
    useEmulatorVerifier(false)
    setFirestorePersistenceForTests(null)
    vi.unstubAllEnvs()
    restart()
  })

  it("listing matters reads no document of another firm", async () => {
    const firmA = await provisionFirm()
    const firmB = await provisionFirm()
    const partnerA = await provisionUser(firmA, "partner", "privileged-restricted")
    const peersB = await Promise.all([1, 2, 3].map(() => provisionUser(firmB, "associate", "privileged")))
    const [matterA] = await persistMatters(firmA, [partnerA.uid], 1)
    await persistMatters(firmB, peersB.map((p) => p.uid), 5)

    const { result: listed, reads } = await recordQueryReads(() => listMatters(partnerA))
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.items?.map((row) => row.id)).toEqual([matterA])

    // The route did query Firestore (matters and memberships), and every row it got back is firm A's.
    expect(reads.filter((read) => read.collection === "matters").length).toBeGreaterThan(0)
    const foreign = reads.filter((read) => read.firmId !== firmA)
    expect(foreign, `rows of other firms read: ${JSON.stringify(foreign.slice(0, 5))} (${foreign.length})`).toEqual([])
  })

  it("a firm with more rows than one query page is listed completely (no silent truncation)", async () => {
    const firmA = await provisionFirm()
    const partnerA = await provisionUser(firmA, "partner", "privileged-restricted")
    const ids = await persistMatters(firmA, [partnerA.uid], 520)

    const listed = await listMatters(partnerA)
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.total).toBe(ids.length)
  })
})
