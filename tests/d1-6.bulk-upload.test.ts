import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as objectStore from "@/platform/documents/documentObjectStore"
import { newStore, type SpineStore } from "@/platform/spine/store"
import * as documentUpload from "@/services/d1-6/uploadDocument"
import {
  BULK_UPLOAD_CHUNK_BYTES,
  BULK_UPLOAD_MAX_FILES,
  BULK_UPLOAD_MAX_TOTAL_BYTES,
  bulkDeclaredHash,
  finaliseFile,
  getUploadProgress,
  resumeUpload,
  startBulkUpload,
  uploadChunk,
  type BulkUploadCaller,
} from "@/services/d1-6/bulkUpload"

const FLAG = "SIKANDER_FLAG_D1_BULK_UPLOAD"
const caller: BulkUploadCaller = { userId: "partner_a", firmId: "firmA" }

function fileOf(bytes: Buffer, store: SpineStore, firmId: string, name: string) {
  return {
    name,
    size: bytes.length,
    sha256: bulkDeclaredHash(store, firmId, bytes),
    classification: "internal" as const,
  }
}

function declared(size: number, name: string, sha256 = "ab".repeat(32)) {
  return { name, size, sha256, classification: "confidential" as const }
}

function chunkSlice(bytes: Buffer, chunkIdx: number): Buffer {
  const start = (chunkIdx - 1) * BULK_UPLOAD_CHUNK_BYTES
  return bytes.subarray(start, Math.min(start + BULK_UPLOAD_CHUNK_BYTES, bytes.length))
}

