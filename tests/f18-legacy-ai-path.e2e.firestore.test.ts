// Audit F18 (HIGH): "Legacy AI entry points bypass Functions budget and kill switches." On main the Next route
// `POST /api/p1/committee-brain` and the eve bridge call `callCommitteeBrain`, which sends through
// platform/p1/gatewayTransport.ts (`createGateway` + `generateText` from the `ai` SDK) whenever `AI_GATEWAY_API_KEY` or
// `VERCEL_AI_GATEWAY_API_KEY` is set: no cost row, no budget, no kill switch.
//
// Spec docs/superpowers/specs/2026-10-18-f18-legacy-ai-path-closed-design.md. These tests drive the real Next route the
// way production runs it (the harness of #44's F01/F12 e2e files): NODE_ENV=production, SIKANDER_AUTH_MODE=firebase with
// real ID tokens minted by the Auth emulator, SIKANDER_PERSISTENCE_MODE=firestore on Admin Firestore (the emulator). The
// real Cloud Functions `api` router is served on a loopback port (tests/helpers/functions-router-server.ts), with the
// Functions P1 test transport counting the sanctioned provider calls. The legacy provider boundary, the `ai` SDK's
// `createGateway`/`generateText`, is replaced by a fake that counts direct calls. A fetch tripwire refuses and counts any
// request to a non-loopback host, so nothing can reach a real provider. The provider key is an obviously fake value.
//
// The file imports nothing that is new in F18 statically, so it runs on main too; the documented reasons and codes are
// literals. Every module new in F18 or in its re-audit follow-up is loaded with `await import(...).catch(() => ({}))`
// (FA-F18-003: review round 1's static import of platform/p1/functionsCommitteeBrain was a collection error on main).
// Every document and Auth user it creates is deleted after each test, and the last test asserts that none is left.
//
// Re-audit follow-up (spec "Re-audit follow-up"): the Functions fake transport is installed through
// functions/src/p1/transportTestSeam.ts, the one Functions P1 module G-0 [19]'s allowlist lets this file import (never
// the transport or the gateway); the network tripwire is the shared one (tests/helpers/network-tripwire.ts), installed
// when this file loads, before any suite runs, and it refuses fetch and sockets to every host that is not loopback and
// to the agent proxy's port. Rows (l) and (m) are new: the Functions router imported outside the Functions runtime with
// a key (FA-F18-001b), and a key under NODE_ENV=staging (FA-F18-005).
import { randomUUID } from "node:crypto"
import { FieldValue, type DocumentReference } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as committeePost } from "@/app/api/p1/committee-brain/route"
import { committeeBrainLanguageModel } from "@/platform/p1/committeeBrainModel"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { ROUTES, createRouter } from "@/functions/src/http/router"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"
import { closedLoopbackPort, startFunctionsRouterServer, type FunctionsRouterServer } from "@/tests/helpers/functions-router-server"
import { installNetworkTripwire } from "@/tests/helpers/network-tripwire"
import { FUNCTION_TIMEOUT_SECONDS } from "@/functions/src/health"

/** Refuses and records every non-loopback fetch and socket, and the proxy's port, from here on (before any suite). */
const tripwire = installNetworkTripwire()

type FunctionsTransportSeam = { setP1TransportForTests?: (t: { send: (req: unknown) => Promise<{ text: string; inputTokens: number; outputTokens: number }> } | null) => void }
/** The Functions P1 fake-transport seam (re-audit follow-up). Absent on main, where Next never forwards (c02ebbc). */
const functionsSeam = (await import("@/functions/src/p1/transportTestSeam").catch(() => ({}))) as FunctionsTransportSeam
/** platform/p1/functionsCommitteeBrain.ts (F18). Loaded loosely: absent on main (FA-F18-003). */
const forwardModule = (await import("@/platform/p1/functionsCommitteeBrain").catch(() => ({}))) as Record<string, unknown>

requireAuthFirestoreEmulators("F18 legacy AI path e2e")

/** The legacy provider boundary on main (platform/p1/gatewayTransport.ts), counted. Nothing in it reaches a network. */
const direct = vi.hoisted(() => ({ generateText: 0, createGateway: 0 }))
vi.mock("ai", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    createGateway: () => {
      direct.createGateway += 1
      return { languageModel: (id: string) => ({ fakeModelId: id }) }
    },
    generateText: async () => {
      direct.generateText += 1
      return { text: "Answer from the fake provider." }
    },
  }
})

