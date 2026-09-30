import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { HttpsError } from "firebase-functions/v2/https"
import { adminAuth, adminDb } from "../src/admin"
import { HttpError } from "../src/http/errors"
import { canonicalJson, isUuidV4, requestHash } from "../src/http/idempotency"
import { clientIp, retryAfterSeconds, windowId } from "../src/http/rateLimit"
import { ROUTES, buildRouteTable, createRouter, type Route } from "../src/http/router"
import { callableHandler, type Operation } from "../src/p5/common"
import { EMULATORS, callableAuth, mintIdToken, mintMfaIdToken, uniq } from "./emu"

/** A minimal express-like response that records what the router sent. */
function mockRes() {
  const out = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown }
  const res = {
    status(n: number) {
      out.status = n
      return res
    },
    set(name: string, value: string) {
      out.headers[name.toLowerCase()] = value
      return res
    },
    json(body: unknown) {
      out.body = body
      return res
    },
  }
  return { res, out }
}

type ReqInit = {
  method?: string
  path: string
  token?: string
  firmId?: string
  key?: string | null
  body?: unknown
  contentType?: string
  ip?: string
  /** A client-supplied first X-Forwarded-For hop in front of `ip` (the hop Google's front end appends). */
  spoof?: string
  headers?: Record<string, string>
  raw?: Buffer
}

function makeReq(r: ReqInit) {
  const body = r.body ?? {}
  const rawBody = r.raw ?? Buffer.from(JSON.stringify(body))
  const headers: Record<string, string> = { "content-type": r.contentType ?? "application/json", ...r.headers }
  if (r.token) headers.authorization = `Bearer ${r.token}`
  if (r.firmId) headers["x-firm-id"] = r.firmId
  if (r.key !== null) headers["idempotency-key"] = r.key ?? randomUUID()
  if (r.ip) headers["x-forwarded-for"] = `${r.spoof ?? "10.9.9.9"}, ${r.ip}`
  return { method: r.method ?? "POST", path: r.path, headers, body, rawBody, ip: "127.0.0.1" }
}

async function send(router: ReturnType<typeof createRouter>, r: ReqInit) {
  const { res, out } = mockRes()
  await router(makeReq(r) as never, res as never)
  return out
}

const errorOf = (out: { body: unknown }) => (out.body as { error?: { code?: string } }).error?.code

const partnerClaims = (firmId: string) => ({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })

/** A firm-scoped test operation that counts its invocations. */
function countingOp(result: (data: Record<string, unknown>) => unknown = (d) => ({ echo: d.value ?? null })) {
  const calls = { n: 0 }
  const op: Operation = {
    auth: "firm",
    kind: "general",
    action: "test.op",
    target: "test",
    run: async (_session, data) => {
      calls.n++
      return result(data)
    },
  }
  return { op, calls }
}

const route = (path: string, handler: Operation, kind: Route["kind"] = "general", method: Route["method"] = "POST"): Route => ({
  method,
  path,
  handler,
  kind,
})

describe("route table", () => {
  it("rejects a duplicate method + path at build time", () => {
    const { op } = countingOp()
    expect(() => buildRouteTable([route("/api/x/y/z", op), route("/api/x/y/z", op)])).toThrow(/duplicate route POST \/api\/x\/y\/z/)
  })

  it("allows the same path under different methods", () => {
    const { op } = countingOp()
    expect(() => buildRouteTable([route("/api/x/y/z", op), route("/api/x/y/z", op, "general", "PUT")])).not.toThrow()
  })

  it("exposes the nine identity functions as POST /api/platform/identity/{fn}, kind general", () => {
    const fns = [
      "onboardFirm",
      "createFirmUser",
      "setUserClaims",
      "deactivateUser",
      "enforceMfaForRole",
      "approveMfaDisable",
      "disableMfa",
      "generateRecoveryCodes",
      "syncMfaStatus",
    ]
    expect(ROUTES.map((r) => `${r.method} ${r.path} ${r.kind}`).sort()).toEqual(
      fns.map((f) => `POST /api/platform/identity/${f} general`).sort()
    )
    expect(() => buildRouteTable(ROUTES)).not.toThrow()
  })

  it("each route's rate-limit kind is its operation's kind (the callable uses the same)", () => {
    for (const r of ROUTES) expect(r.kind).toBe(r.handler.kind)
  })
})

