// SEC-2 / U-7 / I-2 (final audits) and E-27: the Next.js session and the Cloud Functions API
// make the same identity decision. One table of cases runs through both implementations —
// platform/p5/session.ts resolveSession (firebase mode) and functions/src/p5/auth.ts
// bindHttpSession — and through the shared policy (platform/p5/identityPolicy.ts) they both
// call, and every case must come out the same: the same refusal (status and code; Next.js
// spells codes in upper case) or the same firm, role and effective clearance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const verifyIdToken = vi.fn()
vi.mock("firebase-admin/app", () => ({ getApps: () => [], initializeApp: () => ({ name: "t" }), applicationDefault: () => ({}) }))
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }))

// The functions runtime reads users/{uid} and firms/{firmId} through the Admin SDK: serve the
// same records from this table.
const records: { user?: Record<string, unknown>; firm?: Record<string, unknown> } = {}
vi.mock("../functions/src/admin", () => ({
  adminDb: () => ({
    collection: (name: string) => ({ doc: (id: string) => ({ name, id }) }),
    getAll: async (...refs: Array<{ name: string }>) =>
      refs.map((ref) => ({ data: () => (ref.name === "users" ? records.user : records.firm) })),
  }),
  adminAuth: () => ({}),
}))

import type { DecodedIdToken } from "firebase-admin/auth"
import { GET as mattersGet } from "@/app/api/d1/matters/route"
import { bindHttpSession } from "../functions/src/p5/auth"
import { AuthError, resetSessionStateForTests, resolveSession } from "@/platform/p5/session"
import { decideIdentity, IDENTITY_ROLES } from "@/platform/p5/identityPolicy"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { ROLES as FUNCTIONS_ROLES } from "../functions/src/p5/auth"
import type { Role } from "@/platform/spine/store"

type Outcome = { status: number; code: string } | { status: 200; firmId: string; role: string; clearance: string }

const UID = "parity_user"
const PARTNER_CLAIMS = { firmId: "firmA", role: "partner", clearanceLevel: "privileged-restricted" }
const PARTNER_RECORD = { id: UID, firmId: "firmA", role: "partner", clearanceLevel: "privileged-restricted", active: true }
const SECOND_FACTOR = { firebase: { sign_in_provider: "password", sign_in_second_factor: "totp" } }
const FIRST_FACTOR = { firebase: { sign_in_provider: "password" } }

type Case = {
  name: string
  claims: Record<string, unknown>
  header?: string
  user?: Record<string, unknown>
  firm?: Record<string, unknown>
  expected: Outcome
}

