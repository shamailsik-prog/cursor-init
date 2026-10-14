/**
 * Re-audit R1-D1 (LOW): credential material must never reach an error message or a log.
 *
 * A CR/LF inside SIKANDER_R2_ACCESS_KEY_ID (or the region) used to pass the config check; the
 * signer then built an invalid Authorization header, `new Request()` threw a TypeError quoting it
 * ("Headers.set: "AWS4-HMAC-SHA256 Credential=AKID… Signature=…" is an invalid header value"),
 * the PUT path treated that as an ambiguous PUT and rethrew it, and the upload route logged it.
 * Now: every R2 setting must be printable ASCII (503 naming the variable, never its value), and
 * every R2 error is built from fixed text, the method, the object key, an HTTP status, an S3 error
 * code or a Node error code — never from an underlying message or header.
 */
import { randomBytes, randomUUID } from "node:crypto"
import { inspect } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "@/app/api/d1/documents/route"
import {
  assertDocumentObjectIngestAllowed,
  createR2DocumentObjectBackend,
  DocumentObjectConfigurationError,
  readR2DocumentObjectConfig,
  resetDocumentObjectStoreForTests,
  setDocumentObjectBackendForTests,
  type R2DocumentObjectBackendConfig,
} from "@/platform/documents/documentObjectStore"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { createFakeS3, type FakeS3 } from "@/tests/helpers/fakeS3"

// Canaries generated per run (never committed); each is unique enough to find anywhere.
const AKID_CANARY = `AKIDCANARY${randomBytes(6).toString("hex").toUpperCase()}`
const SECRET_CANARY = `SECRETCANARY${randomBytes(12).toString("hex")}`
const KEY = "firmA/documents/doc_canary/v1.enc"
const FORBIDDEN = [AKID_CANARY, SECRET_CANARY, "Signature=", "Credential=", "aws4_request", "AWS4-HMAC-SHA256"]

const env = process.env as Record<string, string | undefined>
const VARS = [
  "SIKANDER_DOCUMENT_OBJECT_BACKEND",
  "SIKANDER_DOCUMENT_OBJECT_ROOT",
  "SIKANDER_R2_ENDPOINT",
  "SIKANDER_R2_BUCKET",
  "SIKANDER_R2_ACCESS_KEY_ID",
  "SIKANDER_R2_SECRET_ACCESS_KEY",
  "SIKANDER_R2_REGION",
]
const VALID: Record<string, string> = {
  SIKANDER_R2_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
  SIKANDER_R2_BUCKET: "sikander-vault",
  SIKANDER_R2_ACCESS_KEY_ID: AKID_CANARY,
  SIKANDER_R2_SECRET_ACCESS_KEY: SECRET_CANARY,
  SIKANDER_R2_REGION: "auto",
}

let saved: Record<string, string | undefined>
let fake: FakeS3

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((n) => [n, env[n]]))
  fake = createFakeS3()
})

afterEach(() => {
  for (const [n, v] of Object.entries(saved)) {
    if (v === undefined) delete env[n]
    else env[n] = v
  }
  vi.restoreAllMocks()
  setDocumentObjectBackendForTests(null)
  resetRuntimeStoreForTests()
  resetDocumentObjectStoreForTests()
})

/** Everything an error carries when logged: message, stack, cause chain, own properties. */
function rendered(value: unknown): string {
  return inspect(value, { depth: 10, showHidden: true })
}

function expectNoCredentialMaterial(text: string) {
  for (const needle of FORBIDDEN) expect(text, `found ${needle}`).not.toContain(needle)
}

function backend(overrides: Partial<R2DocumentObjectBackendConfig> = {}) {
  return createR2DocumentObjectBackend({
    endpoint: "https://account-id.r2.example.test",
    bucket: "sikander-vault",
    accessKeyId: AKID_CANARY,
    secretAccessKey: SECRET_CANARY,
    region: "auto",
    fetchImpl: fake.fetchImpl,
    ...overrides,
  })
}