describe("router: request shape (before auth)", () => {
  const { op } = countingOp()
  const router = createRouter([route("/api/t/u/echo", op)])

  it("unknown route → 404 route_not_found", async () => {
    const out = await send(router, { path: "/api/t/u/nope" })
    expect(out.status).toBe(404)
    expect(errorOf(out)).toBe("route_not_found")
  })

  it("known path, wrong method → 405 with Allow", async () => {
    const out = await send(router, { method: "GET", path: "/api/t/u/echo" })
    expect(out.status).toBe(405)
    expect(errorOf(out)).toBe("method_not_allowed")
    expect(out.headers.allow).toBe("POST")
  })

  it("accepts the path without the /api prefix (direct function URL)", async () => {
    const out = await send(router, { method: "GET", path: "/t/u/echo" })
    expect(out.status).toBe(405)
  })

  it("non-JSON content type → 415", async () => {
    const out = await send(router, { path: "/api/t/u/echo", contentType: "text/plain" })
    expect(out.status).toBe(415)
    expect(errorOf(out)).toBe("unsupported_media_type")
  })

  it("body over 1 MB → 413", async () => {
    const out = await send(router, { path: "/api/t/u/echo", raw: Buffer.alloc(1024 * 1024 + 1, 32) })
    expect(out.status).toBe(413)
    expect(errorOf(out)).toBe("payload_too_large")
  })
})

describe("idempotency helpers", () => {
  it.each([
    ["3b241101-e2bb-4255-8caf-4136c566a962", true],
    ["3B241101-E2BB-4255-8CAF-4136C566A962", true],
    ["3b241101-e2bb-1255-8caf-4136c566a962", false], // version 1
    ["3b241101-e2bb-4255-7caf-4136c566a962", false], // bad variant
    ["3b241101e2bb42558caf4136c566a962", false],
    ["", false],
  ])("isUuidV4(%s) → %s", (key, ok) => {
    expect(isUuidV4(key)).toBe(ok)
  })

  it("canonicalJson ignores key order, keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 }))
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }))
  })
})

describe("rate-limit helpers", () => {
  it("clientIp is the last X-Forwarded-For hop (appended by Google's front end), else req.ip", () => {
    expect(clientIp({ headers: { "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.9" }, ip: "10.0.0.1" })).toBe("203.0.113.9")
    expect(clientIp({ headers: { "x-forwarded-for": "203.0.113.9" }, ip: "10.0.0.1" })).toBe("203.0.113.9")
    expect(clientIp({ headers: {}, ip: "10.0.0.1" })).toBe("10.0.0.1")
  })

  it("windowId is the UTC minute yyyyMMddHHmm", () => {
    expect(windowId(Date.UTC(2026, 8, 30, 7, 5, 59, 999))).toBe("202609300705")
  })

  it("Retry-After is the seconds to the window end, at least 1", () => {
    expect(retryAfterSeconds(Date.UTC(2026, 8, 30, 7, 5, 0))).toBe(60)
    expect(retryAfterSeconds(Date.UTC(2026, 8, 30, 7, 5, 30, 500))).toBe(30)
    expect(retryAfterSeconds(Date.UTC(2026, 8, 30, 7, 5, 59, 999))).toBe(1)
  })
})

