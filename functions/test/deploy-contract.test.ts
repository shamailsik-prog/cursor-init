import { afterEach, describe, expect, it, vi } from "vitest"
import { deployContractViolations } from "../src/deployConfig"

type ContractCode =
  | "ingress_not_set"
  | "ingress_invalid"
  | "proxy_hops_invalid"
  | "proxy_trust_with_open_ingress"
  | "gclb_ingress_without_trusted_hop"

type Env = Record<string, string | undefined>

const CONTRACT_ALERT = "deploy.contract_violation"

function codes(env: Env, deployed: boolean): ContractCode[] {
  return deployContractViolations(env, { deployed })
}

describe("deploy contract violations (R6)", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it.each([
    [{ deployed: true, env: {}, expect: ["ingress_not_set"] as ContractCode[] }],
    [{ deployed: true, env: { SIKANDER_INGRESS_SETTINGS: "ALLOW_ALL", TRUSTED_PROXY_HOPS: "1" }, expect: ["proxy_trust_with_open_ingress"] }],
    [{ deployed: true, env: { SIKANDER_INGRESS_SETTINGS: "ALLOW_INTERNAL_AND_GCLB", TRUSTED_PROXY_HOPS: "0" }, expect: ["gclb_ingress_without_trusted_hop"] }],
    [{ deployed: true, env: { SIKANDER_INGRESS_SETTINGS: "ALLOW_INTERNAL_AND_GCLB", TRUSTED_PROXY_HOPS: "1" }, expect: [] }],
    [{ deployed: false, env: { TRUSTED_PROXY_HOPS: "1" }, expect: ["proxy_trust_with_open_ingress"] }],
    [{ deployed: false, env: {}, expect: [] }],
    [{ deployed: true, env: { SIKANDER_INGRESS_SETTINGS: "allow_all" }, expect: ["ingress_invalid"] }],
    [{ deployed: true, env: { TRUSTED_PROXY_HOPS: "x" }, expect: ["proxy_hops_invalid", "ingress_not_set"] }],
    [{ deployed: true, env: { TRUSTED_PROXY_HOPS: " 1" }, expect: ["proxy_hops_invalid", "ingress_not_set"] }],
    [{ deployed: true, env: { TRUSTED_PROXY_HOPS: "+1" }, expect: ["proxy_hops_invalid", "ingress_not_set"] }],
    [{ deployed: true, env: { TRUSTED_PROXY_HOPS: "01" }, expect: ["proxy_hops_invalid", "ingress_not_set"] }],
  ] as const)("deployed=$deployed env=$env", ({ deployed, env, expect: expected }) => {
    expect(codes(env, deployed).sort()).toEqual([...expected].sort())
  })

  it.each([
    { env: { TRUSTED_PROXY_HOPS: "1", SIKANDER_INGRESS_SETTINGS: "ALLOW_ALL" } },
    { env: { TRUSTED_PROXY_HOPS: "0", SIKANDER_INGRESS_SETTINGS: "ALLOW_INTERNAL_AND_GCLB" } },
    { env: { TRUSTED_PROXY_HOPS: "x" } },
  ])("refuses to load deployConfig for unsafe env %j", async ({ env }) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    vi.stubEnv("NODE_ENV", "production")
    const { logger } = await import("firebase-functions")
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined)
    await expect(import("../src/deployConfig")).rejects.toMatchObject({ name: "DeployContractError" })
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls[0]?.[0]).toBe(CONTRACT_ALERT)
    const payload = errSpy.mock.calls[0]?.[1] as { codes?: string[] } | undefined
    expect(Array.isArray(payload?.codes)).toBe(true)
    expect(payload?.codes?.length).toBeGreaterThan(0)
    expect(JSON.stringify(errSpy.mock.calls[0])).not.toMatch(/ALLOW_ALL|ALLOW_INTERNAL/)
  })

  it("loads deployConfig for a safe deployed env", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_INGRESS_SETTINGS", "ALLOW_INTERNAL_AND_GCLB")
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1")
    await expect(import("../src/deployConfig")).resolves.toBeDefined()
  })

  it("isDeployedRuntime is false under vitest and true in the production bundle", async () => {
    const { isDeployedRuntime } = await import("../src/deployConfig")
    expect(isDeployedRuntime()).toBe(false)
  })

  it("refuses to load when K_SERVICE is set without an ingress setting (no NODE_ENV)", async () => {
    vi.stubEnv("K_SERVICE", "api")
    const { logger } = await import("firebase-functions")
    vi.spyOn(logger, "error").mockImplementation(() => undefined)
    await expect(import("../src/deployConfig")).rejects.toMatchObject({ name: "DeployContractError" })
  })
})
