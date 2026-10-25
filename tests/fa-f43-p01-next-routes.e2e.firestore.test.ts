/**
 * FA-F43-R1-P01 (spec docs/superpowers/specs/2026-10-24-fa-f43-p01-unknown-action-deny-design.md R2, R12), Auth + Firestore
 * emulators, production persistence, Firebase sessions: the real Next routes whose actions reached the table's default
 * `allow ok` until this audit still work for their permitted roles once those actions are decided by explicit rows, and
 * still refuse the others exactly as before.
 *
 *   POST /api/g0/normalise           normalise_case_number   partner, associate, clerk, intern
 *   POST + GET /api/p1/committee-brain committee_brain(_read) partner, associate, clerk (members)
 *   GET  /api/d1/matters              list_matters            staff members, the matter's client
 *   GET + POST /api/d2/court-ops      research (matter-level) partner, associate, clerk (members); acknowledge_item
 *   GET  /api/d4/drafts               draft (matter-level)    partner, associate, clerk (members)
 *
 * A regression guard: it passes on main 5840d3d too (every refusal here is made by the route or by a row main already
 * had). The RED cases are at the two P5 entry points (tests/fa-f43-p01-unknown-action.test.ts, functions/test/
 * p5.permission.test.ts). One firm is created for the file and every row it leaves is deleted afterwards.
 */
import { randomUUID } from "node:crypto"
import type { DocumentReference } from "firebase-admin/firestore"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { POST as normalisePost } from "@/app/api/g0/normalise/route"
import { GET as committeeGet, POST as committeePost } from "@/app/api/p1/committee-brain/route"
import { GET as mattersGet } from "@/app/api/d1/matters/route"
import { GET as courtOpsGet, POST as courtOpsPost } from "@/app/api/d2/court-ops/route"
import { GET as draftsGet } from "@/app/api/d4/drafts/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"

requireAuthFirestoreEmulators("FA-F43-R1-P01 Next routes e2e")

const TIMEOUT = 180_000
const ROLES = ["partner", "associate", "clerk", "intern", "client", "accounts"] as const
type R = (typeof ROLES)[number]
type Actor = { firmId: string; uid: string; token: string; role: R }

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

const uids: string[] = []

async function provisionUser(firmId: string, role: R): Promise<Actor> {
  const uid = adminDb().collection("users").doc().id
  uids.push(uid)
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
  return { firmId, uid, role, token: ((await res.json()) as { idToken: string }).idToken }
}

