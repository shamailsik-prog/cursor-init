/**
 * FA-D16-001 / FA-D16-002 / FA-D16-003: the document vault against a real S3-compatible server
 * (MinIO built from its pinned upstream source in CI, standing in for Cloudflare R2; SigV4 checked
 * by the server). Runs through `npm run test:document-object-s3`; vitest.config.ts leaves it out of
 * a plain run, so a missing endpoint fails the script ("No test files found") instead of skipping.
 */
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DocumentObjectStoreError,
  backupDocumentObjectFile,
  buildDocumentStoragePath,
  deleteDocumentObject,
  getImmutableDocumentObject,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
  restoreDocumentObjectFile,
} from "@/platform/documents/documentObjectStore"
import { writeS3Payload } from "@/platform/documents/documentObjectS3"
import { newStore } from "@/platform/spine/store"
import {
  keyOf,
  rawVault,
  realS3Endpoint,
  startS3FaultProxy,
  type FaultProxy,
  type RawVault,
} from "@/tests/helpers/s3-document-vault"

const realEndpoint = realS3Endpoint()
/** Doc ids are unique per run: the bucket outlives a run, and objects are immutable. */
const RUN = randomBytes(4).toString("hex")
const id = (name: string) => `${name}_${RUN}`
const keyFor = (name: string) => `firmA/documents/${id(name)}/v1`
let vault: RawVault
let proxy: FaultProxy
let scratch: string

function putInput(docId: string, text = `F03 S3 payload for ${docId}`) {
  const store = newStore()
  const bytes = Buffer.from(text)
  return {
    store,
    firmId: "firmA",
    docId,
    bytes,
    contentHash: store.hashKey("firmA", bytes),
    mimeType: "application/pdf",
  }
}

/** Point the product at `endpoint` (MinIO itself, or the fault proxy in front of it). */
function productEndpoint(endpoint: string, timeoutMs = "2000", settleMs = "3000") {
  process.env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT = endpoint
  process.env.SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS = timeoutMs
  process.env.SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS = settleMs
  resetDocumentObjectStoreForTests()
}

beforeAll(async () => {
  process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "s3"
  process.env.SIKANDER_DOCUMENT_OBJECT_S3_SSE = "none"
  delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
  vault = rawVault(realEndpoint)
  await vault.ensureBucket()
  proxy = await startS3FaultProxy(realEndpoint)
}, 60_000)

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "f03-s3-"))
  proxy.setMode({ kind: "pass" })
  productEndpoint(realEndpoint)
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  vi.restoreAllMocks()
})

afterAll(async () => {
  productEndpoint(realEndpoint)
  delete process.env.SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS
  delete process.env.SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS
  await proxy.close()
  vault.close()
  resetDocumentObjectStoreForTests()
})

describe("F03 document vault on S3 (FA-D16-001)", () => {
  it("stores ciphertext under s3://firm/documents/doc/v1 and reads it back byte-identical", async () => {
    const input = putInput(id("doc_s3_roundtrip"), "PLAINTEXT-MARKER-F03-S3 round trip")
    const stored = await putImmutableDocumentObject(input)
    expect(stored.storagePath).toBe(`s3://${keyFor("doc_s3_roundtrip")}`)
    const raw = await vault.get(keyOf(stored.storagePath))
    expect(raw).not.toBeNull()
    expect(raw![0]).toBe(1)
    expect(raw!.includes(Buffer.from("PLAINTEXT-MARKER-F03"))).toBe(false)
    expect(raw!.length).toBe(input.bytes.length + 1 + 12 + 16)
    const readBack = await getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)
    expect(readBack.equals(input.bytes)).toBe(true)
    await deleteDocumentObject(stored.storagePath)
    expect(await vault.get(keyOf(stored.storagePath))).toBeNull()
  })

  it("a second instance (fresh client, fresh store) reads what the first wrote", async () => {
    const input = putInput(id("doc_s3_second_instance"))
    const stored = await putImmutableDocumentObject(input)
    resetDocumentObjectStoreForTests()
    const otherStore = newStore()
    const readBack = await getImmutableDocumentObject(otherStore, "firmA", stored.storagePath, input.contentHash)
    expect(readBack.equals(input.bytes)).toBe(true)
    await deleteDocumentObject(stored.storagePath)
  })

  it("restore drill: back up, lose the object, restore, read back byte-identical; a second restore is refused", async () => {
    const input = putInput(id("doc_s3_restore"))
    const stored = await putImmutableDocumentObject(input)
    const backup = join(scratch, "doc_s3_restore.enc")
    await backupDocumentObjectFile(stored.storagePath, backup)
    await vault.remove(keyOf(stored.storagePath))
    await expect(
      getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)
    ).rejects.toThrow(/not found/)
    await restoreDocumentObjectFile(stored.storagePath, backup)
    const readBack = await getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)
    expect(readBack.equals(input.bytes)).toBe(true)
    await expect(restoreDocumentObjectFile(stored.storagePath, backup)).rejects.toThrow(/already exists/)
    await deleteDocumentObject(stored.storagePath)
  })

  it("the server checks the signature: a wrong secret is refused with SignatureDoesNotMatch", async () => {
    process.env.SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY = `${process.env.SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY}x`
    resetDocumentObjectStoreForTests()
    try {
      const error = await writeS3Payload(
        buildDocumentStoragePath("firmA", id("doc_bad_secret"), 1),
        Buffer.from("x")
      ).catch((err) => err)
      expect(error).toBeInstanceOf(DocumentObjectStoreError)
      expect((error as DocumentObjectStoreError).httpStatus).toBe(403)
      expect((error as DocumentObjectStoreError).s3Code).toBe("SignatureDoesNotMatch")
    } finally {
      process.env.SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY = process.env.SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY!.slice(0, -1)
      resetDocumentObjectStoreForTests()
    }
  })
})