/** Emulator round trips, the first ID-token verification and the Functions router's first imports on a loaded machine. */
const E2E_TIMEOUT_MS = 120_000
/** An obviously fake provider key: never a real or key-shaped secret. */
const FAKE_PROVIDER_KEY = "placeholder-not-a-key"

/** The documented outcomes (spec R2, R4, R5). Literals, so this file runs against main, where none exists. */
const PHASE0_NO_CREDENTIALS = "blocked: no live provider credentials in Phase 0"
const KEY_REFUSAL = /a provider API key is set in this Next or eve runtime/
const KEY_ALERT = "p1.provider_key_in_next_runtime"
const FORWARD_ALERT = "p1.next_forward_failed"

type Verifier = (token: string) => Promise<{ uid: string } & Record<string, unknown>>
type SessionSeams = { setIdTokenVerifierForTests?: (verifier: Verifier | null) => void }

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

// ---------------------------------------------------------------------------------------------------------------------
// What the suite creates, so it can delete exactly that.

const created = { firms: new Set<string>(), uids: new Set<string>(), platformP1: false }

/** onboardFirmOp's firm document (functions/src/p5/identity.ts). */
async function provisionFirm(): Promise<string> {
  const ref = adminDb().collection("firms").doc()
  created.firms.add(ref.id)
  await ref.create({ name: `F18 firm ${ref.id}`, dataResidency: "PK", plan: "internal", createdAt: FieldValue.serverTimestamp() })
  return ref.id
}

type Member = { firmId: string; uid: string; token: string }

