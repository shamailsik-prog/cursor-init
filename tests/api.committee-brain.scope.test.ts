import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/p1/committee-brain/route"
import { setTransportForTests } from "@/platform/p1/internalAICaller"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import type { Classification, DocumentRecord } from "@/platform/spine/store"

function seedMatter(id: string, classification: Classification, members: string[], firmId = "firmA") {
  const store = getRuntimeStore()
  store.matters.set(id, {
    id,
    firmId,
    clientId: "client_a",
    title: `Matter ${id}`,
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "live",
    classification,
  })
  for (const userId of members) {
    store.members.set(store.memberKey(id, userId), { matterId: id, userId, firmId })
  }
}

function seedDocument(id: string, matterId: string | null, classification: Classification) {
  const doc: DocumentRecord = {
    id,
    firmId: "firmA",
    matterId,
    contentHash: `hash-${id}`,
    sourceChannel: "web",
    classification,
  }
  getRuntimeStore().documents.set(id, doc)
}

let keySeq = 0
function nextKey(): string {
  keySeq += 1
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(keySeq).padStart(12, "0")}`
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://127.0.0.1/api/p1/committee-brain", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": nextKey() },
      body: JSON.stringify(body),
    })
  )
}

type PostJson = {
  result: { blocked: boolean; outputId: string; outbound: { metadata: { classification: string } } }
  error?: string
}

let sent = 0
beforeEach(() => {
  resetRuntimeStoreForTests()
  sent = 0
  // A transport that would happily send if the policy allowed it.
  setTransportForTests({
    async send() {
      sent += 1
      return { text: "ok" }
    },
  })
})

afterEach(() => {
  setTransportForTests(null)
  resetRuntimeStoreForTests()
})

describe("committee-brain classification is derived server-side (H1)", () => {
  it("ignores a body 'public' label on a privileged matter", async () => {
    seedMatter("mat_priv", "privileged", ["partner_a"])
    const res = await post({
      actorId: "partner_a",
      matterId: "mat_priv",
      body: "privileged strategy memo",
      classification: "public",
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as PostJson
    expect(json.result.outbound.metadata.classification).toBe("privileged")
    expect(json.result.blocked).toBe(true)
    expect(sent).toBe(0)
    const stored = getRuntimeStore().committeeOutputs.get(json.result.outputId)
    expect(stored?.classification).toBe("privileged")
    expect(stored?.matterId).toBe("mat_priv")
  })

  it("refuses free text that names no matter (matter_required)", async () => {
    const res = await post({ actorId: "partner_a", body: "unlabelled text", classification: "public" })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("matter_required")
    expect(sent).toBe(0)
  })

  it("uses the strictest classification across the matter and referenced documents", async () => {
    seedMatter("mat_int", "internal", ["partner_a"])
    seedDocument("doc_conf", "mat_int", "confidential")
    seedDocument("doc_priv", "mat_int", "privileged")
    const res = await post({
      actorId: "partner_a",
      matterId: "mat_int",
      documentIds: ["doc_conf", "doc_priv"],
      body: "summary",
      classification: "internal",
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as PostJson
    expect(json.result.outbound.metadata.classification).toBe("privileged")
  })

  it("lets the body raise but never lower the derived classification", async () => {
    seedMatter("mat_int", "internal", ["partner_a"])
    const res = await post({
      actorId: "partner_a",
      matterId: "mat_int",
      body: "summary",
      classification: "privileged",
    })
    const json = (await res.json()) as PostJson
    expect(json.result.outbound.metadata.classification).toBe("privileged")
  })

  it("keeps a genuinely public matter public", async () => {
    seedMatter("mat_pub", "public", ["partner_a"])
    const res = await post({ actorId: "partner_a", matterId: "mat_pub", body: "press release" })
    expect(res.status).toBe(200)
    const json = (await res.json()) as PostJson
    expect(json.result.outbound.metadata.classification).toBe("public")
  })

  it("refuses a matter the actor is not a member of", async () => {
    seedMatter("mat_other", "internal", ["associate_a"])
    const res = await post({ actorId: "partner_a", matterId: "mat_other", body: "x" })
    expect(res.status).toBe(403)
    expect(getRuntimeStore().committeeOutputs.size).toBe(0)
  })

  it("refuses a cross-firm matter and unknown / cross-matter documents", async () => {
    seedMatter("mat_b", "internal", ["partner_b"], "firmB")
    expect((await post({ actorId: "partner_a", matterId: "mat_b", body: "x" })).status).toBe(403)

    seedMatter("mat_a", "internal", ["partner_a"])
    expect(
      (await post({ actorId: "partner_a", matterId: "mat_a", documentIds: ["doc_missing"], body: "x" }))
        .status
    ).toBe(404)

    seedMatter("mat_a2", "internal", ["associate_a"])
    seedDocument("doc_foreign", "mat_a2", "internal")
    expect(
      (await post({ actorId: "partner_a", matterId: "mat_a", documentIds: ["doc_foreign"], body: "x" }))
        .status
    ).toBe(403)
  })

  it("refuses when the derived classification exceeds the actor's clearance", async () => {
    seedMatter("mat_pr", "privileged-restricted", ["associate_a"])
    const res = await post({ actorId: "associate_a", matterId: "mat_pr", body: "x" })
    expect(res.status).toBe(403)
  })
})

describe("committee-brain GET is filtered by matter membership (M4)", () => {
  it("only lists outputs for matters the caller is a member of", async () => {
    seedMatter("mat_shared", "internal", ["partner_a", "clerk_a"])
    seedMatter("mat_partner_only", "internal", ["partner_a"])
    expect(
      (await post({ actorId: "partner_a", matterId: "mat_shared", body: "shared" })).status
    ).toBe(200)
    expect(
      (await post({ actorId: "partner_a", matterId: "mat_partner_only", body: "private" })).status
    ).toBe(200)

    const clerk = await GET(
      new Request("http://127.0.0.1/api/p1/committee-brain?actorId=clerk_a&limit=10&cursor=0")
    )
    expect(clerk.status).toBe(200)
    const clerkJson = (await clerk.json()) as { items: Array<{ matterId: string }>; total: number }
    expect(clerkJson.total).toBe(1)
    expect(clerkJson.items[0]?.matterId).toBe("mat_shared")

    const partner = await GET(
      new Request("http://127.0.0.1/api/p1/committee-brain?actorId=partner_a&limit=10&cursor=0")
    )
    const partnerJson = (await partner.json()) as { total: number }
    expect(partnerJson.total).toBe(2)

    // Same firm, sufficient clearance, but not a member of either matter.
    const associate = await GET(
      new Request("http://127.0.0.1/api/p1/committee-brain?actorId=associate_a&limit=10&cursor=0")
    )
    const associateJson = (await associate.json()) as { total: number }
    expect(associateJson.total).toBe(0)
  })

  it("keeps legacy matter-less outputs readable by their author only", async () => {
    // Written before matterId was required; new writes always carry a matter.
    getRuntimeStore().committeeOutputs.set("cbo_legacy", {
      id: "cbo_legacy",
      firmId: "firmA",
      actorId: "partner_a",
      classification: "internal",
      purpose: "committee-brain",
      blocked: true,
      outbound: {
        body: "[masked]",
        metadata: {
          classification: "internal",
          provider: "ai-gateway",
          purpose: "committee-brain",
          redactionCounts: {},
        },
      },
      createdAt: 1,
    })
    const author = await GET(
      new Request("http://127.0.0.1/api/p1/committee-brain?actorId=partner_a&limit=10&cursor=0")
    )
    expect(((await author.json()) as { total: number }).total).toBe(1)
    const other = await GET(
      new Request("http://127.0.0.1/api/p1/committee-brain?actorId=associate_a&limit=10&cursor=0")
    )
    expect(((await other.json()) as { total: number }).total).toBe(0)
  })
})
