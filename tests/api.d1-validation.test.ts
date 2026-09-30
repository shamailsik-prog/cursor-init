import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { POST as mattersPost } from "@/app/api/d1/matters/route"
import { POST as documentsPost } from "@/app/api/d1/documents/route"
import { POST as clientsPost } from "@/app/api/d1/clients/route"
import { POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import {
  DEFAULT_JSON_BODY_BYTES,
  DEFAULT_MAX_UPLOAD_BYTES,
  fingerprintOf,
  maxUploadBytes,
  maxUploadRequestBytes,
  readJsonLimited,
} from "@/platform/http/validation"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

afterEach(() => {
  vi.unstubAllEnvs()
  resetRuntimeStoreForTests()
})

type Handler = (request: Request) => Promise<Response>

function post(handler: Handler, path: string, body: unknown) {
  return handler(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify(body),
    })
  )
}

async function expectInvalid(res: Response) {
  expect(res.status).toBe(400)
  const json = (await res.json()) as { error: string; code: string }
  expect(json.code).toBe("invalid_request")
  expect(typeof json.error).toBe("string")
}

function seedMatter() {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Validation matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  return matter.id
}

const NON_OBJECT_BODIES: unknown[] = [null, [], "create", 42]

describe("M3 — zod request validation on d1 POST routes", () => {
  const routes: [string, Handler, unknown[]][] = [
    [
      "/api/d1/matters",
      mattersPost,
      [
        {},
        { action: "bogus", actorId: "partner_a" },
        { action: "create" },
        { action: "create", actorId: 1, firmId: "firmA", clientId: "c", title: "t", courtId: "SHC", classification: "internal" },
        { action: "create", actorId: "partner_a", firmId: "firmA", clientId: "c", title: "t", courtId: "SHC", classification: "secret" },
        { action: "create", actorId: "partner_a", firmId: "firmA", clientId: "c", title: "t", courtId: "SHC", classification: "internal", memberUserIds: "u1" },
        { action: "create", actorId: "partner_a", firmId: "firmA", clientId: "c", title: "x".repeat(5000), courtId: "SHC", classification: "internal" },
        { action: "confirm_engagement", actorId: "partner_a", matterId: "m", atMs: "soon" },
        { action: "record_case_number", actorId: "partner_a", matterId: "m", raw: { n: 1 }, courtId: "SHC" },
      ],
    ],
    [
      "/api/d1/documents",
      documentsPost,
      [
        {},
        { action: "delete" },
        { action: "ingest", actorId: "partner_a", firmId: "firmA", contentBase64: 42, sourceChannel: "web", classification: "internal" },
        { action: "ingest", actorId: "partner_a", firmId: "firmA", matterId: 7, contentBase64: "QUJD", sourceChannel: "web", classification: "internal" },
        { action: "ingest", actorId: "partner_a", firmId: "firmA", contentBase64: "QUJD", sourceChannel: "fax", classification: "internal" },
        { action: "ingest", actorId: "partner_a", firmId: "firmA", contentBase64: "not base64 !!", sourceChannel: "web", classification: "internal" },
      ],
    ],
    [
      "/api/d1/clients",
      clientsPost,
      [
        {},
        { action: "merge" },
        { action: "create", actorId: "partner_a", firmId: "firmA", canonicalName: {}, cnic: "1", phone: "2", classification: "internal" },
        { action: "create", actorId: "partner_a", firmId: "firmA", canonicalName: "A", cnic: "1", phone: "2", classification: 3 },
        { action: "conflict_check", actorId: "partner_a", firmId: "firmA", entityId: ["e1"] },
      ],
    ],
    [
      "/api/d1/document-workflow",
      workflowPost,
      [
        {},
        { action: "archive" },
        { action: "transition", actorId: "partner_a", documentId: "d1", nextStatus: "done" },
        { action: "assign_reviewer", actorId: "partner_a", documentId: "d1", reviewerId: 5 },
        { action: "review_decision", actorId: "partner_a", documentId: "d1", decision: "maybe" },
        { action: "review_decision", actorId: "partner_a", documentId: "d1", decision: "declassify", nextClassification: "top-secret" },
      ],
    ],
  ]

  for (const [path, handler, bodies] of routes) {
    describe(path, () => {
      it.each([...NON_OBJECT_BODIES, ...bodies].map((b) => [JSON.stringify(b).slice(0, 80), b]))(
        "rejects %s with 400 invalid_request",
        async (_label, body) => {
          await expectInvalid(await post(handler, path, body))
        }
      )
    })
  }
})

describe("M3 — document upload size limit", () => {
  it("defaults to 25 MB and honours SIKANDER_MAX_UPLOAD_BYTES", () => {
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024)
    vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", "")
    expect(maxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES)
    vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", "not-a-number")
    expect(maxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES)
    vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", "1024")
    expect(maxUploadBytes()).toBe(1024)
  })

  function ingest(bytes: Buffer, matterId: string) {
    return post(documentsPost, "/api/d1/documents", {
      action: "ingest",
      actorId: "partner_a",
      firmId: "firmA",
      matterId,
      contentBase64: bytes.toString("base64"),
      sourceChannel: "web",
      classification: "internal",
    })
  }

  it("rejects a decoded upload above the limit with 413 payload_too_large", async () => {
    vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", "16")
    const matterId = seedMatter()
    const res = await ingest(Buffer.alloc(17, 0x41), matterId)
    expect(res.status).toBe(413)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe("payload_too_large")
  })

  it("accepts an upload exactly at the limit", async () => {
    vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", "16")
    const matterId = seedMatter()
    const res = await ingest(Buffer.alloc(16, 0x42), matterId)
    expect(res.status).toBe(200)
  })

  it("rejects an oversize request by Content-Length before parsing", async () => {
    vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", "16")
    const res = await documentsPost(
      new Request("http://127.0.0.1/api/d1/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
          "Content-Length": String(10 * 1024 * 1024),
        },
        body: "{}",
      })
    )
    expect(res.status).toBe(413)
  })
})

