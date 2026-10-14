/**
 * FA-D16-002 (audit v2, HIGH): the integrity check and the key validation that F03 relies on had
 * no test coverage (Stryker NoCoverage at documentObjectStore.ts:47-49, :93-94 and :112-113).
 * These tests drive the encrypted envelope directly: tampered and truncated ciphertext, the wrong
 * key, malformed keys, the wrong format version and content-hash mismatches.
 */
import { randomBytes } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  assertDocumentObjectIngestAllowed,
  DocumentObjectConfigurationError,
  filesystemPathForStoragePath,
  getImmutableDocumentObject,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
} from "@/platform/documents/documentObjectStore"
import { newStore, type SpineStore } from "@/platform/spine/store"

// Two distinct valid keys, generated per run (never committed).
const KEY_A = randomBytes(32).toString("hex")
const KEY_B = randomBytes(32).toString("hex")
const GCM_AUTH_FAILURE = /unable to authenticate data/
const ENVELOPE_OVERHEAD = 1 + 12 + 16

let root: string
let savedKey: string | undefined

beforeAll(() => {
  savedKey = process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
})

afterAll(() => {
  if (savedKey === undefined) delete process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
  else process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = savedKey
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fa-d16-002-"))
  process.env.SIKANDER_DOCUMENT_OBJECT_ROOT = root
  process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = KEY_A
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
  process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = KEY_A
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetDocumentObjectStoreForTests()
})

async function putSample(text = "%PDF-1.7 FA-D16-002 sample evidence bytes%", docId = "doc_sample") {
  const store = newStore()
  const bytes = Buffer.from(text, "utf8")
  const contentHash = store.hashKey("firmA", bytes)
  const stored = await putImmutableDocumentObject({
    store,
    firmId: "firmA",
    docId,
    bytes,
    contentHash,
    mimeType: "application/pdf",
  })
  const file = filesystemPathForStoragePath(stored.storagePath)
  return { store, bytes, contentHash, stored, file }
}

function read(store: SpineStore, storagePath: string, contentHash: string) {
  return getImmutableDocumentObject(store, "firmA", storagePath, contentHash)
}

function encFiles(): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
}

describe("FA-D16-002: envelope format", () => {
  it("writes version 1 | 12-byte nonce | ciphertext | 16-byte tag, never the plaintext", async () => {
    const { bytes, file, stored } = await putSample()
    const onDisk = readFileSync(file)
    expect(onDisk[0]).toBe(1)
    expect(onDisk.length).toBe(bytes.length + ENVELOPE_OVERHEAD)
    expect(onDisk.includes(bytes)).toBe(false)
    expect(onDisk.includes(Buffer.from("FA-D16-002"))).toBe(false)
    expect(stored).toEqual({
      storagePath: "fs://firmA/documents/doc_sample/v1",
      objectVersion: 1,
      byteSize: bytes.length,
      mimeType: "application/pdf",
    })
  })

  it("uses a fresh random nonce per object, so equal plaintexts encrypt differently", async () => {
    const a = await putSample("same bytes", "doc_nonce_a")
    const b = await putSample("same bytes", "doc_nonce_b")
    const fa = readFileSync(a.file)
    const fb = readFileSync(b.file)
    expect(fa.subarray(1, 13).equals(fb.subarray(1, 13))).toBe(false)
    expect(fa.subarray(13).equals(fb.subarray(13))).toBe(false)
  })

  it("round-trips the exact bytes", async () => {
    const { store, bytes, contentHash, stored } = await putSample()
    const back = await read(store, stored.storagePath, contentHash)
    expect(back.equals(bytes)).toBe(true)
  })

  it("round-trips a zero-length object (the minimum envelope: header + tag, 29 bytes)", async () => {
    // A zero-length plaintext is exactly the 29-byte header + tag: the truncation guard must
    // accept that length and leave the decision to GCM.
    const { store, file, stored, contentHash } = await putSample("", "doc_min")
    const envelope = readFileSync(file)
    expect(envelope.length).toBe(ENVELOPE_OVERHEAD)
    const back = await read(store, stored.storagePath, contentHash)
    expect(back.length).toBe(0)
  })
})

