/**
 * Audit F03 / FA-D16-001: failure handling of the S3-compatible document vault, without MinIO.
 *
 * The fault proxy in tests/helpers/s3-document-vault.ts answers in place of the endpoint, so each
 * case runs in the plain unit suite: hostile error bodies, hangs, refused connections and
 * ambiguous PUTs. The real round trip against MinIO is tests/f03-document-object-store.s3.integration.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DocumentObjectConfigurationError,
  DocumentObjectStoreError,
  assertDocumentObjectIngestAllowed,
  buildDocumentStoragePath,
  getImmutableDocumentObject,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
} from "@/platform/documents/documentObjectStore"
import {
  DOCUMENT_OBJECT_S3_MAX_CALLS_PER_INGEST,
  DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_MAX_MS,
  DOCUMENT_OBJECT_S3_SETTLE_BUDGET_MAX_MS,
  DOCUMENT_OBJECT_S3_WORST_CASE_MS,
  documentObjectS3RequestTimeoutMs,
  documentObjectS3SettleBudgetMs,
  readS3Payload,
  writeS3Payload,
} from "@/platform/documents/documentObjectS3"
import { maxDuration } from "@/app/api/d1/documents/route"
import { newStore } from "@/platform/spine/store"
import { startS3FaultProxy, type FaultProxy } from "@/tests/helpers/s3-document-vault"

const S3_ENV = [
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
] as const
const saved = new Map<string, string | undefined>()
const ACCESS_KEY = "FAULTPROXYACCESSKEYID01"
const SECRET_KEY = "fault-proxy-secret-0123456789abcdefSECRET"

let proxy: FaultProxy

function useS3(endpoint: string, extra: Partial<Record<(typeof S3_ENV)[number], string>> = {}) {
  process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "s3"
  delete process.env.SIKANDER_DOCUMENT_OBJECT_ROOT
  process.env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT = endpoint
  process.env.SIKANDER_DOCUMENT_OBJECT_S3_BUCKET = "sikander-documents-faults"
  process.env.SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID = ACCESS_KEY
  process.env.SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY = SECRET_KEY
  process.env.SIKANDER_DOCUMENT_OBJECT_S3_FORCE_PATH_STYLE = "true"
  process.env.SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS = "300"
  process.env.SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS = "400"
  for (const [name, value] of Object.entries(extra)) process.env[name] = value
  resetDocumentObjectStoreForTests()
}

function putInput(docId: string, text = `bytes of ${docId}`) {
  const store = newStore()
  const bytes = Buffer.from(text)
  return { store, firmId: "firmA", docId, bytes, contentHash: store.hashKey("firmA", bytes), mimeType: "application/pdf" }
}

/** Everything console.error printed during `run`, flattened to text. */
async function capturedErrors(run: () => Promise<unknown>): Promise<{ text: string; error: unknown }> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {})
  let error: unknown
  try {
    await run()
  } catch (err) {
    error = err
  }
  const text = spy.mock.calls
    .map((args) => args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : String(a))).join(" "))
    .join("\n")
  spy.mockRestore()
  return { text, error }
}

function expectNoForeignText(text: string) {
  expect(text).not.toContain(ACCESS_KEY)
  expect(text).not.toContain(SECRET_KEY)
  expect(text).not.toMatch(/Credential=/)
  expect(text).not.toMatch(/Signature=/)
  expect(text).not.toMatch(/deadbeef/)
}

beforeAll(async () => {
  proxy = await startS3FaultProxy("http://127.0.0.1:9")
})

afterAll(async () => {
  await proxy.close()
})

beforeEach(() => {
  for (const name of S3_ENV) saved.set(name, process.env[name])
  proxy.setMode({ kind: "pass" })
  useS3(proxy.endpoint)
})

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  vi.unstubAllEnvs()
  resetDocumentObjectStoreForTests()
})

