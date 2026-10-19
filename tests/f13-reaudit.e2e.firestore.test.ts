// Audit F13 re-audit of PR #92 (FA-F13-005..010): the client-SDK persistence path (G-2 runs Next on a
// @firebase/rules-unit-testing context), the confirm_engagement reopen race and intimation dedup, the rules type fence
// on `title`, and the closed-matter guards of record_case_number / add_member. Both stacks, Auth + Firestore emulators.
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { Timestamp } from "firebase-admin/firestore"
import { doc as cdoc, updateDoc as cupdateDoc } from "firebase/firestore"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"
import { ApiError, viaApi } from "@/functions/test/api"
import { mintIdToken, uniq } from "@/functions/test/emu"

/** FA-F13-005: runs between the route's own closed check and the repository write (a Functions close landing there). */
const hooks: { beforeMatterWrite?: (id: string) => Promise<void> } = {}
vi.mock("@/platform/persistence/firestoreSpineRepositories", async (orig) => {
  type Repos = { matters: Record<string, ((...args: never[]) => Promise<unknown>) | undefined> }
  const mod = (await orig()) as Record<string, unknown> & { createFirestoreRepositories: (db: unknown) => Repos }
  return {
    ...mod,
    createFirestoreRepositories: (db: unknown) => {
      const repos = mod.createFirestoreRepositories(db)
      for (const name of ["update", "confirmEngagement"]) {
        const fn = repos.matters[name]
        if (!fn) continue
        repos.matters[name] = (async (...args: never[]) => {
          const h = hooks.beforeMatterWrite
          if (h) {
            hooks.beforeMatterWrite = undefined
            await h(args[0] as unknown as string)
          }
          return fn.apply(repos.matters, args)
        }) as never
      }
      return repos
    },
  }
})

requireAuthFirestoreEmulators("F13 re-audit contract")

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

const intimationsOf = async (matterId: string) =>
  (await adminDb().collection("intimation_register").where("matterId", "==", matterId).get()).size
