/**
 * Audit F03 / FA-D16-002: the document vault's contract, pinned assertion by assertion, so a change
 * that drops a check fails here (stryker.documents.config.mjs holds the mutation floor at 85).
 *
 * The S3 half runs against the fault proxy's in-memory S3 (tests/helpers/s3-document-vault.ts), so
 * it needs no MinIO; the real-server round trip is tests/f03-document-object-store.s3.integration.test.ts.
 * Test keys are derived at run time (no key-shaped literals in the repository).
 */
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DocumentObjectConfigurationError,
  DocumentObjectStoreError,
  assertDocumentObjectIngestAllowed,
  backupDocumentObjectFile,
  buildDocumentStoragePath,
  decryptDocumentObjectPayload,
  deleteDocumentObject,
  filesystemPathForStoragePath,
  getImmutableDocumentObject,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
  resolveDocumentObjectBackendKind,
  restoreDocumentObjectFile,
  validateDocumentObjectIdentity,
  __testHookFailNextDocumentObjectDelete,
  __testHookFailNextDocumentObjectRead,
} from "@/platform/documents/documentObjectStore"
import {
  DocumentObjectAlreadyExistsError,
  documentObjectS3RequestTimeoutMs,
  isDocumentObjectS3Configured,
  readS3Payload,
  resetDocumentObjectS3ClientForTests,
  resolveDocumentObjectS3SseMode,
  s3ConfigFromEnv,
  toDocumentObjectStoreError,
  writeS3Payload,
} from "@/platform/documents/documentObjectS3"
import { newStore } from "@/platform/spine/store"
import { startS3FaultProxy, type FaultProxy } from "@/tests/helpers/s3-document-vault"

const VAULT_ENV = [
  "NODE_ENV",
  "VITEST",
  "SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY",
  "SIKANDER_DOCUMENT_OBJECT_BACKEND",
  "SIKANDER_DOCUMENT_OBJECT_ROOT",
  "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT",
  "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET",
  "SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID",
  "SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY",
  "SIKANDER_DOCUMENT_OBJECT_S3_REGION",
  "SIKANDER_DOCUMENT_OBJECT_S3_FORCE_PATH_STYLE",
  "SIKANDER_DOCUMENT_OBJECT_S3_SSE",
  "SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS",
  "SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS",
  "SIKANDER_MAX_UPLOAD_BYTES",
] as const
const saved = new Map<string, string | undefined>()
const BUCKET = "sikander-documents-contract"
const otherKey = createHash("sha256").update("f03 vault contract: a second key").digest("hex")

let proxy: FaultProxy
let root: string

function setEnv(values: Partial<Record<(typeof VAULT_ENV)[number], string | undefined>>) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  resetDocumentObjectStoreForTests()
}

function vaultOnS3(extra: Partial<Record<(typeof VAULT_ENV)[number], string | undefined>> = {}) {
  setEnv({
    SIKANDER_DOCUMENT_OBJECT_BACKEND: "s3",
    SIKANDER_DOCUMENT_OBJECT_ROOT: undefined,
    SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT: proxy.endpoint,
    SIKANDER_DOCUMENT_OBJECT_S3_BUCKET: BUCKET,
    SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID: "contract-access-id",
    SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY: "contract-secret",
    SIKANDER_DOCUMENT_OBJECT_S3_FORCE_PATH_STYLE: "true",
    SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS: "500",
    SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS: "1000",
    ...extra,
  })
  proxy.setMode({ kind: "memory-s3" })
}

/** All four S3 settings present, pointing nowhere (production paths that must refuse before any call). */
const productionS3 = {
  NODE_ENV: "production",
  SIKANDER_DOCUMENT_OBJECT_BACKEND: undefined,
  SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  SIKANDER_DOCUMENT_OBJECT_S3_BUCKET: BUCKET,
  SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID: "contract-access-id",
  SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY: "contract-secret",
}

function putInput(docId: string, text = `contract bytes ${docId}`) {
  const store = newStore()
  const bytes = Buffer.from(text)
  return { store, firmId: "firmA", docId, bytes, contentHash: store.hashKey("firmA", bytes), mimeType: "application/pdf" }
}

/** Requests for one doc id: a hang case can leave a request in flight that lands in the next case. */
function seenFor(docId: string) {
  return proxy.seen.filter((r) => r.path.includes(`/${docId}/`))
}

function puts(docId: string) {
  return seenFor(docId).filter((r) => r.method === "PUT")
}

beforeAll(async () => {
  proxy = await startS3FaultProxy("http://127.0.0.1:9")
})

afterAll(async () => {
  await proxy.close()
})

beforeEach(() => {
  for (const name of VAULT_ENV) saved.set(name, process.env[name])
  root = mkdtempSync(join(tmpdir(), "f03-contract-"))
  proxy.memory.clear()
  proxy.seen.length = 0
})

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  resetDocumentObjectStoreForTests()
})

