import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  filesystemPathForStoragePath,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
} from "@/platform/documents/documentObjectStore"
import { newStore } from "@/platform/spine/store"
import { S3Client } from "@aws-sdk/client-s3"
import { pickIntactVersion, restoreObjects } from "../objects/restore"
import { validateR2LockRules } from "../objects/protection"
import { S3Versioned, type ObjectVersionInfo, type VersionedObjectAccess } from "../objects/s3"

let objectRoot: string

beforeEach(() => {
  objectRoot = mkdtempSync(join(tmpdir(), "f33-restore-objects-"))
  process.env.SIKANDER_DOCUMENT_OBJECT_ROOT = objectRoot
  process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "fs"
  process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = randomBytes(32).toString("hex")
})

afterEach(() => {
  rmSync(objectRoot, { recursive: true, force: true })
  delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
  delete process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND
  delete process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
  resetDocumentObjectStoreForTests()
})

describe("pickIntactVersion", () => {
  it("skips delete markers and picks newest intact version", async () => {
    const versions: ObjectVersionInfo[] = [
      { key: "k", versionId: "v1" },
      { key: "k", versionId: "v2", isDeleteMarker: true },
      { key: "k", versionId: "v3" },
    ]
    const bodies: Record<string, Buffer> = { v1: Buffer.from("bad"), v3: Buffer.from("good") }
    const id = await pickIntactVersion(
      versions,
      async (v) => bodies[v.versionId!],
      async (b) => b.toString() === "good"
    )
    expect(id).toBe("v3")
  })

  it("returns undefined when none intact", async () => {
    const versions: ObjectVersionInfo[] = [{ key: "k", versionId: "v1" }]
    const id = await pickIntactVersion(versions, async () => Buffer.from("x"), async () => false)
    expect(id).toBeUndefined()
  })
})

describe("restoreObjects", () => {
  it("does not mark corrupt ciphertext as restored when only length > 0", async () => {
    const store = newStore()
    const bytes = Buffer.from("vault-plaintext")
    const hash = store.hashKey("firmA", bytes)
    const put = await putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_restore_check",
      bytes,
      contentHash: hash,
      mimeType: "application/octet-stream",
    })
    const encrypted = await readFile(filesystemPathForStoragePath(put.storagePath))
    const corrupt = Buffer.from(encrypted)
    corrupt[corrupt.length - 1] ^= 0x01

    const source: VersionedObjectAccess = {
      listVersions: async () => [{ key: "k", versionId: "v1" }],
      getVersion: async () => corrupt,
      put: async () => {},
    }
    let putCalled = false
    const target: VersionedObjectAccess = {
      resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" }),
      listVersions: async () => [],
      getVersion: async () => Buffer.alloc(0),
      put: async () => {
        putCalled = true
      },
    }

    const report = await restoreObjects({
      rows: [{ id: "row1", firmId: "firmA", storagePath: put.storagePath, contentHash: hash, key: "k" }],
      source,
      target,
      store,
      location: { kind: "temp", root: objectRoot, bucket: "f33-vault-drill" },
    })
    expect(report.restored).toEqual([])
    expect(report.unrecoverable).toEqual(["row1"])
    expect(report.noop).toBe(false)
    expect(putCalled).toBe(false)
  })

  it("R4-L3 keeps noop false when a row is unrecoverable", async () => {
    const store = newStore()
    const report = await restoreObjects({
      rows: [{ id: "row-lost", firmId: "firmA", storagePath: "s3://b/k", contentHash: "ab".repeat(32), key: "k" }],
      source: {
        listVersions: async () => [{ key: "k", versionId: "v1" }],
        getVersion: async () => Buffer.from("not-a-vault-object"),
        put: async () => {},
      },
      target: {
        resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" }),
        listVersions: async () => [],
        getVersion: async () => Buffer.alloc(0),
        put: async () => {
          throw new Error("put must not run")
        },
      },
      store,
      location: { kind: "local", endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" },
    })
    expect(report.restored).toEqual([])
    expect(report.unrecoverable).toEqual(["row-lost"])
    expect(report.noop).toBe(false)
    expect(report.refused).toEqual([])
  })

  it("R4-L3 refuses a declared bucket that disagrees with the writer bucket", async () => {
    let writes = 0
    const report = await restoreObjects({
      rows: [{ id: "row1", firmId: "firmA", storagePath: "s3://b/k", contentHash: "ab".repeat(32), key: "k" }],
      source: {
        listVersions: async () => [],
        getVersion: async () => Buffer.from("x"),
        put: async () => {},
      },
      target: {
        resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" }),
        listVersions: async () => {
          writes += 1
          return []
        },
        getVersion: async () => Buffer.from("x"),
        put: async () => {
          writes += 1
        },
      },
      store: newStore(),
      location: { kind: "local", endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-other" },
    })
    expect(writes).toBe(0)
    expect(report.restored).toEqual([])
    expect(report.refused).toContain("declared object location does not match the writer bucket")
  })

  it("rejects decrypted bytes whose content hash does not match the row", async () => {
    const store = newStore()
    const bytes = Buffer.from("vault-plaintext-2")
    const hash = store.hashKey("firmA", bytes)
    const put = await putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_hash_mismatch",
      bytes,
      contentHash: hash,
      mimeType: "application/octet-stream",
    })
    const encrypted = await readFile(filesystemPathForStoragePath(put.storagePath))
    const wrongHash = store.hashKey("firmA", Buffer.from("other"))

    const report = await restoreObjects({
      rows: [{ id: "row2", firmId: "firmA", storagePath: put.storagePath, contentHash: wrongHash, key: "k" }],
      location: { kind: "temp", root: objectRoot, bucket: "f33-vault-drill" },
      source: {
        listVersions: async () => [{ key: "k", versionId: "v1" }],
        getVersion: async () => encrypted,
        put: async () => {},
      },
      target: {
        resolvedTarget: async () => ({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" }),
        listVersions: async () => [],
        getVersion: async () => Buffer.alloc(0),
        put: async () => {
          throw new Error("should not put")
        },
      },
      store,
    })
    expect(report.restored).toEqual([])
    expect(report.unrecoverable).toEqual(["row2"])
  })

  it("reads the S3 client endpoint and bucket, and refuses a declared location that disagrees", async () => {
    const client = new S3Client({
      region: "us-east-1",
      endpoint: "http://127.0.0.1:19021",
      forcePathStyle: true,
      credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
    })
    const writer = new S3Versioned(client, "f33-vault-drill")
    const actual = await writer.resolvedTarget()
    expect(actual).toEqual({ endpoint: "http://127.0.0.1:19021", bucket: "f33-vault-drill" })
    const store = newStore()
    const report = await restoreObjects({
      rows: [],
      source: writer,
      target: writer,
      store,
      location: { kind: "local", endpoint: "https://s3.amazonaws.com", bucket: "prod" },
    })
    expect(report.restored).toEqual([])
    expect(report.refused.join("\n")).toMatch(/writer endpoint|managed cloud|explicit drill target/)
  })
})

describe("validateR2LockRules", () => {
  it("requires id, enabled, prefix and min age", () => {
    const problems = validateR2LockRules({ rules: [{ enabled: true, condition: { maxAgeSeconds: 1 } }] }, 100)
    expect(problems.some((p) => p.includes("id"))).toBe(true)
    expect(problems.some((p) => p.includes("maxAgeSeconds"))).toBe(true)
    expect(problems.some((p) => p.includes("prefix"))).toBe(true)
  })
})