const close = (p: User, matterId: string) =>
  closeMatter({ token: p.token, data: { firmId: p.firmId, matterId, reason: "Client withdrew instructions entirely." } } as never)

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 re-audit: client SDK path, races, rules fence, closed guards", { timeout: E2E_TIMEOUT_MS }, () => {
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
    hooks.beforeMatterWrite = undefined
    useEmulatorVerifier(false)
    setFirestorePersistenceForTests(null)
    vi.unstubAllEnvs()
    restart()
  })

  afterAll(async () => {
    await rulesEnv?.cleanup()
  })

  it("FA-F13-010: Next create and member upsert through the CLIENT SDK path store a server createdAt both stacks read", async () => {
    vi.stubEnv("SIKANDER_FLAG_LEGACY_D1_NEXT_WRITES", "true")
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const client = await user(firmId, "client", "public")
    const associate = await user(firmId, "associate")
    let id = ""
    // The G-2 wiring: Next persistence on a @firebase/rules-unit-testing context (a client-SDK Firestore, not Admin).
    await (await rules()).withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore() as never)
      await signInToNext(client)
      await signInToNext(associate)
      const created = await nextPost(partner, {
        action: "create",
        actorId: partner.uid,
        firmId,
        clientId: client.uid,
        title: "Client SDK matter",
        courtId: "SHC",
        classification: "internal",
      })
      expect(created.status, JSON.stringify(created.body)).toBe(200)
      id = (created.body.result as { matter: { id: string } }).matter.id
      const added = await nextPost(partner, { action: "add_member", actorId: partner.uid, matterId: id, memberUserId: associate.uid })
      expect(added.status, JSON.stringify(added.body)).toBe(200)
    })
    expect((await matterDoc(id))?.createdAt).toBeInstanceOf(Timestamp)
    expect((await memberDoc(id, partner.uid))?.createdAt).toBeInstanceOf(Timestamp)
    expect((await memberDoc(id, associate.uid))?.createdAt).toBeInstanceOf(Timestamp)
    const listed = await listMatters({ token: associate.token, data: { firmId, limit: "10" } } as never)
    expect(listed.items.map((row) => row.matterId)).toContain(id)
  })

  it("FA-F13-005: a Functions close landing between the route's closed check and its write answers 409 and stays closed", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const m = await openViaFunctions(partner)
    hooks.beforeMatterWrite = async (id) => {
      await close(partner, id)
    }
    const res = await nextPost(partner, { action: "confirm_engagement", actorId: partner.uid, matterId: m.matterId })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.code).toBe("matter_closed")
    expect((await matterDoc(m.matterId))?.status).toBe("closed")
    expect(await intimationsOf(m.matterId)).toBe(0)
  })

  it("FA-F13-005: concurrent Next confirm and Functions close never leave a closed matter live", async () => {
    for (let i = 0; i < 5; i++) {
      const firmId = await newFirm()
      const partner = await user(firmId, "partner")
      const m = await openViaFunctions(partner)
      const [closed, confirmed] = await Promise.allSettled([
        close(partner, m.matterId),
        nextPost(partner, { action: "confirm_engagement", actorId: partner.uid, matterId: m.matterId }),
      ])
      const status = (await matterDoc(m.matterId))?.status
      if (closed.status === "fulfilled") expect(status).toBe("closed")
      if (confirmed.status === "fulfilled") expect([200, 409]).toContain(confirmed.value.status)
    }
  })

  it("FA-F13-009: concurrent confirms record one engagement intimation", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const m = await openViaFunctions(partner)
    const results = await Promise.all(
      Array.from({ length: 5 }, () => nextPost(partner, { action: "confirm_engagement", actorId: partner.uid, matterId: m.matterId }))
    )
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
    expect((await matterDoc(m.matterId))?.status).toBe("live")
    expect(await intimationsOf(m.matterId)).toBe(1)
    // A later confirm of a live matter records no second intimation either.
    expect((await nextPost(partner, { action: "confirm_engagement", actorId: partner.uid, matterId: m.matterId })).status).toBe(200)
    expect(await intimationsOf(m.matterId)).toBe(1)
  })

  it("FA-F13-006: the rules refuse an associate writing a non-string title (the shape both stacks validate)", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const associate = await user(firmId, "associate")
    const m = await openViaFunctions(partner, { memberUserIds: [associate.uid] })
    const claims = { firmId, role: "associate", clearanceLevel: "privileged-restricted" }
    await adminDb().collection("users").doc(associate.uid).set({ ...claims, active: true }, { merge: true })
    const firebase = { sign_in_provider: "password", sign_in_second_factor: "phone" } as unknown as { sign_in_provider: "password" }
    const db = (await rules()).authenticatedContext(associate.uid, { ...claims, firebase }).firestore()
    await assertFails(cupdateDoc(cdoc(db, "matters", m.matterId), { title: 123 }))
    // A string title stays writable by a member associate (the fence is a type fence, not a lock).
    await cupdateDoc(cdoc(db, "matters", m.matterId), { title: "Recovery suit (amended)" })
    expect((await matterDoc(m.matterId))?.title).toBe("Recovery suit (amended)")
  })

  it("FA-F13-007: a closed matter refuses record_case_number and add_member (409 matter_closed), nothing written", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const associate = await user(firmId, "associate")
    const m = await openViaFunctions(partner)
    await signInToNext(associate)
    await close(partner, m.matterId)
    const rc = await nextPost(partner, { action: "record_case_number", actorId: partner.uid, matterId: m.matterId, raw: "Suit No. 12 of 2024", courtId: "SHC" })
    expect(rc.status, JSON.stringify(rc.body)).toBe(409)
    expect(rc.body.code).toBe("matter_closed")
    const am = await nextPost(partner, { action: "add_member", actorId: partner.uid, matterId: m.matterId, memberUserId: associate.uid })
    expect(am.status, JSON.stringify(am.body)).toBe(409)
    expect(am.body.code).toBe("matter_closed")
    const stored = await matterDoc(m.matterId)
    expect(stored).toMatchObject({ status: "closed", caseNumber: null, caseNumberStatus: "pending" })
    expect(await memberDoc(m.matterId, associate.uid)).toBeUndefined()
    // Cloud Functions keeps a closed matter closed as well: no further stage transition.
    const advanced = await fnError(advanceStage({ token: partner.token, data: { firmId, matterId: m.matterId, to: "filed" } } as never))
    expect(advanced.status).toBeGreaterThanOrEqual(400)
  })

  it("FA-F13-007: a Functions close landing just before the case-number write is refused by the write itself", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const m = await openViaFunctions(partner)
    hooks.beforeMatterWrite = async (id) => {
      await close(partner, id)
    }
    const rc = await nextPost(partner, { action: "record_case_number", actorId: partner.uid, matterId: m.matterId, raw: "Suit No. 12 of 2024", courtId: "SHC" })
    expect(rc.status, JSON.stringify(rc.body)).toBe(409)
    expect(await matterDoc(m.matterId)).toMatchObject({ status: "closed", caseNumber: null })
  })
})
