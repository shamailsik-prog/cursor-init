/**
 * FA-D16-002 (audit v2): uploadDocument.ts scored 50.00% under Stryker (52 survived, 18 no
 * coverage). These tests pin its rollback paths and the dedup / classification branches that
 * decide whether an upload writes a new encrypted object or reuses an existing one.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  filesystemPathForStoragePath,
  getImmutableDocumentObject,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
} from "@/platform/documents/documentObjectStore"
import { PublicError } from "@/platform/http/publicError"
import type { Classification } from "@/platform/p1/types"
import { newStore, type DocumentRecord, type SpineStore } from "@/platform/spine/store"
import { ocrJobsFor, rollbackDocumentIngest, uploadDocument } from "@/services/d1-6/uploadDocument"

beforeEach(() => {
  delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
  resetDocumentObjectStoreForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetDocumentObjectStoreForTests()
})

function storeWithPartner(): SpineStore {
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

let keyCounter = 0
function upload(
  store: SpineStore,
  bytes: Buffer,
  overrides: Partial<{
    matterId: string | null
    classification: Classification
    callerClearance: Classification
    mimeType: string
    firmId: string
  }> = {}
) {
  keyCounter += 1
  return uploadDocument(store, {
    firmId: overrides.firmId ?? "firmA",
    matterId: overrides.matterId ?? null,
    bytes,
    sourceChannel: "web",
    classification: overrides.classification ?? "internal",
    idempotencyKey: `fad16002-0000-4000-8000-${String(keyCounter).padStart(12, "0")}`,
    callerClearance: overrides.callerClearance,
    uploadedBy: "partner_a",
    mimeType: overrides.mimeType,
  })
}

function readBack(store: SpineStore, doc: DocumentRecord) {
  return getImmutableDocumentObject(store, doc.firmId, doc.storagePath, doc.contentHash)
}

describe("FA-D16-002: a new upload", () => {
  it("writes the object, the document row, one OCR job and the dedup entry together", async () => {
    const store = storeWithPartner()
    const bytes = Buffer.from("%PDF-1.4 new upload%")
    const res = await upload(store, bytes)
    expect(res.reused).toBe(false)
    const doc = store.documents.get(res.docId)!
    expect(doc).toMatchObject({
      id: res.docId,
      firmId: "firmA",
      matterId: null,
      contentHash: store.hashKey("firmA", bytes),
      sourceChannel: "web",
      classification: "internal",
      storagePath: `fs://firmA/documents/${res.docId}/v1`,
      isImmutable: true,
      byteSize: bytes.length,
      mimeType: "application/pdf",
      objectVersion: 1,
      uploadedBy: "partner_a",
      objectBytesStatus: "available",
    })
    expect((await readBack(store, doc)).equals(bytes)).toBe(true)
    expect(ocrJobsFor(store, res.docId)).toHaveLength(1)
    expect(store.jobs).toEqual([
      expect.objectContaining({
        firmId: "firmA",
        jobType: "ocr",
        documentId: res.docId,
        matterId: null,
        classification: "internal",
        idempotencyKey: expect.stringMatching(/^fad16002-/),
      }),
    ])
    expect(store.docsByHash.get(`${doc.contentHash}|loose-vault`)).toBe(res.docId)
  })

  it("keeps an explicit mimeType and sniffs one only when none is given", async () => {
    const store = storeWithPartner()
    const explicit = await upload(store, Buffer.from("%PDF-1.4 but labelled%"), { mimeType: "text/plain" })
    expect(store.documents.get(explicit.docId)?.mimeType).toBe("text/plain")
    const sniffed = await upload(store, Buffer.from("plain bytes without magic"))
    expect(store.documents.get(sniffed.docId)?.mimeType).toBe("application/octet-stream")
  })

  it("refuses a write with no valid classification before touching storage", async () => {
    const store = storeWithPartner()
    const spy = vi.spyOn(store, "hashKey")
    await expect(
      upload(store, Buffer.from("x"), { classification: "secret" as Classification })
    ).rejects.toThrow(new PublicError("artefact write omitted classification"))
    expect(spy).not.toHaveBeenCalled()
    expect(store.documents.size).toBe(0)
  })

  it("floors the document at the matter's stricter classification", async () => {
    const store = storeWithPartner()
    store.matters.set("m_priv", {
      id: "m_priv",
      firmId: "firmA",
      clientId: "c",
      title: "t",
      courtId: "SHC",
      classification: "privileged",
    } as never)
    const res = await upload(store, Buffer.from("matter floor"), { matterId: "m_priv" })
    expect(store.documents.get(res.docId)?.classification).toBe("privileged")
    expect(store.jobs[0].classification).toBe("privileged")
    expect(store.documents.get(res.docId)?.matterId).toBe("m_priv")
    expect(store.jobs[0].matterId).toBe("m_priv")
  })

  it("floors at privileged-restricted when the matter's label is unreadable", async () => {
    const store = storeWithPartner()
    store.matters.set("m_bad", {
      id: "m_bad",
      firmId: "firmA",
      clientId: "c",
      title: "t",
      courtId: "SHC",
      classification: "garbage-label",
    } as never)
    const res = await upload(store, Buffer.from("unreadable matter label"), { matterId: "m_bad" })
    expect(store.documents.get(res.docId)?.classification).toBe("privileged-restricted")
  })

  it("keeps the upload's own label when it is stricter than the matter's", async () => {
    const store = storeWithPartner()
    store.matters.set("m_int", {
      id: "m_int",
      firmId: "firmA",
      clientId: "c",
      title: "t",
      courtId: "SHC",
      classification: "internal",
    } as never)
    const res = await upload(store, Buffer.from("stricter upload"), {
      matterId: "m_int",
      classification: "confidential",
    })
    expect(store.documents.get(res.docId)?.classification).toBe("confidential")
  })
})

describe("FA-D16-002: rollback of a failed new upload", () => {
  it("a refused object write (key already exists) leaves no row or job and never deletes the existing object", async () => {
    const store = storeWithPartner()
    vi.spyOn(store, "id").mockImplementation((prefix: string) => `${prefix}_fixed`)
    const squatter = Buffer.from("object already at this key")
    await putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_fixed",
      bytes: squatter,
      contentHash: store.hashKey("firmA", squatter),
      mimeType: "application/octet-stream",
    })
    await expect(upload(store, Buffer.from("new bytes"))).rejects.toThrow(/already exists/)
    expect(store.documents.size).toBe(0)
    expect(store.jobs).toHaveLength(0)
    expect(store.docsByHash.size).toBe(0)
    const kept = await getImmutableDocumentObject(
      store,
      "firmA",
      "fs://firmA/documents/doc_fixed/v1",
      store.hashKey("firmA", squatter)
    )
    expect(kept.equals(squatter)).toBe(true)
  })

  it("a failure after the object write (staging the OCR job) deletes the object and the row", async () => {
    const store = storeWithPartner()
    vi.spyOn(store.jobs, "push").mockImplementation(() => {
      throw new Error("simulated job staging failure")
    })
    vi.spyOn(store, "id").mockImplementation((prefix: string) => `${prefix}_late`)
    const bytes = Buffer.from("late failure")
    await expect(upload(store, bytes)).rejects.toThrow("simulated job staging failure")
    expect(store.documents.size).toBe(0)
    expect(store.docsByHash.size).toBe(0)
    await expect(
      getImmutableDocumentObject(store, "firmA", "fs://firmA/documents/doc_late/v1", store.hashKey("firmA", bytes))
    ).rejects.toThrow(/not found/)
  })

  it("rollback removes only the failed upload's jobs", async () => {
    const store = storeWithPartner()
    const keep = await upload(store, Buffer.from("kept upload"))
    const ids = ["doc_fail", "job_fail"]
    vi.spyOn(store, "id").mockImplementation(() => ids.shift() ?? "unused")
    vi.spyOn(store.docsByHash, "set").mockImplementation(() => {
      throw new Error("simulated dedup index failure")
    })
    await expect(upload(store, Buffer.from("failing upload"))).rejects.toThrow("simulated dedup index failure")
    expect([...store.documents.keys()]).toEqual([keep.docId])
    expect(store.jobs.map((j) => j.documentId)).toEqual([keep.docId])
  })
})

describe("FA-D16-002: duplicate uploads", () => {
  it("reuses a readable duplicate in the same matter without writing a second object", async () => {
    const store = storeWithPartner()
    const bytes = Buffer.from("duplicate bytes")
    const first = await upload(store, bytes)
    const idSpy = vi.spyOn(store, "id")
    const second = await upload(store, bytes)
    expect(second).toEqual({ docId: first.docId, reused: true })
    expect(idSpy).not.toHaveBeenCalled()
    expect(store.documents.size).toBe(1)
    expect(store.jobs).toHaveLength(1)
  })

  it("the same bytes in another matter (or the loose vault) are a separate document", async () => {
    const store = storeWithPartner()
    store.matters.set("m1", { id: "m1", firmId: "firmA", classification: "internal" } as never)
    const bytes = Buffer.from("same bytes, different matter")
    const loose = await upload(store, bytes)
    const inMatter = await upload(store, bytes, { matterId: "m1" })
    expect(inMatter.reused).toBe(false)
    expect(inMatter.docId).not.toBe(loose.docId)
  })

  it("raises the stored classification (and its jobs) when a stricter duplicate arrives, never lowers it", async () => {
    const store = storeWithPartner()
    const bytes = Buffer.from("reclassified duplicate")
    const first = await upload(store, bytes, { classification: "internal" })
    await upload(store, bytes, { classification: "confidential" })
    expect(store.documents.get(first.docId)?.classification).toBe("confidential")
    expect(ocrJobsFor(store, first.docId).map((j) => j.classification)).toEqual(["confidential"])
    await upload(store, bytes, { classification: "public" })
    expect(store.documents.get(first.docId)?.classification).toBe("confidential")
    expect(ocrJobsFor(store, first.docId).map((j) => j.classification)).toEqual(["confidential"])
  })

  it("a caller below the duplicate's clearance gets a new document, not the restricted one", async () => {
    const store = storeWithPartner()
    const bytes = Buffer.from("restricted duplicate")
    const restricted = await upload(store, bytes, { classification: "privileged-restricted" })
    const low = await upload(store, bytes, { classification: "internal", callerClearance: "internal" })
    expect(low.reused).toBe(false)
    expect(low.docId).not.toBe(restricted.docId)
    expect(store.documents.get(restricted.docId)?.classification).toBe("privileged-restricted")
    // The dedup index keeps pointing at the first document.
    expect(store.docsByHash.get(`${store.hashKey("firmA", bytes)}|loose-vault`)).toBe(restricted.docId)
  })

  it("falls back to scanning for a readable duplicate when the indexed one is above the caller", async () => {
    const store = storeWithPartner()
    const bytes = Buffer.from("scan fallback")
    const restricted = await upload(store, bytes, { classification: "privileged-restricted" })
    const low = await upload(store, bytes, { classification: "internal", callerClearance: "internal" })
    const again = await upload(store, bytes, { classification: "internal", callerClearance: "internal" })
    expect(again).toEqual({ docId: low.docId, reused: true })
    expect(again.docId).not.toBe(restricted.docId)
  })

  it("the scan ignores documents in another firm, another matter or with other bytes", async () => {
    const store = storeWithPartner()
    store.matters.set("m1", { id: "m1", firmId: "firmA", classification: "internal" } as never)
    const bytes = Buffer.from("scan filters")
    const restricted = await upload(store, bytes, { classification: "privileged-restricted" })
    await upload(store, bytes, { firmId: "firmB", classification: "internal" })
    await upload(store, bytes, { matterId: "m1", classification: "internal" })
    await upload(store, Buffer.from("other bytes"), { classification: "internal" })
    const low = await upload(store, bytes, { classification: "internal", callerClearance: "internal" })
    expect(low.reused).toBe(false)
    expect(low.docId).not.toBe(restricted.docId)
  })

  it("re-writes the object when a duplicate's recorded bytes are missing from storage", async () => {
    const store = storeWithPartner()
    const bytes = Buffer.from("bytes deleted out of band")
    const first = await upload(store, bytes)
    resetDocumentObjectStoreForTests()
    const doc = store.documents.get(first.docId)!
    await expect(readBack(store, doc)).rejects.toThrow(/not found/)
    const again = await upload(store, bytes)
    expect(again).toEqual({ docId: first.docId, reused: true })
    expect(doc.objectBytesStatus).toBe("available")
    expect((await readBack(store, doc)).equals(bytes)).toBe(true)
  })

  it("backfills bytes for a legacy metadata-only row", async () => {
    const store = storeWithPartner()
    const bytes = Buffer.from("%PDF-legacy%")
    const hash = store.hashKey("firmA", bytes)
    const legacy: DocumentRecord = {
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
    }
    store.documents.set(legacy.id, legacy)
    store.docsByHash.set(`${hash}|loose-vault`, legacy.id)
    const res = await upload(store, bytes)
    expect(res).toEqual({ docId: "doc_legacy", reused: true })
    expect(legacy).toMatchObject({
      storagePath: "fs://firmA/documents/doc_legacy/v1",
      isImmutable: true,
      byteSize: bytes.length,
      mimeType: "application/pdf",
      objectVersion: 1,
      objectBytesStatus: "available",
    })
    expect((await readBack(store, legacy)).equals(bytes)).toBe(true)
  })

  it("a row marked available without a storagePath is treated as missing and backfilled", async () => {
    const store = storeWithPartner()
    const bytes = Buffer.from("available but no path")
    const hash = store.hashKey("firmA", bytes)
    store.documents.set("doc_nopath", {
      id: "doc_nopath",
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
      objectBytesStatus: "available",
    })
    store.docsByHash.set(`${hash}|loose-vault`, "doc_nopath")
    await upload(store, bytes)
    expect(store.documents.get("doc_nopath")?.storagePath).toBe("fs://firmA/documents/doc_nopath/v1")
  })

  it("a duplicate whose stored object is unreadable is marked missing and the immutable key refuses a rewrite", async () => {
    const root = mkdtempSync(join(tmpdir(), "fa-d16-002-dup-"))
    process.env.SIKANDER_DOCUMENT_OBJECT_ROOT = root
    try {
      const store = storeWithPartner()
      const bytes = Buffer.from("tampered stored object")
      const first = await upload(store, bytes)
      const doc = store.documents.get(first.docId)!
      const file = filesystemPathForStoragePath(doc.storagePath)
      const tampered = readFileSync(file)
      tampered[tampered.length - 1] ^= 0x01
      writeFileSync(file, tampered)
      await expect(upload(store, bytes)).rejects.toThrow(/already exists/)
      expect(doc.objectBytesStatus).toBe("missing")
      // The tampered evidence is preserved, never overwritten or deleted.
      expect(readFileSync(file).equals(tampered)).toBe(true)
    } finally {
      delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("FA-D16-002: rollbackDocumentIngest", () => {
  it("removes the row, its jobs, every dedup entry for it and the object", async () => {
    const store = storeWithPartner()
    const bytes = Buffer.from("rollback me")
    const keep = await upload(store, Buffer.from("keep me"))
    const res = await upload(store, bytes)
    const doc = store.documents.get(res.docId)!
    store.docsByHash.set("alias-key", res.docId)
    await rollbackDocumentIngest(store, res.docId)
    expect(store.documents.has(res.docId)).toBe(false)
    expect(store.jobs.map((j) => j.documentId)).toEqual([keep.docId])
    expect([...store.docsByHash.values()]).toEqual([keep.docId])
    await expect(readBack(store, doc)).rejects.toThrow(/not found/)
    expect((await readBack(store, store.documents.get(keep.docId)!)).toString()).toBe("keep me")
  })

  it("is a no-op for an unknown document", async () => {
    const store = storeWithPartner()
    await upload(store, Buffer.from("untouched"))
    await expect(rollbackDocumentIngest(store, "doc_unknown")).resolves.toBeUndefined()
    expect(store.documents.size).toBe(1)
    expect(store.jobs).toHaveLength(1)
  })

  it("does not touch storage for a row without a storagePath", async () => {
    const store = storeWithPartner()
    store.documents.set("doc_meta", {
      id: "doc_meta",
      firmId: "firmA",
      matterId: null,
      contentHash: "h",
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
    await expect(rollbackDocumentIngest(store, "doc_meta")).resolves.toBeUndefined()
    expect(store.documents.has("doc_meta")).toBe(false)
  })
})

describe("FA-D16-002: ocrJobsFor", () => {
  it("returns only OCR jobs for the given document", async () => {
    const store = storeWithPartner()
    const a = await upload(store, Buffer.from("doc a"))
    const b = await upload(store, Buffer.from("doc b"))
    store.jobs.push({ ...store.jobs[0], id: "job_other", jobType: "classify" })
    expect(ocrJobsFor(store, a.docId).map((j) => j.documentId)).toEqual([a.docId])
    expect(ocrJobsFor(store, b.docId).map((j) => j.jobType)).toEqual(["ocr"])
  })
})
