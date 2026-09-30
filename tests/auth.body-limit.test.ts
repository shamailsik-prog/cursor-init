import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Integration of fix/auth (withSession identity binding) with fix/rules (streaming
// body caps): the session boundary must read the body once, under the route's cap,
// before binding identity, so a bearer of a valid token cannot make the server
// buffer an unbounded body.

const verifyIdToken = vi.fn()

vi.mock("firebase-admin/app", () => ({
  getApps: () => [],
  initializeApp: () => ({ name: "test-app" }),
  applicationDefault: () => ({}),
}))
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken }),
}))

import { POST as mattersPost } from "@/app/api/d1/matters/route"
import { POST as documentsPost } from "@/app/api/d1/documents/route"
import { withSession } from "@/platform/http/withSession"
import { DEFAULT_JSON_BODY_BYTES, readJsonLimited } from "@/platform/http/validation"
import { resetSessionStateForTests } from "@/platform/p5/session"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

function authedPost(url: string, body: BodyInit, extra: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer token-partner-a",
      "X-Firm-Id": "firmA",
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      ...extra,
    },
    body,
    // Node's fetch Request requires duplex for stream bodies.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit)
}

/** A chunked body (no Content-Length) that counts how many bytes were pulled. */
function countingStream(totalBytes: number, chunkBytes = 64 * 1024) {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close()
        return
      }
      const size = Math.min(chunkBytes, totalBytes - sent)
      sent += size
      controller.enqueue(new Uint8Array(size).fill(0x20))
    },
  })
  return { stream, pulled: () => sent }
}