/** createFirmUserOp's user (no `id` field), then a password sign-in for a real ID token. */
async function provisionPartner(firmId: string): Promise<Member> {
  const uid = adminDb().collection("users").doc().id
  created.uids.add(uid)
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

/** An internal matter both the Next repositories and the Functions route read, with the partner as a member. */
async function seedMatter(member: Member): Promise<string> {
  const id = `f18-matter-${randomUUID().slice(0, 8)}`
  await adminDb().collection("matters").doc(id).set({
    id,
    firmId: member.firmId,
    clientId: `f18-client-${id}`,
    title: `F18 matter ${id}`,
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "engagement_unconfirmed",
    stage: "pre_filing",
    classification: "internal",
  })
  await adminDb().collection("matter_members").doc(`${id}_${member.uid}`).set({ matterId: id, userId: member.uid, firmId: member.firmId })
  return id
}

/** The firm's P1 configuration (functions/src/p1/config.ts): a budget in micro-USD and the firm's kill switch. */
async function setFirmAiConfig(firmId: string, cfg: { budget?: number; killAll?: boolean }): Promise<void> {
  const data: Record<string, unknown> = {}
  if (cfg.budget !== undefined) data.monthlyBudgetMicroUsd = cfg.budget
  if (cfg.killAll) data.killSwitch = { disableAll: true, disabledModels: [], reason: "F18 drill", setBy: "f18-test", setAt: FieldValue.serverTimestamp() }
  await adminDb().collection("ai_config").doc(firmId).set(data)
}

async function setPlatformKillSwitch(): Promise<void> {
  created.platformP1 = true
  await adminDb()
    .collection("platform")
    .doc("p1")
    .set({ killSwitch: { disableAll: true, disabledModels: [], reason: "F18 drill", setBy: "platform", setAt: FieldValue.serverTimestamp() } })
}

/** The firm's P1 cost rows (functions/src/p1/gateway.ts: one per decision). */
async function costRows(firmId: string): Promise<Array<Record<string, unknown>>> {
  const snap = await adminDb().collection("ai_usage_logs").where("firmId", "==", firmId).get()
  return snap.docs.map((d) => d.data())
}

const SWEPT_BY_FIRM = [
  "firms",
  "users",
  "matters",
  "matter_members",
  "matter_parties",
  "clients",
  "ai_config",
  "ai_usage_logs",
  "ai_usage_months",
  "ai_reservations",
  "ai_budget_alerts",
  "committee_outputs",
  "idempotency_keys",
  "idempotency_effects",
  "audit_log",
  "audit_outbox",
  "events",
] as const

/** Deletes every document this suite created: by firm, by user, by id, the rate-limit windows and `platform/p1`. */
async function sweep(): Promise<void> {
  const db = adminDb()
  const firms = [...created.firms]
  const uids = [...created.uids]
  const refs = new Map<string, DocumentReference>()
  const add = (ref: DocumentReference) => refs.set(ref.path, ref)
  for (const firmId of firms) {
    add(db.collection("firms").doc(firmId))
    add(db.collection("ai_config").doc(firmId))
  }
  for (const uid of uids) add(db.collection("users").doc(uid))
  for (const name of SWEPT_BY_FIRM) {
    for (let i = 0; i < firms.length; i += 10) {
      const snap = await db.collection(name).where("firmId", "in", firms.slice(i, i + 10)).get()
      snap.docs.forEach((d) => add(d.ref))
    }
    for (const field of ["uid", "userId", "actorId"]) {
      for (let i = 0; i < uids.length; i += 10) {
        const snap = await db.collection(name).where(field, "in", uids.slice(i, i + 10)).get()
        snap.docs.forEach((d) => add(d.ref))
      }
    }
  }
  const limits = await db.collection("rate_limits").get()
  for (const d of limits.docs) if (uids.some((uid) => d.id.includes(uid))) add(d.ref)
  if (created.platformP1) add(db.collection("platform").doc("p1"))
  for (const ref of refs.values()) await ref.delete()
  if (uids.length > 0) await adminAuth().deleteUsers(uids)
}

/** What is left of this suite's data (empty after a sweep). */
async function leftovers(firms: string[], uids: string[]): Promise<string[]> {
  const db = adminDb()
  const left: string[] = []
  for (const name of SWEPT_BY_FIRM) {
    for (let i = 0; i < firms.length; i += 10) {
      const snap = await db.collection(name).where("firmId", "in", firms.slice(i, i + 10)).get()
      snap.docs.forEach((d) => left.push(d.ref.path))
    }
  }
  for (const firmId of firms) {
    if ((await db.collection("firms").doc(firmId).get()).exists) left.push(`firms/${firmId}`)
    if ((await db.collection("ai_config").doc(firmId).get()).exists) left.push(`ai_config/${firmId}`)
  }
  for (const uid of uids) if ((await db.collection("users").doc(uid).get()).exists) left.push(`users/${uid}`)
  const limits = await db.collection("rate_limits").get()
  for (const d of limits.docs) if (uids.some((uid) => d.id.includes(uid))) left.push(d.ref.path)
  return left
}

// ---------------------------------------------------------------------------------------------------------------------
// The sanctioned path (Functions P1 transport), the network tripwire and the alert lines.

const sanctioned = { calls: 0, delayMs: 0 }

type ForwardSeams = { setForwardTimeoutForTests?: (ms: number | null) => void; FORWARD_TIMEOUT_MS?: number }
/** The forward-deadline seam (review round 1). Read loosely, so this file still runs where it does not exist. */
const forwardSeams = forwardModule as unknown as ForwardSeams
/** What the tripwire refused: `fetch:<host>` or `socket:<host>:<port>`. */
const egress = tripwire.refused

function errorLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
}

let server: FunctionsRouterServer
let errorSpy: ReturnType<typeof vi.spyOn>

type Answer = { status: number; json: Record<string, unknown>; result?: Record<string, unknown> }

