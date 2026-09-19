import { afterEach, describe, expect, it } from "vitest"
import { GET as workflowGet, POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import { GET as courtOpsGet, POST as courtOpsPost } from "@/app/api/d2/court-ops/route"
import { GET as opsReportingGet } from "@/app/api/d2/ops-reporting/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function postWorkflow(body: unknown, key: string) {
  return workflowPost(
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

function postCourtOps(body: unknown, key: string) {
  return courtOpsPost(
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

function getOpsReport(params: URLSearchParams) {
  return opsReportingGet(new Request(`http://127.0.0.1/api/d2/ops-reporting?${params.toString()}`))
}

function seedOpsMatter(classification: "internal" | "privileged" = "internal") {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Ops reporting matter",
    courtId: "SHC",
    classification,
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  addMember(store, matter.id, "clerk_a", "firmA")
  return matter.id
}

describe("GET /api/d2/ops-reporting", () => {
  it("returns persisted workflow + court-ops activity rows with filters and pagination", async () => {
    const matterId = seedOpsMatter("internal")
    const doc = uploadDocument(getRuntimeStore(), {
      firmId: "firmA",
      matterId,
      bytes: Buffer.from("%PDF-ops-report%"),
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "00a2157a-9f8c-4c4a-847f-772d8cbc2e5e",
    })
    recordCaseNumber(getRuntimeStore(), matterId, "CP 1234", "SHC")

    const workflowTransition = await postWorkflow(
      {
        action: "transition",
        actorId: "associate_a",
        documentId: doc.docId,
        nextStatus: "processing",
      },
      "93e2b34e-48f3-4b17-a52b-c931fc7cdde8"
    )
    expect(workflowTransition.status).toBe(200)

    const queue = await courtOpsGet(
      new Request(`http://127.0.0.1/api/d2/court-ops?userId=associate_a&matterId=${matterId}&limit=10&cursor=0`)
    )
    expect(queue.status).toBe(200)
    const queueJson = (await queue.json()) as { items: Array<{ queueType: string; id: string }> }
    const followUp = queueJson.items.find((row) => row.queueType === "follow_up")
    if (!followUp) throw new Error("expected follow_up queue item")

    const resolved = await postCourtOps(
      {
        action: "resolve_follow_up",
        actorId: "partner_a",
        followUpId: followUp.id,
        reason: "resolved in ops reporting test",
      },
      "76ea6d1a-b9dc-4358-885c-b8f2d2e9cb4a"
    )
    expect(resolved.status).toBe(200)

    const firstPage = await getOpsReport(
      new URLSearchParams({
        actorId: "associate_a",
        matterId,
        limit: "1",
        cursor: "0",
      })
    )
    expect(firstPage.status).toBe(200)
    const firstJson = (await firstPage.json()) as {
      items: Array<{ source: string; action: string }>
      total: number
      nextCursor: string | null
    }
    expect(firstJson.total).toBeGreaterThanOrEqual(2)
    expect(firstJson.items).toHaveLength(1)
    expect(firstJson.nextCursor).toBe("1")

    const filtered = await getOpsReport(
      new URLSearchParams({
        actorId: "associate_a",
        source: "court_ops",
        action: "court_ops_resolve_follow_up",
        q: "resolved",
        limit: "10",
        cursor: "0",
      })
    )
    expect(filtered.status).toBe(200)
    const filteredJson = (await filtered.json()) as {
      items: Array<{ source: string; action: string }>
    }
    expect(
      filteredJson.items.some(
        (row) => row.source === "court_ops" && row.action === "court_ops_resolve_follow_up"
      )
    ).toBe(true)

    const workflowFiltered = await getOpsReport(
      new URLSearchParams({
        actorId: "associate_a",
        source: "workflow_event",
        action: "workflow_transition",
        status: "processing",
        limit: "10",
        cursor: "0",
      })
    )
    expect(workflowFiltered.status).toBe(200)
    const workflowFilteredJson = (await workflowFiltered.json()) as {
      items: Array<{ source: string; action: string; status: string | null }>
    }
    expect(
      workflowFilteredJson.items.some(
        (row) =>
          row.source === "workflow_event" &&
          row.action === "workflow_transition" &&
          row.status === "processing"
      )
    ).toBe(true)
  })

  it("enforces actor role and clearance boundaries", async () => {
    const matterId = seedOpsMatter("privileged")
    const doc = uploadDocument(getRuntimeStore(), {
      firmId: "firmA",
      matterId,
      bytes: Buffer.from("%PDF-privileged-ops-report%"),
      sourceChannel: "web",
      classification: "privileged",
      idempotencyKey: "9666bfcc-251e-4a1a-938d-50f3d9875777",
    })
    const privilegedTransition = await postWorkflow(
      {
        action: "transition",
        actorId: "partner_a",
        documentId: doc.docId,
        nextStatus: "processing",
      },
      "cad8d1fe-f26d-4cfc-8d79-c516d6f08465"
    )
    expect(privilegedTransition.status).toBe(200)

    const clerkView = await getOpsReport(
      new URLSearchParams({
        actorId: "clerk_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(clerkView.status).toBe(200)
    const clerkJson = (await clerkView.json()) as { total: number }
    expect(clerkJson.total).toBe(0)

    const partnerView = await getOpsReport(
      new URLSearchParams({
        actorId: "partner_a",
        source: "workflow_event",
        limit: "10",
        cursor: "0",
      })
    )
    expect(partnerView.status).toBe(200)
    const partnerJson = (await partnerView.json()) as {
      items: Array<{ source: string }>
    }
    expect(partnerJson.items.some((row) => row.source === "workflow_event")).toBe(true)

    const unknown = await getOpsReport(new URLSearchParams({ actorId: "ghost", limit: "10", cursor: "0" }))
    expect(unknown.status).toBe(404)
    const denied = await getOpsReport(
      new URLSearchParams({ actorId: "client_a", limit: "10", cursor: "0" })
    )
    expect(denied.status).toBe(403)

    const workflowListStillWorks = await workflowGet(
      new Request(
        `http://127.0.0.1/api/d1/document-workflow?view=queue&userId=partner_a&matterId=${matterId}&limit=10&cursor=0`
      )
    )
    expect(workflowListStillWorks.status).toBe(200)
  })
})
