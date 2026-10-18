import { afterEach, describe, expect, it, vi } from "vitest"
import { POST as mattersPost } from "@/app/api/d1/matters/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

/**
 * Audit F14 R7: the matters route persists a membership before it caches it, so a failed membership write leaves
 * nothing cached (and no `matter_member_add` audit row), with the route's error contract unchanged: 400
 * `{ error: "matter operation failed", code: "REQUEST_FAILED" }`. The memory repository's membership write is made to
 * fail for the users named in `failing`.
 */

const failing = vi.hoisted(() => ({ userIds: new Set<string>() }))

vi.mock("@/platform/persistence/spineRepositories", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/platform/persistence/spineRepositories")>()
  return {
    ...mod,
    createMemoryRepositories: (...args: Parameters<typeof mod.createMemoryRepositories>) => {
      const repos = mod.createMemoryRepositories(...args)
      const upsert = repos.members.upsert.bind(repos.members)
      repos.members.upsert = async (row: Parameters<typeof upsert>[0]) => {
        if (failing.userIds.has(row.userId)) throw new Error("injected membership write failure")
        return upsert(row)
      }
      return repos
    },
  }
})

afterEach(() => {
  failing.userIds.clear()
  resetRuntimeStoreForTests()
})

let keySeq = 0
const post = (body: unknown) =>
  mattersPost(
    new Request("http://127.0.0.1/api/d1/matters", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `a7a7a7a7-0000-4000-8000-${String(++keySeq).padStart(12, "0")}` },
      body: JSON.stringify(body),
    })
  )

const FAILED = { error: "matter operation failed", code: "REQUEST_FAILED" }
const memberAdds = (matterId: string, userId: string) =>
  [...getRuntimeStore().audit].filter((row) => row.action === "matter_member_add" && row.target === matterId && row.reason === `added ${userId}`)

describe("Audit F14 R7: a membership write that fails leaves nothing cached", () => {
  it("add_member: the write fails, so the assignee is not cached and no seat is audited; the error contract is unchanged", async () => {
    const store = getRuntimeStore()
    const matter = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "R7 add_member write", courtId: "SHC", classification: "internal" })
    addMember(store, matter.id, "partner_a", "firmA")
    failing.userIds.add("clerk_a")

    const res = await post({ action: "add_member", actorId: "partner_a", matterId: matter.id, memberUserId: "clerk_a" })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(FAILED)
    expect(store.members.has(store.memberKey(matter.id, "clerk_a"))).toBe(false)
    expect(memberAdds(matter.id, "clerk_a")).toEqual([])
  })

  it("create: the second member's write fails, so that member is not cached and no seat is audited; the first stays", async () => {
    failing.userIds.add("associate_a")
    const res = await post({
      action: "create",
      actorId: "partner_a",
      firmId: "firmA",
      clientId: "client_a",
      title: "R7 create write",
      courtId: "SHC",
      classification: "internal",
      memberUserIds: ["associate_a", "clerk_a"],
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(FAILED)
    const store = getRuntimeStore()
    const matter = [...store.matters.values()].find((row) => row.title === "R7 create write")
    expect(matter).toBeDefined()
    const matterId = matter?.id ?? ""
    // The creator's seat was written and cached; the associate's write failed, so neither it nor the clerk's is cached.
    expect(store.members.has(store.memberKey(matterId, "partner_a"))).toBe(true)
    expect(store.members.has(store.memberKey(matterId, "associate_a"))).toBe(false)
    expect(store.members.has(store.memberKey(matterId, "clerk_a"))).toBe(false)
    expect(memberAdds(matterId, "associate_a")).toEqual([])
  })
})
