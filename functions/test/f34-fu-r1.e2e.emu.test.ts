import { createHash, generateKeyPairSync, sign } from "node:crypto"
import type { Response } from "express"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import type { Request } from "firebase-functions/v2/https"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildOutbound } from "@/platform/p1/outboundPrompt"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { SYSTEM_POLICIES } from "@/platform/p1/systemPolicy"
import { adminDb } from "../src/admin"
import { firmConfigRef, platformConfigRef, reservationRef } from "../src/p1/config"
import { handleCorpusEmbedding } from "../src/p1/corpusEmbedding"
import { reconstructP1Decision } from "../src/p1/decisionRecord"
import { callP1Embedding, p1EmbeddingTestSeam, type P1EmbeddingRequest } from "../src/p1/embedding"
import { setP1EmbeddingTransportForTests } from "../src/p1/embeddingTransport"
import { RESERVATION_LEASE_MS, callP1, p1TestSeam, type P1Request } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { p1OpsTestSeam } from "../src/p1/ops"
import { reconcileReservations } from "../src/p1/reconciler"
import { setServiceKeysForTests } from "../src/p1/serviceAuth"
import { reconcileTraceExports } from "../src/p1/traceExport"
import { setP1TransportForTests } from "../src/p1/transport"
import { ApiError, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { deleteFirmData } from "./firmCleanup"

/**
 * Audit F34, independent re-audit FAIL 6/10 at e37b115 (#121): the R1 follow-up, end to end over the Auth and Firestore
 * emulators. Spec: docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md, section 5 (R15 to R25).
 *
 * - FA-F34-R1-001 (R15): `committeeBrain` through the real HTTP router at ranks 2 to 4, and a refused `not_minimised`
 *   call: the exported Opik payload carries no prompt hash, and a dictionary attack over it recovers nothing. On main
 *   e37b115 the payload's `metadata.promptHash` gives the privileged figure and the refused call's name back.
 * - FA-F34-R1-002 (R16): the corpus embedding path (`p1CorpusEmbedding`'s handler with a verified token, and
 *   `callP1Embedding`) writes its decision record: an ok call whose export failed is pending and then exported by the
 *   export reconciler; a block is recorded with its reason; a call that died after dispatch gets a record consistent
 *   with its seed. On main no `p1_decisions` record exists for any of them.
 * - The LOWs in the same files: R1-005 (R19), R1-006 (R20, residual 10), R1-007 (R21), R1-009 (R23), R1-010 (R24),
 *   R1-011 (R25).
 *
 * This file imports only what main already has, so it loads there and its assertions are what fail. The provider is
 * faked at the transport boundary and Opik at its fetch. Every name, figure, citation and marker is invented.
 */

const T = Date.parse("2026-10-24T10:00:00.000Z")
const BIG = 1_000_000_000
const OPUS = "anthropic/claude-opus-5.5"
const HEX64 = /[0-9a-f]{64}/g
const db = () => adminDb()
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const afterLease = () => T + RESERVATION_LEASE_MS + 1_000
const firms: string[] = []

type Msg = { role: string; content: string }
type Trace = { id: string; metadata: Record<string, unknown>; input?: unknown; output?: unknown }

/** Enables Opik (self-hosted, confirmed) with a fake fetch; `status.code` may change between posts. */
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

/** A stub Gateway answering `text`, reporting `model`; it records every request's messages. */
function gatewayStub(text: string, model: string = "claude-opus-5.5"): Msg[][] {
  const sent: Msg[][] = []
  setP1TransportForTests({
    id: "f34-fu-fake-gateway",
    async send(r: { messages: Msg[] }) {
      sent.push(JSON.parse(JSON.stringify(r.messages)) as Msg[])
      return { text, inputTokens: 1000, outputTokens: 500, model, responseId: "resp-f34-fu-1" }
    },
  } as never)
  return sent
}

/** The prompt hash of the spec (R3): SHA-256 of the canonical JSON of the masked messages as sent. */
const promptHashOf = (messages: readonly Msg[]) => sha256(JSON.stringify(messages.map((m) => [m.role, m.content])))
/** What an attacker computes for a guessed body: the registry's committee text and the guess, masked as P1 masks it. */
const guessHash = (body: string) =>
  promptHashOf(buildOutbound({ purpose: "committee-brain", turns: [{ role: "user", segments: [{ kind: "text", text: body }] }], partyNames: [] }).messages)

const decisionOf = async (usageLogId: string): Promise<DocumentData | undefined> => (await db().collection("p1_decisions").doc(usageLogId).get()).data()
const byFirm = async (collection: string, firmId: string): Promise<DocumentData[]> =>
  (await db().collection(collection).where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))

