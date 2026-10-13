import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  assertDocumentObjectIngestAllowed,
  buildDocumentStoragePath,
  DocumentObjectConfigurationError,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
  restoreDocumentObjectFile,
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
  vi.unstubAllEnvs()
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

  it("restore refuses when the object already exists in memory mode", async () => {
    delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
    const store = newStore()
    const bytes = Buffer.from("restore-once")
    const hash = store.hashKey("firmA", bytes)
    const storagePath = (
      await putImmutableDocumentObject({
        store,
        firmId: "firmA",
        docId: "doc_restore",
        bytes,
        contentHash: hash,
        mimeType: "application/octet-stream",
      })
    ).storagePath
    const backupPath = join(root, "backup.enc")
    const { writeFile } = await import("node:fs/promises")
    await writeFile(backupPath, Buffer.from("backup"))
    await expect(restoreDocumentObjectFile(storagePath, backupPath)).rejects.toThrow(/already exists/)
  })

  it("assertDocumentObjectIngestAllowed refuses missing root when NODE_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production")
    delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(DocumentObjectConfigurationError)
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(/SIKANDER_DOCUMENT_OBJECT_ROOT/)
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