describe("F03 vault errors carry no endpoint text or credential material (owner review items 1-2)", () => {
  it("drops a key- or signature-shaped S3 error code and never echoes the endpoint's message", async () => {
    proxy.setMode({
      kind: "error",
      method: "PUT",
      status: 400,
      code: `Credential=${ACCESS_KEY}/20261018/auto/s3/aws4_request`,
      message: `Signature=deadbeef${SECRET_KEY}`,
    })
    const { text, error } = await capturedErrors(() => putImmutableDocumentObject(putInput("doc_hostile_code")))
    expect(error).toBeInstanceOf(DocumentObjectStoreError)
    const storeError = error as DocumentObjectStoreError
    expect(storeError.httpStatus).toBe(400)
    expect(storeError.s3Code).toBeNull()
    expect(storeError.message).toBe("document object store put failed: HTTP 400")
    expect("cause" in storeError).toBe(false)
    expectNoForeignText(`${storeError.message} ${storeError.stack} ${JSON.stringify(storeError)}`)
    expectNoForeignText(text)
  })

  it("echoes a well-formed S3 code, and only the code", async () => {
    proxy.setMode({ kind: "error", method: "GET", status: 403, code: "AccessDenied", message: `Signature=deadbeef ${SECRET_KEY}` })
    const path = buildDocumentStoragePath("firmA", "doc_denied", 1)
    const { text, error } = await capturedErrors(() =>
      getImmutableDocumentObject(newStore(), "firmA", path, "any-hash")
    )
    expect(error).toBeInstanceOf(DocumentObjectStoreError)
    expect((error as DocumentObjectStoreError).s3Code).toBe("AccessDenied")
    expect((error as Error).message).toBe("document object store get failed: HTTP 403 AccessDenied")
    expectNoForeignText(`${(error as Error).message} ${text}`)
  })

  it.each([
    ["a code with digits", "SignatureDoesNotMatch1"],
    ["a code with punctuation", "Access-Denied"],
    ["a lower-case code", "accessDenied"],
    ["a code longer than 64 characters", `A${"b".repeat(64)}`],
  ])("drops %s", async (_label, code) => {
    proxy.setMode({ kind: "error", method: "GET", status: 400, code, message: "x" })
    const error = await readS3Payload(buildDocumentStoragePath("firmA", "doc_code_shape", 1)).catch((err) => err)
    expect(error).toBeInstanceOf(DocumentObjectStoreError)
    expect((error as DocumentObjectStoreError).s3Code).toBeNull()
    expect((error as Error).message).toBe("document object store get failed: HTTP 400")
  })

  it("keeps a three-letter and a 64-letter code (the pattern's bounds)", async () => {
    for (const code of ["Abc", `A${"b".repeat(63)}`]) {
      proxy.setMode({ kind: "error", method: "GET", status: 400, code, message: "x" })
      const error = (await readS3Payload(buildDocumentStoragePath("firmA", "doc_code_bounds", 1)).catch(
        (err) => err
      )) as DocumentObjectStoreError
      expect(error.s3Code).toBe(code)
    }
  })

  it("maps 404 to not-found and 412 to an immutability conflict", async () => {
    proxy.setMode({ kind: "error", method: "GET", status: 404, code: "NoSuchKey", message: "x" })
    const path = buildDocumentStoragePath("firmA", "doc_missing", 1)
    await expect(readS3Payload(path)).rejects.toThrow(`document object not found: ${path}`)
    proxy.setMode({ kind: "error", method: "PUT", status: 412, code: "PreconditionFailed", message: "x" })
    await expect(writeS3Payload(path, Buffer.from("payload"))).rejects.toThrow(
      "document object already exists (immutable)"
    )
  })

  it.each([
    ["a line feed", "SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID", `${ACCESS_KEY}\nX-Injected: 1`],
    ["a carriage return", "SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY", `${SECRET_KEY}\r`],
    ["an inner space", "SIKANDER_DOCUMENT_OBJECT_S3_REGION", "auto x"],
    ["a non-ASCII byte", "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET", "bucketé"],
    ["a tab", "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT", "http://127.0.\t0.1:9"],
  ])("refuses a setting with %s, without printing its value", (_label, name, value) => {
    // trim() would remove a trailing CR, so put it in the middle as well.
    process.env[name] = value.endsWith("\r") ? `${value}x` : value
    resetDocumentObjectStoreForTests()
    let error: unknown
    try {
      assertDocumentObjectIngestAllowed()
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(DocumentObjectConfigurationError)
    expect((error as Error).message).toContain(name)
    expectNoForeignText((error as Error).message)
    expect((error as Error).message).not.toContain("X-Injected")
  })

  it.each([
    ["a path", "http://127.0.0.1:9/bucket"],
    ["credentials", "http://user:pass@127.0.0.1:9"],
    ["a query", "http://127.0.0.1:9/?x=1"],
    ["another scheme", "ftp://127.0.0.1:9"],
    ["no scheme", "127.0.0.1:9"],
  ])("refuses an endpoint with %s", (_label, endpoint) => {
    process.env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT = endpoint
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(DocumentObjectConfigurationError)
  })

  it("refuses a plain-http endpoint in production and accepts https", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(/must use https in production/)
    process.env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT = "https://account.r2.cloudflarestorage.com"
    expect(() => assertDocumentObjectIngestAllowed()).not.toThrow()
  })

  it.each([
    ["an upper-case bucket", "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET", "Bucket"],
    ["a one-letter bucket", "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET", "b"],
    ["an upper-case region", "SIKANDER_DOCUMENT_OBJECT_S3_REGION", "AUTO"],
    ["a timeout below the floor", "SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS", "49"],
    ["a timeout above the ceiling", "SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS", String(DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_MAX_MS + 1)],
    ["a fractional timeout", "SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS", "300.5"],
    ["a settle budget above the ceiling", "SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS", String(DOCUMENT_OBJECT_S3_SETTLE_BUDGET_MAX_MS + 1)],
    ["a negative settle budget", "SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS", "-1"],
  ])("refuses %s", (_label, name, value) => {
    process.env[name] = value
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(DocumentObjectConfigurationError)
  })

  it("accepts the bounds of the timeout and settle settings and defaults when unset", () => {
    process.env.SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS = "50"
    process.env.SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS = "0"
    expect(documentObjectS3RequestTimeoutMs()).toBe(50)
    expect(documentObjectS3SettleBudgetMs()).toBe(0)
    process.env.SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS = String(DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_MAX_MS)
    process.env.SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS = String(DOCUMENT_OBJECT_S3_SETTLE_BUDGET_MAX_MS)
    expect(documentObjectS3RequestTimeoutMs()).toBe(DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_MAX_MS)
    expect(documentObjectS3SettleBudgetMs()).toBe(DOCUMENT_OBJECT_S3_SETTLE_BUDGET_MAX_MS)
    delete process.env.SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS
    delete process.env.SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS
    expect(documentObjectS3RequestTimeoutMs()).toBe(5_000)
    expect(documentObjectS3SettleBudgetMs()).toBe(10_000)
  })
})

