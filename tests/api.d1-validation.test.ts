import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { POST as mattersPost } from "@/app/api/d1/matters/route"
import { POST as documentsPost } from "@/app/api/d1/documents/route"
import { POST as clientsPost } from "@/app/api/d1/clients/route"
import { POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import { DEFAULT_MAX_UPLOAD_BYTES, maxUploadBytes } from "@/platform/http/validation"
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
