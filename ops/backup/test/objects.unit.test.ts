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
import { pickIntactVersion, restoreObjects } from "../objects/restore"
import { validateR2LockRules } from "../objects/protection"
import type { ObjectVersionInfo } from "../objects/s3"
import type { VersionedObjectAccess } from "../objects/s3"

const ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
let objectRoot: string

beforeEach(() => {
  objectRoot = mkdtempSync(join(tmpdir(), "f33-restore-objects-"))
  process.env.SIKANDER_DOCUMENT_OBJECT_ROOT = objectRoot
  process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "fs"
  process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = ENC_KEY
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
    }
    let putCalled = false
    const target: VersionedObjectAccess = {
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
    })
    expect(report.restored).toEqual([])
    expect(report.unrecoverable).toEqual(["row1"])
    expect(putCalled).toBe(false)
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
