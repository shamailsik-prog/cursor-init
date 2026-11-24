import { afterEach, describe, expect, it } from "vitest"
import { seedUser } from "@/platform/p5/checkPermission"
import { newStore, type SpineStore } from "@/platform/spine/store"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { createClient } from "@/services/d1-1/clients"
import { dispatchWhatsApp, resetD2WhatsAppThreadsForTests } from "@/services/d2-1/dispatch"

/**
 * PARITY-006 as defined in the Q14a R1 audit and left open by R3-L1:
 * sync before the decision, one web-shaped audit row, and a fresh open title.
 * These assertions are red on 7ae1a33f.
 */

afterEach(() => {
  resetD2WhatsAppThreadsForTests()
})

function staff(store: SpineStore, id: string, role: "clerk" | "associate" | "intern" = "clerk") {
  return seedUser(store, { id, firmId: "firmA", role, clearanceLevel: "privileged" })
}

describe("PARITY-006 firm sync", () => {
  it("denies the next command when the repository dropped a member the runtime store still caches", async () => {
    const store = newStore()
    staff(store, "staff")
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client1",
      title: "Cached matter title",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "staff", "firmA")
    const listed = await dispatchWhatsApp(store, "staff", "/matters")
    expect(listed.matters?.map((row) => row.title)).toEqual(["Cached matter title"])
    expect(store.members.size).toBe(1)

    const opened = await dispatchWhatsApp(store, "staff", "open 1", {
      repos: {
        members: { listByFirm: async () => [] },
        matters: {
          listByFirm: async (firmId) => [...store.matters.values()].filter((row) => row.firmId === firmId),
        },
      },
    })

    expect(opened.denied).toBe(true)
    expect(opened.ok).toBe(false)
    expect(opened.opened).toBeUndefined()
    expect(opened.text).not.toContain("Cached matter title")
    expect(store.members.has(store.memberKey(matter.id, "staff"))).toBe(false)
  })
})

describe("PARITY-006 audit shape", () => {
  it("an allowed drafts command writes exactly one permission_check row in the web shape", async () => {
    const store = newStore()
    staff(store, "staff", "associate")
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client1",
      title: "Draft matter",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "staff", "firmA")
    store.drafts.set("dr1", {
      id: "dr1",
      firmId: "firmA",
      matterId: matter.id,
      templateId: "t",
      title: "Plea",
      body: "Body",
      classification: "internal",
      createdBy: "staff",
      createdAt: 1,
      status: "draft",
    })
    const before = store.audit.length
    const result = await dispatchWhatsApp(store, "staff", "/drafts")
    const added = [...store.audit].slice(before)
    expect(result.ok).toBe(true)
    expect(result.drafts?.map((row) => row.title)).toEqual(["Plea"])
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      action: "permission_check",
      actorId: "staff",
      firmId: "firmA",
      target: "draft",
      classification: "internal",
      reason: "allow:draft:ok",
    })
    expect(added[0]?.id).toEqual(expect.any(String))
    expect(added[0]?.at).toEqual(expect.any(Number))
  })

  it("an intern client-registry denial writes exactly one deny row and no client names", async () => {
    const store = newStore()
    staff(store, "intern1", "intern")
    const entity = createClient(store, {
      firmId: "firmA",
      canonicalName: "Intern Visible Client",
      cnic: "4210112345671",
      phone: "03001111111",
      classification: "internal",
    })
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: entity.id,
      title: "Intern matter",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "intern1", "firmA")
    const before = store.audit.length
    const result = await dispatchWhatsApp(store, "intern1", "/clients")
    const added = [...store.audit].slice(before)
    expect(result.ok).toBe(false)
    expect(result.denied).toBe(true)
    expect(result.clients).toBeUndefined()
    expect(result.text).not.toContain("Intern Visible Client")
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      action: "permission_check",
      actorId: "intern1",
      firmId: "firmA",
      target: "client.read",
      classification: "internal",
      reason: "deny:client.read:user role not allowed for client registry reads",
    })
  })

  it("a cross-firm matter id replies not-found and does not leak the title or the firm", async () => {
    const store = newStore()
    staff(store, "staff")
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client1",
      title: "SECRET-CROSS-TITLE",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "staff", "firmA")
    const listed = await dispatchWhatsApp(store, "staff", "/matters")
    expect(listed.matters?.[0]?.title).toBe("SECRET-CROSS-TITLE")
    matter.firmId = "firmB"
    const before = store.audit.length
    const opened = await dispatchWhatsApp(store, "staff", "open 1")
    const added = [...store.audit].slice(before)
    expect(opened.ok).toBe(false)
    expect(opened.opened).toBeUndefined()
    expect(opened.text).toBe("not found")
    expect(JSON.stringify(opened)).not.toContain("SECRET-CROSS-TITLE")
    expect(JSON.stringify(opened)).not.toContain("cross-firm")
    expect(JSON.stringify(opened)).not.toContain("firmB")
    expect(added).toHaveLength(1)
    expect(added[0]?.action).toBe("permission_check")
    expect(added[0]?.reason?.startsWith("allow:")).toBe(false)
  })
})

describe("PARITY-006 fresh open title", () => {
  it("open N shows the title as it stands now, and not-found after the matter is deleted", async () => {
    const store = newStore()
    staff(store, "staff")
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client1",
      title: "Original pleading",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "staff", "firmA")
    const listed = await dispatchWhatsApp(store, "staff", "/matters")
    expect(listed.text).toContain("Original pleading")
    matter.title = "Renamed pleading"
    const opened = await dispatchWhatsApp(store, "staff", "open 1")
    expect(opened.ok).toBe(true)
    expect(opened.opened?.title).toBe("Renamed pleading")
    expect(opened.text).toContain("Renamed pleading")
    expect(opened.text).not.toContain("Original pleading")
    store.matters.delete(matter.id)
    const gone = await dispatchWhatsApp(store, "staff", "open 1")
    expect(gone.ok).toBe(false)
    expect(gone.opened).toBeUndefined()
    expect(gone.text).toBe("not found")
    expect(gone.text).not.toContain("Renamed pleading")
    expect(gone.text).not.toContain("Original pleading")
  })
})
