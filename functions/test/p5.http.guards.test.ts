/**
 * Pure guards of the P5 layer and the HTTP api, no emulator needed. Written
 * against the surviving mutants of `npm run mutation:functions`
 * (docs/audits/mutation-report.md): error mapping, classification and role
 * guards, the second-factor check, document-id and uid parsing, the
 * clearance ceiling for target users, the one-row-per-call CallAudit,
 * per-firm rate-limit overrides, the idempotency storable-result table and
 * request hashing, and the router's request-shape checks.
 */
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HttpsError } from "firebase-functions/v2/https"

const spies = vi.hoisted(() => ({ appendAudit: vi.fn(), logFailure: vi.fn() }))
vi.mock("../src/p5/audit", () => ({ appendAudit: spies.appendAudit }))
vi.mock("../src/log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/log")>()),
  logFailure: spies.logFailure,
}))

import { HttpError, RateLimitedError, toHttpsError } from "../src/http/errors"
import { canonicalJson, isStorableResult, isUuidV4, requestHash } from "../src/http/idempotency"
import { DEFAULT_LIMITS, MAX_LIMIT_OVERRIDE, clientIp, limitFor } from "../src/http/rateLimit"
import { createRouter, type Route } from "../src/http/router"
import { TokenRejectedError, hasSecondFactor, isRole, type Caller } from "../src/p5/auth"
import { isKnownClassification, rankOf } from "../src/p5/classification"
import {
  CallAudit,
  dataOf,
  isSafeDocId,
  parseRole,
  parseUid,
  requirePartner,
  requireTargetWithinOwnClearance,
  runAudited,
  type Operation,
} from "../src/p5/common"
import { mockRes } from "./emu"

beforeEach(() => {
  spies.appendAudit.mockReset()
  spies.appendAudit.mockResolvedValue("row-id")
  spies.logFailure.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function httpErrorOf(fn: () => unknown): HttpError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError)
    return e as HttpError
  }
  throw new Error("expected an HttpError")
}

describe("errors", () => {
  it("HttpError and RateLimitedError carry name, status and code", () => {
    expect(new HttpError(403, "x")).toMatchObject({ name: "HttpError", status: 403, code: "x", message: "x" })
    expect(new HttpError(403, "x", "detail").message).toBe("detail")
    expect(new RateLimitedError(7)).toMatchObject({ name: "RateLimitedError", status: 429, code: "rate_limited", retryAfter: 7 })
  })

  it("toHttpsError passes an HttpsError through untouched", () => {
    const original = new HttpsError("permission-denied", "already mapped", { code: "x" })
    expect(toHttpsError(original)).toBe(original)
  })

  it("maps anything that is not an HttpError to a bare internal error, leaking nothing", () => {
    const err = toHttpsError(new Error("password=hunter2"))
    expect({ code: err.code, message: err.message, details: err.details }).toEqual({
      code: "internal",
      message: "internal",
      details: { code: "internal" },
    })
  })

  it.each([
    [400, "invalid-argument"],
    [401, "unauthenticated"],
    [403, "permission-denied"],
    [404, "not-found"],
    [503, "unavailable"],
    [418, "internal"],
    [500, "internal"],
  ])("status %i maps to %s, keeping the machine code", (status, code) => {
    const err = toHttpsError(new HttpError(status, "the_code"))
    expect({ code: err.code, message: err.message, details: err.details }).toEqual({
      code,
      message: "the_code",
      details: { code: "the_code" },
    })
  })

  it("409 is already-exists only for already_exists; 429 carries retryAfter", () => {
    expect(toHttpsError(new HttpError(409, "already_exists")).code).toBe("already-exists")
    expect(toHttpsError(new HttpError(409, "last_partner")).code).toBe("failed-precondition")
    const limited = toHttpsError(new RateLimitedError(12))
    expect({ code: limited.code, details: limited.details }).toEqual({
      code: "resource-exhausted",
      details: { code: "rate_limited", retryAfter: 12 },
    })
  })
})

