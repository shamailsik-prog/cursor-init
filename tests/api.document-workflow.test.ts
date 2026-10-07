import { afterEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/d1/document-workflow/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { uploadDocument } from "@/services/d1-6/uploadDocument"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/d1/document-workflow", {
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
  return GET(new Request(`http://127.0.0.1/api/d1/document-workflow?${params.toString()}`))
}

function seedMatterAndDocument() {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Workflow matter",
    courtId: "SHC",
    classification: "confidential",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  addMember(store, matter.id, "clerk_a", "firmA")
  const write = uploadDocument(store, {
    firmId: "firmA",
    matterId: matter.id,
    bytes: Buffer.from("%PDF-workflow%"),
    sourceChannel: "web",
    classification: "confidential",
    idempotencyKey: "8f158546-f2f9-4d31-8e96-cf333d4c0cd4",
  })
  return { matterId: matter.id, docId: write.docId }
}

describe("POST/GET /api/d1/document-workflow", () => {
  it("supports valid status transitions and blocks invalid transitions", async () => {
    const { docId } = seedMatterAndDocument()
    const first = await post(
      {
        action: "transition",
        actorId: "associate_a",
        documentId: docId,
        nextStatus: "processing",
      },
      "a3f87dd8-d2ec-43ab-8667-3c4f3f669813"
    )
    expect(first.status).toBe(200)

    const invalid = await post(
      {
        action: "transition",
        actorId: "associate_a",
        documentId: docId,
        nextStatus: "queued",
      },
      "f5248d5e-2a40-4db7-b860-c15990906b9f"
    )
    expect(invalid.status).toBe(400)
  })

  it("assigns reviewer with firm and clearance enforcement", async () => {
    const { docId } = seedMatterAndDocument()
    const ok = await post(
      {
        action: "assign_reviewer",
        actorId: "partner_a",
        documentId: docId,
        reviewerId: "associate_a",
      },
      "a2367d95-4f1e-4ceb-af14-895a6fc43b74"
    )
    expect(ok.status).toBe(200)

    const crossFirm = await post(
      {
        action: "assign_reviewer",
        actorId: "partner_a",
        documentId: docId,
        reviewerId: "partner_b",
      },
      "5f6dc028-649a-413d-b4d0-2d5298947984"
    )
    expect(crossFirm.status).toBe(400)
  })

  it("records review decision confirmation and declassification rules", async () => {
    const { docId } = seedMatterAndDocument()
    await post(
      {
        action: "assign_reviewer",
        actorId: "partner_a",
        documentId: docId,
        reviewerId: "associate_a",
      },
      "f8928e7f-72b0-43da-895d-c34f6f7af8cd"
    )

    const blocked = await post(
      {
        action: "review_decision",
        actorId: "associate_a",
        documentId: docId,
        decision: "declassify",
        nextClassification: "internal",
        reason: "Associate cannot declassify",
      },
      "aa16742b-f79f-43de-afeb-b607fef85f36"
    )
    expect(blocked.status).toBe(400)

    const allowed = await post(
      {
        action: "review_decision",
        actorId: "partner_a",
        documentId: docId,
        decision: "declassify",
        nextClassification: "internal",
        reason: "Partner confirms declassify for filing packet",
      },
      "bc8790ca-4b11-43f9-a75f-d2d67161c288"
    )
    expect(allowed.status).toBe(200)
    const store = getRuntimeStore()
    expect(store.documents.get(docId)?.classification).toBe("internal")
  })

  it("replays idempotent transitions and rejects idempotency key conflicts", async () => {
    const { docId } = seedMatterAndDocument()
    const key = "fdf26fac-99f6-46e4-8944-f214f6e1db4d"
    const payload = {
      action: "transition",
      actorId: "associate_a",
      documentId: docId,
      nextStatus: "processing",
    }
    const first = await post(payload, key)
    const second = await post(payload, key)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { reused: boolean }
    const b = (await second.json()) as { reused: boolean }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)

    const conflict = await post({ ...payload, nextStatus: "review_required" }, key)
    expect(conflict.status).toBe(422) // idempotency_key_reused (final audit F4: functions semantics)
  })

  it("lists queue and timeline with pagination and matter scoping", async () => {
    const { matterId, docId } = seedMatterAndDocument()
    await post(
      {
        action: "transition",
        actorId: "associate_a",
        documentId: docId,
        nextStatus: "processing",
      },
      "f40ec0ef-92ad-4483-bf5f-c2ec50d18ce6"
    )
    await post(
      {
        action: "assign_reviewer",
        actorId: "partner_a",
        documentId: docId,
        reviewerId: "associate_a",
      },
      "73690370-8c96-4c59-9cf8-40f7182f13dd"
    )

    const queue = await get(
      new URLSearchParams({
        view: "queue",
        userId: "associate_a",
        matterId,
        limit: "1",
        cursor: "0",
      })
    )
    expect(queue.status).toBe(200)
    const queueJson = (await queue.json()) as {
      items: Array<{ documentId: string }>
      total: number
      nextCursor: string | null
    }
    expect(queueJson.total).toBe(1)
    expect(queueJson.items[0]?.documentId).toBe(docId)
    expect(queueJson.nextCursor).toBeNull()

    const timelineOne = await get(
      new URLSearchParams({
        view: "timeline",
        userId: "associate_a",
        matterId,
        limit: "1",
        cursor: "0",
      })
    )
    expect(timelineOne.status).toBe(200)
    const t1 = (await timelineOne.json()) as {
      items: Array<{ id: string }>
      total: number
      nextCursor: string | null
    }
    expect(t1.total).toBeGreaterThanOrEqual(1)
    expect(t1.items).toHaveLength(1)
    if (t1.nextCursor) {
      const timelineTwo = await get(
        new URLSearchParams({
          view: "timeline",
          userId: "associate_a",
          matterId,
          limit: "1",
          cursor: t1.nextCursor,
        })
      )
      expect(timelineTwo.status).toBe(200)
    }
  })

  it("denies cross-firm timeline reads", async () => {
    const { matterId } = seedMatterAndDocument()
    const denied = await get(
      new URLSearchParams({
        view: "timeline",
        userId: "partner_b",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(denied.status).toBe(400)
  })
})
