import { afterEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/d1/documents/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/d1/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    })
  )
}

function get(params: URLSearchParams) {
  return GET(new Request(`http://127.0.0.1/api/d1/documents?${params.toString()}`))
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64")
}

function seedMatter(classification: "internal" | "confidential" | "privileged" = "internal") {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Doc ops matter",
    courtId: "SHC",
    classification,
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "clerk_a", "firmA")
  return matter.id
}

describe("POST/GET /api/d1/documents", () => {
  it("ingests and replays the same idempotent request", async () => {
    const matterId = seedMatter("internal")
    const payload = {
      action: "ingest",
      actorId: "partner_a",
      firmId: "firmA",
      matterId,
      contentBase64: b64("%PDF-memo-one%"),
      sourceChannel: "web",
      classification: "confidential",
    }
    const first = await post(payload, "21ea3f5f-bf8a-4464-9710-fdf028fbc0ce")
    const second = await post(payload, "21ea3f5f-bf8a-4464-9710-fdf028fbc0ce")
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { reused: boolean; result: { doc: { id: string } } }
    const b = (await second.json()) as { reused: boolean; result: { doc: { id: string } } }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(a.result.doc.id).toBe(b.result.doc.id)
  })

  it("dedupes same bytes across different keys and keeps one OCR job", async () => {
    const matterId = seedMatter("internal")
    const payload = {
      action: "ingest",
      actorId: "partner_a",
      firmId: "firmA",
      matterId,
      contentBase64: b64("%PDF-same-content%"),
      sourceChannel: "web",
      classification: "internal",
    }
    const a = await post(payload, "ff313807-1f4c-4984-ac1f-9ec5cfaeaa98")
    const b = await post(payload, "73754aa3-326e-4939-8dc8-e09f9fda08cd")
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const first = (await a.json()) as { result: { doc: { id: string } } }
    const second = (await b.json()) as { result: { reused: boolean; ocrJobs: number; doc: { id: string } } }
    expect(second.result.reused).toBe(true)
    expect(second.result.doc.id).toBe(first.result.doc.id)
    expect(second.result.ocrJobs).toBe(1)
  })

  it("scopes content-hash dedup to the matter: a non-member re-uploading another matter's file gets a new document in their own matter (R-2)", async () => {
    const store = getRuntimeStore()
    const partnerOnly = createMatter(store, {
      firmId: "firmA",
      clientId: "client_a",
      title: "Partner-only matter",
      courtId: "SHC",
      classification: "privileged",
    })
    addMember(store, partnerOnly.id, "partner_a", "firmA")
    const clerkMatter = seedMatter("internal")
    const bytes = b64("%PDF-shared-evidence%")

    const original = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId: partnerOnly.id,
        contentBase64: bytes,
        sourceChannel: "web",
        classification: "privileged",
      },
      "0d6b7e1f-2a3c-4d5e-8f60-718293a4b5c6"
    )
    expect(original.status).toBe(200)
    const originalDoc = ((await original.json()) as { result: { doc: { id: string } } }).result.doc

    const dup = await post(
      {
        action: "ingest",
        actorId: "clerk_a",
        firmId: "firmA",
        matterId: clerkMatter,
        contentBase64: bytes,
        sourceChannel: "web",
        classification: "confidential",
      },
      "1e7c8f20-3b4d-4e6f-9071-8293a4b5c6d7"
    )
    expect(dup.status).toBe(200)
    const dupJson = (await dup.json()) as {
      result: { reused: boolean; ocrJobs: number; doc: { id: string; matterId: string; classification: string } }
    }
    expect(dupJson.result.reused).toBe(false)
    expect(dupJson.result.doc.id).not.toBe(originalDoc.id)
    expect(dupJson.result.doc.matterId).toBe(clerkMatter)
    // L17.3: the copy inherits the highest label the same bytes already carry in the firm.
    expect(dupJson.result.doc.classification).toBe("privileged")
    expect(dupJson.result.ocrJobs).toBe(1)
    // The other matter's record is untouched (no classification side effects either way).
    expect(store.documents.get(originalDoc.id)?.classification).toBe("privileged")
    expect(store.documents.get(originalDoc.id)?.matterId).toBe(partnerOnly.id)
  })

  it("rejects same key with different payload", async () => {
    const matterId = seedMatter("internal")
    const key = "a47956f0-f9f7-4474-a66c-c533f4b8ecf8"
    const a = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: b64("%PDF-A%"),
        sourceChannel: "web",
        classification: "internal",
      },
      key
    )
    const b = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: b64("%PDF-B%"),
        sourceChannel: "web",
        classification: "internal",
      },
      key
    )
    expect(a.status).toBe(200)
    expect(b.status).toBe(409)
  })

  it("defaults an unlabelled upload to privileged, floored at the matter's classification (L17.3)", async () => {
    const internalMatter = seedMatter("internal")
    const unlabelled = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId: internalMatter,
        contentBase64: b64("%PDF-client-letter%"),
        sourceChannel: "whatsapp",
      },
      "2a3b4c5d-6e7f-4081-9a2b-3c4d5e6f7a81"
    )
    expect(unlabelled.status).toBe(200)
    const one = (await unlabelled.json()) as { result: { doc: { classification: string } } }
    expect(one.result.doc.classification).toBe("privileged")

    const store = getRuntimeStore()
    const restricted = createMatter(store, {
      firmId: "firmA",
      clientId: "client_a",
      title: "Partner-only",
      courtId: "SHC",
      classification: "privileged-restricted",
    })
    addMember(store, restricted.id, "partner_a", "firmA")
    const floored = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId: restricted.id,
        contentBase64: b64("%PDF-restricted%"),
        sourceChannel: "web",
      },
      "3b4c5d6e-7f80-4192-8b3c-4d5e6f7a8b92"
    )
    expect(floored.status).toBe(200)
    const two = (await floored.json()) as { result: { doc: { classification: string } } }
    expect(two.result.doc.classification).toBe("privileged-restricted")

    const explicit = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId: internalMatter,
        contentBase64: b64("%PDF-public-order%"),
        sourceChannel: "web",
        classification: "internal",
      },
      "4c5d6e7f-8091-42a3-9c4d-5e6f7a8b9ca3"
    )
    const three = (await explicit.json()) as { result: { doc: { classification: string } } }
    expect(three.result.doc.classification).toBe("internal")
  })

  it("enforces matter classification floor and firm/member boundaries", async () => {
    const privilegedMatter = seedMatter("privileged")
    const tooLow = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId: privilegedMatter,
        contentBase64: b64("%PDF-low%"),
        sourceChannel: "web",
        classification: "internal",
      },
      "9f33bdbd-b90f-4f9d-bc95-edb0722ef9db"
    )
    expect(tooLow.status).toBe(400)

    const crossFirm = await post(
      {
        action: "ingest",
        actorId: "partner_b",
        firmId: "firmB",
        matterId: privilegedMatter,
        contentBase64: b64("%PDF-cross%"),
        sourceChannel: "web",
        classification: "privileged",
      },
      "77f01591-9e8c-4f2d-bd4c-bfca8eb8ef10"
    )
    expect(crossFirm.status).toBe(403)
  })

  it("lists visible documents with pagination and matter scoping", async () => {
    const memberMatter = seedMatter("internal")
    const store = getRuntimeStore()
    const hiddenMatter = createMatter(store, {
      firmId: "firmA",
      clientId: "client_a",
      title: "Hidden",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, hiddenMatter.id, "partner_a", "firmA")

    await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId: memberMatter,
        contentBase64: b64("%PDF-visible-1%"),
        sourceChannel: "web",
        classification: "internal",
      },
      "4fddded4-61eb-4165-a949-feb062f6ff66"
    )
    await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId: memberMatter,
        contentBase64: b64("%PDF-visible-2%"),
        sourceChannel: "bulk",
        classification: "internal",
      },
      "fda6f9d5-4f63-4de2-8ba2-fab30ced9ca9"
    )
    await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId: hiddenMatter.id,
        contentBase64: b64("%PDF-hidden%"),
        sourceChannel: "web",
        classification: "internal",
      },
      "6e6f19d6-4f44-48ee-9e15-a6e905489704"
    )

    const pageOne = await get(
      new URLSearchParams({
        userId: "clerk_a",
        matterId: memberMatter,
        limit: "1",
        cursor: "0",
      })
    )
    expect(pageOne.status).toBe(200)
    const one = (await pageOne.json()) as {
      items: Array<{ id: string }>
      total: number
      nextCursor: string | null
    }
    expect(one.total).toBe(2)
    expect(one.items).toHaveLength(1)
    expect(one.nextCursor).toBe("1")

    const pageTwo = await get(
      new URLSearchParams({
        userId: "clerk_a",
        matterId: memberMatter,
        limit: "1",
        cursor: one.nextCursor ?? "1",
      })
    )
    const two = (await pageTwo.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(two.items).toHaveLength(1)
    expect(two.nextCursor).toBeNull()
  })

  it("writes audit entries for ingest actions", async () => {
    const matterId = seedMatter("internal")
    const res = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: b64("%PDF-audit%"),
        sourceChannel: "web",
        classification: "internal",
      },
      "a0fe9c59-6b2f-4ef5-ad9d-aa0f7b8a6ea0"
    )
    expect(res.status).toBe(200)
    const actions = getRuntimeStore().audit.map((a) => a.action)
    expect(actions).toContain("document_ingest")
  })
})
