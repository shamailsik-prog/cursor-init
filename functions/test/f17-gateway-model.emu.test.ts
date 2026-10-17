import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { logger } from "firebase-functions"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { firmConfigRef, platformConfigRef } from "../src/p1/config"
import { callP1, type P1Request } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { P1TransportError, setP1TransportForTests } from "../src/p1/transport"
import { EMULATORS, uniq } from "./emu"

/**
 * Audit F17, spec rulings 4 and 6 (R6a), over the Firestore emulator: `callP1` returns the model the provider reported
 * (`modelReported`, null when absent or not a model id) and records it on the usage row beside the configured `model`;
 * and it hands the masked answer to `onAnswer` as soon as it exists, once, so committeeBrain can ground it while the
 * call records, traces and commits. `onAnswer` never sees unmasked text and is never called for a blocked or failed
 * call; a hook that throws cannot break the call.
 */

const T = Date.parse("2026-10-11T10:00:00.000Z")
const at = { now: () => T }
const BIG_BUDGET = 1_000_000_000
const OPUS = "anthropic/claude-opus-5.5"

type Extra = { modelReported?: unknown }
type Hooked = P1Request & { onAnswer?: (text: string) => void }

function transport(reply: { text: string; model?: unknown } | (() => Promise<never>)) {
  setP1TransportForTests({
    async send() {
      if (typeof reply === "function") return reply()
      return { text: reply.text, inputTokens: 1000, outputTokens: 500, ...(reply.model === undefined ? {} : { model: reply.model }) } as never
    },
  })
}

async function seedFirm(): Promise<string> {
  const firmId = uniq("firm")
  await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BIG_BUDGET })
  return firmId
}

const req = (firmId: string, extra: Partial<Hooked> = {}): Hooked => ({
  firmId,
  actorId: "uid-1",
  matterId: "matter-1",
  jobId: null,
  taskType: "committee",
  classification: "internal",
  body: "Tariq Zarvani asks whether bail may be granted.",
  purpose: "committee-brain",
  partyNames: ["Tariq Zarvani"],
  ...extra,
})

const usageRow = async (id: string) => (await adminDb().collection("ai_usage_logs").doc(id).get()).data()!

describe.skipIf(!EMULATORS)("audit F17: callP1 reports the provider's model and hands over the masked answer", () => {
  beforeEach(() => {
    vi.stubEnv("OPIK_BASE_URL", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    setProviderConfigForTests(null)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    await platformConfigRef().delete()
  })

  it("records the reported model on the result and the usage row, beside the configured one", async () => {
    const firmId = await seedFirm()
    transport({ text: "ANSWER", model: "claude-opus-5.5" })
    const r = (await callP1(req(firmId), at)) as Awaited<ReturnType<typeof callP1>> & Extra
    expect(r.outcome).toBe("ok")
    expect(r.model).toBe(OPUS)
    expect(r.modelReported).toBe("claude-opus-5.5")
    const row = await usageRow(r.usageLogId)
    expect([row.model, row.modelReported]).toEqual([OPUS, "claude-opus-5.5"])
  })

  it.each([
    ["absent", undefined],
    ["not a model id", "a model, said the provider"],
    ["not a string", 7],
  ])("records null when the reported model is %s", async (_label, model) => {
    const firmId = await seedFirm()
    transport({ text: "ANSWER", model })
    const r = (await callP1(req(firmId), at)) as Awaited<ReturnType<typeof callP1>> & Extra
    expect(r.outcome).toBe("ok")
    expect(r.modelReported).toBeNull()
    expect((await usageRow(r.usageLogId)).modelReported).toBeNull()
  })

  it("a blocked call records no reported model", async () => {
    const firmId = await seedFirm()
    await firmConfigRef(firmId).set({ killSwitch: { disableAll: true, disabledModels: [], reason: "stop" } }, { merge: true })
    transport({ text: "ANSWER", model: OPUS })
    const r = (await callP1(req(firmId), at)) as Awaited<ReturnType<typeof callP1>> & Extra
    expect(r.outcome).toBe("blocked")
    expect(r.modelReported).toBeNull()
    expect((await usageRow(r.usageLogId)).modelReported).toBeNull()
  })

  it("onAnswer receives the masked answer once, before the call returns", async () => {
    const firmId = await seedFirm()
    transport({ text: "Tariq Zarvani may apply; see PLD 2099 SC 101.", model: OPUS })
    const seen: string[] = []
    const r = await callP1(req(firmId, { onAnswer: (text) => seen.push(text) }), at)
    expect(r.outcome).toBe("ok")
    expect(seen).toEqual(["[PARTY] may apply; see PLD 2099 SC 101."])
    expect(seen[0]).toBe(r.text)
  })

  it("onAnswer is not called for a blocked call or a failed one", async () => {
    const blockedFirm = await seedFirm()
    await firmConfigRef(blockedFirm).set({ killSwitch: { disableAll: true, disabledModels: [], reason: "stop" } }, { merge: true })
    const seen: string[] = []
    transport({ text: "ANSWER" })
    expect((await callP1(req(blockedFirm, { onAnswer: (t) => seen.push(t) }), at)).outcome).toBe("blocked")
    const failedFirm = await seedFirm()
    transport(() => Promise.reject(new P1TransportError("gateway_status", { billable: false, status: 500 })))
    expect((await callP1(req(failedFirm, { onAnswer: (t) => seen.push(t) }), at)).outcome).toBe("failed")
    expect(seen).toEqual([])
  })

  it("a hook that throws never breaks the call; the failure is logged by its code only", async () => {
    const firmId = await seedFirm()
    transport({ text: "ANSWER", model: OPUS })
    const warn = vi.spyOn(logger, "warn")
    const r = await callP1(
      req(firmId, {
        onAnswer: () => {
          throw Object.assign(new Error("Tariq Zarvani"), { code: "hook_bug" })
        },
      }),
      at
    )
    expect([r.outcome, r.text, r.accounting]).toEqual(["ok", "ANSWER", "settled"])
    expect(warn).toHaveBeenCalledWith("p1.on_answer_failed", expect.objectContaining({ usageLogId: r.usageLogId, code: "hook_bug" }))
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Tariq")
  })
})
