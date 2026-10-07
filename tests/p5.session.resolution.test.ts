/**
 * P5 session resolution (platform/p5/session.ts), unit level, with
 * firebase-admin, the runtime store and the repository layer stubbed. Covers
 * the branches the route-level suite (tests/auth.session.test.ts) left open
 * to surviving mutants of `npm run mutation` (docs/audits/mutation-report.md):
 * auth-mode parsing, the Bearer grammar, firebase-admin initialisation, the
 * uid / firm-claim / firm-header checks, the authoritative repository lookup,
 * and the exact error codes and messages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { User } from "@/platform/spine/store"

const admin = vi.hoisted(() => ({
  apps: [] as unknown[],
  initializeApp: vi.fn((opts: unknown) => ({ name: "app", opts })),
  applicationDefault: vi.fn(() => ({ kind: "adc" })),
  getAuth: vi.fn(),
  verifyIdToken: vi.fn(),
}))
vi.mock("firebase-admin/app", () => ({
  getApps: () => admin.apps,
  initializeApp: admin.initializeApp,
  applicationDefault: admin.applicationDefault,
}))
vi.mock("firebase-admin/auth", () => ({ getAuth: admin.getAuth }))

const runtime = vi.hoisted(() => ({
  store: null as unknown as import("@/platform/spine/store").SpineStore,
  repoUsers: new Map<string, User>(),
  repoFails: false,
  repoReads: 0,
}))
vi.mock("@/platform/spine/runtimeStore", () => ({ getRuntimeStore: () => runtime.store }))
vi.mock("@/platform/persistence/runtimeRepositories", () => ({
  getRuntimeRepositories: async () => ({
    users: {
      get: async (id: string) => {
        runtime.repoReads += 1
        if (runtime.repoFails) throw new Error("firestore unreachable")
        return runtime.repoUsers.get(id) ?? null
      },
    },
  }),
}))

import {
  AuthError,
  FIRM_HEADER,
  loadUserRecord,
  resetSessionStateForTests,
  resolveAuthMode,
  resolveSession,
} from "@/platform/p5/session"
import { newStore } from "@/platform/spine/store"

const partner: User = { id: "partner_a", firmId: "firmA", role: "partner", clearanceLevel: "privileged-restricted" }

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1/api/x", { headers })
}
const good = (extra: Record<string, string> = {}) =>
  req({ authorization: "Bearer tok", [FIRM_HEADER]: "firmA", ...extra })

async function authError(p: Promise<unknown>): Promise<AuthError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(AuthError)
  return err as AuthError
}

let warn: ReturnType<typeof vi.spyOn>
let errorLog: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetSessionStateForTests()
  runtime.store = newStore()
  runtime.repoUsers = new Map([[partner.id, partner]])
  runtime.repoFails = false
  runtime.repoReads = 0
  admin.apps = []
  admin.initializeApp.mockClear()
  admin.applicationDefault.mockClear()
  admin.verifyIdToken.mockReset()
  admin.verifyIdToken.mockResolvedValue({ uid: "partner_a", firmId: "firmA" })
  admin.getAuth.mockReset()
  admin.getAuth.mockImplementation(() => ({ verifyIdToken: admin.verifyIdToken }))
  vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
  vi.stubEnv("FIREBASE_PROJECT_ID", "demo-p")
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "")
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "")
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetSessionStateForTests()
})

describe("resolveAuthMode", () => {
  const env = (vars: Record<string, string | undefined>) => vars as NodeJS.ProcessEnv

  it("is firebase when unset, empty, or firebase in any case and padding", () => {
    for (const v of [undefined, "", "firebase", "FIREBASE", "  Firebase  "]) {
      expect(resolveAuthMode(env({ SIKANDER_AUTH_MODE: v }))).toBe("firebase")
    }
  })

  it("accepts insecure-dev in any case and padding under NODE_ENV test or development", () => {
    for (const NODE_ENV of ["test", "development"]) {
      expect(resolveAuthMode(env({ SIKANDER_AUTH_MODE: " Insecure-Dev ", NODE_ENV }))).toBe("insecure-dev")
    }
  })

  it("refuses insecure-dev outside test/development, naming NODE_ENV (or that it is unset)", () => {
    const prod = (() => {
      try {
        resolveAuthMode(env({ SIKANDER_AUTH_MODE: "insecure-dev", NODE_ENV: "production" }))
      } catch (e) {
        return e as AuthError
      }
    })()
    expect(prod).toMatchObject({ status: 503, code: "AUTH_MISCONFIGURED", name: "AuthError" })
    expect(prod?.message).toBe("SIKANDER_AUTH_MODE=insecure-dev is refused when NODE_ENV=production")
    expect(() => resolveAuthMode(env({ SIKANDER_AUTH_MODE: "insecure-dev" }))).toThrow(
      "SIKANDER_AUTH_MODE=insecure-dev is refused when NODE_ENV=(unset)"
    )
  })

  it.each(["K_SERVICE", "VERCEL", "VERCEL_ENV", "FUNCTION_TARGET", "FIREBASE_CONFIG", "GAE_SERVICE"])(
    "refuses insecure-dev on a hosted runtime (%s set), naming the marker",
    (marker) => {
      let err: AuthError | undefined
      try {
        resolveAuthMode(env({ SIKANDER_AUTH_MODE: "insecure-dev", NODE_ENV: "test", [marker]: "1" }))
      } catch (e) {
        err = e as AuthError
      }
      expect(err).toMatchObject({ status: 503, code: "AUTH_MISCONFIGURED" })
      expect(err?.message).toBe(`SIKANDER_AUTH_MODE=insecure-dev is refused on a hosted runtime (${marker} is set)`)
    }
  )

  it("ignores an empty hosted-runtime marker", () => {
    expect(resolveAuthMode(env({ SIKANDER_AUTH_MODE: "insecure-dev", NODE_ENV: "test", K_SERVICE: "" }))).toBe(
      "insecure-dev"
    )
  })

  it("warns once per process that insecure-dev trusts the request, and again after a reset", () => {
    const e = env({ SIKANDER_AUTH_MODE: "insecure-dev", NODE_ENV: "test" })
    resolveAuthMode(e)
    resolveAuthMode(e)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("is TRUSTED WITHOUT AUTHENTICATION")
    resetSessionStateForTests()
    resolveAuthMode(e)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it("warns on the first insecure-dev resolution of a freshly loaded module (no reset needed)", async () => {
    vi.resetModules()
    const fresh = await import("@/platform/p5/session")
    fresh.resolveAuthMode(env({ SIKANDER_AUTH_MODE: "insecure-dev", NODE_ENV: "test" }))
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("fails closed on any other mode, naming it", () => {
    expect(() => resolveAuthMode(env({ SIKANDER_AUTH_MODE: "None" }))).toThrow('unknown SIKANDER_AUTH_MODE "none"')
    try {
      resolveAuthMode(env({ SIKANDER_AUTH_MODE: "none" }))
    } catch (e) {
      expect(e).toMatchObject({ status: 503, code: "AUTH_MISCONFIGURED" })
    }
  })
})

describe("firebase-admin initialisation", () => {
  it.each(["FIREBASE_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"])(
    "is not configured when every variable is blank (%s whitespace only)",
    async (name) => {
      vi.stubEnv("FIREBASE_PROJECT_ID", "")
      vi.stubEnv(name, "   ")
      const err = await authError(resolveSession(good()))
      expect(err).toMatchObject({ status: 503, code: "AUTH_NOT_CONFIGURED", message: "auth not configured" })
      expect(admin.initializeApp).not.toHaveBeenCalled()
    }
  )

  it("is not configured when the variables are unset (not just blank)", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", undefined)
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", undefined)
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined)
    const err = await authError(resolveSession(good()))
    expect(err).toMatchObject({ status: 503, code: "AUTH_NOT_CONFIGURED" })
  })

  it("reads the project id when FIREBASE_PROJECT_ID is unset and GOOGLE_CLOUD_PROJECT is set", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", undefined)
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "gcp-only")
    await resolveSession(good())
    expect(admin.initializeApp).toHaveBeenCalledWith({ projectId: "gcp-only" })
  })

  it("initialises without a project id when only credentials are set and both project variables are unset", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", undefined)
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", undefined)
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/k.json")
    await resolveSession(good())
    expect(admin.initializeApp).toHaveBeenCalledWith({ credential: { kind: "adc" } })
  })

  it("ignores blank GOOGLE_APPLICATION_CREDENTIALS (no application-default credential)", async () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "   ")
    await resolveSession(good())
    expect(admin.initializeApp).toHaveBeenCalledWith({ projectId: "demo-p" })
    expect(admin.applicationDefault).not.toHaveBeenCalled()
  })

  it("initialises once, with the trimmed FIREBASE_PROJECT_ID, and verifies with revocation checking", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "  demo-p  ")
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "other")
    await resolveSession(good())
    await resolveSession(good())
    expect(admin.initializeApp).toHaveBeenCalledTimes(1)
    expect(admin.initializeApp).toHaveBeenCalledWith({ projectId: "demo-p" })
    expect(admin.verifyIdToken).toHaveBeenCalledWith("tok", true)
  })

  it("falls back to GOOGLE_CLOUD_PROJECT for the project id", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "")
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", " gcp-p ")
    await resolveSession(good())
    expect(admin.initializeApp).toHaveBeenCalledWith({ projectId: "gcp-p" })
  })

  it("uses application default credentials only when GOOGLE_APPLICATION_CREDENTIALS is set", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "")
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", " /k.json ")
    await resolveSession(good())
    expect(admin.initializeApp).toHaveBeenCalledWith({ credential: { kind: "adc" } })
  })

  it("reuses an existing firebase-admin app", async () => {
    const existing = { name: "existing" }
    admin.apps = [existing]
    await resolveSession(good())
    expect(admin.initializeApp).not.toHaveBeenCalled()
    expect(admin.getAuth).toHaveBeenCalledWith(existing)
  })

  it("forgets a failed initialisation so the next request retries", async () => {
    admin.getAuth.mockImplementationOnce(() => {
      throw new Error("admin init failed")
    })
    await expect(resolveSession(good())).rejects.toThrow("admin init failed")
    await expect(resolveSession(good())).resolves.toMatchObject({ userId: "partner_a" })
  })
})

describe("Bearer token grammar", () => {
  it.each([
    ["Bearer tok", "tok"],
    ["bearer tok", "tok"],
    ["Bearer   tok", "tok"],
    ["Bearer tok   ", "tok"],
  ])("accepts %j", async (header, token) => {
    await resolveSession(req({ authorization: header, [FIRM_HEADER]: "firmA" }))
    expect(admin.verifyIdToken).toHaveBeenCalledWith(token, true)
  })

  it.each(["", "Basic tok", "Basic Bearer tok", "Bearer", "Bearer tok extra", "Bearertok"])(
    "rejects %j with 401 AUTH_REQUIRED before verifying",
    async (header) => {
      const err = await authError(resolveSession(req(header ? { authorization: header, [FIRM_HEADER]: "firmA" } : {})))
      expect(err).toMatchObject({ status: 401, code: "AUTH_REQUIRED", message: "authentication required" })
      expect(admin.verifyIdToken).not.toHaveBeenCalled()
    }
  )
})

describe("token verification", () => {
  it("maps a verifier error to 401 AUTH_INVALID, logging the reason server-side only", async () => {
    admin.verifyIdToken.mockRejectedValue(new Error("signature mismatch"))
    const err = await authError(resolveSession(good()))
    expect(err).toMatchObject({ status: 401, code: "AUTH_INVALID", message: "invalid or expired token" })
    expect(warn).toHaveBeenCalledWith("[auth] ID token rejected", "signature mismatch")
  })

  it.each([[null], [{}], [{ uid: "" }], [{ uid: 42 }]])("rejects a decoded token without a uid (%j)", async (decoded) => {
    admin.verifyIdToken.mockResolvedValue(decoded)
    const err = await authError(resolveSession(good()))
    expect(err).toMatchObject({ status: 401, code: "AUTH_INVALID", message: "invalid or expired token" })
  })

  it("403 USER_NOT_PROVISIONED for a verified uid with no record", async () => {
    admin.verifyIdToken.mockResolvedValue({ uid: "ghost" })
    const err = await authError(resolveSession(good()))
    expect(err).toMatchObject({ status: 403, code: "USER_NOT_PROVISIONED", message: "user not provisioned" })
  })
})

describe("firm binding", () => {
  it("takes the firm from the record when the token has no firm claim, or a non-string one", async () => {
    for (const firmId of [undefined, 42]) {
      admin.verifyIdToken.mockResolvedValue({ uid: "partner_a", firmId })
      await expect(resolveSession(good())).resolves.toMatchObject({ firmId: "firmA", userId: "partner_a" })
    }
  })

  it("refuses a firm claim that disagrees with the record even when the header matches the record", async () => {
    admin.verifyIdToken.mockResolvedValue({ uid: "partner_a", firmId: "firmB" })
    const err = await authError(resolveSession(good()))
    expect(err).toMatchObject({ status: 403, code: "FIRM_MISMATCH", message: "firm scope mismatch" })
  })

  it("400 FIRM_HEADER_REQUIRED when X-Firm-Id is absent or blank", async () => {
    const variants: Record<string, string>[] = [
      { authorization: "Bearer tok" },
      { authorization: "Bearer tok", [FIRM_HEADER]: "  " },
    ]
    for (const headers of variants) {
      const err = await authError(resolveSession(req(headers)))
      expect(err).toMatchObject({ status: 400, code: "FIRM_HEADER_REQUIRED", message: "X-Firm-Id header required" })
    }
  })

  it("trims the X-Firm-Id header and refuses another firm's id", async () => {
    await expect(resolveSession(good({ [FIRM_HEADER]: "  firmA " }))).resolves.toMatchObject({ firmId: "firmA" })
    const err = await authError(resolveSession(good({ [FIRM_HEADER]: "firmB" })))
    expect(err).toMatchObject({ status: 403, code: "FIRM_MISMATCH", message: "firm scope mismatch" })
  })
})

describe("role and clearance claims", () => {
  it.each(["partner", "associate", "clerk", "intern", "accounts", "client"] as const)(
    "a known role claim (%s) that differs from the record is ignored, with a warning",
    async (role) => {
      const recordRole = role === "clerk" ? "partner" : "clerk"
      runtime.repoUsers.set("u2", { id: "u2", firmId: "firmA", role: recordRole, clearanceLevel: "internal" })
      admin.verifyIdToken.mockResolvedValue({ uid: "u2", role })
      await expect(resolveSession(good())).resolves.toMatchObject({ role: recordRole })
      expect(warn).toHaveBeenCalledWith("[auth] role claim for u2 differs from record; using record")
    }
  )

  it("does not warn for a matching, unknown or non-string role claim", async () => {
    for (const role of ["partner", "admin", 7]) {
      admin.verifyIdToken.mockResolvedValue({ uid: "partner_a", role })
      await expect(resolveSession(good())).resolves.toMatchObject({ role: "partner" })
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it("lets a clearance claim restrict but never raise the record, and ignores an unknown one", async () => {
    runtime.repoUsers.set("u3", { id: "u3", firmId: "firmA", role: "associate", clearanceLevel: "confidential" })
    const clearance = async (clearanceLevel: unknown) => {
      admin.verifyIdToken.mockResolvedValue({ uid: "u3", clearanceLevel })
      return ((await resolveSession(good())) as { clearance: string }).clearance
    }
    expect(await clearance("internal")).toBe("internal")
    expect(await clearance("privileged-restricted")).toBe("confidential")
    expect(await clearance("confidential")).toBe("confidential")
    expect(await clearance("top-secret")).toBe("confidential")
  })

  it("returns exactly the verified session", async () => {
    await expect(resolveSession(good())).resolves.toEqual({
      mode: "firebase",
      userId: "partner_a",
      firmId: "firmA",
      role: "partner",
      clearance: "privileged-restricted",
    })
  })
})

describe("loadUserRecord", () => {
  it("returns the cached record without reading the repository unless the repository is preferred", async () => {
    const store = newStore()
    const cached: User = { ...partner, clearanceLevel: "internal" }
    store.users.set(cached.id, cached)
    expect(await loadUserRecord(cached.id, { store })).toBe(cached)
    expect(runtime.repoReads).toBe(0)
    expect(await loadUserRecord(cached.id, { store, preferRepository: true })).toBe(partner)
    expect(runtime.repoReads).toBe(1)
    expect(store.users.get(cached.id)).toBe(partner)
  })

  it("hydrates the store from the repository on a miss", async () => {
    const store = newStore()
    expect(await loadUserRecord("partner_a", { store })).toBe(partner)
    expect(store.users.get("partner_a")).toBe(partner)
  })

  it("uses the runtime store when none is passed", async () => {
    expect(await loadUserRecord("partner_a")).toBe(partner)
    expect(runtime.store.users.get("partner_a")).toBe(partner)
  })

  it("fails closed (503 IDENTITY_UNAVAILABLE) when the authoritative repository is unreachable", async () => {
    const store = newStore()
    store.users.set(partner.id, partner)
    runtime.repoFails = true
    const err = await authError(loadUserRecord(partner.id, { store, preferRepository: true }))
    expect(err).toMatchObject({ status: 503, code: "IDENTITY_UNAVAILABLE", message: "identity service unavailable" })
    expect(errorLog).toHaveBeenCalledWith("[auth] user lookup failed", expect.any(Error))
  })

  it("falls back to the cached record (or null) when a non-authoritative lookup fails", async () => {
    runtime.repoFails = true
    const store = newStore()
    expect(await loadUserRecord("partner_a", { store })).toBeNull()
    const other: User = { ...partner, id: "other" }
    store.users.set(other.id, other)
    runtime.repoUsers.clear()
    runtime.repoFails = false
    expect(await loadUserRecord("other", { store })).toBe(other)
  })

  it("evicts a cached user the authoritative repository no longer has", async () => {
    const store = newStore()
    const stale: User = { ...partner, id: "gone" }
    store.users.set(stale.id, stale)
    expect(await loadUserRecord("gone", { store, preferRepository: true })).toBeNull()
    expect(store.users.has("gone")).toBe(false)
  })

  it("answers null for a user in neither the store nor the repository", async () => {
    expect(await loadUserRecord("missing", { store: newStore() })).toBeNull()
  })
})
