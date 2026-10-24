import { generateKeyPairSync, sign } from "node:crypto"
import type { Response } from "express"
import type { Request } from "firebase-functions/v2/https"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { firmConfigRef, monthRef, platformConfigRef, reservationRef } from "../src/p1/config"
import { EMBEDDING_OVERHEAD_TOKENS, bodyTokenCeiling, costMicroUsd, estimateTokens } from "../src/p1/costTable"
import { MAX_BODY_BYTES, handleCorpusEmbedding, p1CorpusEmbedding } from "../src/p1/corpusEmbedding"
import { EMBEDDING_ROUTES, P1EmbeddingRequestError, callP1Embedding, p1EmbeddingTestSeam, type P1EmbeddingRequest } from "../src/p1/embedding"
import { P1EmbeddingTransportError, setP1EmbeddingTransportForTests, type P1EmbeddingTransport } from "../src/p1/embeddingTransport"
import { RESERVATION_LEASE_MS } from "../src/p1/gateway"
import { reconcileReservations } from "../src/p1/reconciler"
import { setServiceKeysForTests } from "../src/p1/serviceAuth"
import { deleteFirmData } from "./firmCleanup"
import { EMULATORS, uniq } from "./emu"

/**
 * FA-D3C-002 (spec docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-boundary-design.md, R5-R10, R12) over the
 * Firestore emulator: a corpus embedding goes through P1's controls, on P1's own ledger documents. `callP1Embedding`
 * refuses on the kill switches (also one set between the first read and the reservation), the provider policy, the
 * budget and missing credentials, sending nothing; an allowed call reserves, records its attempt, sends only the masked
 * input, and commits the usage row, the month total, the event and the audit row in one transaction, settling the
 * reservation; a lapsed one is settled by the lease reconciler. The HTTP handler adds the service caller check and the
 * request contract. A fake transport stands in for the Gateway; nothing leaves the machine. Synthetic data only.
 */

const T = Date.parse("2026-10-24T10:00:00.000Z") // PKT month 2026-10
const MONTH = "2026-10"
const at = { now: () => T }
const MODEL = "openai/text-embedding-3-small"
const DIMS = 1536
const CALLER = "corpus-embedder@corpus-project.iam.gserviceaccount.com"
const OP = "a".repeat(64)
const CNIC_TEXT = "Section 4 F27-ROW-001. Contact the registrar, CNIC 35202-1234567-1, for certified copies."
const vector = (n = DIMS) => Array.from({ length: n }, (_, i) => (i % 7) / 10)
const db = () => adminDb()
const firms: string[] = []

type Sent = { model: string; input: string }
function fakeTransport(reply: (sent: Sent) => Promise<{ embedding: number[]; inputTokens: number | null; model?: string }> = async () => ({ embedding: vector(), inputTokens: 7, model: MODEL })): Sent[] {
  const sent: Sent[] = []
  const t: P1EmbeddingTransport = {
    async embed(r) {
      sent.push({ ...r })
      return reply(r)
    },
  }
  setP1EmbeddingTransportForTests(t)
  return sent
}

async function seedFirm(cfg: Record<string, unknown> | null = { monthlyBudgetMicroUsd: 1_000_000 }): Promise<string> {
  const firmId = uniq("d3cfirm")
  firms.push(firmId)
  if (cfg) await firmConfigRef(firmId).set(cfg)
  return firmId
}

const request = (firmId: string, over: Partial<P1EmbeddingRequest> = {}): P1EmbeddingRequest => ({
  firmId,
  caller: CALLER,
  operationId: OP,
  corpusModel: "text-embedding-3-small",
  dimensions: DIMS,
  input: CNIC_TEXT,
  classification: "public",
  ...over,
})

async function usageRow(id: string): Promise<Record<string, unknown>> {
  const snap = await db().collection("ai_usage_logs").doc(id).get()
  expect(snap.exists).toBe(true)
  return snap.data()!
}

async function month(firmId: string): Promise<Record<string, unknown>> {
  return (await monthRef(firmId, MONTH).get()).data() ?? {}
}

const maskedOf = (s: string) => s.replace("35202-1234567-1", "[CNIC]")
const worstCaseOf = (masked: string) => costMicroUsd(MODEL, bodyTokenCeiling(masked) + EMBEDDING_OVERHEAD_TOKENS, 0)!

