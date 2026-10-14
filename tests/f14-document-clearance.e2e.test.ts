import { afterEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/d1/documents/route"
import { GET as workflowGet } from "@/app/api/d1/document-workflow/route"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

/**
 * Audit finding F14, the download door (audit §10: "repeat get/list/download as lower-clearance user. Every reference
 * and payload uses current matter authority"; open item O-76). End to end through the Next documents routes, as the
 * existing route suites drive them (tests/api.documents.test.ts, tests/f03-document-bytes.e2e.test.ts).
 *
 * The user flow: a partner ingests a plaint on an `internal` matter through POST /api/d1/documents (the ingest also
 * queues the document's OCR job). The matter's clerk, cleared to `confidential`, lists it with its OCR job count and
 * downloads its bytes. Then the matter is raised to `privileged-restricted` through the matter repository (no Next
 * route reclassifies a matter). Before the fix the document access check judged only the document's stored label, so the
 * clerk still listed the document with its job-derived `ocrJobs` count and downloaded the bytes (200). After the fix
 * the check also needs clearance for the matter's current label: the clerk's download is 403 and the document, with
 * its `ocrJobs`, is left out of the list and of the workflow queue, and the matter's workflow timeline (which names
 * its documents) is refused; a member cleared for the raised label still reads all of it.
 */

afterEach(() => {
  resetRuntimeStoreForTests()
})

const PLAINT = Buffer.from("%PDF-1.4 F14 synthetic plaint, matter raised after ingest.\n", "utf8")

type ListItem = { id: string; classification: string; ocrJobs: number }

function ingest(matterId: string, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/d1/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: PLAINT.toString("base64"),
        sourceChannel: "web",
        classification: "internal",
        mimeType: "application/pdf",
      }),
    })
  )
}

const download = (userId: string, docId: string) =>
  GET(new Request(`http://127.0.0.1/api/d1/documents?userId=${userId}&docId=${docId}&includeContent=true`))

async function listed(userId: string, matterId: string): Promise<ListItem[]> {
  const res = await GET(new Request(`http://127.0.0.1/api/d1/documents?userId=${userId}&matterId=${matterId}&limit=50&cursor=0`))
  expect(res.status).toBe(200)
  return ((await res.json()) as { items: ListItem[] }).items
}

async function queued(userId: string, matterId: string): Promise<string[]> {
  const res = await workflowGet(new Request(`http://127.0.0.1/api/d1/document-workflow?view=queue&userId=${userId}&matterId=${matterId}&limit=50&cursor=0`))
  expect(res.status).toBe(200)
  return ((await res.json()) as { items: Array<{ documentId: string }> }).items.map((i) => i.documentId)
}

const timeline = (userId: string, matterId: string) =>
  workflowGet(new Request(`http://127.0.0.1/api/d1/document-workflow?view=timeline&userId=${userId}&matterId=${matterId}&limit=50&cursor=0`))

async function bytesOf(res: Response): Promise<Buffer> {
  expect(res.status).toBe(200)
  return Buffer.from(((await res.json()) as { contentBase64: string }).contentBase64, "base64")
}

/** An `internal` matter with the seeded partner (privileged-restricted), associate (privileged) and clerk (confidential) as members. */
function openMatter(): string {
  const store = getRuntimeStore()
  const matter = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "F14 synthetic suit", courtId: "SHC", classification: "internal" })
  for (const userId of ["partner_a", "associate_a", "clerk_a"]) addMember(store, matter.id, userId, "firmA")
  return matter.id
}

async function raise(matterId: string, classification: "privileged" | "privileged-restricted"): Promise<void> {
  const repos = await getRuntimeRepositories(getRuntimeStore())
  expect(await repos.matters.update(matterId, { classification })).toMatchObject({ classification })
}

describe("F14 download door: the Next documents routes apply the matter's current label", () => {
  it("after the matter is raised above the clerk's clearance, the clerk's download is 403 and the list and queue leave the document and its OCR job count out", async () => {
    const matterId = openMatter()
    const ingested = await ingest(matterId, "f14f14f1-4f14-4f14-8f14-f14f14f14f01")
    expect(ingested.status).toBe(200)
    const docId = ((await ingested.json()) as { result: { doc: { id: string } } }).result.doc.id

    // Before the raise: the clerk lists the document with its OCR job and downloads the bytes.
    expect((await listed("clerk_a", matterId)).find((i) => i.id === docId)).toMatchObject({ classification: "internal", ocrJobs: 1 })
    expect((await bytesOf(await download("clerk_a", docId))).equals(PLAINT)).toBe(true)
    expect(await queued("clerk_a", matterId)).toContain(docId)
    expect((await timeline("clerk_a", matterId)).status).toBe(200)

    await raise(matterId, "privileged-restricted")

    // After: refused to every member below the matter's new label, whatever the document's own label says.
    for (const userId of ["clerk_a", "associate_a"]) {
      const res = await download(userId, docId)
      expect([userId, res.status]).toEqual([userId, 403])
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toEqual({ error: "document access denied" })
      expect(JSON.stringify(await listed(userId, matterId))).not.toContain(docId)
      expect(await queued(userId, matterId)).not.toContain(docId)
      // The matter's workflow timeline names its documents: refused too (the route's refusal is 400 with a public error).
      const refusedTimeline = await timeline(userId, matterId)
      expect([userId, refusedTimeline.status]).toEqual([userId, 400])
      expect(JSON.stringify(await refusedTimeline.json())).not.toContain(docId)
    }
    expect((await timeline("partner_a", matterId)).status).toBe(200)
    // The member cleared for the raised label still lists it (with its OCR job) and downloads it.
    expect((await listed("partner_a", matterId)).find((i) => i.id === docId)).toMatchObject({ ocrJobs: 1 })
    expect((await bytesOf(await download("partner_a", docId))).equals(PLAINT)).toBe(true)
    expect(await queued("partner_a", matterId)).toContain(docId)
  })

  it("a matter document whose matter cannot be read is refused to every member, however cleared", async () => {
    const matterId = openMatter()
    const ingested = await ingest(matterId, "f14f14f1-4f14-4f14-8f14-f14f14f14f02")
    expect(ingested.status).toBe(200)
    const docId = ((await ingested.json()) as { result: { doc: { id: string } } }).result.doc.id
    expect((await bytesOf(await download("partner_a", docId))).equals(PLAINT)).toBe(true)

    // The matter row is gone (memberships remain): fail closed rather than fall back to the document's own label.
    getRuntimeStore().matters.delete(matterId)
    expect((await download("partner_a", docId)).status).toBe(403)
    expect(JSON.stringify(await listed("partner_a", matterId))).not.toContain(docId)
  })
})
