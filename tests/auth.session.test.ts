import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const verifyIdToken = vi.fn()

vi.mock("firebase-admin/app", () => ({
  getApps: () => [],
  initializeApp: () => ({ name: "test-app" }),
  applicationDefault: () => ({}),
}))
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken }),
}))

import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import { GET as tenancyGet, POST as tenancyPost } from "@/app/api/p5/tenancy/route"
import { GET as monitorGet } from "@/app/api/g0/monitor/route"
import { resetSessionStateForTests, resolveSession } from "@/platform/p5/session"
import { withSession } from "@/platform/http/withSession"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

const TOKENS: Record<string, Record<string, unknown>> = {
  "token-partner-a": { uid: "partner_a", firmId: "firmA", role: "partner" },
  "token-clerk-a": { uid: "clerk_a", firmId: "firmA", clearanceLevel: "privileged-restricted" },
  "token-partner-b": { uid: "partner_b", firmId: "firmB" },
  "token-ghost": { uid: "ghost_user" },
}

function authed(
  url: string,
  init: RequestInit & { token?: string; firm?: string | null } = {}
): Request {
  const { token = "token-partner-a", firm = "firmA", headers, ...rest } = init
  const h = new Headers(headers)
  if (token) h.set("Authorization", `Bearer ${token}`)
  if (firm) h.set("X-Firm-Id", firm)
  return new Request(url, { ...rest, headers: h })
}

beforeEach(() => {
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
  vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
  vi.stubEnv("FIREBASE_PROJECT_ID", "demo-sikander")
  verifyIdToken.mockReset()
  verifyIdToken.mockImplementation(async (token: string) => {
    const decoded = TOKENS[token]
    if (!decoded) throw new Error("Firebase ID token has invalid signature")
    return decoded
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
})

describe("firebase auth mode (default)", () => {
  it("defaults to firebase mode when SIKANDER_AUTH_MODE is unset", async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "")
    const res = await mattersGet(new Request("http://127.0.0.1/api/d1/matters?userId=partner_a"))
    expect(res.status).toBe(401)
  })

  it("rejects a request with no bearer token with 401", async () => {
    const res = await mattersGet(authed("http://127.0.0.1/api/d1/matters?userId=partner_a", { token: "" }))
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe("AUTH_REQUIRED")
    expect(verifyIdToken).not.toHaveBeenCalled()
  })

  it("rejects an invalid token with 401 without echoing the verifier error", async () => {
    const res = await mattersGet(authed("http://127.0.0.1/api/d1/matters", { token: "forged" }))
    expect(res.status).toBe(401)
    const json = (await res.json()) as { error: string; code: string }
    expect(json.code).toBe("AUTH_INVALID")
    expect(json.error).not.toMatch(/signature/)
  })

  it("verifies tokens with revocation checking", async () => {
    await mattersGet(authed("http://127.0.0.1/api/d1/matters"))
    expect(verifyIdToken).toHaveBeenCalledWith("token-partner-a", true)
  })

  it("returns 403 for a verified uid that is not provisioned", async () => {
    const res = await mattersGet(authed("http://127.0.0.1/api/d1/matters", { token: "token-ghost" }))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("USER_NOT_PROVISIONED")
  })

  it("fails closed with 503 when firebase-admin is not configured", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "")
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "")
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "")
    const res = await mattersGet(authed("http://127.0.0.1/api/d1/matters?userId=partner_a"))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_NOT_CONFIGURED")
  })

  it("fails closed on an unknown auth mode", async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "none")
    const res = await mattersGet(new Request("http://127.0.0.1/api/d1/matters?userId=partner_a"))
    expect(res.status).toBe(503)
  })

  it("requires the X-Firm-Id header and rejects a mismatching one", async () => {
    const missing = await mattersGet(authed("http://127.0.0.1/api/d1/matters", { firm: null }))
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { code: string }).code).toBe("FIRM_HEADER_REQUIRED")

    const wrong = await mattersGet(authed("http://127.0.0.1/api/d1/matters", { firm: "firmB" }))
    expect(wrong.status).toBe(403)
    expect(((await wrong.json()) as { code: string }).code).toBe("FIRM_MISMATCH")
  })

  it("rejects a firmId claim that disagrees with the provisioned record", async () => {
    TOKENS["token-bad-claim"] = { uid: "partner_a", firmId: "firmB" }
    const res = await mattersGet(
      authed("http://127.0.0.1/api/d1/matters", { token: "token-bad-claim", firm: "firmB" })
    )
    expect(res.status).toBe(403)
  })

  it("takes clearance from the claim but never above the provisioned record", async () => {
    const session = await resolveSession(
      authed("http://127.0.0.1/api/d1/matters", { token: "token-clerk-a" })
    )
    expect(session).toMatchObject({ userId: "clerk_a", firmId: "firmA", clearance: "confidential" })
  })
})