describe("S3 vault contract (in-memory S3 behind the fault proxy)", () => {
  it("PUT is create-only, typed as opaque bytes, without an SSE header by default; GET returns the bytes", async () => {
    vaultOnS3()
    const input = putInput("doc_contract_roundtrip")
    const stored = await putImmutableDocumentObject(input)
    expect(stored).toEqual({
      storagePath: "s3://firmA/documents/doc_contract_roundtrip/v1",
      objectVersion: 1,
      byteSize: input.bytes.length,
      mimeType: "application/pdf",
    })
    const [put] = puts("doc_contract_roundtrip")
    expect(put.path.startsWith(`/${BUCKET}/firmA/documents/doc_contract_roundtrip/v1`)).toBe(true)
    expect(put.headers["if-none-match"]).toBe("*")
    expect(put.headers["content-type"]).toBe("application/octet-stream")
    expect(put.headers["x-amz-server-side-encryption"]).toBeUndefined()
    const held = proxy.memory.get(`/${BUCKET}/firmA/documents/doc_contract_roundtrip/v1`)!
    expect(decryptDocumentObjectPayload(held).equals(input.bytes)).toBe(true)
    const read = await getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)
    expect(read.equals(input.bytes)).toBe(true)
  })

  it("SIKANDER_DOCUMENT_OBJECT_S3_SSE=AES256 adds the SSE header; the r2 backend never sends it", async () => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_SSE: "AES256" })
    await putImmutableDocumentObject(putInput("doc_contract_sse"))
    expect(puts("doc_contract_sse").at(-1)!.headers["x-amz-server-side-encryption"]).toBe("AES256")
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_SSE: "AES256", SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2" })
    await putImmutableDocumentObject(putInput("doc_contract_r2"))
    expect(puts("doc_contract_r2").at(-1)!.headers["x-amz-server-side-encryption"]).toBeUndefined()
  })

  it("a second put to the key is refused with the immutability error, after exactly one PUT", async () => {
    vaultOnS3()
    const input = putInput("doc_contract_twice")
    await putImmutableDocumentObject(input)
    proxy.seen.length = 0
    await expect(putImmutableDocumentObject(input)).rejects.toThrow("document object already exists (immutable)")
    expect(puts("doc_contract_twice")).toHaveLength(1)
  })

  it("a stored object whose plaintext hash does not match is refused on read", async () => {
    vaultOnS3()
    const input = putInput("doc_contract_hash")
    const stored = await putImmutableDocumentObject(input)
    await expect(
      getImmutableDocumentObject(input.store, "firmA", stored.storagePath, "not-the-hash")
    ).rejects.toThrow("document object integrity check failed: content hash mismatch")
  })

  it("an ambiguous PUT that did land is recognised by its own bytes, with one PUT and no retry", async () => {
    vaultOnS3()
    proxy.setMode({ kind: "memory-s3", dropNextPutResponse: true })
    const input = putInput("doc_contract_landed")
    const stored = await putImmutableDocumentObject(input)
    expect(puts("doc_contract_landed")).toHaveLength(1)
    const read = await getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)
    expect(read.equals(input.bytes)).toBe(true)
  })

  it("a 5xx PUT is not retried by the SDK: one PUT, then settle reads only", async () => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS: "300" })
    proxy.setMode({ kind: "error", method: "PUT", status: 500, code: "InternalError", message: "x" })
    vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(putImmutableDocumentObject(putInput("doc_contract_no_retry"))).rejects.toThrow(/outcome unknown/)
    expect(puts("doc_contract_no_retry")).toHaveLength(1)
  })

  it("a best-effort delete that fails is logged with the key and does not throw", async () => {
    vaultOnS3()
    proxy.setMode({ kind: "error", method: "DELETE", status: 500, code: "InternalError", message: "x" })
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(deleteDocumentObject("s3://firmA/documents/doc_contract_del/v1")).resolves.toBeUndefined()
    expect(errors).toHaveBeenCalledWith(
      "[documentObjectStore] best-effort delete failed (document object store delete failed: HTTP 500 InternalError): key=firmA/documents/doc_contract_del/v1"
    )
  })

  it("a delete removes the object; a later read is not-found", async () => {
    vaultOnS3()
    const input = putInput("doc_contract_delete")
    const stored = await putImmutableDocumentObject(input)
    await deleteDocumentObject(stored.storagePath)
    expect(seenFor("doc_contract_delete").at(-1)!.method).toBe("DELETE")
    expect(proxy.memory.size).toBe(0)
    await expect(readS3Payload(stored.storagePath)).rejects.toThrow(`document object not found: ${stored.storagePath}`)
  })

  it("a failed verify read rolls back on S3 with a strict DELETE", async () => {
    vaultOnS3()
    __testHookFailNextDocumentObjectRead()
    await expect(putImmutableDocumentObject(putInput("doc_contract_rollback"))).rejects.toThrow("forced round-trip failure")
    expect(seenFor("doc_contract_rollback").map((r) => r.method)).toEqual(["PUT", "DELETE"])
    expect(proxy.memory.size).toBe(0)
  })

  it("backup and restore on S3: restore writes create-only, so a second restore is refused", async () => {
    vaultOnS3()
    const input = putInput("doc_contract_restore")
    const stored = await putImmutableDocumentObject(input)
    const backup = join(root, "deep", "er", "copy.enc")
    await backupDocumentObjectFile(stored.storagePath, backup)
    expect(readFileSync(backup).equals(proxy.memory.get(`/${BUCKET}/firmA/documents/doc_contract_restore/v1`)!)).toBe(true)
    proxy.memory.clear()
    await restoreDocumentObjectFile(stored.storagePath, backup)
    expect(puts("doc_contract_restore").at(-1)!.headers["if-none-match"]).toBe("*")
    const read = await getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)
    expect(read.equals(input.bytes)).toBe(true)
    await expect(restoreDocumentObjectFile(stored.storagePath, backup)).rejects.toThrow("document object already exists (immutable)")
  })

  it("refuses a declared body larger than the cap, and a streamed one", async () => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS: "5000" })
    const cap = 25 * 1024 * 1024 + 29
    proxy.setMode({ kind: "declare-huge-get", bytes: cap + 1 })
    await expect(readS3Payload("s3://firmA/documents/doc_contract_big/v1")).rejects.toThrow(
      "document object store get failed: object exceeds the size cap"
    )
    proxy.setMode({ kind: "stream-huge-get", bytes: cap + 1024 * 1024 })
    await expect(readS3Payload("s3://firmA/documents/doc_contract_big/v1")).rejects.toThrow(
      "document object store get failed: object exceeds the size cap"
    )
  })

  it("reads a body exactly at the cap's edge when the upload limit is raised above the default", async () => {
    vaultOnS3({ SIKANDER_MAX_UPLOAD_BYTES: String(26 * 1024 * 1024) })
    proxy.setMode({ kind: "declare-huge-get", bytes: 25 * 1024 * 1024 + 30 })
    // Under the raised cap the declared length is accepted; the body then fails as cut short.
    const error = (await readS3Payload("s3://firmA/documents/doc_contract_edge/v1").catch((e) => e)) as Error
    expect(error.message).not.toMatch(/size cap/)
  })

  it("serves an exact body back (no checksum headers) through the read path", async () => {
    vaultOnS3()
    proxy.setMode({ kind: "serve-get", body: Buffer.from("raw-bytes") })
    expect((await readS3Payload("s3://firmA/documents/doc_contract_serve/v1")).toString()).toBe("raw-bytes")
  })

  it("an s3:// path refuses to read when the backend is not S3", async () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "memory" })
    await expect(
      getImmutableDocumentObject(newStore(), "firmA", "s3://firmA/documents/doc_x/v1", "h")
    ).rejects.toThrow("document storage path uses s3:// but the active backend is not S3-compatible")
  })

  it("s3 paths are checked: a non-s3 scheme or a dot-dot key is refused", async () => {
    vaultOnS3()
    await expect(readS3Payload("fs://firmA/documents/doc_x/v1")).rejects.toThrow("document storagePath must use s3:// scheme")
    await expect(writeS3Payload("s3://", Buffer.from("x"))).rejects.toThrow("document object path failed safety validation")
    await expect(writeS3Payload("s3://firmA/../x/v1", Buffer.from("x"))).rejects.toThrow(
      "document object path failed safety validation"
    )
    expect(seenFor("doc_x")).toHaveLength(0)
  })
})