describe("classification, roles and second factors", () => {
  it("rankOf names the unknown label it refuses", () => {
    expect(() => rankOf("bogus" as never)).toThrow("unknown classification: bogus")
    expect(isKnownClassification(4)).toBe(false)
  })

  it("isRole accepts exactly the six roles", () => {
    for (const r of ["partner", "associate", "clerk", "intern", "accounts", "client"]) expect(isRole(r)).toBe(true)
    for (const r of ["admin", "", 1, null, "constructor"]) expect(isRole(r)).toBe(false)
  })

  it("hasSecondFactor needs a non-empty string sign_in_second_factor", () => {
    expect(hasSecondFactor({ firebase: { sign_in_second_factor: "phone" } })).toBe(true)
    for (const claims of [{}, { firebase: {} }, { firebase: { sign_in_second_factor: "" } }, { firebase: { sign_in_second_factor: 1 } }]) {
      expect(hasSecondFactor(claims)).toBe(false)
    }
  })

  it("TokenRejectedError is a 401 that may name the token's uid", () => {
    expect(new TokenRejectedError("token_revoked", "u1")).toMatchObject({
      name: "TokenRejectedError",
      status: 401,
      code: "token_revoked",
      uid: "u1",
    })
  })
})

describe("request parsing and target checks", () => {
  it("dataOf takes only a plain object", () => {
    const obj = { a: 1 }
    expect(dataOf({ data: obj } as never)).toBe(obj)
    for (const data of [null, undefined, [1], "s", 5]) expect(dataOf({ data } as never)).toEqual({})
  })

  it("isSafeDocId: one Firestore document id, at most 128 characters", () => {
    for (const ok of ["a", "a.b", "x".repeat(128), "__x", "x__", "a__b__", "__a__b"]) expect(isSafeDocId(ok)).toBe(true)
    for (const bad of ["", "x".repeat(129), "a/b", ".", "..", "__x__", "____", 5, null]) expect(isSafeDocId(bad)).toBe(false)
  })

  it("parseUid / parseRole refuse with their codes", () => {
    expect(parseUid("u1")).toBe("u1")
    expect(httpErrorOf(() => parseUid("a/b"))).toMatchObject({ status: 400, code: "invalid_uid" })
    expect(parseRole("clerk")).toBe("clerk")
    expect(httpErrorOf(() => parseRole("admin"))).toMatchObject({ status: 400, code: "invalid_role" })
  })

  it("a caller may act only on targets cleared no higher than themselves; unknown counts as highest", () => {
    const caller = { uid: "c", firmId: "f", role: "partner", clearanceLevel: "privileged" } as Caller
    expect(() => requireTargetWithinOwnClearance(caller, "privileged")).not.toThrow()
    expect(() => requireTargetWithinOwnClearance(caller, "internal")).not.toThrow()
    expect(httpErrorOf(() => requireTargetWithinOwnClearance(caller, "privileged-restricted"))).toMatchObject({
      status: 403,
      code: "exceeds_own_clearance",
    })
    expect(httpErrorOf(() => requireTargetWithinOwnClearance(caller, undefined)).code).toBe("exceeds_own_clearance")
    const top = { ...caller, clearanceLevel: "privileged-restricted" } as Caller
    expect(() => requireTargetWithinOwnClearance(top, "garbage")).not.toThrow()
  })

  it("requirePartner refuses every other role", () => {
    expect(() => requirePartner({ role: "partner" } as Caller)).not.toThrow()
    expect(httpErrorOf(() => requirePartner({ role: "associate" } as Caller))).toMatchObject({ status: 403, code: "partner_only" })
  })
})

