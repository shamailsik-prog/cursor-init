/**
 * FA-D16-001 (audit v2, HIGH) end to end: the document vault against a real S3-compatible server.
 *
 * Runs only through `npm run test:document-vault-s3` with SIKANDER_TEST_S3_ENDPOINT,
 * SIKANDER_TEST_S3_ACCESS_KEY_ID and SIKANDER_TEST_S3_SECRET_ACCESS_KEY pointing at a MinIO
 * (CI: the `document-vault-s3` job's service container; locally: any MinIO). vitest.config.ts
 * leaves it out of the plain unit run when those variables are absent, the same way the
 * emulator suites are left out; run directly without them, it fails rather than skips.
 *
 * The user flow is the real one: POST /api/d1/documents (ingest) writes through the configured
 * R2 backend (SigV4, S3 API) into the bucket; a second, freshly constructed store instance reads
 * it back; GET /api/d1/documents?includeContent=true downloads it after the in-process state is
 * thrown away. Overwrites are refused, tampering is detected, and a restore drill copies the
 * bucket to a second bucket and reads every document back through a store pointed at the copy.
 */
import { randomBytes, randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { GET, POST } from "@/app/api/d1/documents/route"
import {
  createDocumentObjectStore,
  createR2DocumentObjectBackend,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
} from "@/platform/documents/documentObjectStore"
import * as runtimeRepositories from "@/platform/persistence/runtimeRepositories"
import type { DocumentRecord } from "@/platform/spine/store"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { createS3TestClient, type S3TestClient } from "@/tests/helpers/s3TestClient"

const env = process.env as Record<string, string | undefined>
const endpoint = env.SIKANDER_TEST_S3_ENDPOINT?.trim()
const accessKeyId = env.SIKANDER_TEST_S3_ACCESS_KEY_ID?.trim()
const secretAccessKey = env.SIKANDER_TEST_S3_SECRET_ACCESS_KEY?.trim()
const region = env.SIKANDER_TEST_S3_REGION?.trim() || "us-east-1"

const runId = randomBytes(4).toString("hex")
const BUCKET = `fa-d16-vault-${runId}`
const RESTORE_BUCKET = `fa-d16-restore-${runId}`
const VAULT_ENV = [
  "SIKANDER_DOCUMENT_OBJECT_BACKEND",
  "SIKANDER_DOCUMENT_OBJECT_ROOT",
  "SIKANDER_R2_ENDPOINT",
  "SIKANDER_R2_BUCKET",
  "SIKANDER_R2_ACCESS_KEY_ID",
  "SIKANDER_R2_SECRET_ACCESS_KEY",
  "SIKANDER_R2_REGION",
]

let s3: S3TestClient
let saved: Record<string, string | undefined>

function pointVaultAt(bucket: string) {
  env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "r2"
  delete env.SIKANDER_DOCUMENT_OBJECT_ROOT
  env.SIKANDER_R2_ENDPOINT = endpoint
  env.SIKANDER_R2_BUCKET = bucket
  env.SIKANDER_R2_ACCESS_KEY_ID = accessKeyId
  env.SIKANDER_R2_SECRET_ACCESS_KEY = secretAccessKey
  env.SIKANDER_R2_REGION = region
}

function freshStoreFor(bucket: string) {
  return createDocumentObjectStore(
    createR2DocumentObjectBackend({ endpoint: endpoint!, bucket, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, region })
  )
}

beforeAll(async () => {
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "SIKANDER_TEST_S3_ENDPOINT, SIKANDER_TEST_S3_ACCESS_KEY_ID and SIKANDER_TEST_S3_SECRET_ACCESS_KEY " +
        "must point at an S3-compatible server (npm run test:document-vault-s3)."
    )
  }
  s3 = createS3TestClient({ endpoint, accessKeyId, secretAccessKey, region })
  await s3.createBucket(BUCKET)
  await s3.createBucket(RESTORE_BUCKET)
})

afterAll(async () => {
  if (!s3) return
  await s3.emptyAndDeleteBucket(BUCKET)
  await s3.emptyAndDeleteBucket(RESTORE_BUCKET)
})

beforeEach(() => {
  saved = Object.fromEntries(VAULT_ENV.map((name) => [name, env[name]]))
  pointVaultAt(BUCKET)
  resetRuntimeStoreForTests()
  resetDocumentObjectStoreForTests()
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  vi.restoreAllMocks()
  resetRuntimeStoreForTests()
  resetDocumentObjectStoreForTests()
})

function seedMatter(): string {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "FA-D16-001 vault matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  return matter.id
}