describe("S3 settings, exactly", () => {
  it("names every missing setting", () => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY: undefined })
    expect(() => s3ConfigFromEnv()).toThrow(
      "S3-compatible document storage requires SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT, SIKANDER_DOCUMENT_OBJECT_S3_BUCKET, " +
        "SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID and SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY"
    )
    for (const name of [
      "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT",
      "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET",
      "SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID",
    ] as const) {
      vaultOnS3({ [name]: undefined })
      expect(() => s3ConfigFromEnv(), name).toThrow(/requires SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT/)
    }
  })

  it("trims settings and defaults the region to auto", () => {
    vaultOnS3({
      SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT: `  ${proxy.endpoint}/  `,
      SIKANDER_DOCUMENT_OBJECT_S3_BUCKET: ` ${BUCKET} `,
      SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID: " id ",
      SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY: " secret ",
      SIKANDER_DOCUMENT_OBJECT_S3_FORCE_PATH_STYLE: " TRUE ",
    })
    expect(s3ConfigFromEnv()).toEqual({
      endpoint: proxy.endpoint,
      bucket: BUCKET,
      accessKeyId: "id",
      secretAccessKey: "secret",
      region: "auto",
      forcePathStyle: true,
    })
  })

  it.each([
    ["1", true],
    ["true", true],
    ["yes", false],
    ["0", false],
    [undefined, false],
  ])("SIKANDER_DOCUMENT_OBJECT_S3_FORCE_PATH_STYLE=%s means path style %s", (value, expected) => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_FORCE_PATH_STYLE: value })
    expect(s3ConfigFromEnv().forcePathStyle).toBe(expected)
  })

  it.each([
    ["an underscore", "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET", "bucket_name", "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET is not a valid bucket name"],
    ["a leading hyphen", "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET", "-bucket", "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET is not a valid bucket name"],
    ["a trailing bang", "SIKANDER_DOCUMENT_OBJECT_S3_REGION", "auto!", "SIKANDER_DOCUMENT_OBJECT_S3_REGION is not a valid region name"],
    ["a leading hyphen", "SIKANDER_DOCUMENT_OBJECT_S3_REGION", "-auto", "SIKANDER_DOCUMENT_OBJECT_S3_REGION is not a valid region name"],
    ["not a URL", "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT", "not-a-url", "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT must be an absolute http(s) URL"],
    ["another scheme", "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT", "ftp://127.0.0.1:9", "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT must be an absolute http(s) URL"],
    ["a password only", "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT", "http://:pw@127.0.0.1:9", "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT must be a bare origin (no credentials, path, query or fragment)"],
    ["a fragment", "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT", "http://127.0.0.1:9/#x", "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT must be a bare origin (no credentials, path, query or fragment)"],
    ["a user only", "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT", "http://u@127.0.0.1:9", "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT must be a bare origin (no credentials, path, query or fragment)"],
    ["an exponent", "SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS", "1e3", "SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS must be an integer from 50 to 8000"],
    ["a plus sign", "SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS", "+500", "SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS must be an integer from 50 to 8000"],
    ["seven digits", "SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS", "0000100", "SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS must be an integer from 0 to 12000"],
    ["an SSE value", "SIKANDER_DOCUMENT_OBJECT_S3_SSE", "aws:kms", "unsupported SIKANDER_DOCUMENT_OBJECT_S3_SSE value (expected none or AES256)"],
  ])("refuses %s in %s with an exact message", (_label, name, value, message) => {
    vaultOnS3({ [name]: value })
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(new DocumentObjectConfigurationError(message))
  })

  it("an SSE setting of exactly none is accepted", () => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_SSE: "none" })
    expect(() => assertDocumentObjectIngestAllowed()).not.toThrow()
  })

  it.each([
    "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT",
    "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET",
    "SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID",
    "SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY",
  ] as const)("a blank %s means S3 is not configured (no implicit S3 backend)", (name) => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_BACKEND: undefined, NODE_ENV: "development", VITEST: "false" })
    expect(resolveDocumentObjectBackendKind()).toBe("s3")
    setEnv({ [name]: "   " })
    expect(resolveDocumentObjectBackendKind()).toBe("memory")
  })
})