afterEach(async () => {
  vi.unstubAllEnvs()
  setP1EmbeddingTransportForTests(null)
  setServiceKeysForTests(null)
  setProviderConfigForTests(null)
  for (const k of Object.keys(p1EmbeddingTestSeam)) delete (p1EmbeddingTestSeam as Record<string, unknown>)[k]
  if (EMULATORS) await platformConfigRef().delete()
})

afterAll(async () => {
  if (EMULATORS) await deleteFirmData(firms)
}, 120_000)

describe.skipIf(!EMULATORS)("FA-D3C-002 callP1Embedding: an allowed call", () => {
  it("reserves, sends only the masked input, and commits the usage row, month total, event and audit row, settling the reservation", async () => {
    const firmId = await seedFirm()
    const sent = fakeTransport()
    const r = await callP1Embedding(request(firmId), at)

    expect(r).toMatchObject({ outcome: "ok", blockReason: null, dimensions: DIMS, model: MODEL, modelReported: MODEL, inputTokens: 7, tokensEstimated: false, costMicroUsd: 1, accounting: "settled" })
    expect(r.embedding).toHaveLength(DIMS)
    expect(r.redactionCounts).toEqual({ cnic: 1 })
    // Only the masked input left (R8).
    expect(sent).toEqual([{ model: MODEL, input: maskedOf(CNIC_TEXT) }])
    expect(JSON.stringify(sent)).not.toContain("35202")

    const row = await usageRow(r.usageLogId)
    expect(row).toMatchObject({
      firmId, actorId: "system", matterId: null, jobId: null, taskType: "embedding", provider: "ai-gateway", model: MODEL, modelReported: MODEL,
      classification: "public", outcome: "ok", blockReason: null, inputTokens: 7, outputTokens: 0, tokensEstimated: false, costMicroUsd: 1,
      monthKey: MONTH, caller: CALLER, corpusOperationId: OP,
    })
    expect(JSON.stringify(row)).not.toContain("Section 4")

    expect(await month(firmId)).toMatchObject({ spentMicroUsd: 1, reservedMicroUsd: 0, inputTokens: 7, outputTokens: 0, calls: { ok: 1, failed: 0, blocked: 0 } })

    const res = (await reservationRef(r.usageLogId).get()).data()!
    const masked = maskedOf(CNIC_TEXT)
    expect(res).toMatchObject({
      firmId, taskType: "embedding", model: MODEL, state: "settled", actualMicroUsd: 1, settledBy: "gateway",
      reservedBodyTokens: bodyTokenCeiling(masked), reservedOverheadTokens: EMBEDDING_OVERHEAD_TOKENS,
      reservedInputTokens: bodyTokenCeiling(masked) + EMBEDDING_OVERHEAD_TOKENS, reservedOutputTokens: 0, reservedMicroUsd: worstCaseOf(masked),
      providerAttempt: { outcome: "returned", result: "ok", inputTokens: 7, outputTokens: 0, costMicroUsd: 1 },
    })

    const event = (await db().collection("events").doc(`${r.usageLogId}_completed`).get()).data()!
    expect(event).toMatchObject({ name: "ai.call.completed", firmId, payload: { traceId: r.traceId, task: "embedding", model: MODEL, classification: "public", costMicroUsd: 1 } })
    const audit = await db().collection("audit_log").where("target", "==", `ai_usage_logs/${r.usageLogId}`).get()
    expect(audit.docs.map((d) => d.data())).toEqual([expect.objectContaining({ firmId, actorId: "system", action: "ai.gateway.decision", decision: "allow", reason: "ok" })])
  })

  it("estimates the input from the masked text when the provider reports no usage", async () => {
    const firmId = await seedFirm()
    fakeTransport(async () => ({ embedding: vector(), inputTokens: null }))
    const r = await callP1Embedding(request(firmId), at)
    const est = estimateTokens(maskedOf(CNIC_TEXT))
    expect(r).toMatchObject({ outcome: "ok", inputTokens: est, tokensEstimated: true, costMicroUsd: costMicroUsd(MODEL, est, 0) })
  })
})

