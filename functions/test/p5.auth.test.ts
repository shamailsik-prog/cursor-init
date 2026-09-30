import { describe, expect, it } from "vitest"
import { adminAuth } from "../src/admin"
import { HttpError } from "../src/http/errors"
import { callerFromCallable, requireAuth } from "../src/p5/auth"
import { EMULATORS, mintIdToken, uniq } from "./emu"

async function httpErrorOf(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError)
    return e as HttpError
  }
  throw new Error("expected HttpError, promise resolved")
}

const goodClaims = (firmId: string) => ({ firmId, role: "associate", clearanceLevel: "confidential" })

describe("requireAuth (no emulator needed)", () => {
  it("no Authorization header → 401 missing_token", async () => {
    const err = await httpErrorOf(requireAuth({ headers: {} }))
    expect(err.status).toBe(401)
    expect(err.code).toBe("missing_token")
  })

  it("non-Bearer Authorization header → 401 missing_token", async () => {
    const err = await httpErrorOf(requireAuth({ headers: { authorization: "Basic abc" } }))
    expect(err.status).toBe(401)
    expect(err.code).toBe("missing_token")
  })
})

describe.skipIf(!EMULATORS)("requireAuth (Auth emulator)", () => {
  it("valid token + matching X-Firm-Id → Caller from custom claims", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(goodClaims(firmId))
    const caller = await requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": firmId } })
    expect(caller).toEqual({ uid, firmId, role: "associate", clearanceLevel: "confidential" })
  })

  it("garbage token → 401 invalid_token", async () => {
    const err = await httpErrorOf(requireAuth({ headers: { authorization: "Bearer not-a-jwt", "x-firm-id": "f" } }))
    expect(err.status).toBe(401)
    expect(err.code).toBe("invalid_token")
  })

  it("revoked token → 401 token_revoked", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(goodClaims(firmId))
    // revocation granularity is one second: make validSince strictly later than auth_time
    await new Promise((r) => setTimeout(r, 1100))
    await adminAuth().revokeRefreshTokens(uid)
    const err = await httpErrorOf(requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": firmId } }))
    expect(err.status).toBe(401)
    expect(err.code).toBe("token_revoked")
  })

  it("valid token + X-Firm-Id of another firm → 403 firm_mismatch", async () => {
    const { token } = await mintIdToken(goodClaims(uniq("firm")))
    const err = await httpErrorOf(
      requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": uniq("other-firm") } })
    )
    expect(err.status).toBe(403)
    expect(err.code).toBe("firm_mismatch")
  })

  it("valid token + missing X-Firm-Id → 403 firm_mismatch", async () => {
    const { token } = await mintIdToken(goodClaims(uniq("firm")))
    const err = await httpErrorOf(requireAuth({ headers: { authorization: `Bearer ${token}` } }))
    expect(err.status).toBe(403)
    expect(err.code).toBe("firm_mismatch")
  })

  it("claims missing firmId → 403 no_claims", async () => {
    const { token } = await mintIdToken({ role: "partner", clearanceLevel: "privileged" })
    const err = await httpErrorOf(requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": "f" } }))
    expect(err.status).toBe(403)
    expect(err.code).toBe("no_claims")
  })

  it("no custom claims at all → 403 no_claims", async () => {
    const { token } = await mintIdToken(null)
    const err = await httpErrorOf(requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": "f" } }))
    expect(err.status).toBe(403)
    expect(err.code).toBe("no_claims")
  })

  it("unknown role claim → 403 no_claims", async () => {
    const firmId = uniq("firm")
    const { token } = await mintIdToken({ firmId, role: "superuser", clearanceLevel: "internal" })
    const err = await httpErrorOf(requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": firmId } }))
    expect(err.status).toBe(403)
    expect(err.code).toBe("no_claims")
  })

  it("unknown clearanceLevel claim → 403 no_claims", async () => {
    const firmId = uniq("firm")
    const { token } = await mintIdToken({ firmId, role: "partner", clearanceLevel: "top-secret" })
    const err = await httpErrorOf(requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": firmId } }))
    expect(err.status).toBe(403)
    expect(err.code).toBe("no_claims")
  })
})

describe("callerFromCallable", () => {
  const auth = (token: Record<string, unknown>) => ({ uid: "u1", token, rawToken: "raw" }) as never

  it("missing auth → 401 missing_token", () => {
    expect(() => callerFromCallable(undefined)).toThrow(HttpError)
    try {
      callerFromCallable(undefined)
    } catch (e) {
      expect((e as HttpError).status).toBe(401)
      expect((e as HttpError).code).toBe("missing_token")
    }
  })

  it("valid claims → Caller; mismatching firm header → 403 firm_mismatch; bad claims → 403 no_claims", () => {
    const token = { firmId: "f1", role: "clerk", clearanceLevel: "internal" }
    expect(callerFromCallable(auth(token), "f1")).toEqual({
      uid: "u1",
      firmId: "f1",
      role: "clerk",
      clearanceLevel: "internal",
    })
    expect(() => callerFromCallable(auth(token), "f2")).toThrow(expect.objectContaining({ status: 403, code: "firm_mismatch" }))
    expect(() => callerFromCallable(auth({ ...token, role: "root" }), "f1")).toThrow(
      expect.objectContaining({ status: 403, code: "no_claims" })
    )
  })
})