describe("backend choice", () => {
  beforeEach(() => {
    setEnv({
      NODE_ENV: "development",
      VITEST: "false",
      SIKANDER_DOCUMENT_OBJECT_BACKEND: undefined,
      SIKANDER_DOCUMENT_OBJECT_ROOT: undefined,
      SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT: undefined,
    })
  })

  it.each([
    ["s3", "s3"],
    ["R2", "s3"],
    [" fs ", "fs"],
    ["MEMORY", "memory"],
  ])("SIKANDER_DOCUMENT_OBJECT_BACKEND=%s selects %s", (value, kind) => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: value })
    expect(resolveDocumentObjectBackendKind()).toBe(kind)
  })

  it("refuses an unknown backend by name", () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "Disk" })
    expect(() => resolveDocumentObjectBackendKind()).toThrow(
      new DocumentObjectConfigurationError("unsupported SIKANDER_DOCUMENT_OBJECT_BACKEND value: disk")
    )
  })

  it("falls back: a root means fs; then the test runner means memory; then S3 settings mean s3; else memory", () => {
    expect(resolveDocumentObjectBackendKind()).toBe("memory")
    setEnv({ SIKANDER_DOCUMENT_OBJECT_ROOT: "   " })
    expect(resolveDocumentObjectBackendKind()).toBe("memory")
    setEnv({ SIKANDER_DOCUMENT_OBJECT_ROOT: root })
    expect(resolveDocumentObjectBackendKind()).toBe("fs")
    setEnv({ SIKANDER_DOCUMENT_OBJECT_ROOT: undefined, ...productionS3, NODE_ENV: "development" })
    expect(resolveDocumentObjectBackendKind()).toBe("s3")
    setEnv({ NODE_ENV: "test" })
    expect(resolveDocumentObjectBackendKind()).toBe("memory")
    setEnv({ NODE_ENV: "development", VITEST: "true" })
    expect(resolveDocumentObjectBackendKind()).toBe("memory")
  })

  it("production: s3 when configured, whatever else is set; refuses fs, memory and a missing S3 setup", () => {
    setEnv({ ...productionS3, SIKANDER_DOCUMENT_OBJECT_ROOT: root, VITEST: "true" })
    expect(resolveDocumentObjectBackendKind()).toBe("s3")
    for (const backend of ["fs", "memory"]) {
      setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: backend })
      expect(() => resolveDocumentObjectBackendKind(), backend).toThrow(
        new DocumentObjectConfigurationError(
          "production requires S3-compatible document object storage (R2); fs and memory backends are forbidden"
        )
      )
    }
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2", SIKANDER_DOCUMENT_OBJECT_S3_BUCKET: undefined })
    expect(() => resolveDocumentObjectBackendKind()).toThrow(
      new DocumentObjectConfigurationError(
        "production requires S3-compatible document object storage (configure Cloudflare R2 / S3 env vars)"
      )
    )
  })

  it("production refuses to read or delete an fs:// object even when a local root is set", async () => {
    writeFileSync(join(root, "probe.enc"), "x")
    setEnv({ ...productionS3, SIKANDER_DOCUMENT_OBJECT_ROOT: root })
    const fsPath = "fs://firmA/documents/doc_prod/v1"
    await expect(getImmutableDocumentObject(newStore(), "firmA", fsPath, "h")).rejects.toThrow(
      new DocumentObjectConfigurationError("production document object reads require s3:// storage paths")
    )
    await expect(deleteDocumentObject(fsPath)).rejects.toThrow(
      new DocumentObjectConfigurationError("production document object deletes require s3:// storage paths")
    )
  })

  it("an fs backend without a root refuses ingest, a blank root included", () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "fs", SIKANDER_DOCUMENT_OBJECT_ROOT: "  " })
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(
      new DocumentObjectConfigurationError("SIKANDER_DOCUMENT_OBJECT_ROOT is required before ingest is accepted")
    )
  })
})

