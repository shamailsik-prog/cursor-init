import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { installNetworkTripwire } from "@/tests/helpers/network-tripwire"

/**
 * Audit F18, spec ruling R5: a provider key in the Next or eve runtime. Under NODE_ENV=production every P1 call is refused
 * with a documented reason and an alert line that names the variables, never their values; eve refuses to start. Outside
 * production only the alert line is logged: no paid path exists there to refuse (R2).
 *
 * The guard is loaded dynamically, so on main this file runs and fails on its absence. Values are obviously fake.
 *
 * No request can leave: the legacy provider boundary (the `ai` SDK's `createGateway`/`generateText`, which main's
 * platform/p1/gatewayTransport.ts calls when a key is set) is a counting fake, and the shared network tripwire
 * (tests/helpers/network-tripwire.ts), installed when this file loads and before any suite runs, refuses and records
 * every fetch and every socket to a host that is not loopback, and to the agent proxy's port. (An intermediate run of
 * this file without either, on a tree that still had the transport, let that transport attempt a call with the fake
 * key: see the F18 evidence log. Both guards close that.)
 *
 * Re-audit follow-up (FA-F18-005, spec R5 as amended): a key is tolerated, with its alert line, only when NODE_ENV is
 * exactly `development` or `test`; every other value, unset included, refuses as production does.
 */

const direct = vi.hoisted(() => ({ calls: 0 }))
vi.mock("ai", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    createGateway: () => ({ languageModel: (id: string) => ({ fakeModelId: id }) }),
    generateText: async () => {
      direct.calls += 1
      return { text: "Answer from the fake provider." }
    },
  }
})

const tripwire = installNetworkTripwire()
const egress = tripwire.refused

afterAll(() => {
  tripwire.uninstall()
  expect(egress, "non-loopback requests attempted by this file").toEqual([])
})

const FAKE = "placeholder-not-a-key"
type Guard = typeof import("@/platform/p1/providerKeyGuard")

async function guard(): Promise<Guard> {
  const mod = (await import("@/platform/p1/providerKeyGuard").catch(() => null)) as Guard | null
  expect(mod, "platform/p1/providerKeyGuard.ts exists").not.toBeNull()
  return mod!
}

function alertLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("audit F18: the provider-key guard (R5)", () => {
  it("lists the AI Gateway pair and the common provider keys", async () => {
    const { PROVIDER_KEY_ENV_NAMES } = await guard()
    for (const name of ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]) {
      expect(PROVIDER_KEY_ENV_NAMES).toContain(name)
    }
  })

  it("reports the names that are set and non-blank, never a value", async () => {
    const { providerKeysPresent } = await guard()
    expect(providerKeysPresent({})).toEqual([])
    expect(providerKeysPresent({ AI_GATEWAY_API_KEY: "   ", OPENAI_API_KEY: "" })).toEqual([])
    const present = providerKeysPresent({ VERCEL_AI_GATEWAY_API_KEY: FAKE, ANTHROPIC_API_KEY: FAKE, UNRELATED: FAKE })
    expect(present.sort()).toEqual(["ANTHROPIC_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"])
    expect(JSON.stringify(present)).not.toContain(FAKE)
  })

  it("in production: refuses, and logs one alert line naming the variables without their values", async () => {
    const { checkProviderKeys, PROVIDER_KEY_ALERT } = await guard()
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const check = checkProviderKeys("next", { NODE_ENV: "production", AI_GATEWAY_API_KEY: FAKE })
    expect(check).toEqual({ names: ["AI_GATEWAY_API_KEY"], refuse: true })
    const lines = alertLines(spy)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`ALERT ${PROVIDER_KEY_ALERT}`)
    expect(lines[0]).toContain("AI_GATEWAY_API_KEY")
    expect(lines[0]).not.toContain(FAKE)
  })

  it("outside production: alerts, does not refuse", async () => {
    const { checkProviderKeys } = await guard()
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(checkProviderKeys("eve", { NODE_ENV: "development", OPENAI_API_KEY: FAKE })).toEqual({ names: ["OPENAI_API_KEY"], refuse: false })
    expect(alertLines(spy)).toHaveLength(1)
  })

  it("with no key: neither refuses nor alerts", async () => {
    const { checkProviderKeys } = await guard()
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(checkProviderKeys("next", { NODE_ENV: "production" })).toEqual({ names: [], refuse: false })
    expect(spy).not.toHaveBeenCalled()
  })

  it("eve's start-up check throws in production with a key, and only then", async () => {
    const { assertNoProviderKeyAtStartup, PROVIDER_KEY_IN_RUNTIME_REASON } = await guard()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(() => assertNoProviderKeyAtStartup("eve", { NODE_ENV: "production", GROQ_API_KEY: FAKE })).toThrow(PROVIDER_KEY_IN_RUNTIME_REASON)
    expect(() => assertNoProviderKeyAtStartup("eve", { NODE_ENV: "production" })).not.toThrow()
    expect(() => assertNoProviderKeyAtStartup("eve", { NODE_ENV: "development", GROQ_API_KEY: FAKE })).not.toThrow()
  })

  // Re-audit follow-up FA-F18-005: Next keeps a non-standard NODE_ENV at runtime, so `=== "production"` let a key through
  // under `staging`. Only the two values a developer's or the test runner's process carries tolerate a key.
  const REFUSING_NODE_ENVS: (string | undefined)[] = ["production", "staging", "prod", "Production", "preview", "development ", " test", "", undefined]

  it.each(REFUSING_NODE_ENVS.map((v) => [JSON.stringify(v) ?? "unset", v] as const))("NODE_ENV %s with a key: refuses, with the alert line", async (_label, nodeEnv) => {
    const { checkProviderKeys } = await guard()
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const env: Record<string, string | undefined> = { DEEPL_AUTH_KEY: FAKE }
    if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv
    expect(checkProviderKeys("p1-call", env)).toEqual({ names: ["DEEPL_AUTH_KEY"], refuse: true })
    expect(alertLines(spy)).toHaveLength(1)
    expect(alertLines(spy)[0]).not.toContain(FAKE)
  })

  it.each(["development", "test"])("NODE_ENV %s with a key: alerts and does not refuse", async (nodeEnv) => {
    const { checkProviderKeys } = await guard()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(checkProviderKeys("p1-call", { NODE_ENV: nodeEnv, DEEPL_AUTH_KEY: FAKE })).toEqual({ names: ["DEEPL_AUTH_KEY"], refuse: false })
  })

  it("eve refuses to start with a key under NODE_ENV=staging and with NODE_ENV unset", async () => {
    const { assertNoProviderKeyAtStartup, PROVIDER_KEY_IN_RUNTIME_REASON } = await guard()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(() => assertNoProviderKeyAtStartup("eve", { NODE_ENV: "staging", AI_GATEWAY_API_KEY: FAKE })).toThrow(PROVIDER_KEY_IN_RUNTIME_REASON)
    expect(() => assertNoProviderKeyAtStartup("eve", { AI_GATEWAY_API_KEY: FAKE })).toThrow(PROVIDER_KEY_IN_RUNTIME_REASON)
    expect(() => assertNoProviderKeyAtStartup("eve", { NODE_ENV: "staging" })).not.toThrow()
  })

  it("with no key, no NODE_ENV value refuses (next build and next start run with production and no key)", async () => {
    const { checkProviderKeys } = await guard()
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    for (const nodeEnv of ["production", "staging", "development", "test"]) expect(checkProviderKeys("next", { NODE_ENV: nodeEnv })).toEqual({ names: [], refuse: false })
    expect(checkProviderKeys("next", {})).toEqual({ names: [], refuse: false })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("audit F18: callCommitteeBrain under the guard (R2, R5)", () => {
  it("in production with a key: blocked with the documented reason, nothing dispatched", async () => {
    const { PROVIDER_KEY_IN_RUNTIME_REASON } = await guard()
    const { callCommitteeBrain } = await import("@/platform/p1/internalAICaller")
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE)
    const result = await callCommitteeBrain({ body: "Summarise the order.", classification: "public", provider: "ai-gateway", purpose: "summarise" })
    expect(direct.calls, "calls through the legacy provider boundary").toBe(0)
    expect(egress).toEqual([])
    expect(result).toMatchObject({ blocked: true, event: "ai.call.blocked", reason: PROVIDER_KEY_IN_RUNTIME_REASON })
  })

  it("under NODE_ENV=staging with a key: blocked with the documented reason (FA-F18-005), nothing dispatched", async () => {
    const { PROVIDER_KEY_IN_RUNTIME_REASON } = await guard()
    const { callCommitteeBrain } = await import("@/platform/p1/internalAICaller")
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("NODE_ENV", "staging")
    vi.stubEnv("OPENAI_API_KEY", FAKE)
    const result = await callCommitteeBrain({ body: "Summarise the order.", classification: "public", provider: "ai-gateway", purpose: "summarise" })
    expect(direct.calls, "calls through the legacy provider boundary").toBe(0)
    expect(egress).toEqual([])
    expect(result).toMatchObject({ blocked: true, event: "ai.call.blocked", reason: PROVIDER_KEY_IN_RUNTIME_REASON })
  })

  it("in production without a key: blocked PHASE0_NO_CREDENTIALS, because the Next runtime has no provider transport", async () => {
    const { callCommitteeBrain, PHASE0_NO_CREDENTIALS } = await import("@/platform/p1/internalAICaller")
    vi.stubEnv("NODE_ENV", "production")
    const result = await callCommitteeBrain({ body: "Summarise the order.", classification: "public", provider: "ai-gateway", purpose: "summarise" })
    expect(result).toMatchObject({ blocked: true, reason: PHASE0_NO_CREDENTIALS })
  })

  it("outside production with a key: the alert is logged and the call goes to the injected test transport only", async () => {
    await guard()
    const { callCommitteeBrain, setTransportForTests } = await import("@/platform/p1/internalAICaller")
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE)
    let sent = 0
    setTransportForTests({
      async send() {
        sent += 1
        return { text: "stub" }
      },
    })
    try {
      const result = await callCommitteeBrain({ body: "Summarise the order.", classification: "public", provider: "ai-gateway", purpose: "summarise" })
      expect(result.blocked).toBe(false)
      expect(sent).toBe(1)
      expect(alertLines(spy).some((l) => l.includes("p1.provider_key_in_next_runtime"))).toBe(true)
    } finally {
      setTransportForTests(null)
    }
  })
})

