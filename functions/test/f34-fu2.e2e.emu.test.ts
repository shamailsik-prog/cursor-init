import { createHash, generateKeyPairSync, sign } from "node:crypto"
import type { Response } from "express"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import type { Request } from "firebase-functions/v2/https"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildOutbound } from "@/platform/p1/outboundPrompt"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { IDEMPOTENCY_TTL_MS } from "../src/http/idempotency"
import { firmConfigRef, platformConfigRef } from "../src/p1/config"
import { handleCorpusEmbedding } from "../src/p1/corpusEmbedding"
import { reconstructP1Decision } from "../src/p1/decisionRecord"
import { p1EmbeddingTestSeam } from "../src/p1/embedding"
import { setP1EmbeddingTransportForTests } from "../src/p1/embeddingTransport"
import { RESERVATION_LEASE_MS, p1TestSeam } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { p1OpsTestSeam } from "../src/p1/ops"
import { reconcileReservations } from "../src/p1/reconciler"
import { setServiceKeysForTests } from "../src/p1/serviceAuth"
import { p1TraceExportReconciler, reconcileTraceExports } from "../src/p1/traceExport"
import { setP1TransportForTests } from "../src/p1/transport"
import { ApiError, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { deleteFirmData } from "./firmCleanup"

/**
 * Audit F34, independent round-2 re-audit FAIL 7/10 at 7987e39 (#129): the round-2 follow-up, end to end over the Auth and
 * Firestore emulators. Spec: docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md, section 6.
 *
 * - FA-F34-R2-003 (R37): `committeeBrain` through the real HTTP router, a privileged-restricted answer whose output row is
 *   never written (the auditor's probe "R15 premise after the marker's 24 h TTL"): once the idempotency marker is gone and
 *   its TTL has passed, the scheduled export reconciler (`p1TraceExportReconciler`, run here as Cloud Scheduler runs it)
 *   withholds the server-only record's bare prompt hash, and the auditor's dictionary attack over the record recovers
 *   nothing. On main 798cf56 the record keeps the hash and the attack recovers the settlement figure. The published case,
 *   the rank-1 case and the reconciled case keep their hash, and the reconstruction still checks it.
 * - FA-F34-R2-005: the auditor's surviving mutants X03 (a re-exported blocked record read as reconciled, so its hash rode at
 *   rank 0) and X04 (a blocked embedding traced as failed, so its hash rode; the auditor's probe E2). These pass on main:
 *   the code is right there, and these are the tests that were missing.
 *
 * Like the R1 follow-up's file, this one imports only what main already has, so it loads there and its assertions are what
 * fail. The provider is faked at the transport boundary and Opik at its fetch. Every name and figure is invented.
 */

const T = Date.parse("2026-10-24T10:00:00.000Z")
const HOUR = 60 * 60_000
const BIG = 1_000_000_000
const HEX64 = /[0-9a-f]{64}/g
const db = () => adminDb()
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const firms: string[] = []

type Msg = { role: string; content: string }
type Trace = { id: string; metadata: Record<string, unknown>; input?: unknown }

function fakeOpik(status: { code: number } = { code: 204 }): { bodies: string[]; traces: () => Trace[] } {
  vi.stubEnv("OPIK_BASE_URL", "http://opik.test.internal")
  vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", "true")
  const bodies: string[] = []
  setOpikFetchForTests((async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body))
    return new Response(null, { status: status.code })
  }) as typeof fetch)
  return { bodies, traces: () => bodies.map((b) => (JSON.parse(b) as { traces: Trace[] }).traces[0]!) }
}

function gatewayStub(text = "Noted."): Msg[][] {
  const sent: Msg[][] = []
  setP1TransportForTests({
    id: "f34-fu2-fake-gateway",
    async send(r: { messages: Msg[] }) {
      sent.push(JSON.parse(JSON.stringify(r.messages)) as Msg[])
      return { text, inputTokens: 100, outputTokens: 20, model: "claude-opus-5.5", responseId: "resp-f34-fu2" }
    },
  } as never)
  return sent
}

const promptHashOf = (messages: readonly Msg[]) => sha256(JSON.stringify(messages.map((m) => [m.role, m.content])))
/** What an attacker computes for a guessed body: the registry's committee text and the guess, masked as P1 masks it. */
const guessHash = (body: string) =>
  promptHashOf(buildOutbound({ purpose: "committee-brain", turns: [{ role: "user", segments: [{ kind: "text", text: body }] }], partyNames: [] }).messages)
