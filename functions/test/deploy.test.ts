import { afterEach, describe, expect, it, vi } from "vitest"
import { ingressSettings, ingressWarning, trustedProxyHops } from "../src/deployConfig"
import { header } from "../src/http/headers"
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
