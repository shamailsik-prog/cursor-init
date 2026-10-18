// Audit F01, independent re-audit 2026-10-16 (FAIL 5/10). HIGH: a user that the Cloud Functions provisioned
// (createFirmUser and the founder document write no `id` field) got 404 on every Next route in production, because
// `getById` returned `snap.data()` without the document id and the session cached the user under `undefined`.
// MEDIUM (rule 2): the earlier closing e2e passed only through the in-memory demo `partner_a` under insecure-dev auth.
// LOW: the persistence and auth paths accepted emulator hosts under NODE_ENV=production.
//
// These tests drive the real Next route handlers the way production runs them: NODE_ENV=production (so the runtime
// store starts empty: no demo identities), SIKANDER_AUTH_MODE=firebase with a real ID token minted by the Auth
// emulator, SIKANDER_PERSISTENCE_MODE=firestore on Admin Firestore (the emulator), and identity rows shaped exactly
// as the Functions writers write them (functions/src/p5/identity.ts: createFirmUserOp and onboardFirmOp).
//
// Two test seams carry the emulators in, because a production process now refuses both emulator hosts:
//   - setFirestorePersistenceForTests(db): the Admin Firestore of the emulator (it exists on main);
//   - setIdTokenVerifierForTests(verifier): firebase-admin's own verifyIdToken against the Auth emulator. It is read
//     loosely, so this file also runs against main, where it does not exist (main verified emulator tokens in
//     production on its own: the LOW this follow-up closes).
import { randomUUID } from "node:crypto"
import { FieldValue } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"

requireAuthFirestoreEmulators("F01 production identity e2e")

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

/** A fresh Next process: nothing in memory survives; Firestore does. */
function restart(): void {
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
  session.resetSessionStateForTests()
  resetProductionFirestoreForTests()
}

type Provisioned = { firmId: string; uid: string; token: string }

/** onboardFirmOp's firm document (functions/src/p5/identity.ts). */
async function provisionFirm(): Promise<string> {
  const ref = adminDb().collection("firms").doc()
  await ref.create({ name: `F01 firm ${ref.id}`, dataResidency: "PK", plan: "internal", createdAt: FieldValue.serverTimestamp() })
  return ref.id
}

/**
 * createFirmUserOp, step for step: a Firestore auto id as the uid, the Auth user, its custom claims, then the users
 * document with exactly the fields the Functions writer stores (no `id`). Then a password sign-in for a real ID token.
 */