describe.skipIf(!EMULATORS)("FA-D3C-002 callP1Embedding: refusals send nothing and are logged", () => {
  async function blocked(firmId: string, reason: string, req: Partial<P1EmbeddingRequest> = {}) {
    const sent = fakeTransport()
    const r = await callP1Embedding(request(firmId, req), at)
    expect(r).toMatchObject({ outcome: "blocked", blockReason: reason, costMicroUsd: 0, inputTokens: 0, accounting: "settled" })
    expect(r).not.toHaveProperty("embedding")
    expect(sent).toEqual([])
    expect(await usageRow(r.usageLogId)).toMatchObject({ outcome: "blocked", blockReason: reason, taskType: "embedding", costMicroUsd: 0 })
    expect((await month(firmId)).calls).toMatchObject({ blocked: 1, ok: 0 })
    const ev = (await db().collection("events").doc(`${r.usageLogId}_blocked`).get()).data()!
    expect(ev).toMatchObject({ name: "ai.call.blocked", payload: { blockReason: reason, task: "embedding" } })
    return r
  }

  it("kill_switch_platform: the operator's switch blocks every model", async () => {
    const firmId = await seedFirm()
    await platformConfigRef().set({ killSwitch: { disableAll: true, disabledModels: [], reason: "drill", setBy: "platform", setAt: T } })
    const r = await blocked(firmId, "kill_switch_platform")
    expect((await reservationRef(r.usageLogId).get()).exists).toBe(false)
  })

  it("kill_switch_firm: the firm's switch names the embedding model; a switch naming another model does not block", async () => {
    const firmId = await seedFirm({ monthlyBudgetMicroUsd: 1_000_000, killSwitch: { disableAll: false, disabledModels: [MODEL], reason: "pause corpus", setBy: "u", setAt: T } })
    await blocked(firmId, "kill_switch_firm")
    const other = await seedFirm({ monthlyBudgetMicroUsd: 1_000_000, killSwitch: { disableAll: false, disabledModels: ["anthropic/claude-opus-5.5"], reason: "x", setBy: "u", setAt: T } })
    fakeTransport()
    expect((await callP1Embedding(request(other), at)).outcome).toBe("ok")
  })

  it("a switch set after the first read still stops the call at the reservation (re-read in its transaction)", async () => {
    const firmId = await seedFirm()
    p1EmbeddingTestSeam.beforeReserve = async () => {
      await platformConfigRef().set({ killSwitch: { disableAll: true, disabledModels: [], reason: "late", setBy: "platform", setAt: T } })
    }
    const r = await blocked(firmId, "kill_switch_platform")
    expect((await month(firmId)).reservedMicroUsd ?? 0).toBe(0)
    expect((await reservationRef(r.usageLogId).get()).exists).toBe(false)
  })

  it("policy_denied: a confidential input may not go to a provider without an executed DPA", async () => {
    await blocked(await seedFirm(), "policy_denied", { classification: "confidential" })
  })

  it("not_minimised: at rank 3 an address left in the masked input blocks the call", async () => {
    setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: false } })
    await blocked(await seedFirm(), "not_minimised", { classification: "privileged", input: "The petitioner, r/o Punjab Colony, Lahore, filed the appeal." })
  })

  it("budget_not_set: a firm with no budget", async () => {
    await blocked(await seedFirm(null), "budget_not_set")
  })

  it("budget_exhausted: the worst case does not fit beside spent and held", async () => {
    const masked = maskedOf(CNIC_TEXT)
    const firmId = await seedFirm({ monthlyBudgetMicroUsd: worstCaseOf(masked) + 5 })
    await monthRef(firmId, MONTH).set({ firmId, monthKey: MONTH, spentMicroUsd: 6, reservedMicroUsd: 0 })
    await blocked(firmId, "budget_exhausted")
    // At the edge it fits.
    const edge = await seedFirm({ monthlyBudgetMicroUsd: worstCaseOf(masked) + 6 })
    await monthRef(edge, MONTH).set({ firmId: edge, monthKey: MONTH, spentMicroUsd: 6, reservedMicroUsd: 0 })
    fakeTransport()
    expect((await callP1Embedding(request(edge), at)).outcome).toBe("ok")
  })

  it("no_credentials: no transport is configured", async () => {
    const firmId = await seedFirm()
    setP1EmbeddingTransportForTests(null)
    vi.stubEnv("AI_GATEWAY_API_KEY", "")
    const r = await callP1Embedding(request(firmId), at)
    expect(r).toMatchObject({ outcome: "blocked", blockReason: "no_credentials", costMicroUsd: 0 })
  })

  it("throws before any read or write on a missing classification, an unknown model, the wrong size or an empty input", async () => {
    const firmId = await seedFirm()
    const sent = fakeTransport()
    await expect(callP1Embedding(request(firmId, { classification: undefined as never }), at)).rejects.toThrow(/classification/)
    for (const [over, code] of [
      [{ corpusModel: "text-embedding-3-large" }, "unsupported_model"],
      [{ corpusModel: "constructor" }, "unsupported_model"],
      [{ dimensions: 3072 }, "unsupported_dimensions"],
      [{ input: "" }, "invalid_input"],
      [{ input: "x".repeat(8001) }, "invalid_input"],
    ] as const) {
      const err = await callP1Embedding(request(firmId, over), at).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(P1EmbeddingRequestError)
      expect((err as P1EmbeddingRequestError).code).toBe(code)
    }
    expect(sent).toEqual([])
    expect((await db().collection("ai_usage_logs").where("firmId", "==", firmId).get()).size).toBe(0)
  })
})