const CASES: Case[] = [
  { name: "an active partner with matching claims", claims: PARTNER_CLAIMS, user: PARTNER_RECORD, expected: { status: 200, firmId: "firmA", role: "partner", clearance: "privileged-restricted" } },
  { name: "no role claim", claims: { firmId: "firmA", clearanceLevel: "internal" }, user: PARTNER_RECORD, expected: { status: 403, code: "no_claims" } },
  { name: "no clearance claim", claims: { firmId: "firmA", role: "partner" }, user: PARTNER_RECORD, expected: { status: 403, code: "no_claims" } },
  { name: "no firm claim", claims: { role: "partner", clearanceLevel: "internal" }, user: PARTNER_RECORD, expected: { status: 403, code: "no_claims" } },
  { name: "an unknown clearance claim", claims: { ...PARTNER_CLAIMS, clearanceLevel: "secret" }, user: PARTNER_RECORD, expected: { status: 403, code: "no_claims" } },
  { name: "an inherited-key clearance claim", claims: { ...PARTNER_CLAIMS, clearanceLevel: "constructor" }, user: PARTNER_RECORD, expected: { status: 403, code: "no_claims" } },
  { name: "an unknown role claim", claims: { ...PARTNER_CLAIMS, role: "superuser" }, user: PARTNER_RECORD, expected: { status: 403, code: "no_claims" } },
  { name: "X-Firm-Id differs from the firm claim", claims: PARTNER_CLAIMS, header: "firmB", user: PARTNER_RECORD, expected: { status: 403, code: "firm_mismatch" } },
  { name: "no users record", claims: PARTNER_CLAIMS, expected: { status: 403, code: "inactive_user" } },
  { name: "a deactivated user (active: false)", claims: PARTNER_CLAIMS, user: { ...PARTNER_RECORD, active: false }, expected: { status: 403, code: "inactive_user" } },
  { name: "a record without active", claims: PARTNER_CLAIMS, user: { ...PARTNER_RECORD, active: undefined }, expected: { status: 403, code: "inactive_user" } },
  { name: "active as a string", claims: PARTNER_CLAIMS, user: { ...PARTNER_RECORD, active: "true" }, expected: { status: 403, code: "inactive_user" } },
  { name: "a record in another firm", claims: PARTNER_CLAIMS, user: { ...PARTNER_RECORD, firmId: "firmB" }, expected: { status: 403, code: "firm_mismatch" } },
  { name: "a malformed record role", claims: PARTNER_CLAIMS, user: { ...PARTNER_RECORD, role: "boss" }, expected: { status: 403, code: "no_claims" } },
  { name: "a malformed record clearance", claims: PARTNER_CLAIMS, user: { ...PARTNER_RECORD, clearanceLevel: "top" }, expected: { status: 403, code: "no_claims" } },
  { name: "demoted: record role differs from the token", claims: PARTNER_CLAIMS, user: { ...PARTNER_RECORD, role: "intern", clearanceLevel: "internal" }, expected: { status: 401, code: "claims_stale" } },
  { name: "a claim below the record restricts clearance", claims: { ...PARTNER_CLAIMS, clearanceLevel: "internal" }, user: PARTNER_RECORD, expected: { status: 200, firmId: "firmA", role: "partner", clearance: "internal" } },
  { name: "a record below the claim (clearance demoted) wins", claims: PARTNER_CLAIMS, user: { ...PARTNER_RECORD, clearanceLevel: "confidential" }, expected: { status: 200, firmId: "firmA", role: "partner", clearance: "confidential" } },
  { name: "MFA enforced for partners, first factor only", claims: { ...PARTNER_CLAIMS, ...FIRST_FACTOR }, user: PARTNER_RECORD, firm: { mfaEnforcedRoles: ["partner"] }, expected: { status: 403, code: "mfa_required" } },
  { name: "MFA enforced for partners, no firebase claim at all", claims: PARTNER_CLAIMS, user: PARTNER_RECORD, firm: { mfaEnforcedRoles: ["partner"] }, expected: { status: 403, code: "mfa_required" } },
  { name: "MFA enforced for partners, empty second factor", claims: { ...PARTNER_CLAIMS, firebase: { sign_in_second_factor: "" } }, user: PARTNER_RECORD, firm: { mfaEnforcedRoles: ["partner"] }, expected: { status: 403, code: "mfa_required" } },
  { name: "MFA enforced for partners, second factor present", claims: { ...PARTNER_CLAIMS, ...SECOND_FACTOR }, user: PARTNER_RECORD, firm: { mfaEnforcedRoles: ["partner"] }, expected: { status: 200, firmId: "firmA", role: "partner", clearance: "privileged-restricted" } },
  { name: "MFA enforced for associates only", claims: { ...PARTNER_CLAIMS, ...FIRST_FACTOR }, user: PARTNER_RECORD, firm: { mfaEnforcedRoles: ["associate"] }, expected: { status: 200, firmId: "firmA", role: "partner", clearance: "privileged-restricted" } },
  { name: "a malformed mfaEnforcedRoles enforces nothing", claims: { ...PARTNER_CLAIMS, ...FIRST_FACTOR }, user: PARTNER_RECORD, firm: { mfaEnforcedRoles: "partner" }, expected: { status: 200, firmId: "firmA", role: "partner", clearance: "privileged-restricted" } },
  { name: "an inactive user is refused before the MFA policy", claims: { ...PARTNER_CLAIMS, ...FIRST_FACTOR }, user: { ...PARTNER_RECORD, active: false }, firm: { mfaEnforcedRoles: ["partner"] }, expected: { status: 403, code: "inactive_user" } },
  { name: "a stale role is refused before the MFA policy", claims: { ...PARTNER_CLAIMS, role: "associate", ...FIRST_FACTOR }, user: PARTNER_RECORD, firm: { mfaEnforcedRoles: ["partner", "associate"] }, expected: { status: 401, code: "claims_stale" } },
]

function viaPolicy(c: Case): Outcome {
  const d = decideIdentity({ claims: c.claims, firmHeader: c.header ?? "firmA", user: c.user, firm: c.firm })
  return d.ok ? { status: 200, firmId: d.firmId, role: d.role, clearance: d.clearanceLevel } : { status: d.status, code: d.code }
}

async function viaFunctions(c: Case): Promise<Outcome> {
  records.user = c.user
  records.firm = c.firm
  try {
    const { caller } = await bindHttpSession({ uid: UID, ...c.claims } as unknown as DecodedIdToken, { "x-firm-id": c.header ?? "firmA" }, { mfaExempt: false })
    return { status: 200, firmId: caller.firmId, role: caller.role, clearance: caller.clearanceLevel }
  } catch (err) {
    const e = err as { status: number; code: string }
    return { status: e.status, code: e.code }
  }
}