/**
 * PR #88 review round 1 (Codex P2, thread 4307495841; spec ruling R5, review-round note): the key check, with its alert
 * line, runs first on every path through P1 in this runtime, including every early exit that came before it on
 * 72ff10f:
 *   - in callCommitteeBrain, the 900 KiB storage bound (a return), the missing-classification guard and the request
 *     builder's input checks (throws);
 *   - in the eve bridge, the two refusals before callCommitteeBrain (no classification in providerOptions, a prompt part
 *     P1 cannot carry).
 * When the key refusal and the storage bound both hold, the stored row carries the key reason, in the storage-safe shape
 * (no body, no messages). Each path logs the alert exactly once.
 */
describe("audit F18 review round 1: the key check runs before every early exit", () => {
  const KEY_ALERT = "p1.provider_key_in_next_runtime"
  const alerts = (spy: { mock: { calls: unknown[][] } }) => alertLines(spy).filter((l) => l.includes(KEY_ALERT))
  /** A body whose stored outbound exceeds MAX_STORED_OUTBOUND_BYTES (900 KiB), as tests/f16-next-output-size uses. */
  const OVERSIZED = "Draft the reply. ".repeat(56_000)

  it("production, a key and an outbound over 900 KiB: the alert is logged, and the storage-safe row carries the key reason", async () => {
    const { PROVIDER_KEY_IN_RUNTIME_REASON } = await guard()
    const { callCommitteeBrain } = await import("@/platform/p1/internalAICaller")
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE)
    const result = await callCommitteeBrain({ body: OVERSIZED, classification: "internal", provider: "ai-gateway", purpose: "summarise" })
    expect(alerts(spy), "the deployment alert line").toHaveLength(1)
    expect(alerts(spy)[0]).not.toContain(FAKE)
    expect(result).toMatchObject({ blocked: true, event: "ai.call.blocked", reason: PROVIDER_KEY_IN_RUNTIME_REASON })
    expect(result.outbound.body, "storage-safe: the body is not kept").toBe("")
    expect(result.messages).toEqual([])
    expect(direct.calls).toBe(0)
  }, 120_000)

  it("control: without a key, the same outbound is refused for its size, with no alert", async () => {
    const { callCommitteeBrain } = await import("@/platform/p1/internalAICaller")
    const { STORED_OUTBOUND_TOO_LARGE_REASON } = await import("@/platform/p1/constants")
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("NODE_ENV", "production")
    const result = await callCommitteeBrain({ body: OVERSIZED, classification: "internal", provider: "ai-gateway", purpose: "summarise" })
    expect(alerts(spy)).toHaveLength(0)
    expect(result).toMatchObject({ blocked: true, reason: STORED_OUTBOUND_TOO_LARGE_REASON })
    expect(result.outbound.body).toBe("")
  }, 120_000)

  it("production and a key: a call missing its classification still throws, and the alert is logged first", async () => {
    await guard()
    const { callCommitteeBrain } = await import("@/platform/p1/internalAICaller")
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE)
    await expect(
      callCommitteeBrain({ body: "Summarise the order.", classification: undefined as never, provider: "ai-gateway", purpose: "summarise" })
    ).rejects.toThrow("P1 call omitted classification")
    expect(alerts(spy)).toHaveLength(1)
  })

  it("production and a key: a request the builder refuses still throws, and the alert is logged first", async () => {
    await guard()
    const { callCommitteeBrain } = await import("@/platform/p1/internalAICaller")
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE)
    await expect(callCommitteeBrain({ turns: [], classification: "public", provider: "ai-gateway", purpose: "committee-brain" })).rejects.toThrow(
      "P1: a request needs at least one turn"
    )
    expect(alerts(spy)).toHaveLength(1)
  })

  it("production and a key: the eve bridge's refusal for a missing classification logs the alert and reports the key reason", async () => {
    const { PROVIDER_KEY_IN_RUNTIME_REASON } = await guard()
    const { committeeBrainLanguageModel } = await import("@/platform/p1/committeeBrainModel")
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE)
    const result = await committeeBrainLanguageModel.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Summarise." }] }] })
    const text = result.content.map((p) => ("text" in p ? p.text : "")).join("")
    expect(alerts(spy)).toHaveLength(1)
    expect(result.finishReason.unified).toBe("error")
    expect(text).toContain(PROVIDER_KEY_IN_RUNTIME_REASON)
  })

  it("production and a key: the eve bridge's refusal for a part P1 cannot carry logs the alert and reports the key reason", async () => {
    const { PROVIDER_KEY_IN_RUNTIME_REASON } = await guard()
    const { committeeBrainLanguageModel } = await import("@/platform/p1/committeeBrainModel")
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE)
    const result = await committeeBrainLanguageModel.doGenerate({
      prompt: [{ role: "user", content: [{ type: "file", data: "aGVsbG8=", mediaType: "text/plain" }] }],
      providerOptions: { sikander: { classification: "public" } },
    })
    const text = result.content.map((p) => ("text" in p ? p.text : "")).join("")
    expect(alerts(spy)).toHaveLength(1)
    expect(text).toContain(PROVIDER_KEY_IN_RUNTIME_REASON)
  })

  it("without a key the bridge's refusals keep their own reasons and log no alert", async () => {
    const { committeeBrainLanguageModel } = await import("@/platform/p1/committeeBrainModel")
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("NODE_ENV", "production")
    const missing = await committeeBrainLanguageModel.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Summarise." }] }] })
    expect(missing.content.map((p) => ("text" in p ? p.text : "")).join("")).toContain("classification missing")
    const file = await committeeBrainLanguageModel.doGenerate({
      prompt: [{ role: "user", content: [{ type: "file", data: "aGVsbG8=", mediaType: "text/plain" }] }],
      providerOptions: { sikander: { classification: "public" } },
    })
    expect(file.content.map((p) => ("text" in p ? p.text : "")).join("")).toContain("P1 cannot carry file parts")
    expect(alerts(spy)).toHaveLength(0)
  })

  it("outside production with a key, a call that reaches the transport logs the alert once (no double alert)", async () => {
    await guard()
    const { committeeBrainLanguageModel } = await import("@/platform/p1/committeeBrainModel")
    const { setTransportForTests } = await import("@/platform/p1/internalAICaller")
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE)
    setTransportForTests({ send: async () => ({ text: "stub" }) })
    try {
      const result = await committeeBrainLanguageModel.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Summarise." }] }],
        providerOptions: { sikander: { classification: "public" } },
      })
      expect(result.finishReason.unified).toBe("stop")
      expect(alerts(spy)).toHaveLength(1)
    } finally {
      setTransportForTests(null)
    }
  })
})
