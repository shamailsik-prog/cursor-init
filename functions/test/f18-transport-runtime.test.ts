import { readFileSync } from "node:fs"
import path from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import * as transport from "../src/p1/transport"
import { installNetworkTripwire } from "@/tests/helpers/network-tripwire"

/**
 * Audit F18 re-audit follow-up, FA-F18-001(b) (spec ruling R13): the Cloud Functions P1 transport builds a paid
 * transport only inside the Functions runtime. The signal is a compile-time constant that functions/build.mjs defines in
 * the bundles it builds (functions/runtime-define.mjs: lib/index.js, which the deployed `api` function and the emulator
 * load, and the operator CLIs). No environment variable can set it, so a process that is not the Functions bundle (Next
 * importing functions/src/p1/transport, attack P17; this test runner) gets no paid transport even with a key: it gets
 * none, and an alert line that names the variable and never its value. Tests that exercise the real transport against a
 * loopback server opt in with an explicit allowance, which only NODE_ENV=test accepts.
 *
 * This file runs outside the bundle, as P17's Next route would. Nothing can leave: the key is an obviously fake
 * placeholder, every `fetch` here is a recorder that answers locally or refuses, and the shared tripwire refuses every
 * non-loopback fetch and socket from the moment this file loads. Exports new in the follow-up are read through the
 * module namespace, so on main this file runs and its assertions fail.
 */

const tripwire = installNetworkTripwire()

afterAll(() => {
  tripwire.uninstall()
})

const FAKE_KEY = "placeholder-not-a-key"
const REQUEST = { model: "anthropic/claude-opus-5.5", messages: [{ role: "user" as const, content: "Summarise the order." }], maxTokens: 16 }
const KEY_ALERT = "p1.provider_key_in_next_runtime"

type FollowUp = {
  setPaidTransportAllowedForTests?: (on: boolean) => void
  inFunctionsRuntime?: () => boolean
  PAID_TRANSPORT_OUTSIDE_FUNCTIONS_REASON?: string
}
const followUp = transport as unknown as FollowUp

type Recorded = { url: string; authorization: string | null }

/** A fetch that records what a transport would send and refuses it: nothing reaches a network. */
function refusingRecorder(): Recorded[] {
  const recorded: Recorded[] = []
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    recorded.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") })
    throw new TypeError("recorder: refused")
  })
  return recorded
}

function alertLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
}

afterEach(() => {
  vi.unstubAllEnvs() // first: the seams refuse to be set unless NODE_ENV is "test"
  followUp.setPaidTransportAllowedForTests?.(false)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  transport.setP1TransportForTests(null)
})

describe("audit F18 follow-up: the Functions P1 transport outside the Functions runtime (FA-F18-001b)", () => {
  it("P17: in production with a key, activeTransport() builds no transport, logs the alert, and nothing is sent", async () => {
    const recorded = refusingRecorder()
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_KEY)
    const built = transport.activeTransport()
    const outcome = built === null ? "no transport" : await built.send(REQUEST).then(() => "answered", (err: unknown) => `send failed: ${(err as Error).message}`)
    console.info(`[F18 follow-up] P17 probe: ${JSON.stringify({ outcome, recorded: recorded.map((r) => ({ url: r.url, bearer: r.authorization?.startsWith("Bearer ") ?? false })) })}`)
    expect(outcome).toBe("no transport")
    expect(recorded, "requests a transport built").toEqual([])
    expect(tripwire.refused).toEqual([])
    const alerts = alertLines(spy).filter((l) => l.includes(KEY_ALERT))
    expect(alerts, "the alert line").toHaveLength(1)
    expect(alerts[0]).toContain("AI_GATEWAY_API_KEY")
    expect(alerts[0]).not.toContain(FAKE_KEY)
  })

  it("with a key under NODE_ENV=test and no allowance: still no transport", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_KEY)
    expect(transport.activeTransport()).toBeNull()
  })

  it("gatewayTransport() refuses to build outside the runtime, in production and in tests alike", async () => {
    const recorded = refusingRecorder()
    const attempt = (): string => {
      try {
        transport.gatewayTransport(FAKE_KEY)
        return "built"
      } catch (err) {
        return `refused: ${(err as Error).message}`
      }
    }
    vi.stubEnv("NODE_ENV", "production")
    const inProduction = attempt()
    vi.stubEnv("NODE_ENV", "test")
    const inTest = attempt()
    expect(followUp.PAID_TRANSPORT_OUTSIDE_FUNCTIONS_REASON, "the documented reason").toBeDefined()
    expect(inProduction).toBe(`refused: ${followUp.PAID_TRANSPORT_OUTSIDE_FUNCTIONS_REASON}`)
    expect(inTest).toBe(`refused: ${followUp.PAID_TRANSPORT_OUTSIDE_FUNCTIONS_REASON}`)
    expect(followUp.PAID_TRANSPORT_OUTSIDE_FUNCTIONS_REASON).not.toContain(FAKE_KEY)
    expect(recorded).toEqual([])
  })

  it("reports that this process is not the Functions runtime", () => {
    expect(followUp.inFunctionsRuntime, "inFunctionsRuntime is exported").toBeDefined()
    expect(followUp.inFunctionsRuntime!()).toBe(false)
  })

  it("the test-only allowance: accepted only under NODE_ENV=test, and inert once NODE_ENV is anything else", () => {
    expect(followUp.setPaidTransportAllowedForTests, "the allowance exists").toBeDefined()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    for (const nodeEnv of ["production", "development", "staging"]) {
      vi.stubEnv("NODE_ENV", nodeEnv)
      expect(() => followUp.setPaidTransportAllowedForTests!(true), nodeEnv).toThrow("setPaidTransportAllowedForTests is test-only")
    }
    vi.stubEnv("NODE_ENV", "test")
    followUp.setPaidTransportAllowedForTests!(true)
    expect(typeof transport.gatewayTransport(FAKE_KEY).send).toBe("function")
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_KEY)
    expect(transport.activeTransport()).not.toBeNull()
    // Set while NODE_ENV was "test", then production: the allowance no longer counts.
    vi.stubEnv("NODE_ENV", "production")
    expect(() => transport.gatewayTransport(FAKE_KEY)).toThrow()
    expect(transport.activeTransport()).toBeNull()
  })

  it("the fake-transport seam still serves tests outside the runtime (the in-process Functions router in the F18 e2e)", async () => {
    const fake = { send: async () => ({ text: "fake", inputTokens: 1, outputTokens: 1 }) }
    transport.setP1TransportForTests(fake)
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_KEY)
    expect(transport.activeTransport()).toBe(fake)
  })
})