describe("F03 integrity on S3 (FA-D16-002)", () => {
  it("rejects a content hash mismatch on read", async () => {
    const input = putInput(id("doc_s3_hash"))
    const stored = await putImmutableDocumentObject(input)
    await expect(
      getImmutableDocumentObject(input.store, "firmA", stored.storagePath, "wrong-hash")
    ).rejects.toThrow(/content hash mismatch/i)
    await deleteDocumentObject(stored.storagePath)
  })

  it("a missing object is an error, never empty bytes", async () => {
    const path = buildDocumentStoragePath("firmA", id("doc_s3_missing"), 1)
    await expect(getImmutableDocumentObject(newStore(), "firmA", path, "any-hash")).rejects.toThrow(
      `document object not found: ${path}`
    )
  })

  it.each([
    ["the last byte (GCM tag)", (b: Buffer) => { b[b.length - 1] ^= 0xff }],
    ["a ciphertext byte", (b: Buffer) => { b[1 + 12] ^= 0x01 }],
    ["a nonce byte", (b: Buffer) => { b[1] ^= 0x01 }],
  ])("detects tampering with %s", async (_label, tamper) => {
    const input = putInput(id(`doc_s3_tamper_${_label.length}`))
    const stored = await putImmutableDocumentObject(input)
    const key = keyOf(stored.storagePath)
    const tampered = Buffer.from((await vault.get(key))!)
    tamper(tampered)
    await vault.put(key, tampered)
    await expect(
      getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)
    ).rejects.toThrow(/unable to authenticate data|Unsupported state/)
    await vault.remove(key)
  })

  it("rejects an object whose format version byte is not 1", async () => {
    const input = putInput(id("doc_s3_version"))
    const stored = await putImmutableDocumentObject(input)
    const key = keyOf(stored.storagePath)
    const bad = Buffer.from((await vault.get(key))!)
    bad[0] = 2
    await vault.put(key, bad)
    await expect(
      getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)
    ).rejects.toThrow("unsupported document object format version 2")
    await vault.remove(key)
  })

  it("an object written under another key does not decrypt", async () => {
    const input = putInput(id("doc_s3_wrong_key"))
    const stored = await putImmutableDocumentObject(input)
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY", "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff1")
    await expect(
      getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)
    ).rejects.toThrow(/unable to authenticate data|Unsupported state/)
    vi.unstubAllEnvs()
    await deleteDocumentObject(stored.storagePath)
  })

  it("rejects path traversal in the object identity", async () => {
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

  it("a second put to the same key is refused and leaves the first object intact", async () => {
    const input = putInput(id("doc_s3_immutable"))
    const first = await putImmutableDocumentObject(input)
    const before = await vault.get(keyOf(first.storagePath))
    await expect(putImmutableDocumentObject(input)).rejects.toThrow("document object already exists (immutable)")
    expect((await vault.get(keyOf(first.storagePath)))!.equals(before!)).toBe(true)
    await deleteDocumentObject(first.storagePath)
  })

  it("the server honours If-None-Match: * (412 when the key exists)", async () => {
    const key = keyOf(buildDocumentStoragePath("firmA", id("doc_if_none_match"), 1))
    await vault.put(key, Buffer.from("seed"))
    const client = new S3Client({
      region: "auto",
      endpoint: realEndpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY!,
      },
    })
    await expect(
      client.send(
        new PutObjectCommand({ Bucket: vault.bucket, Key: key, Body: Buffer.from("duplicate"), IfNoneMatch: "*" })
      )
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } })
    client.destroy()
    await vault.remove(key)
  })

  it("concurrent create-only puts: exactly one wins, the loser is told the key exists", async () => {
    const path = buildDocumentStoragePath("firmA", id("doc_concurrent_put"), 1)
    const results = await Promise.allSettled([
      writeS3Payload(path, Buffer.from("writer-a")),
      writeS3Payload(path, Buffer.from("writer-b")),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0].reason)).toMatch(/already exists \(immutable\)/)
    await deleteDocumentObject(path)
  })
})

