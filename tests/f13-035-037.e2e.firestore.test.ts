// FA-F13-035: documents list exposes droppedDocuments from listByFirm.
// FA-F13-036: Firestore-mode GET by docId must not fall back to cache when get returns null.
import { FieldValue } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as documentsGet } from "@/app/api/d1/documents/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"
import { uniq } from "@/functions/test/emu"

requireAuthFirestoreEmulators("F13 FA-F13-035/036 documents e2e")

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

type Verifier = (token: string) => Promise<{ uid: string } & Record<string, unknown>>
type SessionSeams = { setIdTokenVerifierForTests?: (verifier: Verifier | null) => void }
type Provisioned = { firmId: string; uid: string; token: string }

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

async function provisionPartner(): Promise<Provisioned> {
  const firmRef = adminDb().collection("firms").doc()
  const firmId = firmRef.id
  await firmRef.create({
    name: `F13-035 ${firmId}`,
    dataResidency: "PK",
    plan: "internal",
    createdAt: FieldValue.serverTimestamp(),
  })
  const uid = adminDb().collection("users").doc().id
  const email = `${uid.toLowerCase()}@example.test`
  const password = "emulator-pass-123"
  await adminAuth().createUser({ uid, email, password })
  await adminAuth().setCustomUserClaims(uid, { firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  await adminDb().collection("users").doc(uid).create({
    firmId,
    role: "partner",
    clearanceLevel: "privileged-restricted",
    mfaEnabled: false,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
  })
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

const goodRow = (firmId: string) => ({
  firmId,
  matterId: null as string | null,
  contentHash: "sha256:ab",
  sourceChannel: "web" as const,
  classification: "internal" as const,
  storagePath: "firm/obj",
  isImmutable: true,
  byteSize: 12,
  mimeType: "application/pdf",
  objectVersion: 1,
  uploadedBy: "u_up",
  objectBytesStatus: "available" as const,
})

function authGet(partner: Provisioned, query: string) {
  return documentsGet(
    new Request(`http://127.0.0.1/api/d1/documents?${query}`, {
      headers: { Authorization: `Bearer ${partner.token}`, "X-Firm-Id": partner.firmId },
    })
  )
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 FA-F13-035: documents list reports dropped rows", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
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

  it("a signed-in partner sees droppedDocuments for malformed same-firm rows", async () => {
    const partner = await provisionPartner()
    const okId = uniq("doc_ok")
    const badId = uniq("doc_bad")
    await adminDb().collection("documents").doc(okId).set(goodRow(partner.firmId))
    await adminDb().collection("documents").doc(badId).set({ ...goodRow(partner.firmId), byteSize: "12" })

    const res = await authGet(partner, `userId=${partner.uid}&limit=50&cursor=0`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { id: string }[]; droppedDocuments?: { id: string; reason: string }[] }
    expect(body.items.map((row) => row.id)).toEqual([okId])
    expect(body.droppedDocuments).toEqual([{ id: badId, reason: "byteSize" }])
  })
})

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 FA-F13-036: documents GET drops cache when Firestore get is null", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
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

  it("returns 404 (not 400) and clears cache when the row was deleted in Firestore", async () => {
    const partner = await provisionPartner()
    const docId = uniq("doc")
    const row = goodRow(partner.firmId)
    await adminDb().collection("documents").doc(docId).set(row)
    const store = getRuntimeStore()
    store.documents.set(docId, { id: docId, ...row, uploadedBy: partner.uid })
    await adminDb().collection("documents").doc(docId).delete()

    const res = await authGet(partner, `userId=${partner.uid}&docId=${docId}`)
    expect(res.status).toBe(404)
    expect(store.documents.has(docId)).toBe(false)
  })

  it("returns 404 and clears cache when Firestore row belongs to another firm", async () => {
    const partner = await provisionPartner()
    const otherFirm = uniq("firm_other")
    const docId = uniq("doc")
    const row = goodRow(otherFirm)
    await adminDb().collection("documents").doc(docId).set(row)
    const store = getRuntimeStore()
    store.documents.set(docId, { id: docId, ...goodRow(partner.firmId), uploadedBy: partner.uid })

    const res = await authGet(partner, `userId=${partner.uid}&docId=${docId}`)
    expect(res.status).toBe(404)
    expect(store.documents.has(docId)).toBe(false)
  })

  it("returns 404 and clears cache when stored firmId is padded and does not match the caller firm", async () => {
    const partner = await provisionPartner()
    const docId = uniq("doc")
    const paddedFirm = `${partner.firmId}   `
    await adminDb().collection("documents").doc(docId).set({ ...goodRow(paddedFirm), firmId: paddedFirm })
    const store = getRuntimeStore()
    store.documents.set(docId, { id: docId, ...goodRow(partner.firmId), uploadedBy: partner.uid })

    const res = await authGet(partner, `userId=${partner.uid}&docId=${docId}`)
    expect(res.status).toBe(404)
    expect(store.documents.has(docId)).toBe(false)
  })
})