describe.skipIf(!EMULATORS)("FA-D3C-002 callP1Embedding: provider failures are charged by the billing rule", () => {
  it("a timeout may have been billed: charged at the estimated input, the reservation settled", async () => {
    const firmId = await seedFirm()
    fakeTransport(async () => {
      throw new P1EmbeddingTransportError("gateway_timeout", { billable: true })
    })
    const r = await callP1Embedding(request(firmId), at)
    const est = estimateTokens(maskedOf(CNIC_TEXT))
    expect(r).toMatchObject({ outcome: "failed", blockReason: null, inputTokens: est, tokensEstimated: true, costMicroUsd: costMicroUsd(MODEL, est, 0) })
    expect(r).not.toHaveProperty("embedding")
    expect((await reservationRef(r.usageLogId).get()).data()).toMatchObject({ state: "settled", actualMicroUsd: r.costMicroUsd })
    expect(await month(firmId)).toMatchObject({ spentMicroUsd: r.costMicroUsd, reservedMicroUsd: 0, calls: { failed: 1 } })
  })

  it("a non-2xx cannot have been billed: charged 0, the reservation released", async () => {
    const firmId = await seedFirm()
    fakeTransport(async () => {
      throw new P1EmbeddingTransportError("gateway_status", { billable: false, status: 503 })
    })
    const r = await callP1Embedding(request(firmId), at)
    expect(r).toMatchObject({ outcome: "failed", inputTokens: 0, costMicroUsd: 0 })
    expect((await reservationRef(r.usageLogId).get()).data()).toMatchObject({ state: "released", actualMicroUsd: 0 })
  })

  it("an error that is not a transport error is charged 0 and its text goes nowhere", async () => {
    const firmId = await seedFirm()
    fakeTransport(async () => {
      throw new Error("raw provider text that must never surface")
    })
    const r = await callP1Embedding(request(firmId), at)
    expect(r).toMatchObject({ outcome: "failed", costMicroUsd: 0 })
    expect(JSON.stringify(r)).not.toContain("raw provider text")
    expect(JSON.stringify(await usageRow(r.usageLogId))).not.toContain("raw provider text")
  })

  it("a vector of the wrong size was answered and billed, and is never returned", async () => {
    const firmId = await seedFirm()
    fakeTransport(async () => ({ embedding: vector(DIMS - 1), inputTokens: 7 }))
    const r = await callP1Embedding(request(firmId), at)
    expect(r).toMatchObject({ outcome: "failed", inputTokens: 7, costMicroUsd: 1 })
    expect(r).not.toHaveProperty("embedding")
    fakeTransport(async () => ({ embedding: [...vector(DIMS - 1), Number.NaN], inputTokens: 7 }))
    expect((await callP1Embedding(request(firmId), at)).outcome).toBe("failed")
  })
})

describe.skipIf(!EMULATORS)("FA-D3C-002: a lapsed embedding reservation is settled by the lease reconciler", () => {
  it("a call that died after dispatch is charged its hold, with no output tokens, under the reconciled outcome", async () => {
    const firmId = await seedFirm()
    fakeTransport()
    p1EmbeddingTestSeam.crashAt = "dispatched"
    await expect(callP1Embedding(request(firmId), at)).rejects.toThrow(/crashAt/)
    const open = await db().collection("ai_reservations").where("firmId", "==", firmId).get()
    expect(open.size).toBe(1)
    const res = open.docs[0]!
    expect(res.data()).toMatchObject({ state: "reserved", taskType: "embedding", reservedOutputTokens: 0, providerAttempt: { outcome: "pending" } })
    const held = res.get("reservedMicroUsd") as number

    const done = await reconcileReservations({ now: () => T + RESERVATION_LEASE_MS + 1_000 })
    expect(done.settled).toContain(res.id)
    expect((await res.ref.get()).data()).toMatchObject({ state: "settled", actualMicroUsd: held, settledBy: "reconciler" })
    expect(await usageRow(res.id)).toMatchObject({ outcome: "reconciled", taskType: "embedding", outputTokens: 0, costMicroUsd: held, reconciledFrom: "worst_case" })
    expect(await month(firmId)).toMatchObject({ spentMicroUsd: held, reservedMicroUsd: 0 })
  })
})

