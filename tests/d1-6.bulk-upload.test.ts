import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as objectStore from "@/platform/documents/documentObjectStore"
import * as staging from "@/platform/documents/uploadStagingStore"
import { uploadSessionsOf } from "@/platform/spine/bulkUploadSession"
import { newStore, type SpineStore } from "@/platform/spine/store"
import * as documentUpload from "@/services/d1-6/uploadDocument"
import {
  BULK_UPLOAD_CHUNK_BYTES,
  BULK_UPLOAD_MAX_FILES,
  BULK_UPLOAD_MAX_TOTAL_BYTES,
  BULK_UPLOAD_STAGING_TTL_MS,
  bulkDeclaredHash,
  finaliseFile,
  getUploadProgress,
  resumeUpload,
  parseStoredUploadSession,
  pendingSessionMutations,
  startBulkUpload,
  sweepExpiredBulkUploads,
  uploadChunk,
  uploadSessionDocument,
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

function isIndexSegment(part: string): boolean {
  return /^[0-9]+$/.test(part)
}

/**
 * Firestore field-path update. A numeric segment on an array parent replaces
 * that array with a map, so `files.0` drops every other file. A whole-field
 * write of `files` keeps the array.
 */
function applyFieldPatch(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(current)
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split(".")
    let cursor: Record<string, unknown> = next
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] ?? ""
      const child = cursor[part]
      const descent = parts[i + 1] ?? ""
      // A numeric index into an array is not an element write. Firestore replaces that array with a map.
      if (!child || typeof child !== "object" || (Array.isArray(child) && isIndexSegment(descent))) {
        const map: Record<string, unknown> = {}
        cursor[part] = map
        cursor = map
        continue
      }
      cursor = child as Record<string, unknown>
    }
    const last = parts[parts.length - 1] ?? ""
    cursor[last] = typeof value === "object" && value !== null ? structuredClone(value) : value
  }
  return next
}

function sessionFirestore(rows: Map<string, Record<string, unknown>>, names?: string[]) {
  const versions = new Map<string, number>()
  const bump = (key: string) => versions.set(key, (versions.get(key) ?? 0) + 1)
  const read = (key: string, id: string) => {
    const data = rows.get(key)
    return {
      exists: data !== undefined,
      id,
      version: versions.get(key) ?? 0,
      data: () => (data ? structuredClone(data) : undefined),
    }
  }
  const api = (key: string, id: string) => ({
    id,
    path: key,
    read: () => read(key, id),
    async set(data: Record<string, unknown>) {
      rows.set(key, structuredClone(data))
      bump(key)
    },
    async update(patch: Record<string, unknown>) {
      const current = rows.get(key)
      if (!current) throw new Error("upload session missing")
      rows.set(key, applyFieldPatch(current, patch))
      bump(key)
    },
    async delete() {
      rows.delete(key)
      bump(key)
    },
    async get() {
      const snap = read(key, id)
      return { exists: snap.exists, id, data: snap.data }
    },
  })
  return {
    collection(name: string) {
      names?.push(name)
      return {
        doc(id: string) {
          return api(`${name}/${id}`, id)
        },
      }
    },
    async runTransaction<T>(
      fn: (tx: {
        get: (ref: ReturnType<typeof api>) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>
        set: (ref: ReturnType<typeof api>, data: Record<string, unknown>) => void
        update: (ref: ReturnType<typeof api>, data: Record<string, unknown>) => void
        delete: (ref: ReturnType<typeof api>) => void
      }) => Promise<T>
    ): Promise<T> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const seen = new Map<string, number>()
        const pending = new Map<string, Record<string, unknown> | null>()
        const tx = {
          async get(ref: ReturnType<typeof api>) {
            const snap = ref.read()
            seen.set(ref.path, snap.version)
            return { exists: snap.exists, data: snap.data }
          },
          set(ref: ReturnType<typeof api>, data: Record<string, unknown>) {
            pending.set(ref.path, structuredClone(data))
          },
          update(ref: ReturnType<typeof api>, patch: Record<string, unknown>) {
            const staged = pending.get(ref.path)
            const base = staged === undefined ? rows.get(ref.path) : staged
            if (!base) throw new Error("upload session missing")
            pending.set(ref.path, applyFieldPatch(base, patch))
          },
          delete(ref: ReturnType<typeof api>) {
            pending.set(ref.path, null)
          },
        }
        const result = await fn(tx)
        let conflict = false
        for (const [path, version] of seen) {
          if ((versions.get(path) ?? 0) !== version) conflict = true
        }
        if (conflict) continue
        for (const [path, data] of pending) {
          if (data === null) rows.delete(path)
          else rows.set(path, data)
          bump(path)
        }
        return result
      }
      throw new Error("transaction contention")
    },
  }
}

