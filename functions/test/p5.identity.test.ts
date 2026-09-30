import { beforeEach, describe, expect, it } from "vitest"
import { HttpsError } from "firebase-functions/v2/https"
import { adminAuth, adminDb } from "../src/admin"
import { HttpError, toHttpsError } from "../src/http/errors"
import { callerWithoutFirm, requireAuth } from "../src/p5/auth"
import {
  createFirmUserHandler,
  deactivateUserHandler,
  onboardFirmHandler,
  setUserClaimsHandler,
} from "../src/p5/identity"
import { EMULATORS, callableAuth, mintIdToken, uniq } from "./emu"

async function httpsErrorOf(p: Promise<unknown>): Promise<HttpsError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(HttpsError)
    return e as HttpsError
  }
  throw new Error("expected HttpsError, promise resolved")
}

function expectHttps(err: HttpsError, code: string, detail: string) {
  expect({ code: err.code, details: err.details }).toEqual({ code, details: { code: detail } })
}

async function auditRows(actorId: string, action: string) {
  const snap = await adminDb().collection("audit_log").where("actorId", "==", actorId).where("action", "==", action).get()
  return snap.docs.map((d) => d.data())
}

async function auditCount(actorId: string, action: string): Promise<number> {
  return (await auditRows(actorId, action)).length
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A request as the onCall runtime would hand it to the handler. */
async function req(token: string | null, data: Record<string, unknown>) {
  return { auth: token ? await callableAuth(token) : undefined, data } as never
}

const partnerClaims = (firmId: string, clearanceLevel = "privileged-restricted") => ({
  firmId,
  role: "partner",
  clearanceLevel,
})

describe("toHttpsError", () => {
  it.each([
    [400, "bad", "invalid-argument"],
    [401, "token_revoked", "unauthenticated"],
    [403, "partner_only", "permission-denied"],
    [409, "already_exists", "already-exists"],
    [409, "already_onboarded", "failed-precondition"],
    [503, "audit_unavailable", "unavailable"],
  ])("HttpError(%i, %s) → %s with the code in details", (status, code, expected) => {
    const err = toHttpsError(new HttpError(status, code))
    expect(err).toBeInstanceOf(HttpsError)
    expectHttps(err, expected, code)
  })

  it("non-HttpError → internal (no detail leak)", () => {
    const err = toHttpsError(new Error("secret stack detail"))
    expectHttps(err, "internal", "internal")
    expect(err.message).not.toContain("secret")
  })
})

describe.skipIf(!EMULATORS)("callerWithoutFirm (Auth emulator)", () => {
  it("returns uid and claims for a user without firm claims", async () => {
    const { uid, token } = await mintIdToken({ platformAdmin: true })
    const res = await callerWithoutFirm(await callableAuth(token))
    expect(res.uid).toBe(uid)
    expect(res.claims.platformAdmin).toBe(true)
  })

  it("no auth → 401 missing_token; revoked → token_revoked; disabled → user_disabled", async () => {
    await expect(callerWithoutFirm(undefined)).rejects.toMatchObject({ status: 401, code: "missing_token" })

    const a = await mintIdToken(null)
    const authA = await callableAuth(a.token)
    await sleep(1100)
    await adminAuth().revokeRefreshTokens(a.uid)
    await expect(callerWithoutFirm(authA)).rejects.toMatchObject({ status: 401, code: "token_revoked" })

    const b = await mintIdToken(null)
    const authB = await callableAuth(b.token)
    await adminAuth().updateUser(b.uid, { disabled: true })
    await expect(callerWithoutFirm(authB)).rejects.toMatchObject({ status: 401, code: "user_disabled" })
  })
})

describe.skipIf(!EMULATORS)("onboardFirm", () => {
  const ACTION = "identity.onboardFirm"
  const bootstrapRef = () => adminDb().collection("platform").doc("bootstrap")

  beforeEach(async () => {
    await bootstrapRef().delete()
  })

  it("bootstrap: first caller creates the firm, becomes its partner, and the bootstrap marker is written", async () => {
    const { uid, token } = await mintIdToken(null)
    const res = (await onboardFirmHandler(await req(token, { name: "  Sikander & Co  " }))) as { firmId: string }
    expect(typeof res.firmId).toBe("string")

    const firm = (await adminDb().collection("firms").doc(res.firmId).get()).data()
    expect(firm).toMatchObject({ name: "Sikander & Co", dataResidency: "PK", plan: "internal" })
    expect(firm?.createdAt).toBeDefined()

    const marker = (await bootstrapRef().get()).data()
    expect(marker?.firstFirmId).toBe(res.firmId)
    expect(marker?.at).toBeDefined()

    const user = await adminAuth().getUser(uid)
    expect(user.customClaims).toEqual({ firmId: res.firmId, role: "partner", clearanceLevel: "privileged-restricted" })

    const userDoc = (await adminDb().collection("users").doc(uid).get()).data()
    expect(userDoc).toMatchObject({ firmId: res.firmId, role: "partner", clearanceLevel: "privileged-restricted", active: true })

    const rows = await auditRows(uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ firmId: res.firmId, target: `firms/${res.firmId}`, decision: "allow", reason: "ok" })
  })

  it("after bootstrap, a non-admin caller → permission-denied bootstrap_closed; no firm, one deny row", async () => {
    const first = await mintIdToken(null)
    await onboardFirmHandler(await req(first.token, { name: "First" }))

    const { uid, token } = await mintIdToken(null)
    const err = await httpsErrorOf(onboardFirmHandler(await req(token, { name: "Second" })))
    expectHttps(err, "permission-denied", "bootstrap_closed")
    expect((await adminAuth().getUser(uid)).customClaims ?? {}).toEqual({})
    const rows = await auditRows(uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "deny", reason: "bootstrap_closed" })
  })

  it("after bootstrap, a platformAdmin caller may onboard another firm (platformAdmin claim kept)", async () => {
    const first = await mintIdToken(null)
    await onboardFirmHandler(await req(first.token, { name: "First" }))

    const { uid, token } = await mintIdToken({ platformAdmin: true })
    const res = (await onboardFirmHandler(await req(token, { name: "Second" }))) as { firmId: string }
    expect((await adminAuth().getUser(uid)).customClaims).toEqual({
      platformAdmin: true,
      firmId: res.firmId,
      role: "partner",
      clearanceLevel: "privileged-restricted",
    })
    expect((await bootstrapRef().get()).data()?.firstFirmId).not.toBe(res.firmId)
    expect(await auditCount(uid, ACTION)).toBe(1)
  })

  it("platformAdmin: 'true' (string) is not an admin", async () => {
    const first = await mintIdToken(null)
    await onboardFirmHandler(await req(first.token, { name: "First" }))
    const { uid, token } = await mintIdToken({ platformAdmin: "true" })
    const err = await httpsErrorOf(onboardFirmHandler(await req(token, { name: "X" })))
    expectHttps(err, "permission-denied", "bootstrap_closed")
    expect(await auditCount(uid, ACTION)).toBe(1)
  })

  it("concurrent bootstrap: exactly one caller wins", async () => {
    const a = await mintIdToken(null)
    const b = await mintIdToken(null)
    const results = await Promise.allSettled([
      onboardFirmHandler(await req(a.token, { name: "A" })),
      onboardFirmHandler(await req(b.token, { name: "B" })),
    ])
    const ok = results.filter((r) => r.status === "fulfilled")
    const denied = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
    expect(ok).toHaveLength(1)
    expect(denied).toHaveLength(1)
    expectHttps(denied[0].reason as HttpsError, "permission-denied", "bootstrap_closed")
    expect(await auditCount(a.uid, ACTION)).toBe(1)
    expect(await auditCount(b.uid, ACTION)).toBe(1)
  })

  it("caller already holding a firmId claim → failed-precondition already_onboarded", async () => {
    const { uid, token } = await mintIdToken({ ...partnerClaims(uniq("firm")), platformAdmin: true })
    const err = await httpsErrorOf(onboardFirmHandler(await req(token, { name: "Again" })))
    expectHttps(err, "failed-precondition", "already_onboarded")
    expect(await bootstrapRef().get()).toMatchObject({ exists: false })
    expect(await auditCount(uid, ACTION)).toBe(1)
  })

  it.each([[""], ["   "], ["x".repeat(201)], [42], [undefined]])("name %j → invalid-argument invalid_name", async (name) => {
    const { uid, token } = await mintIdToken(null)
    const err = await httpsErrorOf(onboardFirmHandler(await req(token, { name })))
    expectHttps(err, "invalid-argument", "invalid_name")
    expect(await bootstrapRef().get()).toMatchObject({ exists: false })
    expect(await auditCount(uid, ACTION)).toBe(1)
  })

  it("a 200-char name is accepted", async () => {
    const { token } = await mintIdToken(null)
    await expect(onboardFirmHandler(await req(token, { name: "n".repeat(200) }))).resolves.toHaveProperty("firmId")
  })

  it("unauthenticated → unauthenticated missing_token, audited as anonymous", async () => {
    const before = await auditCount("anonymous", ACTION)
    const err = await httpsErrorOf(onboardFirmHandler(await req(null, { name: "X" })))
    expectHttps(err, "unauthenticated", "missing_token")
    expect(await auditCount("anonymous", ACTION)).toBe(before + 1)
  })

  it("revoked session → unauthenticated token_revoked", async () => {
    const { uid, token } = await mintIdToken(null)
    const request = await req(token, { name: "X" })
    await sleep(1100)
    await adminAuth().revokeRefreshTokens(uid)
    const err = await httpsErrorOf(onboardFirmHandler(request))
    expectHttps(err, "unauthenticated", "token_revoked")
    expect(await auditCount(uid, ACTION)).toBe(1)
  })
})