// ---------------------------------------------------------------------------------------------
// The HTTP handler
// ---------------------------------------------------------------------------------------------
const AUDIENCE = "https://p1corpusembedding-abc123-el.a.run.app"
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const KID = "fa-d3c-emu-key"
const JWKS = { keys: [{ ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID, alg: "RS256", use: "sig" }] }
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
function idToken(over: Record<string, unknown> = {}): string {
  // The handler's clock is `at` (T), so the token is issued against it.
  const now = Math.floor(T / 1000)
  const input = `${b64({ alg: "RS256", kid: KID, typ: "JWT" })}.${b64({ iss: "https://accounts.google.com", aud: AUDIENCE, sub: "1234567890", email: CALLER, email_verified: true, iat: now - 10, exp: now + 3000, ...over })}`
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`
}

type Captured = { status: number; headers: Record<string, string>; body: Record<string, unknown> }
function fakeRes(): { res: Response; out: Captured } {
  const out: Captured = { status: 0, headers: {}, body: {} }
  const res = {
    status(code: number) {
      out.status = code
      return res
    },
    set(k: string, v: string) {
      out.headers[k.toLowerCase()] = v
      return res
    },
    json(body: Record<string, unknown>) {
      out.body = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
      return res
    },
  }
  return { res: res as unknown as Response, out }
}

function httpReq(over: { method?: string; headers?: Record<string, string>; body?: unknown; raw?: Buffer } = {}): Request {
  const raw = over.raw ?? Buffer.from(JSON.stringify(over.body ?? { operationId: OP, model: "text-embedding-3-small", dimensions: DIMS, input: CNIC_TEXT, classification: "public" }))
  return {
    method: over.method ?? "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken()}`, "content-length": String(raw.length), ...over.headers },
    rawBody: raw,
  } as unknown as Request
}

async function call(req: Request): Promise<Captured> {
  const { res, out } = fakeRes()
  await handleCorpusEmbedding(req, res, at)
  expect(out.headers["cache-control"]).toBe("no-store")
  return out
}

