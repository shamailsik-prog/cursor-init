import { describe, expect, it } from "vitest"
import { adminAuth, adminDb } from "../src/admin"
import { HttpError } from "../src/http/errors"
import { callerFromCallable, requireAuth } from "../src/p5/auth"
import { EMULATORS, callableAuth, mintIdToken, uniq } from "./emu"

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

  it("'Bearer ' with no token → 401 missing_token", async () => {
    const err = await httpErrorOf(requireAuth({ headers: { authorization: "Bearer " } }))
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


describe.skipIf(!EMULATORS)("requireAuth header handling (Auth emulator)", () => {
  it("capitalised Authorization / X-Firm-Id headers are accepted", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(goodClaims(firmId))
    const caller = await requireAuth({ headers: { Authorization: `Bearer ${token}`, "X-Firm-Id": firmId } })
    expect(caller.uid).toBe(uid)
  })

  it("auth scheme is case-insensitive: 'bearer <valid>' → Caller, 'bearer tok' → 401 invalid_token", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(goodClaims(firmId))
    await expect(requireAuth({ headers: { authorization: `bearer ${token}`, "x-firm-id": firmId } })).resolves.toMatchObject({
      uid,
    })
    const err = await httpErrorOf(requireAuth({ headers: { authorization: "bearer tok", "x-firm-id": firmId } }))
    expect(err.status).toBe(401)
    expect(err.code).toBe("invalid_token")
  })

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "clearanceLevel claim %j (Object.prototype key) → 403 no_claims",
    async (key) => {
      const firmId = uniq("firm")
      const { token } = await mintIdToken({ firmId, role: "partner", clearanceLevel: key })
      const err = await httpErrorOf(requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": firmId } }))
      expect(err.status).toBe(403)
      expect(err.code).toBe("no_claims")
    }
  )
})

describe("callerFromCallable (no emulator needed)", () => {
  it("missing auth → 401 missing_token", async () => {
    const err = await httpErrorOf(callerFromCallable(undefined, "f1"))
    expect(err.status).toBe(401)
    expect(err.code).toBe("missing_token")
  })
})

describe.skipIf(!EMULATORS)("callerFromCallable (Auth emulator)", () => {
  it("valid claims + matching firmId → Caller", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(goodClaims(firmId))
    await expect(callerFromCallable(await callableAuth(token), firmId)).resolves.toEqual({
      uid,
      firmId,
      role: "associate",
      clearanceLevel: "confidential",
    })
  })

  it("missing or empty firmId → 400 firm_required", async () => {
    const { token } = await mintIdToken(goodClaims(uniq("firm")))
    const auth = await callableAuth(token)
    for (const firm of [undefined, ""]) {
      const err = await httpErrorOf(callerFromCallable(auth, firm as never))
      expect(err.status).toBe(400)
      expect(err.code).toBe("firm_required")
    }
  })

  it("mismatching firmId → 403 firm_mismatch", async () => {
    const { token } = await mintIdToken(goodClaims(uniq("firm")))
    const err = await httpErrorOf(callerFromCallable(await callableAuth(token), uniq("other")))
    expect(err.status).toBe(403)
    expect(err.code).toBe("firm_mismatch")
  })

  it("malformed claims → 403 no_claims", async () => {
    const firmId = uniq("firm")
    const { token } = await mintIdToken({ firmId, role: "root", clearanceLevel: "internal" })
    const err = await httpErrorOf(callerFromCallable(await callableAuth(token), firmId))
    expect(err.status).toBe(403)
    expect(err.code).toBe("no_claims")
  })

  it("revoked session → 401 token_revoked", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(goodClaims(firmId))
    const auth = await callableAuth(token)
    await new Promise((r) => setTimeout(r, 1100))
    await adminAuth().revokeRefreshTokens(uid)
    const err = await httpErrorOf(callerFromCallable(auth, firmId))
    expect(err.status).toBe(401)
    expect(err.code).toBe("token_revoked")
  })

  it("disabled user → 401 user_disabled", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(goodClaims(firmId))
    const auth = await callableAuth(token)
    await adminAuth().updateUser(uid, { disabled: true })
    const err = await httpErrorOf(callerFromCallable(auth, firmId))
    expect(err.status).toBe(401)
    expect(err.code).toBe("user_disabled")
  })
})

describe.skipIf(!EMULATORS)("requireAuth disabled user (Auth emulator)", () => {
  it("disabled user → 401 user_disabled", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(goodClaims(firmId))
    await adminAuth().updateUser(uid, { disabled: true })
    const err = await httpErrorOf(requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": firmId } }))
    expect(err.status).toBe(401)
    expect(err.code).toBe("user_disabled")
  })
})

describe.skipIf(!EMULATORS)("users/{uid} is authoritative (requireAuth + callerFromCallable)", () => {
  const partner = (firmId: string) => ({ firmId, role: "partner", clearanceLevel: "privileged" })
  const users = () => adminDb().collection("users")

  async function both(token: string, firmId: string) {
    const http = requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": firmId } })
    const callable = callerFromCallable(await callableAuth(token), firmId)
    return Promise.allSettled([http, callable])
  }

  function rejectedWith(results: PromiseSettledResult<unknown>[], status: number, code: string) {
    for (const r of results) {
      expect(r.status).toBe("rejected")
      expect((r as PromiseRejectedResult).reason).toMatchObject({ status, code })
    }
  }

  it("missing users doc → 403 inactive_user", async () => {
    const firmId = uniq("firm")
    const { token } = await mintIdToken(partner(firmId), { userDoc: false })
    rejectedWith(await both(token, firmId), 403, "inactive_user")
  })

  it("users doc active:false → 403 inactive_user", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(partner(firmId))
    await users().doc(uid).update({ active: false })
    rejectedWith(await both(token, firmId), 403, "inactive_user")
  })

  it("users doc of another firm → 403 firm_mismatch", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(partner(firmId))
    await users().doc(uid).update({ firmId: uniq("other") })
    rejectedWith(await both(token, firmId), 403, "firm_mismatch")
  })

  it("demoted partner (doc role changed, old token still says partner) → 401 claims_stale", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(partner(firmId))
    await users().doc(uid).update({ role: "associate" })
    rejectedWith(await both(token, firmId), 401, "claims_stale")
  })

  it("doc clearance lower than the token's → Caller gets the lower clearance", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(partner(firmId))
    await users().doc(uid).update({ clearanceLevel: "internal" })
    for (const r of await both(token, firmId)) {
      expect(r).toEqual({ status: "fulfilled", value: { uid, firmId, role: "partner", clearanceLevel: "internal" } })
    }
  })

  it("doc clearance higher than the token's → Caller keeps the token's (claims only restrict)", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken({ firmId, role: "associate", clearanceLevel: "internal" })
    await users().doc(uid).update({ clearanceLevel: "privileged-restricted" })
    for (const r of await both(token, firmId)) {
      expect(r).toEqual({ status: "fulfilled", value: { uid, firmId, role: "associate", clearanceLevel: "internal" } })
    }
  })

  it("malformed doc clearance (prototype key) → 403 no_claims", async () => {
    const firmId = uniq("firm")
    const { uid, token } = await mintIdToken(partner(firmId))
    await users().doc(uid).update({ clearanceLevel: "constructor" })
    rejectedWith(await both(token, firmId), 403, "no_claims")
  })
})