describe("R1-D1: R2 settings must be printable ASCII", () => {
  // Inside the value (trimming would remove it at either end).
  const insert = (value: string, bad: string) => {
    const at = Math.floor(value.length / 2)
    return `${value.slice(0, at)}${bad}${value.slice(at)}`
  }

  it.each(["SIKANDER_R2_ENDPOINT", "SIKANDER_R2_BUCKET", "SIKANDER_R2_ACCESS_KEY_ID", "SIKANDER_R2_SECRET_ACCESS_KEY", "SIKANDER_R2_REGION"])(
    "%s with CR, LF, a space, a tab, DEL or non-ASCII inside is refused by name, value never echoed",
    (name) => {
      for (const bad of ["\r", "\n", "\r\n", " ", "\t", "\x7f", "é"]) {
        const values = { ...VALID, [name]: insert(VALID[name], bad) }
        let message = ""
        try {
          readR2DocumentObjectConfig({ ...values } as NodeJS.ProcessEnv)
        } catch (err) {
          expect(err).toBeInstanceOf(DocumentObjectConfigurationError)
          message = (err as Error).message
        }
        expect(message, JSON.stringify(bad)).toBe(
          `${name} must be printable ASCII with no spaces or control characters`
        )
        expectNoCredentialMaterial(message)
        expect(message).not.toContain(values[name])
      }
    }
  )

  it("the upload route answers 503 for a CR/LF in the access key id, names it, and writes nothing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    Object.assign(env, VALID, {
      SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2",
      SIKANDER_R2_ACCESS_KEY_ID: `${AKID_CANARY}\r\nX-Injected: 1`,
    })
    expect(() => assertDocumentObjectIngestAllowed()).toThrow(DocumentObjectConfigurationError)
    const store = getRuntimeStore()
    const res = await POST(
      new Request("http://127.0.0.1/api/d1/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          action: "ingest",
          actorId: "partner_a",
          firmId: "firmA",
          contentBase64: Buffer.from("%PDF-crlf%").toString("base64"),
          sourceChannel: "web",
          classification: "internal",
        }),
      })
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("SIKANDER_R2_ACCESS_KEY_ID must be printable ASCII with no spaces or control characters")
    expect(store.documents.size).toBe(0)
    expect(store.jobs).toHaveLength(0)
    expectNoCredentialMaterial(JSON.stringify(body) + rendered(errorSpy.mock.calls))
  })
})