beforeEach(() => {
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
  vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
  vi.stubEnv("FIREBASE_PROJECT_ID", "demo-sikander")
  verifyIdToken.mockReset()
  verifyIdToken.mockImplementation(async (token: string) => {
    if (token === "token-partner-a") return { uid: "partner_a", firmId: "firmA" }
    throw new Error("invalid token")
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
})

describe("session boundary enforces the d1 body caps (auth x rules)", () => {
  it("rejects a declared oversize JSON body with 413 before reading it", async () => {
    const body = JSON.stringify({ action: "create", title: "x".repeat(DEFAULT_JSON_BODY_BYTES) })
    const res = await mattersPost(
      authedPost("http://127.0.0.1/api/d1/matters", body, {
        "Content-Length": String(Buffer.byteLength(body)),
      })
    )
    expect(res.status).toBe(413)
    expect(((await res.json()) as { code: string }).code).toBe("payload_too_large")
    expect(getRuntimeStore().matters.size).toBe(0)
  })

  it("cuts off a chunked oversize body instead of buffering all of it", async () => {
    const { stream, pulled } = countingStream(8 * DEFAULT_JSON_BODY_BYTES)
    const res = await mattersPost(authedPost("http://127.0.0.1/api/d1/matters", stream))
    expect(res.status).toBe(413)
    expect(pulled()).toBeLessThan(2 * DEFAULT_JSON_BODY_BYTES)
  })

  it("still authenticates before touching the body (401 wins over 413)", async () => {
    const { stream, pulled } = countingStream(8 * DEFAULT_JSON_BODY_BYTES)
    const res = await mattersPost(
      authedPost("http://127.0.0.1/api/d1/matters", stream, { Authorization: "Bearer forged" })
    )
    expect(res.status).toBe(401)
    expect(pulled()).toBeLessThanOrEqual(64 * 1024)
  })

  it("uses the upload cap (not 1 MB) for documents ingest", async () => {
    vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", String(1024))
    const body = JSON.stringify({
      action: "ingest",
      firmId: "firmA",
      contentBase64: Buffer.alloc(4096, 1).toString("base64"),
      sourceChannel: "web",
      classification: "internal",
    })
    const res = await documentsPost(authedPost("http://127.0.0.1/api/d1/documents", body))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toContain("1024 bytes")
  })

  it("binds identity on the capped, parsed body and still validates it (400 with issues)", async () => {
    const res = await mattersPost(
      authedPost(
        "http://127.0.0.1/api/d1/matters",
        JSON.stringify({ action: "create", firmId: "firmA", title: 42 })
      )
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string; issues: { path: string }[] }
    expect(json.code).toBe("invalid_request")
    // actorId was injected from the session, so it is not among the issues.
    expect(json.issues.map((issue) => issue.path)).not.toContain("actorId")
  })

  it("rejects a body identity mismatch with 403 even when the body is within the cap", async () => {
    const res = await mattersPost(
      authedPost(
        "http://127.0.0.1/api/d1/matters",
        JSON.stringify({ action: "create", actorId: "associate_a", firmId: "firmA" })
      )
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("IDENTITY_MISMATCH")
  })

  it("hands the handler the already-parsed body (read once) with the injected actorId", async () => {
    let seen: unknown
    const res = await withSession(
      authedPost("http://127.0.0.1/api/x", JSON.stringify({ note: "hello" })),
      async (request) => {
        const raw = await readJsonLimited(request)
        if (!raw.ok) return raw.response
        seen = raw.data
        // The parse was handed over; the rebuilt body stream is left unread.
        expect(request.bodyUsed).toBe(false)
        return Response.json({ ok: true })
      },
      { maxBodyBytes: DEFAULT_JSON_BODY_BYTES }
    )
    expect(res.status).toBe(200)
    expect(seen).toEqual({ note: "hello", actorId: "partner_a" })
  })

  it("checks caps against the raw wire size, not the body after actorId fill-in", async () => {
    // Exactly DEFAULT_JSON_BODY_BYTES on the wire, with no actorId: filling actorId in
    // from the session grows the re-serialised body past the cap, which must not matter.
    const skeleton = JSON.stringify({ note: "" })
    const body = JSON.stringify({ note: "x".repeat(DEFAULT_JSON_BODY_BYTES - Buffer.byteLength(skeleton)) })
    expect(Buffer.byteLength(body)).toBe(DEFAULT_JSON_BODY_BYTES)
    let seen: Record<string, unknown> | undefined
    const res = await withSession(
      authedPost("http://127.0.0.1/api/x", body),
      async (request) => {
        const raw = await readJsonLimited(request)
        if (!raw.ok) return raw.response
        seen = raw.data as Record<string, unknown>
        return Response.json({ ok: true })
      },
      { maxBodyBytes: DEFAULT_JSON_BODY_BYTES }
    )
    expect(res.status).toBe(200)
    expect(seen?.actorId).toBe("partner_a")
    // One byte over on the wire is still refused.
    const over = await withSession(
      authedPost("http://127.0.0.1/api/x", body + " "),
      async () => Response.json({ ok: true }),
      { maxBodyBytes: DEFAULT_JSON_BODY_BYTES }
    )
    expect(over.status).toBe(413)
  })

  it("a d1 route accepts an at-cap body without actorId past the size check", async () => {
    const skeleton = JSON.stringify({ action: "create", firmId: "firmA", title: "" })
    const body = JSON.stringify({
      action: "create",
      firmId: "firmA",
      title: "x".repeat(DEFAULT_JSON_BODY_BYTES - Buffer.byteLength(skeleton)),
    })
    expect(Buffer.byteLength(body)).toBe(DEFAULT_JSON_BODY_BYTES)
    const res = await mattersPost(authedPost("http://127.0.0.1/api/d1/matters", body))
    // Reaches schema validation (title too long, fields missing), not a 413.
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("invalid_request")
  })

  it("a handler cap smaller than the boundary cap still applies to the handed-over body", async () => {
    const res = await withSession(
      authedPost("http://127.0.0.1/api/x", JSON.stringify({ note: "x".repeat(4096) })),
      async (request) => {
        const raw = await readJsonLimited(request, 1024)
        return raw.ok ? Response.json({ ok: true }) : raw.response
      }
    )
    expect(res.status).toBe(413)
  })
})

describe("insecure-dev also reads the body once under the cap", () => {
  it("returns 413 for an oversize body in insecure-dev mode", async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "insecure-dev")
    const { stream, pulled } = countingStream(8 * DEFAULT_JSON_BODY_BYTES)
    const res = await mattersPost(
      new Request("http://127.0.0.1/api/d1/matters", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: stream,
        duplex: "half",
      } as RequestInit)
    )
    expect(res.status).toBe(413)
    expect(pulled()).toBeLessThan(2 * DEFAULT_JSON_BODY_BYTES)
  })
})
