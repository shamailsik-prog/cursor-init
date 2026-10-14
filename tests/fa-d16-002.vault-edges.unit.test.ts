/**
 * FA-D16-002: edge cases of the document vault that the main FA-D16 suites do not reach, written
 * against the surviving mutants of `npm run mutation:documents`: identity and storagePath
 * validation boundaries, key and endpoint parsing, local backend failure modes, the error types,
 * and the uploadDocument dedup scan.
 */
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  assertDocumentObjectIngestAllowed,
  buildDocumentStoragePath,
  createDocumentObjectStore,
  createFilesystemDocumentObjectBackend,
  createMemoryDocumentObjectBackend,
  createR2DocumentObjectBackend,
  deleteDocumentObject,
  DocumentObjectConfigurationError,
  DocumentObjectExistsError,
  DocumentObjectNotFoundError,
  DocumentObjectVerificationError,
  filesystemPathForStoragePath,
  getImmutableDocumentObject,
  parseDocumentStoragePath,
  putImmutableDocumentObject,
  readR2DocumentObjectConfig,
  resetDocumentObjectStoreForTests,
  setDocumentObjectBackendForTests,
  validateDocumentObjectIdentity,
  type DocumentObjectBackend,
} from "@/platform/documents/documentObjectStore"
import { filesystemObjectFile } from "@/platform/documents/localObjectBackends"
import { newStore, type SpineStore } from "@/platform/spine/store"
import { uploadDocument } from "@/services/d1-6/uploadDocument"

const env = process.env as Record<string, string | undefined>
const R2_VARS = [
  "SIKANDER_DOCUMENT_OBJECT_BACKEND",
  "SIKANDER_R2_ENDPOINT",
  "SIKANDER_R2_BUCKET",
  "SIKANDER_R2_ACCESS_KEY_ID",
  "SIKANDER_R2_SECRET_ACCESS_KEY",
  "SIKANDER_R2_REGION",
  "SIKANDER_DOCUMENT_OBJECT_ROOT",
  "SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY",
]
let saved: Record<string, string | undefined>
let root: string

beforeEach(() => {
  saved = Object.fromEntries(R2_VARS.map((n) => [n, env[n]]))
  root = mkdtempSync(join(tmpdir(), "fa-d16-002-edges-"))
})

afterEach(() => {
  for (const [n, v] of Object.entries(saved)) {
    if (v === undefined) delete env[n]
    else env[n] = v
  }
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  setDocumentObjectBackendForTests(null)
  resetDocumentObjectStoreForTests()
})

function r2Env(overrides: Record<string, string | undefined> = {}) {
  return {
    SIKANDER_R2_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
    SIKANDER_R2_BUCKET: "sikander-vault",
    SIKANDER_R2_ACCESS_KEY_ID: "FAKEACCESSKEYFAD16",
    SIKANDER_R2_SECRET_ACCESS_KEY: "fake-secret-for-unit-tests-only",
    ...overrides,
  } as NodeJS.ProcessEnv
}

function configMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(DocumentObjectConfigurationError)
    return (err as Error).message
  }
  throw new Error("expected a DocumentObjectConfigurationError")
}

