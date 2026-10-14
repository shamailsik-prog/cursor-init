/**
 * FA-D16-003 (audit v2, LOW): a round-trip verification failure must not leave the written
 * object behind. Before the fix, `assertExpectedHash` threw between the write and the delete
 * (documentObjectStore.ts:190-193) and the outer rollback in uploadDocument only deleted when
 * `storagePath` had been assigned, so the encrypted object stayed addressable.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildDocumentStoragePath,
  createDocumentObjectStore,
  createMemoryDocumentObjectBackend,
  DocumentObjectVerificationError,
  filesystemPathForStoragePath,
  getImmutableDocumentObject,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
  setDocumentObjectBackendForTests,
  type DocumentObjectBackend,
} from "@/platform/documents/documentObjectStore"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { newStore, type SpineStore } from "@/platform/spine/store"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fa-d16-003-"))
  process.env.SIKANDER_DOCUMENT_OBJECT_ROOT = root
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
  vi.restoreAllMocks()
  setDocumentObjectBackendForTests?.(null)
  resetDocumentObjectStoreForTests()
})

function encFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".enc")) out.push(join(entry.parentPath, entry.name))
  }
  return out
}

/** Real hashKey for the first `realCalls` calls, then a hash that can never match. */
function failHashAfter(store: SpineStore, realCalls: number) {
  const real = store.hashKey.bind(store)
  let calls = 0
  return vi.spyOn(store, "hashKey").mockImplementation((firmId: string, bytes: Buffer) => {
    calls += 1
    return calls <= realCalls ? real(firmId, bytes) : "0".repeat(64)
  })
}

function partnerStore(): SpineStore {
  const store = newStore()
  store.users.set("partner_a", {
    id: "partner_a",
    firmId: "firmA",
    role: "partner",
    clearanceLevel: "privileged-restricted",
    active: true,
  })
  return store
}

describe("FA-D16-003: round-trip hash failure removes the written object (public API)", () => {
  it("filesystem backend: the .enc file is deleted before the hash-mismatch error propagates", async () => {
    const store = newStore()
    const bytes = Buffer.from("%PDF-fa-d16-003 filesystem round trip%")
    const contentHash = store.hashKey("firmA", bytes)
    failHashAfter(store, 1)
    await expect(
      putImmutableDocumentObject({
        store,
        firmId: "firmA",
        docId: "doc_fad16003fs",
        bytes,
        contentHash,
        mimeType: "application/pdf",
      })
    ).rejects.toThrow(/content hash mismatch/)
    const storagePath = buildDocumentStoragePath("firmA", "doc_fad16003fs", 1)
    expect(existsSync(filesystemPathForStoragePath(storagePath))).toBe(false)
    expect(encFilesUnder(root)).toEqual([])
  })

  it("memory backend: the object is not left addressable and the key can be written again", async () => {
    delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
    const store = newStore()
    const bytes = Buffer.from("fa-d16-003 memory round trip")
    const contentHash = store.hashKey("firmA", bytes)
    const spy = failHashAfter(store, 1)
    const input = {
      store,
      firmId: "firmA",
      docId: "doc_fad16003mem",
      bytes,
      contentHash,
      mimeType: "application/octet-stream",
    }
    await expect(putImmutableDocumentObject(input)).rejects.toThrow(/content hash mismatch/)
    const storagePath = buildDocumentStoragePath("firmA", "doc_fad16003mem", 1)
    await expect(getImmutableDocumentObject(store, "firmA", storagePath, contentHash)).rejects.toThrow(
      /not found/
    )
    spy.mockRestore()
    const stored = await putImmutableDocumentObject(input)
    expect(stored.storagePath).toBe(storagePath)
  })

  it("uploadDocument: no object, document row or OCR job survives a round-trip hash failure", async () => {
    const store = partnerStore()
    // call 1: dedup hash in uploadDocument; call 2: pre-write check; call 3: round trip.
    failHashAfter(store, 2)
    await expect(
      uploadDocument(store, {
        firmId: "firmA",
        matterId: null,
        bytes: Buffer.from("%PDF-fa-d16-003 upload round trip%"),
        sourceChannel: "web",
        classification: "internal",
        idempotencyKey: "fad16003-0000-4000-8000-000000000003",
        uploadedBy: "partner_a",
      })
    ).rejects.toThrow(/content hash mismatch/)
    expect(encFilesUnder(root)).toEqual([])
    expect(store.documents.size).toBe(0)
    expect(store.jobs).toHaveLength(0)
    expect(store.docsByHash.size).toBe(0)
  })
})

