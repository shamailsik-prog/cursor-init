import { afterEach, describe, expect, it, vi } from "vitest"
import { ingressSettings, ingressWarning, trustedProxyHops } from "../src/deployConfig"
import { header } from "../src/http/headers"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

describe("deploy config: proxy hops and ingress", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it("TRUSTED_PROXY_HOPS: a non-negative integer, else 0", () => {
    expect(trustedProxyHops({})).toBe(0)
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "2" })).toBe(2)
    for (const bad of ["", "-1", "1.5", "x"]) expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: bad })).toBe(0)
  })

  it("SIKANDER_INGRESS_SETTINGS: default ALLOW_ALL; the three Cloud Functions values; anything else throws", () => {
    expect(ingressSettings({})).toBe("ALLOW_ALL")
    expect(ingressSettings({ TRUSTED_PROXY_HOPS: "1" })).toBe("ALLOW_ALL")
    for (const v of ["ALLOW_ALL", "ALLOW_INTERNAL_ONLY", "ALLOW_INTERNAL_AND_GCLB"] as const) {
      expect(ingressSettings({ SIKANDER_INGRESS_SETTINGS: v })).toBe(v)
    }
    expect(() => ingressSettings({ SIKANDER_INGRESS_SETTINGS: "allow_all" })).toThrow(/SIKANDER_INGRESS_SETTINGS/)
  })

  it("warns only when proxy hops are trusted but ingress still allows direct traffic", () => {
    expect(ingressWarning({})).toBeUndefined()
    expect(ingressWarning({ TRUSTED_PROXY_HOPS: "1", SIKANDER_INGRESS_SETTINGS: "ALLOW_INTERNAL_AND_GCLB" })).toBeUndefined()
    expect(ingressWarning({ TRUSTED_PROXY_HOPS: "1" })).toMatch(/ALLOW_INTERNAL_AND_GCLB/)
  })

  it("the warning is logged when the module loads", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1")
    vi.stubEnv("SIKANDER_INGRESS_SETTINGS", "ALLOW_ALL")
    const { logger } = await import("firebase-functions")
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    await import("../src/deployConfig")
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/TRUSTED_PROXY_HOPS/))
  })

  it("api carries the configured ingress (default ALLOW_ALL)", async () => {
    const index = (await import("../src/index")) as Record<string, { __endpoint?: { ingressSettings?: string; httpsTrigger?: unknown } }>
    // Ingress applies to HTTP functions; the job runtime's trigger, queue and schedule functions have none.
    const http = Object.keys(index).filter((n) => n !== "health" && index[n].__endpoint?.httpsTrigger !== undefined)
    expect(http).toContain("api")
    for (const name of http) {
      expect([name, index[name].__endpoint?.ingressSettings]).toEqual([name, "ALLOW_ALL"])
    }
  })

  it("every deployed function runs in asia-south1 (L910), as the deploy tool reads the built bundle", () => {
    // In the bundle, setGlobalOptions in index.ts runs after the imported function objects are built,
    // so it never reaches them: a function without its own region deploys to the platform default.
    // Vitest caches firebase-functions across imports and cannot see this, so the bundle is built and
    // loaded in a fresh Node process, the way `firebase deploy` discovers the endpoints.
    const cwd = path.resolve(__dirname, "..")
    execFileSync(process.execPath, ["build.mjs"], { cwd, stdio: "ignore" })
    const out = execFileSync(
      process.execPath,
      ["-e", "const m=require('./lib/index.js');const r={};for(const k of Object.keys(m)){const e=m[k]&&m[k].__endpoint;if(e)r[k]=e.region??null}console.log(JSON.stringify(r))"],
      { cwd, encoding: "utf8" }
    )
    const regions = JSON.parse(out.trim().split("\n").pop() as string) as Record<string, string[] | null>
    expect(Object.keys(regions)).toEqual(expect.arrayContaining(["api", "health", "onJobCreated", "onEventCreated", "jobWorker", "jobSweeper"]))
    for (const [name, region] of Object.entries(regions)) expect([name, region]).toEqual([name, ["asia-south1"]])
  }, 60_000)

  it("the deployable bundle pins NODE_ENV to production: no runtime NODE_ENV read is left in lib/index.js", () => {
    // Defence in depth for the P1 test seams (p1TestSeam, p1OpsTestSeam): production code never references them,
    // and the bundle cannot make them live even on a host that sets NODE_ENV to something else.
    const cwd = path.resolve(__dirname, "..")
    execFileSync(process.execPath, ["build.mjs"], { cwd, stdio: "ignore" })
    const bundle = readFileSync(path.join(cwd, "lib/index.js"), "utf8")
    expect(bundle).toContain("p1TestSeam")
    expect(bundle).toContain("p1OpsTestSeam")
    expect(bundle).not.toMatch(/process\.env\.NODE_ENV|process\.env\[["']NODE_ENV["']\]/)
  }, 60_000)

  it("api picks up SIKANDER_INGRESS_SETTINGS at load", async () => {
    vi.stubEnv("SIKANDER_INGRESS_SETTINGS", "ALLOW_INTERNAL_AND_GCLB")
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1")
    const { api } = await import("../src/http/router")
    expect((api as unknown as { __endpoint: { ingressSettings?: string } }).__endpoint.ingressSettings).toBe("ALLOW_INTERNAL_AND_GCLB")
  })
})

describe("http/headers", () => {
  it("imports nothing (a leaf module: no import cycle through it)", () => {
    const src = readFileSync(path.join(__dirname, "../src/http/headers.ts"), "utf8")
    expect(src).not.toMatch(/^\s*import\s/m)
  })

  it("header(): case-insensitive, first value of a repeated header", () => {
    expect(header({ "X-Firm-Id": "f1" }, "x-firm-id")).toBe("f1")
    expect(header({ "x-a": ["1", "2"] }, "X-A")).toBe("1")
    expect(header({}, "x")).toBeUndefined()
  })
})