describe("F03 vault time budget (owner review item 4)", () => {
  it("declares a worst case below the upload route's maxDuration", () => {
    expect(DOCUMENT_OBJECT_S3_WORST_CASE_MS).toBe(
      DOCUMENT_OBJECT_S3_MAX_CALLS_PER_INGEST * DOCUMENT_OBJECT_S3_REQUEST_TIMEOUT_MAX_MS +
        DOCUMENT_OBJECT_S3_SETTLE_BUDGET_MAX_MS
    )
    expect(DOCUMENT_OBJECT_S3_WORST_CASE_MS).toBeLessThan(maxDuration * 1000)
  })

  it("a hanging endpoint fails the upload within one request timeout plus the settle budget", async () => {
    proxy.setMode({ kind: "hang" })
    const started = performance.now()
    const { text, error } = await capturedErrors(() => putImmutableDocumentObject(putInput("doc_hang")))
    const elapsed = performance.now() - started
    expect(error).toBeInstanceOf(DocumentObjectStoreError)
    expect((error as DocumentObjectStoreError).failure).toBe("timeout")
    expect((error as Error).message).toMatch(/put outcome unknown after 400 ms settle budget/)
    expect(text).toMatch(/ambiguous PUT did not settle.*key=firmA\/documents\/doc_hang\/v1/)
    // 300 ms PUT + 400 ms of settle reads; the rest is slack for a loaded machine.
    expect(elapsed).toBeGreaterThanOrEqual(650)
    expect(elapsed).toBeLessThan(5_000)
  })

  it("a hanging read fails within one request timeout", async () => {
    proxy.setMode({ kind: "hang" })
    const started = performance.now()
    const error = await getImmutableDocumentObject(
      newStore(),
      "firmA",
      buildDocumentStoragePath("firmA", "doc_hang_read", 1),
      "any-hash"
    ).catch((err) => err)
    const elapsed = performance.now() - started
    expect(error).toBeInstanceOf(DocumentObjectStoreError)
    expect((error as Error).message).toBe("document object store get failed: no response within 300 ms")
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(4_000)
  })

  it("a refused connection is a network error named by its socket code", async () => {
    useS3("http://127.0.0.1:9")
    const error = await readS3Payload(buildDocumentStoragePath("firmA", "doc_refused", 1)).catch((err) => err)
    expect(error).toBeInstanceOf(DocumentObjectStoreError)
    expect((error as DocumentObjectStoreError).failure).toBe("network")
    expect((error as Error).message).toMatch(/^document object store get failed: network error( E[A-Z0-9_]+)?$/)
  })
})