describe.skipIf(!EMULATORS)("createFirmUser", () => {
  const ACTION = "identity.createFirmUser"

  it("partner creates a user: Auth user, claims, users doc, allow row; returns { uid }", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const email = `${uniq("new")}@example.test`
    const res = (await createFirmUserHandler(
      await req(partner.token, { firmId, email, role: "associate", clearanceLevel: "confidential" })
    )) as { uid: string }

    const user = await adminAuth().getUser(res.uid)
    expect(user.email).toBe(email)
    expect(user.customClaims).toEqual({ firmId, role: "associate", clearanceLevel: "confidential" })
    const doc = (await adminDb().collection("users").doc(res.uid).get()).data()
    expect(doc).toMatchObject({ firmId, role: "associate", clearanceLevel: "confidential", mfaEnabled: false, active: true })
    expect(doc?.createdAt).toBeDefined()

    const rows = await auditRows(partner.uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ firmId, target: `users/${res.uid}`, decision: "allow", reason: "ok" })
  })

  it("associate caller → permission-denied partner_only", async () => {
    const firmId = uniq("firm")
    const assoc = await mintIdToken({ firmId, role: "associate", clearanceLevel: "confidential" })
    const email = `${uniq("new")}@example.test`
    const err = await httpsErrorOf(
      createFirmUserHandler(await req(assoc.token, { firmId, email, role: "intern", clearanceLevel: "internal" }))
    )
    expectHttps(err, "permission-denied", "partner_only")
    await expect(adminAuth().getUserByEmail(email)).rejects.toMatchObject({ code: "auth/user-not-found" })
    const rows = await auditRows(assoc.uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ firmId, decision: "deny", reason: "partner_only" })
  })

  it("firmId of another firm → permission-denied firm_mismatch", async () => {
    const partner = await mintIdToken(partnerClaims(uniq("firm")))
    const err = await httpsErrorOf(
      createFirmUserHandler(
        await req(partner.token, {
          firmId: uniq("other"),
          email: `${uniq("n")}@example.test`,
          role: "clerk",
          clearanceLevel: "internal",
        })
      )
    )
    expectHttps(err, "permission-denied", "firm_mismatch")
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })

  it.each([
    [{ role: "root" }, "invalid_role"],
    [{ role: "constructor" }, "invalid_role"],
    [{ clearanceLevel: "top-secret" }, "invalid_clearance"],
    [{ clearanceLevel: "constructor" }, "invalid_clearance"],
    [{ clearanceLevel: "__proto__" }, "invalid_clearance"],
    [{ email: "not-an-email" }, "invalid_email"],
    [{ email: 7 }, "invalid_email"],
  ])("invalid input %j → invalid-argument %s", async (patch, detail) => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const data = { firmId, email: `${uniq("n")}@example.test`, role: "clerk", clearanceLevel: "internal", ...patch }
    const err = await httpsErrorOf(createFirmUserHandler(await req(partner.token, data)))
    expectHttps(err, "invalid-argument", detail)
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })

  it("clearance above the caller's → permission-denied exceeds_own_clearance", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId, "confidential"))
    const email = `${uniq("n")}@example.test`
    const err = await httpsErrorOf(
      createFirmUserHandler(await req(partner.token, { firmId, email, role: "associate", clearanceLevel: "privileged" }))
    )
    expectHttps(err, "permission-denied", "exceeds_own_clearance")
    await expect(adminAuth().getUserByEmail(email)).rejects.toMatchObject({ code: "auth/user-not-found" })
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })

  it("platformAdmin in the payload → permission-denied platform_admin_forbidden", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken({ ...partnerClaims(firmId), platformAdmin: true })
    const email = `${uniq("n")}@example.test`
    const err = await httpsErrorOf(
      createFirmUserHandler(
        await req(partner.token, { firmId, email, role: "associate", clearanceLevel: "internal", platformAdmin: true })
      )
    )
    expectHttps(err, "permission-denied", "platform_admin_forbidden")
    await expect(adminAuth().getUserByEmail(email)).rejects.toMatchObject({ code: "auth/user-not-found" })
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })

  it("duplicate email → already-exists", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const email = `${uniq("dup")}@example.test`
    await adminAuth().createUser({ email })
    const err = await httpsErrorOf(
      createFirmUserHandler(await req(partner.token, { firmId, email, role: "clerk", clearanceLevel: "internal" }))
    )
    expectHttps(err, "already-exists", "already_exists")
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })
})