describe("audit F18 follow-up: inside the Functions bundle the transport is unchanged (spec ruling R13)", () => {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const functionsDir = path.resolve(here, "..")

  it("bundled with functions/build.mjs's runtime define, activeTransport() sends to the Gateway with the bearer key", async () => {
    const defineModule = (await import(path.join(functionsDir, "runtime-define.mjs")).catch(() => null)) as { FUNCTIONS_RUNTIME_DEFINE?: Record<string, string> } | null
    expect(defineModule?.FUNCTIONS_RUNTIME_DEFINE, "functions/runtime-define.mjs exports FUNCTIONS_RUNTIME_DEFINE").toBeDefined()
    const { build } = await import("esbuild")
    const out = await build({
      entryPoints: [path.join(functionsDir, "src/p1/transport.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      target: "node22",
      alias: { "@": path.resolve(functionsDir, "..") },
      define: { "process.env.NODE_ENV": '"production"', ...defineModule!.FUNCTIONS_RUNTIME_DEFINE },
      logLevel: "silent",
    })
    const code = out.outputFiles[0]!.text
    const mod: { exports: Record<string, unknown> } = { exports: {} }
    new Function("module", "exports", "require", code)(mod, mod.exports, () => {
      throw new Error("the transport bundle requires nothing at run time")
    })
    const bundled = mod.exports as typeof transport & FollowUp
    expect(bundled.inFunctionsRuntime?.()).toBe(true)

    const recorded: Recorded[] = []
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      recorded.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") })
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    })
    vi.stubEnv("AI_GATEWAY_API_KEY", FAKE_KEY)
    const built = bundled.activeTransport()
    expect(built, "the deployed bundle builds the Gateway transport").not.toBeNull()
    expect((await built!.send(REQUEST)).text).toBe("ok")
    expect(recorded).toEqual([{ url: transport.GATEWAY_URL, authorization: `Bearer ${FAKE_KEY}` }])
    expect(tripwire.refused).toEqual([])
  })

  it("functions/build.mjs applies the runtime define to the deployed bundle and to the operator CLIs", () => {
    const source = readFileSync(path.join(functionsDir, "build.mjs"), "utf8")
    expect(source).toMatch(/import \{ FUNCTIONS_RUNTIME_DEFINE \} from "\.\/runtime-define\.mjs"/)
    const indexBuild = source.slice(source.indexOf('entryPoints: [path.join(here, "src/index.ts")]'))
    expect(indexBuild.slice(0, indexBuild.indexOf("})"))).toMatch(/define: \{ "process\.env\.NODE_ENV": '"production"', \.\.\.FUNCTIONS_RUNTIME_DEFINE \}/)
    const cliBuild = source.slice(source.indexOf("for (const cli of"))
    expect(cliBuild.slice(0, cliBuild.indexOf("})"))).toMatch(/define: FUNCTIONS_RUNTIME_DEFINE/)
  })
})