describe("FA-D16-002: tampered and truncated ciphertext is rejected on read", () => {
  it.each([
    ["first nonce byte", 1],
    ["last nonce byte", 12],
    ["first ciphertext byte", 13],
    ["last ciphertext byte", -17],
    ["first tag byte", -16],
    ["last tag byte", -1],
  ])("a flipped %s fails GCM authentication", async (_label, offset) => {
    const { store, contentHash, stored, file } = await putSample()
    const tampered = readFileSync(file)
    const index = offset < 0 ? tampered.length + offset : offset
    tampered[index] ^= 0x01
    writeFileSync(file, tampered)
    await expect(read(store, stored.storagePath, contentHash)).rejects.toThrow(GCM_AUTH_FAILURE)
  })

  it("an object cut by one byte fails authentication", async () => {
    const { store, contentHash, stored, file } = await putSample()
    const full = readFileSync(file)
    writeFileSync(file, full.subarray(0, full.length - 1))
    await expect(read(store, stored.storagePath, contentHash)).rejects.toThrow(GCM_AUTH_FAILURE)
  })

  it("an object shorter than header + tag is refused as truncated", async () => {
    const { store, contentHash, stored, file } = await putSample()
    const full = readFileSync(file)
    writeFileSync(file, full.subarray(0, ENVELOPE_OVERHEAD - 1))
    await expect(read(store, stored.storagePath, contentHash)).rejects.toThrow(
      "document object payload is truncated"
    )
    writeFileSync(file, Buffer.alloc(0))
    await expect(read(store, stored.storagePath, contentHash)).rejects.toThrow(
      "document object payload is truncated"
    )
  })

  it("an object of exactly header + tag is not 'truncated' but still fails authentication", async () => {
    const { store, contentHash, stored, file } = await putSample()
    const full = readFileSync(file)
    const headerAndTag = Buffer.concat([full.subarray(0, 13), full.subarray(full.length - 16)])
    expect(headerAndTag.length).toBe(ENVELOPE_OVERHEAD)
    writeFileSync(file, headerAndTag)
    const err = await read(store, stored.storagePath, contentHash).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/truncated/)
    expect((err as Error).message).toMatch(GCM_AUTH_FAILURE)
  })

  it("a wrong format version is refused before decryption (the version byte is not authenticated)", async () => {
    const { store, contentHash, stored, file } = await putSample()
    const original = readFileSync(file)
    for (const version of [0, 2, 255]) {
      const changed = Buffer.from(original)
      changed[0] = version
      writeFileSync(file, changed)
      await expect(read(store, stored.storagePath, contentHash)).rejects.toThrow(
        `unsupported document object format version ${version}`
      )
    }
    writeFileSync(file, original)
    await expect(read(store, stored.storagePath, contentHash)).resolves.toBeInstanceOf(Buffer)
  })
})

describe("FA-D16-002: the wrong key and content-hash mismatches", () => {
  it("a different valid 32-byte key cannot decrypt the object", async () => {
    const { store, contentHash, stored, bytes } = await putSample()
    process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = KEY_B
    await expect(read(store, stored.storagePath, contentHash)).rejects.toThrow(GCM_AUTH_FAILURE)
    process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = KEY_A
    expect((await read(store, stored.storagePath, contentHash)).equals(bytes)).toBe(true)
  })

  it("a read whose expected hash differs from the decrypted bytes is refused", async () => {
    const { store, stored } = await putSample()
    const otherHash = store.hashKey("firmA", Buffer.from("some other document"))
    await expect(read(store, stored.storagePath, otherHash)).rejects.toThrow(
      "document object integrity check failed: content hash mismatch"
    )
  })

  it("the hash is firm-scoped: the same bytes under another firm's hash are refused", async () => {
    const { store, stored, bytes } = await putSample()
    await expect(
      read(store, stored.storagePath, store.hashKey("firmB", bytes))
    ).rejects.toThrow(/content hash mismatch/)
  })

  it("a write whose contentHash does not match the bytes is refused before anything is written", async () => {
    const store = newStore()
    const bytes = Buffer.from("bytes the caller hashed wrongly")
    await expect(
      putImmutableDocumentObject({
        store,
        firmId: "firmA",
        docId: "doc_badhash",
        bytes,
        contentHash: store.hashKey("firmA", Buffer.from("different bytes")),
        mimeType: "application/octet-stream",
      })
    ).rejects.toThrow("document object integrity check failed: content hash mismatch")
    expect(encFiles()).toEqual([])
  })
})

