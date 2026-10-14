import { afterEach, describe, expect, it, vi } from "vitest"
import { POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import { GET as opsReportingGet, POST as opsReportingPost } from "@/app/api/d2/ops-reporting/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { uploadDocument } from "@/services/d1-6/uploadDocument"

/**
 * Audit F14, Copilot C4: the ops-reporting routes refresh the firm's matters through `syncFirmMatters` (audit F14
 * R2-D1). That sync is the request's one listing of the firm's matters; the handlers reuse its result instead of
 * listing the firm's matters again. Counted on the repository the routes get (memory mode, where it is the store).
 */

const listings = vi.hoisted(() => ({ firms: [] as string[] }))

vi.mock("@/platform/persistence/spineRepositories", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/platform/persistence/spineRepositories")>()
  return {
    ...mod,
    createMemoryRepositories: (...args: Parameters<typeof mod.createMemoryRepositories>) => {
      const repos = mod.createMemoryRepositories(...args)
      const listByFirm = repos.matters.listByFirm.bind(repos.matters)
      repos.matters.listByFirm = async (firmId: string) => {
        listings.firms.push(firmId)
        return listByFirm(firmId)
      }
      return repos
    },
  }
})

afterEach(() => {
  resetRuntimeStoreForTests()
})

/** A matter with workflow activity (a document moved to processing), so the ops views have a digest to seed. */
async function seedMatter(): Promise<string> {
  const store = getRuntimeStore()
  const matter = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "C4", courtId: "SHC", classification: "internal" })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  const doc = await uploadDocument(store, {
    firmId: "firmA",
    matterId: matter.id,
    bytes: Buffer.from("%PDF-f14-c4%"),
    sourceChannel: "web",
    classification: "internal",
    idempotencyKey: "c4c4c4c4-0000-4000-8000-000000000010",
    uploadedBy: "partner_a",
  })
  const moved = await workflowPost(
    new Request("http://127.0.0.1/api/d1/document-workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "c4c4c4c4-0000-4000-8000-000000000011" },
      body: JSON.stringify({ action: "transition", actorId: "associate_a", documentId: doc.docId, nextStatus: "processing" }),
    })
  )
  expect(moved.status).toBe(200)
  return matter.id
}

describe("Audit F14 C4: an ops-reporting request lists the firm's matters once", () => {
  it("a GET of any view, and the governance POST, list the firm's matters exactly once (the sync)", async () => {
    const matterId = await seedMatter()
    for (const view of ["activity", "alert_digests"]) {
      listings.firms.length = 0
      const res = await opsReportingGet(
        new Request(`http://127.0.0.1/api/d2/ops-reporting?view=${view}&actorId=partner_a&limit=10&cursor=0`)
      )
      expect(res.status).toBe(200)
      expect({ view, listings: listings.firms }).toEqual({ view, listings: ["firmA"] })
    }

    listings.firms.length = 0
    const acknowledged = await opsReportingPost(
      new Request("http://127.0.0.1/api/d2/ops-reporting", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "c4c4c4c4-0000-4000-8000-000000000001" },
        body: JSON.stringify({ action: "acknowledge_workflow_ops_alert_digest", actorId: "partner_a", matterId, reason: "partner acknowledged digest" }),
      })
    )
    expect(acknowledged.status).toBe(200)
    expect(listings.firms).toEqual(["firmA"])
  })
})