describe("keys, identities and payload framing", () => {
  it("accepts a key with surrounding whitespace, and names a missing key", async () => {
    const valid = process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY!
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "memory", SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY: `  ${valid}  ` })
    const input = putInput("doc_key_trim")
    const stored = await putImmutableDocumentObject(input)
    expect((await getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)).equals(input.bytes)).toBe(true)
    setEnv({ SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY: undefined })
    await expect(putImmutableDocumentObject(putInput("doc_key_missing"))).rejects.toThrow(
      new DocumentObjectConfigurationError("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY is not set")
    )
    setEnv({ SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY: "   " })
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(
      new DocumentObjectConfigurationError("document object encryption key is required before ingest is accepted")
    )
  })

  it("names the two key faults exactly", () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "memory", SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY: `${otherKey}0` })
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(
      new DocumentObjectConfigurationError("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY must be 64 hex characters (32 bytes)")
    )
    setEnv({ SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY: "7".repeat(64) })
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(
      new DocumentObjectConfigurationError(
        "SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY must not be one byte repeated (all-zero, all-ff and the like)"
      )
    )
    // Two distinct bytes are enough to pass the repetition check.
    setEnv({ SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY: `${"7".repeat(62)}78` })
    expect(() => assertDocumentObjectIngestAllowed()).not.toThrow()
  })

  it.each([
    ["a firm with a dot-dot prefix", "../firmA", "doc_ok"],
    ["a doc with a slash suffix", "firmA", "doc_ok/.."],
    ["a doc with a space", "firmA", "doc ok"],
    ["an empty firm", "", "doc_ok"],
  ])("refuses %s", (_label, firmId, docId) => {
    expect(() => validateDocumentObjectIdentity(firmId, docId)).toThrow(
      "document object identity failed path safety validation"
    )
    expect(() => buildDocumentStoragePath(firmId, docId, 1)).toThrow("document object identity failed path safety validation")
  })

  it("frames payloads: 29 bytes is the shortest that is not truncated", () => {
    expect(() => decryptDocumentObjectPayload(Buffer.alloc(28, 1))).toThrow("document object payload is truncated")
    expect(() => decryptDocumentObjectPayload(Buffer.alloc(29, 1))).toThrow(/unable to authenticate data|Unsupported state/)
  })

  it("an object sealed under another key does not open", async () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "memory" })
    const input = putInput("doc_other_key")
    const stored = await putImmutableDocumentObject(input)
    // Set directly: setEnv would also reset (empty) the memory vault.
    process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = otherKey
    await expect(getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)).rejects.toThrow(
      /unable to authenticate data|Unsupported state/
    )
  })
})