describe("CallAudit and runAudited", () => {
  const row = (over: Record<string, unknown>) => ({
    firmId: "",
    actorId: "u1",
    action: "op.x",
    target: "t",
    classification: "internal",
    ...over,
  })

  it("writes one allow row; a later deny adds nothing", async () => {
    const audit = new CallAudit("op.x", "u1", "t")
    await audit.allow()
    await audit.deny("late")
    expect(spies.appendAudit).toHaveBeenCalledTimes(1)
    expect(spies.appendAudit).toHaveBeenCalledWith(row({ decision: "allow", reason: "ok" }))
  })

  it("a failed write is 503 audit_unavailable and leaves the call unaudited, so a deny is still written", async () => {
    const audit = new CallAudit("op.x", "u1", "t")
    audit.firmId = "f1"
    spies.appendAudit.mockRejectedValueOnce(new Error("down"))
    await expect(audit.allow()).rejects.toMatchObject({ status: 503, code: "audit_unavailable" })
    await audit.deny("after_failure")
    expect(spies.appendAudit).toHaveBeenLastCalledWith(row({ firmId: "f1", decision: "deny", reason: "after_failure" }))
  })

  it("stage maps a failed transactional write to 503 audit_unavailable", async () => {
    spies.appendAudit.mockRejectedValueOnce(new Error("down"))
    await expect(new CallAudit("op.x", "u1", "t").stage({} as never, "allow", "ok")).rejects.toMatchObject({
      status: 503,
      code: "audit_unavailable",
    })
  })

  it("incident is best effort: a failed write is logged, not thrown", async () => {
    const err = new Error("down")
    spies.appendAudit.mockRejectedValueOnce(err)
    await expect(new CallAudit("op.x", "u1", "t").incident("claims_sync_failed")).resolves.toBeUndefined()
    expect(spies.logFailure).toHaveBeenCalledWith("identity incident audit failed", err)
  })

  it("runAudited audits an HttpError by its code without logging, and anything else as internal, logged", async () => {
    await expect(runAudited(new CallAudit("op.x", "u1", "t"), () => Promise.reject(new HttpError(403, "cross_firm")))).rejects.toMatchObject({
      code: "cross_firm",
    })
    expect(spies.appendAudit).toHaveBeenLastCalledWith(row({ decision: "deny", reason: "cross_firm" }))
    expect(spies.logFailure).not.toHaveBeenCalled()
    const boom = new Error("boom")
    await expect(runAudited(new CallAudit("op.x", "u1", "t"), () => Promise.reject(boom))).rejects.toBe(boom)
    expect(spies.appendAudit).toHaveBeenLastCalledWith(row({ decision: "deny", reason: "internal" }))
    expect(spies.logFailure).toHaveBeenCalledWith("identity operation failed", boom)
  })
})

describe("rate-limit overrides and client IP", () => {
  it("limitFor takes a firm override only when it is an integer in 1..MAX_LIMIT_OVERRIDE", () => {
    const firm = (v: unknown) => ({ rateLimits: { general: v } })
    expect(limitFor("general", firm(1))).toBe(1)
    expect(limitFor("general", firm(MAX_LIMIT_OVERRIDE))).toBe(MAX_LIMIT_OVERRIDE)
    for (const bad of [0, -1, MAX_LIMIT_OVERRIDE + 1, 1.5, "5", null]) expect(limitFor("general", firm(bad))).toBe(DEFAULT_LIMITS.general)
    expect(limitFor("general", undefined)).toBe(60)
    expect(limitFor("p1", { rateLimits: null })).toBe(10)
    expect(limitFor("p1", { rateLimits: "p1=500" })).toBe(10)
    expect(limitFor("p1", { rateLimits: { general: 5 } })).toBe(10)
  })

  it("clientIp joins a repeated X-Forwarded-For header and falls back to req.ip, then unknown", () => {
    expect(clientIp({ headers: { "x-forwarded-for": ["6.6.6.6", "203.0.113.9"] }, ip: "10.0.0.1" })).toBe("203.0.113.9")
    expect(clientIp({ headers: { "x-forwarded-for": 5 } })).toBe("unknown")
  })
})

describe("idempotency helpers (boundaries)", () => {
  const r = (status: number, error?: unknown) => ({ status, body: error === undefined ? {} : { error } })

  it("stores exactly 200..299, 400, 404, 422 and the business 409s", () => {
    expect(isStorableResult(r(199))).toBe(false)
    expect(isStorableResult(r(200))).toBe(true)
    expect(isStorableResult(r(299))).toBe(true)
    expect(isStorableResult(r(300))).toBe(false)
    expect(isStorableResult(r(409))).toBe(false)
    expect(isStorableResult(r(409, { code: 5 }))).toBe(false)
    expect(isStorableResult(r(409, "already_exists"))).toBe(false)
    // A stored-409 code only counts on a 409.
    expect(isStorableResult(r(401, { code: "already_exists" }))).toBe(false)
    expect(isStorableResult(r(503, { code: "last_partner" }))).toBe(false)
  })

  it("isUuidV4 is anchored and needs a string", () => {
    const id = randomUUID()
    expect(isUuidV4(id)).toBe(true)
    for (const bad of [`x${id}`, `${id}x`, 5, null]) expect(isUuidV4(bad)).toBe(false)
  })

  it("canonicalJson: sorted keys, undefined dropped, arrays and scalars as JSON", () => {
    expect(canonicalJson({ b: [1, { d: 1, c: undefined }], a: "x" })).toBe('{"a":"x","b":[1,{"d":1}]}')
    expect(canonicalJson([])).toBe("[]")
    expect(canonicalJson({})).toBe("{}")
    expect(canonicalJson(undefined)).toBe("null")
    expect(canonicalJson([undefined])).toBe("[null]")
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }))
    expect(requestHash({ a: [1, 2] })).not.toBe(requestHash({ a: [2, 1] }))
  })
})