async function ask(member: Member, matterId: string, key = randomUUID()): Promise<Answer> {
  const res = await committeePost(
    new Request("http://127.0.0.1/api/p1/committee-brain", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${member.token}`,
        "X-Firm-Id": member.firmId,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ matterId, body: "Draft a reply to the notice for the client.", purpose: "committee-brain", classification: "internal" }),
    })
  )
  const json = (await res.json()) as Record<string, unknown>
  return { status: res.status, json, result: json.result as Record<string, unknown> | undefined }
}

/** A firm with a partner on an internal matter and, unless told otherwise, a large budget. */
async function firmWithMatter(cfg: { budget?: number | null; killAll?: boolean } = {}): Promise<{ member: Member; matterId: string }> {
  const firmId = await provisionFirm()
  const member = await provisionPartner(firmId)
  const matterId = await seedMatter(member)
  await setFirmAiConfig(firmId, { budget: cfg.budget === null ? undefined : (cfg.budget ?? 1_000_000_000), killAll: cfg.killAll })
  return { member, matterId }
}

/**
 * One measurement line per row, printed before the row's assertions so a failing run (main) records what it observed:
 * the answer, the direct (legacy) provider calls, the sanctioned Functions P1 calls, what the Functions router received,
 * the firm's cost rows and whether an alert line was logged.
 */
async function measure(row: string, answer: Answer | { text: string; finish: string | undefined }, firmId?: string): Promise<void> {
  const rows = firmId ? await costRows(firmId) : []
  const out =
    "status" in answer
      ? { status: answer.status, blocked: answer.result?.blocked, reason: answer.result?.reason ?? answer.json.code ?? null }
      : { finish: answer.finish, text: answer.text.slice(0, 120) }
  const alerts = errorLines(errorSpy).filter((l) => l.includes("ALERT")).map((l) => l.slice(0, 80))
  console.info(
    `[F18 e2e] row ${row} ${JSON.stringify({
      ...out,
      directProviderCalls: direct.generateText,
      directGatewayClients: direct.createGateway,
      sanctionedP1Calls: sanctioned.calls,
      forwardedToFunctions: server.received.length,
      costRows: rows.map((r) => `${String(r.outcome)}/${String(r.blockReason)}/${String(r.costMicroUsd)}`),
      alerts,
      nonLoopbackRequests: egress.length,
    })}`
  )
}

async function eveAsk(): Promise<{ text: string; finish: string | undefined }> {
  const result = await committeeBrainLanguageModel.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Summarise the cause list for tomorrow." }] }],
    providerOptions: { sikander: { classification: "public" } },
  })
  const text = result.content.map((p) => ("text" in p ? p.text : "")).join("")
  return { text, finish: result.finishReason.unified }
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F18: no paid AI call leaves the Next or eve runtime outside Functions P1", { timeout: E2E_TIMEOUT_MS }, () => {
  beforeAll(async () => {
    server = await startFunctionsRouterServer(createRouter(ROUTES) as never)
  }, E2E_TIMEOUT_MS)

  afterAll(async () => {
    await server?.close()
    tripwire.uninstall()
  }, E2E_TIMEOUT_MS)

  beforeEach(() => {
    direct.generateText = 0
    direct.createGateway = 0
    sanctioned.calls = 0
    sanctioned.delayMs = 0
    egress.length = 0
    server.received.length = 0
    // Set while NODE_ENV is still "test": the seam refuses to be set in production, and is read at call time.
    functionsSeam.setP1TransportForTests?.({
      async send() {
        sanctioned.calls += 1
        if (sanctioned.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, sanctioned.delayMs))
        return { text: "Answer through Functions P1.", inputTokens: 1000, outputTokens: 500 }
      },
    })
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("METADATA_SERVER_DETECTION", "none")
    vi.stubEnv("OPIK_BASE_URL", "")
    vi.stubEnv("AI_GATEWAY_API_KEY", "")
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "")
    vi.stubEnv("SIKANDER_FUNCTIONS_API_BASE_URL", server.baseUrl)
    restart()
    setFirestorePersistenceForTests(adminDb())
    useEmulatorVerifier(true)
    errorSpy = vi.spyOn(console, "error")
  })

  afterEach(async () => {
    errorSpy.mockRestore()
    useEmulatorVerifier(false)
    setFirestorePersistenceForTests(null)
    vi.unstubAllEnvs()
    functionsSeam.setP1TransportForTests?.(null)
    forwardSeams.setForwardTimeoutForTests?.(null)
    restart()
    await sweep()
  }, E2E_TIMEOUT_MS)

  it("(a) a provider key in the Next environment: nothing reaches a provider; the call is refused with the documented reason and an alert line", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_PROVIDER_KEY)
    const { member, matterId } = await firmWithMatter()

    const answer = await ask(member, matterId)
    await measure("(a)", answer, member.firmId)

    expect({ generateText: direct.generateText, createGateway: direct.createGateway }, "direct provider calls from Next").toEqual({ generateText: 0, createGateway: 0 })
    expect(egress, "non-loopback requests").toEqual([])
    expect(answer.status, JSON.stringify(answer.json)).toBe(200)
    expect(answer.result?.blocked).toBe(true)
    expect(String(answer.result?.reason)).toMatch(KEY_REFUSAL)
    expect(errorLines(errorSpy).some((line) => line.includes(KEY_ALERT) && line.includes("AI_GATEWAY_API_KEY") && !line.includes(FAKE_PROVIDER_KEY))).toBe(true)
    expect(server.received, "nothing forwarded while a key is present").toEqual([])
    expect(sanctioned.calls).toBe(0)
    expect(await costRows(member.firmId)).toEqual([])
  })

  it("(b) a provider key with both kill switches on: still nothing reaches a provider", async () => {
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", FAKE_PROVIDER_KEY)
    const { member, matterId } = await firmWithMatter({ killAll: true })
    await setPlatformKillSwitch()

    const answer = await ask(member, matterId)
    await measure("(b)", answer, member.firmId)

    expect({ generateText: direct.generateText, createGateway: direct.createGateway }, "direct provider calls from Next").toEqual({ generateText: 0, createGateway: 0 })
    expect(egress).toEqual([])
    expect(answer.result?.blocked).toBe(true)
    expect(String(answer.result?.reason)).toMatch(KEY_REFUSAL)
    expect(sanctioned.calls).toBe(0)
  })

  it("(c) no key, Functions configured: the call goes through Functions P1 with the caller's own identity; one cost row, zero direct calls", async () => {
    const { member, matterId } = await firmWithMatter()
    const key = randomUUID()

    const answer = await ask(member, matterId, key)
    await measure("(c)", answer, member.firmId)

    expect(answer.status, JSON.stringify(answer.json)).toBe(200)
    expect(answer.result).toMatchObject({ blocked: false, text: "Answer through Functions P1.", agent: "sikander-ai" })
    expect((answer.result?.usage as { costMicroUsd?: number } | undefined)?.costMicroUsd).toBeGreaterThan(0)
    expect(direct.generateText + direct.createGateway, "direct provider calls from Next").toBe(0)
    expect(egress).toEqual([])
    expect(sanctioned.calls, "calls through the Functions P1 transport").toBe(1)
    const rows = await costRows(member.firmId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: "ok", blockReason: null, matterId, actorId: member.uid })
    expect(rows[0]!.costMicroUsd as number).toBeGreaterThan(0)
    expect(server.received).toHaveLength(1)
    expect(server.received[0]).toMatchObject({
      method: "POST",
      path: "/api/platform/brain/committeeBrain",
      authorization: `Bearer ${member.token}`,
      firmId: member.firmId,
      idempotencyKey: key,
    })
    const output = await adminDb().collection("committee_outputs").doc(String(answer.result?.outputId)).get()
    expect(output.exists, "Functions wrote the output row").toBe(true)

    // The same key again: Next replays its stored answer, and the provider is not called a second time.
    const again = await ask(member, matterId, key)
    expect(again.status).toBe(200)
    expect(again.json.reused).toBe(true)
    expect(sanctioned.calls).toBe(1)
  })

  it("(d) no key, the firm's kill switch on: Functions blocks kill_switch_firm and logs it; nothing is sent", async () => {
    const { member, matterId } = await firmWithMatter({ killAll: true })

    const answer = await ask(member, matterId)
    await measure("(d)", answer, member.firmId)

    expect(answer.status, JSON.stringify(answer.json)).toBe(200)
    expect(answer.result).toMatchObject({ blocked: true, reason: "kill_switch_firm" })
    expect(sanctioned.calls + direct.generateText).toBe(0)
    const rows = await costRows(member.firmId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: "blocked", blockReason: "kill_switch_firm", costMicroUsd: 0 })
  })

  it("(e) no key, the platform kill switch on: Functions blocks kill_switch_platform and logs it; nothing is sent", async () => {
    const { member, matterId } = await firmWithMatter()
    await setPlatformKillSwitch()

    const answer = await ask(member, matterId)
    await measure("(e)", answer, member.firmId)

    expect(answer.status, JSON.stringify(answer.json)).toBe(200)
    expect(answer.result).toMatchObject({ blocked: true, reason: "kill_switch_platform" })
    expect(sanctioned.calls + direct.generateText).toBe(0)
    expect(await costRows(member.firmId)).toEqual([expect.objectContaining({ outcome: "blocked", blockReason: "kill_switch_platform" })])
  })

  it("(f) no key, no budget set: Functions blocks budget_not_set and logs it; nothing is sent", async () => {
    const { member, matterId } = await firmWithMatter({ budget: null })

    const answer = await ask(member, matterId)
    await measure("(f)", answer, member.firmId)

    expect(answer.status, JSON.stringify(answer.json)).toBe(200)
    expect(answer.result).toMatchObject({ blocked: true, reason: "budget_not_set" })
    expect(sanctioned.calls + direct.generateText).toBe(0)
    expect(await costRows(member.firmId)).toEqual([expect.objectContaining({ outcome: "blocked", blockReason: "budget_not_set" })])
  })

  it("(g) no key, a budget smaller than one call's worst case: Functions blocks budget_exhausted; nothing is sent", async () => {
    const { member, matterId } = await firmWithMatter({ budget: 1 })

    const answer = await ask(member, matterId)
    await measure("(g)", answer, member.firmId)

    expect(answer.status, JSON.stringify(answer.json)).toBe(200)
    expect(answer.result).toMatchObject({ blocked: true, reason: "budget_exhausted" })
    expect(sanctioned.calls + direct.generateText).toBe(0)
    expect(await costRows(member.firmId)).toEqual([expect.objectContaining({ outcome: "blocked", blockReason: "budget_exhausted" })])
  })

  it("(h) Functions configured but unreachable: 503 p1_functions_unavailable with an alert line; nothing is sent, nothing is stored", async () => {
    vi.stubEnv("SIKANDER_FUNCTIONS_API_BASE_URL", `http://127.0.0.1:${await closedLoopbackPort()}`)
    const { member, matterId } = await firmWithMatter()

    const answer = await ask(member, matterId)
    await measure("(h)", answer, member.firmId)

    expect(answer.status, JSON.stringify(answer.json)).toBe(503)
    expect(answer.json.code).toBe("p1_functions_unavailable")
    expect(errorLines(errorSpy).some((line) => line.includes(FORWARD_ALERT))).toBe(true)
    expect(sanctioned.calls + direct.generateText + direct.createGateway).toBe(0)
    expect(egress).toEqual([])
    const outputs = await adminDb().collection("committee_outputs").where("firmId", "==", member.firmId).get()
    expect(outputs.size).toBe(0)
  })

  it("(i) the eve bridge with a provider key, in production: refused with the documented reason and an alert line; eve's agent refuses to load", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_PROVIDER_KEY)

    const { text, finish } = await eveAsk()
    await measure("(i)", { text, finish })
    // eve's runtime loads agent/agent.ts at start; its framework has model calls of its own outside the bridge (R5).
    const agentLoad = await import("@/agent/agent").then(
      () => "loaded",
      (err: unknown) => `refused: ${err instanceof Error ? err.message : String(err)}`
    )
    console.info(`[F18 e2e] row (i) eve agent module: ${agentLoad.slice(0, 160)}`)

    expect(direct.generateText + direct.createGateway, "direct provider calls from eve").toBe(0)
    expect(egress).toEqual([])
    expect(finish).toBe("error")
    expect(text).toMatch(KEY_REFUSAL)
    expect(errorLines(errorSpy).some((line) => line.includes(KEY_ALERT))).toBe(true)
    expect(agentLoad).toMatch(/^refused: /)
    expect(agentLoad).toMatch(KEY_REFUSAL)
  })

  it("(j) control: the eve bridge without a key is blocked PHASE0_NO_CREDENTIALS (main and branch alike)", async () => {
    const { text, finish } = await eveAsk()
    await measure("(j)", { text, finish })

    expect(direct.generateText + direct.createGateway).toBe(0)
    expect(finish).toBe("error")
    expect(text).toContain(PHASE0_NO_CREDENTIALS)
  })

  // PR #88 review round 1 (Cursor Bugbot, thread 4307502869; spec R1). The Functions `api` function stops at its own
  // timeout before Next's forward deadline, and the route's maxDuration sits above that deadline (pinned in
  // tests/f18-functions-forward.test.ts). The order of the three is pinned here, where the Functions source can load.
  it("pins the deadlines: the Functions api timeout is below Next's forward deadline", () => {
    expect(forwardSeams.FORWARD_TIMEOUT_MS, "FORWARD_TIMEOUT_MS").toBeDefined()
    expect(FUNCTION_TIMEOUT_SECONDS * 1000).toBeLessThan(forwardSeams.FORWARD_TIMEOUT_MS!)
  })

  // A Functions answer can still land after Next has given up waiting: a cold start or a slow network before Functions
  // starts its own clock. The forward deadline is shortened through the test seam to show what then happens: Next answers
  // 504 with the alert line and releases its key; Functions finishes, pays once and stores the output row and its answer
  // under the same Idempotency-Key (F09); a same-key retry gets that stored answer, and the provider is not called again.
  it("(k) Functions answers after Next's forward deadline: 504 with an alert; the call is paid once and stored; a same-key retry returns it", async () => {
    vi.stubEnv("NODE_ENV", "test")
    forwardSeams.setForwardTimeoutForTests?.(400)
    vi.stubEnv("NODE_ENV", "production")
    sanctioned.delayMs = 2_000
    const { member, matterId } = await firmWithMatter()
    const key = randomUUID()

    const first = await ask(member, matterId, key)
    await measure("(k) first", first, member.firmId)
    expect(first.status, JSON.stringify(first.json)).toBe(504)
    expect(first.json.code).toBe("p1_functions_timeout")
    expect(errorLines(errorSpy).some((line) => line.includes(FORWARD_ALERT) && line.includes("p1_functions_timeout"))).toBe(true)

    // Functions carries on after Next's 504: wait until it has stored its answer for the key.
    const fnKey = adminDb().collection("idempotency_keys").doc(`${member.firmId}_${key.toLowerCase()}`)
    const until = Date.now() + 60_000
    while ((await fnKey.get()).get("status") !== "done") {
      if (Date.now() > until) throw new Error("Functions never stored its answer for the key")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(sanctioned.calls, "the late call was made once").toBe(1)
    const outputs = await adminDb().collection("committee_outputs").where("firmId", "==", member.firmId).get()
    expect(outputs.size, "Functions stored the output row").toBe(1)
    expect(await costRows(member.firmId)).toEqual([expect.objectContaining({ outcome: "ok" })])

    sanctioned.delayMs = 0
    const again = await ask(member, matterId, key)
    await measure("(k) same-key retry", again, member.firmId)
    expect(again.status, JSON.stringify(again.json)).toBe(200)
    expect(again.result).toMatchObject({ blocked: false, outputId: outputs.docs[0]!.id, text: "Answer through Functions P1." })
    expect(sanctioned.calls, "no second provider call").toBe(1)
    expect(await costRows(member.firmId)).toHaveLength(1)
    expect(direct.generateText + direct.createGateway).toBe(0)
  })

  // Re-audit follow-up, FA-F18-001(b) (spec ruling R13). This process is not the Functions runtime: it imports the
  // Functions router the way P17's Next route imported the transport. With a key in its environment and no fake
  // transport, the router's callP1 must build no paid transport: the call is blocked no_credentials, with the alert line,
  // and the tripwire sees nothing. (On main the router's transport is built and its POST to the Gateway is refused by
  // the tripwire before any I/O.)
  it("(l) the Functions router outside the Functions runtime, with a key and no fake transport: no paid transport is built; blocked and alerted; nothing leaves", async () => {
    vi.stubEnv("NODE_ENV", "test")
    functionsSeam.setP1TransportForTests?.(null)
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_PROVIDER_KEY)
    const { member, matterId } = await firmWithMatter()

    const res = await fetch(`${server.baseUrl}/api/platform/brain/committeeBrain`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${member.token}`,
        "x-firm-id": member.firmId,
        "idempotency-key": randomUUID(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ matterId, body: "Draft a reply to the notice for the client.", purpose: "committee-brain", classification: "internal", partyNames: [] }),
    })
    const json = (await res.json()) as Record<string, unknown>
    await measure("(l)", { status: res.status, json, result: json }, member.firmId)

    expect(egress, "non-loopback requests").toEqual([])
    expect(sanctioned.calls + direct.generateText + direct.createGateway).toBe(0)
    expect(res.status, JSON.stringify(json)).toBe(200)
    expect(json).toMatchObject({ blocked: true, reason: "no_credentials" })
    expect(errorLines(errorSpy).some((line) => line.includes(KEY_ALERT) && line.includes("AI_GATEWAY_API_KEY") && !line.includes(FAKE_PROVIDER_KEY))).toBe(true)
    expect(await costRows(member.firmId)).toEqual([expect.objectContaining({ outcome: "blocked", blockReason: "no_credentials", costMicroUsd: 0 })])
  })

  // Re-audit follow-up, FA-F18-005 (spec R5 as amended): Next keeps a non-standard NODE_ENV at runtime; a key under any
  // value other than `development` or `test` refuses as production does, before anything is forwarded.
  it("(m) a provider key under NODE_ENV=staging: refused as in production; nothing forwarded, nothing leaves", async () => {
    vi.stubEnv("NODE_ENV", "staging")
    vi.stubEnv("OPENAI_API_KEY", FAKE_PROVIDER_KEY)
    const { member, matterId } = await firmWithMatter()

    const answer = await ask(member, matterId)
    await measure("(m)", answer, member.firmId)

    expect(direct.generateText + direct.createGateway, "direct provider calls from Next").toBe(0)
    expect(egress).toEqual([])
    expect(answer.status, JSON.stringify(answer.json)).toBe(200)
    expect(answer.result?.blocked).toBe(true)
    expect(String(answer.result?.reason)).toMatch(KEY_REFUSAL)
    expect(server.received, "nothing forwarded while a key is present").toEqual([])
    expect(sanctioned.calls).toBe(0)
  })

  // Audit F11 (PR #86, spec ruling 18) on F18's paths: a request releases its audit-outbox entries only at its audited
  // end. On the forward path Next writes nothing (R6), so it stages no entry; a forward failure leaves none either; the
  // local blocked row (a key in production, R5) stages one, and the route's own `committee_brain_output_create` row lets
  // the request release it. No entry is left for the reconciler to turn into a `request_effect_recovered` row.
  it("audit F11: the forward path stages no audit-outbox entry, a forward failure leaves none, and the local blocked row's entry is released", async () => {
    const { member, matterId } = await firmWithMatter()
    const outboxOf = async () => (await adminDb().collection("audit_outbox").where("firmId", "==", member.firmId).get()).docs.map((d) => d.get("effectPaths"))
    const actionsOf = async () => (await adminDb().collection("audit_log").where("firmId", "==", member.firmId).get()).docs.map((d) => String(d.get("action")))

    const forwarded = await ask(member, matterId)
    expect(forwarded.status, JSON.stringify(forwarded.json)).toBe(200)
    expect(server.received).toHaveLength(1)
    expect(await outboxOf(), "the forward path").toEqual([])

    vi.stubEnv("SIKANDER_FUNCTIONS_API_BASE_URL", `http://127.0.0.1:${await closedLoopbackPort()}`)
    const unreachable = await ask(member, matterId)
    expect(unreachable.status, JSON.stringify(unreachable.json)).toBe(503)
    expect(await outboxOf(), "a forward failure").toEqual([])

    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_PROVIDER_KEY)
    const local = await ask(member, matterId)
    expect(local.status, JSON.stringify(local.json)).toBe(200)
    expect(local.result?.blocked).toBe(true)
    expect(await outboxOf(), "the local blocked row").toEqual([])
    const actions = await actionsOf()
    expect(actions.filter((action) => action === "committee_brain_output_create")).toHaveLength(1)
    expect(actions).not.toContain("request_effect_recovered")
  })

  it("leaves nothing behind: every document and Auth user the suite created is gone", async () => {
    const firmId = await provisionFirm()
    const member = await provisionPartner(firmId)
    await seedMatter(member)
    const firms = [...created.firms]
    const uids = [...created.uids]
    await sweep()
    expect(await leftovers(firms, uids)).toEqual([])
    const remaining = await adminAuth().getUsers(uids.map((uid) => ({ uid })))
    expect(remaining.users).toEqual([])
  })
})