describe.skipIf(!EMULATORS)("router over the emulators", () => {
  /** A fixed clock inside one minute, unique per test so rate-limit windows never collide. */
  let minute = Date.UTC(2031, 0, 1, 0, 0, 0)
  const freshClock = () => {
    minute += 60_000
    const at = minute + 5_000
    return () => at
  }

  async function firmPartner() {
    const firmId = uniq("firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "T" })
    const p = await mintIdToken(partnerClaims(firmId))
    return { firmId, ...p }
  }

  async function auditRows(action: string, actorId: string) {
    const snap = await adminDb().collection("audit_log").where("action", "==", action).where("actorId", "==", actorId).get()
    return snap.docs.map((d) => d.data())
  }

  describe("auth first", () => {
    it("no token → 401 missing_token, audited as a deny under the route's action", async () => {
      const { op } = countingOp()
      const ip = `198.51.100.${Math.floor(Math.random() * 250)}`
      const router = createRouter([route("/api/t/u/authfirst", op)], { now: freshClock() })
      const before = (await auditRows("test.op", "anonymous")).length
      const out = await send(router, { path: "/api/t/u/authfirst", ip })
      expect(out.status).toBe(401)
      expect(errorOf(out)).toBe("missing_token")
      expect((await auditRows("test.op", "anonymous")).length).toBe(before + 1)
    })

    it("X-Firm-Id ≠ token firm → 403 firm_mismatch", async () => {
      const { op, calls } = countingOp()
      const router = createRouter([route("/api/t/u/fm", op)], { now: freshClock() })
      const { token } = await firmPartner()
      const out = await send(router, { path: "/api/t/u/fm", token, firmId: "other-firm" })
      expect(out.status).toBe(403)
      expect(errorOf(out)).toBe("firm_mismatch")
      expect(calls.n).toBe(0)
    })

    it("per-IP limit: the 61st failing unauthenticated request in a minute → 429, and no audit row", async () => {
      const { op } = countingOp()
      const router = createRouter([route("/api/t/u/anon", op)], { now: freshClock() })
      const ip = `203.0.113.${Math.floor(Math.random() * 250)}`
      for (let i = 0; i < 60; i++) {
        const out = await send(router, { path: "/api/t/u/anon", ip, token: "garbage" })
        expect(out.status).toBe(401)
      }
      const before = (await auditRows("test.op", "anonymous")).length
      const out = await send(router, { path: "/api/t/u/anon", ip, token: "garbage" })
      expect(out.status).toBe(429)
      expect(errorOf(out)).toBe("rate_limited")
      expect(Number(out.headers["retry-after"])).toBeGreaterThanOrEqual(1)
      expect((await auditRows("test.op", "anonymous")).length).toBe(before)
      // Another IP is unaffected.
      const other = await send(router, { path: "/api/t/u/anon", ip: "192.0.2.77", token: "garbage" })
      expect(other.status).toBe(401)
    }, 60_000)

    it("a spoofed first X-Forwarded-For hop cannot evade the per-IP limit", async () => {
      const { op } = countingOp()
      const router = createRouter([route("/api/t/u/spoof", op)], { now: freshClock() })
      const ip = `198.18.0.${Math.floor(Math.random() * 250)}`
      for (let i = 0; i < 60; i++) {
        const out = await send(router, { path: "/api/t/u/spoof", ip, spoof: `100.64.${i}.1`, token: "garbage" })
        expect(out.status).toBe(401)
      }
      const out = await send(router, { path: "/api/t/u/spoof", ip, spoof: "100.64.200.1", token: "garbage" })
      expect(out.status).toBe(429)
    }, 60_000)
  })

  describe("rate limits", () => {
    it("61st general request in a minute → 429 rate_limited with Retry-After", async () => {
      const { op, calls } = countingOp()
      const now = freshClock()
      const router = createRouter([route("/api/t/u/rl", op)], { now })
      const { firmId, token } = await firmPartner()
      for (let i = 0; i < 60; i++) {
        const out = await send(router, { path: "/api/t/u/rl", token, firmId })
        expect(out.status).toBe(200)
      }
      const out = await send(router, { path: "/api/t/u/rl", token, firmId })
      expect(out.status).toBe(429)
      expect(errorOf(out)).toBe("rate_limited")
      expect(out.headers["retry-after"]).toBe("55")
      expect(calls.n).toBe(60)
    }, 60_000)

    it("p1 routes allow 10 per minute; the general bucket is separate", async () => {
      const { op } = countingOp()
      const router = createRouter([route("/api/t/u/p1", op, "p1"), route("/api/t/u/gen", op)], { now: freshClock() })
      const { firmId, token } = await firmPartner()
      for (let i = 0; i < 10; i++) expect((await send(router, { path: "/api/t/u/p1", token, firmId })).status).toBe(200)
      expect((await send(router, { path: "/api/t/u/p1", token, firmId })).status).toBe(429)
      expect((await send(router, { path: "/api/t/u/gen", token, firmId })).status).toBe(200)
    }, 30_000)

    it("firms/{firmId}.rateLimits overrides the per-firm limit", async () => {
      const { op } = countingOp()
      const router = createRouter([route("/api/t/u/ovr", op)], { now: freshClock() })
      const { firmId, token } = await firmPartner()
      await adminDb().collection("firms").doc(firmId).set({ rateLimits: { general: 3 } }, { merge: true })
      for (let i = 0; i < 3; i++) expect((await send(router, { path: "/api/t/u/ovr", token, firmId })).status).toBe(200)
      expect((await send(router, { path: "/api/t/u/ovr", token, firmId })).status).toBe(429)
    })

    it("under a parallel burst the limit is never exceeded", async () => {
      const { op, calls } = countingOp()
      const router = createRouter([route("/api/t/u/burst", op)], { now: freshClock() })
      const { firmId, token } = await firmPartner()
      await adminDb().collection("firms").doc(firmId).set({ rateLimits: { general: 5 } }, { merge: true })
      const outs = await Promise.all(Array.from({ length: 20 }, () => send(router, { path: "/api/t/u/burst", token, firmId })))
      const ok = outs.filter((o) => o.status === 200).length
      expect(ok).toBeGreaterThanOrEqual(1)
      expect(ok).toBeLessThanOrEqual(5)
      expect(outs.filter((o) => o.status === 429).length).toBe(20 - ok)
      expect(calls.n).toBe(ok)
    }, 30_000)

    it("the counter lives at rate_limits/{uid}_{kind}_{yyyyMMddHHmm}", async () => {
      const { op } = countingOp()
      const now = freshClock()
      const router = createRouter([route("/api/t/u/doc", op)], { now })
      const { firmId, uid, token } = await firmPartner()
      await send(router, { path: "/api/t/u/doc", token, firmId })
      const doc = await adminDb().collection("rate_limits").doc(`${uid}_general_${windowId(now())}`).get()
      expect(doc.data()?.count).toBe(1)
      expect(doc.data()?.expiresAt).toBeInstanceOf(Timestamp)
    })
  })

  describe("idempotency", () => {
    it("missing or non-v4 Idempotency-Key → 400 idempotency_key_required, handler not run", async () => {
      const { op, calls } = countingOp()
      const router = createRouter([route("/api/t/u/k", op)], { now: freshClock() })
      const { firmId, token } = await firmPartner()
      const missing = await send(router, { path: "/api/t/u/k", token, firmId, key: null })
      expect(missing.status).toBe(400)
      expect(errorOf(missing)).toBe("idempotency_key_required")
      const v1 = await send(router, { path: "/api/t/u/k", token, firmId, key: "3b241101-e2bb-1255-8caf-4136c566a962" })
      expect(v1.status).toBe(400)
      expect(errorOf(v1)).toBe("idempotency_key_required")
      expect(calls.n).toBe(0)
    })

    it("same key twice → identical body plus reused: true; the handler runs once", async () => {
      const { op, calls } = countingOp()
      const router = createRouter([route("/api/t/u/replay", op)], { now: freshClock() })
      const { firmId, uid, token } = await firmPartner()
      const key = randomUUID()
      const first = await send(router, { path: "/api/t/u/replay", token, firmId, key, body: { value: 7, x: [1] } })
      const second = await send(router, { path: "/api/t/u/replay", token, firmId, key, body: { x: [1], value: 7 } })
      expect(first.status).toBe(200)
      expect(first.body).toEqual({ echo: 7 })
      expect(second.status).toBe(200)
      expect(second.body).toEqual({ echo: 7, reused: true })
      expect(calls.n).toBe(1)
      const stored = (await adminDb().collection("idempotency_keys").doc(`${firmId}_${key}`).get()).data()!
      expect(stored).toMatchObject({ firmId, uid, route: "POST /api/t/u/replay", status: "done", response: { status: 200, body: { echo: 7 } } })
      expect(stored.requestHash).toMatch(/^[0-9a-f]{64}$/)
      const ttl = (stored.expiresAt as Timestamp).toMillis() - (stored.createdAt as Timestamp).toMillis()
      expect(ttl).toBe(24 * 60 * 60 * 1000)
    })

    it("same key with a different body, route or user → 422 idempotency_key_reused", async () => {
      const { op, calls } = countingOp()
      const router = createRouter([route("/api/t/u/a", op), route("/api/t/u/b", op)], { now: freshClock() })
      const { firmId, token } = await firmPartner()
      const other = await mintIdToken(partnerClaims(firmId))
      const key = randomUUID()
      expect((await send(router, { path: "/api/t/u/a", token, firmId, key, body: { value: 1 } })).status).toBe(200)
      const diffBody = await send(router, { path: "/api/t/u/a", token, firmId, key, body: { value: 2 } })
      const diffRoute = await send(router, { path: "/api/t/u/b", token, firmId, key, body: { value: 1 } })
      const diffUser = await send(router, { path: "/api/t/u/a", token: other.token, firmId, key, body: { value: 1 } })
      for (const out of [diffBody, diffRoute, diffUser]) {
        expect(out.status).toBe(422)
        expect(errorOf(out)).toBe("idempotency_key_reused")
      }
      expect(calls.n).toBe(1)
    })

    it("a duplicate while the first is in progress → 409 idempotency_in_progress", async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let started!: () => void
      const running = new Promise<void>((r) => (started = r))
      const op: Operation = {
        auth: "firm",
        kind: "general",
        action: "test.slow",
        target: "t",
        run: async () => {
          started()
          await gate
          return { ok: true }
        },
      }
      const router = createRouter([route("/api/t/u/slow", op)], { now: freshClock() })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const first = send(router, { path: "/api/t/u/slow", token, firmId, key })
      await running
      const dup = await send(router, { path: "/api/t/u/slow", token, firmId, key })
      expect(dup.status).toBe(409)
      expect(errorOf(dup)).toBe("idempotency_in_progress")
      release()
      expect((await first).status).toBe(200)
    })

    it("a 4xx business response is stored and replayed", async () => {
      const calls = { n: 0 }
      const op: Operation = {
        auth: "firm",
        kind: "general",
        action: "test.deny",
        target: "t",
        run: async () => {
          calls.n++
          throw new HttpError(409, "already_exists")
        },
      }
      const router = createRouter([route("/api/t/u/deny", op)], { now: freshClock() })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const a = await send(router, { path: "/api/t/u/deny", token, firmId, key })
      const b = await send(router, { path: "/api/t/u/deny", token, firmId, key })
      expect(a.status).toBe(409)
      expect(a.body).toEqual({ error: { code: "already_exists" } })
      expect(b.status).toBe(409)
      expect(b.body).toEqual({ error: { code: "already_exists" }, reused: true })
      expect(calls.n).toBe(1)
    })

    it("a 5xx or thrown handler releases the claim so a retry runs again", async () => {
      const { logger } = await import("firebase-functions")
      const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined)
      const calls = { n: 0 }
      const op: Operation = {
        auth: "firm",
        kind: "general",
        action: "test.flaky",
        target: "t",
        run: async () => {
          calls.n++
          if (calls.n === 1) throw new Error("boom")
          if (calls.n === 2) throw new HttpError(503, "audit_unavailable")
          return { ok: true }
        },
      }
      const router = createRouter([route("/api/t/u/flaky", op)], { now: freshClock() })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const a = await send(router, { path: "/api/t/u/flaky", token, firmId, key })
      expect(a.status).toBe(500)
      expect(errorOf(a)).toBe("internal")
      expect((await adminDb().collection("idempotency_keys").doc(`${firmId}_${key}`).get()).exists).toBe(false)
      const b = await send(router, { path: "/api/t/u/flaky", token, firmId, key })
      expect(b.status).toBe(503)
      const c = await send(router, { path: "/api/t/u/flaky", token, firmId, key })
      expect(c.status).toBe(200)
      expect(c.body).toEqual({ ok: true })
      expect(calls.n).toBe(3)
      expect(spy).toHaveBeenCalledWith("identity operation failed", { code: "unknown" })
      spy.mockRestore()
    })

    it("an expired key is treated as absent", async () => {
      const { op, calls } = countingOp()
      const router = createRouter([route("/api/t/u/exp", op)], { now: freshClock() })
      const { firmId, uid, token } = await firmPartner()
      const key = randomUUID()
      await adminDb()
        .collection("idempotency_keys")
        .doc(`${firmId}_${key}`)
        .set({
          firmId,
          uid: "someone-else",
          route: "POST /api/t/u/other",
          requestHash: "x",
          status: "in_progress",
          createdAt: Timestamp.fromMillis(0),
          expiresAt: Timestamp.fromMillis(1000),
        })
      const out = await send(router, { path: "/api/t/u/exp", token, firmId, key, body: { value: 3 } })
      expect(out.status).toBe(200)
      expect(out.body).toEqual({ echo: 3 })
      expect(calls.n).toBe(1)
      const stored = (await adminDb().collection("idempotency_keys").doc(`${firmId}_${key}`).get()).data()!
      expect(stored).toMatchObject({ uid, status: "done" })
    })

    async function seedClaim(firmId: string, uid: string, key: string, route: string, body: unknown, claimedAgoMs: number, now: number) {
      await adminDb()
        .collection("idempotency_keys")
        .doc(`${firmId}_${key}`)
        .set({
          firmId,
          uid,
          route,
          requestHash: requestHash(body),
          status: "in_progress",
          claimId: "dead-claim",
          createdAt: Timestamp.fromMillis(now - claimedAgoMs),
          claimedAt: Timestamp.fromMillis(now - claimedAgoMs),
          expiresAt: Timestamp.fromMillis(now - claimedAgoMs + 24 * 60 * 60 * 1000),
        })
    }

    it("stale lease: an in_progress claim older than 5 minutes is taken over", async () => {
      const { op, calls } = countingOp()
      const now = freshClock()
      const router = createRouter([route("/api/t/u/stale", op)], { now })
      const { firmId, uid, token } = await firmPartner()
      const key = randomUUID()
      await seedClaim(firmId, uid, key, "POST /api/t/u/stale", { value: 5 }, 5 * 60 * 1000 + 1, now())
      const out = await send(router, { path: "/api/t/u/stale", token, firmId, key, body: { value: 5 } })
      expect(out.status).toBe(200)
      expect(out.body).toEqual({ echo: 5 })
      expect(calls.n).toBe(1)
      const stored = (await adminDb().collection("idempotency_keys").doc(`${firmId}_${key}`).get()).data()!
      expect(stored.status).toBe("done")
      expect((stored.claimedAt as Timestamp).toMillis()).toBe(now())
    })

    it("a live lease (claimed under 5 minutes ago) still answers 409", async () => {
      const { op, calls } = countingOp()
      const now = freshClock()
      const router = createRouter([route("/api/t/u/live", op)], { now })
      const { firmId, uid, token } = await firmPartner()
      const key = randomUUID()
      await seedClaim(firmId, uid, key, "POST /api/t/u/live", { value: 5 }, 4 * 60 * 1000, now())
      const out = await send(router, { path: "/api/t/u/live", token, firmId, key, body: { value: 5 } })
      expect(out.status).toBe(409)
      expect(errorOf(out)).toBe("idempotency_in_progress")
      expect(calls.n).toBe(0)
    })

    it("a stale claim with another body is still 422, not taken over", async () => {
      const { op, calls } = countingOp()
      const now = freshClock()
      const router = createRouter([route("/api/t/u/stale422", op)], { now })
      const { firmId, uid, token } = await firmPartner()
      const key = randomUUID()
      await seedClaim(firmId, uid, key, "POST /api/t/u/stale422", { value: 1 }, 10 * 60 * 1000, now())
      const out = await send(router, { path: "/api/t/u/stale422", token, firmId, key, body: { value: 2 } })
      expect(out.status).toBe(422)
      expect(calls.n).toBe(0)
    })
  })

  describe("identity routes (real handlers)", () => {
    const router = () => createRouter(ROUTES, { now: freshClock() })
    const P = "/api/platform/identity"

    it("createFirmUser: firm from X-Firm-Id (body firmId ignored); a replay returns the same uid without a second user", async () => {
      const { firmId, token } = await firmPartner()
      const r = router()
      const key = randomUUID()
      const email = `${uniq("new")}@example.test`
      const body = { firmId: "ignored-firm", email, role: "associate", clearanceLevel: "confidential" }
      const a = await send(r, { path: `${P}/createFirmUser`, token, firmId, key, body })
      expect(a.status).toBe(200)
      const uid = (a.body as { uid: string }).uid
      expect((await adminAuth().getUser(uid)).customClaims).toMatchObject({ firmId, role: "associate" })
      const b = await send(r, { path: `${P}/createFirmUser`, token, firmId, key, body })
      expect(b.status).toBe(200)
      expect(b.body).toEqual({ uid, reused: true })
      const rows = await auditRows("identity.createFirmUser", (await adminAuth().verifyIdToken(token)).uid)
      expect(rows.filter((x) => x.target === `users/${uid}` && x.decision === "allow")).toHaveLength(1)
    })

    it("MFA policy: enforced role without a second factor → 403 mfa_required, but syncMfaStatus is exempt", async () => {
      const { firmId, uid, token } = await firmPartner()
      await adminDb().collection("firms").doc(firmId).set({ mfaEnforcedRoles: ["partner"] }, { merge: true })
      const r = router()
      const denied = await send(r, {
        path: `${P}/createFirmUser`,
        token,
        firmId,
        body: { email: `${uniq("x")}@example.test`, role: "clerk", clearanceLevel: "internal" },
      })
      expect(denied.status).toBe(403)
      expect(errorOf(denied)).toBe("mfa_required")
      const synced = await send(r, { path: `${P}/syncMfaStatus`, token, firmId })
      expect(synced.status).toBe(200)
      expect(synced.body).toEqual({ uid, mfaEnabled: false })
    })

    it("onboardFirm uses the no-firm path (no X-Firm-Id needed); an onboarded caller → 409 already_onboarded", async () => {
      const r = router()
      const admin = await mintIdToken({ platformAdmin: true })
      const out = await send(r, { path: `${P}/onboardFirm`, token: admin.token, body: { name: "HTTP Firm" } })
      expect(out.status).toBe(200)
      const firmId = (out.body as { firmId: string }).firmId
      expect((await adminDb().collection("firms").doc(firmId).get()).data()?.name).toBe("HTTP Firm")
      const { token } = await firmPartner()
      const again = await send(r, { path: `${P}/onboardFirm`, token, body: { name: "Again" } })
      expect(again.status).toBe(409)
      expect(errorOf(again)).toBe("already_onboarded")
    })

    it("generateRecoveryCodes: codes are returned once and never stored; a replay is redacted", async () => {
      const firmId = uniq("firm")
      await adminDb().collection("firms").doc(firmId).set({ name: "T" })
      const { token } = await mintMfaIdToken(partnerClaims(firmId))
      const r = router()
      const key = randomUUID()
      const a = await send(r, { path: `${P}/generateRecoveryCodes`, token, firmId, key })
      expect(a.status).toBe(200)
      const codes = (a.body as { codes: string[] }).codes
      expect(codes).toHaveLength(10)
      const stored = (await adminDb().collection("idempotency_keys").doc(`${firmId}_${key}`).get()).data()!
      expect(JSON.stringify(stored)).not.toContain(codes[0])
      const b = await send(r, { path: `${P}/generateRecoveryCodes`, token, firmId, key })
      expect(b.status).toBe(200)
      expect(b.body).toEqual({ redacted: true, reused: true })
    })
  })

  it("logs no raw error text for a thrown handler", async () => {
    const { logger } = await import("firebase-functions")
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined)
    const op: Operation = {
      auth: "firm",
      kind: "general",
      action: "test.secret",
      target: "t",
      run: async () => {
        throw new Error("secret-detail@example.test")
      },
    }
    const router = createRouter([route("/api/t/u/secret", op)], { now: freshClock() })
    const { firmId, token } = await firmPartner()
    const out = await send(router, { path: "/api/t/u/secret", token, firmId })
    expect(out.status).toBe(500)
    expect(JSON.stringify(out.body)).not.toContain("secret")
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-detail")
    spy.mockRestore()
  })
})