describe("F03 ambiguous PUT (owner review item 3)", () => {
  it("a 5xx PUT whose object never appears logs the key and fails after the settle budget", async () => {
    proxy.setMode({ kind: "error", method: "PUT", status: 503, code: "SlowDown", message: "x" })
    const { text, error } = await capturedErrors(() => putImmutableDocumentObject(putInput("doc_5xx")))
    expect(error).toBeInstanceOf(DocumentObjectStoreError)
    expect((error as DocumentObjectStoreError).httpStatus).toBe(503)
    expect((error as Error).message).toBe(
      "document object store put outcome unknown after 400 ms settle budget (document object store put failed: HTTP 503 SlowDown)"
    )
    expect(text).toContain("bucket=sikander-documents-faults key=firmA/documents/doc_5xx/v1")
    // The settle loop read the key more than once before giving up.
    const reads = proxy.seen.filter((r) => r.method === "GET" && r.path.includes("doc_5xx"))
    expect(reads.length).toBeGreaterThanOrEqual(2)
  })

  it("a 4xx PUT is a definite failure: no settle reads", async () => {
    proxy.setMode({ kind: "error", method: "PUT", status: 403, code: "AccessDenied", message: "x" })
    const before = proxy.seen.length
    await expect(writeS3Payload(buildDocumentStoragePath("firmA", "doc_4xx", 1), Buffer.from("p"))).rejects.toThrow(
      "document object store put failed: HTTP 403 AccessDenied"
    )
    // Filter by key: a settle read of the previous case can still be in flight.
    expect(proxy.seen.slice(before).filter((r) => r.path.includes("doc_4xx")).map((r) => r.method)).toEqual(["PUT"])
  })

  it("with a zero settle budget an ambiguous PUT fails at once and still names the key", async () => {
    useS3(proxy.endpoint, { SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS: "0" })
    proxy.setMode({ kind: "error", method: "PUT", status: 500, code: "InternalError", message: "x" })
    const before = proxy.seen.length
    const { text, error } = await capturedErrors(() =>
      writeS3Payload(buildDocumentStoragePath("firmA", "doc_zero_settle", 1), Buffer.from("p"))
    )
    expect((error as Error).message).toMatch(/outcome unknown after 0 ms settle budget/)
    expect(text).toContain("key=firmA/documents/doc_zero_settle/v1")
    expect(
      proxy.seen.slice(before).filter((r) => r.path.includes("doc_zero_settle")).map((r) => r.method)
    ).toEqual(["PUT"])
  })
})

describe("F03 production refuses a vault it cannot trust", () => {
  it("rejects an encryption key that is not exactly 64 hex characters, or one byte repeated", () => {
    const bad = [
      "a".repeat(63),
      "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00f",
      "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00zz",
      "0".repeat(64),
      "f".repeat(64),
      "F".repeat(64),
      "ab".repeat(32),
    ]
    for (const key of bad) {
      vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY", key)
      let error: unknown
      try {
        assertDocumentObjectIngestAllowed()
      } catch (err) {
        error = err
      }
      expect(error, key).toBeInstanceOf(DocumentObjectConfigurationError)
      expect((error as Error).message).not.toContain(key)
    }
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY", "A1B2C3D4E5F60718293A4B5C6D7E8F90112233445566778899AABBCCDDEEFF00")
    expect(() => assertDocumentObjectIngestAllowed()).not.toThrow()
  })
})
