// Audit F13 (HIGH): the two API stacks disagreed about the canonical Firestore shape of a matter and of its
// membership rows. Cloud Functions (functions/src/d1/matter/ops.ts) writes `matterNo`, `stage`, `createdBy`,
// `createdAt` and only an optional `courtId`; Next (platform/persistence/firestoreSpineRepositories.ts) cast every row
// blindly to its own `Matter` (`courtId`, `caseNumber`, `caseNumberStatus`, a status union without `closed`) and wrote
// rows without `stage` / `matterNo` / `createdAt`, and membership rows without `createdAt` / `addedBy` /
// `classification` (overwriting the Functions row on every upsert).
//
// These contract tests run BOTH stacks against the same documents on the Auth + Firestore emulators: the Functions
// `api` router in process (the real ops) and the real Next route / Firestore repositories (production mode).
import { randomUUID } from "node:crypto"
import { Timestamp } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"
import { ApiError, viaApi } from "@/functions/test/api"
import { mintIdToken, uniq } from "@/functions/test/emu"

requireAuthFirestoreEmulators("F13 canonical Firestore shapes contract")

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

type FnMatter = Record<string, unknown> & { matterId: string }
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<{ checkId: string; result: string }>("runConflictCheck")
const openMatter = viaApi<FnMatter>("openMatter")
const getMatter = viaApi<FnMatter>("getMatter")
const listMatters = viaApi<{ items: FnMatter[]; nextCursor: string | null }>("listMatters")
const advanceStage = viaApi<FnMatter>("advanceStage")
const closeMatter = viaApi<FnMatter>("closeMatter")

type User = { uid: string; token: string; firmId: string }