describe("memory and filesystem vaults", () => {
  it("memory: write-once, not-found after reset, restore into an empty slot", async () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "memory" })
    const input = putInput("doc_mem")
    const stored = await putImmutableDocumentObject(input)
    await expect(putImmutableDocumentObject(input)).rejects.toThrow("document object already exists (immutable)")
    const backup = join(root, "mem.enc")
    await backupDocumentObjectFile(stored.storagePath, backup)
    resetDocumentObjectStoreForTests()
    await expect(getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)).rejects.toThrow(
      `document object not found: ${stored.storagePath}`
    )
    await restoreDocumentObjectFile(stored.storagePath, backup)
    expect((await getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)).equals(input.bytes)).toBe(true)
    await deleteDocumentObject(stored.storagePath)
    await expect(getImmutableDocumentObject(input.store, "firmA", stored.storagePath, input.contentHash)).rejects.toThrow(
      /not found/
    )
  })

  it("memory: a failed verify read rolls the object back", async () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "memory" })
    const input = putInput("doc_mem_rollback")
    __testHookFailNextDocumentObjectRead()
    await expect(putImmutableDocumentObject(input)).rejects.toThrow("forced round-trip failure")
    const again = await putImmutableDocumentObject(input)
    expect(again.storagePath).toBe("fs://firmA/documents/doc_mem_rollback/v1")
  })

  it("fs: hash mismatch on read, restore refuses to overwrite, paths are checked", async () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "fs", SIKANDER_DOCUMENT_OBJECT_ROOT: root })
    const input = putInput("doc_fs")
    const stored = await putImmutableDocumentObject(input)
    await expect(getImmutableDocumentObject(input.store, "firmA", stored.storagePath, "nope")).rejects.toThrow(
      "document object integrity check failed: content hash mismatch"
    )
    const backup = join(root, "x", "y", "z.enc")
    await backupDocumentObjectFile(stored.storagePath, backup)
    await expect(restoreDocumentObjectFile(stored.storagePath, backup)).rejects.toThrow(/EEXIST/)
    expect(filesystemPathForStoragePath("fs://firmA//documents/doc_fs/v1")).toBe(join(root, "firmA", "documents", "doc_fs", "v1.enc"))
    expect(() => filesystemPathForStoragePath("s3://firmA/documents/doc_fs/v1")).toThrow("document storagePath must use fs:// scheme")
    expect(() => filesystemPathForStoragePath("fs://firmA/../doc_fs/v1")).toThrow(
      "document object path segment failed safety validation"
    )
    setEnv({ SIKANDER_DOCUMENT_OBJECT_ROOT: undefined })
    expect(() => filesystemPathForStoragePath(stored.storagePath)).toThrow(
      new DocumentObjectConfigurationError("SIKANDER_DOCUMENT_OBJECT_ROOT is not set")
    )
  })

  it("an S3 read failure surfaces as DocumentObjectStoreError, not as the SDK's error", async () => {
    vaultOnS3()
    proxy.setMode({ kind: "error", method: "GET", status: 500, code: "InternalError", message: "endpoint text" })
    const error = await readS3Payload("s3://firmA/documents/doc_err/v1").catch((e) => e)
    expect(error).toBeInstanceOf(DocumentObjectStoreError)
    expect(error).toMatchObject({ operation: "get", failure: "http", httpStatus: 500, s3Code: "InternalError" })
  })
})

describe("error reduction (toDocumentObjectStoreError)", () => {
  const sdkError = (name: string, status: unknown, message = "endpoint text") =>
    Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } })

  it("passes a DocumentObjectStoreError through untouched", () => {
    const original = new DocumentObjectStoreError("get", "http", 404, "NoSuchKey", "kept")
    expect(toDocumentObjectStoreError("put", original, true, 1)).toBe(original)
  })

  it("an HTTP failure keeps status and a well-formed code only", () => {
    expect(toDocumentObjectStoreError("get", sdkError("NoSuchKey", 404), false, 300)).toMatchObject({
      operation: "get",
      failure: "http",
      httpStatus: 404,
      s3Code: "NoSuchKey",
      message: "document object store get failed: HTTP 404 NoSuchKey",
    })
    expect(toDocumentObjectStoreError("put", sdkError("Bad Code", 400), false, 300)).toMatchObject({
      s3Code: null,
      message: "document object store put failed: HTTP 400",
    })
    expect("cause" in toDocumentObjectStoreError("put", sdkError("Bad", 400), false, 300)).toBe(false)
  })

  it.each([99, 600, 404.5, "404", null, undefined])("a status of %s is no HTTP status: a network failure", (status) => {
    const reduced = toDocumentObjectStoreError("get", sdkError("NoSuchKey", status), false, 300)
    expect(reduced).toMatchObject({ failure: "network", httpStatus: null, s3Code: null })
    expect(reduced.message).toBe("document object store get failed: network error")
  })

  it("keeps the edge statuses 100 and 599", () => {
    expect(toDocumentObjectStoreError("get", sdkError("Abc", 100), false, 1).httpStatus).toBe(100)
    expect(toDocumentObjectStoreError("get", sdkError("Abc", 599), false, 1).httpStatus).toBe(599)
  })

  it("a deadline wins over anything the error says", () => {
    expect(toDocumentObjectStoreError("delete", sdkError("NoSuchKey", 404), true, 250)).toMatchObject({
      failure: "timeout",
      httpStatus: null,
      s3Code: null,
      message: "document object store delete failed: no response within 250 ms",
    })
  })

  it("names Node socket codes and drops anything else", () => {
    const socket = (code: unknown) => Object.assign(new Error("boom"), { code })
    expect(toDocumentObjectStoreError("get", socket("ECONNRESET"), false, 1)).toMatchObject({
      failure: "network",
      httpStatus: null,
      // The socket code is named in the message, never reported as an S3 code.
      s3Code: null,
      message: "document object store get failed: network error ECONNRESET",
    })
    for (const code of ["XECONNRESET", "ECONNRESET!", "EA", `E${"A".repeat(32)}`, 42, "econnreset"]) {
      expect(toDocumentObjectStoreError("get", socket(code), false, 1).message, String(code)).toBe(
        "document object store get failed: network error"
      )
    }
    expect(toDocumentObjectStoreError("get", null, false, 1).message).toBe("document object store get failed: network error")
    expect(toDocumentObjectStoreError("get", "a string", false, 1).failure).toBe("network")
  })

  it("the SDK's response checksum failure is an integrity failure", () => {
    const reduced = toDocumentObjectStoreError(
      "get",
      new Error('Checksum mismatch: expected "a" but received "b" in response header "x-amz-checksum-crc32".'),
      false,
      1
    )
    expect(reduced).toMatchObject({ failure: "integrity", httpStatus: null, s3Code: null })
    expect(reduced.message).toBe("document object store get failed: transport checksum mismatch")
    expect(toDocumentObjectStoreError("get", new Error("not a Checksum mismatch"), false, 1).failure).toBe("network")
  })
})