describe("L9.1 high-speed bulk upload", () => {
  beforeEach(() => {
    vi.stubEnv(FLAG, "true")
    objectStore.resetDocumentObjectStoreForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    objectStore.resetDocumentObjectStoreForTests()
  })

  it("pins the session caps and the fixed chunk size", () => {
    expect(BULK_UPLOAD_MAX_FILES).toBe(500)
    expect(BULK_UPLOAD_MAX_TOTAL_BYTES).toBe(8 * 1024 * 1024 * 1024)
    expect(BULK_UPLOAD_CHUNK_BYTES).toBe(8 * 1024 * 1024)
    const store = newStore()
    expect(bulkDeclaredHash(store, "firmA", Buffer.from("x"))).toBe(store.hashKey("firmA", Buffer.from("x")))
  })

  it("a 3-file session with one dupe never uploads the dupe and enqueues two OCR jobs", async () => {
    const store = newStore()
    const held = Buffer.from("%PDF-already-held%")
    const freshA = Buffer.from("%PDF-fresh-a%")
    const freshB = Buffer.from("%PDF-fresh-b%")
    const existing = await documentUpload.uploadDocument(store, {
      firmId: "firmA",
      matterId: "m1",
      bytes: held,
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "held-1",
      uploadedBy: "partner_a",
    })
    const puts = vi.spyOn(objectStore, "putStagingChunk")
    const uploads = vi.spyOn(documentUpload, "uploadDocument")
    const started = await startBulkUpload(store, "firmA", "m1", [
      fileOf(freshA, store, "firmA", "a.pdf"),
      fileOf(held, store, "firmA", "dupe.pdf"),
      fileOf(freshB, store, "firmA", "b.pdf"),
    ], caller)
    expect(started.files.map((file) => file.state)).toEqual(["pending", "deduped", "pending"])
    expect(started.files[1]?.docId).toBe(existing.docId)
    await expect(uploadChunk(store, started.sessionId, 1, 1, held, caller)).rejects.toThrow(/chunk refused/)
    await uploadChunk(store, started.sessionId, 0, 1, freshA, caller)
    await uploadChunk(store, started.sessionId, 2, 1, freshB, caller)
    expect(puts.mock.calls.every((call) => call[0].fileIdx !== 1)).toBe(true)
    const first = await finaliseFile(store, started.sessionId, 0, caller)
    const second = await finaliseFile(store, started.sessionId, 2, caller)
    const duped = await finaliseFile(store, started.sessionId, 1, caller)
    expect(uploads).toHaveBeenCalledTimes(2)
    expect(uploads.mock.calls.every((call) => call[1].sourceChannel === "bulk")).toBe(true)
    expect(duped).toEqual({ docId: existing.docId, reused: true })
    expect(store.documents.size).toBe(3)
    expect(documentUpload.ocrJobsFor(store, first.docId)).toHaveLength(1)
    expect(documentUpload.ocrJobsFor(store, second.docId)).toHaveLength(1)
    expect(documentUpload.ocrJobsFor(store, existing.docId)).toHaveLength(1)
    const progress = await getUploadProgress(store, started.sessionId, caller)
    expect(progress.files.map((file) => file.state)).toEqual(["finalised", "deduped", "finalised"])
  })

  it("drops after chunk 2 of 5, then resume lists 3, 4 and 5, and the stored bytes match", async () => {
    const store = newStore()
    const last = 17
    const bytes = Buffer.alloc((5 - 1) * BULK_UPLOAD_CHUNK_BYTES + last, 7)
    bytes[0] = 1
    bytes[bytes.length - 1] = 9
    const started = await startBulkUpload(store, "firmA", "m1", [fileOf(bytes, store, "firmA", "bundle.pdf")], caller)
    await uploadChunk(store, started.sessionId, 0, 1, chunkSlice(bytes, 1), caller)
    await uploadChunk(store, started.sessionId, 0, 2, chunkSlice(bytes, 2), caller)
    const resume = await resumeUpload(store, started.sessionId, caller)
    expect(resume.files.find((file) => file.fileIdx === 0)?.missingChunks).toEqual([3, 4, 5])
    await expect(
      uploadChunk(store, started.sessionId, 0, 5, chunkSlice(bytes, 5).subarray(0, last - 1), caller)
    ).rejects.toThrow(/chunk refused/)
    await uploadChunk(store, started.sessionId, 0, 5, chunkSlice(bytes, 5), caller)
    await uploadChunk(store, started.sessionId, 0, 3, chunkSlice(bytes, 3), caller)
    await uploadChunk(store, started.sessionId, 0, 4, chunkSlice(bytes, 4), caller)
    const done = await finaliseFile(store, started.sessionId, 0, caller)
    const stored = await objectStore.getImmutableDocumentObject(
      store,
      "firmA",
      store.documents.get(done.docId)?.storagePath ?? "",
      store.documents.get(done.docId)?.contentHash ?? ""
    )
    expect(stored.equals(bytes)).toBe(true)
    expect(store.documents.get(done.docId)?.sourceChannel).toBe("bulk")
  }, 30_000)

  it("a hash mismatch at finalise refuses and creates no document or original", async () => {
    const store = newStore()
    const original = Buffer.from("%PDF-original-kept%")
    const kept = await documentUpload.uploadDocument(store, {
      firmId: "firmA",
      matterId: "m1",
      bytes: original,
      sourceChannel: "web",
      classification: "privileged",
      idempotencyKey: "kept-1",
      uploadedBy: "partner_a",
    })
    const good = Buffer.from("%PDF-good-sibling%")
    const bad = Buffer.from("%PDF-bad-hash%")
    const deletes = vi.spyOn(objectStore, "deleteDocumentObject")
    const started = await startBulkUpload(store, "firmA", "m1", [
      fileOf(good, store, "firmA", "good.pdf"),
      { ...fileOf(bad, store, "firmA", "bad.pdf"), sha256: "cd".repeat(32) },
    ], caller)
    await uploadChunk(store, started.sessionId, 0, 1, good, caller)
    await uploadChunk(store, started.sessionId, 1, 1, bad, caller)
    const docsBefore = store.documents.size
    const jobsBefore = store.jobs.length
    await expect(finaliseFile(store, started.sessionId, 1, caller)).rejects.toThrow(/hash mismatch/)
    expect(store.documents.size).toBe(docsBefore)
    expect(store.jobs.length).toBe(jobsBefore)
    expect(deletes).not.toHaveBeenCalled()
    const keptBytes = await objectStore.getImmutableDocumentObject(
      store,
      "firmA",
      store.documents.get(kept.docId)?.storagePath ?? "",
      store.documents.get(kept.docId)?.contentHash ?? ""
    )
    expect(keptBytes.equals(original)).toBe(true)
    const gone = await objectStore.readStagingChunks({
      firmId: "firmA",
      sessionId: started.sessionId,
      fileIdx: 1,
      chunkCount: 1,
    })
    expect(gone).toEqual([null])
    const sibling = await objectStore.readStagingChunks({
      firmId: "firmA",
      sessionId: started.sessionId,
      fileIdx: 0,
      chunkCount: 1,
    })
    expect(sibling[0]?.equals(good)).toBe(true)
    const progress = await getUploadProgress(store, started.sessionId, caller)
    expect(progress.files[1]?.state).toBe("failed")
    await expect(finaliseFile(store, started.sessionId, 1, caller)).rejects.toThrow(/hash mismatch/)
    expect(store.documents.size).toBe(docsBefore)
    const saved = await finaliseFile(store, started.sessionId, 0, caller)
    expect(store.documents.has(saved.docId)).toBe(true)
  })

  it("a replayed identical chunk is a no-op and a different chunk at the same index is refused", async () => {
    const store = newStore()
    const bytes = Buffer.from("%PDF-chunk-once%")
    const started = await startBulkUpload(store, "firmA", null, [fileOf(bytes, store, "firmA", "once.pdf")], caller)
    const puts = vi.spyOn(objectStore, "putStagingChunk")
    await uploadChunk(store, started.sessionId, 0, 1, bytes, caller)
    await uploadChunk(store, started.sessionId, 0, 1, bytes, caller)
    expect(puts).toHaveBeenCalledTimes(1)
    const flipped = Buffer.from(bytes)
    flipped[0] = flipped[0] === 0x25 ? 0x26 : 0x25
    await expect(uploadChunk(store, started.sessionId, 0, 1, flipped, caller)).rejects.toThrow(/chunk refused/)
    expect(puts).toHaveBeenCalledTimes(1)
    const stored = await objectStore.readStagingChunks({
      firmId: "firmA",
      sessionId: started.sessionId,
      fileIdx: 0,
      chunkCount: 1,
    })
    expect(stored[0]?.equals(bytes)).toBe(true)
    expect(store.uploadSessions.get(started.sessionId)?.files[0]?.receivedChunks).toEqual([1])
  })

  it("a cross-firm session id is refused with no leak, and so is another caller", async () => {
    const store = newStore()
    const bytes = Buffer.from("%PDF-sealed-affidavit%")
    const started = await startBulkUpload(
      store,
      "firmA",
      "m1",
      [fileOf(bytes, store, "firmA", "sealed-affidavit.pdf")],
      caller
    )
    const missing = await getUploadProgress(store, "ups_missing", caller).then(
      () => null,
      (err: unknown) => err
    )
    const cross = await getUploadProgress(store, started.sessionId, { userId: "partner_a", firmId: "firmB" }).then(
      () => null,
      (err: unknown) => err
    )
    const otherCaller = await resumeUpload(store, started.sessionId, { userId: "intruder", firmId: "firmA" }).then(
      () => null,
      (err: unknown) => err
    )
    expect(missing).toMatchObject({ name: "PublicError", message: "upload session refused" })
    expect(cross).toMatchObject({ name: "PublicError", message: "upload session refused" })
    expect(otherCaller).toMatchObject({ message: "upload session refused" })
    expect(JSON.stringify(cross)).not.toContain("sealed-affidavit")
    expect(JSON.stringify(cross)).not.toContain("firmA")
    await expect(uploadChunk(store, started.sessionId, 0, 1, bytes, { userId: "partner_a", firmId: "firmB" })).rejects.toThrow(
      /upload session refused/
    )
    await expect(finaliseFile(store, started.sessionId, 0, { userId: "partner_a", firmId: "firmB" })).rejects.toThrow(
      /upload session refused/
    )
    const progress = await getUploadProgress(store, started.sessionId, caller)
    expect(progress.files[0]?.name).toBe("sealed-affidavit.pdf")
    expect(store.documents.size).toBe(0)
  })

  it("exceeding the file-count or byte cap is refused at start, and an unknown classification is refused", async () => {
    const store = newStore()
    const one = () => declared(1, "n.pdf")
    await expect(startBulkUpload(store, "firmA", "m1", Array.from({ length: 501 }, one), caller)).rejects.toThrow(
      /file count cap/
    )
    expect(store.uploadSessions.size).toBe(0)
    const full = await startBulkUpload(store, "firmA", "m1", Array.from({ length: 500 }, one), caller)
    expect(full.files).toHaveLength(500)
    await expect(
      startBulkUpload(store, "firmA", "m1", [declared(BULK_UPLOAD_MAX_TOTAL_BYTES + 1, "huge.pdf")], caller)
    ).rejects.toThrow(/total byte cap/)
    await expect(
      startBulkUpload(
        store,
        "firmA",
        "m1",
        [declared(BULK_UPLOAD_MAX_TOTAL_BYTES, "edge-a.pdf"), declared(1, "edge-b.pdf")],
        caller
      )
    ).rejects.toThrow(/total byte cap/)
    const atCap = await startBulkUpload(
      store,
      "firmA",
      "m9",
      [declared(BULK_UPLOAD_MAX_TOTAL_BYTES, "edge.pdf")],
      caller
    )
    expect(atCap.files[0]?.state).toBe("pending")
    await expect(
      startBulkUpload(store, "firmA", "m1", [{ ...one(), classification: "top-secret" as "confidential" }], caller)
    ).rejects.toThrow(/unknown classification/)
    expect(store.uploadSessions.has(atCap.sessionId)).toBe(true)
  })

  it("finalise replay returns the same docId and does not enqueue a second OCR job", async () => {
    const store = newStore()
    const bytes = Buffer.from("%PDF-replay%")
    const uploads = vi.spyOn(documentUpload, "uploadDocument")
    const started = await startBulkUpload(store, "firmA", "m1", [fileOf(bytes, store, "firmA", "replay.pdf")], caller)
    await uploadChunk(store, started.sessionId, 0, 1, bytes, caller)
    const first = await finaliseFile(store, started.sessionId, 0, caller)
    const second = await finaliseFile(store, started.sessionId, 0, caller)
    expect(second.docId).toBe(first.docId)
    expect(second.reused).toBe(true)
    expect(uploads).toHaveBeenCalledTimes(1)
    expect(documentUpload.ocrJobsFor(store, first.docId)).toHaveLength(1)
    const staged = await objectStore.readStagingChunks({
      firmId: "firmA",
      sessionId: started.sessionId,
      fileIdx: 0,
      chunkCount: 1,
    })
    expect(staged).toEqual([null])
  })

  it("flag off refuses before any write", async () => {
    const store = newStore()
    const bytes = Buffer.from("%PDF-flag%")
    const input = [fileOf(bytes, store, "firmA", "flag.pdf")]
    for (const value of [undefined, "", "false", "yes", "1"] as const) {
      if (value === undefined) delete process.env[FLAG]
      else vi.stubEnv(FLAG, value)
      await expect(startBulkUpload(store, "firmA", "m1", input, caller)).rejects.toThrow(/bulk upload is disabled/)
      expect(store.uploadSessions.size).toBe(0)
    }
    vi.stubEnv(FLAG, " TRUE ")
    const started = await startBulkUpload(store, "firmA", null, input, caller)
    vi.stubEnv(FLAG, "false")
    await expect(uploadChunk(store, started.sessionId, 0, 1, bytes, caller)).rejects.toThrow(/bulk upload is disabled/)
    expect(store.uploadSessions.get(started.sessionId)?.files[0]?.receivedChunks).toEqual([])
    expect(store.documents.size).toBe(0)
  })

  it("dedupes only the same firm and matter, including the loose vault, and still finds a hash when the index row is missing", async () => {
    const store = newStore()
    const bytes = Buffer.from("%PDF-same-bytes%")
    const hash = bulkDeclaredHash(store, "firmA", bytes)
    const inMatter = await documentUpload.uploadDocument(store, {
      firmId: "firmA",
      matterId: "m1",
      bytes,
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "matter-1",
      uploadedBy: "partner_a",
    })
    const otherMatter = await startBulkUpload(store, "firmA", "m2", [fileOf(bytes, store, "firmA", "other.pdf")], caller)
    expect(otherMatter.files[0]?.state).toBe("pending")
    const loose = await startBulkUpload(store, "firmA", null, [fileOf(bytes, store, "firmA", "loose.pdf")], caller)
    expect(loose.files[0]?.state).toBe("pending")
    store.docsByHash.delete(`${hash}|m1`)
    const again = await startBulkUpload(store, "firmA", "m1", [fileOf(bytes, store, "firmA", "again.pdf")], caller)
    expect(again.files[0]).toMatchObject({ state: "deduped", docId: inMatter.docId })
    await documentUpload.uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes,
      sourceChannel: "web",
      classification: "confidential",
      idempotencyKey: "loose-1",
      uploadedBy: "partner_a",
    })
    const looseAgain = await startBulkUpload(store, "firmA", null, [fileOf(bytes, store, "firmA", "loose-2.pdf")], caller)
    expect(looseAgain.files[0]?.state).toBe("deduped")
    const otherFirm = await startBulkUpload(
      store,
      "firmB",
      "m1",
      [fileOf(bytes, store, "firmB", "firm-b.pdf")],
      { userId: "partner_b", firmId: "firmB" }
    )
    expect(otherFirm.files[0]?.state).toBe("pending")
  })

  it("encrypts a staging chunk with the document-object format and never deletes that original", async () => {
    const root = mkdtempSync(join(tmpdir(), "w1-l91-staging-"))
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_BACKEND", "fs")
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ROOT", root)
    try {
      const store = newStore()
      const bytes = Buffer.from("staging-secret-bytes")
      const started = await startBulkUpload(store, "firmA", "m1", [fileOf(bytes, store, "firmA", "secret.pdf")], caller)
      await uploadChunk(store, started.sessionId, 0, 1, bytes, caller)
      const storagePath = `fs://upload-staging/firmA/${started.sessionId}/0/1`
      const payload = readFileSync(objectStore.filesystemPathForStoragePath(storagePath))
      expect(payload.equals(bytes)).toBe(false)
      expect(objectStore.decryptDocumentObjectPayload(payload).equals(bytes)).toBe(true)
      expect(storagePath.includes("/documents/")).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not call deleteDocumentObject on a document storage path", () => {
    const bulkSrc = readFileSync(new URL("../services/d1-6/bulkUpload.ts", import.meta.url), "utf8")
    const storeSrc = readFileSync(new URL("../platform/documents/documentObjectStore.ts", import.meta.url), "utf8")
    expect(bulkSrc.includes("deleteDocumentObject")).toBe(false)
    expect(bulkSrc.includes("TODO(W1-L45)")).toBe(true)
    expect(bulkSrc.includes("isLooseUploadBlocked")).toBe(true)
    const start = storeSrc.indexOf("// L9.1 upload-staging")
    const end = storeSrc.indexOf("export function resetDocumentObjectStoreForTests")
    expect(start).toBeGreaterThan(-1)
    expect(storeSrc.slice(start, end).includes("deleteDocumentObject")).toBe(false)
  })

  it.skip("isLooseUploadBlocked", () => {
    // W1-L45 is not on main at 7ae1a33f. When isLooseUploadBlocked lands, this
    // test must start a loose-vault session (matterId null) while that function
    // returns true and expect a refusal before any session or staging write.
  })
})
