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
})