function chunkedRequest(path: string, totalBytes: number) {
  const chunk = new TextEncoder().encode("a".repeat(64 * 1024))
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close()
        return
      }
      controller.enqueue(chunk)
      sent += chunk.length
    },
  })
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: stream,
    duplex: "half",
  } as RequestInit)
}

describe("review round 1 — streamed body limits (#2)", () => {
  it("documents: a chunked body with no Content-Length above the cap gets 413", async () => {
    vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", "16")
    const req = chunkedRequest("/api/d1/documents", 512 * 1024)
    expect(req.headers.get("content-length")).toBeNull()
    const res = await documentsPost(req)
    expect(res.status).toBe(413)
    expect(((await res.json()) as { code: string }).code).toBe("payload_too_large")
  })

  it("other d1 POSTs cap JSON bodies at 1 MB by default", async () => {
    expect(DEFAULT_JSON_BODY_BYTES).toBe(1024 * 1024)
    for (const [path, handler] of [
      ["/api/d1/matters", mattersPost],
      ["/api/d1/clients", clientsPost],
      ["/api/d1/document-workflow", workflowPost],
    ] as const) {
      const res = await handler(chunkedRequest(path, 2 * 1024 * 1024))
      expect(res.status, path).toBe(413)
    }
  })
})

describe("review round 1 — base64 normalisation (#11)", () => {
  it("accepts whitespace/newline-wrapped (MIME) base64 and stores the decoded bytes", async () => {
    const matterId = seedMatter()
    const content = Buffer.from("%PDF-wrapped-content-for-mime-test%").toString("base64")
    const wrapped = content.replace(/(.{8})/g, "$1\r\n ")
    const res = await post(documentsPost, "/api/d1/documents", {
      action: "ingest",
      actorId: "partner_a",
      firmId: "firmA",
      matterId,
      contentBase64: wrapped,
      sourceChannel: "whatsapp",
      classification: "internal",
    })
    expect(res.status).toBe(200)
  })

  it("rejects base64 whose length is 1 mod 4", async () => {
    await expectInvalid(
      await post(documentsPost, "/api/d1/documents", {
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        contentBase64: "QUJDR",
        sourceChannel: "web",
        classification: "internal",
      })
    )
  })
})

describe("review round 1 — idempotency fingerprint (#10)", () => {
  it("fingerprints are fixed-size sha256 digests, not the payload", () => {
    const big = { body: "x".repeat(100_000) }
    const fp = fingerprintOf(big)
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprintOf({ body: "x".repeat(100_000) })).toBe(fp)
    expect(fingerprintOf({ body: "y" })).not.toBe(fp)
  })
})

function streamRequest(chunks: Uint8Array[], error?: Error) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      if (error) controller.error(error)
      else controller.close()
    },
  })
  return new Request("http://127.0.0.1/x", { method: "POST", body, duplex: "half" } as RequestInit)
}

describe("review round 2 — readJsonLimited edges (N1)", () => {
  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ s: "é€" }))
    const split = bytes.indexOf(0xc3) + 1 // inside the 2-byte é
    const res = await readJsonLimited(streamRequest([bytes.slice(0, split), bytes.slice(split)]))
    expect(res.ok && res.data).toEqual({ s: "é€" })
  })

  it("strips a leading UTF-8 BOM", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf])
    const res = await readJsonLimited(streamRequest([bom, new TextEncoder().encode('{"a":1}')]))
    expect(res.ok && res.data).toEqual({ a: 1 })
  })

  it("an aborted body (stream error) is 400 invalid_request, not a throw", async () => {
    const res = await readJsonLimited(streamRequest([new TextEncoder().encode('{"a":')], new Error("aborted")))
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.response.status).toBe(400)
      expect(((await res.response.json()) as { code: string }).code).toBe("invalid_request")
    }
  })

  it("an aborted body on a route is 400", async () => {
    const req = new Request("http://127.0.0.1/api/d1/matters", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"action":'))
          c.error(new Error("client went away"))
        },
      }),
      duplex: "half",
    } as RequestInit)
    const res = await mattersPost(req)
    expect(res.status).toBe(400)
  })
})

describe("review round 2 — documents wire allowance (N2)", () => {
  it("allowance is ceil(cap*4/3*1.03) + 64KB", () => {
    vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", "3000000")
    expect(maxUploadRequestBytes()).toBe(Math.ceil(((3_000_000 * 4) / 3) * 1.03) + 64 * 1024)
  })

  it("accepts a line-wrapped base64 upload exactly at the decoded cap", async () => {
    const cap = 3 * 1024 * 1024
    vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", String(cap))
    const matterId = seedMatter()
    const bytes = Buffer.alloc(cap)
    for (let i = 0; i < cap; i++) bytes[i] = (i * 31 + 7) & 0xff
    const wrapped = bytes.toString("base64").replace(/(.{76})/g, "$1\n")
    const body = JSON.stringify({
      action: "ingest",
      actorId: "partner_a",
      firmId: "firmA",
      matterId,
      contentBase64: wrapped,
      sourceChannel: "bulk",
      classification: "internal",
    })
    // Old allowance (ceil(cap*4/3) + 64KB) is too small for this wire size.
    expect(body.length).toBeGreaterThan(Math.ceil((cap * 4) / 3) + 64 * 1024)
    const res = await documentsPost(
      new Request("http://127.0.0.1/api/d1/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body,
      })
    )
    expect(res.status).toBe(200)
  })
})
