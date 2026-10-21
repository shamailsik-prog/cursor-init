// Audit F13 slice 3 (FA-F13-001): the Next matters route resolves the users it names (a new matter's client and
// members, an added member) through the firm-scoped users repository, not only from the process's session cache.
// Auth + Firestore emulators.
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as mattersPost } from "@/app/api/d1/matters/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS } from "@/tests/helpers/emulator-require"
import { mintIdToken, uniq } from "@/functions/test/emu"
import { viaApi } from "@/functions/test/api"

const E2E_TIMEOUT_MS = 90_000
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

type User = { uid: string; token: string; firmId: string }

async function newFirm(): Promise<string> {
  const firmId = uniq("f13s3firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F13", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  return firmId
}

async function user(firmId: string, role: "partner" | "associate" | "client", clearanceLevel = "privileged-restricted"): Promise<User> {
  const minted = await mintIdToken({ firmId, role, clearanceLevel })
  return { uid: minted.uid, token: minted.token, firmId }
}

async function nextPost(u: User, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = { Authorization: `Bearer ${u.token}`, "X-Firm-Id": u.firmId, "Content-Type": "application/json", "Idempotency-Key": randomUUID() }
  const res = await mattersPost(new Request("http://127.0.0.1/api/d1/matters", { method: "POST", headers, body: JSON.stringify(body) }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const create = (p: User, clientId: string, memberUserIds: string[] = []) =>
  nextPost(p, { action: "create", actorId: p.uid, firmId: p.firmId, clientId, title: "Recovery suit", courtId: "lhc", classification: "internal", memberUserIds })

type FnMatter = Record<string, unknown> & { matterId: string }
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<{ checkId: string; result: string }>("runConflictCheck")
const openMatter = viaApi<FnMatter>("openMatter")

/** A matter opened by the Cloud Functions writer (openMatter on a CLEAR check), with no court. */
async function openViaFunctions(partner: User): Promise<FnMatter> {
  const client = await registerClient({
    token: partner.token,
    data: { firmId: partner.firmId, name: "Tariq Zarvani", type: "individual", primaryMobile: `0301${String(4000000 + Math.floor(Math.random() * 999999))}`, classification: "internal" },
  } as never)
  const check = await runCheck({
    token: partner.token,
    data: { firmId: partner.firmId, client: { clientId: client.clientId }, opposingParties: [{ name: `Haris Qalbani ${randomUUID().slice(0, 6)}` }] },
  } as never)
  expect(check.result).toBe("CLEAR")
  return openMatter({ token: partner.token, data: { firmId: partner.firmId, conflictCheckId: check.checkId, title: "Recovery suit", classification: "confidential" } } as never)
}

const matterDoc = async (id: string) => (await adminDb().collection("matters").doc(id).get()).data()

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 slice 3: the matters route resolves named users from the repository (FA-F13-001); record_case_number stores a missing court (FA-F13-002)", { timeout: E2E_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    // The legacy check-free create path is the one this finding names.
    vi.stubEnv("SIKANDER_FLAG_LEGACY_D1_NEXT_WRITES", "true")
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

  it("create accepts a client and a member who have never made a request in this process", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const client = await user(firmId, "client")
    const associate = await user(firmId, "associate")
    const res = await create(partner, client.uid, [associate.uid])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const matterId = (res.body.result as { matter: { id: string } }).matter.id
    expect((await adminDb().collection("matter_members").doc(`${matterId}_${associate.uid}`).get()).exists).toBe(true)
  })

  it("add_member seats a same-firm associate who has never made a request in this process", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const client = await user(firmId, "client")
    const created = await create(partner, client.uid)
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const matterId = (created.body.result as { matter: { id: string } }).matter.id
    restart()
    setFirestorePersistenceForTests(adminDb())
    const associate = await user(firmId, "associate")
    const res = await nextPost(partner, { action: "add_member", actorId: partner.uid, matterId, memberUserId: associate.uid })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it("the repository lookup stays firm-scoped and skips deactivated users", async () => {
    const firmId = await newFirm()
    const otherFirm = await newFirm()
    const partner = await user(firmId, "partner")
    const foreignClient = await user(otherFirm, "client")
    const foreignAssociate = await user(otherFirm, "associate")
    const client = await user(firmId, "client")
    const inactive = await user(firmId, "associate")
    await adminDb().collection("users").doc(inactive.uid).update({ active: false })
    for (const res of [
      await create(partner, foreignClient.uid),
      await create(partner, client.uid, [foreignAssociate.uid]),
      await create(partner, client.uid, [inactive.uid]),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400)
      expect(res.body.error).not.toBe("feature_disabled")
    }
    // The same request with an active same-firm member succeeds, so the refusals above are the user checks.
    const ok = await create(partner, client.uid)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((await adminDb().collection("matters").where("firmId", "==", firmId).get()).size).toBe(1)
  })

  it("FA-F13-002: record_case_number stores its courtId on a matter opened without a court, and never replaces a set court", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const m = await openViaFunctions(partner)
    expect((await matterDoc(m.matterId))?.courtId ?? null).toBeNull()
    const rc = await nextPost(partner, { action: "record_case_number", actorId: partner.uid, matterId: m.matterId, raw: "Suit No. 12 of 2024", courtId: "SHC" })
    expect(rc.status, JSON.stringify(rc.body)).toBe(200)
    expect(await matterDoc(m.matterId)).toMatchObject({ courtId: "SHC", caseNumberStatus: "recorded" })
    const again = await nextPost(partner, { action: "record_case_number", actorId: partner.uid, matterId: m.matterId, raw: "Suit No. 13 of 2024", courtId: "LHC" })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect((await matterDoc(m.matterId))?.courtId).toBe("SHC")
  })

  it("FA-F13-002: the repository write keeps a court already stored, whatever court the patch carries", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const m = await openViaFunctions(partner)
    await adminDb().collection("matters").doc(m.matterId).update({ courtId: "SHC" })
    const repo = createFirestoreRepositories(adminDb() as never)
    await repo.matters.recordCaseNumber(m.matterId, firmId, { caseNumber: "SHC/Suit/12/2024", caseNumberStatus: "recorded", courtId: "LHC" })
    expect(await matterDoc(m.matterId)).toMatchObject({ courtId: "SHC", caseNumber: "SHC/Suit/12/2024" })
  })
})
