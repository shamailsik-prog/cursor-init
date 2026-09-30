// E-18 (Layer 18 §13.1): "Loose vault: clerk and partner roles, clearance ≥ confidential".
// The Next documents / document-workflow APIs do not run through Firestore rules, so they
// must apply the same (stricter) rule the rules enforce (firestore.rules documents read).
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GET as documentsGet, POST as documentsPost } from "@/app/api/d1/documents/route"
import { POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { uploadDocument } from "@/services/d1-6/uploadDocument"

let n = 0
const key = () => `dddddddd-dddd-4ddd-8ddd-${String(++n).padStart(12, "0")}`
const postJson = (h: (r: Request) => Promise<Response>, url: string, body: unknown) =>
  h(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify(body),
    })
  )

function seedLoose() {
  const store = getRuntimeStore()
  store.users.set("clerk_low", { id: "clerk_low", firmId: "firmA", role: "clerk", clearanceLevel: "internal" })
  const write = uploadDocument(store, {
    firmId: "firmA",
    matterId: null,
    bytes: Buffer.from("%PDF-loose-vault%"),
    sourceChannel: "bulk",
    classification: "internal",
    idempotencyKey: "loose-1",
  })
  return { store, docId: write.docId }
}

async function visibleIds(userId: string): Promise<string[]> {
  const res = await documentsGet(new Request(`http://127.0.0.1/api/d1/documents?userId=${userId}`))
  const json = (await res.json()) as { items?: Array<{ id: string }> }
  return (json.items ?? []).map((row) => row.id)
}

beforeEach(() => resetRuntimeStoreForTests())
afterEach(() => resetRuntimeStoreForTests())

describe("loose vault in the Next API matches the rules (E-18)", () => {
  it("only clerk/partner with clearance >= confidential see loose-vault documents", async () => {
    const { docId } = seedLoose()
    expect(await visibleIds("associate_a")).not.toContain(docId)
    expect(await visibleIds("clerk_low")).not.toContain(docId)
    expect(await visibleIds("clerk_a")).toContain(docId)
    expect(await visibleIds("partner_a")).toContain(docId)
  })

  it("associates and low-clearance clerks cannot ingest into the loose vault", async () => {
    seedLoose()
    const body = (actorId: string) => ({
      action: "ingest",
      actorId,
      firmId: "firmA",
      matterId: null,
      contentBase64: Buffer.from(`%PDF-${actorId}%`).toString("base64"),
      sourceChannel: "web",
      classification: "internal",
    })
    expect((await postJson(documentsPost, "http://127.0.0.1/api/d1/documents", body("associate_a"))).status).toBe(403)
    expect((await postJson(documentsPost, "http://127.0.0.1/api/d1/documents", body("clerk_low"))).status).toBe(403)
    expect((await postJson(documentsPost, "http://127.0.0.1/api/d1/documents", body("clerk_a"))).status).toBe(200)
  })

  it("document workflow actions on a loose-vault document follow the same rule", async () => {
    const { docId } = seedLoose()
    const denied = await postJson(workflowPost, "http://127.0.0.1/api/d1/document-workflow", {
      action: "transition",
      actorId: "associate_a",
      documentId: docId,
      nextStatus: "processing",
    })
    expect(denied.status).toBeGreaterThanOrEqual(400)
    const allowed = await postJson(workflowPost, "http://127.0.0.1/api/d1/document-workflow", {
      action: "transition",
      actorId: "clerk_a",
      documentId: docId,
      nextStatus: "processing",
    })
    expect(allowed.status).toBe(200)
  })
})