describe("S3 vault edges", () => {
  const CAP = 25 * 1024 * 1024 + 1 + 12 + 16

  it("the read cap is exactly the upload limit plus the 29-byte frame", async () => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS: "8000" })
    proxy.setMode({ kind: "stream-huge-get", bytes: CAP })
    expect((await readS3Payload("s3://firmA/documents/doc_cap/v1")).length).toBe(CAP)
    proxy.setMode({ kind: "stream-huge-get", bytes: CAP + 1 })
    await expect(readS3Payload("s3://firmA/documents/doc_cap/v1")).rejects.toMatchObject({
      operation: "get",
      failure: "http",
      httpStatus: 200,
      message: "document object store get failed: object exceeds the size cap",
    })
    proxy.setMode({ kind: "declare-huge-get", bytes: CAP + 1 })
    await expect(readS3Payload("s3://firmA/documents/doc_cap/v1")).rejects.toMatchObject({
      operation: "get",
      failure: "http",
      httpStatus: 200,
      message: "document object store get failed: object exceeds the size cap",
    })
    proxy.setMode({ kind: "declare-huge-get", bytes: CAP })
    const atCap = (await readS3Payload("s3://firmA/documents/doc_cap/v1").catch((e) => e)) as Error
    expect(atCap.message).not.toMatch(/size cap/)
  })

  it("a body that stalls is cut at the request deadline", async () => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS: "300" })
    proxy.setMode({ kind: "stall-body", bytes: 4096 })
    const started = performance.now()
    await expect(readS3Payload("s3://firmA/documents/doc_stall/v1")).rejects.toThrow(
      "document object store get failed: no response within 300 ms"
    )
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it("a hanging delete is cut at the deadline and, best effort, only logged", async () => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS: "200" })
    proxy.setMode({ kind: "hang" })
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(deleteDocumentObject("s3://firmA/documents/doc_hang_delete/v1")).resolves.toBeUndefined()
    expect(errors.mock.calls.flat().join(" ")).toContain("no response within 200 ms")
  })

  it("settle reads never outlast the settle budget, whatever the request timeout", async () => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS: "1500", SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS: "300" })
    proxy.setMode({ kind: "hang" })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const started = performance.now()
    const error = (await writeS3Payload("s3://firmA/documents/doc_budget/v1", Buffer.from("p")).catch((e) => e)) as DocumentObjectStoreError
    const elapsed = performance.now() - started
    expect(error.operation).toBe("put")
    expect(error.message).toBe(
      "document object store put outcome unknown after 300 ms settle budget (document object store put failed: no response within 1500 ms)"
    )
    // 1500 ms PUT + 300 ms settle; a read allowed its full 1500 ms would end past 3000 ms.
    expect(elapsed).toBeLessThan(2_900)
  })

  it("settle reads are spaced by the poll interval, not a busy loop", async () => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS: "600" })
    proxy.setMode({ kind: "error", method: "PUT", status: 503, code: "SlowDown", message: "x" })
    vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(writeS3Payload("s3://firmA/documents/doc_poll/v1", Buffer.from("p"))).rejects.toThrow(/outcome unknown/)
    const reads = seenFor("doc_poll").filter((r) => r.method === "GET").length
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(reads).toBeLessThanOrEqual(4)
  })

  it("a PUT that fails while someone else's bytes appear at the key is a conflict, named as such", async () => {
    vaultOnS3()
    proxy.setMode({ kind: "serve-get", body: Buffer.from("someone else") })
    const error = await writeS3Payload("s3://firmA/documents/doc_foreign/v1", Buffer.from("ours")).catch((e) => e)
    expect(error).toBeInstanceOf(DocumentObjectAlreadyExistsError)
    expect((error as Error).name).toBe("DocumentObjectAlreadyExistsError")
    expect(seenFor("doc_foreign").filter((r) => r.method === "GET")).toHaveLength(1)
  })

  it("a 4xx PUT fails at once with its own message and no settle read", async () => {
    vaultOnS3()
    proxy.setMode({ kind: "error", method: "PUT", status: 403, code: "AccessDenied", message: "x" })
    await expect(writeS3Payload("s3://firmA/documents/doc_403/v1", Buffer.from("p"))).rejects.toThrow(
      /^document object store put failed: HTTP 403 AccessDenied$/
    )
    expect(seenFor("doc_403").map((r) => r.method)).toEqual(["PUT"])
  })

  it("a strict rollback delete that fails is logged as such on S3", async () => {
    vaultOnS3()
    proxy.setMode({ kind: "memory-s3", failDelete: true })
    __testHookFailNextDocumentObjectRead()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(putImmutableDocumentObject(putInput("doc_strict_delete"))).rejects.toThrow("forced round-trip failure")
    expect(errors).toHaveBeenCalledWith("[documentObjectStore] rollback delete failed:", expect.any(DocumentObjectStoreError))
    const logged = errors.mock.calls[0][1] as DocumentObjectStoreError
    expect(logged.message).toBe("document object store delete failed: HTTP 500 InternalError")
  })

  it("SSE mode: trimmed, cached until reset, none when unset; r2 is recognised with spaces", () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "s3", SIKANDER_DOCUMENT_OBJECT_S3_SSE: " AES256 " })
    expect(resolveDocumentObjectS3SseMode()).toBe("AES256")
    process.env.SIKANDER_DOCUMENT_OBJECT_S3_SSE = "none"
    expect(resolveDocumentObjectS3SseMode()).toBe("AES256")
    resetDocumentObjectS3ClientForTests()
    expect(resolveDocumentObjectS3SseMode()).toBe("none")
    setEnv({ SIKANDER_DOCUMENT_OBJECT_S3_SSE: undefined })
    expect(resolveDocumentObjectS3SseMode()).toBe("none")
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: " R2 ", SIKANDER_DOCUMENT_OBJECT_S3_SSE: "AES256" })
    expect(resolveDocumentObjectS3SseMode()).toBe("none")
  })

  it("an empty optional setting is unset, and integer settings are trimmed", () => {
    vaultOnS3({ SIKANDER_DOCUMENT_OBJECT_S3_REGION: "", SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS: " 300 " })
    expect(s3ConfigFromEnv().region).toBe("auto")
    expect(documentObjectS3RequestTimeoutMs()).toBe(300)
  })

  it.each(["SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID", "SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY"] as const)(
    "an unset %s is simply 'not configured'",
    (name) => {
      vaultOnS3({ [name]: undefined })
      expect(isDocumentObjectS3Configured()).toBe(false)
    }
  )
})

