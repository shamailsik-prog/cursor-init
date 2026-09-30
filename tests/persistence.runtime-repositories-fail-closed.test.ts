import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  getRuntimeRepositories,
  PersistenceConfigurationError,
  setFirestorePersistenceForTests,
} from "@/platform/persistence/runtimeRepositories"
import { newStore } from "@/platform/spine/store"

const env = process.env as Record<string, string | undefined>
const saved = {
  mode: env.SIKANDER_PERSISTENCE_MODE,
  nodeEnv: env.NODE_ENV,
  vitest: env.VITEST,
  allowMemoryInProduction: env.SIKANDER_ALLOW_MEMORY_IN_PRODUCTION,
}

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete env[key]
  else env[key] = value
}

beforeEach(() => {
  setFirestorePersistenceForTests(null)
})

afterEach(() => {
  restore("SIKANDER_PERSISTENCE_MODE", saved.mode)
  restore("NODE_ENV", saved.nodeEnv)
  restore("VITEST", saved.vitest)
  restore("SIKANDER_ALLOW_MEMORY_IN_PRODUCTION", saved.allowMemoryInProduction)
  setFirestorePersistenceForTests(null)
})

describe("runtime repositories fail closed", () => {
  it("throws a configuration error in firestore mode when no database is configured", async () => {
    env.SIKANDER_PERSISTENCE_MODE = "firestore"
    const store = newStore()
    await expect(getRuntimeRepositories(store)).rejects.toBeInstanceOf(
      PersistenceConfigurationError
    )
    await expect(getRuntimeRepositories(store)).rejects.toThrow(/firestore/i)
    await expect(getRuntimeRepositories(store)).rejects.toThrow(/firebase-admin/)
  })

  it("does not silently fall back to memory for firestore mode (case/whitespace-insensitive)", async () => {
    env.SIKANDER_PERSISTENCE_MODE = "  FireStore "
    await expect(getRuntimeRepositories(newStore())).rejects.toBeInstanceOf(
      PersistenceConfigurationError
    )
  })

  it("rejects an unknown persistence mode instead of defaulting to memory", async () => {
    env.SIKANDER_PERSISTENCE_MODE = "firestor"
    await expect(getRuntimeRepositories(newStore())).rejects.toBeInstanceOf(
      PersistenceConfigurationError
    )
  })

  it("uses memory repositories when memory mode is explicit", async () => {
    env.SIKANDER_PERSISTENCE_MODE = "memory"
    const store = newStore()
    const repos = await getRuntimeRepositories(store)
    await repos.matters.create({
      id: "mat_mem",
      firmId: "firmA",
      clientId: "client_a",
      title: "Memory matter",
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      status: "engagement_unconfirmed",
      classification: "internal",
    })
    expect(store.matters.get("mat_mem")?.title).toBe("Memory matter")
  })

  it("defaults to memory only on the test-runner path when the mode is unset", async () => {
    delete env.SIKANDER_PERSISTENCE_MODE
    await expect(getRuntimeRepositories(newStore())).resolves.toBeDefined()
  })

  it("fails closed outside the test runner when the mode is unset", async () => {
    delete env.SIKANDER_PERSISTENCE_MODE
    delete env.VITEST
    env.NODE_ENV = "production"
    await expect(getRuntimeRepositories(newStore())).rejects.toBeInstanceOf(
      PersistenceConfigurationError
    )
    await expect(getRuntimeRepositories(newStore())).rejects.toThrow(
      /SIKANDER_PERSISTENCE_MODE=memory/
    )
  })

  it.each([
    ["VITEST unset under NODE_ENV=test", undefined, "test"],
    ["VITEST=false", "false", "test"],
    ["VITEST empty", "", "test"],
    ["VITEST=true but NODE_ENV=production", "true", "production"],
  ])("fails closed with an unset mode when %s", async (_label, vitest, nodeEnv) => {
    delete env.SIKANDER_PERSISTENCE_MODE
    restore("VITEST", vitest)
    env.NODE_ENV = nodeEnv
    await expect(getRuntimeRepositories(newStore())).rejects.toBeInstanceOf(
      PersistenceConfigurationError
    )
  })

  it("refuses explicit memory mode in production without the opt-in", async () => {
    env.SIKANDER_PERSISTENCE_MODE = "memory"
    env.NODE_ENV = "production"
    delete env.SIKANDER_ALLOW_MEMORY_IN_PRODUCTION
    await expect(getRuntimeRepositories(newStore())).rejects.toThrow(
      /SIKANDER_ALLOW_MEMORY_IN_PRODUCTION=true/
    )
    env.SIKANDER_ALLOW_MEMORY_IN_PRODUCTION = "1"
    await expect(getRuntimeRepositories(newStore())).rejects.toBeInstanceOf(
      PersistenceConfigurationError
    )
  })

  it("allows explicit memory mode in production only with SIKANDER_ALLOW_MEMORY_IN_PRODUCTION=true", async () => {
    env.SIKANDER_PERSISTENCE_MODE = "memory"
    env.NODE_ENV = "production"
    env.SIKANDER_ALLOW_MEMORY_IN_PRODUCTION = "true"
    await expect(getRuntimeRepositories(newStore())).resolves.toBeDefined()
  })
})
