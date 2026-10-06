/**
 * The route boundary (platform/http/withSession.ts) and the client-facing
 * error helpers (errors.ts, publicError.ts), unit level with P5 session
 * resolution stubbed. Written against the surviving mutants of
 * `npm run mutation` (docs/audits/mutation-report.md): AuthError mapping and
 * message hygiene, the body read (empty / non-JSON / null / array bodies),
 * identity binding of body `userId`, insecure-dev identity claims, the
 * declared-surface refusal and the 500 log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { User } from "@/platform/spine/store"

const p5 = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  loadUserRecord: vi.fn(),
}))
vi.mock("@/platform/p5/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/p5/session")>()),
  resolveSession: p5.resolveSession,
  loadUserRecord: p5.loadUserRecord,
}))

import { AuthError } from "@/platform/p5/session"
import { withSession, type HandlerSession } from "@/platform/http/withSession"
import { readJsonLimited } from "@/platform/http/validation"
import { defineSurface } from "@/platform/http/surface"
import {
  INTERNAL_ERROR_CODE,
  REQUEST_FAILED_CODE,
  internalErrorResponse,
  publicErrorMessage,
} from "@/platform/http/errors"
import { PublicError } from "@/platform/http/publicError"

const SESSION = { mode: "firebase", userId: "u1", firmId: "firmA", role: "partner", clearance: "confidential" } as const
const URL_ = "http://127.0.0.1/api/x"

type Seen = { session: HandlerSession | null; url: string; text: string; json: unknown; jsonStatus?: number }

/** A handler that records what it was given (raw text, readJsonLimited result, session). */
function recorder() {
  const seen: Seen[] = []
  const handler = async (request: Request, session: HandlerSession | null) => {
    const clone = request.clone()
    const json = await readJsonLimited(request)
    seen.push({
      session,
      url: request.url,
      text: await clone.text(),
      json: json.ok ? json.data : undefined,
      jsonStatus: json.ok ? undefined : json.response.status,
    })
    return new Response("ok", { status: 200 })
  }
  return { seen, handler }
}

function post(body: BodyInit | null, url = URL_) {
  return new Request(url, { method: "POST", body, headers: { "content-type": "application/json" } })
}

let errorLog: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  p5.resolveSession.mockReset()
  p5.resolveSession.mockResolvedValue(SESSION)
  p5.loadUserRecord.mockReset()
  p5.loadUserRecord.mockResolvedValue(null)
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("AuthError mapping", () => {
  async function refusal(err: unknown) {
    p5.resolveSession.mockRejectedValue(err)
    const { seen, handler } = recorder()
    const res = await withSession(new Request(URL_), handler)
    expect(seen).toHaveLength(0)
    return { status: res.status, body: (await res.json()) as { error: string; code: string } }
  }

  it("passes a 4xx AuthError's code and message through, without logging", async () => {
    expect(await refusal(new AuthError(401, "AUTH_REQUIRED", "authentication required"))).toEqual({
      status: 401,
      body: { error: "authentication required", code: "AUTH_REQUIRED" },
    })
    expect(await refusal(new AuthError(499, "FIRM_MISMATCH", "firm scope mismatch"))).toEqual({
      status: 499,
      body: { error: "firm scope mismatch", code: "FIRM_MISMATCH" },
    })
    expect(errorLog).not.toHaveBeenCalled()
  })

  it("replaces a 5xx AuthError's message with 'auth not configured' and logs the detail", async () => {
    for (const status of [500, 503]) {
      errorLog.mockClear()
      expect(await refusal(new AuthError(status, "AUTH_MISCONFIGURED", "detail: NODE_ENV=production"))).toEqual({
        status,
        body: { error: "auth not configured", code: "AUTH_MISCONFIGURED" },
      })
      expect(errorLog).toHaveBeenCalledWith("[auth]", "detail: NODE_ENV=production")
    }
  })

  it("answers IDENTITY_UNAVAILABLE with its own public message", async () => {
    expect(await refusal(new AuthError(503, "IDENTITY_UNAVAILABLE", "x"))).toEqual({
      status: 503,
      body: { error: "identity service unavailable", code: "IDENTITY_UNAVAILABLE" },
    })
  })

  it("turns any other resolution failure into a generic 500", async () => {
    expect(await refusal(new Error("firestore exploded"))).toEqual({
      status: 500,
      body: { error: "internal error", code: INTERNAL_ERROR_CODE },
    })
  })
})

