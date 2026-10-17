import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Audit F16 (ruling 1): the Next legacy transport (`platform/p1/gatewayTransport.ts`) hands the AI SDK role-separated
 * messages, the system message first. On main 403200c it calls `generateText({ prompt: request.body })`, which the SDK
 * turns into one user message: no system role at all.
 *
 * The SDK boundary is faked (`generateText`, `createGateway`), so no request leaves and no key is needed beyond a
 * stubbed placeholder. This file imports nothing that is new in F16.
 */

const calls: Array<Record<string, unknown>> = []

vi.mock("ai", async (importActual) => {
  const actual = await importActual<typeof import("ai")>()
  return {
    ...actual,
    createGateway: () => ({ languageModel: (id: string) => ({ fakeModelId: id }) }),
    generateText: async (args: Record<string, unknown>) => {
      calls.push(args)
      return { text: "stub reply" }
    },
  }
})

afterEach(() => {
  calls.length = 0
  vi.unstubAllEnvs()
})

describe("audit F16: the Next gateway transport sends role-separated messages", () => {
  it("passes the system message first and the user turn after it, and never a flattened prompt", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "placeholder-not-a-key")
    const { createGatewayTransport } = await import("@/platform/p1/gatewayTransport")
    const messages = [
      { role: "system", content: "Platform policy." },
      { role: "user", content: "Draft the reply for [PARTY]." },
    ]
    const request = {
      body: "Draft the reply for [PARTY].",
      messages,
      metadata: { classification: "internal", provider: "ai-gateway", purpose: "committee-brain", redactionCounts: {} },
    }
    const out = await createGatewayTransport("test/model").send(request as never)

    expect(out).toEqual({ text: "stub reply" })
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toHaveProperty("prompt")
    expect(calls[0]!.messages).toEqual(messages)
    expect(calls[0]!.model).toEqual({ fakeModelId: "test/model" })
  })
})
