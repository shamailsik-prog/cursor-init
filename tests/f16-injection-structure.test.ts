import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { committeeBrainLanguageModel } from "@/platform/p1/committeeBrainModel"
import { setTransportForTests } from "@/platform/p1/internalAICaller"
import { F16_CORPUS_VERSION, F16_INJECTION_CORPUS, type InjectionCase } from "@/tests/fixtures/f16-injection-corpus"
import { INSTRUCTIONS, requestMessages, toolPrompt, userPrompt } from "@/tests/fixtures/f16-injection-prompts"
import { installNetworkTripwire } from "@/tests/helpers/network-tripwire"

/**
 * Audit F16, spec ruling 6: the adversarial corpus through every P1 request builder.
 *
 * (a) Deterministic, runs everywhere: for every case, sent three ways (as the user's body through the shared builder
 *     the Functions `callP1` uses; as a tool result and as a user turn through the eve bridge's `doGenerate`), the
 *     request has exactly one system message, first, equal to the platform's text; the canary never reaches it; the
 *     canary lands only in a user turn or inside an envelope; and no envelope can be closed early.
 * (b) Live, only when AI_GATEWAY_API_KEY is set: every case as a tool result against the real model; a case fails when
 *     the answer contains its canary. Without the key it is reported NOT RUN, never as a pass. Model-level injection
 *     resistance is NOT DEMONSTRATED by (a). Audit F18 (spec ruling R12): the Next transport is deleted and the bridge
 *     has no provider path, so (b) goes through the Cloud Functions P1 transport, the only one that can serve a call.
 *     Audit F18 re-audit follow-up (FA-F18-001a): G-0 [19] lets no root test import that transport, so (b) moved to
 *     functions/test/f16-injection-live.test.ts, which sends `requestMessages` (tests/fixtures/f16-injection-prompts.ts).
 *     This file holds those messages equal to the request the bridge builds, for every case, so the move keeps (b)'s
 *     coverage: it sends exactly what the bridge would.
 *
 * Nothing here can reach a provider: the bridge has no transport but the test one, the `ai` SDK is a fake, and the
 * shared tripwire refuses every non-loopback fetch and socket from the moment this file loads.
 */

vi.mock("ai", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    createGateway: () => ({ languageModel: (id: string) => ({ fakeModelId: id }) }),
    generateText: async () => ({ text: "Answer from the fake provider." }),
  }
})

const tripwire = installNetworkTripwire()

afterAll(() => {
  tripwire.uninstall()
  expect(tripwire.refused, "non-loopback requests attempted by this file").toEqual([])
})

type Msg = { role: string; content: string }
type Builder = (input: { purpose: string; turns: unknown[]; partyNames?: string[] }) => { messages: Msg[] }
type Envelope = { envelopeIntegrity: (s: string) => boolean; envelopeOpen: (s: string) => string; ENVELOPE_CLOSE: string }

let buildOutbound: Builder | null = null
let envelope: Envelope | null = null
let committeeText: string | null = null

beforeAll(async () => {
  buildOutbound = await import("@/platform/p1/outboundPrompt").then((m) => m.buildOutbound as unknown as Builder).catch(() => null)
  envelope = await import("@/platform/p1/promptEnvelope").then((m) => m as unknown as Envelope).catch(() => null)
  committeeText = await import("@/platform/p1/systemPolicy").then((m) => m.SYSTEM_POLICIES["committee-brain"].text).catch(() => null)
})

afterEach(() => {
  setTransportForTests(null)
})

async function viaBridge(prompt: LanguageModelV3Prompt): Promise<Msg[] | undefined> {
  let captured: { messages?: Msg[] } | null = null
  setTransportForTests({
    async send(request) {
      captured = JSON.parse(JSON.stringify(request)) as { messages?: Msg[] }
      return { text: "ok" }
    },
  })
  await committeeBrainLanguageModel.doGenerate({ prompt, providerOptions: { sikander: { classification: "public" } } })
  return (captured as { messages?: Msg[] } | null)?.messages
}