describe("body read and identity binding (firebase mode)", () => {
  it("hands HEAD and GET requests over without a body", async () => {
    for (const method of ["HEAD", "GET"]) {
      const { seen, handler } = recorder()
      const res = await withSession(new Request(URL_, { method }), handler)
      expect(res.status).toBe(200)
      expect(seen[0].session).toEqual(SESSION)
    }
  })

  it("an empty POST body is not JSON: readJsonLimited answers 400", async () => {
    const { seen, handler } = recorder()
    expect((await withSession(post(""), handler)).status).toBe(200)
    expect(seen[0].jsonStatus).toBe(400)
  })

  it("a non-JSON POST body reaches the handler unchanged and readJsonLimited answers 400", async () => {
    const { seen, handler } = recorder()
    expect((await withSession(post("actorId=u1&x"), handler)).status).toBe(200)
    expect(seen[0].text).toBe("actorId=u1&x")
    expect(seen[0].jsonStatus).toBe(400)
  })

  it("binds nothing in a JSON null, array or string body (and does not crash)", async () => {
    for (const body of ["null", '["u2"]', '"u2"']) {
      const { seen, handler } = recorder()
      expect((await withSession(post(body), handler)).status).toBe(200)
      expect(seen[0].json).toEqual(JSON.parse(body))
    }
  })

  it("hands the raw body text over untouched when no identity has to be injected", async () => {
    const raw = '{ "actorId": "u1",\n  "note": "kept as sent" }'
    const { seen, handler } = recorder()
    expect((await withSession(post(raw), handler)).status).toBe(200)
    expect(seen[0].text).toBe(raw)
  })

  it("accepts a body userId equal to the session user and injects actorId", async () => {
    const { seen, handler } = recorder()
    expect((await withSession(post(JSON.stringify({ userId: "u1" })), handler)).status).toBe(200)
    expect(seen[0].json).toEqual({ userId: "u1", actorId: "u1" })
  })

  it("treats null and empty identity fields as absent", async () => {
    const { seen, handler } = recorder()
    const res = await withSession(post(JSON.stringify({ actorId: null, userId: "", firmId: "" })), handler)
    expect(res.status).toBe(200)
    expect(seen[0].json).toMatchObject({ actorId: "u1" })
    const q = recorder()
    expect((await withSession(new Request(`${URL_}?actorId=&firmId=`), q.handler)).status).toBe(200)
    expect(new URL(q.seen[0].url).searchParams.get("actorId")).toBe("u1")
  })

  it("refuses a different body userId with 403 IDENTITY_MISMATCH and its message", async () => {
    const { seen, handler } = recorder()
    const res = await withSession(post(JSON.stringify({ userId: "u2" })), handler)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "request identity does not match the session", code: "IDENTITY_MISMATCH" })
    expect(seen).toHaveLength(0)
  })

  it("names reportedBodyLimit (not maxBodyBytes) in the 413", async () => {
    const { handler } = recorder()
    const res = await withSession(post("x".repeat(64)), handler, { maxBodyBytes: 16, reportedBodyLimit: 8 })
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe("upload exceeds the maximum size of 8 bytes")
  })

  it("refuses a query param the route surface does not declare (400 unknown_param)", async () => {
    const surface = defineSurface({
      views: [],
      actions: [],
      bodyFields: {},
      queryParams: ["actorId", "userId", "firmId"],
      headers: ["authorization", "x-firm-id"],
    })
    const { seen, handler } = recorder()
    const res = await withSession(new Request(`${URL_}?debug=1`), handler, { surface })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "unknown query parameter: debug", code: "unknown_param" })
    expect(seen).toHaveLength(0)
  })

  it("logs a handler crash with the method and path, and returns a generic 500", async () => {
    const res = await withSession(new Request(`${URL_}?q=1`, { method: "DELETE" }), () => {
      throw new Error("handler bug")
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal error", code: "INTERNAL_ERROR" })
    expect(errorLog).toHaveBeenCalledWith("[api] unhandled error in DELETE /api/x:", expect.any(Error))
  })
})