describe("R1-D1: no R2 error path carries the Authorization header, signature or scope", () => {
  it.each([
    ["an access key id", { accessKeyId: `${AKID_CANARY}\nX: y` }],
    ["a region", { region: "auto\r\nX: y" }],
  ] as const)("a signing failure caused by %s with CR/LF names the step only, sends nothing", async (_l, bad) => {
    const b = backend(bad)
    for (const call of [
      () => b.putIfAbsent(KEY, Buffer.from("payload")),
      () => b.get(KEY),
      () => b.delete(KEY),
    ]) {
      const err = await call().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/^R2 (PUT|GET|DELETE) firmA\/documents\/doc_canary\/v1\.enc failed: request signing failed$/)
      expect((err as Error).cause).toBeUndefined()
      expectNoCredentialMaterial(rendered(err))
    }
    // A signing failure is not an ambiguous PUT: nothing was sent, so nothing is read back.
    expect(fake.requests).toHaveLength(0)
  })

  it("a transport failure whose message quotes the request is reported by error code only", async () => {
    const leaky = async () => {
      const cause = Object.assign(new Error(`socket hang up near Credential=${AKID_CANARY}/20261014/auto/s3/aws4_request`), {
        code: "ECONNRESET",
      })
      throw new TypeError(`fetch failed: Authorization: AWS4-HMAC-SHA256 Credential=${AKID_CANARY} Signature=abc`, { cause })
    }
    const b = backend({ fetchImpl: leaky })
    const err = (await b.get(KEY).catch((e: unknown) => e)) as Error
    expect(err.message).toBe(`R2 GET ${KEY} failed: no response (ECONNRESET)`)
    expect(err.cause).toBeUndefined()
    expectNoCredentialMaterial(rendered(err))
  })

  it("a transport failure without a Node error code is reported by error class only", async () => {
    const b = backend({
      fetchImpl: async () => {
        throw new TypeError(`fetch failed Signature=${SECRET_CANARY}`)
      },
    })
    const err = (await b.get(KEY).catch((e: unknown) => e)) as Error
    expect(err.message).toBe(`R2 GET ${KEY} failed: no response (TypeError)`)
    expectNoCredentialMaterial(rendered(err))
  })

  it("a body that breaks off mid-read is reported by error kind only", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]))
            controller.error(Object.assign(new Error(`terminated Credential=${AKID_CANARY}`), { code: "UND_ERR_SOCKET" }))
          },
        }),
        { status: 200 }
      )
    fake.intercept((req) => (req.method === "GET" ? broken() : undefined))
    const err = (await backend().get(KEY).catch((e: unknown) => e)) as Error
    expect(err.message).toBe(`R2 GET ${KEY} failed: response body unreadable (UND_ERR_SOCKET)`)
    expectNoCredentialMaterial(rendered(err))
  })

  it("an error response whose body breaks off still reports the status", async () => {
    fake.intercept(() =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(`Signature=${SECRET_CANARY}`))
          },
        }),
        { status: 500 }
      )
    )
    for (const call of [() => backend().get(KEY), () => backend().delete(KEY), () => backend().putIfAbsent(KEY, Buffer.from("p"))]) {
      const err = (await call().catch((e: unknown) => e)) as Error
      expect(err.message).toMatch(/^R2 (GET|DELETE|PUT) firmA\/documents\/doc_canary\/v1\.enc failed: HTTP 500$/)
      expectNoCredentialMaterial(rendered(err))
    }
  })

  it("a 2xx or 404 whose body breaks off is decided by its status", async () => {
    const brokenBody = (status: number) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("broken"))
          },
        }),
        { status }
      )
    fake.intercept((req) => (req.method === "PUT" || req.method === "DELETE" ? brokenBody(200) : brokenBody(404)))
    const b = backend()
    await expect(b.putIfAbsent(KEY, Buffer.from("p"))).resolves.toBeUndefined()
    await expect(b.delete(KEY)).resolves.toBeUndefined()
    await expect(b.get(KEY)).rejects.toThrow(`document object not found: ${KEY}`)
  })

  describe("the reported failure kind is a Node error code or an error class name, nothing else", () => {
    async function kindOf(thrown: unknown): Promise<string> {
      const b = backend({
        fetchImpl: async () => {
          throw thrown
        },
      })
      const err = (await b.get(KEY).catch((e: unknown) => e)) as Error
      expect(err.name).toBe("R2TransportError")
      expectNoCredentialMaterial(rendered(err))
      return err.message.replace(`R2 GET ${KEY} failed: no response (`, "").replace(/\)$/, "")
    }

    it("prefers the cause's code, then the error's own code, then the class name", async () => {
      expect(await kindOf(Object.assign(new TypeError("x"), { code: "OWN_CODE", cause: { code: "CAUSE_CODE" } }))).toBe("CAUSE_CODE")
      expect(await kindOf(Object.assign(new TypeError("x"), { code: "OWN_CODE" }))).toBe("OWN_CODE")
      expect(await kindOf(new RangeError("x"))).toBe("RangeError")
    })

    it.each([
      ["a lower-case code", "not a code"],
      ["a code with a prefix", "xECONNRESET"],
      ["a code with a suffix", "ECONNRESET!"],
      ["a code quoting a credential", `Credential=${AKID_CANARY}`],
    ])("ignores %s", async (_label, code) => {
      expect(await kindOf(Object.assign(new TypeError("x"), { code, cause: { code } }))).toBe("TypeError")
    })

    it("ignores a code that is not a string, even one that prints like a code", async () => {
      const codeLike = { toString: () => "ECONNRESET" }
      expect(await kindOf(Object.assign(new TypeError("x"), { code: codeLike, cause: { code: codeLike } }))).toBe("TypeError")
    })

    it.each([
      ["an undefined throw", undefined],
      ["a null throw", null],
      ["a thrown string", `Signature=${SECRET_CANARY}`],
      ["a name with a leading digit", Object.assign(new Error("x"), { name: "1Bad" })],
      ["a name with a trailing symbol", Object.assign(new Error("x"), { name: "Bad!" })],
      ["a name quoting a credential", Object.assign(new Error("x"), { name: `Credential=${AKID_CANARY}` })],
      ["a name that is not a string", Object.assign(new Error("x"), { name: { toString: () => "Leaky" } })],
    ])("falls back to 'Error' for %s", async (_label, thrown) => {
      expect(await kindOf(thrown)).toBe("Error")
    })
  })

  it("responses whose status decides the outcome are still consumed", async () => {
    const withBody = (status: number) => new Response("body", { status })
    fake.intercept((req) => {
      if (req.method === "PUT" && req.headers["x-test"] === undefined && fake.requests.length === 1) return withBody(200)
      if (req.method === "PUT") return withBody(412)
      if (req.method === "DELETE") return withBody(200)
      return withBody(404)
    })
    const b = backend()
    await b.putIfAbsent(KEY, Buffer.from("p"))
    await b.putIfAbsent(KEY, Buffer.from("p")).catch(() => undefined)
    await b.delete(KEY)
    await b.get(KEY).catch(() => undefined)
    expect(fake.responses.map((r) => [r.status, r.bodyUsed])).toEqual([
      [200, true],
      [412, true],
      [200, true],
      [404, true],
    ])
  })

  it("an error body that echoes the string to sign yields the status and S3 code only", async () => {
    fake.intercept(() =>
      new Response(
        `<Error><Code>SignatureDoesNotMatch</Code><StringToSign>AWS4-HMAC-SHA256 Credential=${AKID_CANARY}/x/auto/s3/aws4_request</StringToSign></Error>`,
        { status: 403 }
      )
    )
    const err = (await backend().get(KEY).catch((e: unknown) => e)) as Error
    expect(err.message).toBe(`R2 GET ${KEY} failed: HTTP 403 SignatureDoesNotMatch`)
    expectNoCredentialMaterial(rendered(err))
  })

  it("through the upload route a forced signing failure leaves no credential in the response or the log", async () => {
    const lines: string[] = []
    for (const level of ["error", "warn", "log", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(rendered(args))
      })
    }
    setDocumentObjectBackendForTests(backend({ accessKeyId: `${AKID_CANARY}\nX: y` }))
    const store = getRuntimeStore()
    const res = await POST(
      new Request("http://127.0.0.1/api/d1/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          action: "ingest",
          actorId: "partner_a",
          firmId: "firmA",
          contentBase64: Buffer.from("%PDF-forced-sign-failure%").toString("base64"),
          sourceChannel: "web",
          classification: "internal",
        }),
      })
    )
    const text = await res.text()
    expect(res.status).toBe(400)
    expect(store.documents.size).toBe(0)
    expectNoCredentialMaterial(text + lines.join("\n"))
    expect(lines.join("\n")).toContain("request signing failed")
  })
})