/** Wraps the memory backend so a test can corrupt reads and fail deletes. */
function faultyBackend(opts: { corruptReads?: boolean; failDeletes?: number }) {
  const inner = createMemoryDocumentObjectBackend()
  let deleteFailuresLeft = opts.failDeletes ?? 0
  const calls: string[] = []
  const backend: DocumentObjectBackend = {
    kind: inner.kind,
    scheme: inner.scheme,
    async putIfAbsent(key, payload) {
      calls.push(`put:${key}`)
      await inner.putIfAbsent(key, payload)
    },
    async get(key) {
      calls.push(`get:${key}`)
      const payload = await inner.get(key)
      if (!opts.corruptReads) return payload
      const copy = Buffer.from(payload)
      copy[copy.length - 1] ^= 0x01
      return copy
    },
    async delete(key) {
      calls.push(`delete:${key}`)
      if (deleteFailuresLeft > 0) {
        deleteFailuresLeft -= 1
        throw new Error("simulated delete failure")
      }
      await inner.delete(key)
    },
  }
  return { backend, inner, calls }
}

describe("FA-D16-003: cleanup covers every verification failure, for any backend", () => {
  it("a corrupted read-back (GCM authentication failure) deletes the object", async () => {
    const { backend, inner, calls } = faultyBackend({ corruptReads: true })
    const objects = createDocumentObjectStore(backend)
    const store = newStore()
    const bytes = Buffer.from("corrupted on the way back")
    const err = await objects
      .put({
        store,
        firmId: "firmA",
        docId: "doc_corrupt",
        bytes,
        contentHash: store.hashKey("firmA", bytes),
        mimeType: "application/octet-stream",
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DocumentObjectVerificationError)
    const verification = err as DocumentObjectVerificationError
    expect(verification.objectRemoved).toBe(true)
    expect(verification.storagePath).toBe("fs://firmA/documents/doc_corrupt/v1")
    expect(verification.message).toMatch(/round-trip verification failed/)
    expect(calls).toEqual([
      "put:firmA/documents/doc_corrupt/v1.enc",
      "get:firmA/documents/doc_corrupt/v1.enc",
      "delete:firmA/documents/doc_corrupt/v1.enc",
    ])
    await expect(inner.get("firmA/documents/doc_corrupt/v1.enc")).rejects.toThrow(/not found/)
  })

  it("when the inner delete fails, the error says so and carries the storagePath", async () => {
    const { backend, inner } = faultyBackend({ corruptReads: true, failDeletes: 1 })
    const objects = createDocumentObjectStore(backend)
    const store = newStore()
    const bytes = Buffer.from("inner delete fails")
    const err = (await objects
      .put({
        store,
        firmId: "firmA",
        docId: "doc_innerfail",
        bytes,
        contentHash: store.hashKey("firmA", bytes),
        mimeType: "application/octet-stream",
      })
      .catch((e: unknown) => e)) as DocumentObjectVerificationError
    expect(err).toBeInstanceOf(DocumentObjectVerificationError)
    expect(err.objectRemoved).toBe(false)
    expect(err.storagePath).toBe("fs://firmA/documents/doc_innerfail/v1")
    expect(err.message).toMatch(/could not be removed/)
    // The object is still there: the caller (uploadDocument) is responsible for the retry.
    await expect(inner.get("firmA/documents/doc_innerfail/v1.enc")).resolves.toBeInstanceOf(Buffer)
  })

  it("uploadDocument's outer rollback deletes the object when storagePath was never assigned", async () => {
    const { backend, inner, calls } = faultyBackend({ corruptReads: true, failDeletes: 1 })
    setDocumentObjectBackendForTests(backend)
    const store = partnerStore()
    vi.spyOn(store, "id").mockImplementation((prefix: string) => `${prefix}_outer`)
    await expect(
      uploadDocument(store, {
        firmId: "firmA",
        matterId: null,
        bytes: Buffer.from("%PDF-outer rollback%"),
        sourceChannel: "web",
        classification: "internal",
        idempotencyKey: "fad16003-0000-4000-8000-000000000004",
        uploadedBy: "partner_a",
      })
    ).rejects.toBeInstanceOf(DocumentObjectVerificationError)
    expect(calls.filter((c) => c.startsWith("delete:"))).toEqual([
      "delete:firmA/documents/doc_outer/v1.enc",
      "delete:firmA/documents/doc_outer/v1.enc",
    ])
    await expect(inner.get("firmA/documents/doc_outer/v1.enc")).rejects.toThrow(/not found/)
    expect(store.documents.size).toBe(0)
    expect(store.jobs).toHaveLength(0)
  })

  it("the duplicate-upload backfill path also retries the cleanup", async () => {
    const { backend, inner, calls } = faultyBackend({ corruptReads: true, failDeletes: 1 })
    setDocumentObjectBackendForTests(backend)
    const store = partnerStore()
    const bytes = Buffer.from("%PDF-backfill rollback%")
    const hash = store.hashKey("firmA", bytes)
    store.documents.set("doc_legacy", {
      id: "doc_legacy",
      firmId: "firmA",
      matterId: null,
      contentHash: hash,
      sourceChannel: "web",
      classification: "internal",
      storagePath: "",
      isImmutable: false,
      byteSize: 0,
      mimeType: "application/octet-stream",
      objectVersion: 1,
      uploadedBy: "partner_a",
      objectBytesStatus: "missing",
    })
    store.docsByHash.set(`${hash}|loose-vault`, "doc_legacy")
    await expect(
      uploadDocument(store, {
        firmId: "firmA",
        matterId: null,
        bytes,
        sourceChannel: "web",
        classification: "internal",
        idempotencyKey: "fad16003-0000-4000-8000-000000000005",
        uploadedBy: "partner_a",
      })
    ).rejects.toBeInstanceOf(DocumentObjectVerificationError)
    expect(calls.filter((c) => c.startsWith("delete:"))).toHaveLength(2)
    await expect(inner.get("firmA/documents/doc_legacy/v1.enc")).rejects.toThrow(/not found/)
    expect(store.documents.get("doc_legacy")?.storagePath).toBe("")
    expect(store.documents.get("doc_legacy")?.objectBytesStatus).toBe("missing")
  })

  it("a read-back that decrypts to other bytes is refused (and removed) even if the hash check were fooled", async () => {
    const inner = createMemoryDocumentObjectBackend()
    const store = newStore()
    // A hash function that always agrees: only the byte comparison can catch the swap.
    vi.spyOn(store, "hashKey").mockReturnValue("c".repeat(64))
    await createDocumentObjectStore(inner).put({
      store,
      firmId: "firmA",
      docId: "doc_other",
      bytes: Buffer.from("another document's bytes"),
      contentHash: "c".repeat(64),
      mimeType: "application/octet-stream",
    })
    const swapping: DocumentObjectBackend = {
      kind: inner.kind,
      scheme: inner.scheme,
      putIfAbsent: (key, payload) => inner.putIfAbsent(key, payload),
      get: () => inner.get("firmA/documents/doc_other/v1.enc"),
      delete: (key) => inner.delete(key),
    }
    const err = await createDocumentObjectStore(swapping)
      .put({
        store,
        firmId: "firmA",
        docId: "doc_swapped",
        bytes: Buffer.from("the bytes that were uploaded"),
        contentHash: "c".repeat(64),
        mimeType: "application/octet-stream",
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DocumentObjectVerificationError)
    expect((err as Error).message).toBe(
      "document object round-trip verification failed: document object round-trip bytes differ"
    )
    await expect(inner.get("firmA/documents/doc_swapped/v1.enc")).rejects.toThrow(/not found/)
    await expect(inner.get("firmA/documents/doc_other/v1.enc")).resolves.toBeInstanceOf(Buffer)
  })

  it("an existing object is never deleted when the write is refused as a duplicate", async () => {
    const { backend, inner, calls } = faultyBackend({})
    const objects = createDocumentObjectStore(backend)
    const store = newStore()
    const first = Buffer.from("first writer wins")
    await objects.put({
      store,
      firmId: "firmA",
      docId: "doc_dupe",
      bytes: first,
      contentHash: store.hashKey("firmA", first),
      mimeType: "application/octet-stream",
    })
    const second = Buffer.from("second writer must be refused")
    await expect(
      objects.put({
        store,
        firmId: "firmA",
        docId: "doc_dupe",
        bytes: second,
        contentHash: store.hashKey("firmA", second),
        mimeType: "application/octet-stream",
      })
    ).rejects.toThrow(/already exists/)
    expect(calls.filter((c) => c.startsWith("delete:"))).toEqual([])
    const kept = await objects.get(
      store,
      "firmA",
      "fs://firmA/documents/doc_dupe/v1",
      store.hashKey("firmA", first)
    )
    expect(kept.equals(first)).toBe(true)
    expect((await inner.get("firmA/documents/doc_dupe/v1.enc")).length).toBe(1 + 12 + first.length + 16)
  })
})