function chunkSlice(bytes: Buffer, chunkIdx: number): Buffer {
  const start = (chunkIdx - 1) * BULK_UPLOAD_CHUNK_BYTES
  return bytes.subarray(start, Math.min(start + BULK_UPLOAD_CHUNK_BYTES, bytes.length))
}

describe("L9.1 high-speed bulk upload", () => {
  beforeEach(() => {
    vi.stubEnv(FLAG, "true")
    objectStore.resetDocumentObjectStoreForTests()
    staging.resetUploadStagingForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    objectStore.resetDocumentObjectStoreForTests()
    staging.resetUploadStagingForTests()
  })

  it("pins the session caps and the fixed chunk size", () => {
    expect(BULK_UPLOAD_MAX_FILES).toBe(500)
    expect(BULK_UPLOAD_MAX_TOTAL_BYTES).toBe(8 * 1024 * 1024 * 1024)
    expect(BULK_UPLOAD_CHUNK_BYTES).toBe(8 * 1024 * 1024)
    expect(BULK_UPLOAD_STAGING_TTL_MS).toBe(24 * 60 * 60 * 1000)
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
    const puts = vi.spyOn(staging, "putStagingChunk")
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
    const gone = await staging.readStagingChunks({
      firmId: "firmA",
      matterId: "m1",
      sessionId: started.sessionId,
      fileIdx: 1,
      chunkCount: 1,
    })
    expect(gone).toEqual([null])
    const sibling = await staging.readStagingChunks({
      firmId: "firmA",
      matterId: "m1",
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
    const puts = vi.spyOn(staging, "putStagingChunk")
    await uploadChunk(store, started.sessionId, 0, 1, bytes, caller)
    await uploadChunk(store, started.sessionId, 0, 1, bytes, caller)
    expect(puts).toHaveBeenCalledTimes(1)
    const flipped = Buffer.from(bytes)
    flipped[0] = flipped[0] === 0x25 ? 0x26 : 0x25
    await expect(uploadChunk(store, started.sessionId, 0, 1, flipped, caller)).rejects.toThrow(/chunk refused/)
    expect(puts).toHaveBeenCalledTimes(1)
    const stored = await staging.readStagingChunks({
      firmId: "firmA",
      matterId: null,
      sessionId: started.sessionId,
      fileIdx: 0,
      chunkCount: 1,
    })
    expect(uploadSessionsOf(store).get(started.sessionId)?.storagePath).toContain("upload-staging/firmA/loose/")
    expect(stored[0]?.equals(bytes)).toBe(true)
    expect(uploadSessionsOf(store).get(started.sessionId)?.files[0]?.receivedChunks).toEqual([1])
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
    expect(uploadSessionsOf(store).size).toBe(0)
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
    expect(uploadSessionsOf(store).has(atCap.sessionId)).toBe(true)
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
    const staged = await staging.readStagingChunks({
      firmId: "firmA",
      matterId: "m1",
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
      expect(uploadSessionsOf(store).size).toBe(0)
    }
    vi.stubEnv(FLAG, " TRUE ")
    const started = await startBulkUpload(store, "firmA", null, input, caller)
    vi.stubEnv(FLAG, "false")
    await expect(uploadChunk(store, started.sessionId, 0, 1, bytes, caller)).rejects.toThrow(/bulk upload is disabled/)
    expect(uploadSessionsOf(store).get(started.sessionId)?.files[0]?.receivedChunks).toEqual([])
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
      const storagePath = `fs://upload-staging/firmA/m1/${started.sessionId}/0/1`
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
    const stagingSrc = readFileSync(new URL("../platform/documents/uploadStagingStore.ts", import.meta.url), "utf8")
    expect(bulkSrc.includes("deleteDocumentObject")).toBe(false)
    expect(bulkSrc.includes("TODO(W1-L45)")).toBe(true)
    expect(bulkSrc.includes("isLooseUploadBlocked")).toBe(true)
    expect(bulkSrc.includes("isLooseUploadBlocked(")).toBe(false)
    expect(stagingSrc.includes("deleteDocumentObject")).toBe(false)
    expect(stagingSrc.includes("// L9.1 upload-staging")).toBe(true)
  })

  it("every row carries firmId, and an expired session deletes only its staging", async () => {
    const store = newStore()
    const original = Buffer.from("keep-this-original")
    const kept = await documentUpload.uploadDocument(store, {
      firmId: "firmA",
      matterId: "m1",
      bytes: original,
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "keep-1",
      uploadedBy: "partner_a",
    })
    const bytes = Buffer.from("staging-temp")
    const started = await startBulkUpload(store, "firmA", "m1", [fileOf(bytes, store, "firmA", "temp.pdf")], caller)
    await uploadChunk(store, started.sessionId, 0, 1, bytes, caller)
    const row = uploadSessionsOf(store).get(started.sessionId)
    expect(row?.firmId).toBe("firmA")
    expect(row?.files.every((file) => file.firmId === "firmA")).toBe(true)
    expect(row && row.expiresAtMs - row.createdAtMs).toBe(BULK_UPLOAD_STAGING_TTL_MS)
    expect(row?.storagePath.endsWith(`upload-staging/firmA/m1/${started.sessionId}`)).toBe(true)
    expect(row?.storagePath.includes("/documents/")).toBe(false)
    const durable = uploadSessionDocument(row!)
    expect(durable).toMatchObject({
      collection: "upload_sessions",
      firmId: "firmA",
      matterId: "m1",
      callerId: "partner_a",
    })
    expect(durable.storagePath).toContain("upload-staging/firmA/m1/")
    row!.expiresAtMs = Date.now() - 1
    await expect(
      getUploadProgress(store, started.sessionId, { userId: "other", firmId: "firmB" })
    ).rejects.toThrow(/upload session refused/)
    expect(uploadSessionsOf(store).has(started.sessionId)).toBe(true)
    await expect(getUploadProgress(store, started.sessionId, caller)).rejects.toThrow(/bulk upload session expired/)
    expect(uploadSessionsOf(store).has(started.sessionId)).toBe(false)
    const chunks = await staging.readStagingChunks({
      firmId: "firmA",
      matterId: "m1",
      sessionId: started.sessionId,
      fileIdx: 0,
      chunkCount: 1,
    })
    expect(chunks).toEqual([null])
    const still = await objectStore.getImmutableDocumentObject(
      store,
      "firmA",
      store.documents.get(kept.docId)?.storagePath ?? "",
      store.documents.get(kept.docId)?.contentHash ?? ""
    )
    expect(still.equals(original)).toBe(true)
  })

  it("sweepExpiredBulkUploads drops expired staging when the flag is off and keeps a live session", async () => {
    const store = newStore()
    const live = Buffer.from("live-bytes")
    const dead = Buffer.from("dead-bytes")
    const liveStart = await startBulkUpload(store, "firmA", "m1", [fileOf(live, store, "firmA", "live.pdf")], caller)
    const deadStart = await startBulkUpload(store, "firmA", "m1", [fileOf(dead, store, "firmA", "dead.pdf")], caller)
    await uploadChunk(store, liveStart.sessionId, 0, 1, live, caller)
    await uploadChunk(store, deadStart.sessionId, 0, 1, dead, caller)
    const deadRow = uploadSessionsOf(store).get(deadStart.sessionId)
    expect(deadRow).toBeTruthy()
    deadRow!.expiresAtMs = 1
    staging.setStagingWrittenAtForTests(`${deadRow!.storagePath}/0/1`, 1)
    vi.stubEnv(FLAG, "false")
    const removed = await sweepExpiredBulkUploads(store, BULK_UPLOAD_STAGING_TTL_MS + 1)
    expect(removed).toBe(1)
    expect(uploadSessionsOf(store).has(deadStart.sessionId)).toBe(false)
    expect(uploadSessionsOf(store).has(liveStart.sessionId)).toBe(true)
    const gone = await staging.readStagingChunks({
      firmId: "firmA",
      matterId: "m1",
      sessionId: deadStart.sessionId,
      fileIdx: 0,
      chunkCount: 1,
    })
    expect(gone).toEqual([null])
    const kept = await staging.readStagingChunks({
      firmId: "firmA",
      matterId: "m1",
      sessionId: liveStart.sessionId,
      fileIdx: 0,
      chunkCount: 1,
    })
    expect(kept[0]?.equals(live)).toBe(true)
    await expect(startBulkUpload(store, "firmA", "m1", [fileOf(live, store, "firmA", "again.pdf")], caller)).rejects.toThrow(
      /disabled|refused/
    )
  })

  it("sweeps an orphan chunk from storage by age and leaves another matter and an original", async () => {
    const store = newStore()
    const original = Buffer.from("original-stays")
    const kept = await documentUpload.uploadDocument(store, {
      firmId: "firmA",
      matterId: "m1",
      bytes: original,
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "orig-1",
      uploadedBy: "partner_a",
    })
    const oldBytes = Buffer.from("orphan-old")
    const youngBytes = Buffer.from("orphan-young")
    const otherBytes = Buffer.from("other-matter")
    const oldSession = await startBulkUpload(store, "firmA", "m1", [fileOf(oldBytes, store, "firmA", "old.pdf")], caller)
    const youngSession = await startBulkUpload(store, "firmA", "m1", [fileOf(youngBytes, store, "firmA", "young.pdf")], caller)
    const other = await startBulkUpload(store, "firmA", "m2", [fileOf(otherBytes, store, "firmA", "other.pdf")], caller)
    await uploadChunk(store, oldSession.sessionId, 0, 1, oldBytes, caller)
    await uploadChunk(store, youngSession.sessionId, 0, 1, youngBytes, caller)
    await uploadChunk(store, other.sessionId, 0, 1, otherBytes, caller)
    const oldRow = uploadSessionsOf(store).get(oldSession.sessionId)!
    staging.setStagingWrittenAtForTests(`${oldRow.storagePath}/0/1`, 1)
    uploadSessionsOf(store).delete(oldSession.sessionId)
    const removed = await sweepExpiredBulkUploads(store, BULK_UPLOAD_STAGING_TTL_MS + 2)
    expect(removed).toBe(1)
    const orphan = await staging.readStagingChunks({
      firmId: "firmA",
      matterId: "m1",
      sessionId: oldSession.sessionId,
      fileIdx: 0,
      chunkCount: 1,
    })
    expect(orphan).toEqual([null])
    const young = await staging.readStagingChunks({
      firmId: "firmA",
      matterId: "m1",
      sessionId: youngSession.sessionId,
      fileIdx: 0,
      chunkCount: 1,
    })
    expect(young[0]?.equals(youngBytes)).toBe(true)
    const sibling = await staging.readStagingChunks({
      firmId: "firmA",
      matterId: "m2",
      sessionId: other.sessionId,
      fileIdx: 0,
      chunkCount: 1,
    })
    expect(sibling[0]?.equals(otherBytes)).toBe(true)
    const still = await objectStore.getImmutableDocumentObject(
      store,
      "firmA",
      store.documents.get(kept.docId)?.storagePath ?? "",
      store.documents.get(kept.docId)?.contentHash ?? ""
    )
    expect(still.equals(original)).toBe(true)
  })

  it("writes upload_sessions in Firestore and reloads the row after the memory map is dropped", async () => {
    const rows = new Map<string, Record<string, unknown>>()
    const names: string[] = []
    const db = sessionFirestore(rows, names)
    const { setFirestorePersistenceForTests } = await import("@/platform/persistence/runtimeRepositories")
    setFirestorePersistenceForTests(db)
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    try {
      const store = newStore()
      const bytes = Buffer.from("durable-session")
      const started = await startBulkUpload(store, "firmA", "m1", [fileOf(bytes, store, "firmA", "durable.pdf")], caller)
      await uploadChunk(store, started.sessionId, 0, 1, bytes, caller)
      expect(names).toContain("upload_sessions")
      const saved = rows.get(`upload_sessions/${started.sessionId}`)
      expect(saved?.firmId).toBe("firmA")
      expect(saved?.matterId).toBe("m1")
      const files = saved?.files as Array<{ firmId: string }>
      expect(files.every((file) => file.firmId === "firmA")).toBe(true)
      expect(String(saved?.storagePath)).toContain("upload-staging/firmA/m1/")
      uploadSessionsOf(store).clear()
      const progress = await getUploadProgress(store, started.sessionId, caller)
      expect(progress.files[0]?.bytesReceived).toBe(bytes.length)
    } finally {
      setFirestorePersistenceForTests(null)
    }
  })

  it("a matter prefix delete removes that matter's chunks only", async () => {
    const store = newStore()
    const mine = Buffer.from("matter-m1")
    const other = Buffer.from("matter-m2")
    const foreign = Buffer.from("firm-b")
    const a = await startBulkUpload(store, "firmA", "m1", [fileOf(mine, store, "firmA", "a.pdf")], caller)
    const b = await startBulkUpload(store, "firmA", "m2", [fileOf(other, store, "firmA", "b.pdf")], caller)
    const c = await startBulkUpload(
      store,
      "firmB",
      "m1",
      [fileOf(foreign, store, "firmB", "c.pdf")],
      { userId: "partner_b", firmId: "firmB" }
    )
    await uploadChunk(store, a.sessionId, 0, 1, mine, caller)
    await uploadChunk(store, b.sessionId, 0, 1, other, caller)
    await uploadChunk(store, c.sessionId, 0, 1, foreign, { userId: "partner_b", firmId: "firmB" })
    const removed = await staging.deleteStagingObjectsByPrefix(staging.stagingMatterPrefix("firmA", "m1"))
    expect(removed).toBe(1)
    expect(
      await staging.readStagingChunks({ firmId: "firmA", matterId: "m1", sessionId: a.sessionId, fileIdx: 0, chunkCount: 1 })
    ).toEqual([null])
    expect(
      (await staging.readStagingChunks({ firmId: "firmA", matterId: "m2", sessionId: b.sessionId, fileIdx: 0, chunkCount: 1 }))[0]?.equals(other)
    ).toBe(true)
    expect(
      (await staging.readStagingChunks({ firmId: "firmB", matterId: "m1", sessionId: c.sessionId, fileIdx: 0, chunkCount: 1 }))[0]?.equals(foreign)
    ).toBe(true)
  })

  it.skip("isLooseUploadBlocked", () => {
    // isLooseUploadBlocked is on main and this module does not call it.
    // When it is wired, catch only (404, feature_disabled) and rethrow every
    // other error. Matter authorization stays in the route. This test must
    // then start a loose-vault session (matterId null) while that function
    // returns true and expect a refusal before any session or staging write.
  })

  it("starting a second upload sweeps and the first session still finalises", async () => {
    const store = newStore()
    const bytes = Buffer.from("young-session-a")
    const started = await startBulkUpload(store, "firmA", "m1", [fileOf(bytes, store, "firmA", "a.pdf")], caller)
    await uploadChunk(store, started.sessionId, 0, 1, bytes, caller)
    await startBulkUpload(store, "firmA", "m1", [fileOf(Buffer.from("session-b"), store, "firmA", "b.pdf")], caller)
    const done = await finaliseFile(store, started.sessionId, 0, caller)
    expect(done.docId).toBeTruthy()
    expect(uploadSessionsOf(store).get(started.sessionId)?.files[0]?.state).toBe("finalised")
  })

  it("a sweep keeps a chunk younger than the ttl and drops one that has reached it", async () => {
    const store = newStore()
    const now = 5_000_000_000
    const youngBytes = Buffer.from("still-young")
    const agedBytes = Buffer.from("now-aged")
    const young = await startBulkUpload(store, "firmA", "m1", [fileOf(youngBytes, store, "firmA", "young.pdf")], caller)
    const aged = await startBulkUpload(store, "firmA", "m1", [fileOf(agedBytes, store, "firmA", "aged.pdf")], caller)
    await uploadChunk(store, young.sessionId, 0, 1, youngBytes, caller)
    await uploadChunk(store, aged.sessionId, 0, 1, agedBytes, caller)
    const youngRow = uploadSessionsOf(store).get(young.sessionId)!
    const agedRow = uploadSessionsOf(store).get(aged.sessionId)!
    staging.setStagingWrittenAtForTests(`${youngRow.storagePath}/0/1`, now - BULK_UPLOAD_STAGING_TTL_MS + 1)
    staging.setStagingWrittenAtForTests(`${agedRow.storagePath}/0/1`, now - BULK_UPLOAD_STAGING_TTL_MS)
    const removed = await sweepExpiredBulkUploads(store, now)
    expect(removed).toBe(1)
    expect(
      (await staging.readStagingChunks({ firmId: "firmA", matterId: "m1", sessionId: young.sessionId, fileIdx: 0, chunkCount: 1 }))[0]?.equals(
        youngBytes
      )
    ).toBe(true)
    expect(
      await staging.readStagingChunks({ firmId: "firmA", matterId: "m1", sessionId: aged.sessionId, fileIdx: 0, chunkCount: 1 })
    ).toEqual([null])
  })

  it("a matter id of documents is swept, and another firm's start does not sweep this firm", async () => {
    const store = newStore()
    const bytes = Buffer.from("documents-segment")
    const foreign = Buffer.from("other-firm-aged")
    const started = await startBulkUpload(store, "firmA", "documents", [fileOf(bytes, store, "firmA", "d.pdf")], caller)
    const other = await startBulkUpload(
      store,
      "firmB",
      "m1",
      [fileOf(foreign, store, "firmB", "f.pdf")],
      { userId: "partner_b", firmId: "firmB" }
    )
    await uploadChunk(store, started.sessionId, 0, 1, bytes, caller)
    await uploadChunk(store, other.sessionId, 0, 1, foreign, { userId: "partner_b", firmId: "firmB" })
    const row = uploadSessionsOf(store).get(started.sessionId)!
    const foreignRow = uploadSessionsOf(store).get(other.sessionId)!
    staging.setStagingWrittenAtForTests(`${row.storagePath}/0/1`, 1)
    staging.setStagingWrittenAtForTests(`${foreignRow.storagePath}/0/1`, 1)
    const listed = await staging.listStagingObjects(`upload-staging/firmA/documents/`)
    expect(listed.map((item) => item.key)).toContain(`upload-staging/firmA/documents/${started.sessionId}/0/1`)
    await startBulkUpload(store, "firmB", "m9", [fileOf(Buffer.from("b2"), store, "firmB", "b2.pdf")], {
      userId: "partner_b",
      firmId: "firmB",
    })
    expect(
      (await staging.readStagingChunks({
        firmId: "firmA",
        matterId: "documents",
        sessionId: started.sessionId,
        fileIdx: 0,
        chunkCount: 1,
      }))[0]?.equals(bytes)
    ).toBe(true)
    const removed = await sweepExpiredBulkUploads(store, BULK_UPLOAD_STAGING_TTL_MS + 5, "firmA")
    expect(removed).toBe(1)
    expect(
      await staging.readStagingChunks({
        firmId: "firmA",
        matterId: "documents",
        sessionId: started.sessionId,
        fileIdx: 0,
        chunkCount: 1,
      })
    ).toEqual([null])
  })

  it("a 403 delete is not removal, and only 204 or 404 clears the prefix", async () => {
    const store = newStore()
    const bytes = Buffer.from("locked-chunk")
    const started = await startBulkUpload(store, "firmA", "m1", [fileOf(bytes, store, "firmA", "lock.pdf")], caller)
    await uploadChunk(store, started.sessionId, 0, 1, bytes, caller)
    const prefix = staging.stagingMatterPrefix("firmA", "m1")
    staging.setStagingDeleteStatusForTests(async () => 403)
    await expect(staging.deleteStagingObjectsByPrefix(prefix)).rejects.toThrow(/403/)
    expect(
      (await staging.readStagingChunks({ firmId: "firmA", matterId: "m1", sessionId: started.sessionId, fileIdx: 0, chunkCount: 1 }))[0]?.equals(
        bytes
      )
    ).toBe(true)
    staging.setStagingDeleteStatusForTests(async () => 200)
    await expect(staging.deleteStagingObjectsByPrefix(prefix)).rejects.toThrow(/200/)
    staging.setStagingDeleteStatusForTests(async () => 204)
    await expect(staging.deleteStagingObjectsByPrefix(prefix)).resolves.toBe(1)
    expect(
      await staging.readStagingChunks({ firmId: "firmA", matterId: "m1", sessionId: started.sessionId, fileIdx: 0, chunkCount: 1 })
    ).toEqual([null])
    expect(staging.stagingDeleteCountsAsGone(204)).toBe(true)
    expect(staging.stagingDeleteCountsAsGone(404)).toBe(true)
    expect(staging.stagingDeleteCountsAsGone(403)).toBe(false)
    expect(staging.stagingDeleteCountsAsGone(null)).toBe(false)
    expect(staging.stagingSharesLockedVaultBucket()).toBe(false)
    expect(staging.stagingDeletionAck(true)).toMatchObject({ outcome: "retained", detail: { locked: true, reason: "locked_vault_bucket" } })
    expect(staging.stagingDeletionAck(false).outcome).toBe("purged")
    const batches = staging.chunkFirestoreWrites(Array.from({ length: 501 }, (_, i) => i))
    expect(batches.map((batch) => batch.length)).toEqual([450, 51])
    expect(batches.every((batch) => batch.length <= 500)).toBe(true)
  })

  it("a deleted Firestore row is not restored from the instance cache, and a bad row is not loaded", async () => {
    const rows = new Map<string, Record<string, unknown>>()
    const db = {
      collection(name: string) {
        return {
          doc(id: string) {
            return {
              async set(data: Record<string, unknown>) {
                rows.set(`${name}/${id}`, data)
              },
              async delete() {
                rows.delete(`${name}/${id}`)
              },
              async get() {
                const data = rows.get(`${name}/${id}`)
                return { exists: data !== undefined, data: () => data }
              },
            }
          },
        }
      },
    }
    const { setFirestorePersistenceForTests } = await import("@/platform/persistence/runtimeRepositories")
    setFirestorePersistenceForTests(db)
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    try {
      const store = newStore()
      const bytes = Buffer.from("cached-session")
      const started = await startBulkUpload(store, "firmA", "m1", [fileOf(bytes, store, "firmA", "cache.pdf")], caller)
      expect(uploadSessionsOf(store).has(started.sessionId)).toBe(true)
      rows.delete(`upload_sessions/${started.sessionId}`)
      await expect(getUploadProgress(store, started.sessionId, caller)).rejects.toThrow(/upload session refused/)
      expect(rows.has(`upload_sessions/${started.sessionId}`)).toBe(false)
      expect(uploadSessionsOf(store).has(started.sessionId)).toBe(false)
      const again = await startBulkUpload(store, "firmA", "m1", [fileOf(bytes, store, "firmA", "cache.pdf")], caller)
      rows.set(`upload_sessions/${again.sessionId}`, { firmId: "firmA", matterId: 4, files: [] })
      await expect(getUploadProgress(store, again.sessionId, caller)).rejects.toThrow(/upload session refused/)
      expect(rows.get(`upload_sessions/${again.sessionId}`)).toMatchObject({ matterId: 4 })
      expect(parseStoredUploadSession("x", { firmId: "firmA", matterId: 4, files: [] })).toBeUndefined()
    } finally {
      setFirestorePersistenceForTests(null)
    }
  })

  it("a numeric segment on an array field replaces that array with a map", () => {
    const patched = applyFieldPatch(
      { files: [{ name: "a" }, { name: "b" }, { name: "c" }], marker: "keep" },
      { "files.1": { name: "b2" } }
    )
    expect(Array.isArray(patched.files)).toBe(false)
    expect(patched.files).toEqual({ "1": { name: "b2" } })
    expect(patched.marker).toBe("keep")
  })

  it("a per-file session write does not use a files index field path", () => {
    const src = readFileSync(new URL("../services/d1-6/bulkUpload.ts", import.meta.url), "utf8")
    const helpers = readFileSync(new URL("../platform/persistence/runtimeRepositories.ts", import.meta.url), "utf8")
    expect(src.includes("files.${")).toBe(false)
    expect(src.includes("getRuntimeFirestore")).toBe(false)
    expect(src.includes("updateRuntimeDocument")).toBe(true)
    expect(helpers.includes("runTransaction")).toBe(true)
  })

  it("a chunk write to one of three files leaves the other two in the array", async () => {
    const rows = new Map<string, Record<string, unknown>>()
    const db = sessionFirestore(rows)
    const { setFirestorePersistenceForTests } = await import("@/platform/persistence/runtimeRepositories")
    setFirestorePersistenceForTests(db)
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    try {
      const store = newStore()
      const first = Buffer.from("file-a")
      const middle = Buffer.from("file-b")
      const last = Buffer.from("file-c")
      const started = await startBulkUpload(
        store,
        "firmA",
        "m1",
        [fileOf(first, store, "firmA", "a.pdf"), fileOf(middle, store, "firmA", "b.pdf"), fileOf(last, store, "firmA", "c.pdf")],
        caller
      )
      await uploadChunk(store, started.sessionId, 1, 1, middle, caller)
      const saved = rows.get(`upload_sessions/${started.sessionId}`)
      expect(saved).toBeTruthy()
      expect(Array.isArray(saved?.files)).toBe(true)
      const parsed = parseStoredUploadSession(started.sessionId, saved ?? {})
      expect(parsed?.files.map((file) => file.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"])
      expect(parsed?.files[0]?.receivedChunks).toEqual([])
      expect(parsed?.files[0]?.state).toBe("pending")
      expect(parsed?.files[1]?.receivedChunks).toEqual([1])
      expect(parsed?.files[1]?.state).toBe("uploading")
      expect(parsed?.files[2]?.receivedChunks).toEqual([])
      expect(parsed?.files[2]?.state).toBe("pending")
      expect(new Set(parsed?.files.map((file) => file.fileId)).size).toBe(3)
      const legacy = structuredClone(saved ?? {})
      for (const file of legacy.files as Array<Record<string, unknown>>) delete file.fileId
      expect(parseStoredUploadSession(started.sessionId, legacy)?.files).toHaveLength(3)
    } finally {
      setFirestorePersistenceForTests(null)
    }
  })

  it("two instances finalising different files keep both, without a shared lock", async () => {
    const rows = new Map<string, Record<string, unknown>>()
    const db = sessionFirestore(rows)
    const { setFirestorePersistenceForTests } = await import("@/platform/persistence/runtimeRepositories")
    setFirestorePersistenceForTests(db)
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    let waiting = 0
    let sessionKey = ""
    let releaseBoth: () => void = () => {}
    const bothInside = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    if (vi.isMockFunction(documentUpload.uploadDocument)) vi.mocked(documentUpload.uploadDocument).mockRestore()
    const realUpload = documentUpload.uploadDocument.bind(documentUpload)
    const spy = vi.spyOn(documentUpload, "uploadDocument").mockImplementation(async (store, input) => {
      waiting += 1
      if (waiting === 2) {
        const row = rows.get(sessionKey)
        if (row) row.marker = "keep"
        releaseBoth()
      }
      const opened = await Promise.race([
        bothInside,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("the two finalises did not overlap")), 2000)
        }),
      ])
      void opened
      return realUpload(store, input)
    })
    try {
      const leftStore = newStore()
      const rightStore = newStore()
      const left = Buffer.from("cross-left")
      const right = Buffer.from("cross-right")
      const started = await startBulkUpload(
        leftStore,
        "firmA",
        "m1",
        [fileOf(left, leftStore, "firmA", "left.pdf"), fileOf(right, leftStore, "firmA", "right.pdf")],
        caller
      )
      await uploadChunk(leftStore, started.sessionId, 0, 1, left, caller)
      await uploadChunk(leftStore, started.sessionId, 1, 1, right, caller)
      const key = `upload_sessions/${started.sessionId}`
      sessionKey = key
      const [first, second] = await Promise.all([
        finaliseFile(leftStore, started.sessionId, 0, caller),
        finaliseFile(rightStore, started.sessionId, 1, caller),
      ])
      const saved = rows.get(key)
      const files = (saved?.files ?? []) as Array<{ state: string; docId?: string }>
      expect(saved?.marker).toBe("keep")
      expect(files.map((file) => file.state)).toEqual(["finalised", "finalised"])
      expect(files[0]?.docId).toBe(first.docId)
      expect(files[1]?.docId).toBe(second.docId)
      await expect(finaliseFile(leftStore, started.sessionId, 0, caller)).resolves.toMatchObject({ docId: first.docId, reused: true })
      await expect(finaliseFile(rightStore, started.sessionId, 1, caller)).resolves.toMatchObject({ docId: second.docId, reused: true })
    } finally {
      spy.mockRestore()
      setFirestorePersistenceForTests(null)
    }
  })

  it("overlapping Firestore chunk writes and finalises keep both files", async () => {
    const rows = new Map<string, Record<string, unknown>>()
    const db = sessionFirestore(rows)
    const { setFirestorePersistenceForTests } = await import("@/platform/persistence/runtimeRepositories")
    setFirestorePersistenceForTests(db)
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    const realRead = staging.readStagingChunks.bind(staging)
    let inFlight = 0
    let maxInFlight = 0
    const spy = vi.spyOn(staging, "readStagingChunks").mockImplementation(async (input) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        return await realRead(input)
      } finally {
        inFlight -= 1
      }
    })
    try {
      const store = newStore()
      const left = Buffer.from("left-chunk")
      const right = Buffer.from("right-chunk")
      const started = await startBulkUpload(
        store,
        "firmA",
        "m1",
        [fileOf(left, store, "firmA", "left.pdf"), fileOf(right, store, "firmA", "right.pdf")],
        caller
      )
      await Promise.all([
        uploadChunk(store, started.sessionId, 0, 1, left, caller),
        uploadChunk(store, started.sessionId, 1, 1, right, caller),
      ])
      const saved = rows.get(`upload_sessions/${started.sessionId}`)
      const files = saved?.files as Array<{ receivedChunks: number[] }>
      expect(files[0]?.receivedChunks).toEqual([1])
      expect(files[1]?.receivedChunks).toEqual([1])
      expect(maxInFlight).toBe(1)
      maxInFlight = 0
      const [first, second] = await Promise.all([
        finaliseFile(store, started.sessionId, 0, caller),
        finaliseFile(store, started.sessionId, 1, caller),
      ])
      const done = (rows.get(`upload_sessions/${started.sessionId}`)?.files ?? []) as Array<{ state: string; docId?: string }>
      expect(done.map((file) => file.state)).toEqual(["finalised", "finalised"])
      expect(done[0]?.docId).toBe(first.docId)
      expect(done[1]?.docId).toBe(second.docId)
      expect(maxInFlight).toBe(1)
      expect(pendingSessionMutations(store)).toBe(0)
    } finally {
      spy.mockRestore()
      setFirestorePersistenceForTests(null)
    }
  })

  it("a staging sweep continues after one delete fails and reports that failure", async () => {
    const store = newStore()
    const now = 5_000_000_000
    const first = Buffer.from("fail-first")
    const second = Buffer.from("delete-second")
    const a = await startBulkUpload(store, "firmA", "m1", [fileOf(first, store, "firmA", "a.pdf")], caller)
    const b = await startBulkUpload(store, "firmA", "m1", [fileOf(second, store, "firmA", "b.pdf")], caller)
    await uploadChunk(store, a.sessionId, 0, 1, first, caller)
    await uploadChunk(store, b.sessionId, 0, 1, second, caller)
    const aPath = `${uploadSessionsOf(store).get(a.sessionId)?.storagePath}/0/1`
    const bPath = `${uploadSessionsOf(store).get(b.sessionId)?.storagePath}/0/1`
    staging.setStagingWrittenAtForTests(aPath, now - BULK_UPLOAD_STAGING_TTL_MS)
    staging.setStagingWrittenAtForTests(bPath, now - BULK_UPLOAD_STAGING_TTL_MS)
    staging.setStagingDeleteStatusForTests(async (storagePath) => (storagePath === aPath ? 403 : 204))
    await expect(sweepExpiredBulkUploads(store, now)).rejects.toThrow(/1 failure/)
    expect(
      (await staging.readStagingChunks({ firmId: "firmA", matterId: "m1", sessionId: a.sessionId, fileIdx: 0, chunkCount: 1 }))[0]?.equals(first)
    ).toBe(true)
    expect(
      await staging.readStagingChunks({ firmId: "firmA", matterId: "m1", sessionId: b.sessionId, fileIdx: 0, chunkCount: 1 })
    ).toEqual([null])
    expect(pendingSessionMutations(store)).toBe(0)
  })

  it("S3 and R2 keep staging bytes and session rows, and memory does not", () => {
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_BACKEND", "s3")
    expect(staging.liveStagingMatterDeletion()).toMatchObject({
      sharesLock: true,
      deleteBytes: false,
      deleteSessionRows: false,
      ack: { outcome: "retained", detail: { locked: true, reason: "locked_vault_bucket" } },
    })
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_BACKEND", "r2")
    expect(staging.stagingSharesLockedVaultBucket()).toBe(true)
    expect(staging.liveStagingMatterDeletion().ack.outcome).toBe("retained")
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_BACKEND", "memory")
    expect(staging.liveStagingMatterDeletion()).toMatchObject({
      sharesLock: false,
      deleteBytes: true,
      deleteSessionRows: true,
      ack: { outcome: "purged", detail: { locked: false, reason: "prefix_empty" } },
    })
    expect(() => staging.chunkFirestoreWrites([1], 0)).toThrow(/firestore batch failed validation/)
    expect(() => staging.chunkFirestoreWrites([1], 501)).toThrow(/firestore batch failed validation/)
  })
})
