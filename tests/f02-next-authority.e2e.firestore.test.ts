/**
 * Audit F02 (Firestore emulator, no test-database injection): production persistence
 * must answer these Next routes from the Functions authority path.
 *
 * Pinned on current main, before the wrapper exists:
 * - responses carry no `x-authority-path: functions` header;
 * - GET /api/d1/matters returns a privileged-restricted matter to an internal-clearance member;
 * - POST add_member on that matter writes matter_members/{matterId}_{userId}.
 */
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import { GET as documentsGet } from "@/app/api/d1/documents/route"
import { GET as workflowGet } from "@/app/api/d1/document-workflow/route"
import { GET as reportingGet } from "@/app/api/d1/reporting/route"
import { GET as courtOpsGet } from "@/app/api/d2/court-ops/route"
import { GET as opsReportingGet } from "@/app/api/d2/ops-reporting/route"
import { GET as draftsGet } from "@/app/api/d4/drafts/route"
import { GET as filingsGet } from "@/app/api/d4/filings/route"
import { GET as tenancyGet } from "@/app/api/p5/tenancy/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"

requireAuthFirestoreEmulators("F02 Next authority e2e")

const E2E_TIMEOUT_MS = 120_000
const AUTHORITY_HEADER = "x-authority-path"

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

type Actor = { firmId: string; uid: string; token: string }

async function provisionFirm(): Promise<string> {
  const ref = adminDb().collection("firms").doc()
  await ref.create({ name: `F02 firm ${ref.id}`, dataResidency: "PK", plan: "internal" })
  return ref.id
}

async function provisionUser(
  firmId: string,
  role: "partner" | "clerk",
  clearanceLevel: "internal"
): Promise<Actor> {
  const uid = adminDb().collection("users").doc().id
  const email = `${uid.toLowerCase()}@example.test`
  const password = "emulator-pass-123"
  await adminAuth().createUser({ uid, email, password })
  await adminAuth().setCustomUserClaims(uid, { firmId, role, clearanceLevel })
  await adminDb().collection("users").doc(uid).set({ id: uid, firmId, role, clearanceLevel, active: true })
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST is required")
  const res = await fetch(
    `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  )
  if (!res.ok) throw new Error(`emulator sign-in failed: ${res.status} ${await res.text()}`)
  const { idToken } = (await res.json()) as { idToken: string }
  return { firmId, uid, token: idToken }
}

function matterBody(id: string, firmId: string, classification: string) {
  return {
    id,
    firmId,
    clientId: `f02-client-${firmId}`,
    title: `F02 matter ${id}`,
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "live",
    classification,
  }
}

async function seedMatter(firmId: string, memberIds: string[], classification: string): Promise<string> {
  const id = `f02-${randomUUID().slice(0, 8)}`
  const batch = adminDb().batch()
  batch.set(adminDb().collection("matters").doc(id), matterBody(id, firmId, classification))
  for (const userId of memberIds) {
    batch.set(adminDb().collection("matter_members").doc(`${id}_${userId}`), {
      matterId: id,
      userId,
      firmId,
    })
  }
  await batch.commit()
  return id
}

function authHeaders(actor: Actor, extra?: Record<string, string>): HeadersInit {
  return {
    Authorization: `Bearer ${actor.token}`,
    "X-Firm-Id": actor.firmId,
    ...extra,
  }
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F02: Next domain routes use the Functions authority path", () => {
  let actor: Actor
  let assignee: Actor
  let internalMatterId: string
  let privilegedMatterId: string

  beforeEach(async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    restart()
    useEmulatorVerifier(true)
    const firmId = await provisionFirm()
    actor = await provisionUser(firmId, "partner", "internal")
    assignee = await provisionUser(firmId, "clerk", "internal")
    internalMatterId = await seedMatter(firmId, [actor.uid], "internal")
    privilegedMatterId = await seedMatter(firmId, [actor.uid], "privileged-restricted")
  }, E2E_TIMEOUT_MS)

  afterEach(() => {
    useEmulatorVerifier(false)
    vi.unstubAllEnvs()
    restart()
  })

  it("hides a privileged matter from an internal member and stamps the functions path", async () => {
    const res = await mattersGet(
      new Request(`http://127.0.0.1/api/d1/matters?userId=${actor.uid}&limit=50&cursor=0`, {
        headers: authHeaders(actor),
      })
    )
    const body = (await res.json()) as { items?: Array<{ id?: string; classification?: string }> }
    expect(res.status).toBe(200)
    const ids = (body.items ?? []).map((item) => item.id)
    expect(ids).toContain(internalMatterId)
    expect(ids).not.toContain(privilegedMatterId)
    expect(res.headers.get(AUTHORITY_HEADER)).toBe("functions")
  }, E2E_TIMEOUT_MS)

  it("refuses add_member below the matter classification before writing a membership", async () => {
    const memberId = `${privilegedMatterId}_${assignee.uid}`
    const before = await adminDb().collection("matter_members").doc(memberId).get()
    expect(before.exists).toBe(false)
    const res = await mattersPost(
      new Request("http://127.0.0.1/api/d1/matters", {
        method: "POST",
        headers: authHeaders(actor, {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        }),
        body: JSON.stringify({
          action: "add_member",
          matterId: privilegedMatterId,
          memberUserId: assignee.uid,
        }),
      })
    )
    const body = (await res.json()) as { error?: { code?: string } | string }
    const after = await adminDb().collection("matter_members").doc(memberId).get()
    expect(after.exists).toBe(false)
    expect(res.status).toBe(403)
    expect(body.error).toEqual({ code: "clearance" })
  }, E2E_TIMEOUT_MS)

  it.each([
    ["documents", (actor: Actor) => documentsGet(new Request(`http://127.0.0.1/api/d1/documents?userId=${actor.uid}&limit=10&cursor=0`, { headers: authHeaders(actor) }))],
    ["document-workflow", (actor: Actor) => workflowGet(new Request(`http://127.0.0.1/api/d1/document-workflow?view=queue&userId=${actor.uid}&limit=10&cursor=0`, { headers: authHeaders(actor) }))],
    ["reporting", (actor: Actor) => reportingGet(new Request(`http://127.0.0.1/api/d1/reporting?view=search&limit=10&cursor=0`, { headers: authHeaders(actor) }))],
    ["court-ops", (actor: Actor) => courtOpsGet(new Request(`http://127.0.0.1/api/d2/court-ops?userId=${actor.uid}&limit=10&cursor=0`, { headers: authHeaders(actor) }))],
    ["ops-reporting", (actor: Actor) => opsReportingGet(new Request(`http://127.0.0.1/api/d2/ops-reporting?limit=10&cursor=0`, { headers: authHeaders(actor) }))],
    ["drafts", (actor: Actor) => draftsGet(new Request(`http://127.0.0.1/api/d4/drafts?view=templates&limit=10&cursor=0`, { headers: authHeaders(actor) }))],
    ["filings", (actor: Actor) => filingsGet(new Request(`http://127.0.0.1/api/d4/filings?limit=10&cursor=0`, { headers: authHeaders(actor) }))],
    ["tenancy", (actor: Actor) => tenancyGet(new Request(`http://127.0.0.1/api/p5/tenancy?view=memberships&firmId=${actor.firmId}&limit=10&cursor=0`, { headers: authHeaders(actor) }))],
  ] as const)("%s GET is authorised on the functions path", async (_name, call) => {
    const res = await call(actor)
    expect(res.status).toBeLessThan(500)
    expect(res.headers.get(AUTHORITY_HEADER)).toBe("functions")
  }, E2E_TIMEOUT_MS)
})