async function newFirm(): Promise<string> {
  const firmId = uniq("f13firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F13", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  return firmId
}

async function user(firmId: string, role: "partner" | "associate" | "client", clearanceLevel = "privileged-restricted"): Promise<User> {
  const minted = await mintIdToken({ firmId, role, clearanceLevel })
  return { uid: minted.uid, token: minted.token, firmId }
}

let mobileSeq = 0
/** A matter opened by the Cloud Functions writer (openMatter on a CLEAR check), with no court. */
async function openViaFunctions(partner: User, extra: Record<string, unknown> = {}): Promise<FnMatter> {
  const client = await registerClient({
    token: partner.token,
    data: { firmId: partner.firmId, name: "Tariq Zarvani", type: "individual", primaryMobile: `0301${String(4000000 + ++mobileSeq)}`, classification: "internal" },
  } as never)
  const check = await runCheck({
    token: partner.token,
    data: { firmId: partner.firmId, client: { clientId: client.clientId }, opposingParties: [{ name: `Haris Qalbani ${mobileSeq}` }] },
  } as never)
  expect(check.result).toBe("CLEAR")
  return openMatter({
    token: partner.token,
    data: { firmId: partner.firmId, conflictCheckId: check.checkId, title: "Recovery suit", classification: "confidential", ...extra },
  } as never)
}

function authHeaders(u: User): Record<string, string> {
  return { Authorization: `Bearer ${u.token}`, "X-Firm-Id": u.firmId, "Content-Type": "application/json", "Idempotency-Key": randomUUID() }
}

async function nextPost(u: User, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await mattersPost(new Request("http://127.0.0.1/api/d1/matters", { method: "POST", headers: authHeaders(u), body: JSON.stringify(body) }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/**
 * The Next matters route resolves other users (the client of a new matter, an added member) from the process's
 * session cache only: a user is known once it has made a request. Each such user makes one listing request first.
 */
async function signInToNext(u: User): Promise<void> {
  const res = await mattersGet(
    new Request(`http://127.0.0.1/api/d1/matters?userId=${u.uid}&limit=1&cursor=0`, { headers: { Authorization: `Bearer ${u.token}`, "X-Firm-Id": u.firmId } })
  )
  expect(res.status).toBeLessThan(500)
}

async function fnError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (err) {
    if (err instanceof ApiError) return err
    throw err
  }
  throw new Error("expected the Functions call to fail")
}

const matterDoc = async (id: string) => (await adminDb().collection("matters").doc(id).get()).data()
const memberDoc = async (matterId: string, uid: string) => (await adminDb().collection("matter_members").doc(`${matterId}_${uid}`).get()).data()

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13: both API stacks read and write one canonical matter shape", { timeout: E2E_TIMEOUT_MS }, () => {
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

  it("D1: a matter Cloud Functions opened (no court) reads in Next and in Functions with the same canonical fields", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const opened = await openViaFunctions(partner)
    const id = opened.matterId

    const repo = createFirestoreRepositories(adminDb())
    const viaNext = await repo.matters.get(id, firmId)
    const canonical = {
      id,
      firmId,
      clientId: opened.clientId,
      title: "Recovery suit",
      classification: "confidential",
      matterNo: opened.matterNo,
      stage: "pre_filing",
      status: "engagement_unconfirmed",
      courtId: null,
      caseNumber: null,
      caseNumberStatus: "pending",
      createdBy: partner.uid,
    }
    expect(viaNext).toMatchObject(canonical)
    const listed = (await repo.matters.listByFirm(firmId)).find((row) => row.id === id)
    expect(listed).toMatchObject(canonical)

    const viaFunctions = await getMatter({ token: partner.token, data: { firmId, matterId: id } } as never)
    const { id: _id, ...fields } = canonical
    expect(viaFunctions).toMatchObject({ matterId: id, ...fields })
    // The document id is authoritative: neither stack hands out a stored `id` field that could disagree with it.
    expect(viaFunctions).not.toHaveProperty("id")
  })

  it("D1: a malformed matter document (status outside the canonical set) is refused by both stacks", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const opened = await openViaFunctions(partner)
    await adminDb().collection("matters").doc(opened.matterId).update({ status: "archived_by_hand" })

    const repo = createFirestoreRepositories(adminDb())
    expect(await repo.matters.get(opened.matterId, firmId)).toBeNull()
    expect((await repo.matters.listByFirm(firmId)).map((row) => row.id)).not.toContain(opened.matterId)

    const err = await fnError(getMatter({ token: partner.token, data: { firmId, matterId: opened.matterId } } as never))
    expect(err.status).toBe(409)
    expect(err.code).toBe("matter_malformed")
  })

  it("D3: Next confirm_engagement does not reopen a matter Cloud Functions closed", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const opened = await openViaFunctions(partner)
    await closeMatter({ token: partner.token, data: { firmId, matterId: opened.matterId, reason: "Client withdrew instructions." } } as never)
    expect((await matterDoc(opened.matterId))?.status).toBe("closed")

    const res = await nextPost(partner, { action: "confirm_engagement", actorId: partner.uid, matterId: opened.matterId })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect((await matterDoc(opened.matterId))?.status).toBe("closed")
  })

  it("D2: a matter Next creates is stored in the canonical shape, and Cloud Functions reads, lists and advances it", async () => {
    vi.stubEnv("SIKANDER_FLAG_LEGACY_D1_NEXT_WRITES", "true")
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const client = await user(firmId, "client", "public")
    await signInToNext(client)
    const clientUid = client.uid

    const created = await nextPost(partner, {
      action: "create",
      actorId: partner.uid,
      firmId,
      clientId: clientUid,
      title: "Next matter",
      courtId: "SHC",
      classification: "internal",
    })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const id = ((created.body.result as { matter: { id: string } }).matter).id

    const stored = await matterDoc(id)
    expect(stored).toMatchObject({
      firmId,
      clientId: clientUid,
      title: "Next matter",
      classification: "internal",
      matterNo: null,
      stage: "pre_filing",
      status: "engagement_unconfirmed",
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      createdBy: partner.uid,
    })
    expect(stored?.createdAt).toBeInstanceOf(Timestamp)
    expect(stored).not.toHaveProperty("id")
    const seat = await memberDoc(id, partner.uid)
    expect(seat).toMatchObject({ firmId, matterId: id, userId: partner.uid, addedBy: partner.uid, classification: "internal" })
    expect(seat?.createdAt).toBeInstanceOf(Timestamp)

    expect(await getMatter({ token: partner.token, data: { firmId, matterId: id } } as never)).toMatchObject({ matterId: id, stage: "pre_filing" })
    const listed = await listMatters({ token: partner.token, data: { firmId, limit: "10" } } as never)
    expect(listed.items.map((row) => row.matterId)).toContain(id)
    expect(await advanceStage({ token: partner.token, data: { firmId, matterId: id, to: "filed" } } as never)).toMatchObject({ stage: "filed" })
  })

  it("D5: Next add_member writes the canonical membership row, and Cloud Functions lists the matter for the new member", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const associate = await user(firmId, "associate")
    const opened = await openViaFunctions(partner)
    const partnerSeat = await memberDoc(opened.matterId, partner.uid)
    await signInToNext(associate)

    const added = await nextPost(partner, { action: "add_member", actorId: partner.uid, matterId: opened.matterId, memberUserId: associate.uid })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    const seat = await memberDoc(opened.matterId, associate.uid)
    expect(seat).toMatchObject({ firmId, matterId: opened.matterId, userId: associate.uid, addedBy: partner.uid, classification: "confidential" })
    expect(seat?.createdAt).toBeInstanceOf(Timestamp)

    const listed = await listMatters({ token: associate.token, data: { firmId, limit: "10" } } as never)
    expect(listed.items.map((row) => row.matterId)).toEqual([opened.matterId])

    // Re-seating an existing member through Next keeps the row Cloud Functions wrote (createdAt orders listMatters).
    await createFirestoreRepositories(adminDb()).members.upsert({ matterId: opened.matterId, userId: partner.uid, firmId })
    expect(await memberDoc(opened.matterId, partner.uid)).toEqual(partnerSeat)
  })

  it("D4: a legacy matter Next stored before the fix (no stage, no matterNo) is advanced by Cloud Functions as pre_filing", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const id = `f13-legacy-${randomUUID().slice(0, 8)}`
    await adminDb().collection("matters").doc(id).set({
      id,
      firmId,
      clientId: "f13-client",
      title: "Legacy Next matter",
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      status: "live",
      classification: "internal",
    })
    await adminDb().collection("matter_members").doc(`${id}_${partner.uid}`).set({ matterId: id, userId: partner.uid, firmId })

    expect(await getMatter({ token: partner.token, data: { firmId, matterId: id } } as never)).toMatchObject({ matterId: id, stage: "pre_filing", matterNo: null })
    expect(await advanceStage({ token: partner.token, data: { firmId, matterId: id, to: "filed" } } as never)).toMatchObject({ stage: "filed" })
    expect(await createFirestoreRepositories(adminDb()).matters.get(id, firmId)).toMatchObject({ id, stage: "filed", status: "live", matterNo: null })
  })
})
