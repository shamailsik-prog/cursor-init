import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { THRESHOLDS, alertRef, firmConfigRef, monthRef, platformConfigRef } from "../src/p1/config"
import { MAX_OUTPUT_TOKENS, costMicroUsd, estimateTokens } from "../src/p1/costTable"
import { FUNCTION_TIMEOUT_SECONDS } from "../src/health"
import { COMMIT_ATTEMPT_SLACK_MS, COMMIT_BACKOFF_CAP_MS, COMMIT_DEADLINE_MS, callP1, p1TestSeam, type P1Request, type P1Result } from "../src/p1/gateway"
import { OPIK_TIMEOUT_MS, setOpikFetchForTests } from "../src/p1/opik"
import { P1TransportError, TRANSPORT_TIMEOUT_MS, gatewayTransport, setP1TransportForTests, type P1Transport } from "../src/p1/transport"
import { EMULATORS, uniq } from "./emu"

/**
 * Phase 3d Task 2 (spec P3-61, P3-63..P3-66, P3-69): `callP1` over the Firestore emulator, with a fake
 * Gateway transport and a fake Opik fetch. Each test uses its own firm; `platform/p1` is shared and is
 * deleted after every test.
 */

const OPUS = "anthropic/claude-opus-5.5"
const T = Date.parse("2026-10-11T10:00:00.000Z") // PKT month 2026-10
const MONTH = "2026-10"
const at = { now: () => T }
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const BIG_BUDGET = 1_000_000_000

// The Phase 4b fixtures (P4B-21).
const PERSON = "Ardeshir Testani"
const CNIC = "99999-9999999-9"
const LAND = "Plot 99-T, Block Z, Test Housing Scheme, measuring 999 square yards"

/** The P3-63 usage row fields, exactly. */
const ROW_FIELDS = [
  "firmId",
  "actorId",
  "matterId",
  "jobId",
  "taskType",
  "provider",
  "model",
  "classification",
  "outcome",
  "blockReason",
  "inputTokens",
  "outputTokens",
  "tokensEstimated",
  "costMicroUsd",
  "fxPkrPerUsd",
  "costPkr",
  "monthKey",
  "trace",
  "createdAt",
]

const db = () => adminDb()

type Reply = { text?: unknown; inputTokens?: number | null; outputTokens?: number | null; finishReason?: string | null }
type Sent = { model: string; body: string; maxTokens: number }

/** Installs a fake transport that records what it was sent; the default reply costs 14000 micro-USD (1000 in, 500 out). */
function fakeTransport(reply: Reply | (() => Promise<never>) = {}): Sent[] {
  const sent: Sent[] = []
  const t: P1Transport = {
    async send(r) {
      sent.push({ ...r })
      if (typeof reply === "function") return reply()
      return {
        text: (reply.text === undefined ? "REPLY" : reply.text) as string,
        inputTokens: reply.inputTokens === undefined ? 1000 : reply.inputTokens,
        outputTokens: reply.outputTokens === undefined ? 500 : reply.outputTokens,
        finishReason: reply.finishReason, // as given, absent included
      }
    },
  }
  setP1TransportForTests(t)
  return sent
}

/** A transport whose call costs exactly `micro` micro-USD (output tokens only: 20 micro-USD each). */
function costing(micro: number): Sent[] {
  if (micro % 20 !== 0) throw new Error("cost must be a multiple of 20")
  return fakeTransport({ inputTokens: 0, outputTokens: micro / 20 })
}

async function seedFirm(cfg: Record<string, unknown> | null = { monthlyBudgetMicroUsd: BIG_BUDGET }): Promise<string> {
  const firmId = uniq("firm")
  if (cfg) await firmConfigRef(firmId).set(cfg)
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

const killSwitch = (over: Record<string, unknown>) => ({ disableAll: false, disabledModels: [], reason: "test", setBy: "uid-admin", setAt: Timestamp.fromMillis(T), ...over })

const docs = async (collection: string, firmId: string): Promise<{ id: string; data: DocumentData }[]> =>
  (await db().collection(collection).where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, data: d.data() }))
const rowsOf = (firmId: string) => docs("ai_usage_logs", firmId)
const eventsOf = async (firmId: string, name?: string) => (await docs("events", firmId)).filter((e) => name === undefined || e.data.name === name)
const auditsOf = async (firmId: string, action?: string) => (await docs("audit_log", firmId)).filter((a) => action === undefined || a.data.action === action)
const alertsOf = (firmId: string) => docs("ai_budget_alerts", firmId)
const rowOf = async (id: string) => (await db().collection("ai_usage_logs").doc(id).get()).data()
const monthOf = async (firmId: string, mk = MONTH) => (await monthRef(firmId, mk).get()).data()

/** Every call made to any logger method, as JSON, for the "no raw text in a log line" checks. */
function spyLogs(): { all: () => string; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> } {
  const spies = (["debug", "info", "log", "warn", "error", "write"] as const).map((m) => [m, vi.spyOn(logger, m).mockImplementation(() => undefined)] as const)
  const by = Object.fromEntries(spies)
  return { all: () => JSON.stringify(spies.map(([m, s]) => [m, s.mock.calls])), warn: by.warn, error: by.error }
}

/** Enables Opik (self-hosted, confirmed) with a fake fetch that captures each posted body; `status` is its answer. */
function fakeOpik(status = 204): { bodies: string[] } {
  // A plain-http base must be loopback, a private IPv4 literal, or end in .internal or .local (M4).
  vi.stubEnv("OPIK_BASE_URL", "http://opik.test.internal")
  vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", "true")
  const bodies: string[] = []
  setOpikFetchForTests((async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body))
    return new Response(null, { status })
  }) as typeof fetch)
  return { bodies }
}
const traceOf = (bodies: string[]) => (JSON.parse(bodies[0]!) as { traces: Record<string, unknown>[] }).traces[0]!

function resetSeam() {
  for (const k of Object.keys(p1TestSeam)) delete (p1TestSeam as Record<string, unknown>)[k]
}

describe("P1 config refs (P3-64..P3-66)", () => {
  it("names the collections and docs of the plan", () => {
    expect(THRESHOLDS).toEqual([70, 90])
    expect(firmConfigRef("f1").path).toBe("ai_config/f1")
    expect(platformConfigRef().path).toBe("platform/p1")
    expect(monthRef("f1", "2026-10").path).toBe("ai_usage_months/f1_2026-10")
    expect(alertRef("f1", "2026-10", 70).path).toBe("ai_budget_alerts/f1_2026-10_70")
    expect(alertRef("f1", "2026-10", 90).path).toBe("ai_budget_alerts/f1_2026-10_90")
  })
})