describe.skipIf(!EMULATORS)("setUserClaims", () => {
  const ACTION = "identity.setUserClaims"

  async function member(firmId: string, extra: Record<string, unknown> = {}) {
    const m = await mintIdToken({ firmId, role: "associate", clearanceLevel: "confidential", ...extra })
    await adminDb().collection("users").doc(m.uid).set({ firmId, role: "associate", clearanceLevel: "confidential", active: true })
    return m
  }

  it("partner updates a same-firm user: claims merged, unrelated claims kept, users doc updated, refresh tokens revoked", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const target = await member(firmId, { locale: "ur-PK" })
    const targetAuth = await callableAuth(target.token)
    await sleep(1100)

    const res = await setUserClaimsHandler(
      await req(partner.token, { firmId, uid: target.uid, role: "clerk", clearanceLevel: "privileged" })
    )
    expect(res).toEqual({ uid: target.uid, role: "clerk", clearanceLevel: "privileged" })
    expect((await adminAuth().getUser(target.uid)).customClaims).toEqual({
      firmId,
      role: "clerk",
      clearanceLevel: "privileged",
      locale: "ur-PK",
    })
    const doc = (await adminDb().collection("users").doc(target.uid).get()).data()
    expect(doc).toMatchObject({ firmId, role: "clerk", clearanceLevel: "privileged", active: true })

    // The old session is revoked so the new claims take effect on the next sign-in.
    const { callerFromCallable } = await import("../src/p5/auth")
    await expect(callerFromCallable(targetAuth, firmId)).rejects.toMatchObject({ status: 401, code: "token_revoked" })

    const rows = await auditRows(partner.uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ firmId, target: `users/${target.uid}`, decision: "allow", reason: "ok" })
  })

  it("changing only role keeps the existing clearance", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const target = await member(firmId)
    await setUserClaimsHandler(await req(partner.token, { firmId, uid: target.uid, role: "intern" }))
    expect((await adminAuth().getUser(target.uid)).customClaims).toEqual({ firmId, role: "intern", clearanceLevel: "confidential" })
  })

  it("an existing platformAdmin claim on the target is never carried through this path", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const target = await member(firmId, { platformAdmin: true })
    await setUserClaimsHandler(await req(partner.token, { firmId, uid: target.uid, role: "clerk" }))
    expect((await adminAuth().getUser(target.uid)).customClaims).not.toHaveProperty("platformAdmin")
  })

  it("partner of firm A on a firm-B user → permission-denied cross_firm; target unchanged", async () => {
    const firmA = uniq("firmA")
    const partner = await mintIdToken(partnerClaims(firmA))
    const target = await member(uniq("firmB"))
    const before = (await adminAuth().getUser(target.uid)).customClaims
    const err = await httpsErrorOf(setUserClaimsHandler(await req(partner.token, { firmId: firmA, uid: target.uid, role: "partner" })))
    expectHttps(err, "permission-denied", "cross_firm")
    expect((await adminAuth().getUser(target.uid)).customClaims).toEqual(before)
    const rows = await auditRows(partner.uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "deny", reason: "cross_firm" })
  })

  it("unknown uid → permission-denied cross_firm (existence not revealed)", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const err = await httpsErrorOf(setUserClaimsHandler(await req(partner.token, { firmId, uid: uniq("ghost"), role: "clerk" })))
    expectHttps(err, "permission-denied", "cross_firm")
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })

  it("self-change → permission-denied self_change_forbidden", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId, "confidential"))
    const err = await httpsErrorOf(
      setUserClaimsHandler(await req(partner.token, { firmId, uid: partner.uid, clearanceLevel: "internal" }))
    )
    expectHttps(err, "permission-denied", "self_change_forbidden")
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })

  it("clearance above the caller's → permission-denied exceeds_own_clearance", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId, "confidential"))
    const target = await member(firmId)
    const err = await httpsErrorOf(
      setUserClaimsHandler(await req(partner.token, { firmId, uid: target.uid, clearanceLevel: "privileged-restricted" }))
    )
    expectHttps(err, "permission-denied", "exceeds_own_clearance")
    expect((await adminAuth().getUser(target.uid)).customClaims?.clearanceLevel).toBe("confidential")
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })

  it("associate caller → permission-denied partner_only", async () => {
    const firmId = uniq("firm")
    const assoc = await member(firmId)
    const target = await member(firmId)
    const err = await httpsErrorOf(setUserClaimsHandler(await req(assoc.token, { firmId, uid: target.uid, role: "partner" })))
    expectHttps(err, "permission-denied", "partner_only")
    expect(await auditCount(assoc.uid, ACTION)).toBe(1)
  })

  it("platformAdmin in the payload → permission-denied platform_admin_forbidden", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const target = await member(firmId)
    const err = await httpsErrorOf(
      setUserClaimsHandler(await req(partner.token, { firmId, uid: target.uid, platformAdmin: true }))
    )
    expectHttps(err, "permission-denied", "platform_admin_forbidden")
    expect((await adminAuth().getUser(target.uid)).customClaims).not.toHaveProperty("platformAdmin")
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })

  it.each([
    [{}, "nothing_to_change"],
    [{ role: "root" }, "invalid_role"],
    [{ clearanceLevel: "toString" }, "invalid_clearance"],
    [{ uid: "" }, "invalid_uid"],
    [{ uid: "a/b" }, "invalid_uid"],
  ])("invalid input %j → invalid-argument %s", async (patch, detail) => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const target = await member(firmId)
    const err = await httpsErrorOf(setUserClaimsHandler(await req(partner.token, { firmId, uid: target.uid, ...patch })))
    expectHttps(err, "invalid-argument", detail)
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })
})