const figure = (n: number) => `Client authorises settlement at PKR ${n} lakh.`
/** The auditor's attack: every 64-hex value in `stored` against every settlement figure from 1000 to 9999. */
function recoverFigure(stored: unknown): number | null {
  const hashes = new Set(JSON.stringify(stored).match(HEX64) ?? [])
  for (let n = 1000; n <= 9999; n++) if (hashes.has(guessHash(figure(n)))) return n
  return null
}

const decisionOf = async (usageLogId: string): Promise<DocumentData | undefined> => (await db().collection("p1_decisions").doc(usageLogId).get()).data()
const byFirm = async (collection: string, firmId: string): Promise<DocumentData[]> =>
  (await db().collection(collection).where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))

type Out = { outputId: string; blocked: boolean; reason?: string; traceId: string; classification: string }
type Firm = { firmId: string; matterId: string; token: string }

async function newFirm(classification: string, cfg: Record<string, unknown> = { monthlyBudgetMicroUsd: BIG }): Promise<Firm> {
  const firmId = uniq("f34fu2")
  firms.push(firmId)
  await db().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  await firmConfigRef(firmId).set(cfg)
  const matterId = uniq("matter")
  await db().collection("matters").doc(matterId).set({ firmId, classification, title: "Recovery suit", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
  const P = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  await db().collection("matter_members").doc(`${matterId}_${P.uid}`).set({ firmId, matterId, userId: P.uid, classification })
  return { firmId, matterId, token: P.token }
}

const ask = (f: Firm, body: string) => {
  let ms = T
  return viaApi<Out>("committeeBrain", { now: () => (ms += 61_000) })({ token: f.token, data: { firmId: f.firmId, matterId: f.matterId, body } } as never)
}

/** The output write fails on every attempt (code 14, UNAVAILABLE), so no `committee_outputs` row is ever written. */
function failEveryOutputWrite(): void {
  p1OpsTestSeam.sleep = async () => {}
  p1OpsTestSeam.outputWriteFailures = Array.from({ length: 50 }, () => Object.assign(new Error("unavailable"), { code: 14 }))
}

/** Firestore's TTL policy on `idempotency_effects.expiresAt` removes the request's marker once its 24 h have passed. */
async function expireMarkers(firmId: string): Promise<void> {
  for (const doc of (await db().collection("idempotency_effects").where("firmId", "==", firmId).get()).docs) await doc.ref.delete()
}

/** One run of the scheduled export reconciler, as Cloud Scheduler runs it, with the wall clock at `atMs`. */
async function scheduledExportRun(atMs: number): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(atMs)
  try {
    await (p1TraceExportReconciler as unknown as { run: (event: unknown) => Promise<void> }).run({ scheduleTime: new Date(atMs).toISOString(), jobName: "f34-fu2" })
  } finally {
    vi.useRealTimers()
  }
}

const KILL = { disableAll: true, disabledModels: [], reason: "drill", setBy: "uid-x", setAt: Timestamp.fromMillis(T) }

beforeEach(() => {
  vi.stubEnv("OPIK_BASE_URL", undefined)
  vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", undefined)
  vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
  vi.stubEnv("SIKANDER_CORPUS_READER_URL", undefined)
  setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: true } })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const k of Object.keys(p1TestSeam)) delete (p1TestSeam as Record<string, unknown>)[k]
  for (const k of Object.keys(p1EmbeddingTestSeam)) delete (p1EmbeddingTestSeam as Record<string, unknown>)[k]
  for (const k of Object.keys(p1OpsTestSeam)) delete (p1OpsTestSeam as Record<string, unknown>)[k]
  setP1TransportForTests(null)
  setP1EmbeddingTransportForTests(null)
  setServiceKeysForTests(null)
  setOpikFetchForTests(null)
  setProviderConfigForTests(null)
  if (EMULATORS) await platformConfigRef().delete()
})

afterAll(async () => {
  if (EMULATORS) await deleteFirmData(firms)
}, 120_000)

