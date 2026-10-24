// FA-F13-026: production Firebase auth + Firestore persistence — documents GET must not serve a stale in-process row
// when the stored row's firmId is malformed (get throws DocumentMalformedError; the route drops the cache).
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
import { FieldValue } from "firebase-admin/firestore"

requireAuthFirestoreEmulators("F13 FA-F13-026 documents firmId e2e")

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
  await firmRef.create({ name: `F13-026 ${firmId}`, dataResidency: "PK", plan: "internal", createdAt: FieldValue.serverTimestamp() })
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
  matterId: null,
  contentHash: "sha256:ab",
  sourceChannel: "web",
  classification: "internal",
  storagePath: "firm/obj",
  isImmutable: true,
  byteSize: 12,
  mimeType: "application/pdf",
  objectVersion: 1,
  uploadedBy: "u_up",
  objectBytesStatus: "available",
})

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 FA-F13-026: documents GET drops cache on malformed stored firmId", () => {
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

  it("a signed-in partner gets 404 and loses the stale cache when Firestore firmId is non-string", async () => {
    const partner = await provisionPartner()
    const docId = uniq("doc")
    const row = goodRow(partner.firmId)
    await adminDb().collection("documents").doc(docId).set(row)

    const store = getRuntimeStore()
    store.documents.set(docId, { id: docId, ...row, uploadedBy: partner.uid })
    expect(store.documents.get(docId)?.firmId).toBe(partner.firmId)

    await adminDb().collection("documents").doc(docId).set({ ...row, firmId: 12 })

    const res = await documentsGet(
      new Request(`http://127.0.0.1/api/d1/documents?userId=${partner.uid}&docId=${docId}`, {
        headers: { Authorization: `Bearer ${partner.token}`, "X-Firm-Id": partner.firmId },
      })
    )
    expect(res.status).toBe(404)
    expect(store.documents.has(docId)).toBe(false)
  })
})
