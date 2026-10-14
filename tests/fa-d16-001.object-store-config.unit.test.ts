/**
 * FA-D16-001 (audit v2, HIGH): the document vault backend is chosen by configuration and fails
 * closed, in the style of platform/persistence/runtimeRepositories.ts (F01):
 *
 *   SIKANDER_DOCUMENT_OBJECT_BACKEND=r2  requires SIKANDER_R2_ENDPOINT, SIKANDER_R2_BUCKET,
 *                                        SIKANDER_R2_ACCESS_KEY_ID, SIKANDER_R2_SECRET_ACCESS_KEY
 *                                        (and an https endpoint when NODE_ENV=production);
 *   SIKANDER_DOCUMENT_OBJECT_BACKEND=fs  requires SIKANDER_DOCUMENT_OBJECT_ROOT and is refused when
 *                                        NODE_ENV=production (per-instance, ephemeral disk);
 *   SIKANDER_DOCUMENT_OBJECT_BACKEND=memory is test-runner only;
 *   unset                                 production: refused; otherwise fs when a root is set,
 *                                        memory under the test runner, refused elsewhere.
 *
 * Upload acceptance (assertDocumentObjectIngestAllowed, called by POST /api/d1/documents before
 * any write) and every object read go through the same resolution, so a misconfigured process
 * refuses uploads with 503 instead of writing to the wrong place.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { POST } from "@/app/api/d1/documents/route"
import {
  assertDocumentObjectIngestAllowed,
  configuredDocumentObjectBackend,
  DocumentObjectConfigurationError,
  readR2DocumentObjectConfig,
  resetDocumentObjectStoreForTests,
} from "@/platform/documents/documentObjectStore"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

const MANAGED = [
  "NODE_ENV",
  "VITEST",
  "SIKANDER_DOCUMENT_OBJECT_BACKEND",
  "SIKANDER_DOCUMENT_OBJECT_ROOT",
  "SIKANDER_R2_ENDPOINT",
  "SIKANDER_R2_BUCKET",
  "SIKANDER_R2_ACCESS_KEY_ID",
  "SIKANDER_R2_SECRET_ACCESS_KEY",
  "SIKANDER_R2_REGION",
] as const

const env = process.env as Record<string, string | undefined>
let saved: Record<string, string | undefined>
let root: string

const R2_ENV = {
  SIKANDER_R2_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
  SIKANDER_R2_BUCKET: "sikander-vault",
  SIKANDER_R2_ACCESS_KEY_ID: "FAKEACCESSKEYFAD16",
  SIKANDER_R2_SECRET_ACCESS_KEY: "fake-secret-for-unit-tests-only",
}

function setEnv(values: Partial<Record<(typeof MANAGED)[number], string | undefined>>) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
}

beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((name) => [name, env[name]]))
  for (const name of MANAGED) if (name !== "NODE_ENV" && name !== "VITEST") delete env[name]
  root = mkdtempSync(join(tmpdir(), "fa-d16-001-config-"))
})

afterEach(() => {
  setEnv(saved)
  rmSync(root, { recursive: true, force: true })
  resetRuntimeStoreForTests()
  resetDocumentObjectStoreForTests()
})

function refusal(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(DocumentObjectConfigurationError)
    return (err as Error).message
  }
  throw new Error("expected a DocumentObjectConfigurationError")
}

describe("FA-D16-001: production refuses a non-durable vault", () => {
  it("production with no backend configured refuses uploads and names the r2 requirement", () => {
    setEnv({ NODE_ENV: "production" })
    const message = refusal(() => assertDocumentObjectIngestAllowed())
    expect(message).toMatch(/SIKANDER_DOCUMENT_OBJECT_BACKEND=r2/)
    expect(message).toMatch(/SIKANDER_DOCUMENT_OBJECT_ROOT/)
    expect(refusal(() => configuredDocumentObjectBackend())).toBe(message)
  })

  it("production refuses the fs:// backend even with a root configured (explicit or inferred)", () => {
    setEnv({ NODE_ENV: "production", SIKANDER_DOCUMENT_OBJECT_ROOT: root })
    expect(refusal(() => assertDocumentObjectIngestAllowed())).toMatch(/SIKANDER_DOCUMENT_OBJECT_BACKEND=r2/)
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "fs" })
    expect(refusal(() => assertDocumentObjectIngestAllowed())).toBe(
      "SIKANDER_DOCUMENT_OBJECT_BACKEND=fs stores documents on the instance's local disk, which is " +
        "per-instance and ephemeral; it is refused when NODE_ENV=production. Use " +
        "SIKANDER_DOCUMENT_OBJECT_BACKEND=r2."
    )
  })

  it("production refuses the memory backend", () => {
    setEnv({ NODE_ENV: "production", SIKANDER_DOCUMENT_OBJECT_BACKEND: "memory" })
    expect(refusal(() => assertDocumentObjectIngestAllowed())).toMatch(/memory.*test runner/)
  })

  it("production accepts r2 with complete credentials and an https endpoint", () => {
    setEnv({ NODE_ENV: "production", SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2", ...R2_ENV })
    expect(() => assertDocumentObjectIngestAllowed()).not.toThrow()
    const backend = configuredDocumentObjectBackend()
    expect(backend.kind).toBe("r2")
    expect(backend.scheme).toBe("r2://")
  })

  it("production refuses a plain-http r2 endpoint", () => {
    setEnv({
      NODE_ENV: "production",
      SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2",
      ...R2_ENV,
      SIKANDER_R2_ENDPOINT: "http://account-id.r2.cloudflarestorage.com",
    })
    expect(refusal(() => assertDocumentObjectIngestAllowed())).toBe(
      "SIKANDER_R2_ENDPOINT must use https when NODE_ENV=production"
    )
  })
})

describe("FA-D16-001: r2 without complete credentials is refused (any runtime)", () => {
  it.each([
    "SIKANDER_R2_ENDPOINT",
    "SIKANDER_R2_BUCKET",
    "SIKANDER_R2_ACCESS_KEY_ID",
    "SIKANDER_R2_SECRET_ACCESS_KEY",
  ] as const)("refuses when %s is missing or blank, naming the variable but no values", (missing) => {
    for (const nodeEnv of ["production", "development", "test"]) {
      setEnv({ NODE_ENV: nodeEnv, SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2", ...R2_ENV, [missing]: undefined })
      const message = refusal(() => assertDocumentObjectIngestAllowed())
      expect(message).toBe(`SIKANDER_DOCUMENT_OBJECT_BACKEND=r2 requires ${missing}`)
      setEnv({ [missing]: "   " })
      expect(refusal(() => configuredDocumentObjectBackend())).toBe(message)
    }
  })

  it("lists every missing variable at once", () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2" })
    expect(refusal(() => assertDocumentObjectIngestAllowed())).toBe(
      "SIKANDER_DOCUMENT_OBJECT_BACKEND=r2 requires SIKANDER_R2_ENDPOINT, SIKANDER_R2_BUCKET, " +
        "SIKANDER_R2_ACCESS_KEY_ID, SIKANDER_R2_SECRET_ACCESS_KEY"
    )
  })

  it.each([
    ["not a URL", "r2.cloudflarestorage.com", "SIKANDER_R2_ENDPOINT must be an http(s) URL with no path, query or credentials"],
    ["ftp scheme", "ftp://account-id.r2.cloudflarestorage.com", "SIKANDER_R2_ENDPOINT must be an http(s) URL with no path, query or credentials"],
    ["a path", "https://account-id.r2.cloudflarestorage.com/bucket", "SIKANDER_R2_ENDPOINT must be an http(s) URL with no path, query or credentials"],
    ["a query", "https://account-id.r2.cloudflarestorage.com?x=1", "SIKANDER_R2_ENDPOINT must be an http(s) URL with no path, query or credentials"],
    ["embedded credentials", "https://user:pw@account-id.r2.cloudflarestorage.com", "SIKANDER_R2_ENDPOINT must be an http(s) URL with no path, query or credentials"],
  ])("refuses an endpoint with %s", (_label, endpoint, expected) => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2", ...R2_ENV, SIKANDER_R2_ENDPOINT: endpoint })
    expect(refusal(() => assertDocumentObjectIngestAllowed())).toBe(expected)
  })

  it.each(["UPPER", "a", "bucket_with_underscore", "-leading", "trailing-", `${"b".repeat(64)}`])(
    "refuses the bucket name %s",
    (bucket) => {
      setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2", ...R2_ENV, SIKANDER_R2_BUCKET: bucket })
      expect(refusal(() => assertDocumentObjectIngestAllowed())).toBe(
        "SIKANDER_R2_BUCKET is not a valid bucket name"
      )
    }
  )

  it("reads the config, trimming values, with region auto unless SIKANDER_R2_REGION is set", () => {
    setEnv({
      SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2",
      SIKANDER_R2_ENDPOINT: ` ${R2_ENV.SIKANDER_R2_ENDPOINT}/ `,
      SIKANDER_R2_BUCKET: ` ${R2_ENV.SIKANDER_R2_BUCKET} `,
      SIKANDER_R2_ACCESS_KEY_ID: ` ${R2_ENV.SIKANDER_R2_ACCESS_KEY_ID} `,
      SIKANDER_R2_SECRET_ACCESS_KEY: ` ${R2_ENV.SIKANDER_R2_SECRET_ACCESS_KEY} `,
    })
    expect(readR2DocumentObjectConfig()).toEqual({
      endpoint: "https://account-id.r2.cloudflarestorage.com",
      bucket: "sikander-vault",
      accessKeyId: "FAKEACCESSKEYFAD16",
      secretAccessKey: "fake-secret-for-unit-tests-only",
      region: "auto",
    })
    setEnv({ SIKANDER_R2_REGION: " us-east-1 " })
    expect(readR2DocumentObjectConfig().region).toBe("us-east-1")
    setEnv({ SIKANDER_R2_REGION: "  " })
    expect(readR2DocumentObjectConfig().region).toBe("auto")
  })

  it("outside production a plain-http endpoint (a local S3 server) is allowed", () => {
    setEnv({
      NODE_ENV: "development",
      SIKANDER_DOCUMENT_OBJECT_BACKEND: "R2",
      ...R2_ENV,
      SIKANDER_R2_ENDPOINT: "http://127.0.0.1:9000",
    })
    expect(() => assertDocumentObjectIngestAllowed()).not.toThrow()
    expect(configuredDocumentObjectBackend().kind).toBe("r2")
  })
})

describe("FA-D16-001: dev and test backends", () => {
  it("fs requires a root", () => {
    setEnv({ NODE_ENV: "development", VITEST: "false", SIKANDER_DOCUMENT_OBJECT_BACKEND: "fs" })
    expect(refusal(() => assertDocumentObjectIngestAllowed())).toBe(
      "SIKANDER_DOCUMENT_OBJECT_BACKEND=fs requires SIKANDER_DOCUMENT_OBJECT_ROOT"
    )
    setEnv({ SIKANDER_DOCUMENT_OBJECT_ROOT: root })
    expect(configuredDocumentObjectBackend().kind).toBe("fs")
  })

  it("unset backend: fs when a root is set, memory under the test runner, refused otherwise", () => {
    setEnv({ NODE_ENV: "development", VITEST: "false", SIKANDER_DOCUMENT_OBJECT_ROOT: root })
    expect(configuredDocumentObjectBackend().kind).toBe("fs")
    setEnv({ SIKANDER_DOCUMENT_OBJECT_ROOT: undefined })
    expect(refusal(() => assertDocumentObjectIngestAllowed())).toBe(
      "SIKANDER_DOCUMENT_OBJECT_ROOT is required before ingest is accepted (or set " +
        "SIKANDER_DOCUMENT_OBJECT_BACKEND=r2); there is no silent in-memory document store " +
        "outside the test runner."
    )
    setEnv({ VITEST: "true" })
    expect(configuredDocumentObjectBackend().kind).toBe("memory")
    setEnv({ VITEST: "false", NODE_ENV: "test" })
    expect(configuredDocumentObjectBackend().kind).toBe("memory")
  })

  it("memory is refused outside the test runner even when asked for explicitly", () => {
    setEnv({ NODE_ENV: "development", VITEST: "false", SIKANDER_DOCUMENT_OBJECT_BACKEND: "memory" })
    expect(refusal(() => assertDocumentObjectIngestAllowed())).toBe(
      "SIKANDER_DOCUMENT_OBJECT_BACKEND=memory is non-durable and allowed only under the test runner"
    )
    setEnv({ VITEST: "true" })
    expect(configuredDocumentObjectBackend().kind).toBe("memory")
  })

  it("an unknown backend name is refused", () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "s3" })
    expect(refusal(() => assertDocumentObjectIngestAllowed())).toBe(
      'Unknown SIKANDER_DOCUMENT_OBJECT_BACKEND "s3"; expected "r2", "fs" or "memory".'
    )
  })

  it("the encryption key is checked first", () => {
    const savedKey = env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
    try {
      delete env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
      setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2" })
      expect(refusal(() => assertDocumentObjectIngestAllowed())).toBe(
        "document object encryption key is required before ingest is accepted"
      )
    } finally {
      env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = savedKey
    }
  })
})

describe("FA-D16-001: the upload route refuses before writing when r2 is misconfigured", () => {
  it("POST /api/d1/documents ingest answers 503 and stores nothing", async () => {
    setEnv({ SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2", ...R2_ENV, SIKANDER_R2_SECRET_ACCESS_KEY: undefined })
    const store = getRuntimeStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client_a",
      title: "FA-D16-001 config matter",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "partner_a", "firmA")
    const res = await POST(
      new Request("http://127.0.0.1/api/d1/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "fad16001-0000-4000-8000-000000000001",
        },
        body: JSON.stringify({
          action: "ingest",
          actorId: "partner_a",
          firmId: "firmA",
          matterId: matter.id,
          contentBase64: Buffer.from("%PDF-refused%").toString("base64"),
          sourceChannel: "web",
          classification: "internal",
        }),
      })
    )
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe(
      "SIKANDER_DOCUMENT_OBJECT_BACKEND=r2 requires SIKANDER_R2_SECRET_ACCESS_KEY"
    )
    expect(store.documents.size).toBe(0)
    expect(store.jobs).toHaveLength(0)
  })
})
