import { describe, expect, it } from "vitest"
import { isProdLikeFunctionsRuntime } from "../src/deployRuntimeProfile"
import { isProdLikeOcrRuntime, resolveOcrEngine, DeterministicLocalOcrEngine } from "../src/p1/ocrEngine"

describe("FA-F04-006-002: prod-like runtime profile buckets off-bundle", () => {
  it.each(["prod", "stage", "unknown", "production", "staging"])("treats SIKANDER_DEPLOY_PROFILE=%s as prod-like", (profile) => {
    const env = { NODE_ENV: "test", SIKANDER_DEPLOY_PROFILE: profile }
    expect(isProdLikeFunctionsRuntime(env)).toBe(true)
    expect(isProdLikeOcrRuntime(env)).toBe(true)
    expect(resolveOcrEngine(env)).toBeNull()
  })

  it("normalizes NODE_ENV case off-bundle", () => {
    expect(isProdLikeFunctionsRuntime({ NODE_ENV: "Production" })).toBe(true)
    expect(resolveOcrEngine({ NODE_ENV: "PRODUCTION" })).toBeNull()
  })

  it("FA-F04-006-002-001: normalizes host process.env.NODE_ENV case when env arg omits NODE_ENV", () => {
    const saved = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = "Production"
      const envWithoutNodeEnv: Record<string, string | undefined> = {}
      expect(isProdLikeFunctionsRuntime(envWithoutNodeEnv)).toBe(true)
      expect(resolveOcrEngine(envWithoutNodeEnv)).toBeNull()
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = saved
    }
  })

  it("treats an unrecognized deploy profile on a hosted runtime as prod-like (unknown bucket)", () => {
    const env = {
      NODE_ENV: "test",
      K_SERVICE: "api",
      SIKANDER_DEPLOY_PROFILE: "not-a-manifest-profile",
    }
    expect(isProdLikeFunctionsRuntime(env)).toBe(true)
    expect(resolveOcrEngine(env)).toBeNull()
  })

  it("keeps explicit local/dev profiles non-prod-like off-bundle", () => {
    const env = { NODE_ENV: "test", SIKANDER_DEPLOY_PROFILE: "local" }
    expect(isProdLikeFunctionsRuntime(env)).toBe(false)
    expect(resolveOcrEngine(env)).toBeInstanceOf(DeterministicLocalOcrEngine)
  })
})
