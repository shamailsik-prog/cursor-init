// SEC-6 (final security audit): "revoking" a P5 tenancy session reference did not refuse the
// user's next request. Ruling: no request presents a session reference — resolveSession
// authenticates the Firebase ID token (Authorization: Bearer, revocation-checked) and nothing
// else; there is no header, claim or cookie that carries a session-reference id — so the
// registry row is an administrative record only. This test pins that design: revoking or
// drift-revoking a reference changes the registry and the audit log, never authentication.
// Cutting a user's access is deactivateUser / setUserClaims (Cloud Functions), which flip
// users/{uid}.active or the role and revoke the refresh tokens (SEC-2 / SEC-3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const verifyIdToken = vi.fn()
vi.mock("firebase-admin/app", () => ({ getApps: () => [], initializeApp: () => ({ name: "t" }), applicationDefault: () => ({}) }))
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }))

import { GET as mattersGet } from "@/app/api/d1/matters/route"
import { resetSessionStateForTests } from "@/platform/p5/session"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { revokeTenancySessionReference, upsertTenancySessionReference } from "@/platform/p5/tenancyAdmin"

const ASSOCIATE_TOKEN = { uid: "associate_a", firmId: "firmA", role: "associate", clearanceLevel: "privileged" }

beforeEach(() => {
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
  vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
  vi.stubEnv("FIREBASE_PROJECT_ID", "demo-sikander")
  verifyIdToken.mockReset()
  verifyIdToken.mockImplementation(async () => ASSOCIATE_TOKEN)
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetSessionStateForTests()
  resetRuntimeStoreForTests()
})

const request = (headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1/api/d1/matters", { headers: { Authorization: "Bearer t", "X-Firm-Id": "firmA", ...headers } })

describe("SEC-6: a tenancy session reference is an administrative record, not a credential", () => {
  it("revoking every reference of a user leaves the user's authenticated requests unaffected", async () => {
    const store = getRuntimeStore()
    const ref = upsertTenancySessionReference(store, { user: store.users.get("associate_a")!, externalSessionId: "firebase-session-1" })
    expect((await mattersGet(request())).status).toBe(200)

    const { reference, auditEntry } = revokeTenancySessionReference(store, { actorId: "partner_a", firmId: "firmA", sessionReferenceId: ref.id, reason: "compromised" })
    // the registry and the audit log record the revocation …
    expect(reference.revokedAt).not.toBeNull()
    expect(store.tenancySessionReferences.get(ref.id)?.revokedAt).not.toBeNull()
    expect(auditEntry).toMatchObject({ firmId: "firmA" })
    // … and authentication does not read it: the same token is still accepted
    expect((await mattersGet(request())).status).toBe(200)
  })

  it("no request header names a session reference: sending the revoked id changes nothing", async () => {
    const store = getRuntimeStore()
    const ref = upsertTenancySessionReference(store, { user: store.users.get("associate_a")!, externalSessionId: "firebase-session-1" })
    revokeTenancySessionReference(store, { actorId: "partner_a", firmId: "firmA", sessionReferenceId: ref.id })
    for (const name of ["X-Session-Ref", "X-Session-Reference-Id", "X-Session-Id"]) {
      expect((await mattersGet(request({ [name]: ref.id }))).status).toBe(200)
    }
  })
})
