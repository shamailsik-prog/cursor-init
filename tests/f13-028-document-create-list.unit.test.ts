// FA-F13-028 / FA-F13-029: documents.create must refuse a malformed row before it writes, and listByFirm must
// report the rows it omits (the returned array stays valid-only). These fail until both memory paths do that.
import { describe, expect, it } from "vitest"
import { DocumentMalformedError } from "@/platform/d1/documentRecord"
import { createMemoryRepositories } from "@/platform/persistence/spineRepositories"
import { newStore, type DocumentRecord } from "@/platform/spine/store"

type DroppedDocument = { id: string; reason: string }
type DocumentList = DocumentRecord[] & { droppedDocuments?: DroppedDocument[] }

const good = (id: string, firmId = "firmA"): DocumentRecord => ({
  id,
  firmId,
  matterId: null,
  contentHash: "sha256:ab",
  sourceChannel: "web",
  classification: "internal",
  storagePath: "firm/obj",
  isImmutable: true,
  byteSize: 12,
  mimeType: "application/pdf",
  objectVersion: 1,
  uploadedBy: "u_up",
  objectBytesStatus: "available",
})

describe("F13 FA-F13-028: memory documents.create validates before it writes", () => {
  it("a canonical create is stored and readable", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    await repos.documents.create(good("doc_ok"))
    expect(store.documents.get("doc_ok")).toMatchObject({ id: "doc_ok", byteSize: 12, objectBytesStatus: "available" })
    expect(await repos.documents.get("doc_ok", "firmA")).toMatchObject({ id: "doc_ok", contentHash: "sha256:ab" })
  })

  it("a malformed create throws and leaves the store empty", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    const row = { ...good("doc_bad"), byteSize: "12" }
    await expect(repos.documents.create(row as never)).rejects.toMatchObject({
      name: "DocumentMalformedError",
      documentId: "doc_bad",
    })
    expect(store.documents.has("doc_bad")).toBe(false)
    await expect(repos.documents.create(row as never)).rejects.toBeInstanceOf(DocumentMalformedError)
  })

  it("a blank id is refused as unknown and nothing is stored", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    await expect(repos.documents.create({ ...good("doc_blank"), id: "   " } as never)).rejects.toMatchObject({
      name: "DocumentMalformedError",
      documentId: "unknown",
    })
    await expect(repos.documents.create({ ...good("doc_num"), id: 12 } as never)).rejects.toMatchObject({
      documentId: "unknown",
    })
    expect(store.documents.size).toBe(0)
  })

  it("a create without objectBytesStatus stores the canonical missing status, not the raw row", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    const { objectBytesStatus: _omit, ...rest } = good("doc_legacy")
    await repos.documents.create(rest as never)
    expect(store.documents.get("doc_legacy")).toMatchObject({ id: "doc_legacy", objectBytesStatus: "missing" })
  })
})

describe("F13 FA-F13-029: memory listByFirm reports the invalid rows it omits", () => {
  it("returns only the valid row and names the dropped row with its reason", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    store.documents.set("doc_bad", { ...good("doc_bad"), byteSize: "12" } as never)
    store.documents.set("doc_ok", good("doc_ok"))
    store.documents.set("doc_other", { ...good("doc_other", "firmB"), byteSize: "nope" } as never)
    const listed = (await repos.documents.listByFirm("firmA")) as DocumentList
    expect(listed.map((row) => row.id)).toEqual(["doc_ok"])
    expect(listed.droppedDocuments).toEqual([{ id: "doc_bad", reason: "byteSize" }])
  })

  it("a readable row with no objectBytesStatus is listed as missing and is not a drop", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    const { objectBytesStatus: _omit, ...rest } = good("doc_legacy")
    store.documents.set("doc_legacy", rest as never)
    const listed = (await repos.documents.listByFirm("firmA")) as DocumentList
    expect(listed.map((row) => row.id)).toEqual(["doc_legacy"])
    expect(listed[0]?.objectBytesStatus).toBe("missing")
    expect(listed.droppedDocuments).toEqual([])
  })
})
