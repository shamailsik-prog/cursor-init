/**
 * Request validation, idempotency and declared-surface helpers
 * (platform/http/validation.ts, idempotency.ts, surface.ts), unit level.
 * Written against the surviving mutants of `npm run mutation`
 * (docs/audits/mutation-report.md): size caps at their boundaries, the body
 * stream error path, UUID v4 anchoring, replay-cache expiry and eviction
 * order, and the surface guards' refusals.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  base64DecodedLength,
  base64Field,
  maxUploadBytes,
  parseBody,
  readBodyLimited,
  readJsonLimited,
} from "@/platform/http/validation"
import {
  IdempotencyCache,
  IdempotencyConflictError,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import {
  SurfaceError,
  actionOf,
  bodyFieldsOf,
  defineSurface,
  getQuery,
  isAction,
  selectView,
  type RouteSurface,
} from "@/platform/http/surface"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("upload caps", () => {
  it("uses SIKANDER_MAX_UPLOAD_BYTES only when it is a positive safe integer", () => {
    vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", "100")
    expect(maxUploadBytes()).toBe(100)
    for (const bad of ["0", "-5", "1.5", "abc", ""]) {
      vi.stubEnv("SIKANDER_MAX_UPLOAD_BYTES", bad)
      expect(maxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES)
    }
  })

  it("computes the decoded length of padded and unpadded base64", () => {
    expect(base64DecodedLength("QUJD")).toBe(3)
    expect(base64DecodedLength("QUI=")).toBe(2)
    expect(base64DecodedLength("QQ==")).toBe(1)
  })
})

describe("readBodyLimited / readJsonLimited", () => {
  const body = (text: string, headers: Record<string, string> = {}) =>
    new Request("http://x/", { method: "POST", body: text, headers })

  it("accepts a body exactly at the cap, including a declared Content-Length at the cap", async () => {
    await expect(readBodyLimited(body("12345", { "content-length": "5" }), 5)).resolves.toEqual({
      ok: true,
      text: "12345",
      bytes: 5,
    })
  })

  it("refuses a declared Content-Length over the cap with 413 naming the reported limit", async () => {
    const r = await readBodyLimited(body("1", { "content-length": "6" }), 5, 4)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.response.status).toBe(413)
    expect(await r.response.json()).toEqual({ error: "upload exceeds the maximum size of 4 bytes", code: "payload_too_large" })
  })

  it("reads a request with no body as empty text", async () => {
    await expect(readBodyLimited(new Request("http://x/"), 5)).resolves.toEqual({ ok: true, text: "", bytes: 0 })
  })

  it("answers 400 when the body stream fails mid-read", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"))
        controller.error(new Error("client aborted"))
      },
    })
    const req = new Request("http://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit)
    const r = await readBodyLimited(req, 100)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.response.status).toBe(400)
    expect(await r.response.json()).toEqual({ error: "request body could not be read", code: "invalid_request" })
  })

  it("drops only a leading byte-order mark", async () => {
    const BOM = "\uFEFF"
    await expect(readBodyLimited(body(`${BOM}a${BOM}b`), 100)).resolves.toMatchObject({ text: `a${BOM}b` })
    await expect(readBodyLimited(body(`a${BOM}b`), 100)).resolves.toMatchObject({ text: `a${BOM}b` })
  })

  it("readJsonLimited: 413 over the cap, 400 on malformed JSON, the value otherwise", async () => {
    const big = await readJsonLimited(body('{"a":"0123456789"}'), 5)
    expect(big.ok ? 200 : big.response.status).toBe(413)
    const bad = await readJsonLimited(body("{nope"))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(await bad.response.json()).toEqual({ error: "invalid JSON body", code: "invalid_request" })
    await expect(readJsonLimited(body('{"a":1}'))).resolves.toEqual({ ok: true, data: { a: 1 } })
  })
})

describe("parseBody and shared fields", () => {
  it("reports each issue with a dotted path and its message", async () => {
    const schema = z.object({ a: z.object({ b: z.string() }) })
    const r = parseBody(schema, { a: { b: 1 } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.response.status).toBe(400)
    const json = (await r.response.json()) as { error: string; code: string; issues: { path: string; message: string }[] }
    expect(json.error).toBe("invalid request body")
    expect(json.code).toBe("invalid_request")
    expect(json.issues).toHaveLength(1)
    expect(json.issues[0].path).toBe("a.b")
    expect(json.issues[0].message).not.toBe("")
  })

  it("base64Field strips whitespace, and refuses non-base64 anywhere in the value", () => {
    expect(base64Field.parse("QU JD\r\nQUJD")).toBe("QUJDQUJD")
    for (const bad of ["!!QUJD", "QUJD!!", "QUJDQ"]) {
      const r = base64Field.safeParse(bad)
      expect(r.success).toBe(false)
      if (!r.success) expect(r.error.issues[0].message).toBe("must be base64")
    }
  })
})

describe("idempotency keys", () => {
  const KEY = "3b241101-e2bb-4255-8caf-4136c566a962"
  const req = (key?: string) => new Request("http://x/", { headers: key === undefined ? {} : { "Idempotency-Key": key } })

  it("accepts a UUID v4 in either case", () => {
    expect(requireIdempotencyKey(req(KEY))).toBe(KEY)
    expect(requireIdempotencyKey(req(KEY.toUpperCase()))).toBe(KEY.toUpperCase())
  })

  it("refuses a missing key and a key with anything around the UUID", () => {
    expect(() => requireIdempotencyKey(req())).toThrow(new IdempotencyError("Idempotency-Key header required"))
    for (const bad of [`x${KEY}`, `${KEY}x`, "3b241101-e2bb-1255-8caf-4136c566a962"]) {
      expect(() => requireIdempotencyKey(req(bad))).toThrow("Idempotency-Key must be UUID v4")
    }
  })

  it("errors carry their status, name and default message", () => {
    expect(new IdempotencyError()).toMatchObject({
      status: 400,
      name: "IdempotencyError",
      message: "Idempotency-Key header required",
    })
    expect(new IdempotencyConflictError()).toMatchObject({
      status: 409,
      name: "IdempotencyConflictError",
      message: "Idempotency-Key reused with a different request payload",
    })
  })
})

describe("IdempotencyCache", () => {
  it("expires an entry exactly at its TTL, in get and getReplay, and drops it", () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const cache = new IdempotencyCache<string>(100, 10)
    cache.set("a", "A", "fp")
    vi.setSystemTime(1_099)
    expect(cache.get("a")).toBe("A")
    expect(cache.getReplay("a", "fp")).toEqual({ body: "A", conflict: false })
    vi.setSystemTime(1_100)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.size).toBe(0)
    cache.set("b", "B", "fp")
    vi.setSystemTime(1_200)
    expect(cache.getReplay("b", "other")).toEqual({ conflict: false })
    expect(cache.size).toBe(0)
  })

  it("reports a conflict only for a different fingerprint, and a miss as no conflict", () => {
    const cache = new IdempotencyCache<string>(60_000, 10)
    expect(cache.getReplay("nope", "fp")).toEqual({ conflict: false })
    cache.set("a", "A", "fp1")
    expect(cache.getReplay("a", "fp2")).toEqual({ conflict: true })
    cache.set("b", "B")
    expect(cache.getReplay("b", "any")).toEqual({ body: "B", conflict: false })
  })

  it("prunes every expired entry on get, getReplay and set", () => {
    vi.useFakeTimers()
    const touches: [(c: IdempotencyCache<string>) => unknown, number][] = [
      [(c) => c.get("fresh"), 1],
      [(c) => c.getReplay("fresh", "fp"), 1],
      [(c) => c.set("new", "N"), 2],
    ]
    for (const [touch, sizeAfter] of touches) {
      vi.setSystemTime(0)
      const cache = new IdempotencyCache<string>(100, 10)
      cache.set("old1", "1")
      cache.set("old2", "2")
      vi.setSystemTime(150)
      cache.set("fresh", "F")
      expect(cache.size).toBe(1)
      vi.setSystemTime(0)
      cache.set("old3", "3")
      vi.setSystemTime(200)
      expect(cache.size).toBe(2)
      touch(cache)
      expect(cache.size).toBe(sizeAfter)
    }
  })

  it("prune() alone removes expired entries", () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const cache = new IdempotencyCache<string>(100, 10)
    cache.set("a", "A")
    vi.setSystemTime(100)
    cache.prune()
    expect(cache.size).toBe(0)
  })

  it("keeps exactly maxEntries and evicts the oldest by write time, not insertion order", () => {
    vi.useFakeTimers()
    const cache = new IdempotencyCache<string>(60_000, 2)
    vi.setSystemTime(1)
    cache.set("a", "A")
    vi.setSystemTime(2)
    cache.set("b", "B")
    expect(cache.size).toBe(2)
    vi.setSystemTime(3)
    cache.set("a", "A2") // rewritten: now the newest, still first in insertion order
    vi.setSystemTime(4)
    cache.set("c", "C")
    expect(cache.size).toBe(2)
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("a")).toBe("A2")
    expect(cache.get("c")).toBe("C")
  })
})

describe("route surface", () => {
  const surface = defineSurface({
    views: ["list", "detail"],
    defaultView: "list",
    actions: ["create"],
    bodyFields: { create: ["action", "title"] },
    queryParams: ["view", "actorId"],
    headers: ["authorization"],
  } satisfies RouteSurface)

  it("defineSurface refuses an inconsistent surface with a SurfaceError naming the problem", () => {
    const base = { views: [], actions: [], bodyFields: {}, queryParams: [], headers: [] }
    const refuse = (s: RouteSurface, message: string) => {
      let err: unknown
      try {
        defineSurface(s)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(SurfaceError)
      expect(err).toMatchObject({ name: "SurfaceError", message })
    }
    refuse({ ...base, actions: ["a"] }, "bodyFields must list exactly the declared actions")
    refuse({ ...base, views: ["v"], defaultView: "w", queryParams: ["view"] }, "defaultView w is not a declared view")
    refuse({ ...base, views: ["v"] }, 'views need the "view" query param declared')
  })

  it("bodyFieldsOf reads literal actions, multi-value literals, and a bare `value`", () => {
    const schema = z.discriminatedUnion("action", [
      z.object({ action: z.literal("create"), title: z.string() }),
      z.object({ action: z.literal(["close", "archive"]), id: z.string() }),
    ])
    expect(bodyFieldsOf(schema)).toEqual({
      create: ["action", "title"],
      close: ["action", "id"],
      archive: ["action", "id"],
    })
    const bare = { options: [{ shape: { action: { value: "legacy" }, x: 1 } }] } as unknown as z.ZodType
    expect(bodyFieldsOf(bare)).toEqual({ legacy: ["action", "x"] })
  })

  it("getQuery and isAction refuse undeclared keys, naming them", () => {
    expect(() => getQuery(surface, new URL("http://x/?debug=1"), "debug")).toThrow('query param "debug" is not declared')
    expect(() => isAction(surface, { action: "create" }, "delete")).toThrow('action "delete" is not declared')
    expect(isAction(surface, { action: "create" }, "create")).toBe(true)
  })

  it("selectView: default when absent or empty, the declared value, undefined when undeclared", () => {
    expect(selectView(surface, new URL("http://x/"))).toBe("list")
    expect(selectView(surface, new URL("http://x/?view="))).toBe("list")
    expect(selectView(surface, new URL("http://x/?view=detail"))).toBe("detail")
    expect(selectView(surface, new URL("http://x/?view=admin"))).toBeUndefined()
  })

  it("actionOf: null when absent or empty, the declared action, undefined when undeclared or not a string", () => {
    for (const body of [null, undefined, [], "create", {}, { action: null }, { action: "" }]) {
      expect(actionOf(surface, body)).toBeNull()
    }
    expect(actionOf(surface, { action: "create" })).toBe("create")
    expect(actionOf(surface, { action: "delete" })).toBeUndefined()
    expect(actionOf(surface, { action: 5 })).toBeUndefined()
  })
})