describe.skipIf(!EMULATORS)("FA-D3C-002 p1CorpusEmbedding: the HTTP contract", () => {
  let firmId: string
  beforeEach(async () => {
    firmId = await seedFirm()
    vi.stubEnv("P1_CORPUS_FIRM_ID", firmId)
    vi.stubEnv("P1_CORPUS_AUDIENCE", AUDIENCE)
    vi.stubEnv("P1_CORPUS_CALLERS", ` ${CALLER.toUpperCase()} ,other@corpus-project.iam.gserviceaccount.com`)
    setServiceKeysForTests(JWKS)
  })

  it("is deployed IAM-private, ALLOW_ALL ingress, 90 s, at most 2 instances, as the runtime account", () => {
    const ep = (p1CorpusEmbedding as unknown as { __endpoint: Record<string, unknown> }).__endpoint
    expect(ep).toMatchObject({ region: ["asia-south1"], timeoutSeconds: 90, maxInstances: 2, ingressSettings: "ALLOW_ALL", httpsTrigger: { invoker: ["private"] } })
  })

  it("200 ok: the vector and the ledger ids, the firm from the deployment and the caller from the verified token", async () => {
    fakeTransport()
    const out = await call(httpReq())
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ outcome: "ok", blockReason: null, dimensions: DIMS, model: MODEL, costMicroUsd: 1, accounting: "settled" })
    expect(out.body.embedding).toHaveLength(DIMS)
    expect(await usageRow(out.body.usageLogId as string)).toMatchObject({ firmId, caller: CALLER, corpusOperationId: OP, taskType: "embedding" })
  })

  it("200 blocked: a P1 refusal is a decision, answered with its reason and no vector", async () => {
    await platformConfigRef().set({ killSwitch: { disableAll: true, disabledModels: [], reason: "drill", setBy: "platform", setAt: T } })
    const sent = fakeTransport()
    const out = await call(httpReq())
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ outcome: "blocked", blockReason: "kill_switch_platform", costMicroUsd: 0 })
    expect(out.body).not.toHaveProperty("embedding")
    expect(sent).toEqual([])
  })

  it("200 failed: a provider failure carries no provider text", async () => {
    fakeTransport(async () => {
      throw new Error("raw provider text that must never surface")
    })
    const out = await call(httpReq())
    expect(out.status).toBe(200)
    expect(out.body.outcome).toBe("failed")
    expect(JSON.stringify(out.body)).not.toContain("raw provider text")
  })

  it.each([
    ["GET", { method: "GET" }, 405, "method_not_allowed"],
    ["text/plain", { headers: { "content-type": "text/plain" } }, 415, "unsupported_media_type"],
    ["no content type", { headers: { "content-type": "" } }, 415, "unsupported_media_type"],
    ["a declared body over the bound", { headers: { "content-length": String(MAX_BODY_BYTES + 1) } }, 413, "body_too_large"],
    ["a raw body over the bound", { raw: Buffer.alloc(MAX_BODY_BYTES + 1, 0x20) }, 413, "body_too_large"],
    ["no token", { headers: { authorization: "" } }, 401, "missing_token"],
    ["a token for another audience", { headers: { authorization: `Bearer ${idToken({ aud: "https://elsewhere.example" })}` } }, 401, "wrong_audience"],
    ["a token for another identity", { headers: { authorization: `Bearer ${idToken({ email: "intruder@corpus-project.iam.gserviceaccount.com" })}` } }, 403, "caller_not_allowed"],
    ["an extra key", { body: { operationId: OP, model: "text-embedding-3-small", dimensions: DIMS, input: "x", classification: "public", firmId: "other" } }, 400, "invalid_request"],
    ["a missing key", { body: { operationId: OP, model: "text-embedding-3-small", dimensions: DIMS, input: "x" } }, 400, "invalid_request"],
    ["a bad operation id", { body: { operationId: "A".repeat(64), model: "text-embedding-3-small", dimensions: DIMS, input: "x", classification: "public" } }, 400, "invalid_request"],
    ["an unknown classification", { body: { operationId: OP, model: "text-embedding-3-small", dimensions: DIMS, input: "x", classification: "secret" } }, 400, "invalid_request"],
    ["an input over the bound", { body: { operationId: OP, model: "text-embedding-3-small", dimensions: DIMS, input: "x".repeat(8001), classification: "public" } }, 400, "invalid_request"],
    ["a body that is not JSON", { raw: Buffer.from("{nope") }, 400, "invalid_request"],
    ["an unknown model", { body: { operationId: OP, model: "text-embedding-3-large", dimensions: DIMS, input: "x", classification: "public" } }, 400, "unsupported_model"],
  ])("%s", async (_name, over, status, error) => {
    const sent = fakeTransport()
    const out = await call(httpReq(over as Parameters<typeof httpReq>[0]))
    expect([out.status, out.body]).toEqual([status, { error }])
    expect(sent).toEqual([])
  })

  it("503 not_configured when the firm, audience or caller list is missing or malformed, and nothing is read or sent", async () => {
    for (const [name, value] of [
      ["P1_CORPUS_FIRM_ID", ""],
      ["P1_CORPUS_FIRM_ID", "bad/firm"],
      ["P1_CORPUS_AUDIENCE", ""],
      ["P1_CORPUS_AUDIENCE", "http://p1.example"],
      ["P1_CORPUS_CALLERS", ""],
      ["P1_CORPUS_CALLERS", "not-an-email"],
    ] as const) {
      vi.stubEnv("P1_CORPUS_FIRM_ID", firmId)
      vi.stubEnv("P1_CORPUS_AUDIENCE", AUDIENCE)
      vi.stubEnv("P1_CORPUS_CALLERS", CALLER)
      vi.stubEnv(name, value)
      const sent = fakeTransport()
      const out = await call(httpReq())
      expect([name, value, out.status, out.body]).toEqual([name, value, 503, { error: "not_configured" }])
      expect(sent).toEqual([])
    }
  })

  it("the routes are exactly the corpus model at the corpus vector size", () => {
    expect(EMBEDDING_ROUTES).toEqual({ "text-embedding-3-small": { model: MODEL, dimensions: DIMS } })
    expect(Object.isFrozen(EMBEDDING_ROUTES)).toBe(true)
  })
})
