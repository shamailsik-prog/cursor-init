// Audit F10 (spec §2.1): the idempotency backend follows SIKANDER_PERSISTENCE_MODE with the F01 rules, and production
// fails closed. There is no silent fallback to the in-process Map.
import { afterEach, describe, expect, it, vi } from "vitest"
import { beginIdempotentRequest, resetIdempotencyForTests } from "@/platform/http/idempotency"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { PersistenceConfigurationError } from "@/platform/persistence/errors"
import { resolvePersistenceMode, setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"

const KEY = "5f0f0f0f-0000-4000-8000-000000000010"
const post = () => new Request("http://127.0.0.1/api/f10/thing", { method: "POST" })

afterEach(() => {
  vi.unstubAllEnvs()
  resetProductionFirestoreForTests()
  setFirestorePersistenceForTests(null)
  resetIdempotencyForTests()
})

describe("F10: the idempotency backend is selected like the repositories, and fails closed", () => {
  it("memory mode is refused in production: no claim is taken", async () => {
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "memory")
    vi.stubEnv("NODE_ENV", "production")
    expect(() => resolvePersistenceMode()).toThrow(PersistenceConfigurationError)
    await expect(beginIdempotentRequest(post(), KEY, "fp")).rejects.toBeInstanceOf(PersistenceConfigurationError)
  })

  it("an unset mode outside the test runner is refused: there is no silent in-memory default", async () => {
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "")
    vi.stubEnv("VITEST", "")
    await expect(beginIdempotentRequest(post(), KEY, "fp")).rejects.toBeInstanceOf(PersistenceConfigurationError)
  })

  it("firestore mode with no database configured is refused, not served from the Map", async () => {
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "")
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "")
    await expect(beginIdempotentRequest(post(), KEY, "fp")).rejects.toBeInstanceOf(PersistenceConfigurationError)
    // The same key is still unclaimed in memory: nothing fell back to the Map.
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "memory")
    expect((await beginIdempotentRequest(post(), KEY, "fp")).claim).toBeDefined()
  })

  it("an unknown mode is refused", async () => {
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "redis")
    await expect(beginIdempotentRequest(post(), KEY, "fp")).rejects.toBeInstanceOf(PersistenceConfigurationError)
  })

  it("memory mode (outside production) and the test runner's unset mode use the Map", async () => {
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "memory")
    expect(resolvePersistenceMode()).toBe("memory")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "")
    expect(resolvePersistenceMode()).toBe("memory")
    const first = await beginIdempotentRequest(post(), KEY, "fp")
    first.claim!.complete({ ok: 1 })
    expect(await (await beginIdempotentRequest(post(), KEY, "fp")).response!.json()).toEqual({ result: { ok: 1 }, idempotencyKey: KEY, reused: true })
  })
})
