// Audit F13 slice 2 (FA-F13-011..013): the record_case_number close race (one transaction), the server timestamp of
// a firebase-admin copy other than the root one (Cloud Functions bundles 13.x, the Next server 14.x), and the
// matter_members type fence in firestore.rules. Both stacks, Auth + Firestore emulators.
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { Firestore as RootFirestore, Timestamp } from "firebase-admin/firestore"
import { doc as cdoc, serverTimestamp as cserverTimestamp, setDoc as csetDoc, updateDoc as cupdateDoc } from "firebase/firestore"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
import { adminDb as functionsAdminDb } from "@/functions/src/admin"

/**
 * FA-F13-011: a Functions close landing between the route's closed check and the case-number write. Fires at the
 * write itself: the plain matters `updateDoc` carrying the case number or, after the fix, the repository's one-transaction
 * `matters.recordCaseNumber`, whichever the route reaches first.
 */
const hooks: { beforeCaseNumberWrite?: (id: string) => Promise<void> } = {}
async function fireHook(id: string): Promise<void> {
  const h = hooks.beforeCaseNumberWrite
  if (h) {
    hooks.beforeCaseNumberWrite = undefined
    await h(id)
  }
}
vi.mock("@/platform/persistence/firestoreDbModular", async (orig) => {
  const mod = (await orig()) as Record<string, unknown> & { updateDoc: (ref: { path?: string }, data: unknown) => Promise<unknown> }
  return {
    ...mod,
    updateDoc: async (ref: { path?: string }, data: unknown) => {
      const path = ref.path ?? ""
      if (path.startsWith("matters/") && typeof data === "object" && data !== null && "caseNumber" in data) {
        await fireHook(path.slice("matters/".length))
      }
      return mod.updateDoc(ref, data)
    },
  }
})
vi.mock("@/platform/persistence/firestoreSpineRepositories", async (orig) => {
  type Repos = { matters: Record<string, ((...args: never[]) => Promise<unknown>) | undefined> }
  const mod = (await orig()) as Record<string, unknown> & { createFirestoreRepositories: (db: unknown) => Repos }
  return {
    ...mod,
    createFirestoreRepositories: (db: unknown) => {
      const repos = mod.createFirestoreRepositories(db)
      const fn = repos.matters.recordCaseNumber
      if (fn) {
        repos.matters.recordCaseNumber = (async (...args: never[]) => {
          await fireHook(args[0] as unknown as string)
          return fn.apply(repos.matters, args)
        }) as never
      }
      return repos
    },
  }
})


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

let rulesEnv: RulesTestEnvironment | undefined
async function rules(): Promise<RulesTestEnvironment> {
  rulesEnv ??= await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT ?? "demo-sikander",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  })
  return rulesEnv
}

