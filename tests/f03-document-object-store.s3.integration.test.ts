/**
 * FA-D16-001 / FA-D16-002: document object store on MinIO (docker run in CI; SigV4).
 */
import { PutObjectCommand } from "@aws-sdk/client-s3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  buildDocumentStoragePath,
  deleteDocumentObject,
  getImmutableDocumentObject,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
} from "@/platform/documents/documentObjectStore"
import {
  deleteS3Payload,
  documentObjectS3Client,
  ensureDocumentObjectBucketExists,
  objectKeyForS3StoragePath,
  overwriteS3PayloadForTests,
  readS3Payload,
  s3ConfigFromEnv,
  writeS3Payload,
} from "@/platform/documents/documentObjectS3"
import { newStore } from "@/platform/spine/store"

const s3Ready = Boolean(process.env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT?.trim())
const suite = s3Ready ? describe : describe.skip

suite("F03 document object store (S3 / R2 integration)", () => {
  beforeAll(async () => {
    process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "s3"
    delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
    resetDocumentObjectStoreForTests()
    await ensureDocumentObjectBucketExists()
  }, 60_000)

  afterAll(() => {
    resetDocumentObjectStoreForTests()
  })

  it("FA-D16-002: stores and reads bytes with content-hash verification on S3", async () => {
    const store = newStore()
    const bytes = Buffer.from("r2-round-trip-payload")
    const hash = store.hashKey("firmA", bytes)
    const stored = await putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_s3_roundtrip",
      bytes,
      contentHash: hash,
      mimeType: "application/pdf",
    })
    expect(stored.storagePath).toMatch(/^s3:\/\//)
    const readBack = await getImmutableDocumentObject(
      store,
      "firmA",
      stored.storagePath,
      hash
    )
    expect(readBack.equals(bytes)).toBe(true)
    await deleteS3Payload(stored.storagePath)
  })

  it("FA-D16-002: rejects content hash mismatch on read", async () => {
    const store = newStore()
    const bytes = Buffer.from("hash-mismatch-body")
    const hash = store.hashKey("firmA", bytes)
    const stored = await putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_s3_hash",
      bytes,
      contentHash: hash,
      mimeType: "text/plain",
    })
    await expect(
      getImmutableDocumentObject(store, "firmA", stored.storagePath, "wrong-hash")
    ).rejects.toThrow(/content hash mismatch/i)
    await deleteS3Payload(stored.storagePath)
  })

  it("FA-D16-002: missing object errors on read", async () => {
    const store = newStore()
    const path = buildDocumentStoragePath("firmA", "doc_s3_missing", 1)
    await expect(
      getImmutableDocumentObject(store, "firmA", path, "any-hash")
    ).rejects.toThrow(/not found/i)
  })

  it("FA-D16-002: tampered ciphertext is detected (GCM auth / decrypt failure)", async () => {
    const store = newStore()
    const bytes = Buffer.from("tamper-detect")
    const hash = store.hashKey("firmA", bytes)
    const stored = await putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_s3_tamper",
      bytes,
      contentHash: hash,
      mimeType: "application/octet-stream",
    })
    const payload = await readS3Payload(stored.storagePath)
    const tampered = Buffer.from(payload)
    tampered[tampered.length - 1] ^= 0xff
    await overwriteS3PayloadForTests(stored.storagePath, tampered)
    await expect(
      getImmutableDocumentObject(store, "firmA", stored.storagePath, hash)
    ).rejects.toThrow()
    await deleteS3Payload(stored.storagePath)
  })

  it("FA-D16-002: rejects path traversal in object identity", async () => {
    const store = newStore()
    const bytes = Buffer.from("x")
    await expect(
      putImmutableDocumentObject({
        store,
        firmId: "..",
        docId: "doc_escape",
        bytes,
        contentHash: store.hashKey("..", bytes),
        mimeType: "application/octet-stream",
      })
    ).rejects.toThrow(/safety validation/)
  })

  it("FA-D16-002: second put to the same key is rejected (immutability)", async () => {
    const store = newStore()
    const bytes = Buffer.from("immutable-s3")
    const hash = store.hashKey("firmA", bytes)
    const input = {
      store,
      firmId: "firmA",
      docId: "doc_s3_immutable",
      bytes,
      contentHash: hash,
      mimeType: "application/octet-stream",
    }
    const first = await putImmutableDocumentObject(input)
    await expect(putImmutableDocumentObject(input)).rejects.toThrow(/already exists/i)
    await deleteS3Payload(first.storagePath)
  })

  it("D1: PutObject IfNoneMatch * returns 412 when the key already exists", async () => {
    const storagePath = buildDocumentStoragePath("firmA", "doc_if_none_match", 1)
    const { bucket } = s3ConfigFromEnv()
    const key = objectKeyForS3StoragePath(storagePath)
    const client = documentObjectS3Client()
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from("seed"),
        ContentType: "application/octet-stream",
      })
    )
    await expect(
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: Buffer.from("duplicate"),
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
        })
      )
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } })
    await deleteS3Payload(storagePath)
  })

  it("D1: concurrent create-only puts: exactly one succeeds", async () => {
    const storagePath = buildDocumentStoragePath("firmA", "doc_concurrent_put", 1)
    const results = await Promise.allSettled([
      writeS3Payload(storagePath, Buffer.from("writer-a")),
      writeS3Payload(storagePath, Buffer.from("writer-b")),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    await deleteDocumentObject(storagePath)
  })

  it("D5: R2 backend omits ServerSideEncryption on PutObject", async () => {
    const prev = process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND
    process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "r2"
    const { documentObjectS3UsesServerSideEncryptionHeader } = await import(
      "@/platform/documents/documentObjectS3"
    )
    expect(documentObjectS3UsesServerSideEncryptionHeader()).toBe(false)
    process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = prev
  })
})