describe.skipIf(!EMULATORS)("callables share the rate limits", () => {
  let minute = Date.UTC(2032, 0, 1, 0, 0, 0)
  const freshClock = () => {
    minute += 60_000
    const at = minute + 20_000
    return () => at
  }

  async function firmPartner() {
    const firmId = uniq("firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "T" })
    return { firmId, ...(await mintIdToken(partnerClaims(firmId))) }
  }

  const rawRequest = (ip: string, spoof = "10.9.9.9") => ({ headers: { "x-forwarded-for": `${spoof}, ${ip}` }, ip: "127.0.0.1" })

  async function callableError(p: Promise<unknown>): Promise<HttpsError> {
    try {
      await p
    } catch (e) {
      expect(e).toBeInstanceOf(HttpsError)
      return e as HttpsError
    }
    throw new Error("expected HttpsError, promise resolved")
  }

  function testOp(kind: "general" | "p1", action = uniq("test.callable")) {
    const calls = { n: 0 }
    const op: Operation = {
      auth: "firm",
      kind,
      action,
      target: "t",
      run: async () => {
        calls.n++
        return { ok: true }
      },
    }
    return { op, calls }
  }

  it("p1 operation: the 11th call in a minute → resource-exhausted with a retryAfter detail", async () => {
    const { op, calls } = testOp("p1")
    const handler = callableHandler(op, { now: freshClock() })
    const { firmId, token } = await firmPartner()
    const auth = await callableAuth(token)
    const call = () => handler({ auth, data: { firmId }, rawRequest: rawRequest("192.0.2.10") } as never)
    for (let i = 0; i < 10; i++) await expect(call()).resolves.toEqual({ ok: true })
    const err = await callableError(call())
    expect({ code: err.code, details: err.details }).toEqual({
      code: "resource-exhausted",
      details: { code: "rate_limited", retryAfter: 40 },
    })
    expect(calls.n).toBe(10)
  }, 30_000)

  it("the general bucket is shared with HTTP and honours the firm override", async () => {
    const { op } = testOp("general")
    const now = freshClock()
    const handler = callableHandler(op, { now })
    const router = createRouter([route("/api/t/u/shared", countingOp().op)], { now })
    const { firmId, token } = await firmPartner()
    await adminDb().collection("firms").doc(firmId).set({ rateLimits: { general: 2 } }, { merge: true })
    const auth = await callableAuth(token)
    const call = () => handler({ auth, data: { firmId }, rawRequest: rawRequest("192.0.2.11") } as never)
    await expect(call()).resolves.toEqual({ ok: true })
    expect((await send(router, { path: "/api/t/u/shared", token, firmId })).status).toBe(200)
    expect((await callableError(call())).code).toBe("resource-exhausted")
  })

  it("real identity callable: syncMfaStatus is rate limited under the general kind", async () => {
    const { syncMfaStatusOp } = await import("../src/p5/mfa")
    const handler = callableHandler(syncMfaStatusOp, { now: freshClock() })
    const { firmId, token } = await firmPartner()
    await adminDb().collection("firms").doc(firmId).set({ rateLimits: { general: 1 } }, { merge: true })
    const auth = await callableAuth(token)
    const call = () => handler({ auth, data: { firmId }, rawRequest: rawRequest("192.0.2.12") } as never)
    await expect(call()).resolves.toMatchObject({ mfaEnabled: false })
    expect((await callableError(call())).code).toBe("resource-exhausted")
  })

  it("pre-auth per-IP limit from rawRequest: the 61st failing call → resource-exhausted, no audit row; a spoofed first hop does not help", async () => {
    const action = uniq("test.anon")
    const { op, calls } = testOp("general", action)
    const handler = callableHandler(op, { now: freshClock() })
    const ip = `198.19.0.${Math.floor(Math.random() * 250)}`
    for (let i = 0; i < 60; i++) {
      const err = await callableError(handler({ auth: undefined, data: {}, rawRequest: rawRequest(ip, `100.64.${i}.1`) } as never))
      expect(err.code).toBe("unauthenticated")
    }
    const rows = async () =>
      (await adminDb().collection("audit_log").where("action", "==", action).where("actorId", "==", "anonymous").get()).size
    expect(await rows()).toBe(60)
    const err = await callableError(handler({ auth: undefined, data: {}, rawRequest: rawRequest(ip, "100.64.250.1") } as never))
    expect(err.code).toBe("resource-exhausted")
    expect((err.details as { retryAfter?: number }).retryAfter).toBeGreaterThanOrEqual(1)
    expect(await rows()).toBe(60)
    expect(calls.n).toBe(0)
  }, 60_000)
})