describe("router request shape (before auth)", () => {
  const op: Operation = { auth: "firm", kind: "general", action: "t.op", target: "t", run: async () => ({ ok: true }) }
  const routes: Route[] = [
    { method: "POST", path: "/api/t/u/echo", handler: op, kind: "general" },
    { method: "GET", path: "/api/t/u/read", handler: op, kind: "general" },
    { method: "GET", path: "/api/t/u/both", handler: op, kind: "general" },
    { method: "POST", path: "/api/t/u/both", handler: op, kind: "general" },
  ]
  const router = createRouter(routes)

  async function call(over: { method?: string; path?: string; contentType?: string; body?: unknown; raw?: Buffer; length?: string }) {
    const body = "body" in over ? over.body : {}
    const headers: Record<string, string> = { "content-type": over.contentType ?? "application/json" }
    if (over.length !== undefined) headers["content-length"] = over.length
    const { res, out } = mockRes()
    await router(
      { method: over.method ?? "POST", path: over.path ?? "/api/t/u/echo", headers, body, rawBody: over.raw ?? Buffer.from(JSON.stringify(body)), ip: "127.0.0.1" } as never,
      res as never
    )
    return { status: out.status, code: (out.body as { error?: { code?: string } }).error?.code, headers: out.headers }
  }

  // A request that passes every shape check reaches authentication, which refuses it
  // (no token): 401 here means "accepted by the shape checks". Auth failures also hit
  // the per-IP limit store, which is not reachable without emulators, so stop there.
  const pastShape = (s: { status: number; code?: string }) =>
    !["route_not_found", "method_not_allowed", "payload_too_large", "unsupported_media_type", "invalid_body"].includes(s.code ?? "")

  it("ignores trailing slashes and routes the bare root", async () => {
    expect(pastShape(await call({ path: "/api/t/u/echo//" }))).toBe(true)
    expect((await call({ path: "/" })).code).toBe("route_not_found")
  })

  it("lists the allowed methods on 405", async () => {
    const out = await call({ method: "PUT", path: "/api/t/u/read" })
    expect({ status: out.status, code: out.code, allow: out.headers.allow }).toEqual({ status: 405, code: "method_not_allowed", allow: "GET" })
    expect((await call({ method: "PUT", path: "/api/t/u/both" })).headers.allow).toBe("GET, POST")
  })

  it("accepts application/json with parameters only, case-insensitively", async () => {
    expect(pastShape(await call({ contentType: "Application/JSON; charset=utf-8" }))).toBe(true)
    expect(pastShape(await call({ contentType: "application/json ;charset=utf-8" }))).toBe(true)
    for (const ct of ["application/jsonx", "text/application/json", "application/json-patch+json"]) {
      expect((await call({ contentType: ct })).code).toBe("unsupported_media_type")
    }
  })

  it("refuses a non-object JSON body with 400 invalid_body", async () => {
    for (const body of [[1], "s", null]) {
      expect(await call({ body, raw: Buffer.from(JSON.stringify(body)) })).toMatchObject({ status: 400, code: "invalid_body" })
    }
  })

  it("413 on a declared Content-Length over 1 MB, and accepts exactly 1 MB", async () => {
    expect(await call({ length: String(1024 * 1024 + 1) })).toMatchObject({ status: 413, code: "payload_too_large" })
    expect(pastShape(await call({ raw: Buffer.alloc(1024 * 1024, 32) }))).toBe(true)
    expect(pastShape(await call({ length: String(1024 * 1024) }))).toBe(true)
  })

  it("does not apply body checks to GET", async () => {
    expect(pastShape(await call({ method: "GET", path: "/api/t/u/read", contentType: "text/plain", body: [1] }))).toBe(true)
  })
})
