import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  buildDocumentStoragePath,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
} from "@/platform/documents/documentObjectStore"
import { newStore } from "@/platform/spine/store"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "f03-unit-objects-"))
  process.env.SIKANDER_DOCUMENT_OBJECT_ROOT = root
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
  resetDocumentObjectStoreForTests()
})

describe("document object store hardening", () => {
  it("rejects a second write to the same storage path (wx immutability)", async () => {
    const store = newStore()
    const bytes = Buffer.from("immutable-once")
    const hash = store.hashKey("firmA", bytes)
    const input = {
      store,
      firmId: "firmA",
      docId: "doc_immutable",
      bytes,
      contentHash: hash,
      mimeType: "application/octet-stream",
    }
    const first = await putImmutableDocumentObject(input)
    await expect(putImmutableDocumentObject({ ...input, docId: "doc_immutable" })).rejects.toThrow(
      /already exists/
    )
    expect(first.storagePath).toBe(buildDocumentStoragePath("firmA", "doc_immutable", 1))
  })

  it("rejects path traversal in firmId", async () => {
    const store = newStore()
    const bytes = Buffer.from("x")
    await expect(
      putImmutableDocumentObject({
        store,
        firmId: "../etc",
        docId: "doc_x",
        bytes,
        contentHash: store.hashKey("../etc", bytes),
        mimeType: "application/octet-stream",
      })
    ).rejects.toThrow(/safety validation/)
  })
})