describe.skipIf(!EMULATORS)("callP1 (P3-61, P3-63..P3-66, P3-69)", () => {
  beforeEach(() => {
    // No Opik, no Gateway key and the seeded (empty) provider table unless a test sets them.
    vi.stubEnv("OPIK_BASE_URL", undefined)
    vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", undefined)
    vi.stubEnv("OPIK_PROJECT_NAME", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    setProviderConfigForTests(null)
    resetSeam()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    setProviderConfigForTests(null)
    resetSeam()
    await platformConfigRef().delete()
  })

  describe("happy path", () => {
    it("is ok with masked text, a full P3-63 row, the month total, one completed event and one allow audit row; trace disabled", async () => {
      const firmId = await seedFirm()
      const sent = fakeTransport({ text: "Reply for Ali Raza", inputTokens: 1000, outputTokens: 500 })
      const r = await callP1(req(firmId, { partyNames: ["Ali Raza"] }), at)

      expect(r).toMatchObject({ outcome: "ok", blockReason: null, text: "Reply for [PARTY]", model: OPUS, classification: "internal", inputTokens: 1000, outputTokens: 500, costMicroUsd: 14000 })
      expect(r.traceId).toMatch(UUID_V7)
      expect(sent).toEqual([{ model: OPUS, body: "Draft a reply to the notice.", maxTokens: 4096 }])

      const row = (await rowOf(r.usageLogId))!
      expect(Object.keys(row).sort()).toEqual([...ROW_FIELDS].sort())
      expect(row).toMatchObject({
        firmId,
        actorId: "uid-1",
        matterId: "matter-1",
        jobId: null,
        taskType: "committee",
        provider: "ai-gateway",
        model: OPUS,
        classification: "internal",
        outcome: "ok",
        blockReason: null,
        inputTokens: 1000,
        outputTokens: 500,
        tokensEstimated: false,
        costMicroUsd: costMicroUsd(OPUS, 1000, 500),
        fxPkrPerUsd: null,
        costPkr: null,
        monthKey: MONTH,
        trace: { id: r.traceId, status: "disabled" },
      })
      expect(row.createdAt).toBeInstanceOf(Timestamp)

      const month = (await monthOf(firmId))!
      expect(month).toMatchObject({ firmId, monthKey: MONTH, spentMicroUsd: 14000, inputTokens: 1000, outputTokens: 500, calls: { ok: 1, failed: 0, blocked: 0 } })
      expect(month.updatedAt).toBeInstanceOf(Timestamp)

      const events = await eventsOf(firmId)
      expect(events).toHaveLength(1)
      expect(events[0]!.id).toBe(`${r.usageLogId}_completed`)
      expect(events[0]!.data).toMatchObject({ name: "ai.call.completed", firmId, classification: "internal", idempotencyKey: `${r.usageLogId}:completed` })
      expect(events[0]!.data.payload).toEqual({ traceId: r.traceId, task: "committee", model: OPUS, classification: "internal", costMicroUsd: 14000 })
      expect(events[0]!.data.occurredAt).toBeInstanceOf(Timestamp)

      const audits = await auditsOf(firmId)
      expect(audits).toHaveLength(1)
      expect(audits[0]!.data).toMatchObject({
        firmId,
        actorId: "uid-1",
        action: "ai.gateway.decision",
        target: `ai_usage_logs/${r.usageLogId}`,
        classification: "internal",
        decision: "allow",
        reason: "ok",
      })
      expect(audits[0]!.data).not.toHaveProperty("onBehalfOf")
    })

    it("takes monthKey from the injected clock in PKT: 19:00Z on 31 October is November", async () => {
      const firmId = await seedFirm()
      fakeTransport()
      const late = await callP1(req(firmId), { now: () => Date.parse("2026-10-31T19:00:00.000Z") })
      const early = await callP1(req(firmId), { now: () => Date.parse("2026-10-31T18:59:59.000Z") })
      expect((await rowOf(late.usageLogId))!.monthKey).toBe("2026-11")
      expect((await rowOf(early.usageLogId))!.monthKey).toBe("2026-10")
      expect((await monthOf(firmId, "2026-11"))!.calls).toEqual({ ok: 1, failed: 0, blocked: 0 })
      expect((await monthOf(firmId, "2026-10"))!.calls).toEqual({ ok: 1, failed: 0, blocked: 0 })
    })

    it("records a system actor as given", async () => {
      const firmId = await seedFirm()
      fakeTransport()
      const r = await callP1(req(firmId, { actorId: "system", matterId: null, jobId: "job-1" }), at)
      expect(await rowOf(r.usageLogId)).toMatchObject({ actorId: "system", matterId: null, jobId: "job-1" })
      expect((await auditsOf(firmId))[0]!.data.actorId).toBe("system")
    })
  })

  describe("masking (Review Focus 1)", () => {
    const RAW = ["Ali Raza", "35202-1234567-1", "0300-1234567"]
    const containsRaw = (s: string) => RAW.some((raw) => s.toLowerCase().includes(raw.toLowerCase()))

    it("no party name, CNIC or mobile reaches the transport, the row, the event, the audit row, the trace, a log line or the result", async () => {
      const firmId = await seedFirm()
      const logs = spyLogs()
      const opik = fakeOpik()
      const sent = fakeTransport({ text: "ali raza should apply; call 0300-1234567." })
      const r = await callP1(
        req(firmId, {
          body: "Client Ali Raza, CNIC 35202-1234567-1, mobile 0300-1234567, asks about bail.",
          purpose: "committee-brain for Ali Raza",
          partyNames: ["Ali Raza"],
        }),
        at,
      )

      expect(r.outcome).toBe("ok")
      expect(sent).toHaveLength(1)
      expect(sent[0]!.body).toBe("Client [PARTY], CNIC [CNIC], mobile [PHONE], asks about bail.")
      expect(r.text).toBe("[PARTY] should apply; call [PHONE].")
      expect(r.outbound).toEqual({
        body: "Client [PARTY], CNIC [CNIC], mobile [PHONE], asks about bail.",
        purpose: "committee-brain for [PARTY]",
        redactionCounts: { cnic: 1, phone: 1, party: 1, email: 0, iban: 0, ntn: 0, passport: 0 },
      })

      const row = await rowOf(r.usageLogId)
      expect((row as DocumentData).trace.status).toBe("exported")
      expect(opik.bodies).toHaveLength(1)
      const trace = traceOf(opik.bodies)
      expect(trace.input).toEqual({ prompt: "Client [PARTY], CNIC [CNIC], mobile [PHONE], asks about bail." })
      expect(trace.output).toEqual({ text: "[PARTY] should apply; call [PHONE]." })

      for (const seen of [JSON.stringify(sent), JSON.stringify(row), JSON.stringify(await eventsOf(firmId)), JSON.stringify(await auditsOf(firmId)), opik.bodies.join(""), logs.all(), JSON.stringify(r)]) {
        expect(containsRaw(seen)).toBe(false)
      }
    })
  })

  describe("refusals (P3-61 steps 2 to 8)", () => {
    type Case = { name: string; reason: string; classification?: P1Request["classification"]; spent?: number; setup: () => Promise<string> }
    const cases: Case[] = [
      {
        name: "the platform switch with disableAll (the firm's own switch off)",
        reason: "kill_switch_platform",
        setup: async () => {
          await platformConfigRef().set({ killSwitch: killSwitch({ disableAll: true }) })
          return seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET, killSwitch: killSwitch({}) })
        },
      },
      {
        name: "the platform switch naming the routed model",
        reason: "kill_switch_platform",
        setup: async () => {
          await platformConfigRef().set({ killSwitch: killSwitch({ disabledModels: [OPUS] }) })
          return seedFirm()
        },
      },
      {
        name: "the firm switch with disableAll",
        reason: "kill_switch_firm",
        setup: () => seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET, killSwitch: killSwitch({ disableAll: true }) }),
      },
      {
        name: "the firm switch naming the routed model",
        reason: "kill_switch_firm",
        setup: () => seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET, killSwitch: killSwitch({ disabledModels: ["openai/gpt-5", OPUS] }) }),
      },
      { name: "confidential with no DPA", reason: "policy_denied", classification: "confidential", setup: () => seedFirm() },
      {
        name: "a model with no price",
        reason: "model_unpriced",
        setup: async () => {
          p1TestSeam.modelOverride = "x/unpriced-model"
          return seedFirm()
        },
      },
      { name: "no ai_config at all", reason: "budget_not_set", setup: () => seedFirm(null) },
      { name: "an ai_config with no budget", reason: "budget_not_set", setup: () => seedFirm({ pkrPerUsd: 280 }) },
      { name: "a zero budget", reason: "budget_not_set", setup: () => seedFirm({ monthlyBudgetMicroUsd: 0 }) },
      { name: "a negative budget", reason: "budget_not_set", setup: () => seedFirm({ monthlyBudgetMicroUsd: -5 }) },
      { name: "a fractional budget", reason: "budget_not_set", setup: () => seedFirm({ monthlyBudgetMicroUsd: 1.5 }) },
      { name: "a string budget", reason: "budget_not_set", setup: () => seedFirm({ monthlyBudgetMicroUsd: "100000" }) },
      {
        name: "spend exactly at the budget",
        reason: "budget_exhausted",
        spent: 100_000,
        setup: async () => {
          const firmId = await seedFirm({ monthlyBudgetMicroUsd: 100_000 })
          await monthRef(firmId, MONTH).set({ firmId, monthKey: MONTH, spentMicroUsd: 100_000 })
          return firmId
        },
      },
      {
        name: "spend over the budget",
        reason: "budget_exhausted",
        spent: 150_000,
        setup: async () => {
          const firmId = await seedFirm({ monthlyBudgetMicroUsd: 100_000 })
          await monthRef(firmId, MONTH).set({ firmId, monthKey: MONTH, spentMicroUsd: 150_000 })
          return firmId
        },
      },
      {
        name: "no transport and no key",
        reason: "no_credentials",
        setup: async () => {
          setP1TransportForTests(null)
          return seedFirm()
        },
      },
    ]

    it.each(cases)("$name → blocked $reason, no provider call, a blocked row, event and deny audit row", async (c) => {
      const sent = c.reason === "no_credentials" ? [] : fakeTransport()
      const firmId = await c.setup()
      const classification = c.classification ?? "internal"
      const r = await callP1(req(firmId, { classification }), at)

      expect(sent).toHaveLength(0)
      expect(r).toMatchObject({ outcome: "blocked", blockReason: c.reason, classification, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 })
      expect(r).not.toHaveProperty("text")
      expect(r.model).toBe(c.reason === "model_unpriced" ? "x/unpriced-model" : OPUS)

      const row = (await rowOf(r.usageLogId))!
      expect(Object.keys(row).sort()).toEqual([...ROW_FIELDS].sort())
      expect(row).toMatchObject({ outcome: "blocked", blockReason: c.reason, inputTokens: 0, outputTokens: 0, tokensEstimated: false, costMicroUsd: 0, classification, trace: { id: r.traceId, status: "disabled" } })

      const events = await eventsOf(firmId)
      expect(events.map((e) => e.data.name)).toEqual(["ai.call.blocked"])
      expect(events[0]!.id).toBe(`${r.usageLogId}_blocked`)
      expect(events[0]!.data.payload).toEqual({ traceId: r.traceId, task: "committee", model: r.model, classification, costMicroUsd: 0, blockReason: c.reason })

      const audits = await auditsOf(firmId)
      expect(audits).toHaveLength(1)
      expect(audits[0]!.data).toMatchObject({ action: "ai.gateway.decision", target: `ai_usage_logs/${r.usageLogId}`, classification, decision: "deny", reason: c.reason })

      const month = (await monthOf(firmId))!
      expect(month.calls.blocked).toBe(1)
      expect(month.calls.ok ?? 0).toBe(0)
      expect(month.spentMicroUsd).toBe(c.spent ?? 0)
      expect(await alertsOf(firmId)).toHaveLength(0)
    })

    it("a different model in disabledModels does not block, and a cleared switch re-enables", async () => {
      fakeTransport()
      await platformConfigRef().set({ killSwitch: killSwitch({ disabledModels: ["openai/gpt-5"] }) })
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET, killSwitch: killSwitch({ disableAll: false, disabledModels: ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5.5 "] }) })
      expect((await callP1(req(firmId), at)).outcome).toBe("ok")
    })

    it("a disableAll that is not exactly true does not block", async () => {
      fakeTransport()
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET, killSwitch: { disableAll: "true", disabledModels: "anthropic/claude-opus-5.5" } })
      expect((await callP1(req(firmId), at)).outcome).toBe("ok")
    })

    it("a privileged call whose masked text would still be masked again is blocked not_minimised", async () => {
      fakeTransport()
      setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: false } })
      const firmId = await seedFirm()
      // The party name "Party" is masked to "[PARTY]", which the mask would match again: not minimised.
      const r = await callP1(req(firmId, { classification: "privileged", body: "The party agrees.", partyNames: ["Party"] }), at)
      expect(r).toMatchObject({ outcome: "blocked", blockReason: "not_minimised" })
      expect((await auditsOf(firmId))[0]!.data).toMatchObject({ decision: "deny", reason: "not_minimised" })
    })

    it("a privileged call with an executed DPA and a minimised body is allowed", async () => {
      const sent = fakeTransport()
      setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: false } })
      const firmId = await seedFirm()
      const r = await callP1(req(firmId, { classification: "privileged", body: "Client Ali Raza asks.", partyNames: ["Ali Raza"] }), at)
      expect(r.outcome).toBe("ok")
      expect(sent[0]!.body).toBe("Client [PARTY] asks.")
    })

    it("confidential with an executed DPA is allowed", async () => {
      fakeTransport()
      setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: false } })
      const firmId = await seedFirm()
      expect((await callP1(req(firmId, { classification: "confidential" }), at)).outcome).toBe("ok")
    })
  })

  describe("order (P3-61: the first refusal wins)", () => {
    it("the platform switch outranks the firm switch, policy and the budget", async () => {
      const sent = fakeTransport()
      await platformConfigRef().set({ killSwitch: killSwitch({ disableAll: true }) })
      const firmId = await seedFirm({ killSwitch: killSwitch({ disableAll: true }) })
      const r = await callP1(req(firmId, { classification: "confidential" }), at)
      expect(r.blockReason).toBe("kill_switch_platform")
      expect(sent).toHaveLength(0)
    })

    it("the firm switch outranks policy", async () => {
      fakeTransport()
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET, killSwitch: killSwitch({ disableAll: true }) })
      expect((await callP1(req(firmId, { classification: "privileged" }), at)).blockReason).toBe("kill_switch_firm")
    })

    it("policy outranks the price and the budget", async () => {
      fakeTransport()
      p1TestSeam.modelOverride = "x/unpriced-model"
      const unset = await seedFirm(null)
      expect((await callP1(req(unset, { classification: "confidential" }), at)).blockReason).toBe("policy_denied")
      const exhausted = await seedFirm({ monthlyBudgetMicroUsd: 100 })
      await monthRef(exhausted, MONTH).set({ spentMicroUsd: 100 })
      expect((await callP1(req(exhausted, { classification: "privileged" }), at)).blockReason).toBe("policy_denied")
    })

    it("the price outranks the budget, and the budget outranks the credentials", async () => {
      p1TestSeam.modelOverride = "x/unpriced-model"
      const firmId = await seedFirm(null)
      expect((await callP1(req(firmId), at)).blockReason).toBe("model_unpriced")
      delete p1TestSeam.modelOverride
      expect((await callP1(req(firmId), at)).blockReason).toBe("budget_not_set")
    })
  })

  describe("kill switch flips (Review Focus 4)", () => {
    it("a firm switch set between two calls blocks the second; clearing it re-enables", async () => {
      const sent = fakeTransport()
      const firmId = await seedFirm()
      expect((await callP1(req(firmId), at)).outcome).toBe("ok")
      await firmConfigRef(firmId).set({ killSwitch: killSwitch({ disableAll: true }) }, { merge: true })
      expect((await callP1(req(firmId), at)).blockReason).toBe("kill_switch_firm")
      await firmConfigRef(firmId).set({ killSwitch: killSwitch({ disableAll: false, disabledModels: [] }) }, { merge: true })
      expect((await callP1(req(firmId), at)).outcome).toBe("ok")
      expect(sent).toHaveLength(2)
    })

    it("a platform switch set between two calls blocks the second", async () => {
      fakeTransport()
      const firmId = await seedFirm()
      expect((await callP1(req(firmId), at)).outcome).toBe("ok")
      await platformConfigRef().set({ killSwitch: killSwitch({ disableAll: true }) })
      expect((await callP1(req(firmId), at)).blockReason).toBe("kill_switch_platform")
    })

    it("a call already in flight when the switch is set completes", async () => {
      fakeTransport()
      const firmId = await seedFirm()
      p1TestSeam.beforeCommit = async () => {
        await firmConfigRef(firmId).set({ killSwitch: killSwitch({ disableAll: true }) }, { merge: true })
      }
      const r = await callP1(req(firmId), at)
      expect(r.outcome).toBe("ok")
      expect((await rowOf(r.usageLogId))!.outcome).toBe("ok")
    })
  })

  describe("classification guard (L8473)", () => {
    it.each([
      ["missing", undefined],
      ["unknown", "secret"],
      ["an inherited key", "constructor"],
      ["a rank number", 2],
    ])("a %s classification throws and nothing is written", async (_label, classification) => {
      const sent = fakeTransport()
      const firmId = await seedFirm()
      await expect(callP1({ ...req(firmId), classification } as unknown as P1Request, at)).rejects.toThrow(new Error("P1 call omitted classification"))
      expect(sent).toHaveLength(0)
      expect(await rowsOf(firmId)).toHaveLength(0)
      expect(await eventsOf(firmId)).toHaveLength(0)
      expect(await auditsOf(firmId)).toHaveLength(0)
      expect(await monthOf(firmId)).toBeUndefined()
    })
  })

  describe("transport failures (Review Focus 5)", () => {
    it("a rejecting transport gives failed, transport_error, cost 0, a failed event, and stores nothing of the error", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET, pkrPerUsd: 280 })
      const logs = spyLogs()
      const leak = "Upstream said: Ali Raza 35202-1234567-1 quota-xyz"
      fakeTransport(() => Promise.reject(new Error(leak)))
      const r = await callP1(req(firmId, { partyNames: ["Ali Raza"] }), at)

      expect(r).toMatchObject({ outcome: "failed", blockReason: null, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 })
      expect(r).not.toHaveProperty("text")
      const row = (await rowOf(r.usageLogId))!
      expect(row).toMatchObject({ outcome: "failed", blockReason: null, costMicroUsd: 0, inputTokens: 0, outputTokens: 0, tokensEstimated: false, fxPkrPerUsd: 280, costPkr: 0 })
      const events = await eventsOf(firmId)
      expect(events.map((e) => e.data.name)).toEqual(["ai.call.failed"])
      expect(events[0]!.id).toBe(`${r.usageLogId}_failed`)
      expect(events[0]!.data.payload).toEqual({ traceId: r.traceId, task: "committee", model: OPUS, classification: "internal", costMicroUsd: 0 })
      const audits = await auditsOf(firmId)
      expect(audits).toHaveLength(1)
      expect(audits[0]!.data).toMatchObject({ decision: "deny", reason: "transport_error" })
      expect((await monthOf(firmId))!).toMatchObject({ spentMicroUsd: 0, inputTokens: 0, outputTokens: 0, calls: { ok: 0, failed: 1, blocked: 0 } })

      for (const seen of [JSON.stringify(row), JSON.stringify(events), JSON.stringify(audits), JSON.stringify(r), logs.all()]) {
        expect(seen).not.toContain("quota-xyz")
        expect(seen).not.toContain("Upstream")
        expect(seen).not.toContain("35202-1234567-1")
      }
    })

    it("a transport that resolves without string text is a transport_error", async () => {
      const firmId = await seedFirm()
      const logs = spyLogs()
      fakeTransport({ text: { not: "text" } })
      const r = await callP1(req(firmId), at)
      // I1: a response came back, so it is billed like the Gateway's own gateway_no_text, on the usage it reported (1000 in, 500 out).
      expect(r).toMatchObject({ outcome: "failed", inputTokens: 1000, outputTokens: 500, costMicroUsd: costMicroUsd(OPUS, 1000, 500) })
      expect((await auditsOf(firmId))[0]!.data.reason).toBe("transport_error")
      // m2: the fixed code, not "unknown".
      expect(logs.warn.mock.calls.filter((c) => c[0] === "p1.transport_failed").map((c) => (c[1] as { code: string }).code)).toEqual(["gateway_no_text"])
    })

    it("a billed failure is charged into the month total, crosses the alerts and counts toward budget_exhausted; the next call is blocked", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: 100_000 })
      // A 2xx with no text that reported 0 in and 5000 out: 5000 x 20 = 100000 micro-USD, the whole budget.
      fakeTransport(() => Promise.reject(new P1TransportError("gateway_no_text", { billable: true, inputTokens: 0, outputTokens: 5000 })))
      const r = await callP1(req(firmId), at)
      expect(r).toMatchObject({ outcome: "failed", blockReason: null, inputTokens: 0, outputTokens: 5000, costMicroUsd: 100_000 })
      expect(await rowOf(r.usageLogId)).toMatchObject({ outcome: "failed", costMicroUsd: 100_000, inputTokens: 0, outputTokens: 5000, tokensEstimated: false })
      expect((await monthOf(firmId))!).toMatchObject({ spentMicroUsd: 100_000, inputTokens: 0, outputTokens: 5000, calls: { ok: 0, failed: 1, blocked: 0 } })
      expect((await alertsOf(firmId)).map((a) => a.data.threshold).sort()).toEqual([70, 90])

      const sent = fakeTransport()
      const next = await callP1(req(firmId), at)
      expect(next).toMatchObject({ outcome: "blocked", blockReason: "budget_exhausted", costMicroUsd: 0 })
      expect(sent).toHaveLength(0)
    })

    it("an unbilled P1TransportError is charged nothing, and a billed one with no usage is charged the estimated input and the 4,096-token ceiling", async () => {
      const firmId = await seedFirm()
      fakeTransport(() => Promise.reject(new P1TransportError("gateway_status", { billable: false, status: 503 })))
      const unbilled = await callP1(req(firmId), at)
      expect(unbilled).toMatchObject({ outcome: "failed", inputTokens: 0, outputTokens: 0, costMicroUsd: 0 })
      expect(await rowOf(unbilled.usageLogId)).toMatchObject({ costMicroUsd: 0, tokensEstimated: false })

      fakeTransport(() => Promise.reject(new P1TransportError("gateway_not_json", { billable: true })))
      const billed = await callP1(req(firmId, { body: "Client Ali Raza asks.", partyNames: ["Ali Raza"] }), at)
      const inTok = estimateTokens("Client [PARTY] asks.")
      expect(billed).toMatchObject({ outcome: "failed", inputTokens: inTok, outputTokens: MAX_OUTPUT_TOKENS, costMicroUsd: costMicroUsd(OPUS, inTok, 4096) })
      expect(await rowOf(billed.usageLogId)).toMatchObject({ inputTokens: inTok, outputTokens: 4096, tokensEstimated: true, costMicroUsd: costMicroUsd(OPUS, inTok, 4096) })
      expect((await monthOf(firmId))!).toMatchObject({ spentMicroUsd: costMicroUsd(OPUS, inTok, 4096), inputTokens: inTok, outputTokens: 4096, calls: { ok: 0, failed: 2, blocked: 0 } })
    })

    describe("through the real Gateway transport against a local server", () => {
      let server: Server
      let base: string
      let respond: (req: IncomingMessage, res: ServerResponse) => void

      beforeAll(async () => {
        server = createServer((rq, rs) => {
          rq.resume()
          rq.on("end", () => {
            rs.setHeader("connection", "close")
            respond(rq, rs)
          })
        })
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      })

      afterAll(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      })

      const json = (status: number, body: unknown) => (_rq: IncomingMessage, rs: ServerResponse) => {
        rs.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
      }

      // I1: what each failure is charged. The body is "Draft a reply to the notice.", so an estimated input side is
      // estimateTokens of it; a timeout is charged at the 4,096-token ceiling.
      const BODY_TOKENS = estimateTokens("Draft a reply to the notice.")
      it.each([
        ["a non-2xx", json(503, { error: { message: "Ali Raza overloaded quota-xyz" } }), "gateway_status", { inputTokens: 0, outputTokens: 0, tokensEstimated: false, costMicroUsd: 0 }],
        [
          "a 2xx with no choices[0].message.content",
          json(200, { choices: [], note: "Ali Raza quota-xyz", usage: { prompt_tokens: 7, completion_tokens: 3 } }),
          "gateway_no_text",
          { inputTokens: 7, outputTokens: 3, tokensEstimated: false, costMicroUsd: costMicroUsd(OPUS, 7, 3)! },
        ],
        ["a timeout", () => undefined, "gateway_timeout", { inputTokens: BODY_TOKENS, outputTokens: 4096, tokensEstimated: true, costMicroUsd: costMicroUsd(OPUS, BODY_TOKENS, 4096)! }],
      ] as const)("%s gives failed, transport_error, the charge the I1 rule sets, and stores no provider text", async (_label, handler, code, charge) => {
        respond = handler
        setP1TransportForTests(gatewayTransport("test-key", `${base}/v1/chat/completions`, { timeoutMs: 300 }))
        const firmId = await seedFirm()
        const logs = spyLogs()
        const r = await callP1(req(firmId), at)
        const { inputTokens, outputTokens, costMicroUsd: cost } = charge
        expect(r).toMatchObject({ outcome: "failed", blockReason: null, inputTokens, outputTokens, costMicroUsd: cost })
        expect(await rowOf(r.usageLogId)).toMatchObject({ outcome: "failed", ...charge })
        expect((await monthOf(firmId))!).toMatchObject({ spentMicroUsd: cost, inputTokens, outputTokens, calls: { ok: 0, failed: 1, blocked: 0 } })
        const stored = JSON.stringify([await rowOf(r.usageLogId), await eventsOf(firmId), await auditsOf(firmId), r, logs.all()])
        expect(stored).not.toContain("quota-xyz")
        expect((await auditsOf(firmId))[0]!.data.reason).toBe("transport_error")
        expect(logs.warn.mock.calls.filter((c) => c[0] === "p1.transport_failed").map((c) => (c[1] as { code: string }).code)).toEqual([code])
      })

      it("a thrown fetch (connection refused) gives failed", async () => {
        setP1TransportForTests(gatewayTransport("test-key", "http://127.0.0.1:1/v1/chat/completions", { timeoutMs: 300 }))
        const firmId = await seedFirm()
        const r = await callP1(req(firmId), at)
        expect(r).toMatchObject({ outcome: "failed", blockReason: null, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 })
        expect((await monthOf(firmId))!).toMatchObject({ spentMicroUsd: 0, calls: { ok: 0, failed: 1, blocked: 0 } })
      })

      it("a 2xx with content but no usage is ok with tokensEstimated", async () => {
        respond = json(200, { choices: [{ message: { content: "Hello Ali Raza" } }] })
        setP1TransportForTests(gatewayTransport("test-key", `${base}/v1/chat/completions`, { timeoutMs: 1000 }))
        const firmId = await seedFirm()
        const r = await callP1(req(firmId, { partyNames: ["Ali Raza"] }), at)
        expect(r).toMatchObject({ outcome: "ok", text: "Hello [PARTY]" })
        expect((await rowOf(r.usageLogId))!.tokensEstimated).toBe(true)
      })
    })
  })

  describe("usage absent (P3-62)", () => {
    it("null tokens on both sides: ok, tokensEstimated, the input estimated from the masked body sent and the output from the raw response", async () => {
      const firmId = await seedFirm()
      fakeTransport({ text: "Reply to Ali Raza at 0300-1234567", inputTokens: null, outputTokens: null })
      const r = await callP1(req(firmId, { body: "Ali Raza's bail ک", partyNames: ["Ali Raza"] }), at)
      // The input side is what was sent (the masked body); the output side is what the provider produced (the raw text).
      const inTok = estimateTokens("[PARTY]'s bail ک")
      const outTok = estimateTokens("Reply to Ali Raza at 0300-1234567")
      expect(r).toMatchObject({ outcome: "ok", inputTokens: inTok, outputTokens: outTok, costMicroUsd: costMicroUsd(OPUS, inTok, outTok) })
      expect(await rowOf(r.usageLogId)).toMatchObject({ tokensEstimated: true, inputTokens: inTok, outputTokens: outTok, costMicroUsd: costMicroUsd(OPUS, inTok, outTok) })
    })

    it("with no output usage the output side is estimated from the raw response, which masking shortens; only the masked text is returned, stored, traced or logged", async () => {
      const firmId = await seedFirm()
      const logs = spyLogs()
      const opik = fakeOpik()
      const NAME = "Muhammad Abdul Rehman Siddiqui"
      const raw = `${NAME} `.repeat(20) + "agrees, CNIC 35202-1234567-1."
      const sent = fakeTransport({ text: raw, inputTokens: 50, outputTokens: null })
      const r = await callP1(req(firmId, { partyNames: [NAME] }), at)

      expect(r.text).toBe("[PARTY] ".repeat(20) + "agrees, CNIC [CNIC].")
      const rawTok = estimateTokens(raw)
      expect(rawTok).toBeGreaterThan(estimateTokens(r.text!))
      expect(r).toMatchObject({ outcome: "ok", inputTokens: 50, outputTokens: rawTok, costMicroUsd: costMicroUsd(OPUS, 50, rawTok) })
      const row = (await rowOf(r.usageLogId))!
      expect(row).toMatchObject({ inputTokens: 50, outputTokens: rawTok, tokensEstimated: true, costMicroUsd: costMicroUsd(OPUS, 50, rawTok) })
      expect((await monthOf(firmId))!).toMatchObject({ outputTokens: rawTok, spentMicroUsd: costMicroUsd(OPUS, 50, rawTok) })
      expect(traceOf(opik.bodies).output).toEqual({ text: r.text })

      // The raw text was used for the count only: it reaches no row, event, audit row, trace, log line or result.
      for (const seen of [JSON.stringify(row), JSON.stringify(await eventsOf(firmId)), JSON.stringify(await auditsOf(firmId)), opik.bodies.join(""), logs.all(), JSON.stringify(r)]) {
        expect(seen.toLowerCase()).not.toContain("siddiqui")
        expect(seen).not.toContain("35202-1234567-1")
      }
      expect(sent).toHaveLength(1)
    })

    it("one side null: only that side is estimated", async () => {
      const firmId = await seedFirm()
      fakeTransport({ text: "abcdef", inputTokens: 7, outputTokens: null })
      const r = await callP1(req(firmId), at)
      expect(r).toMatchObject({ inputTokens: 7, outputTokens: 2, costMicroUsd: costMicroUsd(OPUS, 7, 2) })
      expect((await rowOf(r.usageLogId))!.tokensEstimated).toBe(true)

      fakeTransport({ text: "abc", inputTokens: null, outputTokens: 9 })
      const r2 = await callP1(req(firmId, { body: "abcdefghi" }), at)
      expect(r2).toMatchObject({ inputTokens: 3, outputTokens: 9 })
      expect((await rowOf(r2.usageLogId))!.tokensEstimated).toBe(true)
    })
  })

  describe("PKR (P3-64)", () => {
    it("with pkrPerUsd 280, a 14000 micro-USD call stores fxPkrPerUsd 280 and costPkr 3.92", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET, pkrPerUsd: 280 })
      fakeTransport({ inputTokens: 1000, outputTokens: 500 })
      const r = await callP1(req(firmId), at)
      expect(r.costMicroUsd).toBe(14000)
      expect(await rowOf(r.usageLogId)).toMatchObject({ fxPkrPerUsd: 280, costPkr: 3.92 })
    })

    it.each([[undefined], [0], [-280], ["280"], [Number.NaN]])("with a rate of %s both are null", async (pkrPerUsd) => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET, ...(pkrPerUsd === undefined ? {} : { pkrPerUsd }) })
      fakeTransport()
      const r = await callP1(req(firmId), at)
      expect(await rowOf(r.usageLogId)).toMatchObject({ fxPkrPerUsd: null, costPkr: null })
    })
  })

  describe("alerts at 70 and 90 (P3-65, Review Focus 2)", () => {
    const BUDGET = 100_000

    it("crossing 70 writes one alert, one system audit row, one event and one warning; crossing 90 later writes the 90 alert", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BUDGET })
      const logs = spyLogs()
      costing(60_000)
      await callP1(req(firmId), at)
      expect(await alertsOf(firmId)).toHaveLength(0)

      costing(15_000)
      const second = await callP1(req(firmId), at)
      const alerts = await alertsOf(firmId)
      expect(alerts.map((a) => a.id)).toEqual([`${firmId}_${MONTH}_70`])
      expect(alerts[0]!.data).toMatchObject({ firmId, monthKey: MONTH, threshold: 70, budgetMicroUsd: BUDGET, spentMicroUsd: 75_000, usageLogId: second.usageLogId })

      const audits = await auditsOf(firmId, "ai.budget.threshold")
      expect(audits).toHaveLength(1)
      expect(audits[0]!.data).toMatchObject({ firmId, actorId: "system", target: `ai_budget_alerts/${firmId}_${MONTH}_70`, classification: "internal", decision: "allow", reason: "70" })

      const events = await eventsOf(firmId, "ai.budget.threshold_crossed")
      expect(events).toHaveLength(1)
      expect(events[0]!.data.payload).toEqual({ monthKey: MONTH, threshold: 70, budgetMicroUsd: BUDGET, spentMicroUsd: 75_000 })
      expect(events[0]!.id).toBe(`${second.usageLogId}_threshold_70`)

      const warned = logs.warn.mock.calls.filter((c) => c[0] === "p1.budget_threshold")
      expect(warned).toHaveLength(1)
      expect(warned[0]![1]).toMatchObject({ firmId, monthKey: MONTH, threshold: 70, budgetMicroUsd: BUDGET, spentMicroUsd: 75_000 })

      costing(20_000)
      await callP1(req(firmId), at)
      expect((await alertsOf(firmId)).map((a) => a.id).sort()).toEqual([`${firmId}_${MONTH}_70`, `${firmId}_${MONTH}_90`])
      expect(await auditsOf(firmId, "ai.budget.threshold")).toHaveLength(2)
      expect(await eventsOf(firmId, "ai.budget.threshold_crossed")).toHaveLength(2)
      expect((await monthOf(firmId))!.spentMicroUsd).toBe(95_000)
    })

    it("one call from 60000 to 95000 writes both alerts", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BUDGET })
      costing(60_000)
      await callP1(req(firmId), at)
      costing(35_000)
      await callP1(req(firmId), at)
      expect((await alertsOf(firmId)).map((a) => a.data.threshold).sort()).toEqual([70, 90])
      expect((await auditsOf(firmId, "ai.budget.threshold")).map((a) => a.data.reason).sort()).toEqual(["70", "90"])
      expect(await eventsOf(firmId, "ai.budget.threshold_crossed")).toHaveLength(2)
    })

    it("landing exactly on 70% crosses it; stopping just below does not", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BUDGET })
      costing(69_980)
      await callP1(req(firmId), at)
      expect(await alertsOf(firmId)).toHaveLength(0)
      costing(20)
      await callP1(req(firmId), at)
      expect((await alertsOf(firmId)).map((a) => a.data.threshold)).toEqual([70])
    })

    it("ten parallel calls crossing 70% write exactly one 70 alert, and the total equals the sum of the rows", { timeout: 60_000 }, async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BUDGET })
      costing(60_000)
      await callP1(req(firmId), at)
      costing(2_000)
      const results = await Promise.all(Array.from({ length: 10 }, () => callP1(req(firmId), at)))
      expect(results.every((r) => r.outcome === "ok")).toBe(true)

      expect((await alertsOf(firmId)).map((a) => a.id)).toEqual([`${firmId}_${MONTH}_70`])
      expect(await auditsOf(firmId, "ai.budget.threshold")).toHaveLength(1)
      expect(await eventsOf(firmId, "ai.budget.threshold_crossed")).toHaveLength(1)

      const rows = await rowsOf(firmId)
      expect(rows).toHaveLength(11)
      const sum = rows.reduce((n, r) => n + (r.data.costMicroUsd as number), 0)
      const month = (await monthOf(firmId))!
      expect(sum).toBe(80_000)
      expect(month.spentMicroUsd).toBe(sum)
      expect(month.calls).toEqual({ ok: 11, failed: 0, blocked: 0 })
    })

    it("ten parallel calls crossing both 70% and 90% write exactly one alert, audit row and event for each, and the total equals the sum of the rows", { timeout: 60_000 }, async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BUDGET })
      costing(60_000)
      await callP1(req(firmId), at)
      // 60000 + 10 x 4000 = 100000: the burst passes 70000 and 90000; no call starts at or over the budget (at most 96000).
      costing(4_000)
      const results = await Promise.all(Array.from({ length: 10 }, () => callP1(req(firmId), at)))
      expect(results.every((r) => r.outcome === "ok")).toBe(true)

      expect((await alertsOf(firmId)).map((a) => a.id).sort()).toEqual([`${firmId}_${MONTH}_70`, `${firmId}_${MONTH}_90`])
      const audits = await auditsOf(firmId, "ai.budget.threshold")
      expect(audits.map((a) => a.data.reason).sort()).toEqual(["70", "90"])
      const events = await eventsOf(firmId, "ai.budget.threshold_crossed")
      expect(events.map((e) => (e.data.payload as { threshold: number }).threshold).sort()).toEqual([70, 90])
      // Each alert names the call that crossed it, and that call's own event.
      for (const a of await alertsOf(firmId)) {
        expect(events.some((e) => e.id === `${a.data.usageLogId}_threshold_${a.data.threshold}`)).toBe(true)
      }

      const rows = await rowsOf(firmId)
      expect(rows).toHaveLength(11)
      const sum = rows.reduce((n, r) => n + (r.data.costMicroUsd as number), 0)
      const month = (await monthOf(firmId))!
      expect(sum).toBe(100_000)
      expect(month.spentMicroUsd).toBe(sum)
      expect(month.calls).toEqual({ ok: 11, failed: 0, blocked: 0 })
      expect(await auditsOf(firmId, "ai.gateway.decision")).toHaveLength(11)
    })

    it("decides the crossing on the budget the transaction reads, not the pre-call one", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: 1_000_000 })
      costing(60_000)
      await callP1(req(firmId), at)
      let once = false
      p1TestSeam.beforeCommit = async () => {
        if (once) return
        once = true
        await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BUDGET }, { merge: true })
      }
      costing(15_000)
      await callP1(req(firmId), at)
      const alerts = await alertsOf(firmId)
      expect(alerts.map((a) => a.data.threshold)).toEqual([70])
      expect(alerts[0]!.data.budgetMicroUsd).toBe(BUDGET)
    })

    it("raising the budget does not re-arm a crossed threshold, and the call still commits", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BUDGET })
      costing(75_000)
      await callP1(req(firmId), at)
      expect(await alertsOf(firmId)).toHaveLength(1)
      await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: 200_000 }, { merge: true })
      costing(70_000) // 75000 -> 145000: 72.5% of the new budget
      const r = await callP1(req(firmId), at)
      expect(r.outcome).toBe("ok")
      expect((await rowOf(r.usageLogId))!.outcome).toBe("ok")
      expect(await alertsOf(firmId)).toHaveLength(1)
      expect(await auditsOf(firmId, "ai.budget.threshold")).toHaveLength(1)
      expect((await monthOf(firmId))!.spentMicroUsd).toBe(145_000)
    })

    it("a blocked call or an unbilled failed call writes no alert and adds nothing to spend", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BUDGET })
      costing(69_000)
      await callP1(req(firmId), at)
      fakeTransport(() => Promise.reject(new Error("boom")))
      await callP1(req(firmId), at)
      await callP1(req(firmId, { classification: "confidential" }), at)
      expect(await alertsOf(firmId)).toHaveLength(0)
      expect((await monthOf(firmId))!).toMatchObject({ spentMicroUsd: 69_000, calls: { ok: 1, failed: 1, blocked: 1 } })
    })
  })

  describe("trace (P3-67)", () => {
    it("a failed export records trace.status failed and logs p1.trace_export_failed with ids only", async () => {
      const firmId = await seedFirm()
      const logs = spyLogs()
      fakeOpik(500)
      fakeTransport()
      const r = await callP1(req(firmId), at)
      expect(r.outcome).toBe("ok")
      expect((await rowOf(r.usageLogId))!.trace).toEqual({ id: r.traceId, status: "failed" })
      const warned = logs.warn.mock.calls.filter((c) => c[0] === "p1.trace_export_failed")
      expect(warned).toEqual([["p1.trace_export_failed", { firmId, usageLogId: r.usageLogId, traceId: r.traceId }]])
    })

    it("the exported trace carries the usage row id and the trace id", async () => {
      const firmId = await seedFirm()
      const opik = fakeOpik()
      fakeTransport()
      const r = await callP1(req(firmId), at)
      const trace = traceOf(opik.bodies)
      expect(trace.id).toBe(r.traceId)
      expect(trace.metadata).toMatchObject({ usageLogId: r.usageLogId, firmId, matterId: "matter-1", outcome: "ok", costMicroUsd: 14000, model: OPUS, provider: "ai-gateway" })
    })
  })

  describe("commit failure (P3-63)", () => {
    it("with failCommit the provider call's text is still returned and p1.usage_log_failed keeps the record", async () => {
      const firmId = await seedFirm()
      const logs = spyLogs()
      fakeTransport({ text: "Answer for Ali Raza" })
      p1TestSeam.failCommit = true
      const r: P1Result = await callP1(req(firmId, { body: "About Ali Raza 35202-1234567-1", partyNames: ["Ali Raza"] }), at)

      expect(r).toMatchObject({ outcome: "ok", text: "Answer for [PARTY]", costMicroUsd: 14000 })
      const failed = logs.error.mock.calls.filter((c) => c[0] === "p1.usage_log_failed")
      expect(failed).toHaveLength(1)
      expect(failed[0]![1]).toMatchObject({ usageLogId: r.usageLogId, firmId, outcome: "ok", costMicroUsd: 14000, monthKey: MONTH, model: OPUS, trace: { id: r.traceId, status: "disabled" } })
      expect(logs.all()).not.toContain("Ali Raza")
      expect(logs.all()).not.toContain("35202-1234567-1")
      expect(logs.all()).not.toContain("[PARTY]") // no text at all, masked or not

      expect(await rowsOf(firmId)).toHaveLength(0)
      expect(await monthOf(firmId)).toBeUndefined()
      expect(await auditsOf(firmId)).toHaveLength(0)
      expect(await eventsOf(firmId)).toHaveLength(0)
    })

    it("a commit still retrying at the deadline gives up: p1.usage_log_failed once (commit_deadline), the result is still returned, nothing is written", async () => {
      const firmId = await seedFirm()
      const logs = spyLogs()
      fakeTransport({ text: "Answer" })
      // Every attempt aborts under contention (gRPC ABORTED, which the SDK retries), and each read of the deadline's
      // clock is 10 s later than the last: the commit must stop at COMMIT_DEADLINE_MS, not after 3 rounds of 10 attempts.
      const aborted = () => Object.assign(new Error("aborted"), { code: 10 })
      p1TestSeam.commitAttemptFailures = Array.from({ length: 30 }, aborted)
      let reads = 0
      p1TestSeam.wallClock = () => 10_000 * reads++
      const r = await callP1(req(firmId), at)

      expect(COMMIT_DEADLINE_MS).toBe(30_000)
      expect(r).toMatchObject({ outcome: "ok", text: "Answer", costMicroUsd: 14000 })
      const remaining = p1TestSeam.commitAttemptFailures.length
      expect(remaining).toBeGreaterThan(0) // it stopped before the attempts ran out
      expect(remaining).toBeLessThan(30) // after at least one attempt
      const failed = logs.error.mock.calls.filter((c) => c[0] === "p1.usage_log_failed")
      expect(failed).toHaveLength(1)
      expect(failed[0]![1]).toMatchObject({ usageLogId: r.usageLogId, firmId, outcome: "ok", costMicroUsd: 14000, code: "commit_deadline" })
      expect(await rowsOf(firmId)).toHaveLength(0)
      expect(await monthOf(firmId)).toBeUndefined()
      expect(await eventsOf(firmId)).toHaveLength(0)
    })

    it("an ambiguous commit followed by ALREADY_EXISTS on the usage row is done: no p1.usage_log_failed, exactly one row, and its threshold warning still logged", async () => {
      // 14000 of a 20000 budget lands exactly on 70%.
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: 20_000 })
      const logs = spyLogs()
      fakeTransport()
      // The first round commits and its answer is lost as a contention abort, so a second round runs and its
      // tx.create of the same usage row fails with ALREADY_EXISTS.
      p1TestSeam.lostCommitAnswers = [Object.assign(new Error("aborted"), { code: 10 })]
      const r = await callP1(req(firmId), at)

      expect(r).toMatchObject({ outcome: "ok", costMicroUsd: 14000 })
      expect(p1TestSeam.lostCommitAnswers).toEqual([])
      expect(logs.error.mock.calls.filter((c) => c[0] === "p1.usage_log_failed")).toHaveLength(0)
      expect((await rowsOf(firmId)).map((row) => row.id)).toEqual([r.usageLogId])
      expect((await eventsOf(firmId, "ai.call.completed")).map((e) => e.id)).toEqual([`${r.usageLogId}_completed`])
      expect(await auditsOf(firmId, "ai.gateway.decision")).toHaveLength(1)
      expect((await monthOf(firmId))!).toMatchObject({ spentMicroUsd: 14000, calls: { ok: 1, failed: 0, blocked: 0 } })
      expect((await alertsOf(firmId)).map((a) => a.data.threshold)).toEqual([70])
      const warned = logs.warn.mock.calls.filter((c) => c[0] === "p1.budget_threshold")
      expect(warned).toHaveLength(1)
      expect(warned[0]![1]).toMatchObject({ firmId, monthKey: MONTH, threshold: 70, budgetMicroUsd: 20_000, spentMicroUsd: 14000 })
    })

    it("an unseen commit followed by the deadline is confirmed by its usage row: no p1.usage_log_failed, exactly one row", async () => {
      const firmId = await seedFirm()
      const logs = spyLogs()
      fakeTransport()
      // The first attempt commits and its answer is lost; by the next attempt the deadline has passed. The row
      // exists, so the commit is done: no failure is logged for it.
      p1TestSeam.lostCommitAnswers = [Object.assign(new Error("aborted"), { code: 10 })]
      let reads = 0
      p1TestSeam.wallClock = () => 10_000 * reads++
      const r = await callP1(req(firmId), at)

      expect(r).toMatchObject({ outcome: "ok", costMicroUsd: 14000 })
      expect(logs.error.mock.calls.filter((c) => c[0] === "p1.usage_log_failed")).toHaveLength(0)
      expect((await rowsOf(firmId)).map((row) => row.id)).toEqual([r.usageLogId])
      expect((await monthOf(firmId))!).toMatchObject({ spentMicroUsd: 14000, calls: { ok: 1, failed: 0, blocked: 0 } })
    })

    it("a RESOURCE_EXHAUSTED commit is retried on P1's own short back-off, never the SDK's 60 s wait", async () => {
      const firmId = await seedFirm()
      const logs = spyLogs()
      fakeTransport()
      const exhausted = () => Object.assign(new Error("resource exhausted"), { code: 8 })
      p1TestSeam.commitAttemptFailures = [exhausted(), exhausted()]
      const t0 = Date.now()
      const r = await callP1(req(firmId), at)

      expect(Date.now() - t0).toBeLessThan(10_000)
      expect(r).toMatchObject({ outcome: "ok", costMicroUsd: 14000 })
      expect(p1TestSeam.commitAttemptFailures).toEqual([])
      expect(logs.error.mock.calls.filter((c) => c[0] === "p1.usage_log_failed")).toHaveLength(0)
      expect((await rowsOf(firmId)).map((row) => row.id)).toEqual([r.usageLogId])
    }, 120_000)

    it("the commit's worst case fits the function timeout: transport, trace, the commit deadline and one attempt in flight", () => {
      expect(TRANSPORT_TIMEOUT_MS + OPIK_TIMEOUT_MS + COMMIT_DEADLINE_MS + COMMIT_ATTEMPT_SLACK_MS).toBeLessThan(FUNCTION_TIMEOUT_SECONDS * 1000)
      expect(COMMIT_BACKOFF_CAP_MS).toBeLessThanOrEqual(2_000)
    })
  })

  describe("test seams in production (M7)", () => {
    it("with NODE_ENV production every p1TestSeam field is inert: the call routes to the real model, commits once and logs no failure", async () => {
      const firmId = await seedFirm()
      // The transport seam is set first: it refuses to be set in production (its own test covers that).
      const sent = fakeTransport()
      const logs = spyLogs()
      const ran: string[] = []
      const aborted = () => Object.assign(new Error("aborted"), { code: 10 })
      p1TestSeam.modelOverride = "x/unpriced-model"
      p1TestSeam.failCommit = true
      p1TestSeam.beforeCommit = async () => void ran.push("beforeCommit")
      p1TestSeam.wallClock = () => {
        ran.push("wallClock")
        return 0
      }
      p1TestSeam.commitAttemptFailures = [aborted()]
      p1TestSeam.lostCommitAnswers = [aborted()]
      vi.stubEnv("NODE_ENV", "production")
      const r = await callP1(req(firmId), at)

      expect(r).toMatchObject({ outcome: "ok", model: OPUS, costMicroUsd: 14000 })
      expect(sent.map((x) => x.model)).toEqual([OPUS])
      expect(ran).toEqual([])
      expect(p1TestSeam.commitAttemptFailures).toHaveLength(1)
      expect(p1TestSeam.lostCommitAnswers).toHaveLength(1)
      expect(logs.error.mock.calls.filter((c) => c[0] === "p1.usage_log_failed")).toHaveLength(0)
      expect((await rowsOf(firmId)).map((row) => row.id)).toEqual([r.usageLogId])
      expect((await monthOf(firmId))!.calls).toEqual({ ok: 1, failed: 0, blocked: 0 })
    })
  })

  describe("drafting, truncation and pseudonyms (P4B-4 to P4B-6)", () => {
    it("truncated is true for an ok answer whose finishReason is anything but stop, absent included; the charge, row and event are unchanged", async () => {
      for (const [finishReason, truncated] of [["stop", false], ["length", true], [null, true], [undefined, true], ["content_filter", true]] as const) {
        const firmId = await seedFirm()
        fakeTransport({ finishReason })
        const r = await callP1(req(firmId, { taskType: "drafting" }), at)
        expect([finishReason, r.outcome, r.truncated, r.costMicroUsd, r.model]).toEqual([finishReason, "ok", truncated, 14000, OPUS])
        expect((await rowOf(r.usageLogId))?.outcome).toBe("ok")
        expect(await eventsOf(firmId, "ai.call.completed")).toHaveLength(1)
      }
    })

    it("truncated is false on a blocked call and on a failed call", async () => {
      const blockedFirm = await seedFirm(null)
      fakeTransport({ finishReason: "length" })
      const blocked = await callP1(req(blockedFirm, { taskType: "drafting" }), at)

      const failedFirm = await seedFirm()
      fakeTransport(() => Promise.reject(new P1TransportError("gateway_status", { billable: false, status: 500 })))
      const failed = await callP1(req(failedFirm, { taskType: "drafting" }), at)

      expect([blocked.outcome, blocked.blockReason, blocked.truncated, failed.outcome, failed.truncated]).toEqual(["blocked", "budget_not_set", false, "failed", false])
    })

    it("with pseudonymise the transport, the row, the event, the audit row, the trace and every log line carry tokens only, and an ok result carries the frozen map", async () => {
      const firmId = await seedFirm()
      const sent = fakeTransport({ text: `⟦PARTY_1⟧, ${PERSON}, holds ⟦CNIC_1⟧` })
      const opik = fakeOpik()
      const logs = spyLogs()
      const r = await callP1(req(firmId, { taskType: "drafting", body: `${PERSON} (${CNIC}) owns ${LAND}`, partyNames: [PERSON], pseudonymise: { verbatim: [LAND] } }), at)
      expect(sent[0]!.body).toBe("⟦PARTY_1⟧ (⟦CNIC_1⟧) owns ⟦VERBATIM_1⟧")
      expect(r.text).toBe("⟦PARTY_1⟧, ⟦PARTY_1⟧, holds ⟦CNIC_1⟧")
      expect(r.outbound.redactionCounts).toMatchObject({ verbatim: 1, cnic: 1, party: 1 })
      expect(r.pseudonyms?.map((p) => p.value)).toEqual([LAND, CNIC, PERSON])
      expect(Object.isFrozen(r.pseudonyms)).toBe(true)
      expect(opik.bodies).toHaveLength(1)
      const everywhere = JSON.stringify([await rowsOf(firmId), await eventsOf(firmId), await auditsOf(firmId), opik.bodies, logs.all()])
      for (const v of [PERSON, CNIC, LAND]) expect(everywhere).not.toContain(v)
    })

    it("without pseudonymise the call is as before: lossy masking, no pseudonyms, no verbatim count", async () => {
      const firmId = await seedFirm()
      const sent = fakeTransport()
      const r = await callP1(req(firmId, { body: `${PERSON} ${CNIC}`, partyNames: [PERSON] }), at)
      expect(sent[0]!.body).toBe("[PARTY] [CNIC]")
      expect("pseudonyms" in r).toBe(false)
      expect(r.outbound.redactionCounts).not.toHaveProperty("verbatim")
    })

    it("a pseudonymised privileged call with an executed DPA passes assertMinimised and goes out", async () => {
      setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: false } })
      const firmId = await seedFirm()
      const sent = fakeTransport()
      const r = await callP1(req(firmId, { classification: "privileged", body: `${PERSON} ${CNIC}`, partyNames: [PERSON], pseudonymise: { verbatim: [] } }), at)
      expect([r.outcome, r.blockReason]).toEqual(["ok", null])
      expect(sent).toHaveLength(1)
      expect(sent[0]!.body).toBe("⟦PARTY_1⟧ ⟦CNIC_1⟧")
    })

    // Beyond the brief's list: the map is returned on an ok result only, and no failure path carries it.
    it("a pseudonymised call that is blocked or fails returns no pseudonyms, and its outbound body is tokens only", async () => {
      const body = `${PERSON} (${CNIC}) owns ${LAND}`
      const options: Partial<P1Request> = { taskType: "drafting", body, partyNames: [PERSON], pseudonymise: { verbatim: [LAND] } }
      const blocked = await callP1(req(await seedFirm(null), options), at)
      fakeTransport(() => Promise.reject(new P1TransportError("gateway_status", { billable: false, status: 500 })))
      const failed = await callP1(req(await seedFirm(), options), at)
      expect([blocked.outcome, "pseudonyms" in blocked, failed.outcome, "pseudonyms" in failed]).toEqual(["blocked", false, "failed", false])
      expect([blocked.outbound.body, failed.outbound.body]).toEqual(["⟦PARTY_1⟧ (⟦CNIC_1⟧) owns ⟦VERBATIM_1⟧", "⟦PARTY_1⟧ (⟦CNIC_1⟧) owns ⟦VERBATIM_1⟧"])
    })

    it("a failed commit logs no pseudonym value, and the result still carries the map", async () => {
      const firmId = await seedFirm()
      fakeTransport({ text: `${PERSON} holds ${CNIC} on ${LAND}` })
      p1TestSeam.failCommit = true
      const logs = spyLogs()
      const r = await callP1(req(firmId, { taskType: "drafting", body: `${PERSON} (${CNIC}) owns ${LAND}`, partyNames: [PERSON], pseudonymise: { verbatim: [LAND] } }), at)
      expect(r.outcome).toBe("ok")
      expect(r.pseudonyms).toHaveLength(3)
      expect(logs.error.mock.calls.filter((c) => c[0] === "p1.usage_log_failed")).toHaveLength(1)
      for (const v of [PERSON, CNIC, LAND]) expect(logs.all()).not.toContain(v)
    })
  })

  describe("G-1 forensic 7 equivalent", () => {
    it("a privileged call with no DPA is blocked, and its exported trace has classification privileged and no input or output", async () => {
      const firmId = await seedFirm()
      const opik = fakeOpik()
      const sent = fakeTransport()
      const r = await callP1(req(firmId, { classification: "privileged", body: "Privileged advice for Ali Raza", partyNames: ["Ali Raza"] }), at)

      expect(r).toMatchObject({ outcome: "blocked", blockReason: "policy_denied", classification: "privileged" })
      expect(sent).toHaveLength(0)
      expect((await eventsOf(firmId)).map((e) => e.data.name)).toEqual(["ai.call.blocked"])
      expect((await rowOf(r.usageLogId))!.trace).toEqual({ id: r.traceId, status: "exported" })

      const trace = traceOf(opik.bodies)
      expect(trace.metadata).toMatchObject({ classification: "privileged", outcome: "blocked", blockReason: "policy_denied" })
      expect(trace).not.toHaveProperty("input")
      expect(trace).not.toHaveProperty("output")
      expect(opik.bodies[0]).not.toContain("Privileged advice")
    })
  })
})