describe.skipIf(!EMULATORS)("deactivateUser", () => {
  const ACTION = "identity.deactivateUser"

  async function member(firmId: string) {
    const m = await mintIdToken({ firmId, role: "associate", clearanceLevel: "confidential" })
    await adminDb().collection("users").doc(m.uid).set({ firmId, role: "associate", clearanceLevel: "confidential", active: true })
    return m
  }

  it("disables the Auth user, revokes sessions, marks users doc inactive; other documents untouched", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const target = await member(firmId)
    const matterRef = adminDb().collection("matters").doc(uniq("m"))
    await matterRef.set({ firmId, ownerId: target.uid, title: "keep me" })
    await sleep(1100)

    await expect(deactivateUserHandler(await req(partner.token, { firmId, uid: target.uid }))).resolves.toEqual({
      uid: target.uid,
      active: false,
    })

    expect((await adminAuth().getUser(target.uid)).disabled).toBe(true)
    expect((await adminDb().collection("users").doc(target.uid).get()).data()).toMatchObject({ firmId, active: false })
    expect((await matterRef.get()).data()).toEqual({ firmId, ownerId: target.uid, title: "keep me" })

    // Old token is rejected while disabled (the SDK reports disabled before revoked)...
    const headers = { authorization: `Bearer ${target.token}`, "x-firm-id": firmId }
    await expect(requireAuth({ headers })).rejects.toMatchObject({ status: 401, code: "user_disabled" })
    // ...and stays rejected as token_revoked even if the account is re-enabled.
    await adminAuth().updateUser(target.uid, { disabled: false })
    await expect(requireAuth({ headers })).rejects.toMatchObject({ status: 401, code: "token_revoked" })

    const rows = await auditRows(partner.uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ firmId, target: `users/${target.uid}`, decision: "allow", reason: "ok" })
  })

  it("self → permission-denied self_change_forbidden", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const err = await httpsErrorOf(deactivateUserHandler(await req(partner.token, { firmId, uid: partner.uid })))
    expectHttps(err, "permission-denied", "self_change_forbidden")
    expect((await adminAuth().getUser(partner.uid)).disabled).toBe(false)
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })

  it("user of another firm → permission-denied cross_firm", async () => {
    const firmA = uniq("firmA")
    const partner = await mintIdToken(partnerClaims(firmA))
    const target = await member(uniq("firmB"))
    const err = await httpsErrorOf(deactivateUserHandler(await req(partner.token, { firmId: firmA, uid: target.uid })))
    expectHttps(err, "permission-denied", "cross_firm")
    expect((await adminAuth().getUser(target.uid)).disabled).toBe(false)
    expect(await auditCount(partner.uid, ACTION)).toBe(1)
  })

  it("associate caller → permission-denied partner_only", async () => {
    const firmId = uniq("firm")
    const assoc = await member(firmId)
    const target = await member(firmId)
    const err = await httpsErrorOf(deactivateUserHandler(await req(assoc.token, { firmId, uid: target.uid })))
    expectHttps(err, "permission-denied", "partner_only")
    expect((await adminAuth().getUser(target.uid)).disabled).toBe(false)
    expect(await auditCount(assoc.uid, ACTION)).toBe(1)
  })
})

describe("index exports", () => {
  it("exports the four identity callables in asia-south1", async () => {
    const mod = (await import("../src/index")) as Record<string, { __endpoint?: { region?: string[]; callableTrigger?: unknown } }>
    for (const name of ["onboardFirm", "createFirmUser", "setUserClaims", "deactivateUser"]) {
      expect(mod[name]?.__endpoint?.callableTrigger, name).toBeDefined()
      expect(mod[name]?.__endpoint?.region, name).toEqual(["asia-south1"])
    }
  })
})