const close = (p: User, matterId: string) =>
  closeMatter({ token: p.token, data: { firmId: p.firmId, matterId, reason: "Client withdrew instructions entirely." } } as never)

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 slice 2: case-number race, admin copies, member rules fence", { timeout: E2E_TIMEOUT_MS }, () => {
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
    hooks.beforeCaseNumberWrite = undefined
    useEmulatorVerifier(false)
    setFirestorePersistenceForTests(null)
    vi.unstubAllEnvs()
    restart()
  })

  afterAll(async () => {
    await rulesEnv?.cleanup()
  })

  it("FA-F13-011: a close landing between the closed check and the case-number write answers 409 and leaves no case number", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const m = await openViaFunctions(partner)
    let fired = false
    hooks.beforeCaseNumberWrite = async (id) => {
      fired = true
      await close(partner, id)
    }
    const rc = await nextPost(partner, { action: "record_case_number", actorId: partner.uid, matterId: m.matterId, raw: "Suit No. 12 of 2024", courtId: "SHC" })
    expect(fired, "the close lands at the case-number write").toBe(true)
    expect(rc.status, JSON.stringify(rc.body)).toBe(409)
    expect(rc.body.code).toBe("matter_closed")
    expect(await matterDoc(m.matterId)).toMatchObject({ status: "closed", caseNumber: null, caseNumberStatus: "pending" })
  })

  it("FA-F13-011: concurrent record_case_number and Functions close never leave a case number on a closed matter", async () => {
    for (let i = 0; i < 8; i++) {
      const firmId = await newFirm()
      const partner = await user(firmId, "partner")
      const m = await openViaFunctions(partner)
      const [closed, recorded] = await Promise.allSettled([
        close(partner, m.matterId),
        nextPost(partner, { action: "record_case_number", actorId: partner.uid, matterId: m.matterId, raw: "Suit No. 12 of 2024", courtId: "SHC" }),
      ])
      const stored = await matterDoc(m.matterId)
      if (closed.status === "fulfilled" && recorded.status === "fulfilled" && recorded.value.status === 200) {
        // The record committed first: the close followed it, which is allowed (the number was recorded while live).
        expect(stored?.status).toBe("closed")
      }
      if (recorded.status === "fulfilled" && recorded.value.status === 409) expect(stored?.caseNumber ?? null).toBeNull()
      if (recorded.status === "fulfilled") expect([200, 409]).toContain(recorded.value.status)
    }
  })

  it("FA-F13-012: Next writes a server createdAt through a root (14.x) and a Cloud Functions (13.x) firebase-admin instance", async () => {
    const fnDb = functionsAdminDb()
    // The two are different firebase-admin copies: an instanceof check against the root class cannot see the other.
    expect(fnDb instanceof RootFirestore).toBe(false)
    expect(adminDb() instanceof RootFirestore).toBe(true)
    for (const [name, db] of [["root", adminDb()], ["functions", fnDb]] as const) {
      const firmId = await newFirm()
      const partner = await user(firmId, "partner")
      const repo = createFirestoreRepositories(db as never)
      const id = uniq(`f13s2-${name}`)
      await repo.matters.create({
        id,
        firmId,
        clientId: uniq("client"),
        title: `Admin copy ${name}`,
        classification: "internal",
        courtId: null,
        caseNumber: null,
        caseNumberStatus: "pending",
        status: "engagement_unconfirmed",
        matterNo: null,
        stage: "pre_filing",
        createdBy: partner.uid,
      } as never)
      await repo.members.upsert({ firmId, matterId: id, userId: partner.uid, addedBy: partner.uid } as never)
      expect((await matterDoc(id))?.createdAt, name).toBeInstanceOf(Timestamp)
      expect((await memberDoc(id, partner.uid))?.createdAt, name).toBeInstanceOf(Timestamp)
    }
  })

  it("FA-F13-013: the rules refuse a member partner's wrong-typed membership row", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const associate = await user(firmId, "associate")
    const m = await openViaFunctions(partner)
    const claims = { firmId, role: "partner", clearanceLevel: "privileged-restricted" }
    await adminDb().collection("users").doc(partner.uid).set({ ...claims, active: true }, { merge: true })
    await adminDb().collection("users").doc(associate.uid).set({ firmId, role: "associate", clearanceLevel: "internal", active: true }, { merge: true })
    const firebase = { sign_in_provider: "password", sign_in_second_factor: "phone" } as unknown as { sign_in_provider: "password" }
    const db = (await rules()).authenticatedContext(partner.uid, { ...claims, firebase }).firestore()
    const ref = cdoc(db, "matter_members", `${m.matterId}_${associate.uid}`)
    const base = { firmId, matterId: m.matterId, userId: associate.uid, createdAt: cserverTimestamp() }
    await assertFails(csetDoc(ref, { ...base, addedBy: 42 }))
    await assertFails(csetDoc(ref, { ...base, classification: 7 }))
    await assertFails(csetDoc(ref, { ...base, classification: "top-secret" }))
    // The canonical row is still allowed, and an update cannot retype it either.
    await assertSucceeds(csetDoc(ref, { ...base, addedBy: partner.uid, classification: "confidential" }))
    await assertFails(cupdateDoc(ref, { addedBy: 42 }))
    await assertFails(cupdateDoc(ref, { classification: 7 }))
  })
})