// ---------------------------------------------------------------------------------------------------------------------
// FA-F34-R2-003 (R37): the bare hash does not outlive the masked body it hashes
// ---------------------------------------------------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("FA-F34-R2-003: a prompt hash with no output row is withheld once the marker's TTL has passed (R37)", () => {
  it("a privileged-restricted answer whose output row is never written: the hash stays while the marker lives, is withheld after its TTL, and the record then recovers nothing", async () => {
    const f = await newFirm("privileged-restricted")
    gatewayStub()
    failEveryOutputWrite()
    const secret = 1000 + Math.floor(Math.random() * 9000)
    const err = await ask(f, figure(secret)).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(ApiError)
    expect(await byFirm("committee_outputs", f.firmId)).toEqual([])
    const [d0] = await byFirm("p1_decisions", f.firmId)
    // The attack is sound: the server-only record holds exactly the hash it computes.
    expect(d0!.prompt.hash).toBe(guessHash(figure(secret)))

    // While the marker lives it stores the masked body beside the hash, and a retry may still publish: nothing changes.
    await scheduledExportRun(T + HOUR)
    expect((await decisionOf(d0!.id as string))!.prompt.hash).toBe(d0!.prompt.hash)

    await expireMarkers(f.firmId)
    await scheduledExportRun(T + IDEMPOTENCY_TTL_MS + HOUR)
    const d = (await decisionOf(d0!.id as string))!
    expect(d.prompt.hash, "the bare hash outlived the marker").toBeNull()
    expect(d.prompt).toMatchObject({ hashWithheld: "no_output_row", templateId: "committee-brain", hashAlgorithm: "sha256/p1-messages-v1" })
    expect(d.prompt).not.toHaveProperty("hashWithholdAtMs")
    expect(recoverFigure(d), "the settlement figure is recoverable from the server-only record").toBeNull()
    const rec = await reconstructP1Decision(db(), { usageLogId: d0!.id as string })
    expect(rec?.checks.promptHashMatchesOutput).toBeNull()
  })

  it("a privileged answer that was published keeps its hash after the TTL, and the reconstruction still checks it against the output row", async () => {
    const f = await newFirm("privileged")
    gatewayStub()
    const out = await ask(f, figure(4321))
    expect(out.blocked).toBe(false)
    const usageLogId = (await db().collection("committee_outputs").doc(out.outputId).get()).get("usageLogId") as string
    expect((await decisionOf(usageLogId))!.prompt).not.toHaveProperty("hashWithholdAtMs")
    await expireMarkers(f.firmId)
    await scheduledExportRun(T + IDEMPOTENCY_TTL_MS + HOUR)
    const d = (await decisionOf(usageLogId))!
    expect(d.prompt.hash).toBe(guessHash(figure(4321)))
    expect(d.prompt).not.toHaveProperty("hashWithheld")
    expect((await reconstructP1Decision(db(), { usageLogId }))?.checks.promptHashMatchesOutput).toBe(true)
  })

  it("an internal answer whose output row is never written keeps its hash: at rank 1 the masked text itself rides to Opik", async () => {
    const f = await newFirm("internal")
    gatewayStub()
    failEveryOutputWrite()
    await ask(f, figure(2468)).catch(() => null)
    const [d0] = await byFirm("p1_decisions", f.firmId)
    expect(d0!.prompt).not.toHaveProperty("hashWithholdAtMs")
    await expireMarkers(f.firmId)
    await scheduledExportRun(T + IDEMPOTENCY_TTL_MS + HOUR)
    expect((await decisionOf(d0!.id as string))!.prompt.hash).toBe(guessHash(figure(2468)))
  })

  it("a privileged-restricted call whose commit failed: the published row is found, so the lease-reconciled record keeps its hash", async () => {
    const f = await newFirm("privileged-restricted")
    gatewayStub()
    p1TestSeam.failCommit = true
    const out = await ask(f, figure(8765))
    p1TestSeam.failCommit = false
    const usageLogId = (await db().collection("committee_outputs").doc(out.outputId).get()).get("usageLogId") as string
    await reconcileReservations({ now: () => T + RESERVATION_LEASE_MS + HOUR })
    const reconciled = (await decisionOf(usageLogId))!
    expect(reconciled.settledBy).toBe("reconciler")
    // The record came from the reservation's seed, which carries the time; the output row predates it.
    expect(typeof reconciled.prompt.hashWithholdAtMs).toBe("number")
    await scheduledExportRun(T + IDEMPOTENCY_TTL_MS + HOUR)
    const d = (await decisionOf(usageLogId))!
    expect(d.prompt.hash).toBe(guessHash(figure(8765)))
    expect(d.prompt).not.toHaveProperty("hashWithholdAtMs")
    expect(d.prompt).not.toHaveProperty("hashWithheld")
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// FA-F34-R2-005: the auditor's surviving mutants X03 and X04
// ---------------------------------------------------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("FA-F34-R2-005: a blocked call's hash never rides, on a re-export or from the embedding path (R15)", () => {
  it("X03: a public call blocked by the firm kill switch, whose export failed, is re-exported as blocked and without its prompt hash", async () => {
    const f = await newFirm("public", { monthlyBudgetMicroUsd: BIG, killSwitch: KILL })
    const status = { code: 500 }
    const opik = fakeOpik(status)
    const sent = gatewayStub("UNUSED")
    const out = await ask(f, "Draft a reply to the notice about the quokka matter.")
    expect([out.blocked, out.reason, sent.length]).toEqual([true, "kill_switch_firm", 0])
    const [d] = await byFirm("p1_decisions", f.firmId)
    expect(d!.export.state).toBe("pending")
    expect(typeof d!.prompt.hash).toBe("string")
    opik.bodies.length = 0
    status.code = 204
    const run = await reconcileTraceExports({ now: () => T + 6 * HOUR })
    expect(run.exported).toContain(d!.id)
    const mine = opik.traces().filter((t) => t.id === out.traceId)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.metadata).toMatchObject({ outcome: "blocked", blockReason: "kill_switch_firm" })
    expect(mine[0]!.metadata, "a blocked call's hash rode on its re-export").not.toHaveProperty("promptHash")
    expect(opik.bodies.join("\n")).not.toContain(d!.prompt.hash as string)
  })

  // The auditor's probe E2 (re-audit evidence probes/zz-audit-r2-r1002.emu.test.ts), through p1CorpusEmbedding's handler
  // with a verified service token.
  it("X04: a public embedding blocked by the platform kill switch is traced as blocked, without its input hash", async () => {
    const firmId = uniq("f34fu2emb")
    firms.push(firmId)
    await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BIG })
    await platformConfigRef().set({ killSwitch: KILL })
    const opik = fakeOpik()
    const sent = embeddingStub()
    const out = await embedViaHttp(firmId)
    expect([out.body.outcome, out.body.blockReason, sent.length]).toEqual(["blocked", "kill_switch_platform", 0])
    const [d] = await byFirm("p1_decisions", firmId)
    expect(d!.prompt.hash).toBe(sha256(MASKED_INPUT))
    const [trace] = opik.traces()
    expect(trace!.metadata).toMatchObject({ outcome: "blocked", blockReason: "kill_switch_platform", classification: "public" })
    expect(trace!.metadata, "a blocked embedding's hash rode").not.toHaveProperty("promptHash")
    expect(opik.bodies.join("\n")).not.toContain(sha256(MASKED_INPUT))
  })
})