describe("store hooks and filesystem edges", () => {
  it("the test hooks refuse production by name", () => {
    setEnv({ NODE_ENV: "production" })
    const message = "document object test hooks are not available when NODE_ENV=production"
    expect(() => __testHookFailNextDocumentObjectRead()).toThrow(new DocumentObjectConfigurationError(message))
    expect(() => __testHookFailNextDocumentObjectDelete()).toThrow(new DocumentObjectConfigurationError(message))
  })

  it("a forced delete failure is one shot: the next rollback deletes", async () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "fs", SIKANDER_DOCUMENT_OBJECT_ROOT: `  ${root}  ` })
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    __testHookFailNextDocumentObjectRead()
    __testHookFailNextDocumentObjectDelete()
    await expect(putImmutableDocumentObject(putInput("doc_hook_once"))).rejects.toThrow("forced round-trip failure")
    expect((errors.mock.calls[0][1] as Error).message).toBe("delete blocked for test")
    __testHookFailNextDocumentObjectRead()
    await expect(putImmutableDocumentObject(putInput("doc_hook_twice"))).rejects.toThrow("forced round-trip failure")
    expect(errors).toHaveBeenCalledTimes(1)
    // The padded root was trimmed: the first object (whose delete was blocked) is under it.
    expect(readFileSync(join(root, "firmA", "documents", "doc_hook_once", "v1.enc")).length).toBeGreaterThan(29)
  })
})