describe("F03 no orphan on a failed round trip (FA-D16-003)", () => {
  it("a corrupted verify read deletes the new object and keeps its neighbour", async () => {
    const keep = putInput(id("doc_s3_neighbour"))
    const kept = await putImmutableDocumentObject(keep)
    productEndpoint(proxy.endpoint)
    proxy.setMode({ kind: "corrupt-next-get" })
    const failing = putInput(id("doc_s3_verify_fail"))
    // The SDK's response checksum catches the flipped byte before AES-GCM does; either way the
    // verify read fails and the object must go.
    await expect(putImmutableDocumentObject(failing)).rejects.toThrow(
      "document object store get failed: transport checksum mismatch"
    )
    expect(await vault.get(keyFor("doc_s3_verify_fail"))).toBeNull()
    expect(await vault.get(keyOf(kept.storagePath))).not.toBeNull()
    productEndpoint(realEndpoint)
    await deleteDocumentObject(kept.storagePath)
  })

  it("when the rollback delete fails too, it is logged with the key and the verify error is the one thrown", async () => {
    productEndpoint(proxy.endpoint)
    proxy.setMode({ kind: "corrupt-next-get", thenFailDelete: true })
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(putImmutableDocumentObject(putInput(id("doc_s3_rollback_fail")))).rejects.toThrow(
      "document object store get failed: transport checksum mismatch"
    )
    expect(errors).toHaveBeenCalledWith("[documentObjectStore] rollback delete failed:", expect.any(DocumentObjectStoreError))
    const logged = errors.mock.calls.flat().find((a) => a instanceof DocumentObjectStoreError) as DocumentObjectStoreError
    expect(logged.message).toBe("document object store delete failed: HTTP 500 InternalError")
    // The object stays (the delete was refused) and the log said so.
    expect(await vault.get(keyFor("doc_s3_rollback_fail"))).not.toBeNull()
    await vault.remove(keyFor("doc_s3_rollback_fail"))
  })
})

describe("F03 ambiguous PUT on S3 (owner review items 3-4)", () => {
  it("a PUT whose connection drops but which lands late is recognised by its own bytes: the upload succeeds", async () => {
    productEndpoint(proxy.endpoint, "2000", "6000")
    proxy.setMode({ kind: "put-lands-late", delayMs: 600 })
    const input = putInput(id("doc_s3_late_put"))
    const stored = await putImmutableDocumentObject(input)
    await proxy.settled()
    proxy.setMode({ kind: "pass" })
    expect(stored.storagePath).toBe(`s3://${keyFor("doc_s3_late_put")}`)
    const readBack = await getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)
    expect(readBack.equals(input.bytes)).toBe(true)
    const settleReads = proxy.seen.filter((r) => r.method === "GET" && r.path.includes("doc_s3_late_put"))
    expect(settleReads.length).toBeGreaterThanOrEqual(2)
    await deleteDocumentObject(stored.storagePath)
  })

  it("a late landing of someone else's bytes is a conflict, not a success", async () => {
    productEndpoint(proxy.endpoint, "2000", "4000")
    proxy.setMode({ kind: "put-lost" })
    const path = buildDocumentStoragePath("firmA", id("doc_s3_foreign_bytes"), 1)
    const write = writeS3Payload(path, Buffer.from("ours"))
    setTimeout(() => void vault.put(keyOf(path), Buffer.from("theirs")), 300)
    await expect(write).rejects.toThrow("document object already exists (immutable)")
    expect((await vault.get(keyOf(path)))!.toString()).toBe("theirs")
    await vault.remove(keyOf(path))
  })

  it("a lost PUT fails after the settle budget, names the key in an ERROR log, and leaves nothing behind", async () => {
    productEndpoint(proxy.endpoint, "500", "800")
    proxy.setMode({ kind: "put-lost" })
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const started = performance.now()
    const error = await putImmutableDocumentObject(putInput(id("doc_s3_lost_put"))).catch((err) => err)
    const elapsed = performance.now() - started
    expect(error).toBeInstanceOf(DocumentObjectStoreError)
    expect((error as Error).message).toMatch(/^document object store put outcome unknown after 800 ms settle budget/)
    const logged = errors.mock.calls.flat().map(String).join("\n")
    expect(logged).toMatch(/ambiguous PUT did not settle within 800 ms/)
    expect(logged).toContain(`key=${keyFor("doc_s3_lost_put")}`)
    expect(elapsed).toBeLessThan(500 + 800 + 4_000)
    expect(await vault.get(keyFor("doc_s3_lost_put"))).toBeNull()
  })

  it("a read whose body stalls half way fails within the request timeout", async () => {
    const input = putInput(id("doc_s3_stalled_body"), "x".repeat(64 * 1024))
    const stored = await putImmutableDocumentObject(input)
    productEndpoint(proxy.endpoint, "400", "0")
    proxy.setMode({ kind: "stall-get-body" })
    const started = performance.now()
    const error = await getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash).catch(
      (err) => err
    )
    const elapsed = performance.now() - started
    expect(error).toBeInstanceOf(DocumentObjectStoreError)
    expect((error as Error).message).toBe("document object store get failed: no response within 400 ms")
    expect(elapsed).toBeLessThan(400 + 4_000)
    proxy.setMode({ kind: "pass" })
    productEndpoint(realEndpoint)
    await deleteDocumentObject(stored.storagePath)
  })
})
