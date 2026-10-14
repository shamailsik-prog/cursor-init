/**
 * FA-D16-001 (audit v2, HIGH): the document vault must live in Cloudflare R2, not on the
 * instance's local disk. Unit tests for the R2 backend (S3 API, AWS SigV4) against an in-process
 * fake endpoint. The real S3-compatible server run is fa-d16-001.document-vault-s3.e2e.test.ts.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createDocumentObjectStore,
  createFilesystemDocumentObjectBackend,
  createR2DocumentObjectBackend,
  DocumentObjectConfigurationError,
  DocumentObjectExistsError,
  DocumentObjectNotFoundError,
  DocumentObjectVerificationError,
  resetDocumentObjectStoreForTests,
  type R2DocumentObjectBackendConfig,
} from "@/platform/documents/documentObjectStore"
import { newStore } from "@/platform/spine/store"
import { createFakeS3, s3ErrorResponse, sha256Hex, verifySigV4, type FakeS3 } from "@/tests/helpers/fakeS3"

const ACCESS_KEY_ID = "FAKEACCESSKEYFAD16"
const SECRET = "fake-secret-for-unit-tests-only"
const KEY = "firmA/documents/doc_r2unit/v1.enc"

let fake: FakeS3

function config(overrides: Partial<R2DocumentObjectBackendConfig> = {}): R2DocumentObjectBackendConfig {
  return {
    endpoint: "https://account-id.r2.example.test",
    bucket: "sikander-vault",
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET,
    region: "auto",
    fetchImpl: fake.fetchImpl,
    // Ambiguous-PUT settling (R1-D2) re-reads for 2 × the timeout by default; keep it short here.
    settleWindowMs: 60,
    settleInitialDelayMs: 5,
    ...overrides,
  }
}

beforeEach(() => {
  fake = createFakeS3()
})

afterEach(() => {
  vi.useRealTimers()
  resetDocumentObjectStoreForTests()
})

describe("FA-D16-001: R2 backend wire format", () => {
  it("PUT is a SigV4-signed, conditional create carrying the payload's SHA-256", async () => {
    const backend = createR2DocumentObjectBackend(config())
    const payload = Buffer.from([1, 2, 3, 4, 5])
    await backend.putIfAbsent(KEY, payload)
    expect(fake.requests).toHaveLength(1)
    const [put] = fake.requests
    expect(put.method).toBe("PUT")
    expect(put.url).toBe(`https://account-id.r2.example.test/sikander-vault/${KEY}`)
    expect(put.headers["if-none-match"]).toBe("*")
    expect(put.headers["x-amz-content-sha256"]).toBe(sha256Hex(payload))
    expect(put.headers["content-type"]).toBe("application/octet-stream")
    expect(put.body.equals(payload)).toBe(true)
    const sig = verifySigV4(put, { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET, region: "auto" })
    expect(sig.ok).toBe(true)
    expect(sig.signedHeaders).toEqual(
      expect.arrayContaining(["host", "if-none-match", "x-amz-content-sha256", "x-amz-date"])
    )
    for (const value of Object.values(put.headers)) expect(value).not.toContain(SECRET)
    expect(backend.kind).toBe("r2")
    expect(backend.scheme).toBe("r2://")
  })

  it("signs for the configured region (credential scope) and the s3 service", async () => {
    const backend = createR2DocumentObjectBackend(config({ region: "us-east-1" }))
    await backend.putIfAbsent(KEY, Buffer.from("x"))
    const [put] = fake.requests
    expect(verifySigV4(put, { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET, region: "us-east-1" }).ok).toBe(true)
    expect(verifySigV4(put, { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET, region: "auto" }).ok).toBe(false)
    expect(put.headers.authorization).toMatch(/\/us-east-1\/s3\/aws4_request, /)
  })

  it("GET and DELETE are signed with the empty-payload hash", async () => {
    const backend = createR2DocumentObjectBackend(config())
    await backend.putIfAbsent(KEY, Buffer.from("payload"))
    await backend.get(KEY)
    await backend.delete(KEY)
    const [, get, del] = fake.requests
    for (const req of [get, del]) {
      expect(req.headers["x-amz-content-sha256"]).toBe(sha256Hex(""))
      expect(verifySigV4(req, { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET, region: "auto" }).ok).toBe(true)
      expect(req.headers["if-none-match"]).toBeUndefined()
      expect(req.body.length).toBe(0)
    }
    expect(get.method).toBe("GET")
    expect(del.method).toBe("DELETE")
    expect(get.headers["cache-control"]).toBe("no-cache")
  })

  it("hands fetch the body as bytes (a known Content-Length) and opts out of the Next.js fetch cache", async () => {
    // Regression: inside the Next.js runtime a Request object carrying the body was sent chunked
    // without Content-Length, and the S3 server answered 411 MissingContentLength.
    const backend = createR2DocumentObjectBackend(config())
    await backend.putIfAbsent(KEY, Buffer.from("sized body"))
    await backend.get(KEY)
    await backend.delete(KEY)
    expect(fake.requests.map((r) => [r.method, r.bodyKind, r.cache])).toEqual([
      ["PUT", "bytes", "no-store"],
      ["GET", "none", "no-store"],
      ["DELETE", "none", "no-store"],
    ])
  })

  it("ignores trailing slashes on the endpoint and percent-encodes the bucket and key segments", async () => {
    const backend = createR2DocumentObjectBackend(config({ endpoint: "http://127.0.0.1:9/// " }))
    await backend.putIfAbsent("firm_A-1/documents/doc_x-Y/v12.enc", Buffer.from("p"))
    expect(fake.requests[0].url).toBe("http://127.0.0.1:9/sikander-vault/firm_A-1/documents/doc_x-Y/v12.enc")
  })
})

describe("FA-D16-001: R2 backend status handling", () => {
  it("get returns the remote bytes", async () => {
    const backend = createR2DocumentObjectBackend(config())
    await backend.putIfAbsent(KEY, Buffer.from("remote bytes"))
    expect((await backend.get(KEY)).toString()).toBe("remote bytes")
  })

  it("a second create of the same key is refused (412) and does not change the stored object", async () => {
    const backend = createR2DocumentObjectBackend(config())
    await backend.putIfAbsent(KEY, Buffer.from("first"))
    const err = await backend.putIfAbsent(KEY, Buffer.from("second")).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DocumentObjectExistsError)
    expect((err as Error).message).toBe(`document object already exists (immutable): ${KEY}`)
    expect((await backend.get(KEY)).toString()).toBe("first")
  })

  it("a 409 conditional-write conflict is also refused as an existing object", async () => {
    fake.intercept((req) => (req.method === "PUT" ? s3ErrorResponse(409, "ConditionalRequestConflict") : undefined))
    const backend = createR2DocumentObjectBackend(config())
    await expect(backend.putIfAbsent(KEY, Buffer.from("x"))).rejects.toBeInstanceOf(DocumentObjectExistsError)
  })

  it("a missing object is DocumentObjectNotFoundError", async () => {
    const backend = createR2DocumentObjectBackend(config())
    const err = await backend.get(KEY).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DocumentObjectNotFoundError)
    expect((err as Error).message).toBe(`document object not found: ${KEY}`)
  })

  it.each([
    ["PUT", 500, "InternalError"],
    ["PUT", 403, "AccessDenied"],
    ["PUT", 400, "XAmzContentSHA256Mismatch"],
    ["GET", 500, "InternalError"],
    ["GET", 403, "AccessDenied"],
    ["DELETE", 500, "InternalError"],
    ["DELETE", 403, "AccessDenied"],
  ])("%s answered %i %s becomes an error naming the status and code, never the secret", async (method, status, code) => {
    fake.intercept((req) => (req.method === method ? s3ErrorResponse(status, code) : undefined))
    const backend = createR2DocumentObjectBackend(config())
    const call =
      method === "PUT"
        ? backend.putIfAbsent(KEY, Buffer.from("x"))
        : method === "GET"
          ? backend.get(KEY)
          : backend.delete(KEY)
    const err = (await call.catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(DocumentObjectExistsError)
    expect(err).not.toBeInstanceOf(DocumentObjectNotFoundError)
    expect(err.message).toBe(`R2 ${method} ${KEY} failed: HTTP ${status} ${code}`)
    expect(err.message).not.toContain(SECRET)
  })

  it("an error body without an S3 code still reports the status", async () => {
    fake.intercept(() => new Response("gateway exploded", { status: 502 }))
    const backend = createR2DocumentObjectBackend(config())
    await expect(backend.get(KEY)).rejects.toThrow(new Error(`R2 GET ${KEY} failed: HTTP 502`))
    await expect(backend.get(KEY)).rejects.not.toThrow(/exploded/)
  })

  it("DELETE of an absent object is not an error (204 or 404)", async () => {
    const backend = createR2DocumentObjectBackend(config())
    await expect(backend.delete(KEY)).resolves.toBeUndefined()
    fake.intercept((req) => (req.method === "DELETE" ? s3ErrorResponse(404, "NoSuchKey") : undefined))
    await expect(backend.delete(KEY)).resolves.toBeUndefined()
  })

  it("a request that hangs is aborted after the configured timeout", async () => {
    const hanging = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal!
        signal.addEventListener("abort", () => reject(signal.reason))
      })
    const backend = createR2DocumentObjectBackend(config({ fetchImpl: hanging, timeoutMs: 25 }))
    await expect(backend.get(KEY)).rejects.toThrow(`R2 GET ${KEY} timed out after 25 ms`)
  })

  it("a network failure is reported without the signed request", async () => {
    const failing = async () => {
      throw new TypeError("fetch failed")
    }
    const backend = createR2DocumentObjectBackend(config({ fetchImpl: failing }))
    const err = (await backend.get(KEY).catch((e: unknown) => e)) as Error
    expect(err.message).toBe(`R2 GET ${KEY} failed: no response (TypeError)`)
  })

  describe("an ambiguous PUT (no response: connection reset or timeout) is settled by reading the key", () => {
    // S3 servers may answer a refused conditional PUT early and reset the connection before the
    // client reads the 412 (seen with MinIO), and a PUT can also land before the connection
    // drops. The envelope's nonce is random, so identical stored bytes can only be this write.
    function resetOnPut(storeFirst: boolean) {
      fake.intercept((req) => {
        if (req.method !== "PUT") return undefined
        if (storeFirst) fake.objects.set(decodeURIComponent(req.path), req.body)
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) })
      })
    }

    it("the write landed: the PUT counts as done", async () => {
      resetOnPut(true)
      const backend = createR2DocumentObjectBackend(config())
      await expect(backend.putIfAbsent(KEY, Buffer.from("landed"))).resolves.toBeUndefined()
      expect(fake.requests.map((r) => r.method)).toEqual(["PUT", "GET"])
    })

    it("another object holds the key: refused as existing, never overwritten", async () => {
      const backend = createR2DocumentObjectBackend(config())
      await backend.putIfAbsent(KEY, Buffer.from("first"))
      resetOnPut(false)
      await expect(backend.putIfAbsent(KEY, Buffer.from("second"))).rejects.toBeInstanceOf(
        DocumentObjectExistsError
      )
      expect(fake.objects.get(`/sikander-vault/${KEY}`)?.toString()).toBe("first")
    })

    it("nothing is stored: the transport failure is reported", async () => {
      resetOnPut(false)
      const backend = createR2DocumentObjectBackend(config())
      await expect(backend.putIfAbsent(KEY, Buffer.from("lost"))).rejects.toThrow(
        `R2 PUT ${KEY} failed: no response (ECONNRESET)`
      )
    })

    it("the settling read fails too: the original transport failure is reported", async () => {
      resetOnPut(false)
      fake.intercept((req) => (req.method === "GET" ? s3ErrorResponse(500, "InternalError") : undefined))
      const backend = createR2DocumentObjectBackend(config())
      await expect(backend.putIfAbsent(KEY, Buffer.from("unknown"))).rejects.toThrow(
        `R2 PUT ${KEY} failed: no response (ECONNRESET)`
      )
    })

    it("an HTTP error status is definitive and is not settled by a read", async () => {
      fake.intercept((req) => (req.method === "PUT" ? s3ErrorResponse(503, "SlowDown") : undefined))
      const backend = createR2DocumentObjectBackend(config())
      await expect(backend.putIfAbsent(KEY, Buffer.from("x"))).rejects.toThrow(
        `R2 PUT ${KEY} failed: HTTP 503 SlowDown`
      )
      expect(fake.requests.map((r) => r.method)).toEqual(["PUT"])
    })
  })

  it("uses the global fetch and a 30 s timeout by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(new Uint8Array([7]), { status: 200 })
    })
    const backend = createR2DocumentObjectBackend({ ...config(), fetchImpl: undefined, timeoutMs: undefined })
    expect((await backend.get(KEY))[0]).toBe(7)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe("FA-D16-001: the encrypted store over R2", () => {
  function r2Store(bucket = "sikander-vault") {
    return createDocumentObjectStore(createR2DocumentObjectBackend(config({ bucket })))
  }

  it("R2 only ever receives the encrypted envelope, and the read-after-write GET hits the remote copy", async () => {
    const objects = r2Store()
    const store = newStore()
    const bytes = Buffer.from("PLAINTEXT-MARKER-FA-D16-001 privileged evidence")
    const result = await objects.put({
      store,
      firmId: "firmA",
      docId: "doc_r2env",
      bytes,
      contentHash: store.hashKey("firmA", bytes),
      mimeType: "application/pdf",
    })
    expect(result).toEqual({
      storagePath: "r2://firmA/documents/doc_r2env/v1",
      objectVersion: 1,
      byteSize: bytes.length,
      mimeType: "application/pdf",
    })
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "PUT /sikander-vault/firmA/documents/doc_r2env/v1.enc",
      "GET /sikander-vault/firmA/documents/doc_r2env/v1.enc",
    ])
    const remote = fake.objects.get("/sikander-vault/firmA/documents/doc_r2env/v1.enc")!
    expect(remote[0]).toBe(1)
    expect(remote.length).toBe(bytes.length + 29)
    expect(remote.includes(Buffer.from("PLAINTEXT-MARKER"))).toBe(false)
    for (const req of fake.requests) expect(req.body.includes(Buffer.from("PLAINTEXT-MARKER"))).toBe(false)
  })

  it("the envelope is identical across backends: an R2 object decrypts through the fs backend", async () => {
    const root = mkdtempSync(join(tmpdir(), "fa-d16-001-xbackend-"))
    try {
      const store = newStore()
      const bytes = Buffer.from("cross-backend envelope")
      const contentHash = store.hashKey("firmA", bytes)
      await r2Store().put({ store, firmId: "firmA", docId: "doc_x", bytes, contentHash, mimeType: "text/plain" })
      const remote = fake.objects.get("/sikander-vault/firmA/documents/doc_x/v1.enc")!
      const file = join(root, "firmA", "documents", "doc_x", "v1.enc")
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, remote)
      const fsStore = createDocumentObjectStore(createFilesystemDocumentObjectBackend(root))
      const back = await fsStore.get(store, "firmA", "fs://firmA/documents/doc_x/v1", contentHash)
      expect(back.equals(bytes)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a second, freshly constructed store reads the object (nothing is cached per instance)", async () => {
    const store = newStore()
    const bytes = Buffer.from("second instance")
    const contentHash = store.hashKey("firmA", bytes)
    const { storagePath } = await r2Store().put({
      store,
      firmId: "firmA",
      docId: "doc_second",
      bytes,
      contentHash,
      mimeType: "text/plain",
    })
    const before = fake.requests.length
    const back = await r2Store().get(store, "firmA", storagePath, contentHash)
    expect(back.equals(bytes)).toBe(true)
    expect(fake.requests.length).toBe(before + 1)
  })

  it("the storagePath does not name the bucket, so a restored copy in another bucket reads back", async () => {
    const store = newStore()
    const bytes = Buffer.from("restore into another bucket")
    const contentHash = store.hashKey("firmA", bytes)
    const { storagePath } = await r2Store("sikander-vault").put({
      store,
      firmId: "firmA",
      docId: "doc_restore",
      bytes,
      contentHash,
      mimeType: "text/plain",
    })
    for (const [path, body] of [...fake.objects]) {
      fake.objects.set(path.replace("/sikander-vault/", "/sikander-vault-restore/"), body)
    }
    const back = await r2Store("sikander-vault-restore").get(store, "firmA", storagePath, contentHash)
    expect(back.equals(bytes)).toBe(true)
  })

  it("a tampered remote object is refused on read", async () => {
    const store = newStore()
    const bytes = Buffer.from("tamper me remotely")
    const contentHash = store.hashKey("firmA", bytes)
    const { storagePath } = await r2Store().put({
      store,
      firmId: "firmA",
      docId: "doc_tamper",
      bytes,
      contentHash,
      mimeType: "text/plain",
    })
    const remote = fake.objects.get("/sikander-vault/firmA/documents/doc_tamper/v1.enc")!
    remote[20] ^= 0xff
    await expect(r2Store().get(store, "firmA", storagePath, contentHash)).rejects.toThrow(
      /unable to authenticate data/
    )
  })

  it("FA-D16-003 for R2: a read-back that does not verify deletes the remote object", async () => {
    fake.intercept((req) => {
      if (req.method !== "GET") return undefined
      const stored = fake.objects.get(decodeURIComponent(req.path))
      if (!stored) return undefined
      const corrupt = Buffer.from(stored)
      corrupt[corrupt.length - 1] ^= 0x01
      return new Response(new Uint8Array(corrupt), { status: 200 })
    })
    const store = newStore()
    const bytes = Buffer.from("verify fails on R2")
    const err = await r2Store()
      .put({
        store,
        firmId: "firmA",
        docId: "doc_r2verify",
        bytes,
        contentHash: store.hashKey("firmA", bytes),
        mimeType: "text/plain",
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DocumentObjectVerificationError)
    expect((err as DocumentObjectVerificationError).objectRemoved).toBe(true)
    expect(fake.requests.map((r) => r.method)).toEqual(["PUT", "GET", "DELETE"])
    expect(fake.objects.size).toBe(0)
  })

  it("an R2 store refuses fs:// paths, and an fs store refuses r2:// paths", async () => {
    const store = newStore()
    await expect(r2Store().get(store, "firmA", "fs://firmA/documents/doc_a/v1", "0".repeat(64))).rejects.toThrow(
      DocumentObjectConfigurationError
    )
    await expect(r2Store().get(store, "firmA", "fs://firmA/documents/doc_a/v1", "0".repeat(64))).rejects.toThrow(
      "document storagePath scheme fs:// does not match the configured document object backend (r2://)"
    )
    const root = mkdtempSync(join(tmpdir(), "fa-d16-001-scheme-"))
    try {
      const fsStore = createDocumentObjectStore(createFilesystemDocumentObjectBackend(root))
      await expect(fsStore.get(store, "firmA", "r2://firmA/documents/doc_a/v1", "0".repeat(64))).rejects.toThrow(
        "document storagePath scheme r2:// does not match the configured document object backend (fs://)"
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    expect(fake.requests).toHaveLength(0)
  })

  it("store.delete removes the object behind a storagePath", async () => {
    const objects = r2Store()
    const store = newStore()
    const bytes = Buffer.from("delete through the store")
    const { storagePath } = await objects.put({
      store,
      firmId: "firmA",
      docId: "doc_del",
      bytes,
      contentHash: store.hashKey("firmA", bytes),
      mimeType: "text/plain",
    })
    await objects.delete(storagePath)
    expect(fake.objects.size).toBe(0)
    expect(fake.requests.at(-1)?.method).toBe("DELETE")
  })
})