describe("FA-D16-002: encryption key validation", () => {
  async function putWithKey(key: string | undefined) {
    if (key === undefined) delete process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
    else process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = key
    const store = newStore()
    const bytes = Buffer.from("key validation")
    return putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_key",
      bytes,
      contentHash: store.hashKey("firmA", bytes),
      mimeType: "application/octet-stream",
    })
  }

  const malformed: Array<[string, string]> = [
    ["31 bytes (62 hex characters)", KEY_A.slice(0, 62)],
    ["33 bytes (66 hex characters)", `${KEY_A}ab`],
    ["63 hex characters (odd length)", KEY_A.slice(0, 63)],
    ["65 hex characters (odd length; Buffer.from would drop the last nibble)", `${KEY_A}a`],
    ["64 non-hex characters", "g".repeat(64)],
    ["64 hex characters followed by non-hex junk", `${KEY_A}zz`],
    ["non-hex in the middle", `${KEY_A.slice(0, 30)}zz${KEY_A.slice(32)}`],
    ["base64 of 32 bytes (hex is the only accepted encoding)", Buffer.from(KEY_A, "hex").toString("base64")],
  ]

  it.each(malformed)("rejects a key of %s", async (_label, key) => {
    await expect(putWithKey(key)).rejects.toThrow(DocumentObjectConfigurationError)
    await expect(putWithKey(key)).rejects.toThrow(
      "SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"
    )
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(DocumentObjectConfigurationError)
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(/must be 64 hex characters/)
    expect(encFiles()).toEqual([])
  })

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("rejects a key that is %s", async (_label, key) => {
    await expect(putWithKey(key)).rejects.toThrow("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY is not set")
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(
      "document object encryption key is required before ingest is accepted"
    )
  })

  it("accepts 64 hex characters in either case, with surrounding whitespace trimmed", async () => {
    await expect(putWithKey(KEY_A.toUpperCase())).resolves.toMatchObject({ objectVersion: 1 })
    rmSync(root, { recursive: true, force: true })
    await expect(putWithKey(`  ${KEY_A}\n`)).resolves.toMatchObject({ objectVersion: 1 })
    expect(() => assertDocumentObjectIngestAllowed()).not.toThrow()
  })

  it("an object written with the upper-case spelling of a key reads back with the lower-case one", async () => {
    process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = KEY_A.toUpperCase()
    const { store, contentHash, stored, bytes } = await putSample()
    process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = KEY_A
    expect((await read(store, stored.storagePath, contentHash)).equals(bytes)).toBe(true)
  })
})

describe("FA-D16-002: storage paths are firm-scoped and validated", () => {
  it.each([
    ["fs://firmA/documents/doc_x/v1/../../etc", "traversal"],
    ["fs://firmA/documents/doc x/v1", "space"],
    ["fs://firmA/other/doc_x/v1", "wrong collection segment"],
    ["fs://firmA/documents/doc_x", "missing version"],
    ["fs://firmA/documents/doc_x/v1/extra", "extra segment"],
    ["fs://firmA/documents/doc_x/vX", "non-numeric version"],
    ["s3://firmA/documents/doc_x/v1", "unknown scheme"],
    ["firmA/documents/doc_x/v1", "no scheme"],
  ])("refuses to read %s (%s)", async (storagePath) => {
    const store = newStore()
    await expect(read(store, storagePath, "0".repeat(64))).rejects.toThrow(
      "document storagePath is malformed"
    )
  })

  it("refuses a read whose storagePath belongs to another firm", async () => {
    const { store, contentHash, stored } = await putSample()
    await expect(
      getImmutableDocumentObject(store, "firmB", stored.storagePath, contentHash)
    ).rejects.toThrow(/does not belong to firm/)
  })
})
