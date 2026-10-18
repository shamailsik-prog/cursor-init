import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { installNetworkTripwire } from "@/tests/helpers/network-tripwire"

/**
 * Audit F16 (ruling 1) tested the Next legacy transport, `platform/p1/gatewayTransport.ts`: role-separated messages and
 * the 4,096-token answer bound. Audit F18 (spec docs/superpowers/specs/2026-10-18-f18-legacy-ai-path-closed-design.md,
 * rulings R2 and R12) deletes that transport: the Next and eve runtime has no provider path, and a paid call runs only in
 * Cloud Functions P1, whose transport keeps both F16 properties (functions/test/p1.transport.test.ts posts the
 * role-separated messages, the system message first, with `max_tokens` 4096).
 *
 * So this file now holds the Next side to having no transport at all: the module is gone, and with a provider key in the
 * environment a P1 call never reaches the AI SDK. The SDK boundary is a counting fake and a fetch tripwire refuses every
 * non-loopback request, so nothing can leave even on a tree that still had the transport. The key is an obviously fake
 * placeholder.
 */

const calls = vi.hoisted(() => ({ generateText: 0, createGateway: 0 }))

vi.mock("ai", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    createGateway: () => {
      calls.createGateway += 1
      return { languageModel: (id: string) => ({ fakeModelId: id }) }
    },
    generateText: async () => {
      calls.generateText += 1
      return { text: "stub reply" }
    },
  }
})

// Audit F18 re-audit follow-up: the shared tripwire, installed when this file loads (before any suite), refuses fetch
// and sockets to every host that is not loopback, and to the agent proxy's port.
const tripwire = installNetworkTripwire()
const egress = tripwire.refused

afterAll(() => {
  tripwire.uninstall()
})

afterEach(() => {
  calls.generateText = 0
  calls.createGateway = 0
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("audit F18 (supersedes the F16 Next-transport checks): the Next runtime has no provider transport", () => {
  it("the legacy transport module is gone", async () => {
    await expect(import("@/platform/p1/gatewayTransport" as string)).rejects.toThrow()
  })

  it("with an AI Gateway key in the environment, a P1 call never reaches the AI SDK and is blocked PHASE0_NO_CREDENTIALS", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", "placeholder-not-a-key")
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "placeholder-not-a-key")
    const { callCommitteeBrain, PHASE0_NO_CREDENTIALS } = await import("@/platform/p1/internalAICaller")
    const result = await callCommitteeBrain({ body: "Draft the reply.", classification: "public", provider: "ai-gateway", purpose: "committee-brain" })
    expect(calls).toEqual({ generateText: 0, createGateway: 0 })
    expect(egress).toEqual([])
    expect(result).toMatchObject({ blocked: true, reason: PHASE0_NO_CREDENTIALS })
  })
})