async function ingest(matterId: string, bytes: Buffer): Promise<{ status: number; doc: DocumentRecord }> {
  const res = await POST(
    new Request("http://127.0.0.1/api/d1/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: bytes.toString("base64"),
        sourceChannel: "web",
        classification: "internal",
        mimeType: "application/pdf",
      }),
    })
  )
  const json = (await res.json()) as { result?: { doc: DocumentRecord }; error?: string }
  return { status: res.status, doc: json.result?.doc as DocumentRecord }
}

async function download(docId: string) {
  const res = await GET(
    new Request(`http://127.0.0.1/api/d1/documents?userId=partner_a&docId=${docId}&includeContent=true`)
  )
  const json = (await res.json()) as { contentBase64?: string; contentHash?: string; error?: string }
  return {
    status: res.status,
    bytes: json.contentBase64 === undefined ? undefined : Buffer.from(json.contentBase64, "base64"),
    contentHash: json.contentHash,
    error: json.error,
  }
}

/** Simulates another server instance: no in-process store, no cached objects, same bucket. */
async function restartWith(doc: DocumentRecord) {
  resetRuntimeStoreForTests()
  resetDocumentObjectStoreForTests()
  const store = getRuntimeStore()
  const matterId = seedMatter()
  const restored: DocumentRecord = { ...doc, matterId }
  store.documents.set(restored.id, restored)
  const repos = await runtimeRepositories.getRuntimeRepositories(store)
  await repos.documents.create(restored)
  return restored
}

function objectKey(doc: DocumentRecord): string {
  const match = /^r2:\/\/(.+)$/.exec(doc.storagePath)
  if (!match) throw new Error(`expected an r2:// storagePath, got "${doc.storagePath}"`)
  return `${match[1]}.enc`
}

function evidence(label: string): Buffer {
  return Buffer.concat([
    Buffer.from(`%PDF-1.7\nPLAINTEXT-MARKER-${label}\n`, "utf8"),
    randomBytes(2048),
    Buffer.from("\n%%EOF\n"),
  ])
}

