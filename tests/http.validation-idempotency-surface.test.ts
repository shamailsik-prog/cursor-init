/**
 * Request validation, idempotency and declared-surface helpers
 * (platform/http/validation.ts, idempotency.ts, surface.ts), unit level.
 * Written against the surviving mutants of `npm run mutation`
 * (docs/audits/mutation-report.md): size caps at their boundaries, the body
 * stream error path, UUID v4 anchoring, replay-store expiry, lease and eviction
 * order, the replay / refusal answers, and the surface guards' refusals.
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
  IdempotencyError,
  IdempotencyStore,
  beginIdempotentRequest,
  requireIdempotencyKey,
  resetIdempotencyForTests,
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

  it("the key error carries its status, name and default message", () => {
    // IdempotencyConflictError (409) is gone: a reused key is now a 422 response from
    // beginIdempotentRequest, asserted below.
    expect(new IdempotencyError()).toMatchObject({
      status: 400,
      name: "IdempotencyError",
      message: "Idempotency-Key header required",
    })
  })
})

// Adapted after final audit F4 / SEC-4: the per-route IdempotencyCache was replaced by one
// shared IdempotencyStore (explicit `now`, check-and-reserve claims, 422 on key reuse). The same
// mutant classes are targeted on it: the TTL and lease boundaries, conflict only on a different
// fingerprint, pruning of expired entries, eviction order and byte accounting.
describe("IdempotencyStore boundaries", () => {
  const limits = { ttlMs: 100, maxEntries: 10, maxBytes: 10_000, maxEntryBytes: 1_000, leaseMs: 50 }
  const claimed = (s: IdempotencyStore, key: string, fp: string, now: number): number => {
    const begun = s.begin(key, fp, now)
    if (begun.kind !== "claimed") throw new Error(`expected a claim for ${key}, got ${begun.kind}`)
    return begun.claimId
  }
  const done = (s: IdempotencyStore, key: string, body: unknown, now: number, fp = "fp") =>
    s.complete(key, claimed(s, key, fp, now), body, now)

  it("expires an entry exactly at its TTL, for a replay and for a reuse check, and drops it", () => {
    const s = new IdempotencyStore(limits)
    done(s, "a", "A", 1_000)
    expect(s.begin("a", "fp", 1_099)).toEqual({ kind: "replay", body: "A" })
    expect(s.begin("a", "other", 1_099)).toEqual({ kind: "reused" })
    expect(s.begin("a", "other", 1_100).kind).toBe("claimed")
    expect(s.size).toBe(1)
    expect(s.storedBytes).toBe(0)
  })

  it("reports reuse only for a different fingerprint; a miss is a claim", () => {
    const s = new IdempotencyStore(limits)
    expect(s.begin("nope", "fp", 0).kind).toBe("claimed")
    done(s, "a", "A", 0, "fp1")
    expect(s.begin("a", "fp2", 1)).toEqual({ kind: "reused" })
    expect(s.begin("a", "fp1", 1)).toEqual({ kind: "replay", body: "A" })
    const live = claimed(s, "b", "fp1", 1)
    expect(live).toBeGreaterThan(0)
    expect(s.begin("b", "fp2", 2)).toEqual({ kind: "reused" })
    expect(s.begin("b", "fp1", 2)).toEqual({ kind: "in_progress" })
  })

  it("an in-progress claim holds until its lease ends, inclusive, then may be taken over", () => {
    const s = new IdempotencyStore(limits)
    claimed(s, "a", "fp", 0)
    expect(s.begin("a", "fp", 50)).toEqual({ kind: "in_progress" })
    expect(s.begin("a", "fp", 51).kind).toBe("claimed")
  })

  it("prunes expired entries from the head on begin and on complete", () => {
    for (const touch of ["begin", "complete"] as const) {
      const s = new IdempotencyStore(limits)
      done(s, "old1", "1", 0)
      done(s, "old2", "2", 0)
      const id = claimed(s, "fresh", "fp", 60)
      expect(s.size).toBe(3)
      if (touch === "begin") claimed(s, "new", "fp", 100)
      else s.complete("fresh", id, "F", 100)
      expect(s.size).toBe(touch === "begin" ? 2 : 1)
      expect(s.storedBytes).toBe(touch === "begin" ? 0 : JSON.stringify("F").length * 2)
    }
  })

  it("keeps exactly maxEntries and evicts the least recently used, counting a replay as a use", () => {
    const s = new IdempotencyStore({ ...limits, maxEntries: 2 })
    done(s, "a", "A", 1)
    done(s, "b", "B", 2)
    expect(s.size).toBe(2)
    expect(s.begin("a", "fp", 3)).toEqual({ kind: "replay", body: "A" }) // a is now the most recent
    done(s, "c", "C", 4)
    expect(s.size).toBe(2)
    expect(s.begin("b", "fp", 5).kind).toBe("claimed") // b was evicted
    expect(s.begin("c", "fp", 5)).toEqual({ kind: "replay", body: "C" })
  })

  it("accounts stored bytes as UTF-16 code units, at the per-entry cap inclusive, and frees them on eviction", () => {
    const body = "x".repeat(498) // JSON "\"x...x\"" = 500 chars = 1000 bytes: exactly the cap
    const s = new IdempotencyStore({ ...limits, maxEntries: 1 })
    done(s, "a", body, 0)
    expect(s.storedBytes).toBe(1_000)
    expect(s.begin("a", "fp", 1)).toEqual({ kind: "replay", body })
    done(s, "b", "y", 2)
    expect(s.storedBytes).toBe(6)
    done(s, "c", "x".repeat(499), 3)
    expect(s.storedBytes).toBe(0)
    expect(s.begin("c", "fp", 4)).toEqual({ kind: "unavailable" })
  })
})

describe("beginIdempotentRequest answers", () => {
  const KEY = "3b241101-e2bb-4255-8caf-4136c566a962"
  const post = () => new Request("http://x/api/route", { method: "POST" })
  afterEach(() => resetIdempotencyForTests())

  it("replays a completed key with reused: true, and refuses reuse, in-progress and an unstorable response", async () => {
    const first = beginIdempotentRequest(post(), KEY, "fp")
    expect(first.claim).toBeDefined()
    first.claim!.complete({ ok: 1 })
    const replay = beginIdempotentRequest(post(), KEY, "fp").response!
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ result: { ok: 1 }, idempotencyKey: KEY, reused: true })

    const reused = beginIdempotentRequest(post(), KEY.toUpperCase(), "other").response!
    expect(reused.status).toBe(422)
    expect(await reused.json()).toEqual({
      code: "idempotency_key_reused",
      error: "Idempotency-Key reused with a different request payload",
    })

    const KEY2 = "3b241101-e2bb-4255-8caf-4136c566a963"
    expect(beginIdempotentRequest(post(), KEY2, "fp").claim).toBeDefined()
    const busy = beginIdempotentRequest(post(), KEY2, "fp").response!
    expect(busy.status).toBe(409)
    expect(await busy.json()).toEqual({ code: "idempotency_in_progress", error: "a request with this Idempotency-Key is in progress" })

    const KEY3 = "3b241101-e2bb-4255-8caf-4136c566a964"
    beginIdempotentRequest(post(), KEY3, "fp").claim!.complete("x".repeat(3 * 1024 * 1024))
    const gone = beginIdempotentRequest(post(), KEY3, "fp").response!
    expect(gone.status).toBe(409)
    expect(await gone.json()).toEqual({
      code: "idempotency_replay_unavailable",
      error: "this Idempotency-Key was already used; its response is not available for replay",
    })
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
