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

function getContent(docId: string, userId: string) {
  return GET(
    new Request(
      `http://127.0.0.1/api/d1/documents?userId=${userId}&docId=${docId}&includeContent=true`
    )
  )
}

describe("F03: uploaded document bytes are retained and integrity-checked", () => {
  it("ingests through POST and reads byte-identical content through GET", async () => {
    const store = getRuntimeStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client_a",
      title: "F03 bytes matter",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "partner_a", "firmA")

    const original = Buffer.from(
      "%PDF-1.4 F03 forensic audit fixture — original bytes must round-trip.\n",
      "utf8"
    )
    const ingestRes = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId: matter.id,
        contentBase64: original.toString("base64"),
        sourceChannel: "web",
        classification: "internal",
        mimeType: "application/pdf",
      },
      "a3f03f03-f03f-4111-8111-f03f03f03f03"
    )
    expect(ingestRes.status).toBe(200)
    const ingestJson = (await ingestRes.json()) as {
      result: {
        doc: {
          id: string
          contentHash: string
          storagePath: string
          byteSize: number
          mimeType: string
          isImmutable: boolean
          uploadedBy: string
        }
      }
    }
    const doc = ingestJson.result.doc
    expect(doc.byteSize).toBe(original.length)
    expect(doc.mimeType).toBe("application/pdf")
    expect(doc.isImmutable).toBe(true)
    expect(doc.uploadedBy).toBe("partner_a")
    expect(doc.storagePath).toMatch(/^r2:\/\/firmA\/documents\//)

    const downloadRes = await getContent(doc.id, "partner_a")
    expect(downloadRes.status).toBe(200)
    const downloadJson = (await downloadRes.json()) as {
      contentBase64: string
      contentHash: string
      byteSize: number
    }
    expect(downloadJson.contentHash).toBe(doc.contentHash)
    expect(downloadJson.byteSize).toBe(original.length)
    const roundTrip = Buffer.from(downloadJson.contentBase64, "base64")
    expect(roundTrip.equals(original)).toBe(true)
  })
})
