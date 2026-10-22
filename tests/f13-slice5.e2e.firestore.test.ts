// Audit F13 slice 5 (FA-F13-017): record_case_number indexes the matter its transaction stored, not the cached copy.
// Auth + Firestore emulators.
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as mattersPost } from "@/app/api/d1/matters/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
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
  const firmId = uniq("f13s5firm")
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


/** Fires `beforeTx` once, just before the next transaction starts: a writer landing between the cache read and the write. */
let beforeTx: (() => Promise<void>) | null = null
/** The hook waits for the transaction this test means (other transactions, such as the idempotency claim, pass). */
let beforeTxWhen: () => boolean = () => true
function dbWithRace(): unknown {
  const target = adminDb() as unknown as Record<string | symbol, unknown>
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t)
      if (prop === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const hook = beforeTx && beforeTxWhen() ? beforeTx : null
          if (hook) beforeTx = null
          if (hook) await hook()
          return (value as (...a: unknown[]) => unknown).apply(t, args)
        }
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(t) : value
    },
  })
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 slice 5: record_case_number indexes the stored matter (FA-F13-017)", { timeout: E2E_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    // The legacy check-free create path is the one this finding names.
    vi.stubEnv("SIKANDER_FLAG_LEGACY_D1_NEXT_WRITES", "true")
    restart()
    setFirestorePersistenceForTests(dbWithRace())
    useEmulatorVerifier(true)
  })

  afterEach(() => {
    useEmulatorVerifier(false)
    setFirestorePersistenceForTests(null)
    vi.unstubAllEnvs()
    restart()
  })

  it("FA-F13-017: the search index carries the court the transaction stored, not the court it refused", async () => {
    const firmId = await newFirm()
    const partner = await user(firmId, "partner")
    const m = await openViaFunctions(partner)
    // Another writer sets the court after the route cached the court-less matter and before its transaction runs.
    // The matters transaction is the one that runs after the service put the case number on the cached matter.
    beforeTxWhen = () => getRuntimeStore().matters.get(m.matterId)?.caseNumberStatus === "recorded"
    beforeTx = async () => {
      await adminDb().collection("matters").doc(m.matterId).update({ courtId: "PHC" })
    }
    const rc = await nextPost(partner, { action: "record_case_number", actorId: partner.uid, matterId: m.matterId, raw: "Suit No. 12 of 2024", courtId: "SHC" })
    expect(rc.status, JSON.stringify(rc.body)).toBe(200)
    expect(beforeTx).toBeNull()
    expect((await matterDoc(m.matterId))?.courtId).toBe("PHC")
    const row = (await adminDb().collection("matter_client_search_index").doc(`matter:${m.matterId}`).get()).data()
    expect(row, "index row").toBeDefined()
    const tags = (row?.tags ?? []) as string[]
    expect(tags).toContain("phc")
    // The cache follows the stored matter too.
    expect(getRuntimeStore().matters.get(m.matterId)?.courtId).toBe("PHC")
  })
})
