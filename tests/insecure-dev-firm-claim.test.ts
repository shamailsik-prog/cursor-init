import { afterEach, describe, expect, it, vi } from "vitest"
import { assertInsecureDevAuthContext } from "@/platform/p5/insecureDevAuth"
import { resetSessionStateForTests } from "@/platform/p5/session"

describe("insecure-dev firm claim helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetSessionStateForTests()
  })

  it("hard-fails under production NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_AUTH_MODE", "insecure-dev")
    expect(() => assertInsecureDevAuthContext("claimedFirmIdForInsecureDev")).toThrow(
      /not in production or firebase auth mode/
    )
  })

  it("hard-fails under firebase auth mode", () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    expect(() => assertInsecureDevAuthContext("claimedFirmIdForInsecureDev")).toThrow(
      /not in production or firebase auth mode/
    )
  })
})
