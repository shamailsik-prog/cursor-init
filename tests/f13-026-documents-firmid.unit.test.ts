// FA-F13-026: documents.get must validate stored firmId before the firm gate (same order as reportingIndex.get in
// FA-F13-020). A non-string or blank firmId throws DocumentMalformedError so routes never treat it as absence and
// fall back to a stale in-process cache.
import { describe, expect, it } from "vitest"
import { DocumentMalformedError } from "@/platform/d1/documentRecord"
import { createMemoryRepositories } from "@/platform/persistence/spineRepositories"
import { newStore, type DocumentRecord } from "@/platform/spine/store"

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

describe("F13 FA-F13-026: memory documents.get validates firmId before the firm gate", () => {
  it("a non-string or blank stored firmId throws, and another firm's row stays null", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    const caller = "firmA"
    for (const firmId of [12, null, true, "", "   "] as const) {
      const id = `doc_${String(firmId)}`
      store.documents.set(id, { ...good(id, caller), firmId } as never)
      await expect(repos.documents.get(id, caller)).rejects.toMatchObject({
        name: "DocumentMalformedError",
        documentId: id,
      })
    }
    const foreign = good("doc_foreign", "firmB")
    store.documents.set(foreign.id, foreign)
    expect(await repos.documents.get(foreign.id, caller)).toBeNull()
    expect(await repos.documents.get("missing", caller)).toBeNull()
  })
})
