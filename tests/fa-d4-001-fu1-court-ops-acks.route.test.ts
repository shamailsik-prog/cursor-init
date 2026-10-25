// Audit FA-D4-001-FU1, spec R4 and R7, on the route's memory path (insecure-dev, body actorId):
// - an acknowledgement's audit row is pushed only after its activity row committed: a write that fails transiently
//   (an ABORTED lock timeout) answers 503 court_ops_ack_unavailable and leaves NO court_ops_acknowledge audit row
//   (on main the audit row was pushed before the write, so a failed write still flushed "acknowledged");
// - a firm-B actor acknowledging firm A's follow-up answers 404 and writes nothing.
// The Firestore path (the same route through the F02 router) is tests/fa-d4-001-fu1-court-ops-acks.e2e.firestore.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest"
import { POST } from "@/app/api/d2/court-ops/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import type { WorkflowOpsActivityRow } from "@/platform/spine/store"

const failure = vi.hoisted(() => ({ error: null as Error | null }))

// Both the pre-fix writer (upsert of the ack row) and the fixed one fail the same way, so the test pins the route's
// order and answer, not a method name.
vi.mock("@/platform/persistence/runtimeRepositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/persistence/runtimeRepositories")>()
  return {
    ...actual,
    getRuntimeRepositories: async (...args: Parameters<typeof actual.getRuntimeRepositories>) => {
      const repos = await actual.getRuntimeRepositories(...args)
      const err = failure.error
      if (!err) return repos
      const activity = repos.workflowOpsActivity as typeof repos.workflowOpsActivity & Record<string, unknown>
      return {
        ...repos,
        workflowOpsActivity: {
          ...activity,
          recordCourtOpsAcknowledgement: async () => {
            throw err
          },
          upsert: async (row: WorkflowOpsActivityRow) => {
            if (row.id.startsWith("ops:court_ops:ack:")) throw err
            return activity.upsert(row)
          },
        },
      }
    },
  }
})

afterEach(() => {
  failure.error = null
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/d2/court-ops", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    })
  )
}

function seedFollowUp(): string {
  const store = getRuntimeStore()
  const matter = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "FU1 matter", courtId: "SHC", classification: "internal" })
  addMember(store, matter.id, "associate_a", "firmA")
  recordCaseNumber(store, matter.id, "CP 1234", "SHC")
  const follow = store.followUps.find((row) => row.matterId === matter.id && row.kind === "case_number_reject")
  if (!follow) throw new Error("fixture: no follow-up")
  return follow.id
}

const ackAudit = () => getRuntimeStore().audit.filter((row) => row.action === "court_ops_acknowledge")
const ackRows = () => [...getRuntimeStore().workflowOpsActivity.values()].filter((row) => row.action === "court_ops_acknowledge")

describe("FA-D4-001-FU1 court-ops acknowledge_item (memory path)", () => {
  it("control: a committed acknowledgement writes its firm-qualified row and exactly one audit row", async () => {
    const id = seedFollowUp()
    const res = await post({ action: "acknowledge_item", actorId: "associate_a", queueType: "follow_up", id, reason: "seen" }, "3f0b4c1e-7a2d-4e5f-9a1b-2c3d4e5f6a71")
    expect(res.status).toBe(200)
    expect(ackRows().map((row) => row.id)).toEqual([`ops:court_ops:ack:firmA:follow_up:${id}`])
    expect(ackAudit()).toHaveLength(1)
    expect(ackAudit()[0]).toMatchObject({ actorId: "associate_a", target: `follow_up:${id}` })
  })

  it("a transient write failure answers 503 court_ops_ack_unavailable and leaves no acknowledgement audit row", async () => {
    const id = seedFollowUp()
    failure.error = new Error("10 ABORTED: Transaction lock timeout")
    const key = "8a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c42"
    const body = { action: "acknowledge_item", actorId: "associate_a", queueType: "follow_up", id, reason: "seen" }
    const res = await post(body, key)
    // The half-state first: on main the "acknowledged" audit row was already pushed when the write failed.
    expect(ackAudit(), "an acknowledgement audit row exists for a write that failed").toEqual([])
    expect(ackRows()).toEqual([])
    expect(res.status).toBe(503)
    expect(((await res.json()) as { code?: string }).code).toBe("court_ops_ack_unavailable")
    // Nothing committed, so the claim was released: the same key runs again once the store is back.
    failure.error = null
    const retry = await post(body, key)
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as { reused?: boolean }).reused).toBe(false)
    expect(ackAudit()).toHaveLength(1)
  })

  it("a workflow row stamped with another firm answers 404, even over a document the caller may read", async () => {
    const store = getRuntimeStore()
    const matter = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "FU1 wf", courtId: "SHC", classification: "internal" })
    addMember(store, matter.id, "associate_a", "firmA")
    const write = await uploadDocument(store, {
      firmId: "firmA",
      matterId: matter.id,
      bytes: Buffer.from("%PDF-fu1-workflow%"),
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "0d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6",
      uploadedBy: "associate_a",
    })
    const row = { documentId: write.docId, firmId: "firmB", matterId: matter.id, status: "review_required" as const, reviewerId: null, updatedAt: 1 }
    store.documentWorkflow.set(write.docId, row)
    const body = { action: "acknowledge_item", actorId: "associate_a", queueType: "workflow", id: write.docId }
    const res = await post(body, "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d")
    expect(res.status).toBe(404)
    expect(ackRows()).toEqual([])
    // Control: the same item stamped with the caller's firm is acknowledged, so the stamp alone decided the 404.
    store.documentWorkflow.set(write.docId, { ...row, firmId: "firmA" })
    expect((await post(body, "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e")).status).toBe(200)
    expect(ackRows().map((r) => r.id)).toEqual([`ops:court_ops:ack:firmA:workflow:${write.docId}`])
  })

  it("a firm-B actor acknowledging firm A's follow-up answers 404 and writes nothing", async () => {
    const id = seedFollowUp()
    const res = await post({ action: "acknowledge_item", actorId: "partner_b", queueType: "follow_up", id }, "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e93")
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code?: string }).code).toBe("court_ops_item_not_found")
    expect(ackRows()).toEqual([])
    expect(ackAudit()).toEqual([])
  })
})
