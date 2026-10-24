import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CLOCK_SKEW_SECONDS,
  GOOGLE_JWKS_URL,
  MAX_TOKEN_LIFETIME_SECONDS,
  ServiceAuthError,
  activeKeySource,
  googleKeySource,
  resetGoogleKeyCacheForTests,
  setServiceKeysForTests,
  verifyServiceCaller,
  type JwkSet,
} from "../src/p1/serviceAuth"

/**
 * FA-D3C-002 (spec R9): the corpus service's call to `p1CorpusEmbedding` carries a Google-signed OIDC ID token. The
 * handler verifies it itself, with node:crypto against Google's key set: RS256 only, key by `kid`, issuer, audience,
 * expiry with 60 s skew, a lifetime of at most an hour, a verified email on the caller allowlist. Every refusal is a
 * fixed code; a key set that cannot be read fails closed (503). Synthetic keys only: generated per run, never stored.
 */

const AUDIENCE = "https://p1corpusembedding-abc123-el.a.run.app"
const CALLER = "corpus-embedder@corpus-project.iam.gserviceaccount.com"
const NOW = Date.parse("2026-10-24T10:00:00.000Z")
const NOW_S = NOW / 1000

function rsaKey(bits = 2048): { privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: bits })
  return { privateKey, jwk: publicKey.export({ format: "jwk" }) as Record<string, unknown> }
}

const KEY = rsaKey()
const KID = "fa-d3c-test-key-1"
const KEYS: JwkSet = { keys: [{ ...KEY.jwk, kid: KID, alg: "RS256", use: "sig" }] }

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url")