type Out = { outputId: string; blocked: boolean; reason?: string; text?: string; traceId: string; classification: string; accounting: string }
type Firm = { firmId: string; matterId: string; token: string }

async function newFirm(classification: string): Promise<Firm> {
  const firmId = uniq("f34fu")
  firms.push(firmId)
  await db().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BIG })
  const matterId = uniq("matter")
  await db().collection("matters").doc(matterId).set({ firmId, classification, title: "Recovery suit", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
  const P = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  await db().collection("matter_members").doc(`${matterId}_${P.uid}`).set({ firmId, matterId, userId: P.uid, classification })
  return { firmId, matterId, token: P.token }
}

function brain() {
  let ms = T
  return viaApi<Out>("committeeBrain", { now: () => (ms += 61_000) })
}
const ask = (f: Firm, body: string) => brain()({ token: f.token, data: { firmId: f.firmId, matterId: f.matterId, body } } as never)
const usageLogIdOf = async (out: Out): Promise<string> => (await db().collection("committee_outputs").doc(out.outputId).get()).get("usageLogId") as string

async function seedFirm(cfg: Record<string, unknown> = { monthlyBudgetMicroUsd: BIG }): Promise<string> {
  const firmId = uniq("f34fu")
  firms.push(firmId)
  await firmConfigRef(firmId).set(cfg)
  return firmId
}

const req = (firmId: string, extra: Partial<P1Request> = {}): P1Request => ({
  firmId,
  actorId: "uid-1",
  matterId: "matter-1",
  jobId: null,
  taskType: "committee",
  classification: "internal",
  body: "Draft a reply to the notice.",
  purpose: "committee-brain",
  ...extra,
})

const KILL = { disableAll: true, disabledModels: [], reason: "drill", setBy: "uid-x", setAt: Timestamp.fromMillis(T) }

beforeEach(() => {
  vi.stubEnv("OPIK_BASE_URL", undefined)
  vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", undefined)
  vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
  vi.stubEnv("SIKANDER_CORPUS_READER_URL", undefined)
  setProviderConfigForTests(null)
})

afterEach(async () => {
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
// FA-F34-R1-001 (R15): no prompt hash leaves at ranks 2 to 4 or on a blocked call
// ---------------------------------------------------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("FA-F34-R1-001: the exported trace carries no reversible prompt hash (R15)", () => {
  it("a privileged committee answer exports no prompt hash, and a dictionary attack on the exported payload recovers nothing", async () => {
    setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: true } })
    const f = await newFirm("privileged")
    const opik = fakeOpik()
    gatewayStub("Noted.")
    const secret = 1000 + Math.floor(Math.random() * 9000)
    const body = `Client authorises settlement at PKR ${secret} lakh.`
    const out = await ask(f, body)
    expect([out.blocked, out.classification]).toEqual([false, "privileged"])
    expect(opik.bodies).toHaveLength(1)
    const [trace] = opik.traces()
    expect("input" in trace!).toBe(false)
    expect(trace!.metadata, "no prompt hash at rank 3").not.toHaveProperty("promptHash")
    // The attack is sound: the server-only record holds exactly the hash it computes.
    const usageLogId = await usageLogIdOf(out)
    expect((await decisionOf(usageLogId))!.prompt.hash).toBe(guessHash(body))
    const exported = new Set(opik.bodies.join("\n").match(HEX64) ?? [])
    let recovered: number | null = null
    for (let n = 1000; n <= 9999 && recovered === null; n++) if (exported.has(guessHash(`Client authorises settlement at PKR ${n} lakh.`))) recovered = n
    expect(recovered, "the settlement figure is recoverable from the exported payload").toBeNull()
  })

  it("a refused not_minimised call exports no prompt hash, and a name dictionary recovers nothing", async () => {
    setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: true } })
    const f = await newFirm("privileged")
    const opik = fakeOpik()
    const sent = gatewayStub("UNUSED")
    const out = await ask(f, "Draft bail grounds for the accused s/o Kamran.")
    expect([out.blocked, out.reason, sent.length]).toEqual([true, "not_minimised", 0])
    const [trace] = opik.traces()
    expect(trace!.metadata, "no prompt hash on a blocked call").not.toHaveProperty("promptHash")
    const exported = new Set(opik.bodies.join("\n").match(HEX64) ?? [])
    const names = ["Ahmed", "Bilal", "Imran", "Kamran", "Usman", "Zubair", "Faisal", "Tariq", "Nadeem", "Saleem"]
    expect(names.find((n) => exported.has(guessHash(`Draft bail grounds for the accused s/o ${n}.`))) ?? null).toBeNull()
  })

  it.each([
    ["public", true],
    ["internal", true],
    ["confidential", false],
    ["privileged", false],
    ["privileged-restricted", false],
  ] as const)("an answered %s call exports the prompt hash only where its text may ride (%s)", async (classification, carries) => {
    setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: true } })
    const firmId = await seedFirm()
    const opik = fakeOpik()
    const sent = gatewayStub("Noted.")
    const r = await callP1(req(firmId, { classification }), { now: () => T })
    expect(r.outcome).toBe("ok")
    const [trace] = opik.traces()
    if (carries) {
      expect(trace!.metadata.promptHash).toBe(promptHashOf(sent[0]!))
      expect(trace!.input).toBeDefined()
    } else {
      expect(trace!.metadata).not.toHaveProperty("promptHash")
      expect(opik.bodies[0]).not.toContain(promptHashOf(sent[0]!))
    }
  })

  it("a blocked internal call exports no prompt hash", async () => {
    const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG, killSwitch: KILL })
    const opik = fakeOpik()
    gatewayStub("UNUSED")
    const r = await callP1(req(firmId), { now: () => T })
    expect([r.outcome, r.blockReason]).toEqual(["blocked", "kill_switch_firm"])
    expect(opik.traces()[0]!.metadata).not.toHaveProperty("promptHash")
    expect(opik.bodies[0]).not.toContain((await decisionOf(r.usageLogId))!.prompt.hash as string)
  })

  it("a privileged record re-exported by the export reconciler carries no prompt hash", async () => {
    setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: true } })
    const firmId = await seedFirm()
    const status = { code: 500 }
    const opik = fakeOpik(status)
    gatewayStub("Noted.")
    const r = await callP1(req(firmId, { classification: "privileged" }), { now: () => T })
    const hash = (await decisionOf(r.usageLogId))!.prompt.hash as string
    expect((await decisionOf(r.usageLogId))!.export).toMatchObject({ state: "pending", attempts: 1 })
    status.code = 204
    expect((await reconcileTraceExports({ now: () => T + 6 * 60_000 })).exported).toContain(r.usageLogId)
    const retried = opik.traces().filter((t) => t.id === r.traceId)
    expect(retried).toHaveLength(2)
    expect(retried[1]!.metadata).not.toHaveProperty("promptHash")
    // Only this record's posts: another suite's internal record with the same body may be due in the shared emulator,
    // and at rank 1 its hash rides legitimately.
    expect(JSON.stringify(retried)).not.toContain(hash)
  })

  it("R1-005 (R19): the provider's model name is exported only when it is the configured model or its alias", async () => {
    const firmId = await seedFirm()
    const opik = fakeOpik()
    gatewayStub("Noted.", "zanzibar-quokka-restricted-strategy")
    const odd = await callP1(req(firmId), { now: () => T })
    gatewayStub("Noted.", "claude-opus-5.5")
    const alias = await callP1(req(firmId), { now: () => T })
    gatewayStub("Noted.", OPUS)
    const exact = await callP1(req(firmId), { now: () => T })
    const meta = (traceId: string) => opik.traces().find((t) => t.id === traceId)!.metadata
    expect(meta(odd.traceId).modelReported).toBe("unrecognised")
    expect(opik.bodies.join("\n")).not.toContain("zanzibar")
    expect(meta(alias.traceId).modelReported).toBe("claude-opus-5.5")
    expect(meta(exact.traceId).modelReported).toBe(OPUS)
    // The server-only record keeps what the provider reported (F17).
    expect((await decisionOf(odd.usageLogId))!.model.reported).toBe("zanzibar-quokka-restricted-strategy")
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// FA-F34-R1-002 (R16): the corpus embedding path writes its decision record
// ---------------------------------------------------------------------------------------------------------------------

const MODEL = "openai/text-embedding-3-small"
const DIMS = 1536
const CALLER = "corpus-embedder@corpus-project.iam.gserviceaccount.com"
const OP = "b".repeat(64)
const INPUT = "Section 9 F34-ROW-001. Contact the registrar, CNIC 35202-1234567-1, for certified copies."
const MASKED_INPUT = INPUT.replace("35202-1234567-1", "[CNIC]")
const AUDIENCE = "https://p1corpusembedding-f34fu-el.a.run.app"
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const KID = "f34-fu-emu-key"
const JWKS = { keys: [{ ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID, alg: "RS256", use: "sig" }] }
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")

function idToken(): string {
  const now = Math.floor(T / 1000)
  const input = `${b64({ alg: "RS256", kid: KID, typ: "JWT" })}.${b64({ iss: "https://accounts.google.com", aud: AUDIENCE, sub: "1234567890", email: CALLER, email_verified: true, iat: now - 10, exp: now + 3000 })}`
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`
}

/** One POST to the `p1CorpusEmbedding` handler with a verified service token, for the firm the deployment names. */
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
    id: "f34-fu-fake-embeddings",
    async embed(r: { model: string; input: string }) {
      sent.push({ ...r })
      return { embedding: Array.from({ length: DIMS }, (_, i) => (i % 5) / 10), inputTokens: 9, model: MODEL, requestId: "req-f34-fu-1" }
    },
  } as never)
  return sent
}

const embeddingRequest = (firmId: string, over: Partial<P1EmbeddingRequest> = {}): P1EmbeddingRequest => ({
  firmId,
  caller: CALLER,
  operationId: OP,
  corpusModel: "text-embedding-3-small",
  dimensions: DIMS,
  input: INPUT,
  classification: "public",
  ...over,
})

describe.skipIf(!EMULATORS)("FA-F34-R1-002: the corpus embedding path writes its decision record (R16)", () => {
  it("through p1CorpusEmbedding: an ok embedding whose export failed is recorded pending, retried by the export reconciler, and ends exported", async () => {
    const firmId = await seedFirm()
    const status = { code: 500 }
    const opik = fakeOpik(status)
    const sent = embeddingStub()
    const out = await embedViaHttp(firmId)
    expect([out.status, out.body.outcome]).toEqual([200, "ok"])
    expect(sent).toEqual([{ model: MODEL, input: MASKED_INPUT }])
    const usageLogId = out.body.usageLogId as string
    const d = await decisionOf(usageLogId)
    expect(d, "an embedding leaves a decision record (R16)").toBeDefined()
    expect(d).toMatchObject({
      recordVersion: "f34.3",
      traceId: out.body.traceId,
      usageLogId,
      firmId,
      actorId: "system",
      matterId: null,
      taskType: "embedding",
      classification: "public",
      operationId: null,
      caller: CALLER,
      corpusOperationId: OP,
      outcome: "ok",
      blockReason: null,
      settledBy: "gateway",
      prompt: { templateId: null, templateVersion: null, templateSha256: null, hash: sha256(MASKED_INPUT), hashAlgorithm: "sha256/p1-embedding-input-v1", messageCount: 1 },
      model: { configured: MODEL, reported: MODEL, revisionStatus: "reported", provider: "ai-gateway", transport: "f34-fu-fake-embeddings", requestId: "req-f34-fu-1" },
      retrieval: { context: { state: "none", anchors: [] } },
      decisions: {
        killSwitch: { platform: "clear", firm: "clear" },
        systemVerified: null,
        route: { classification: "public", rank: 0, provider: "ai-gateway", allowed: true },
        mask: { redactionCounts: { cnic: 1 }, policyVersion: "f34.1" },
        budget: { firstLook: "fits", reservation: "reserved" },
        credentials: "present",
        attemptRecord: "recorded",
      },
      cost: { inputTokens: 9, outputTokens: 0, tokensEstimated: false, costMicroUsd: out.body.costMicroUsd, reservation: `ai_reservations/${usageLogId}` },
      export: { state: "pending", attempts: 1, lastCode: "export_failed" },
    })
    expect(d!.model.gatewayVersion).toMatch(/^f34\./)
    for (const phase of ["firstReadsMs", "maskMs", "reserveMs", "attemptRecordMs", "transportMs", "attemptOutcomeMs", "traceMs"]) expect(d!.phases[phase], phase).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(d)).not.toContain("35202")
    expect(JSON.stringify(d)).not.toContain("registrar")
    // The usage row still says what the call's export did; the record is what the reconciler retries.
    expect((await db().collection("ai_usage_logs").doc(usageLogId).get()).get("trace")).toEqual({ id: out.body.traceId, status: "failed" })

    status.code = 204
    const run = await reconcileTraceExports({ now: () => T + 6 * 60_000 })
    expect(run.exported).toContain(usageLogId)
    expect((await decisionOf(usageLogId))!.export).toMatchObject({ state: "exported", attempts: 2 })
    const retried = opik.traces().filter((t) => t.id === out.body.traceId)
    expect(retried).toHaveLength(2)
    expect(retried[1]!.metadata).toMatchObject({ taskType: "embedding", usageLogId, outcome: "ok" })
    expect("input" in retried[1]!).toBe(false)
    expect(opik.bodies.join("\n")).not.toContain("35202")
    const rec = await reconstructP1Decision(db(), { traceId: out.body.traceId as string })
    expect(rec!.checks).toMatchObject({ decisionPresent: true, usageJoined: true, reservationJoined: true, exportState: "exported" })
  })

  it("through p1CorpusEmbedding: a kill-switch block is recorded with its reason and nothing sent", async () => {
    const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG, killSwitch: KILL })
    const sent = embeddingStub()
    const out = await embedViaHttp(firmId)
    expect([out.status, out.body.outcome, out.body.blockReason, sent.length]).toEqual([200, "blocked", "kill_switch_firm", 0])
    const d = await decisionOf(out.body.usageLogId as string)
    expect(d, "a blocked embedding leaves a decision record (R16)").toBeDefined()
    expect(d).toMatchObject({
      outcome: "blocked",
      blockReason: "kill_switch_firm",
      taskType: "embedding",
      caller: CALLER,
      corpusOperationId: OP,
      prompt: { hash: sha256(MASKED_INPUT), hashAlgorithm: "sha256/p1-embedding-input-v1" },
      decisions: { killSwitch: { platform: "clear", firm: "blocks" }, budget: { firstLook: "not_reached", reservation: "not_attempted" }, credentials: "not_checked", attemptRecord: "not_attempted" },
      phases: { reserveMs: null, attemptRecordMs: null, transportMs: null, attemptOutcomeMs: null },
      model: { reported: null, revisionStatus: "unreported", transport: null },
      cost: { costMicroUsd: 0, reservation: null },
      export: { state: "disabled", attempts: 0, disabledReason: "unset" },
    })
    const rec = await reconstructP1Decision(db(), { usageLogId: out.body.usageLogId as string })
    expect(rec!.events).toEqual(["ai.call.blocked"])
  })

  it("through p1CorpusEmbedding: a policy refusal is recorded with its reason", async () => {
    const firmId = await seedFirm()
    const sent = embeddingStub()
    const out = await embedViaHttp(firmId, "confidential")
    expect([out.body.outcome, out.body.blockReason, sent.length]).toEqual(["blocked", "policy_denied", 0])
    expect(await decisionOf(out.body.usageLogId as string)).toMatchObject({
      outcome: "blocked",
      blockReason: "policy_denied",
      classification: "confidential",
      decisions: { killSwitch: { platform: "clear", firm: "clear" }, route: { classification: "confidential", rank: 2, allowed: false, minimisationRequired: false, minimised: null } },
    })
  })

  it("a call that died after dispatch gets, from the lease reconciler, a record consistent with its seed", async () => {
    const firmId = await seedFirm()
    embeddingStub()
    p1EmbeddingTestSeam.crashAt = "dispatched"
    await expect(callP1Embedding(embeddingRequest(firmId), { now: () => T })).rejects.toThrow(/crashAt/)
    delete p1EmbeddingTestSeam.crashAt
    const [res] = await byFirm("ai_reservations", firmId)
    const seed = (await reservationRef(res!.id as string).get()).get("decisionSeed")
    expect(seed, "the reservation carries the decision seed (R16)").toBeDefined()
    expect((await reconcileReservations({ now: afterLease })).settled).toContain(res!.id)
    const d = await decisionOf(res!.id as string)
    expect(d).toBeDefined()
    expect(d).not.toHaveProperty("seedMissing")
    expect(d).toMatchObject({
      outcome: "reconciled",
      settledBy: "reconciler",
      taskType: "embedding",
      caller: CALLER,
      corpusOperationId: OP,
      prompt: { ...seed.prompt, hash: sha256(MASKED_INPUT), hashAlgorithm: "sha256/p1-embedding-input-v1", messageCount: 1 },
      model: { configured: MODEL, transport: "f34-fu-fake-embeddings", gatewayVersion: seed.model.gatewayVersion },
      decisions: { ...seed.decisions, attemptRecord: "recorded", fromSeed: true },
      export: { state: "disabled", disabledReason: "unset" },
      // The instance died before the provider's answer was recorded: the hold is charged, and no transport time is known.
      cost: { reconciledFrom: "worst_case" },
      phases: { firstReadsMs: seed.phases.firstReadsMs, maskMs: seed.phases.maskMs, transportMs: null },
    })
  })

  it("a call whose commit failed after the answer was recorded gets the transport time from its attempt", async () => {
    const firmId = await seedFirm()
    embeddingStub()
    p1EmbeddingTestSeam.failCommit = true
    const r = await callP1Embedding(embeddingRequest(firmId), { now: () => T })
    delete p1EmbeddingTestSeam.failCommit
    expect([r.outcome, r.accounting]).toEqual(["ok", "pending"])
    expect(await decisionOf(r.usageLogId)).toBeUndefined()
    expect((await reconcileReservations({ now: afterLease })).settled).toContain(r.usageLogId)
    const d = await decisionOf(r.usageLogId)
    expect(d).toMatchObject({ outcome: "reconciled", caller: CALLER, corpusOperationId: OP, cost: { reconciledFrom: "recorded", inputTokens: 9 }, decisions: { attemptRecord: "recorded", fromSeed: true } })
    expect(d!.phases.transportMs).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The LOWs in the same files
// ---------------------------------------------------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("F34 R1 LOWs end to end", () => {
  it("R1-006 (R20, residual 10): a pre-call deadline exit leaves no decision record; the route's deny audit row names precall_deadline", async () => {
    const f = await newFirm("internal")
    const sent = gatewayStub("UNUSED")
    p1OpsTestSeam.preCallClock = () => Date.now() + 8_001
    const err = await ask(f, "Draft the reply to the notice.").then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(ApiError)
    expect([(err as ApiError).status, (err as ApiError).code]).toEqual([503, "precall_deadline"])
    expect(sent).toHaveLength(0)
    expect(await byFirm("p1_decisions", f.firmId)).toEqual([])
    expect(await byFirm("ai_usage_logs", f.firmId)).toEqual([])
    const audit = await byFirm("audit_log", f.firmId)
    expect(audit.filter((a) => a.decision === "deny" && a.reason === "precall_deadline")).toHaveLength(1)
  })

  it("R1-007 (R21): a record the lease reconciler writes says the attempt was recorded and that its verdicts are the seed's", async () => {
    const firmId = await seedFirm()
    gatewayStub("ANSWER")
    p1TestSeam.failCommit = true
    const r = await callP1(req(firmId), { now: () => T })
    p1TestSeam.failCommit = false
    expect((await reservationRef(r.usageLogId).get()).get("providerAttempt.outcome")).toBe("returned")
    expect((await reconcileReservations({ now: afterLease })).settled).toContain(r.usageLogId)
    const d = await decisionOf(r.usageLogId)
    expect(d!.decisions).toMatchObject({ attemptRecord: "recorded", fromSeed: true, budget: { reservation: "reserved" } })
  })

  it("R1-009 (R23): export.disabledReason tells Opik turned off from Opik misconfigured, and a rejected URL logs p1.opik_misconfigured", async () => {
    const firmId = await seedFirm()
    gatewayStub("ANSWER")
    const error = vi.spyOn(logger, "error")
    const off = await callP1(req(firmId), { now: () => T })
    expect((await decisionOf(off.usageLogId))!.export).toEqual({ state: "disabled", attempts: 0, disabledReason: "unset" })
    expect(error.mock.calls.filter((c) => c[0] === "p1.opik_misconfigured")).toEqual([])

    vi.stubEnv("OPIK_BASE_URL", "http://opik.example.com")
    const bad = await callP1(req(firmId), { now: () => T })
    expect((await decisionOf(bad.usageLogId))!.export).toEqual({ state: "disabled", attempts: 0, disabledReason: "invalid_url" })
    vi.stubEnv("OPIK_BASE_URL", "https://opik.example.com")
    const unconfirmed = await callP1(req(firmId), { now: () => T })
    expect((await decisionOf(unconfirmed.usageLogId))!.export).toEqual({ state: "disabled", attempts: 0, disabledReason: "unconfirmed" })
    const lines = error.mock.calls.filter((c) => c[0] === "p1.opik_misconfigured")
    expect(lines).toEqual([
      // `event`: the field the log-based alert policy filters on (audit F43 R1, FA-F43-R1-001).
      ["p1.opik_misconfigured", { reason: "invalid_url", event: "p1.opik_misconfigured" }],
      ["p1.opik_misconfigured", { reason: "unconfirmed", event: "p1.opik_misconfigured" }],
    ])
    expect(JSON.stringify(error.mock.calls)).not.toContain("opik.example.com")
  })

  it("R1-011 (R25): every record names the mask policy version, on the call's record and on the seed", async () => {
    const firmId = await seedFirm()
    gatewayStub("ANSWER")
    const r = await callP1(req(firmId), { now: () => T })
    expect((await decisionOf(r.usageLogId))!.decisions.mask).toMatchObject({ policyVersion: "f34.1" })
    expect((await reservationRef(r.usageLogId).get()).get("decisionSeed.decisions.mask.policyVersion")).toBe("f34.1")
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// FA-F34-R1-010 (R24): the auditor's surviving mutants
// ---------------------------------------------------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("FA-F34-R1-010: tests for the auditor's surviving mutants (R24)", () => {
  it("A02: when masking changed the text, the record's hash is the hash of the masked messages, not of the raw body", async () => {
    const firmId = await seedFirm()
    const sent = gatewayStub("ANSWER")
    const body = "Reply to the registrar about CNIC 35202-1234567-1 before the hearing."
    const r = await callP1(req(firmId, { body }), { now: () => T })
    expect(sent[0]![1]!.content).not.toContain("35202")
    const hash = (await decisionOf(r.usageLogId))!.prompt.hash
    expect(hash).toBe(promptHashOf(sent[0]!))
    expect(hash).not.toBe(promptHashOf([sent[0]![0]!, { role: "user", content: body }]))
  })

  it("A08: neither the reservation (with its seed) nor the reconstruction holds any 20-character window of the body", async () => {
    const firmId = await seedFirm()
    gatewayStub("ANSWER")
    const body = "Advise on the plea bargain terms for the quokka marigold holdings dispute."
    p1TestSeam.failCommit = true
    const r = await callP1(req(firmId, { body }), { now: () => T })
    p1TestSeam.failCommit = false
    const reservation = JSON.stringify((await reservationRef(r.usageLogId).get()).data())
    expect(reservation).toContain("decisionSeed")
    await reconcileReservations({ now: afterLease })
    const rebuilt = JSON.stringify(await reconstructP1Decision(db(), { traceId: r.traceId }))
    for (let i = 0; i + 20 <= body.length; i++) {
      const window = body.slice(i, i + 20)
      expect(reservation.includes(window), `reservation holds "${window}"`).toBe(false)
      expect(rebuilt.includes(window), `reconstruction holds "${window}"`).toBe(false)
    }
  })

  it("A14: the reconstruction finds an attempt by trace id with no decision record, through the usage row and then the reservation", async () => {
    const firmId = await seedFirm()
    gatewayStub("ANSWER")
    const r = await callP1(req(firmId), { now: () => T })
    await db().collection("p1_decisions").doc(r.usageLogId).delete()
    const viaUsage = await reconstructP1Decision(db(), { traceId: r.traceId })
    expect(viaUsage!.key).toEqual({ usageLogId: r.usageLogId, traceId: r.traceId })
    expect(viaUsage!.checks).toMatchObject({ decisionPresent: false, usageJoined: true, reservationJoined: true })
    await db().collection("ai_usage_logs").doc(r.usageLogId).delete()
    const viaReservation = await reconstructP1Decision(db(), { traceId: r.traceId })
    expect(viaReservation!.key).toEqual({ usageLogId: r.usageLogId, traceId: r.traceId })
    expect(viaReservation!.checks).toMatchObject({ decisionPresent: false, usageJoined: false, reservationJoined: true })
  })

  it("A15: a blocked call's reconstruction carries exactly its blocked event", async () => {
    const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG, killSwitch: KILL })
    gatewayStub("UNUSED")
    const r = await callP1(req(firmId), { now: () => T })
    expect(r.outcome).toBe("blocked")
    expect((await reconstructP1Decision(db(), { traceId: r.traceId }))!.events).toEqual(["ai.call.blocked"])
  })

  it("A17: the publisher's fields written before the lease reconciler's record survive it", async () => {
    const f = await newFirm("internal")
    gatewayStub("ANSWER WITH TEXT")
    p1TestSeam.failCommit = true
    const out = await ask(f, "Draft the reply to the notice.")
    p1TestSeam.failCommit = false
    expect([out.blocked, out.accounting]).toEqual([false, "pending"])
    const usageLogId = await usageLogIdOf(out)
    expect(await decisionOf(usageLogId)).toMatchObject({ output: { outputId: out.outputId }, approval: { state: "no_approval_path" } })
    // The router's clock runs ahead of T (61 s per read), so the lease is taken well past its end.
    expect((await reconcileReservations({ now: () => afterLease() + 600_000 })).settled).toContain(usageLogId)
    const d = await decisionOf(usageLogId)
    expect(d).toMatchObject({
      settledBy: "reconciler",
      outcome: "reconciled",
      prompt: { templateId: "committee-brain" },
      output: { outputId: out.outputId, collection: "committee_outputs" },
      approval: { state: "no_approval_path", ref: null },
    })
    expect(d!.retrieval).toHaveProperty("verification")
    expect(d!.retrieval).toHaveProperty("context")
    expect(JSON.stringify(d)).not.toContain(SYSTEM_POLICIES["committee-brain"].text.slice(0, 40))
  })
})