describe("FA-D16-001: document vault on a real S3-compatible server", () => {
  it("upload → bucket holds only ciphertext → a fresh store instance reads it → download bytes and hash match", async () => {
    const matterId = seedMatter()
    const original = evidence("UPLOAD")
    const { status, doc } = await ingest(matterId, original)
    expect(status).toBe(200)
    expect(doc.storagePath).toMatch(/^r2:\/\/firmA\/documents\/doc_[0-9a-f-]{36}\/v1$/)
    expect(doc.objectBytesStatus).toBe("available")

    const key = objectKey(doc)
    expect(await s3.listKeys(BUCKET)).toEqual([key])
    const remote = await s3.getObject(BUCKET, key)
    expect(remote.status).toBe(200)
    expect(remote.body[0]).toBe(1)
    expect(remote.body.length).toBe(original.length + 29)
    expect(remote.body.includes(Buffer.from("PLAINTEXT-MARKER"))).toBe(false)

    const store = getRuntimeStore()
    const fresh = freshStoreFor(BUCKET)
    const viaFreshInstance = await fresh.get(store, "firmA", doc.storagePath, doc.contentHash)
    expect(viaFreshInstance.equals(original)).toBe(true)

    const restored = await restartWith(doc)
    const downloaded = await download(restored.id)
    expect(downloaded.status).toBe(200)
    expect(downloaded.bytes?.equals(original)).toBe(true)
    expect(downloaded.contentHash).toBe(doc.contentHash)
    expect(getRuntimeStore().hashKey("firmA", downloaded.bytes!)).toBe(doc.contentHash)
  })

  it("an overwrite of a stored object is refused (If-None-Match) and the original stays intact", async () => {
    const matterId = seedMatter()
    const original = evidence("NO-OVERWRITE")
    const { doc } = await ingest(matterId, original)
    const key = objectKey(doc)
    const before = await s3.getObject(BUCKET, key)

    const store = getRuntimeStore()
    const docId = doc.id
    const attempt = Buffer.from("replacement bytes")
    await expect(
      putImmutableDocumentObject({
        store,
        firmId: "firmA",
        docId,
        bytes: attempt,
        contentHash: store.hashKey("firmA", attempt),
        mimeType: "application/pdf",
      })
    ).rejects.toThrow(/already exists \(immutable\)/)

    const conditional = await s3.putObject(BUCKET, key, Buffer.from("raw conditional overwrite"), {
      "If-None-Match": "*",
    })
    expect(conditional.status).toBe(412)

    const after = await s3.getObject(BUCKET, key)
    expect(after.body.equals(before.body)).toBe(true)
    const downloaded = await download(doc.id)
    expect(downloaded.status).toBe(200)
    expect(downloaded.bytes?.equals(original)).toBe(true)
  })

  it("a tampered or truncated remote object is detected on read", async () => {
    const matterId = seedMatter()
    const original = evidence("TAMPER")
    const { doc } = await ingest(matterId, original)
    const key = objectKey(doc)
    const genuine = (await s3.getObject(BUCKET, key)).body

    const flipped = Buffer.from(genuine)
    flipped[40] ^= 0x01
    expect((await s3.putObject(BUCKET, key, flipped)).status).toBe(200)
    const store = getRuntimeStore()
    await expect(freshStoreFor(BUCKET).get(store, "firmA", doc.storagePath, doc.contentHash)).rejects.toThrow(
      /unable to authenticate data/
    )
    const tamperedDownload = await download(doc.id)
    expect(tamperedDownload.status).toBe(500)
    expect(tamperedDownload.bytes).toBeUndefined()

    expect((await s3.putObject(BUCKET, key, genuine.subarray(0, 20))).status).toBe(200)
    await expect(freshStoreFor(BUCKET).get(store, "firmA", doc.storagePath, doc.contentHash)).rejects.toThrow(
      "document object payload is truncated"
    )
    expect((await download(doc.id)).status).toBe(500)

    expect((await s3.deleteObject(BUCKET, key)).status).toBe(204)
    await expect(freshStoreFor(BUCKET).get(store, "firmA", doc.storagePath, doc.contentHash)).rejects.toThrow(
      /document object not found/
    )
    expect((await download(doc.id)).status).toBe(500)
  })

  it("restore drill: copy every object to a second bucket and read each document back through a store pointed at it", async () => {
    const matterId = seedMatter()
    const originals = [evidence("RESTORE-1"), evidence("RESTORE-2"), evidence("RESTORE-3")]
    const docs: DocumentRecord[] = []
    for (const bytes of originals) {
      const { status, doc } = await ingest(matterId, bytes)
      expect(status).toBe(200)
      docs.push(doc)
    }
    const sourceKeys = await s3.listKeys(BUCKET)
    for (const doc of docs) expect(sourceKeys).toContain(objectKey(doc))

    for (const key of sourceKeys) {
      const object = await s3.getObject(BUCKET, key)
      expect(object.status).toBe(200)
      expect((await s3.putObject(RESTORE_BUCKET, key, object.body, { "If-None-Match": "*" })).status).toBe(200)
    }
    expect(await s3.listKeys(RESTORE_BUCKET)).toEqual(sourceKeys)

    // The primary bucket is lost; the restored copy must serve every document unchanged.
    for (const key of sourceKeys) await s3.deleteObject(BUCKET, key)
    expect(await s3.listKeys(BUCKET)).toEqual([])

    pointVaultAt(RESTORE_BUCKET)
    for (const [i, doc] of docs.entries()) {
      const restored = await restartWith(doc)
      const downloaded = await download(restored.id)
      expect(downloaded.status).toBe(200)
      expect(downloaded.bytes?.equals(originals[i])).toBe(true)
      expect(getRuntimeStore().hashKey("firmA", downloaded.bytes!)).toBe(doc.contentHash)
      const viaStore = await freshStoreFor(RESTORE_BUCKET).get(
        getRuntimeStore(),
        "firmA",
        doc.storagePath,
        doc.contentHash
      )
      expect(viaStore.equals(originals[i])).toBe(true)
    }
  })

  it("FA-D16-003 on S3: a failed round-trip verification leaves no object in the bucket", async () => {
    const store = getRuntimeStore()
    const bytes = evidence("ROUND-TRIP")
    const contentHash = store.hashKey("firmA", bytes)
    const real = store.hashKey.bind(store)
    let calls = 0
    vi.spyOn(store, "hashKey").mockImplementation((firmId: string, b: Buffer) => {
      calls += 1
      return calls === 1 ? real(firmId, b) : "0".repeat(64)
    })
    const before = await s3.listKeys(BUCKET)
    await expect(
      putImmutableDocumentObject({
        store,
        firmId: "firmA",
        docId: `doc_${randomUUID()}`,
        bytes,
        contentHash,
        mimeType: "application/pdf",
      })
    ).rejects.toThrow(/round-trip verification failed/)
    expect(await s3.listKeys(BUCKET)).toEqual(before)
  })
})