const MODEL = "openai/text-embedding-3-small"
const DIMS = 1536
const CALLER = "corpus-embedder@corpus-project.iam.gserviceaccount.com"
const OP = "d".repeat(64)
const INPUT = "Section 12 F34-FU2-ROW. Write to the clerk, CNIC 61101-7654321-9, for the record of proceedings."
const MASKED_INPUT = INPUT.replace("61101-7654321-9", "[CNIC]")
const AUDIENCE = "https://p1corpusembedding-f34fu2-el.a.run.app"
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const KID = "f34-fu2-emu-key"
const JWKS = { keys: [{ ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID, alg: "RS256", use: "sig" }] }
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")

function idToken(): string {
  const now = Math.floor(T / 1000)
  const input = `${b64({ alg: "RS256", kid: KID, typ: "JWT" })}.${b64({ iss: "https://accounts.google.com", aud: AUDIENCE, sub: "1234567890", email: CALLER, email_verified: true, iat: now - 10, exp: now + 3000 })}`
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`
}

async function embedViaHttp(firmId: string, classification = "public"): Promise<{ status: number; body: Record<string, unknown> }> {
  vi.stubEnv("P1_CORPUS_FIRM_ID", firmId)
  vi.stubEnv("P1_CORPUS_AUDIENCE", AUDIENCE)
  vi.stubEnv("P1_CORPUS_CALLERS", CALLER)
  setServiceKeysForTests(JWKS)
  const raw = Buffer.from(JSON.stringify({ operationId: OP, model: "text-embedding-3-small", dimensions: DIMS, input: INPUT, classification }))
  const request = { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${idToken()}`, "content-length": String(raw.length) }, rawBody: raw } as unknown as Request
  const out = { status: 0, body: {} as Record<string, unknown> }
  const res = {
    status(code: number) {
      out.status = code
      return res
    },
    set() {
      return res
    },
    json(b: Record<string, unknown>) {
      out.body = JSON.parse(JSON.stringify(b)) as Record<string, unknown>
      return res
    },
  }
  await handleCorpusEmbedding(request, res as unknown as Response, { now: () => T })
  return out
}

function embeddingStub(): { model: string; input: string }[] {
  const sent: { model: string; input: string }[] = []
  setP1EmbeddingTransportForTests({
    id: "f34-fu2-fake-embeddings",
    async embed(r: { model: string; input: string }) {
      sent.push({ ...r })
      return { embedding: Array.from({ length: DIMS }, (_, i) => (i % 5) / 10), inputTokens: 9, model: MODEL, requestId: "req-f34-fu2" }
    },
  } as never)
  return sent
}