async function provisionUser(firmId: string, role: "partner" | "associate", clearanceLevel: string): Promise<Provisioned> {
  const uid = adminDb().collection("users").doc().id
  const email = `${uid.toLowerCase()}@example.test`
  const password = "emulator-pass-123"
  await adminAuth().createUser({ uid, email, password })
  await adminAuth().setCustomUserClaims(uid, { firmId, role, clearanceLevel })
  await adminDb().collection("users").doc(uid).create({
    firmId,
    role,
    clearanceLevel,
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

/** A matter of the firm, persisted earlier by a Next instance (Next's own matter shape), with the given members. */
async function persistMatter(firmId: string, memberIds: string[]): Promise<string> {
  const id = `f01-matter-${randomUUID().slice(0, 8)}`
  await adminDb().collection("matters").doc(id).set({
    id,
    firmId,
    clientId: `f01-client-${id}`,
    title: `F01 production matter ${id}`,
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "engagement_unconfirmed",
    classification: "internal",
  })
  for (const userId of memberIds) {
    await adminDb().collection("matter_members").doc(`${id}_${userId}`).set({ matterId: id, userId, firmId })
  }
  return id
}

function authHeaders(user: Provisioned): Record<string, string> {
  return { Authorization: `Bearer ${user.token}`, "X-Firm-Id": user.firmId }
}

type MatterRow = { id: string; status: string; title: string; firmId: string }

async function listMatters(user: Provisioned): Promise<{ status: number; body: { items?: MatterRow[]; error?: unknown } }> {
  const res = await mattersGet(
    new Request(`http://127.0.0.1/api/d1/matters?userId=${user.uid}&limit=50&cursor=0`, { headers: authHeaders(user) })
  )
  return { status: res.status, body: (await res.json()) as { items?: MatterRow[]; error?: unknown } }
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F01: production identity and persistence through the Next routes", { timeout: E2E_TIMEOUT_MS }, () => {
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

  it("starts from the production store: no demo identities to fall back on", () => {
    expect(getRuntimeStore().users.size).toBe(0)
  })

  it("a partner provisioned by the Functions writer lists the firm's matter (200, not 404)", async () => {
    const firmId = await provisionFirm()
    const partner = await provisionUser(firmId, "partner", "privileged-restricted")
    const matterId = await persistMatter(firmId, [partner.uid])

    const listed = await listMatters(partner)
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.items?.map((row) => row.id)).toEqual([matterId])
    // The session cached the user under its uid, never under `undefined`.
    expect(getRuntimeStore().users.get(partner.uid)?.id).toBe(partner.uid)
    expect(getRuntimeStore().users.has("undefined")).toBe(false)
  })

  it("a matter write through the route survives a restart and is read back from Firestore", async () => {
    const firmId = await provisionFirm()
    const partner = await provisionUser(firmId, "partner", "privileged-restricted")
    const matterId = await persistMatter(firmId, [partner.uid])

    const confirmed = await mattersPost(
      new Request("http://127.0.0.1/api/d1/matters", {
        method: "POST",
        headers: { ...authHeaders(partner), "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ action: "confirm_engagement", actorId: partner.uid, matterId }),
      })
    )
    expect(confirmed.status, await confirmed.clone().text()).toBe(200)
    expect((await adminDb().collection("matters").doc(matterId).get()).data()?.status).toBe("live")

    restart()
    setFirestorePersistenceForTests(adminDb())
    useEmulatorVerifier(true)
    expect(getRuntimeStore().matters.size).toBe(0)

    const listed = await listMatters(partner)
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.items?.find((row) => row.id === matterId)).toMatchObject({ status: "live", firmId })
  })

  it("an associate added on the Functions side sees only matters it is a member of", async () => {
    const firmId = await provisionFirm()
    const partner = await provisionUser(firmId, "partner", "privileged-restricted")
    const associate = await provisionUser(firmId, "associate", "privileged")
    const shared = await persistMatter(firmId, [partner.uid, associate.uid])
    await persistMatter(firmId, [partner.uid])

    const listed = await listMatters(associate)
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.items?.map((row) => row.id)).toEqual([shared])
  })

  it("a users record that names another firm than the token is refused as firm_mismatch, as Cloud Functions answers", async () => {
    const firmA = await provisionFirm()
    const firmB = await provisionFirm()
    const partner = await provisionUser(firmA, "partner", "privileged-restricted")
    // An operator moved the record to firm B; the token still carries firm A's claims.
    await adminDb().collection("users").doc(partner.uid).update({ firmId: firmB })

    const listed = await listMatters(partner)
    expect(listed.status, JSON.stringify(listed.body)).toBe(403)
    expect(JSON.stringify(listed.body)).toContain("FIRM_MISMATCH")
  })

  it("another firm's partner never sees this firm's matter", async () => {
    const firmA = await provisionFirm()
    const firmB = await provisionFirm()
    const partnerA = await provisionUser(firmA, "partner", "privileged-restricted")
    const partnerB = await provisionUser(firmB, "partner", "privileged-restricted")
    await persistMatter(firmA, [partnerA.uid])
    const matterB = await persistMatter(firmB, [partnerB.uid])

    const listed = await listMatters(partnerB)
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.items?.map((row) => row.id)).toEqual([matterB])
  })
})

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F01 LOW: a production process refuses emulator hosts", { timeout: E2E_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    restart()
  })

  afterEach(() => {
    useEmulatorVerifier(false)
    setFirestorePersistenceForTests(null)
    vi.unstubAllEnvs()
    restart()
  })

  it("FIREBASE_AUTH_EMULATOR_HOST under NODE_ENV=production: an emulator token is refused (503), never verified", async () => {
    const firmId = await provisionFirm()
    const partner = await provisionUser(firmId, "partner", "privileged-restricted")
    await persistMatter(firmId, [partner.uid])
    setFirestorePersistenceForTests(adminDb())

    const listed = await listMatters(partner)
    expect(listed.status, JSON.stringify(listed.body)).toBe(503)
    expect(JSON.stringify(listed.body)).toContain("AUTH_MISCONFIGURED")
  })

  it("FIRESTORE_EMULATOR_HOST under NODE_ENV=production: identity reads fail closed (503), never reach the emulator", async () => {
    const firmId = await provisionFirm()
    const partner = await provisionUser(firmId, "partner", "privileged-restricted")
    await persistMatter(firmId, [partner.uid])
    // No test database: the process resolves its own production Firestore, with FIRESTORE_EMULATOR_HOST still set.
    setFirestorePersistenceForTests(null)
    useEmulatorVerifier(true)

    const listed = await listMatters(partner)
    expect(listed.status, JSON.stringify(listed.body)).toBe(503)
    expect(JSON.stringify(listed.body)).toContain("IDENTITY_UNAVAILABLE")
  })
})