describe("insecure-dev mode (local and tests only)", () => {
  const record = (id: string): User => ({ id, firmId: "firmA", role: "clerk", clearanceLevel: "internal" })

  beforeEach(() => {
    p5.resolveSession.mockResolvedValue({ mode: "insecure-dev" })
    p5.loadUserRecord.mockImplementation(async (id: string) => (id.startsWith("u") ? record(id) : null))
  })

  async function claimed(request: Request): Promise<{ id: string | null; seen: Seen }> {
    const { seen, handler } = recorder()
    expect((await withSession(request, handler)).status).toBe(200)
    return { id: seen[0].session?.userId ?? null, seen: seen[0] }
  }

  it("takes the identity from query actorId, else query userId", async () => {
    expect((await claimed(new Request(`${URL_}?actorId=u1&userId=u2`))).id).toBe("u1")
    expect((await claimed(new Request(`${URL_}?userId=u2`))).id).toBe("u2")
  })

  it("takes the identity from body actorId, else body userId, when the query has none", async () => {
    expect((await claimed(post(JSON.stringify({ actorId: "u1", userId: "u2" })))).id).toBe("u1")
    expect((await claimed(post(JSON.stringify({ userId: "u2" })))).id).toBe("u2")
  })

  it("has no identity for a non-string, empty, array or absent claim", async () => {
    for (const body of [{ actorId: 7 }, { actorId: "" }, ["u1"], {}, null]) {
      expect((await claimed(post(JSON.stringify(body)))).id).toBeNull()
    }
    expect((await claimed(new Request(URL_))).id).toBeNull()
    expect(p5.loadUserRecord).not.toHaveBeenCalledWith(7)
  })

  it("hands the record over as an insecure-dev session, and the body unchanged", async () => {
    const { seen } = await claimed(post("actorId=u1 not json"))
    expect(seen.text).toBe("actorId=u1 not json")
    const json = await claimed(post(JSON.stringify({ actorId: "u3" })))
    expect(json.seen.session).toEqual({ userId: "u3", firmId: "firmA", role: "clerk", clearance: "internal", mode: "insecure-dev" })
  })
})

describe("error helpers", () => {
  it("passes only PublicError messages through and logs everything else", () => {
    const pub = new PublicError("permission denied: not-member", "FORBIDDEN")
    expect(pub).toMatchObject({ name: "PublicError", code: "FORBIDDEN" })
    expect(publicErrorMessage(pub, "request failed")).toBe("permission denied: not-member")
    expect(errorLog).not.toHaveBeenCalled()
    expect(publicErrorMessage(new Error("db password=x"), "request failed")).toBe("request failed")
    expect(errorLog).toHaveBeenCalledWith("[api] request failed:", expect.any(Error))
  })

  it("internalErrorResponse logs where it happened and returns the generic body", async () => {
    const res = internalErrorResponse(new Error("boom"), "GET /api/y")
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal error", code: "INTERNAL_ERROR" })
    expect(errorLog).toHaveBeenCalledWith("[api] unhandled error in GET /api/y:", expect.any(Error))
  })

  it("exports stable machine-readable codes", () => {
    expect(INTERNAL_ERROR_CODE).toBe("INTERNAL_ERROR")
    expect(REQUEST_FAILED_CODE).toBe("REQUEST_FAILED")
  })
})