function mint(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: KID, typ: "JWT" }, key: KeyObject = KEY.privateKey): string {
  const input = `${b64(header)}.${b64(payload)}`
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`
}

const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: "https://accounts.google.com",
  aud: AUDIENCE,
  sub: "112233445566778899000",
  email: CALLER,
  email_verified: true,
  iat: NOW_S - 30,
  exp: NOW_S + 3000,
  ...over,
})

const opts = (over: Partial<Parameters<typeof verifyServiceCaller>[1]> = {}) => ({
  audience: AUDIENCE,
  callers: new Set([CALLER]),
  nowMs: NOW,
  keys: async () => KEYS,
  ...over,
})

async function refusal(p: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceAuthError)
    const e = err as ServiceAuthError
    return { code: e.code, status: e.status }
  }
  throw new Error("expected a refusal")
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  setServiceKeysForTests(null)
  resetGoogleKeyCacheForTests()
})

describe("verifyServiceCaller: a valid Google OIDC ID token for an allowed caller", () => {
  it("returns the caller's email and subject", async () => {
    await expect(verifyServiceCaller(`Bearer ${mint(claims())}`, opts())).resolves.toEqual({ email: CALLER, subject: "112233445566778899000" })
  })

  it("accepts the issuer without the scheme and an email in another case", async () => {
    const token = mint(claims({ iss: "accounts.google.com", email: CALLER.toUpperCase() }))
    await expect(verifyServiceCaller(`Bearer ${token}`, opts())).resolves.toMatchObject({ email: CALLER })
  })

  it("accepts a token that expired within the clock skew", async () => {
    const token = mint(claims({ iat: NOW_S - 3600, exp: NOW_S - CLOCK_SKEW_SECONDS + 1 }))
    await expect(verifyServiceCaller(`Bearer ${token}`, opts())).resolves.toMatchObject({ email: CALLER })
  })
})

describe("verifyServiceCaller: every refusal is a fixed code", () => {
  it.each([
    ["no header", undefined, "missing_token", 401],
    ["empty header", "", "missing_token", 401],
    ["a Basic header", "Basic Zm9vOmJhcg==", "missing_token", 401],
    ["two segments", "Bearer abc.def", "malformed_token", 401],
    ["a segment with padding", "Bearer abc.def=.ghi", "malformed_token", 401],
    ["a header that is not JSON", `Bearer ${b64("x")}.${b64(claims())}.c2ln`, "malformed_token", 401],
    ["a payload that is not an object", `Bearer ${b64({ alg: "RS256", kid: KID })}.${b64("[1]")}.c2ln`, "malformed_token", 401],
    ["a token over the size bound", `Bearer ${"a".repeat(5000)}.${"b".repeat(5000)}.c`, "malformed_token", 401],
  ])("%s", async (_name, header, code, status) => {
    expect(await refusal(verifyServiceCaller(header, opts()))).toEqual({ code, status })
  })

  it.each([
    ["alg none", { alg: "none", kid: KID }],
    ["alg HS256", { alg: "HS256", kid: KID }],
    ["alg RS512", { alg: "RS512", kid: KID }],
    ["a crit header", { alg: "RS256", kid: KID, crit: ["exp"] }],
    ["a typ other than JWT", { alg: "RS256", kid: KID, typ: "at+jwt" }],
  ])("unsupported_algorithm: %s", async (_name, header) => {
    expect(await refusal(verifyServiceCaller(`Bearer ${mint(claims(), header)}`, opts()))).toEqual({ code: "unsupported_algorithm", status: 401 })
  })

  it("unknown_key: a kid the key set does not hold, after one refresh of the set", async () => {
    const calls: Array<boolean | undefined> = []
    const keys = async (o?: { refresh?: boolean }) => {
      calls.push(o?.refresh)
      return KEYS
    }
    const token = mint(claims(), { alg: "RS256", kid: "rotated-away" })
    expect(await refusal(verifyServiceCaller(`Bearer ${token}`, opts({ keys })))).toEqual({ code: "unknown_key", status: 401 })
    expect(calls).toEqual([undefined, true])
  })

  it("unknown_key: no kid at all", async () => {
    const token = mint(claims(), { alg: "RS256" })
    expect(await refusal(verifyServiceCaller(`Bearer ${token}`, opts()))).toEqual({ code: "unknown_key", status: 401 })
  })

  it("unknown_key: the key set holds the kid only as a key too weak, of the wrong type or not for signing", async () => {
    const weak = rsaKey(1024)
    const weakSet: JwkSet = { keys: [{ ...weak.jwk, kid: KID, alg: "RS256" }] }
    const token = mint(claims(), undefined, weak.privateKey)
    expect(await refusal(verifyServiceCaller(`Bearer ${token}`, opts({ keys: async () => weakSet })))).toEqual({ code: "unknown_key", status: 401 })
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" })
    const ecSet: JwkSet = { keys: [{ ...ec, kid: KID }] }
    expect(await refusal(verifyServiceCaller(`Bearer ${mint(claims())}`, opts({ keys: async () => ecSet })))).toEqual({ code: "unknown_key", status: 401 })
    const encSet: JwkSet = { keys: [{ ...KEY.jwk, kid: KID, use: "enc" }] }
    expect(await refusal(verifyServiceCaller(`Bearer ${mint(claims())}`, opts({ keys: async () => encSet })))).toEqual({ code: "unknown_key", status: 401 })
    const otherAlg: JwkSet = { keys: [{ ...KEY.jwk, kid: KID, alg: "RS384" }] }
    expect(await refusal(verifyServiceCaller(`Bearer ${mint(claims())}`, opts({ keys: async () => otherAlg })))).toEqual({ code: "unknown_key", status: 401 })
  })

  it("bad_signature: a payload changed after signing, a signature by another key, an empty signature", async () => {
    const [h, , s] = mint(claims()).split(".")
    const forged = `${h}.${b64(claims({ email: "attacker@evil.example" }))}.${s}`
    expect(await refusal(verifyServiceCaller(`Bearer ${forged}`, opts()))).toEqual({ code: "bad_signature", status: 401 })
    const other = rsaKey()
    expect(await refusal(verifyServiceCaller(`Bearer ${mint(claims(), undefined, other.privateKey)}`, opts()))).toEqual({ code: "bad_signature", status: 401 })
    const [h2, p2] = mint(claims()).split(".")
    expect(await refusal(verifyServiceCaller(`Bearer ${h2}.${p2}.`, opts()))).toEqual({ code: "malformed_token", status: 401 })
  })

  it.each([
    ["another issuer", { iss: "https://securetoken.google.com/demo" }, "wrong_issuer"],
    ["no issuer", { iss: undefined }, "wrong_issuer"],
    ["another audience", { aud: "https://evil.example" }, "wrong_audience"],
    ["an audience list", { aud: [AUDIENCE] }, "wrong_audience"],
    ["expired past the skew", { iat: NOW_S - 3600, exp: NOW_S - CLOCK_SKEW_SECONDS - 1 }, "expired"],
    ["no expiry", { exp: undefined }, "expired"],
    ["a string expiry", { exp: String(NOW_S + 100) }, "expired"],
    ["issued in the future past the skew", { iat: NOW_S + CLOCK_SKEW_SECONDS + 5, exp: NOW_S + 3000 }, "not_yet_valid"],
    ["no issued-at", { iat: undefined }, "not_yet_valid"],
    ["not before in the future", { nbf: NOW_S + CLOCK_SKEW_SECONDS + 5 }, "not_yet_valid"],
    ["a lifetime over an hour", { iat: NOW_S - 30, exp: NOW_S - 30 + MAX_TOKEN_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS + 1 }, "lifetime_too_long"],
    ["email_verified false", { email_verified: false }, "email_unverified"],
    ["email_verified as a string", { email_verified: "true" }, "email_unverified"],
    ["no email", { email: undefined }, "email_unverified"],
    ["no subject", { sub: undefined }, "malformed_token"],
  ])("%s", async (_name, over, code) => {
    expect(await refusal(verifyServiceCaller(`Bearer ${mint(claims(over))}`, opts()))).toEqual({ code, status: 401 })
  })

  it("caller_not_allowed (403): a valid token for an identity not on the list", async () => {
    const token = mint(claims({ email: "someone-else@corpus-project.iam.gserviceaccount.com" }))
    expect(await refusal(verifyServiceCaller(`Bearer ${token}`, opts()))).toEqual({ code: "caller_not_allowed", status: 403 })
    expect(await refusal(verifyServiceCaller(`Bearer ${mint(claims())}`, opts({ callers: new Set() })))).toEqual({ code: "caller_not_allowed", status: 403 })
  })

  it("keys_unavailable (503): the key set cannot be read", async () => {
    const keys = async () => {
      throw new Error("network down")
    }
    expect(await refusal(verifyServiceCaller(`Bearer ${mint(claims())}`, opts({ keys })))).toEqual({ code: "keys_unavailable", status: 503 })
  })

  it("a refusal never carries the token or a claim in its message", async () => {
    const token = mint(claims({ aud: "https://evil.example" }))
    try {
      await verifyServiceCaller(`Bearer ${token}`, opts())
    } catch (err) {
      expect((err as Error).message).not.toContain(token.slice(0, 20))
      expect((err as Error).message).not.toContain("evil.example")
      expect((err as Error).message).not.toContain(CALLER)
    }
  })
})

describe("the key source", () => {
  const jwksResponse = (body: unknown, headers: Record<string, string> = { "cache-control": "public, max-age=19000" }, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

  it("fetches Google's JWKS with redirects refused and a timeout, and caches it for its max-age (capped at an hour)", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jwksResponse(KEYS))
    vi.stubGlobal("fetch", fetchMock)
    let now = NOW
    const source = googleKeySource(() => now)
    await expect(source()).resolves.toEqual(KEYS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe(GOOGLE_JWKS_URL)
    const init = fetchMock.mock.calls[0]![1]!
    expect(init.redirect).toBe("error")
    expect(init.signal).toBeInstanceOf(AbortSignal)
    now += 3_599_000
    await source()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now += 2_000
    await source()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("refreshes on request only when the cached set is more than a minute old", async () => {
    const fetchMock = vi.fn(async () => jwksResponse(KEYS))
    vi.stubGlobal("fetch", fetchMock)
    let now = NOW
    const source = googleKeySource(() => now)
    await source()
    await source({ refresh: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now += 61_000
    await source({ refresh: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("with no max-age caches for five minutes", async () => {
    const fetchMock = vi.fn(async () => jwksResponse(KEYS, {}))
    vi.stubGlobal("fetch", fetchMock)
    let now = NOW
    const source = googleKeySource(() => now)
    await source()
    now += 299_000
    await source()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now += 2_000
    await source()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["a non-2xx", () => jwksResponse({ error: "x" }, {}, 500)],
    ["a body without keys", () => jwksResponse({ nope: [] })],
    ["keys that are not a list", () => jwksResponse({ keys: {} })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
  ])("throws on %s", async (_name, make) => {
    vi.stubGlobal("fetch", vi.fn(async () => make()))
    await expect(googleKeySource(() => NOW)()).rejects.toThrow()
  })

  it("the test key set is refused in production, and wins over Google's elsewhere", async () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(() => setServiceKeysForTests(KEYS)).toThrow(/test-only/)
    vi.unstubAllEnvs()
    setServiceKeysForTests(KEYS)
    await expect(activeKeySource()()).resolves.toEqual(KEYS)
  })
})
