// L17.6 #41: "The accounts role is defined in L4.7 with read access to the intimation
// register only — no matter documents." The accounts role is denied everything else,
// even when (wrongly) added as a matter member.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GET as clientsGet } from "@/app/api/d1/clients/route"
import { GET as documentsGet, POST as documentsPost } from "@/app/api/d1/documents/route"
import { GET as mattersGet } from "@/app/api/d1/matters/route"
import { GET as draftsGet } from "@/app/api/d4/drafts/route"
import { checkPermission } from "@/platform/p5/checkPermission"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { uploadDocument } from "@/services/d1-6/uploadDocument"

async function seed() {
  const store = getRuntimeStore()
  store.users.set("accounts_a", {
    id: "accounts_a",
    firmId: "firmA",
    role: "accounts",
    clearanceLevel: "privileged",
  })
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Fee matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "accounts_a", "firmA")
  await uploadDocument(store, {
    firmId: "firmA",
    matterId: matter.id,
    bytes: Buffer.from("%PDF-matter%"),
    sourceChannel: "web",
    classification: "internal",
    idempotencyKey: "k1",
      uploadedBy: "partner_a",
  })
  await uploadDocument(store, {
    firmId: "firmA",
    matterId: null,
    bytes: Buffer.from("%PDF-loose%"),
    sourceChannel: "web",
    classification: "confidential",
    idempotencyKey: "k2",
      uploadedBy: "partner_a",
  })
  return { store, matterId: matter.id }
}

beforeEach(() => resetRuntimeStoreForTests())
afterEach(() => resetRuntimeStoreForTests())

describe("accounts role is register-only (L17.6 #41)", () => {
  it("checkPermission denies accounts every matter action, even as a member; allows the intimation register", async () => {
    const { store, matterId } = await seed()
    for (const action of ["draft", "research", "committee_brain", "read", "list_matters"]) {
      const decision = checkPermission(store, "accounts_a", action, action === "list_matters" ? undefined : matterId)
      expect(decision).toMatchObject({ allow: false, reason: "accounts-register-only" })
    }
    expect(checkPermission(store, "accounts_a", "intimation_register").allow).toBe(true)
  })

  it("documents API: accounts can neither list matter / loose-vault documents nor ingest", async () => {
    const { matterId } = await seed()
    const list = await documentsGet(
      new Request(`http://127.0.0.1/api/d1/documents?userId=accounts_a&matterId=${matterId}`)
    )
    const listJson = (await list.json()) as { items?: unknown[] }
    expect(list.status === 403 || (listJson.items ?? []).length === 0).toBe(true)
    const loose = await documentsGet(new Request("http://127.0.0.1/api/d1/documents?userId=accounts_a"))
    const looseJson = (await loose.json()) as { items?: unknown[] }
    expect(loose.status === 403 || (looseJson.items ?? []).length === 0).toBe(true)

    const ingest = await documentsPost(
      new Request("http://127.0.0.1/api/d1/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "3f1e2d4c-5b6a-4789-8a0b-1c2d3e4f5a60" },
        body: JSON.stringify({
          action: "ingest",
          actorId: "accounts_a",
          firmId: "firmA",
          matterId,
          contentBase64: Buffer.from("%PDF-acc%").toString("base64"),
          sourceChannel: "web",
          classification: "internal",
        }),
      })
    )
    expect(ingest.status).toBeGreaterThanOrEqual(400)
  })

  it("matters, clients and drafts reads are denied to accounts", async () => {
    const { matterId } = await seed()
    const matters = await mattersGet(new Request("http://127.0.0.1/api/d1/matters?userId=accounts_a"))
    expect(matters.status).toBe(403)
    const clients = await clientsGet(new Request("http://127.0.0.1/api/d1/clients?userId=accounts_a"))
    expect(clients.status).toBe(403)
    const drafts = await draftsGet(
      new Request(`http://127.0.0.1/api/d4/drafts?view=drafts&userId=accounts_a&matterId=${matterId}`)
    )
    const draftsJson = (await drafts.json()) as { items?: unknown[] }
    expect(drafts.status === 403 || (draftsJson.items ?? []).length === 0).toBe(true)
  })
})
