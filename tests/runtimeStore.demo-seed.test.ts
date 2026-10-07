// SEC-5 (final security audit): the demo identities (partner_a … in firmA, partner_b in firmB) were
// seeded into the runtime store whatever NODE_ENV was, so a production memory-mode process
// authenticated a Firebase uid "partner_a" as a firmA partner and held a second firm (R-5).
// A production process now starts with an empty store.
import { afterEach, describe, expect, it, vi } from "vitest"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

afterEach(() => {
  vi.unstubAllEnvs()
  resetRuntimeStoreForTests()
})

describe("SEC-5 demo seed", () => {
  it("a production process starts with no users", () => {
    vi.stubEnv("NODE_ENV", "production")
    resetRuntimeStoreForTests()
    const store = getRuntimeStore()
    expect(store.users.get("partner_a")).toBeUndefined()
    expect(store.users.get("partner_b")).toBeUndefined()
    expect(store.users.size).toBe(0)
  })

  it("SIKANDER_SEED_DEMO=true does not seed a production process either", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_SEED_DEMO", "true")
    resetRuntimeStoreForTests()
    expect(getRuntimeStore().users.size).toBe(0)
  })

  it("test and development processes keep the demo identities", () => {
    for (const env of ["test", "development"]) {
      vi.stubEnv("NODE_ENV", env)
      resetRuntimeStoreForTests()
      expect(getRuntimeStore().users.get("partner_a")).toMatchObject({ firmId: "firmA", role: "partner" })
      expect(getRuntimeStore().users.get("partner_b")).toMatchObject({ firmId: "firmB" })
    }
  })
})
