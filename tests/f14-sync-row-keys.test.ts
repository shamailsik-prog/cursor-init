import { describe, expect, it } from "vitest"
import { syncFirmMatters, syncFirmMembers } from "@/platform/persistence/memberSync"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import { newStore } from "@/platform/spine/store"

/**
 * Audit F14 R8: the syncs cache a row only under a usable key. A matter without a non-empty string `id`, or a membership
 * without a non-empty string `matterId` and `userId`, is skipped (never cached under `undefined` or "undefined_<uid>"),
 * and the sync carries on with the other rows.
 */

const matter = (id: unknown) => ({ id, firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", caseNumber: null, caseNumberStatus: "pending", status: "live", classification: "internal" })
const member = (matterId: unknown, userId: unknown) => ({ matterId, userId, firmId: "firmA" })

function reposListing(matters: unknown[], members: unknown[]): SpineRepositories {
  return {
    matters: { listByFirm: async () => matters },
    members: { listByFirm: async () => members },
  } as unknown as SpineRepositories
}

describe("Audit F14 R8: the syncs never cache a row under a missing or empty key", () => {
  it("syncFirmMatters skips a matter without a non-empty string id and caches the others", async () => {
    const store = newStore()
    const repos = reposListing([matter(undefined), matter(""), matter(42), matter(null), matter("mat_ok")], [])
    await syncFirmMatters(store, repos, "firmA")
    expect([...store.matters.keys()]).toEqual(["mat_ok"])
  })

  it("syncFirmMembers skips a membership without a non-empty string matterId and userId and caches the others", async () => {
    const store = newStore()
    const repos = reposListing([], [member(undefined, "u1"), member("mat_ok", undefined), member("", "u1"), member("mat_ok", ""), member(7, "u1"), member("mat_ok", "u1")])
    await syncFirmMembers(store, repos, "firmA")
    expect([...store.members.keys()]).toEqual([store.memberKey("mat_ok", "u1")])
  })
})