describe("identity and storagePath validation boundaries", () => {
  it.each(["firmA/..", "../etc", "firm A", "", "firm.A", "firmA\n", "/firmA"])(
    "refuses the firm id %j",
    (firmId) => {
      expect(() => validateDocumentObjectIdentity(firmId, "doc_ok")).toThrow(
        "document object identity failed path safety validation"
      )
      expect(() => validateDocumentObjectIdentity("firmA", firmId)).toThrow(
        "document object identity failed path safety validation"
      )
    }
  )

  it("accepts letters, digits, underscore and hyphen", () => {
    expect(() => validateDocumentObjectIdentity("Firm_A-9", "doc_0a-Z")).not.toThrow()
  })

  it.each([
    "xfs://firmA/documents/doc_x/v1",
    "fs://firm.A/documents/doc_x/v1",
    "fs://firmA/documents/doc.x/v1",
    "fs:///documents/doc_x/v1",
    "fs://firmA/documents//v1",
    "fs://firmA/documents/doc_x/v",
    "fs://firmA/documents/doc_x/v1\n",
    "r2:/firmA/documents/doc_x/v1",
  ])("refuses the storagePath %j", (storagePath) => {
    expect(() => parseDocumentStoragePath(storagePath)).toThrow("document storagePath is malformed")
  })

  it("parses scheme, firm, document, multi-digit version and object key", () => {
    expect(parseDocumentStoragePath("r2://firmA/documents/doc_x/v12")).toEqual({
      scheme: "r2://",
      firmId: "firmA",
      docId: "doc_x",
      objectVersion: 12,
      key: "firmA/documents/doc_x/v12.enc",
    })
    expect(parseDocumentStoragePath("fs://f/documents/d/v1").scheme).toBe("fs://")
  })

  it("a well-formed path to an absent object is 'not found', not 'malformed'", async () => {
    env.SIKANDER_DOCUMENT_OBJECT_ROOT = root
    await expect(
      getImmutableDocumentObject(newStore(), "firmA", "fs://firmA/documents/doc_x/v12", "0".repeat(64))
    ).rejects.toThrow("document object not found: firmA/documents/doc_x/v12.enc")
  })

  it("buildDocumentStoragePath uses the configured backend's scheme", () => {
    Object.assign(env, r2Env(), { SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2" })
    expect(buildDocumentStoragePath("firmA", "doc_x", 3)).toBe("r2://firmA/documents/doc_x/v3")
    expect(buildDocumentStoragePath("firmA", "doc_x", 3, "fs://")).toBe("fs://firmA/documents/doc_x/v3")
    expect(() => buildDocumentStoragePath("firm/A", "doc_x", 1, "fs://")).toThrow(/path safety/)
  })

  it("filesystemPathForStoragePath needs an fs:// path and a root", () => {
    env.SIKANDER_DOCUMENT_OBJECT_ROOT = root
    expect(filesystemPathForStoragePath("fs://firmA/documents/doc_x/v1")).toBe(
      join(root, "firmA", "documents", "doc_x", "v1.enc")
    )
    expect(() => filesystemPathForStoragePath("r2://firmA/documents/doc_x/v1")).toThrow(
      "document storagePath must use fs:// scheme"
    )
    delete env.SIKANDER_DOCUMENT_OBJECT_ROOT
    expect(() => filesystemPathForStoragePath("fs://firmA/documents/doc_x/v1")).toThrow(
      new DocumentObjectConfigurationError("SIKANDER_DOCUMENT_OBJECT_ROOT is not set")
    )
  })
})

describe("key and endpoint parsing boundaries", () => {
  it("refuses non-hex junk before 64 hex characters", () => {
    env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = `zz${randomBytes(32).toString("hex")}`
    expect(configMessage(() => assertDocumentObjectIngestAllowed())).toBe(
      "SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"
    )
  })

  it.each([
    ["a fragment", "https://account-id.r2.cloudflarestorage.com/#x"],
    ["a user name only", "https://user@account-id.r2.cloudflarestorage.com"],
    ["a password only", "https://:pw@account-id.r2.cloudflarestorage.com"],
    ["a double slash path", "https://account-id.r2.cloudflarestorage.com//"],
  ])("refuses an endpoint with %s", (_label, endpoint) => {
    expect(configMessage(() => readR2DocumentObjectConfig(r2Env({ SIKANDER_R2_ENDPOINT: endpoint })))).toBe(
      "SIKANDER_R2_ENDPOINT must be an http(s) URL with no path, query or credentials"
    )
  })

  it("keeps the port of the endpoint", () => {
    expect(readR2DocumentObjectConfig(r2Env({ SIKANDER_R2_ENDPOINT: "http://127.0.0.1:9000" })).endpoint).toBe(
      "http://127.0.0.1:9000"
    )
  })

  it.each(["ab", "a".repeat(64)])("refuses the bucket name %s (length bounds 3..63)", (bucket) => {
    expect(configMessage(() => readR2DocumentObjectConfig(r2Env({ SIKANDER_R2_BUCKET: bucket })))).toBe(
      "SIKANDER_R2_BUCKET is not a valid bucket name"
    )
  })

  it.each(["abc", "a".repeat(63), "my.bucket-1"])("accepts the bucket name %s", (bucket) => {
    expect(readR2DocumentObjectConfig(r2Env({ SIKANDER_R2_BUCKET: bucket })).bucket).toBe(bucket)
  })
})

describe("local backends", () => {
  it("the memory backend stores and returns copies, never the caller's buffer", async () => {
    const backend = createMemoryDocumentObjectBackend()
    const payload = Buffer.from("original")
    await backend.putIfAbsent("firmA/documents/doc_copy/v1.enc", payload)
    payload[0] = 0x58
    const first = await backend.get("firmA/documents/doc_copy/v1.enc")
    expect(first.toString()).toBe("original")
    first[0] = 0x59
    expect((await backend.get("firmA/documents/doc_copy/v1.enc")).toString()).toBe("original")
    expect(backend.kind).toBe("memory")
    expect(backend.scheme).toBe("fs://")
  })

  it.each([".", "..", "../outside.enc", "a/../../outside.enc"])(
    "filesystemObjectFile refuses the key %j (outside or equal to the root)",
    (key) => {
      expect(() => filesystemObjectFile(root, key)).toThrow("document object path escapes storage root")
    }
  )

  it("filesystemObjectFile resolves a key below the root", () => {
    expect(filesystemObjectFile(root, "firmA/documents/doc_x/v1.enc")).toBe(
      join(root, "firmA", "documents", "doc_x", "v1.enc")
    )
  })

  it("the fs backend reports I/O failures as they are, not as 'exists' or 'not found'", async () => {
    const fileAsRoot = join(root, "not-a-directory")
    writeFileSync(fileAsRoot, "x")
    const broken = createFilesystemDocumentObjectBackend(fileAsRoot)
    const putErr = await broken.putIfAbsent("firmA/documents/doc_x/v1.enc", Buffer.from("p")).catch((e) => e)
    expect(putErr).toBeInstanceOf(Error)
    expect(putErr).not.toBeInstanceOf(DocumentObjectExistsError)
    expect((putErr as NodeJS.ErrnoException).code).toMatch(/ENOTDIR|EEXIST/)

    const backend = createFilesystemDocumentObjectBackend(root)
    mkdirSync(join(root, "firmA", "documents", "doc_dir", "v1.enc"), { recursive: true })
    const getErr = await backend.get("firmA/documents/doc_dir/v1.enc").catch((e) => e)
    expect(getErr).not.toBeInstanceOf(DocumentObjectNotFoundError)
    expect((getErr as NodeJS.ErrnoException).code).toBe("EISDIR")
    const delErr = await backend.delete("firmA/documents/doc_dir/v1.enc").catch((e) => e)
    expect(delErr).toBeInstanceOf(Error)
    expect((delErr as NodeJS.ErrnoException).code).toMatch(/EISDIR|EPERM/)

    await expect(backend.delete("firmA/documents/doc_absent/v1.enc")).resolves.toBeUndefined()
    await expect(backend.get("firmA/documents/doc_absent/v1.enc")).rejects.toBeInstanceOf(
      DocumentObjectNotFoundError
    )
    expect(backend.kind).toBe("fs")
    expect(backend.scheme).toBe("fs://")
  })
})

describe("error types and logging", () => {
  it("every vault error carries its own name", () => {
    expect(new DocumentObjectConfigurationError("x").name).toBe("DocumentObjectConfigurationError")
    expect(new DocumentObjectExistsError("k").name).toBe("DocumentObjectExistsError")
    expect(new DocumentObjectNotFoundError("k").name).toBe("DocumentObjectNotFoundError")
    const cause = new Error("inner")
    const err = new DocumentObjectVerificationError("fs://f/documents/d/v1", true, cause)
    expect(err.name).toBe("DocumentObjectVerificationError")
    expect(err.cause).toBe(cause)
    expect(err.message).toBe("document object round-trip verification failed: inner")
    expect(new DocumentObjectVerificationError("p", true, "a string").message).toBe(
      "document object round-trip verification failed: a string"
    )
  })

  it("a failed discard of an unverified object is logged with its storagePath", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = createMemoryDocumentObjectBackend()
    const backend: DocumentObjectBackend = {
      kind: inner.kind,
      scheme: inner.scheme,
      putIfAbsent: (k, p) => inner.putIfAbsent(k, p),
      get: async () => {
        throw "unreadable"
      },
      delete: async () => {
        throw new Error("locked")
      },
    }
    const store = newStore()
    const bytes = Buffer.from("log me")
    const err = await createDocumentObjectStore(backend)
      .put({ store, firmId: "firmA", docId: "doc_log", bytes, contentHash: store.hashKey("firmA", bytes), mimeType: "x" })
      .catch((e) => e)
    expect((err as Error).message).toBe(
      "document object round-trip verification failed: unreadable; the written object could not be removed"
    )
    expect(errorSpy).toHaveBeenCalledWith(
      "[documents] could not remove unverified object fs://firmA/documents/doc_log/v1:",
      expect.objectContaining({ message: "locked" })
    )
  })

  it("deleteDocumentObject is best effort: a failure is logged, not thrown", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = createMemoryDocumentObjectBackend()
    setDocumentObjectBackendForTests({
      kind: inner.kind,
      scheme: inner.scheme,
      putIfAbsent: (k, p) => inner.putIfAbsent(k, p),
      get: (k) => inner.get(k),
      delete: async () => {
        throw new Error("delete refused")
      },
    })
    await expect(deleteDocumentObject("fs://firmA/documents/doc_x/v1")).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(
      "[documents] best-effort delete of fs://firmA/documents/doc_x/v1 failed:",
      expect.objectContaining({ message: "delete refused" })
    )
  })

  it("the configured store goes through the test seam when one is set", async () => {
    const inner = createMemoryDocumentObjectBackend()
    const calls: string[] = []
    setDocumentObjectBackendForTests({
      kind: inner.kind,
      scheme: inner.scheme,
      putIfAbsent: (k, p) => (calls.push(`put ${k}`), inner.putIfAbsent(k, p)),
      get: (k) => (calls.push(`get ${k}`), inner.get(k)),
      delete: (k) => (calls.push(`delete ${k}`), inner.delete(k)),
    })
    const store = newStore()
    const bytes = Buffer.from("seam")
    await putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_seam",
      bytes,
      contentHash: store.hashKey("firmA", bytes),
      mimeType: "x",
    })
    expect(calls).toEqual(["put firmA/documents/doc_seam/v1.enc", "get firmA/documents/doc_seam/v1.enc"])
  })
})

