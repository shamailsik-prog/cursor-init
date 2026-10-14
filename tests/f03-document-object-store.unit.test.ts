import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  assertDocumentObjectIngestAllowed,
  buildDocumentStoragePath,
  decryptDocumentObjectPayload,
  deleteDocumentObject,
  DocumentObjectConfigurationError,
  getImmutableDocumentObject,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
  resolveDocumentObjectBackendKind,
  restoreDocumentObjectFile,
  __testHookFailNextDocumentObjectDelete,
  __testHookFailNextDocumentObjectRead,
} from "@/platform/documents/documentObjectStore"
import { newStore } from "@/platform/spine/store"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "f03-unit-objects-"))
  process.env.SIKANDER_DOCUMENT_OBJECT_ROOT = root
  process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "fs"
  delete process.env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT
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
    process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "memory"
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

  it("assertDocumentObjectIngestAllowed refuses production without S3/R2 configuration", () => {
    vi.stubEnv("NODE_ENV", "production")
    delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
    delete process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND
    delete process.env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(DocumentObjectConfigurationError)
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(/S3-compatible|R2/i)
  })

  it("FA-D16-002: rejects encryption key that is not 32 bytes", async () => {
    process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = "abcd"
    const store = newStore()
    const bytes = Buffer.from("key-len")
    await expect(
      putImmutableDocumentObject({
        store,
        firmId: "firmA",
        docId: "doc_key",
        bytes,
        contentHash: store.hashKey("firmA", bytes),
        mimeType: "application/octet-stream",
      })
    ).rejects.toThrow(/32 bytes/)
    process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY =
      "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00"
  })

  it("FA-D16-002: rejects unsupported object format version", () => {
    const store = newStore()
    const bytes = Buffer.from("version-check")
    const hash = store.hashKey("firmA", bytes)
    const stored = putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_version",
      bytes,
      contentHash: hash,
      mimeType: "application/octet-stream",
    })
    return stored.then(async (meta) => {
      const { readFile, writeFile } = await import("node:fs/promises")
      const { filesystemPathForStoragePath } = await import(
        "@/platform/documents/documentObjectStore"
      )
      const encPath = filesystemPathForStoragePath(meta.storagePath)
      const payload = await readFile(encPath)
      const bad = Buffer.from(payload)
      bad[0] = 99
      await writeFile(encPath, bad)
      await expect(
        getImmutableDocumentObject(store, "firmA", meta.storagePath, hash)
      ).rejects.toThrow(/unsupported document object format version/)
    })
  })

  it("FA-D16-002: rejects content hash mismatch before write", async () => {
    const store = newStore()
    const bytes = Buffer.from("pre-write-hash")
    await expect(
      putImmutableDocumentObject({
        store,
        firmId: "firmA",
        docId: "doc_prehash",
        bytes,
        contentHash: "not-the-hash",
        mimeType: "application/octet-stream",
      })
    ).rejects.toThrow(/content hash mismatch/i)
  })

  it("FA-D16-002: decryptDocumentObjectPayload rejects truncated payloads", () => {
    expect(() => decryptDocumentObjectPayload(Buffer.from([1, 2, 3]))).toThrow(/truncated/)
  })

  it("D2: production rejects fs, memory, and incomplete S3 on every object-store path", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const store = newStore()
    const bytes = Buffer.from("prod-guard")
    const hash = store.hashKey("firmA", bytes)
    const putInput = {
      store,
      firmId: "firmA",
      docId: "doc_prod",
      bytes,
      contentHash: hash,
      mimeType: "application/octet-stream",
    }
    const fsPath = "fs://firmA/documents/doc_prod/v1"

    process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "fs"
    process.env.SIKANDER_DOCUMENT_OBJECT_ROOT = root
    expect(() => resolveDocumentObjectBackendKind()).toThrow(DocumentObjectConfigurationError)
    await expect(putImmutableDocumentObject(putInput)).rejects.toThrow(DocumentObjectConfigurationError)
    await expect(getImmutableDocumentObject(store, "firmA", fsPath, hash)).rejects.toThrow(
      DocumentObjectConfigurationError
    )
    await expect(deleteDocumentObject(fsPath)).rejects.toThrow(DocumentObjectConfigurationError)
    await expect(restoreDocumentObjectFile(fsPath, join(root, "b.enc"))).rejects.toThrow(
      DocumentObjectConfigurationError
    )

    delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
    process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "memory"
    expect(() => resolveDocumentObjectBackendKind()).toThrow(DocumentObjectConfigurationError)
    await expect(putImmutableDocumentObject(putInput)).rejects.toThrow(DocumentObjectConfigurationError)

    process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "s3"
    delete process.env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT
    expect(() => resolveDocumentObjectBackendKind()).toThrow(DocumentObjectConfigurationError)
    await expect(putImmutableDocumentObject(putInput)).rejects.toThrow(DocumentObjectConfigurationError)
  })

  it("FA-D16-003: failed verify deletes the new object and leaves siblings intact", async () => {
    const store = newStore()
    const keepBytes = Buffer.from("sibling-ok")
    const keepHash = store.hashKey("firmA", keepBytes)
    const kept = await putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_sibling_keep",
      bytes: keepBytes,
      contentHash: keepHash,
      mimeType: "application/octet-stream",
    })
    const failBytes = Buffer.from("verify-fail")
    const failHash = store.hashKey("firmA", failBytes)
    const mod = await import("@/platform/documents/documentObjectStore")
    mod.__testHookFailNextDocumentObjectRead()
    await expect(
      mod.putImmutableDocumentObject({
        store,
        firmId: "firmA",
        docId: "doc_sibling_fail",
        bytes: failBytes,
        contentHash: failHash,
        mimeType: "application/octet-stream",
      })
    ).rejects.toThrow(/forced round-trip failure/)
    const { filesystemPathForStoragePath } = mod
    const failEnc = filesystemPathForStoragePath(
      buildDocumentStoragePath("firmA", "doc_sibling_fail", 1)
    )
    const { access } = await import("node:fs/promises")
    await expect(access(failEnc)).rejects.toThrow()
    await getImmutableDocumentObject(store, "firmA", kept.storagePath, keepHash)
  })

  it("FA-D16-003: logs rollback delete failure and rethrows the original verify error", async () => {
    const store = newStore()
    const bytes = Buffer.from("rollback-log")
    const hash = store.hashKey("firmA", bytes)
    const mod = await import("@/platform/documents/documentObjectStore")
    mod.__testHookFailNextDocumentObjectRead()
    mod.__testHookFailNextDocumentObjectDelete()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(
      mod.putImmutableDocumentObject({
        store,
        firmId: "firmA",
        docId: "doc_rollback_log",
        bytes,
        contentHash: hash,
        mimeType: "application/octet-stream",
      })
    ).rejects.toThrow(/forced round-trip failure/)
    expect(errorSpy).toHaveBeenCalledWith(
      "[documentObjectStore] rollback delete failed:",
      expect.any(Error)
    )
    errorSpy.mockRestore()
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
