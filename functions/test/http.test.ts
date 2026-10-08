import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Firestore } from "firebase-admin/firestore"
import { Timestamp } from "firebase-admin/firestore"
import { adminAuth, adminDb } from "../src/admin"
import { HttpError } from "../src/http/errors"
import { IDEMPOTENCY_LEASE_MS, canonicalJson, isStorableResult, isUuidV4, requestHash } from "../src/http/idempotency"
import { FUNCTION_TIMEOUT_SECONDS } from "../src/health"
import { clientIp, retryAfterSeconds, windowId } from "../src/http/rateLimit"
import { ROUTES, api, buildRouteTable, createRouter, type Route } from "../src/http/router"
import { type FirmOperation, type Operation } from "../src/p5/common"
import { EMULATORS, mintIdToken, mintMfaIdToken, mockRes, uniq } from "./emu"

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
  query?: Record<string, unknown>
}

function makeReq(r: ReqInit) {
  const body = r.body ?? {}
  const rawBody = r.raw ?? Buffer.from(JSON.stringify(body))
  const headers: Record<string, string> = { "content-type": r.contentType ?? "application/json", ...r.headers }
  if (r.token) headers.authorization = `Bearer ${r.token}`
  if (r.firmId) headers["x-firm-id"] = r.firmId
  if (r.key !== null) headers["idempotency-key"] = r.key ?? randomUUID()
  if (r.ip) headers["x-forwarded-for"] = `${r.spoof ?? "10.9.9.9"}, ${r.ip}`
  return { method: r.method ?? "POST", path: r.path, headers, body, rawBody, ip: "127.0.0.1", query: r.query ?? {} }
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

  it("exposes the nine identity functions as POST /api/platform/identity/{fn} and recordGatePass as POST /api/platform/gates/recordGatePass, setFirmNumbering, registerClient (POST), getClient and listClients (GET) under /api/d1/client, kind general; runConflictCheck (POST, kind p1), getConflictResult (GET), resolveReviewItem and recordPartnerWaiver (POST) and getConflictTrail (GET) under /api/d1/conflict; openMatter, advanceStage and closeMatter (POST), getMatter and listMatters (GET) under /api/d1/matter", () => {
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
      [
        ...fns.map((f) => `POST /api/platform/identity/${f} general`),
        "POST /api/platform/gates/recordGatePass general",
        "POST /api/d1/client/setFirmNumbering general",
        "POST /api/d1/client/registerClient general",
        "GET /api/d1/client/getClient general",
        "GET /api/d1/client/listClients general",
        "POST /api/d1/conflict/runConflictCheck p1",
        "GET /api/d1/conflict/getConflictResult general",
        "POST /api/d1/conflict/resolveReviewItem general",
        "POST /api/d1/conflict/recordPartnerWaiver general",
        "GET /api/d1/conflict/getConflictTrail general",
        "POST /api/d1/matter/openMatter general",
        "GET /api/d1/matter/getMatter general",
        "GET /api/d1/matter/listMatters general",
        "POST /api/d1/matter/advanceStage general",
        "POST /api/d1/matter/closeMatter general",
        "GET /api/d1/entity/listReviewQueue general",
        "GET /api/d1/entity/getEntity general",
        "GET /api/d1/entity/listAliases general",
        "POST /api/d1/entity/confirmMerge general",
        "POST /api/d1/entity/disputeLink general",
        "POST /api/d1/entity/rejectLink general",
      ].sort()
    )
    expect(() => buildRouteTable(ROUTES)).not.toThrow()
  })

  it("each route's rate-limit kind is its operation's kind", () => {
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
  const r = (status: number, code?: string) => ({ status, body: code ? { error: { code } } : { ok: true } })
  it.each([
    [200, undefined, true],
    [201, undefined, true],
    [400, "invalid_role", true],
    [404, "not_found", true],
    [422, "idempotency_key_reused", true],
    [409, "last_partner", true],
    [409, "already_onboarded", true],
    [409, "already_exists", true],
    [409, "code_used", true],
    [409, "claims_sync_failed", false],
    [409, "idempotency_in_progress", false],
    [409, "bootstrap_not_configured", false],
    [409, "some_new_conflict", false],
    [401, "token_revoked", false],
    [403, "mfa_required", false],
    [429, "rate_limited", false],
    [500, "internal", false],
    [503, "audit_unavailable", false],
  ])("isStorableResult(%i %s) → %s", (status, code, stored) => {
    expect(isStorableResult(r(status, code))).toBe(stored)
  })

  it("the idempotency lease outlives the pinned function timeout; api pins it", async () => {
    expect(FUNCTION_TIMEOUT_SECONDS).toBe(120)
    expect(IDEMPOTENCY_LEASE_MS).toBeGreaterThan(FUNCTION_TIMEOUT_SECONDS * 1000)
    const index = (await import("../src/index")) as Record<string, { __endpoint?: { timeoutSeconds?: number; httpsTrigger?: unknown } }>
    // The job runtime's trigger, queue and schedule functions are not HTTP and run under their own
    // timeout (JOB_WORKER_TIMEOUT_SECONDS, pinned by p2.boot.test.ts).
    const names = Object.keys(index).filter((n) => n !== "health" && index[n].__endpoint?.httpsTrigger !== undefined)
    // U-1: the HTTP api is the only entry point (no onCall callables are deployed)
    expect(names).toEqual(["api"])
    for (const name of names) expect([name, index[name].__endpoint?.timeoutSeconds]).toEqual([name, FUNCTION_TIMEOUT_SECONDS])
    expect((api as unknown as { __endpoint: { timeoutSeconds?: number } }).__endpoint.timeoutSeconds).toBe(FUNCTION_TIMEOUT_SECONDS)
  })

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

  describe("TRUSTED_PROXY_HOPS", () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it("N hops: the entry N+1 from the right (behind a load balancer / Hosting)", () => {
      vi.stubEnv("TRUSTED_PROXY_HOPS", "1")
      expect(clientIp({ headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9, 130.211.0.1" }, ip: "10.0.0.1" })).toBe("203.0.113.9")
      vi.stubEnv("TRUSTED_PROXY_HOPS", "2")
      expect(clientIp({ headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9, 35.191.0.1, 130.211.0.1" }, ip: "10.0.0.1" })).toBe(
        "203.0.113.9"
      )
    })

    it("fewer hops than trusted proxies → req.ip; unset or invalid → 0 (the last hop)", () => {
      vi.stubEnv("TRUSTED_PROXY_HOPS", "2")
      expect(clientIp({ headers: { "x-forwarded-for": "203.0.113.9, 130.211.0.1" }, ip: "10.0.0.1" })).toBe("10.0.0.1")
      for (const bad of ["", "-1", "1.5", "x"]) {
        vi.stubEnv("TRUSTED_PROXY_HOPS", bad)
        expect(clientIp({ headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, ip: "10.0.0.1" })).toBe("203.0.113.9")
      }
    })
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
      // Increment + read-back may refuse more than needed under a burst (even all), never admit more.
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
      // R-5: a firm may already exist on this emulator, so record the G-2 pass a second firm needs.
      await adminDb().collection("platform").doc("gates").set({ g2PassedAt: Timestamp.now() })
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

// U-1: these were the callable rate-limit checks; the HTTP api is now the only entry point, so
// the same limits are checked through the router.
describe.skipIf(!EMULATORS)("rate limits on the api (per user, per firm override, per IP before auth)", () => {
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

  function testOp(kind: "general" | "p1", action = uniq("test.api")) {
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

  it("p1 operation: the 11th call in a minute → 429 rate_limited with Retry-After", async () => {
    const { op, calls } = testOp("p1")
    const router = createRouter([route("/api/t/u/p1", op, "p1")], { now: freshClock() })
    const { firmId, token } = await firmPartner()
    const call = () => send(router, { path: "/api/t/u/p1", token, firmId, ip: "192.0.2.10" })
    for (let i = 0; i < 10; i++) expect((await call()).status).toBe(200)
    const out = await call()
    expect({ status: out.status, code: errorOf(out), retryAfter: out.headers["retry-after"] }).toEqual({
      status: 429,
      code: "rate_limited",
      retryAfter: "40",
    })
    expect(calls.n).toBe(10)
  }, 30_000)

  it("the general bucket is per user across routes and honours the firm override", async () => {
    const now = freshClock()
    const router = createRouter([route("/api/t/u/one", testOp("general").op), route("/api/t/u/shared", countingOp().op)], { now })
    const { firmId, token } = await firmPartner()
    await adminDb().collection("firms").doc(firmId).set({ rateLimits: { general: 2 } }, { merge: true })
    expect((await send(router, { path: "/api/t/u/one", token, firmId })).status).toBe(200)
    expect((await send(router, { path: "/api/t/u/shared", token, firmId })).status).toBe(200)
    expect(errorOf(await send(router, { path: "/api/t/u/one", token, firmId }))).toBe("rate_limited")
  })

  it("real identity route: syncMfaStatus is rate limited under the general kind", async () => {
    const router = createRouter(ROUTES, { now: freshClock() })
    const { firmId, token } = await firmPartner()
    await adminDb().collection("firms").doc(firmId).set({ rateLimits: { general: 1 } }, { merge: true })
    const path = "/api/platform/identity/syncMfaStatus"
    const first = await send(router, { path, token, firmId })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ mfaEnabled: false })
    expect(errorOf(await send(router, { path, token, firmId }))).toBe("rate_limited")
  })

  it("pre-auth per-IP limit: the 61st failing call → 429, no audit row; a spoofed first hop does not help", async () => {
    const action = uniq("test.anon")
    const { op, calls } = testOp("general", action)
    const router = createRouter([route("/api/t/u/anon", op)], { now: freshClock() })
    const ip = `198.19.0.${Math.floor(Math.random() * 250)}`
    for (let i = 0; i < 60; i++) {
      const out = await send(router, { path: "/api/t/u/anon", ip, spoof: `100.64.${i}.1` })
      expect({ status: out.status, code: errorOf(out) }).toEqual({ status: 401, code: "missing_token" })
    }
    const rows = async () =>
      (await adminDb().collection("audit_log").where("action", "==", action).where("actorId", "==", "anonymous").get()).size
    expect(await rows()).toBe(60)
    const out = await send(router, { path: "/api/t/u/anon", ip, spoof: "100.64.250.1" })
    expect(out.status).toBe(429)
    expect(Number(out.headers["retry-after"])).toBeGreaterThanOrEqual(1)
    expect(await rows()).toBe(60)
    expect(calls.n).toBe(0)
  }, 60_000)
})

describe.skipIf(!EMULATORS)("fix round 1", () => {
  let minute = Date.UTC(2033, 0, 1, 0, 0, 0)
  const freshClock = () => {
    minute += 60_000
    const at = minute + 5_000
    return () => at
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function firmPartner() {
    const firmId = uniq("firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "T" })
    return { firmId, ...(await mintIdToken(partnerClaims(firmId))) }
  }

  async function rows(action: string, actorId: string) {
    const snap = await adminDb().collection("audit_log").where("action", "==", action).where("actorId", "==", actorId).get()
    return snap.docs.map((d) => d.data())
  }

  function namedOp(action: string, run: FirmOperation["run"] = async () => ({ ok: true })) {
    const op: Operation = { auth: "firm", kind: "general", action, target: "t", run }
    return op
  }

  it("step-up: 403 mfa_required is not stored; the same key with a second-factor token → 200", async () => {
    const firmId = uniq("firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "T" })
    const { token, firstFactorToken } = await mintMfaIdToken(partnerClaims(firmId))
    const router = createRouter(ROUTES, { now: freshClock() })
    const key = randomUUID()
    const path = "/api/platform/identity/generateRecoveryCodes"
    const first = await send(router, { path, token: firstFactorToken, firmId, key })
    expect(first.status).toBe(403)
    expect(errorOf(first)).toBe("mfa_required")
    const second = await send(router, { path, token, firmId, key })
    expect(second.status).toBe(200)
    expect((second.body as { codes: string[] }).codes).toHaveLength(10)
  })

  it("a 409 contention code (claims_sync_failed) releases the claim; a business 409 (last_partner) is replayed", async () => {
    let n = 0
    const op = namedOp(uniq("test.conflict"), async () => {
      n++
      if (n === 1) throw new HttpError(409, "claims_sync_failed")
      throw new HttpError(409, "last_partner")
    })
    const router = createRouter([route("/api/t/f/conflict", op)], { now: freshClock() })
    const { firmId, token } = await firmPartner()
    const key = randomUUID()
    expect(errorOf(await send(router, { path: "/api/t/f/conflict", token, firmId, key }))).toBe("claims_sync_failed")
    const b = await send(router, { path: "/api/t/f/conflict", token, firmId, key })
    expect(b.body).toEqual({ error: { code: "last_partner" } })
    const c = await send(router, { path: "/api/t/f/conflict", token, firmId, key })
    expect(c.body).toEqual({ error: { code: "last_partner" }, reused: true })
    expect(n).toBe(2)
  })

  it("audit actor: a revoked or disabled token's deny row carries its uid, not anonymous", async () => {
    const action = uniq("test.revoked")
    const router = createRouter([route("/api/t/f/revoked", namedOp(action))], { now: freshClock() })
    const { firmId, uid, token } = await firmPartner()
    await sleep(1100)
    await adminAuth().revokeRefreshTokens(uid)
    const out = await send(router, { path: "/api/t/f/revoked", token, firmId, ip: "192.0.2.201" })
    expect(out.status).toBe(401)
    expect(errorOf(out)).toBe("token_revoked")
    expect((await rows(action, uid)).map((r) => r.reason)).toEqual(["token_revoked"])
    expect(await rows(action, "anonymous")).toHaveLength(0)

    const other = await firmPartner()
    await adminAuth().updateUser(other.uid, { disabled: true })
    const out2 = await send(router, { path: "/api/t/f/revoked", token: other.token, firmId: other.firmId, ip: "192.0.2.201" })
    expect(errorOf(out2)).toBe("user_disabled")
    expect((await rows(action, other.uid)).map((r) => r.reason)).toEqual(["user_disabled"])
  })

  it("audit actor: a forged token (bad signature / garbage) stays anonymous", async () => {
    const action = uniq("test.forged")
    const router = createRouter([route("/api/t/f/forged", namedOp(action))], { now: freshClock() })
    const payload = Buffer.from(JSON.stringify({ sub: "victim-uid", user_id: "victim-uid" })).toString("base64url")
    const out = await send(router, { path: "/api/t/f/forged", token: `x.${payload}.y`, firmId: "f", ip: "192.0.2.202" })
    expect(out.status).toBe(401)
    expect(await rows(action, "victim-uid")).toHaveLength(0)
    expect(await rows(action, "anonymous")).toHaveLength(1)
  })

  it("idempotency refusals (400, 409, 422) are audited as denies; a replay is not audited", async () => {
    const action = uniq("test.idem")
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const op = namedOp(action, async (_s, data) => {
      calls++
      if (data.slow === true) await gate
      return { ok: true }
    })
    const router = createRouter([route("/api/t/f/idem", op)], { now: freshClock() })
    const { firmId, uid, token } = await firmPartner()
    const reasons = async () => (await rows(action, uid)).filter((r) => r.decision === "deny").map((r) => r.reason).sort()

    expect((await send(router, { path: "/api/t/f/idem", token, firmId, key: null })).status).toBe(400)
    const key = randomUUID()
    expect((await send(router, { path: "/api/t/f/idem", token, firmId, key })).status).toBe(200)
    expect((await send(router, { path: "/api/t/f/idem", token, firmId, key, body: { other: 1 } })).status).toBe(422)
    const slowKey = randomUUID()
    const slow = send(router, { path: "/api/t/f/idem", token, firmId, key: slowKey, body: { slow: true } })
    while (calls < 2) await sleep(10)
    expect((await send(router, { path: "/api/t/f/idem", token, firmId, key: slowKey, body: { slow: true } })).status).toBe(409)
    release()
    await slow
    expect(await reasons()).toEqual(["idempotency_in_progress", "idempotency_key_required", "idempotency_key_reused"])
    const denyRow = (await rows(action, uid)).find((r) => r.reason === "idempotency_key_reused")!
    expect(denyRow.firmId).toBe(firmId)

    const before = (await rows(action, uid)).length
    const replay = await send(router, { path: "/api/t/f/idem", token, firmId, key })
    expect(replay.body).toEqual({ ok: true, reused: true })
    expect((await rows(action, uid)).length).toBe(before)
  })

  it("settle is retried: two failed 'done' writes, then it is stored", async () => {
    const spy = vi.spyOn((await import("firebase-functions")).logger, "error").mockImplementation(() => undefined)
    const router = createRouter([route("/api/t/f/settle", namedOp(uniq("test.settle")))], { now: freshClock() })
    const { firmId, token } = await firmPartner()
    const key = randomUUID()
    const realTx = Firestore.prototype.runTransaction
    const tx = vi
      .spyOn(Firestore.prototype, "runTransaction")
      .mockImplementationOnce(function (this: Firestore, ...args: unknown[]) {
        return (realTx as (...a: unknown[]) => Promise<unknown>).apply(this, args) as never
      })
      .mockRejectedValueOnce(new Error("injected settle failure"))
      .mockRejectedValueOnce(new Error("injected settle failure"))
    const out = await send(router, { path: "/api/t/f/settle", token, firmId, key })
    tx.mockRestore()
    expect(out.status).toBe(200)
    const stored = (await adminDb().collection("idempotency_keys").doc(`${firmId}_${key}`).get()).data()!
    expect(stored.status).toBe("done")
    expect(spy).not.toHaveBeenCalledWith("idempotency complete failed", expect.anything())
    spy.mockRestore()
  })

  it("truly simultaneous same-key pair: exactly one runs, the other gets 409 (or the replay)", async () => {
    let calls = 0
    const op = namedOp(uniq("test.race"), async () => {
      calls++
      await sleep(50)
      return { ok: true }
    })
    const router = createRouter([route("/api/t/f/race", op)], { now: freshClock() })
    const { firmId, token } = await firmPartner()
    const key = randomUUID()
    const outs = await Promise.all([1, 2].map(() => send(router, { path: "/api/t/f/race", token, firmId, key })))
    expect(calls).toBe(1)
    const fresh = outs.filter((o) => o.status === 200 && !(o.body as { reused?: boolean }).reused)
    const loser = outs.filter((o) => !fresh.includes(o))
    expect(fresh).toHaveLength(1)
    expect(loser).toHaveLength(1)
    // The loser either raced the claim (409) or arrived after it settled (the replay).
    if (loser[0].status === 409) expect(errorOf(loser[0])).toBe("idempotency_in_progress")
    else expect(loser[0].body).toEqual({ ok: true, reused: true })
  })

  it("cross-firm: firm B reusing firm A's key and body gets its own execution, never A's response", async () => {
    let calls = 0
    const op = namedOp(uniq("test.xfirm"), async ({ caller }) => {
      calls++
      return { firmId: caller.firmId }
    })
    const router = createRouter([route("/api/t/f/xfirm", op)], { now: freshClock() })
    const a = await firmPartner()
    const b = await firmPartner()
    const key = randomUUID()
    const outA = await send(router, { path: "/api/t/f/xfirm", token: a.token, firmId: a.firmId, key, body: { v: 1 } })
    const outB = await send(router, { path: "/api/t/f/xfirm", token: b.token, firmId: b.firmId, key, body: { v: 1 } })
    expect(outA.body).toEqual({ firmId: a.firmId })
    expect(outB.body).toEqual({ firmId: b.firmId })
    expect(calls).toBe(2)
  })

  it("a deactivated caller cannot replay: 403 inactive_user, not the stored body", async () => {
    const router = createRouter([route("/api/t/f/deact", namedOp(uniq("test.deact")))], { now: freshClock() })
    const { firmId, uid, token } = await firmPartner()
    const key = randomUUID()
    expect((await send(router, { path: "/api/t/f/deact", token, firmId, key })).status).toBe(200)
    await adminDb().collection("users").doc(uid).update({ active: false })
    const out = await send(router, { path: "/api/t/f/deact", token, firmId, key })
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ error: { code: "inactive_user" } })
  })
})

describe("router: GET query data", () => {
  it("a repeated query parameter (array value) → 400 invalid_query, before auth", async () => {
    const { op, calls } = countingOp()
    const router = createRouter([route("/api/t/u/get", op, "general", "GET")])
    const out = await send(router, { method: "GET", path: "/api/t/u/get", key: null, query: { a: ["1", "2"] } })
    expect(out.status).toBe(400)
    expect(errorOf(out)).toBe("invalid_query")
    expect(calls.n).toBe(0)
  })

  it("a non-string query value (nested object) → 400 invalid_query", async () => {
    const { op } = countingOp()
    const router = createRouter([route("/api/t/u/get", op, "general", "GET")])
    const out = await send(router, { method: "GET", path: "/api/t/u/get", key: null, query: { a: { b: "1" } } })
    expect(errorOf(out)).toBe("invalid_query")
  })
})

describe.skipIf(!EMULATORS)("router: GET over the emulators", () => {
  it("passes the parsed query as data and needs no Idempotency-Key", async () => {
    const firmId = uniq("firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "T" })
    const { token } = await mintIdToken(partnerClaims(firmId))
    const { op, calls } = countingOp((d) => ({ got: d }))
    const router = createRouter([route("/api/t/u/getq", op, "general", "GET")])
    const out = await send(router, {
      method: "GET",
      path: "/api/t/u/getq",
      token,
      firmId,
      key: null,
      query: { limit: "5" },
      ip: `198.51.101.${Math.floor(Math.random() * 250)}`,
    })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ got: { limit: "5" } })
    expect(calls.n).toBe(1)
  })
})