describe("backend selection, exact outcomes", () => {
  it("documentObjectBackendKind names the backend it selects", async () => {
    const { documentObjectBackendKind } = await import("@/platform/documents/documentObjectStore")
    expect(documentObjectBackendKind({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "fs", NODE_ENV: "development" })).toBe("fs")
    expect(documentObjectBackendKind({ SIKANDER_DOCUMENT_OBJECT_ROOT: root, NODE_ENV: "development" })).toBe("fs")
    expect(documentObjectBackendKind({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2", NODE_ENV: "production" })).toBe("r2")
    expect(documentObjectBackendKind({ NODE_ENV: "test" })).toBe("memory")
  })

  it("production with nothing configured names exactly what is required", () => {
    expect(configMessage(() => assertDocumentObjectIngestAllowed({
      NODE_ENV: "production",
      SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    }))).toBe(
      "No document object backend is configured. NODE_ENV=production requires " +
        "SIKANDER_DOCUMENT_OBJECT_BACKEND=r2 with the SIKANDER_R2_* credentials; the fs:// backend " +
        "(SIKANDER_DOCUMENT_OBJECT_ROOT) is per-instance, ephemeral disk and is refused in production."
    )
  })
})

describe("fs backend and backup specifics", () => {
  it("a second create of a key is DocumentObjectExistsError, not the raw EEXIST", async () => {
    const backend = createFilesystemDocumentObjectBackend(root)
    await backend.putIfAbsent("firmA/documents/doc_twice/v1.enc", Buffer.from("one"))
    const err = await backend.putIfAbsent("firmA/documents/doc_twice/v1.enc", Buffer.from("two")).catch((e) => e)
    expect(err).toBeInstanceOf(DocumentObjectExistsError)
    expect((err as Error).message).toBe("document object already exists (immutable): firmA/documents/doc_twice/v1.enc")
    expect((await backend.get("firmA/documents/doc_twice/v1.enc")).toString()).toBe("one")
  })

  it("a write failure other than EEXIST is reported as it is", async () => {
    const backend = createFilesystemDocumentObjectBackend(root)
    const err = await backend
      .putIfAbsent(`firmA/documents/doc_long/v${"1".repeat(300)}.enc`, Buffer.from("x"))
      .catch((e) => e)
    expect(err).not.toBeInstanceOf(DocumentObjectExistsError)
    expect((err as NodeJS.ErrnoException).code).toBe("ENAMETOOLONG")
  })

  it("backupDocumentObjectFile creates missing parent directories", async () => {
    const { backupDocumentObjectFile } = await import("@/platform/documents/documentObjectStore")
    env.SIKANDER_DOCUMENT_OBJECT_ROOT = root
    const store = newStore()
    const bytes = Buffer.from("backup into a nested directory")
    const { storagePath } = await putImmutableDocumentObject({
      store,
      firmId: "firmA",
      docId: "doc_backup",
      bytes,
      contentHash: store.hashKey("firmA", bytes),
      mimeType: "x",
    })
    const target = join(root, "backups", "2026", "10", "copy.enc")
    await backupDocumentObjectFile(storagePath, target)
    const { readFileSync } = await import("node:fs")
    expect(readFileSync(target).equals(readFileSync(filesystemPathForStoragePath(storagePath)))).toBe(true)
  })
})

describe("R2 backend defaults", () => {
  it("the default per-request timeout is long enough that a fresh request is not already aborted", async () => {
    let aborted: boolean | undefined
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      await new Promise((r) => setTimeout(r, 20))
      aborted = init?.signal?.aborted
      return new Response(new Uint8Array([1]), { status: 200 })
    })
    const backend = createR2DocumentObjectBackend({
      endpoint: "https://account-id.r2.example.test",
      bucket: "sikander-vault",
      accessKeyId: "FAKEACCESSKEYFAD16",
      secretAccessKey: "fake-secret-for-unit-tests-only",
      region: "auto",
    })
    await backend.get("firmA/documents/doc_x/v1.enc")
    expect(aborted).toBe(false)
  })
})

describe("uploadDocument dedup and reclassification edges", () => {
  function partnerStore(): SpineStore {
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
  let n = 0
  const upload = (store: SpineStore, bytes: Buffer, classification: "internal" | "confidential" | "privileged-restricted", callerClearance?: "internal") =>
    uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes,
      sourceChannel: "web",
      classification,
      idempotencyKey: `fad16edg-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      callerClearance,
      uploadedBy: "partner_a",
    })

  it("the OCR job gets its own job_ id", async () => {
    const store = partnerStore()
    await upload(store, Buffer.from("job id"), "internal")
    expect(store.jobs[0].id).toMatch(/^job_[0-9a-f-]{36}$/)
  })

  it("the dedup scan never reuses another firm's row, even one with the same content hash", async () => {
    const store = partnerStore()
    const bytes = Buffer.from("cross-firm scan")
    const restricted = await upload(store, bytes, "privileged-restricted")
    const hash = store.hashKey("firmA", bytes)
    store.documents.set("doc_firmB", {
      ...store.documents.get(restricted.docId)!,
      id: "doc_firmB",
      firmId: "firmB",
      classification: "internal",
      contentHash: hash,
    })
    const low = await upload(store, bytes, "internal", "internal")
    expect(low.reused).toBe(false)
    expect(low.docId).not.toBe("doc_firmB")
  })

  it("a row marked missing after a transient read failure is healed when its object still verifies", async () => {
    // On a network backend a read can fail transiently. The duplicate upload then must not be
    // refused forever by the immutable key: the intact object is verified and reused.
    const store = partnerStore()
    const bytes = Buffer.from("transient read failure")
    const first = await upload(store, bytes, "internal")
    const doc = store.documents.get(first.docId)!
    doc.objectBytesStatus = "missing"
    const again = await upload(store, bytes, "internal")
    expect(again).toEqual({ docId: first.docId, reused: true })
    expect(doc.objectBytesStatus).toBe("available")
    expect((await getImmutableDocumentObject(store, "firmA", doc.storagePath, doc.contentHash)).equals(bytes)).toBe(
      true
    )
  })

  it("a refused write (object already at the key) triggers no cleanup delete of any kind", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const inner = createMemoryDocumentObjectBackend()
    const deletes: string[] = []
    setDocumentObjectBackendForTests({
      kind: inner.kind,
      scheme: inner.scheme,
      putIfAbsent: (k, p) => inner.putIfAbsent(k, p),
      get: (k) => inner.get(k),
      delete: (k) => (deletes.push(k), inner.delete(k)),
    })
    const store = partnerStore()
    vi.spyOn(store, "id").mockImplementation((prefix: string) => `${prefix}_taken`)
    await inner.putIfAbsent("firmA/documents/doc_taken/v1.enc", Buffer.from("squatter"))
    await expect(upload(store, Buffer.from("refused"), "internal")).rejects.toBeInstanceOf(DocumentObjectExistsError)
    expect(deletes).toEqual([])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it("a verification failure the store already cleaned up is not deleted a second time", async () => {
    const inner = createMemoryDocumentObjectBackend()
    const deletes: string[] = []
    setDocumentObjectBackendForTests({
      kind: inner.kind,
      scheme: inner.scheme,
      putIfAbsent: (k, p) => inner.putIfAbsent(k, p),
      get: async (k) => {
        const p = Buffer.from(await inner.get(k))
        p[p.length - 1] ^= 1
        return p
      },
      delete: (k) => (deletes.push(k), inner.delete(k)),
    })
    const store = partnerStore()
    vi.spyOn(store, "id").mockImplementation((prefix: string) => `${prefix}_once`)
    await expect(upload(store, Buffer.from("cleaned once"), "internal")).rejects.toBeInstanceOf(
      DocumentObjectVerificationError
    )
    expect(deletes).toEqual(["firmA/documents/doc_once/v1.enc"])
  })

  it("the dedup index wins over an earlier readable duplicate", async () => {
    const store = partnerStore()
    const bytes = Buffer.from("index preference")
    const first = await upload(store, bytes, "internal")
    const hash = store.hashKey("firmA", bytes)
    store.documents.set("doc_indexed", { ...store.documents.get(first.docId)!, id: "doc_indexed" })
    store.docsByHash.set(`${hash}|loose-vault`, "doc_indexed")
    const again = await upload(store, bytes, "internal")
    expect(again.docId).toBe("doc_indexed")
  })

  it("without a dedup index entry, no scan runs: the same bytes become a new document", async () => {
    const store = partnerStore()
    const bytes = Buffer.from("no index entry")
    const first = await upload(store, bytes, "internal")
    store.docsByHash.clear()
    const again = await upload(store, bytes, "internal")
    expect(again.reused).toBe(false)
    expect(again.docId).not.toBe(first.docId)
  })

  it("the scan fallback also works inside a matter", async () => {
    const store = partnerStore()
    store.matters.set("m_scan", { id: "m_scan", firmId: "firmA", classification: "internal" } as never)
    const bytes = Buffer.from("scan inside a matter")
    const call = (classification: "internal" | "privileged-restricted", callerClearance?: "internal") =>
      uploadDocument(store, {
        firmId: "firmA",
        matterId: "m_scan",
        bytes,
        sourceChannel: "web",
        classification,
        idempotencyKey: `fad16edg-1111-4000-8000-${String(++n).padStart(12, "0")}`,
        callerClearance,
        uploadedBy: "partner_a",
      })
    const restricted = await call("privileged-restricted")
    const low = await call("internal", "internal")
    const again = await call("internal", "internal")
    expect(low.docId).not.toBe(restricted.docId)
    expect(again).toEqual({ docId: low.docId, reused: true })
  })

  it("a stored label that cannot be read is left as stored (it already ranks as the strictest)", async () => {
    const store = partnerStore()
    const bytes = Buffer.from("unreadable stored label")
    const first = await upload(store, bytes, "internal")
    const doc = store.documents.get(first.docId)!
    doc.classification = "legacy-label" as never
    await upload(store, bytes, "privileged-restricted")
    expect(doc.classification).toBe("legacy-label")
  })

  it("raising one document's label leaves other documents' jobs alone", async () => {
    const store = partnerStore()
    const other = await upload(store, Buffer.from("other document"), "internal")
    const bytes = Buffer.from("reclassify me")
    const first = await upload(store, bytes, "internal")
    await upload(store, bytes, "confidential")
    const byDoc = Object.fromEntries(store.jobs.map((j) => [j.documentId, j.classification]))
    expect(byDoc[first.docId]).toBe("confidential")
    expect(byDoc[other.docId]).toBe("internal")
  })
})