/** The structural checks every carrier shares; returns the message holding the canary. */
function checkStructure(messages: Msg[] | undefined, c: InjectionCase, expectedSystem: string): Msg {
  expect(messages, "role-separated messages").toBeDefined()
  expect(messages!.filter((m) => m.role === "system")).toHaveLength(1)
  expect(messages![0]!.role).toBe("system")
  expect(messages![0]!.content).toBe(expectedSystem)
  expect(messages![0]!.content).not.toContain(c.canary)
  const holders = messages!.filter((m) => m.content.includes(c.canary))
  expect(holders.length, "the canary is carried").toBeGreaterThan(0)
  for (const m of holders) expect(m.role, "the canary only in a user turn").toBe("user")
  expect(envelope, "the envelope module").not.toBeNull()
  for (const m of messages!.slice(1)) expect(envelope!.envelopeIntegrity(m.content), `${c.id} integrity`).toBe(true)
  return holders[0]!
}

describe(`audit F16: injection corpus ${F16_CORPUS_VERSION}, request structure (deterministic)`, () => {
  it("has at least 40 cases, in English and Urdu, across the six categories, with unique ids and canaries", () => {
    expect(F16_INJECTION_CORPUS.length).toBeGreaterThanOrEqual(40)
    expect(new Set(F16_INJECTION_CORPUS.map((c) => c.id)).size).toBe(F16_INJECTION_CORPUS.length)
    expect(new Set(F16_INJECTION_CORPUS.map((c) => c.canary)).size).toBe(F16_INJECTION_CORPUS.length)
    expect(new Set(F16_INJECTION_CORPUS.map((c) => c.category))).toEqual(new Set(["override", "envelope", "fake-role", "role-play", "tool-coercion", "exfiltration"]))
    expect(F16_INJECTION_CORPUS.filter((c) => c.lang === "ur").length).toBeGreaterThanOrEqual(10)
    for (const c of F16_INJECTION_CORPUS) expect(c.text).toContain(c.canary)
  })

  it.each(F16_INJECTION_CORPUS.map((c) => [c.id, c] as const))("%s as the user's body through the Functions builder", (_id, c) => {
    expect(buildOutbound, "the shared builder").not.toBeNull()
    const { messages } = buildOutbound!({ purpose: "committee-brain", turns: [{ role: "user", segments: [{ kind: "text", text: c.text }] }] })
    const holder = checkStructure(messages, c, committeeText!)
    expect(messages.map((m) => m.role)).toEqual(["system", "user"])
    expect(holder).toBe(messages[1])
  })

  it.each(F16_INJECTION_CORPUS.map((c) => [c.id, c] as const))("%s as a tool result through the eve bridge: inside its envelope", async (_id, c) => {
    const messages = await viaBridge(toolPrompt(c))
    const holder = checkStructure(messages, c, `${committeeText}\n\nAgent instructions:\n${INSTRUCTIONS}`)
    const open = envelope!.envelopeOpen("tool:mask_preview")
    const start = holder.content.indexOf(`${open}\n`)
    const end = holder.content.indexOf(`\n${envelope!.ENVELOPE_CLOSE}`, start)
    const at = holder.content.indexOf(c.canary)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(at).toBeGreaterThan(start)
    expect(at).toBeLessThan(end)
  })

  it.each(F16_INJECTION_CORPUS.map((c) => [c.id, c] as const))("%s as a user turn through the eve bridge", async (_id, c) => {
    const messages = await viaBridge(userPrompt(c))
    checkStructure(messages, c, `${committeeText}\n\nAgent instructions:\n${INSTRUCTIONS}`)
    expect(messages!.map((m) => m.role)).toEqual(["system", "user"])
  })
})

/**
 * Audit F18 re-audit follow-up: the live evaluation (b) runs in functions/test/f16-injection-live.test.ts and sends
 * `requestMessages(toolPrompt(c))`. Here, for every case, those messages are the bridge's own request, so (b) keeps its
 * coverage after the move.
 */
describe(`audit F16: injection corpus ${F16_CORPUS_VERSION}, the live evaluation sends the bridge's request (F18 follow-up)`, () => {
  it.each(F16_INJECTION_CORPUS.map((c) => [c.id, c] as const))("%s as a tool result: requestMessages equals the bridge's request", async (_id, c) => {
    const bridge = await viaBridge(toolPrompt(c))
    expect(bridge, "the bridge built a request").toBeDefined()
    expect(requestMessages(toolPrompt(c))).toEqual(bridge)
  })
})