const headers = (a: Actor, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${a.token}`, "X-Firm-Id": a.firmId, ...extra })
const post = (a: Actor) => headers(a, { "Content-Type": "application/json", "Idempotency-Key": randomUUID() })

async function call(handler: (r: Request) => Promise<Response>, request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handler(request)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const get = (handler: (r: Request) => Promise<Response>, a: Actor, path: string) =>
  call(handler, new Request(`http://127.0.0.1${path}`, { headers: headers(a) }))

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("FA-F43-R1-P01: the Next routes that relied on the default allow still work", () => {
  let firmId = ""
  const actor = {} as Record<R, Actor>
  let outsider: Actor
  let matterId = ""
  let followUpId = ""
  let draftId = ""

  beforeAll(async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    // The committee call runs the local P1 pipeline (no Functions forward, no provider key): it records a blocked row.
    vi.stubEnv("SIKANDER_FUNCTIONS_API_BASE_URL", "")
    vi.stubEnv("NEXT_PUBLIC_SIKANDER_FUNCTIONS_API_BASE_URL", "")
    vi.stubEnv("FIREBASE_FUNCTIONS_EMULATOR_HOST", "")
    vi.stubEnv("FUNCTIONS_EMULATOR_HOST", "")
    vi.stubEnv("AI_GATEWAY_API_KEY", "")
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "")
    restart()
    useEmulatorVerifier(true)
    const firm = adminDb().collection("firms").doc()
    firmId = firm.id
    await firm.create({ name: `FA-F43-P01 firm ${firmId}`, dataResidency: "PK", plan: "internal" })
    for (const role of ROLES) actor[role] = await provisionUser(firmId, role)
    outsider = await provisionUser(firmId, "clerk")
    matterId = adminDb().collection("matters").doc().id
    const batch = adminDb().batch()
    batch.set(adminDb().collection("matters").doc(matterId), {
      firmId,
      clientId: actor.client.uid,
      title: "FA-F43-P01 matter",
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      status: "live",
      classification: "internal",
    })
    for (const role of ["partner", "associate", "clerk", "intern", "client"] as const) {
      const uid = actor[role].uid
      batch.set(adminDb().collection("matter_members").doc(`${matterId}_${uid}`), { matterId, userId: uid, firmId })
    }
    followUpId = adminDb().collection("follow_ups").doc().id
    batch.set(adminDb().collection("follow_ups").doc(followUpId), {
      id: followUpId,
      firmId,
      matterId,
      courtId: "SHC",
      raw: "CP 1234",
      kind: "case_number_reject",
      status: "open",
    })
    draftId = adminDb().collection("drafts").doc().id
    batch.set(adminDb().collection("drafts").doc(draftId), {
      id: draftId,
      firmId,
      matterId,
      templateId: "tpl-fa-f43-p01",
      title: "FA-F43-P01 draft",
      body: "Synthetic draft body.",
      classification: "internal",
      createdBy: actor.partner.uid,
      createdAt: Date.now(),
      status: "draft",
    })
    await batch.commit()
  }, TIMEOUT)

  afterAll(async () => {
    useEmulatorVerifier(false)
    vi.unstubAllEnvs()
    restart()
    if (!firmId) return
    const db = adminDb()
    const refs = new Map<string, DocumentReference>()
    for (const col of await db.listCollections()) {
      for (;;) {
        const page = await col.where("firmId", "==", firmId).select().limit(400).get()
        const fresh = page.docs.filter((d) => !refs.has(d.ref.path))
        fresh.forEach((d) => refs.set(d.ref.path, d.ref))
        if (page.size < 400 || fresh.length === 0) break
      }
    }
    refs.set(`firms/${firmId}`, db.collection("firms").doc(firmId))
    for (const uid of uids) refs.set(`users/${uid}`, db.collection("users").doc(uid))
    for (const ref of refs.values()) await ref.delete()
    if (uids.length > 0) await adminAuth().deleteUsers(uids)
  }, TIMEOUT)

  it("POST /api/g0/normalise (normalise_case_number): the four staff roles 200; a client staff-only, accounts register-only", async () => {
    for (const role of ["partner", "associate", "clerk", "intern"] as const) {
      const a = actor[role]
      const res = await call(normalisePost, new Request("http://127.0.0.1/api/g0/normalise", {
        method: "POST",
        headers: post(a),
        body: JSON.stringify({ actorId: a.uid, raw: "C.P. No. D-1234 of 2025", courtId: "SHC" }),
      }))
      expect([role, res.status, (res.body.result as { canonical?: string } | undefined)?.canonical]).toEqual([role, 200, "CP D-1234/2025"])
    }
    for (const [role, reason] of [["client", "staff-only"], ["accounts", "accounts-register-only"]] as const) {
      const a = actor[role]
      const res = await call(normalisePost, new Request("http://127.0.0.1/api/g0/normalise", {
        method: "POST",
        headers: post(a),
        body: JSON.stringify({ actorId: a.uid, raw: "C.P. No. D-1234 of 2025", courtId: "SHC" }),
      }))
      expect([role, res.status, res.body.error]).toEqual([role, 403, `permission denied: ${reason}`])
    }
  }, TIMEOUT)

  it("POST then GET /api/p1/committee-brain (committee_brain, committee_brain_read): members partner, associate, clerk", async () => {
    const outputs: Record<string, string> = {}
    for (const role of ["partner", "associate", "clerk"] as const) {
      const a = actor[role]
      const res = await call(committeePost, new Request("http://127.0.0.1/api/p1/committee-brain", {
        method: "POST",
        headers: post(a),
        body: JSON.stringify({ actorId: a.uid, matterId, body: "Summarise the synthetic hearing notes.", purpose: "summarise" }),
      }))
      expect([role, res.status]).toEqual([role, 200])
      const result = res.body.result as { outputId?: string; blocked?: boolean }
      expect(typeof result.outputId).toBe("string")
      outputs[role] = result.outputId as string
    }
    // A clerk of the firm who is not a member is refused by P5 (not-member), as before.
    const refused = await call(committeePost, new Request("http://127.0.0.1/api/p1/committee-brain", {
      method: "POST",
      headers: post(outsider),
      body: JSON.stringify({ actorId: outsider.uid, matterId, body: "Summarise the synthetic hearing notes.", purpose: "summarise" }),
    }))
    expect([refused.status, refused.body.error]).toEqual([403, "permission denied: not-member"])
    // An intern is refused by the route before P5 (unchanged).
    const intern = await call(committeePost, new Request("http://127.0.0.1/api/p1/committee-brain", {
      method: "POST",
      headers: post(actor.intern),
      body: JSON.stringify({ actorId: actor.intern.uid, matterId, body: "Summarise the synthetic hearing notes.", purpose: "summarise" }),
    }))
    expect(intern.status).toBe(400)
    expect(intern.body.error).toBe("actor role not allowed for committee brain operations")

    for (const role of ["partner", "associate", "clerk"] as const) {
      const a = actor[role]
      const listed = await get(committeeGet, a, `/api/p1/committee-brain?actorId=${a.uid}&limit=100&cursor=0`)
      expect([role, listed.status]).toEqual([role, 200])
      const ids = ((listed.body.items ?? []) as Array<{ id: string }>).map((i) => i.id)
      for (const id of Object.values(outputs)) expect([role, ids.includes(id)]).toEqual([role, true])
    }
    const hidden = await get(committeeGet, outsider, `/api/p1/committee-brain?actorId=${outsider.uid}&limit=100&cursor=0`)
    expect(hidden.status).toBe(200)
    const hiddenIds = ((hidden.body.items ?? []) as Array<{ id: string }>).map((i) => i.id)
    for (const id of Object.values(outputs)) expect(hiddenIds).not.toContain(id)
  }, TIMEOUT)

  it("GET /api/d1/matters (list_matters): every staff member and the matter's client list it; accounts are refused", async () => {
    for (const role of ["partner", "associate", "clerk", "intern", "client"] as const) {
      const a = actor[role]
      const res = await get(mattersGet, a, `/api/d1/matters?userId=${a.uid}&limit=50&cursor=0`)
      expect([role, res.status]).toEqual([role, 200])
      expect([role, ((res.body.items ?? []) as Array<{ id: string }>).map((m) => m.id)]).toEqual([role, [matterId]])
    }
    // The production path answers a refusal without its reason (the F02 surface's error shape).
    const accounts = await get(mattersGet, actor.accounts, `/api/d1/matters?userId=${actor.accounts.uid}&limit=50&cursor=0`)
    expect([accounts.status, accounts.body.error]).toEqual([403, { code: "forbidden" }])
  }, TIMEOUT)

  it("GET /api/d2/court-ops (research, matter-level): members partner, associate, clerk see the follow-up; a non-member does not", async () => {
    for (const role of ["partner", "associate", "clerk"] as const) {
      const a = actor[role]
      const res = await get(courtOpsGet, a, `/api/d2/court-ops?userId=${a.uid}&limit=50&cursor=0`)
      expect([role, res.status]).toEqual([role, 200])
      expect([role, ((res.body.items ?? []) as Array<{ id: string }>).map((i) => i.id)]).toEqual([role, [followUpId]])
    }
    const res = await get(courtOpsGet, outsider, `/api/d2/court-ops?userId=${outsider.uid}&limit=50&cursor=0`)
    expect(res.status).toBe(200)
    expect(res.body.items).toEqual([])
    // acknowledge_item (FA-D4-001-FU1, main 4a12508) resolves the item under the same `research` matter check: a member
    // clerk acknowledges it; a clerk of the firm who is not a member is answered as if it did not exist.
    const ack = (a: Actor) =>
      call(courtOpsPost, new Request("http://127.0.0.1/api/d2/court-ops", {
        method: "POST",
        headers: post(a),
        body: JSON.stringify({ action: "acknowledge_item", actorId: a.uid, queueType: "follow_up", id: followUpId, reason: "seen" }),
      }))
    const acked = await ack(actor.clerk)
    expect(acked.status, JSON.stringify(acked.body)).toBe(200)
    expect(acked.body.result).toMatchObject({ action: "acknowledge_item", queueType: "follow_up", id: followUpId })
    const refused = await ack(outsider)
    expect(refused.status, JSON.stringify(refused.body)).toBe(404)
    const code = (refused.body as { code?: unknown; error?: { code?: unknown } }).code ?? (refused.body.error as { code?: unknown } | undefined)?.code
    expect(code).toBe("court_ops_item_not_found")
  }, TIMEOUT)

  it("GET /api/d4/drafts (draft, matter-level): members partner, associate, clerk see the draft; an intern and a non-member do not", async () => {
    for (const role of ["partner", "associate", "clerk"] as const) {
      const a = actor[role]
      const res = await get(draftsGet, a, `/api/d4/drafts?view=drafts&userId=${a.uid}&limit=50&cursor=0`)
      expect([role, res.status]).toEqual([role, 200])
      expect([role, ((res.body.items ?? []) as Array<{ id: string }>).map((d) => d.id)]).toEqual([role, [draftId]])
    }
    for (const a of [actor.intern, outsider]) {
      const res = await get(draftsGet, a, `/api/d4/drafts?view=drafts&userId=${a.uid}&limit=50&cursor=0`)
      expect([a.role, res.status, res.body.items]).toEqual([a.role, 200, []])
    }
  }, TIMEOUT)
})
