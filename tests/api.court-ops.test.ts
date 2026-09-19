import { afterEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/d2/court-ops/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"
import { transitionWorkflowStatus } from "@/services/d1-7/documentWorkflow"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/d2/court-ops", {
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
  return GET(new Request(`http://127.0.0.1/api/d2/court-ops?${params.toString()}`))
}

function seedOpsFixtures() {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Ops matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  addMember(store, matter.id, "clerk_a", "firmA")

  recordCaseNumber(store, matter.id, "CP 1234", "SHC")
  const write = uploadDocument(store, {
    firmId: "firmA",
    matterId: matter.id,
    bytes: Buffer.from("%PDF-workflow-blocker%"),
    sourceChannel: "web",
    classification: "internal",
    idempotencyKey: "6979997c-bf72-4aaa-a59a-8fe1e8616cc2",
  })
  transitionWorkflowStatus(store, {
    actorId: "associate_a",
    documentId: write.docId,
    nextStatus: "processing",
  })
  transitionWorkflowStatus(store, {
    actorId: "associate_a",
    documentId: write.docId,
    nextStatus: "review_required",
  })
  return { matterId: matter.id, workflowDocId: write.docId }
}

describe("GET/POST /api/d2/court-ops", () => {
  it("validates WhatsApp command grammar and command authorization", async () => {
    seedOpsFixtures()
    const bad = await post(
      {
        action: "whatsapp_command",
        actorId: "associate_a",
        command: "/unknown command",
      },
      "a6d88f95-3d94-4c96-a954-5e4f2f52aa75"
    )
    expect(bad.status).toBe(400)

    const denied = await post(
      {
        action: "whatsapp_command",
        actorId: "client_a",
        command: "/research PPC 302",
      },
      "fbbbd6f3-285e-4f84-a28c-cf9f4bf17f61"
    )
    expect(denied.status).toBe(403)

    const ok = await post(
      {
        action: "whatsapp_command",
        actorId: "associate_a",
        command: "/matters",
      },
      "7f7a90a6-f10d-4da6-a497-e0229f066d6c"
    )
    expect(ok.status).toBe(200)
  })

  it("lists queue with pagination including follow-up and workflow blockers", async () => {
    const { matterId } = seedOpsFixtures()
    const queue = await get(
      new URLSearchParams({
        userId: "associate_a",
        matterId,
        limit: "1",
        cursor: "0",
      })
    )
    expect(queue.status).toBe(200)
    const q = (await queue.json()) as {
      items: Array<{ queueType: string }>
      total: number
      nextCursor: string | null
    }
    expect(q.total).toBeGreaterThanOrEqual(2)
    expect(q.items).toHaveLength(1)
    expect(q.nextCursor).toBe("1")
  })

  it("resolves follow-ups and denies cross-firm resolvers", async () => {
    seedOpsFixtures()
    const follow = getRuntimeStore().followUps.find((row) => row.kind === "case_number_reject")
    expect(follow).toBeTruthy()
    const followUpId = follow?.id ?? ""

    const denied = await post(
      {
        action: "resolve_follow_up",
        actorId: "partner_b",
        followUpId,
      },
      "90501f6d-97f0-4b64-b3dc-568176dd63e2"
    )
    expect(denied.status).toBe(400)

    const ok = await post(
      {
        action: "resolve_follow_up",
        actorId: "partner_a",
        followUpId,
      },
      "f19047ad-47d7-45f7-b9b8-ed0f61df3f9c"
    )
    expect(ok.status).toBe(200)
    expect(getRuntimeStore().followUps.find((row) => row.id === followUpId)?.status).toBe(
      "resolved"
    )
  })

  it("resolves workflow blockers through status transitions", async () => {
    const { workflowDocId } = seedOpsFixtures()
    const res = await post(
      {
        action: "resolve_workflow",
        actorId: "associate_a",
        documentId: workflowDocId,
        nextStatus: "complete",
      },
      "2f0c09f7-35f2-4e3e-b932-ca5e1f4ef2ab"
    )
    expect(res.status).toBe(200)
    expect(getRuntimeStore().documentWorkflow.get(workflowDocId)?.status).toBe("complete")
  })

  it("replays idempotent acknowledge calls and rejects key conflicts", async () => {
    seedOpsFixtures()
    const follow = getRuntimeStore().followUps.find((row) => row.kind === "case_number_reject")
    const followUpId = follow?.id ?? ""
    const key = "2fc9c715-29ce-4504-a9d5-dd4ddfb6d58b"
    const payload = {
      action: "acknowledge_item",
      actorId: "associate_a",
      queueType: "follow_up",
      id: followUpId,
      reason: "Seen by desk",
    }
    const first = await post(payload, key)
    const second = await post(payload, key)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { reused: boolean }
    const b = (await second.json()) as { reused: boolean }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)

    const conflict = await post({ ...payload, id: `${followUpId}-other` }, key)
    expect(conflict.status).toBe(409)
  })
})