describe("identity binding", () => {
  it("returns 403 when the query userId differs from the session", async () => {
    const res = await mattersGet(authed("http://127.0.0.1/api/d1/matters?userId=partner_b"))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("IDENTITY_MISMATCH")
  })

  it("returns 403 when the body actorId differs from the session", async () => {
    const res = await mattersPost(
      authed("http://127.0.0.1/api/d1/matters", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "0f0e9b64-5a47-4bd4-9b0e-3a9d1f0e2a11",
        },
        body: JSON.stringify({
          action: "create",
          actorId: "associate_a",
          firmId: "firmA",
          clientId: "client_a",
          title: "Impersonated",
          courtId: "SHC",
          classification: "internal",
        }),
      })
    )
    expect(res.status).toBe(403)
    expect(getRuntimeStore().matters.size).toBe(0)
  })

  it("returns 403 when the body firmId differs from the session firm", async () => {
    const res = await mattersPost(
      authed("http://127.0.0.1/api/d1/matters", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "7d3d4a52-65a2-4b0f-8f38-3d8f0d7f7a20",
        },
        body: JSON.stringify({
          action: "create",
          firmId: "firmB",
          clientId: "client_a",
          title: "Cross firm",
          courtId: "SHC",
          classification: "internal",
        }),
      })
    )
    expect(res.status).toBe(403)
  })

  it("injects the session userId into the query when absent", async () => {
    const res = await mattersGet(authed("http://127.0.0.1/api/d1/matters?limit=10&cursor=0"))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { total: number }
    expect(json.total).toBe(0)
  })

  it("injects the session actorId into a JSON body when absent", async () => {
    const res = await mattersPost(
      authed("http://127.0.0.1/api/d1/matters", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "3b4d7e9c-1c1f-4e4a-9d62-2f8f3a1c0b55",
        },
        body: JSON.stringify({
          action: "create",
          firmId: "firmA",
          clientId: "client_a",
          title: "Injected actor",
          courtId: "SHC",
          classification: "internal",
        }),
      })
    )
    expect(res.status).toBe(200)
    const [matter] = [...getRuntimeStore().matters.values()]
    expect(matter?.title).toBe("Injected actor")
    expect(getRuntimeStore().members.has(getRuntimeStore().memberKey(matter!.id, "partner_a"))).toBe(
      true
    )
  })

  it("stops another user's tenancy session from being minted (C2)", async () => {
    const res = await tenancyGet(
      authed("http://127.0.0.1/api/p5/tenancy?view=session&userId=partner_b&limit=10&cursor=0")
    )
    expect(res.status).toBe(403)

    const own = await tenancyGet(
      authed("http://127.0.0.1/api/p5/tenancy?view=session&limit=10&cursor=0")
    )
    expect(own.status).toBe(200)
    const json = (await own.json()) as { sessionReference: { userId: string } }
    expect(json.sessionReference.userId).toBe("partner_a")
  })

  it("stops a non-partner escalating roles via update_role (C2)", async () => {
    const attempt = (actorId?: string) =>
      tenancyPost(
        authed("http://127.0.0.1/api/p5/tenancy", {
          token: "token-clerk-a",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": actorId
              ? "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
              : "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
          },
          body: JSON.stringify({
            action: "update_role",
            ...(actorId ? { actorId } : {}),
            firmId: "firmA",
            targetUserId: "clerk_a",
            nextRole: "associate",
            nextClearance: "privileged",
          }),
        })
      )
    // Claiming to be the partner is rejected outright…
    expect((await attempt("partner_a")).status).toBe(403)
    // …and acting as itself, the clerk fails the partner-only check.
    const own = await attempt()
    expect(own.status).toBeGreaterThanOrEqual(400)
    expect(getRuntimeStore().users.get("clerk_a")?.role).toBe("clerk")
    expect(getRuntimeStore().users.get("clerk_a")?.clearanceLevel).toBe("confidential")
  })

  it("treats userId as a filter (not the caller) on tenancy session_refs", async () => {
    const res = await tenancyGet(
      authed(
        "http://127.0.0.1/api/p5/tenancy?view=session_refs&firmId=firmA&userId=clerk_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const spoofed = await tenancyGet(
      authed(
        "http://127.0.0.1/api/p5/tenancy?view=session_refs&actorId=clerk_a&firmId=firmA&limit=10&cursor=0"
      )
    )
    expect(spoofed.status).toBe(403)
  })

  it("keeps the health monitor public", async () => {
    const res = await monitorGet(new Request("http://127.0.0.1/api/g0/monitor?limit=1&cursor=0"))
    expect(res.status).toBe(200)
  })
})

describe("error boundary", () => {
  it("returns a generic body with a stable code for unhandled errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await withSession(authed("http://127.0.0.1/api/x"), async () => {
      throw new Error("FirestoreError: projects/secret-project/databases/(default) PERMISSION_DENIED")
    })
    expect(res.status).toBe(500)
    const json = (await res.json()) as { error: string; code: string }
    expect(json).toEqual({ error: "internal error", code: "INTERNAL_ERROR" })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe("insecure-dev mode", () => {
  it("trusts the request identity when explicitly enabled", async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "insecure-dev")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const res = await mattersGet(new Request("http://127.0.0.1/api/d1/matters?userId=partner_a"))
    expect(res.status).toBe(200)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/insecure-dev/))
    warn.mockRestore()
  })

  it("is refused when NODE_ENV=production", async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "insecure-dev")
    vi.stubEnv("NODE_ENV", "production")
    const res = await mattersGet(new Request("http://127.0.0.1/api/d1/matters?userId=partner_a"))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_MISCONFIGURED")
  })
})
