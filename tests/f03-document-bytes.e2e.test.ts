import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET, POST } from "@/app/api/d1/documents/route"
import {
  backupDocumentObjectFile,
  filesystemPathForStoragePath,
  getImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
  restoreDocumentObjectFile,
} from "@/platform/documents/documentObjectStore"
import { rollbackDocumentIngest, uploadDocument } from "@/services/d1-6/uploadDocument"
import { newStore } from "@/platform/spine/store"
import * as runtimeRepositories from "@/platform/persistence/runtimeRepositories"
import type { DocumentRecord } from "@/platform/spine/store"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

let objectRoot: string | undefined

beforeEach(() => {
  objectRoot = mkdtempSync(join(tmpdir(), "f03-doc-objects-"))
  process.env.SIKANDER_DOCUMENT_OBJECT_ROOT = objectRoot
})

afterEach(() => {
  if (objectRoot) rmSync(objectRoot, { recursive: true, force: true })
  delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
  process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00"
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetRuntimeStoreForTests()
  resetDocumentObjectStoreForTests()
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

/** Object store must use filesystem (root required); persistence stays in-memory for the route. */
function requireFilesystemObjectBackend() {
  vi.stubEnv("NODE_ENV", "development")
  vi.stubEnv("VITEST", "false")
  process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "fs"
  process.env.SIKANDER_PERSISTENCE_MODE = "memory"
}

function seedMatter() {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "F03 bytes matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  return matter.id
}

describe("F03: uploaded document bytes are retained and integrity-checked", () => {
  it("ingests through POST and reads byte-identical content through GET (memory backend)", async () => {
    delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
    const matterId = seedMatter()
    const original = Buffer.from("%PDF-1.4 F03 in-memory round-trip.\n", "utf8")
    const ingestRes = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: original.toString("base64"),
        sourceChannel: "web",
        classification: "internal",
        mimeType: "application/pdf",
      },
      "a3f03f03-f03f-4111-8111-f03f03f03f03"
    )
    expect(ingestRes.status).toBe(200)
    const ingestJson = (await ingestRes.json()) as { result: { doc: { id: string; storagePath: string } } }
    expect(ingestJson.result.doc.storagePath).toMatch(/^fs:\/\/firmA\/documents\//)
    const downloadRes = await getContent(ingestJson.result.doc.id, "partner_a")
    const downloadJson = (await downloadRes.json()) as { contentBase64: string }
    expect(Buffer.from(downloadJson.contentBase64, "base64").equals(original)).toBe(true)
  })

  it("filesystem backend: encrypted .enc on disk, survives store reset, tamper/missing fail", async () => {
    const matterId = seedMatter()
    const original = Buffer.from(
      "PLAINTEXT-MARKER-F03-FORENSIC-AUDIT-BYTES-ON-DISK",
      "utf8"
    )
    const ingestRes = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: original.toString("base64"),
        sourceChannel: "web",
        classification: "internal",
      },
      "b4f03f03-f03f-4111-8111-f03f03f03f04"
    )
    expect(ingestRes.status).toBe(200)
    const ingestJson = (await ingestRes.json()) as {
      result: { doc: DocumentRecord }
    }
    const savedDoc = ingestJson.result.doc
    const encPath = filesystemPathForStoragePath(savedDoc.storagePath)
    expect(encPath.endsWith(".enc")).toBe(true)
    const onDisk = readFileSync(encPath)
    expect(onDisk.includes(original)).toBe(false)
    expect(onDisk.includes(Buffer.from("PLAINTEXT-MARKER-F03"))).toBe(false)

    resetRuntimeStoreForTests()
    resetDocumentObjectStoreForTests()
    const store = getRuntimeStore()
    const matterIdAfterRestart = seedMatter()
    const restoredDoc: DocumentRecord = { ...savedDoc, matterId: matterIdAfterRestart }
    store.documents.set(restoredDoc.id, restoredDoc)
    const repos = await runtimeRepositories.getRuntimeRepositories(store)
    await repos.documents.create(restoredDoc)

    const afterRestart = await getContent(restoredDoc.id, "partner_a")
    expect(afterRestart.status).toBe(200)
    const body = (await afterRestart.json()) as { contentBase64: string }
    expect(Buffer.from(body.contentBase64, "base64").equals(original)).toBe(true)

    writeFileSync(encPath, Buffer.from("tampered"))
    const tampered = await getContent(restoredDoc.id, "partner_a")
    expect(tampered.status).toBe(500)

    rmSync(encPath, { force: true })
    const missing = await getContent(restoredDoc.id, "partner_a")
    expect(missing.status).toBe(500)
  })

  it("backup copy and restore yields byte-identical readback", async () => {
    const matterId = seedMatter()
    const original = Buffer.from("%PDF-backup-restore-f03%", "utf8")
    const ingestRes = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: original.toString("base64"),
        sourceChannel: "web",
        classification: "internal",
      },
      "c5f03f03-f03f-4111-8111-f03f03f03f05"
    )
    const doc = ((await ingestRes.json()) as { result: { doc: DocumentRecord } }).result.doc
    const backupPath = join(objectRoot!, "backup", "copy.enc")
    await backupDocumentObjectFile(doc.storagePath, backupPath)
    rmSync(filesystemPathForStoragePath(doc.storagePath), { force: true })
    await restoreDocumentObjectFile(doc.storagePath, backupPath)
    const downloadRes = await getContent(doc.id, "partner_a")
    const json = (await downloadRes.json()) as { contentBase64: string }
    expect(Buffer.from(json.contentBase64, "base64").equals(original)).toBe(true)
  })

  it("refuses ingest when object root is required but missing (non-memory mode)", async () => {
    requireFilesystemObjectBackend()
    delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
    const matterId = seedMatter()
    const res = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: Buffer.from("x").toString("base64"),
        sourceChannel: "web",
        classification: "internal",
      },
      "d6f03f03-f03f-4111-8111-f03f03f03f06"
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/SIKANDER_DOCUMENT_OBJECT_ROOT/)
  })

  it("refuses ingest when encryption key is missing (non-memory mode)", async () => {
    requireFilesystemObjectBackend()
    delete process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
    const matterId = seedMatter()
    const res = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: Buffer.from("x").toString("base64"),
        sourceChannel: "web",
        classification: "internal",
      },
      "e6f03f03-f03f-4111-8111-f03f03f03f06"
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/encryption key/)
  })

  it("legacy metadata without bytes: duplicate upload backfills; read without bytes stays unavailable", async () => {
    const store = getRuntimeStore()
    const matterId = seedMatter()
    const bytes = Buffer.from("%PDF-legacy-backfill%", "utf8")
    const hash = store.hashKey("firmA", bytes)
    const legacyId = "doc_legacy_f03"
    const legacy: DocumentRecord = {
      id: legacyId,
      firmId: "firmA",
      matterId,
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
    store.documents.set(legacyId, legacy)
    store.docsByHash.set(`${hash}|${matterId}`, legacyId)

    const missingRead = await getContent(legacyId, "partner_a")
    expect(missingRead.status).toBe(500)

    const backfill = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: bytes.toString("base64"),
        sourceChannel: "web",
        classification: "internal",
      },
      "e7f03f03-f03f-4111-8111-f03f03f03f07"
    )
    expect(backfill.status).toBe(200)
    const json = (await backfill.json()) as { result: { reused: boolean; doc: DocumentRecord } }
    expect(json.result.reused).toBe(true)
    expect(json.result.doc.storagePath).toMatch(/^fs:\/\//)
    expect(json.result.doc.objectBytesStatus).toBe("available")

    const ok = await getContent(legacyId, "partner_a")
    expect(ok.status).toBe(200)
  })

  it("stages document metadata and OCR job together; rollback clears both and the object", async () => {
    const store = newStore()
    store.users.set("partner_a", {
      id: "partner_a",
      firmId: "firmA",
      role: "partner",
      clearanceLevel: "privileged-restricted",
      active: true,
    })
    const bytes = Buffer.from("%PDF-orphan-rollback%")
    const write = await uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes,
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "f8f03f03-f03f-4111-8111-f03f03f03f08",
      uploadedBy: "partner_a",
    })
    const doc = store.documents.get(write.docId)
    expect(doc).toBeTruthy()
    expect(store.jobs.some((j) => j.documentId === write.docId && j.jobType === "ocr")).toBe(true)
    const storagePath = doc!.storagePath
    await rollbackDocumentIngest(store, write.docId)
    expect(store.documents.has(write.docId)).toBe(false)
    expect(store.jobs.some((j) => j.documentId === write.docId)).toBe(false)
    await expect(
      getImmutableDocumentObject(store, "firmA", storagePath, doc!.contentHash)
    ).rejects.toThrow()
  })

  it("route rollback removes persisted document when repos.jobs.create throws", async () => {
    const matterId = seedMatter()
    const store = getRuntimeStore()
    const actualGet = runtimeRepositories.getRuntimeRepositories
    vi.spyOn(runtimeRepositories, "getRuntimeRepositories").mockImplementation(async (s) => {
      const repos = await actualGet(s)
      repos.jobs.create = async () => {
        throw new Error("simulated jobs persist failure")
      }
      return repos
    })
    const res = await post(
      {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: Buffer.from("%PDF-jobs-persist-fail%").toString("base64"),
        sourceChannel: "web",
        classification: "internal",
      },
      "a9f03f03-f03f-4111-8111-f03f03f03f09"
    )
    expect(res.status).toBe(400)
    expect(store.documents.size).toBe(0)
    expect(store.jobs.filter((j) => j.jobType === "ocr")).toHaveLength(0)
    const repos = await actualGet(store)
    const ids = [...store.documents.keys()]
    for (const id of ids) {
      expect(await repos.documents.get(id)).toBeNull()
    }
  })
})