async function viaNext(c: Case): Promise<Outcome> {
  const store = getRuntimeStore()
  store.users.delete(UID)
  if (c.user) store.users.set(UID, { ...c.user, id: UID } as never)
  store.firms.delete("firmA")
  if (c.firm) store.firms.set("firmA", { id: "firmA", ...c.firm } as never)
  verifyIdToken.mockImplementation(async () => ({ uid: UID, ...c.claims }))
  try {
    const session = await resolveSession(
      new Request("http://127.0.0.1/api/d1/matters", { headers: { Authorization: "Bearer t", "X-Firm-Id": c.header ?? "firmA" } })
    )
    if (session.mode !== "firebase") throw new Error("expected a firebase session")
    return { status: 200, firmId: session.firmId, role: session.role, clearance: session.clearance }
  } catch (err) {
    if (!(err instanceof AuthError)) throw err
    return { status: err.status, code: err.code.toLowerCase() }
  }
}

beforeEach(() => {
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
  vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
  vi.stubEnv("FIREBASE_PROJECT_ID", "demo-sikander")
  verifyIdToken.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
})

describe("identity parity: Next.js resolveSession == functions bindHttpSession == the shared policy", () => {
  it.each(CASES)("$name", async (c) => {
    expect(viaPolicy(c)).toEqual(c.expected)
    expect(await viaFunctions(c)).toEqual(c.expected)
    expect(await viaNext(c)).toEqual(c.expected)
  })

  it("the role lists agree: the policy, functions and platform/spine Role", () => {
    const spineRoles: Role[] = ["partner", "associate", "clerk", "intern", "accounts", "client"]
    expect([...IDENTITY_ROLES]).toEqual(spineRoles)
    expect([...FUNCTIONS_ROLES]).toEqual(spineRoles)
  })
})

describe("SEC-2 at the route boundary (the audit's probes)", () => {
  const get = () =>
    mattersGet(new Request("http://127.0.0.1/api/d1/matters", { headers: { Authorization: "Bearer t", "X-Firm-Id": "firmA" } }))

  it("a first-factor-only partner is refused when the firm enforces MFA for partners (403 MFA_REQUIRED)", async () => {
    getRuntimeStore().firms.set("firmA", { id: "firmA", mfaEnforcedRoles: ["partner"] })
    verifyIdToken.mockImplementation(async () => ({ uid: "partner_a", ...PARTNER_CLAIMS, ...FIRST_FACTOR }))
    const res = await get()
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("MFA_REQUIRED")
  })

  it("the same partner with a second factor is served", async () => {
    getRuntimeStore().firms.set("firmA", { id: "firmA", mfaEnforcedRoles: ["partner"] })
    verifyIdToken.mockImplementation(async () => ({ uid: "partner_a", ...PARTNER_CLAIMS, ...SECOND_FACTOR }))
    expect((await get()).status).toBe(200)
  })

  it("a users record with active:false is refused (403 INACTIVE_USER)", async () => {
    const store = getRuntimeStore()
    store.users.set("partner_a", { ...store.users.get("partner_a")!, active: false })
    verifyIdToken.mockImplementation(async () => ({ uid: "partner_a", ...PARTNER_CLAIMS }))
    const res = await get()
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("INACTIVE_USER")
  })

  it("a demoted user's old token is refused (401 CLAIMS_STALE)", async () => {
    const store = getRuntimeStore()
    store.users.set("partner_a", { ...store.users.get("partner_a")!, role: "intern", clearanceLevel: "internal" })
    verifyIdToken.mockImplementation(async () => ({ uid: "partner_a", ...PARTNER_CLAIMS }))
    const res = await get()
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe("CLAIMS_STALE")
  })

  it("a failed firm read fails closed (503 IDENTITY_UNAVAILABLE)", async () => {
    const repoModule = await import("@/platform/persistence/runtimeRepositories")
    const real = await repoModule.getRuntimeRepositories(getRuntimeStore())
    const spy = vi.spyOn(repoModule, "getRuntimeRepositories").mockResolvedValue({
      ...real,
      firms: {
        get: async () => {
          throw new Error("firestore unavailable")
        },
      },
    })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    verifyIdToken.mockImplementation(async () => ({ uid: "partner_a", ...PARTNER_CLAIMS }))
    const res = await get()
    expect(res.status).toBe(503)
    expect(((await res.json()) as { code: string }).code).toBe("IDENTITY_UNAVAILABLE")
    spy.mockRestore()
    err.mockRestore()
  })
})
