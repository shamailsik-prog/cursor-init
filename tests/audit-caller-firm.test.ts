import { describe, expect, it } from "vitest"
import {
  CallerFirmRequiredError,
  requireCallerFirmId,
} from "@/platform/persistence/callerFirm"
import { bindRouteRepos } from "@/platform/persistence/forFirm"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"

describe("caller firm enforcement (FA-F01-002)", () => {
  it("requireCallerFirmId throws on empty or missing firm", () => {
    expect(() => requireCallerFirmId("")).toThrow(CallerFirmRequiredError)
    expect(() => requireCallerFirmId("   ")).toThrow(CallerFirmRequiredError)
    expect(() => requireCallerFirmId(undefined)).toThrow(CallerFirmRequiredError)
  })

  it("bindRouteRepos throws on empty firm", () => {
    const repos = createFirestoreRepositories({} as never)
    expect(() => bindRouteRepos(repos, "")).toThrow(CallerFirmRequiredError)
  })

  it("get returns null for cross-firm id and for empty caller firm", async () => {
    const store = new Map<string, { id: string; firmId: string; title: string }>([
      ["m1", { id: "m1", firmId: "firmA", title: "A" }],
    ])
    const db = {
      collection: () => ({
        doc: (id: string) => ({
          get: async () => ({
            exists: store.has(id),
            data: () => store.get(id),
          }),
        }),
      }),
    }
    const repos = createFirestoreRepositories(db as never)
    await expect(repos.matters.get("m1", "")).rejects.toThrow(CallerFirmRequiredError)
    expect(await repos.matters.get("m1", "firmB")).toBeNull()
  })

  it("a row with no firmId belongs to no firm: get and update refuse it for every caller (fail closed)", async () => {
    const store = new Map<string, Record<string, unknown>>([["m1", { id: "m1", title: "orphan" }]])
    let updates = 0
    const db = {
      collection: () => ({
        doc: (id: string) => ({
          get: async () => ({ exists: store.has(id), data: () => store.get(id) }),
          update: async () => {
            updates += 1
          },
        }),
      }),
    }
    const repos = createFirestoreRepositories(db as never)
    expect(await repos.matters.get("m1", "firmA")).toBeNull()
    expect(await repos.matters.update("m1", "firmA", { title: "claimed" })).toBeNull()
    expect(updates).toBe(0)
  })

  it("F01: a users row written without an `id` (the Functions writers' shape) comes back under its document id", async () => {
    const store = new Map<string, Record<string, unknown>>([
      ["uid_1", { firmId: "firmA", role: "partner", clearanceLevel: "privileged-restricted", mfaEnabled: false, active: true }],
      ["uid_2", { id: "someone_else", firmId: "firmA", role: "associate", clearanceLevel: "privileged", active: true }],
    ])
    const db = {
      collection: () => ({
        doc: (id: string) => ({ get: async () => ({ exists: store.has(id), data: () => store.get(id) }) }),
      }),
    }
    const repos = createFirestoreRepositories(db as never)
    expect(await repos.users.get("uid_1", "firmA")).toMatchObject({ id: "uid_1", firmId: "firmA", role: "partner" })
    // The document id is authoritative over an `id` field in the data.
    expect((await repos.users.get("uid_2", "firmA"))?.id).toBe("uid_2")
    expect((await repos.users.get("uid_1", ""))?.id).toBe("uid_1")
    expect(await repos.users.get("uid_1", "firmB")).toBeNull()
  })
})
