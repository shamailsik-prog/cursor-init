/**
 * P5 decisions over the Auth + Firestore emulators that the existing suites
 * left to surviving mutants of `npm run mutation:functions`
 * (docs/audits/mutation-report.md): checkPermission's exact decision and audit
 * row per branch, the Bearer grammar and the revoked-token subject, verified
 * email for firmless callers, the rate-limit counter refusal and IP key
 * sanitising, setUserClaims' Auth-claim firm check, email parsing, and gate
 * evidence validation.
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { HttpsError } from "firebase-functions/v2/https"
import { adminAuth, adminDb } from "../src/admin"
import { RateLimitedError } from "../src/http/errors"
import { IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_TTL_MS, requestHash, withIdempotency } from "../src/http/idempotency"
import { rateLimit, rateLimitAnonymous, windowId } from "../src/http/rateLimit"
import { callerWithoutFirm, firmlessFromToken, requireAuth, verifyBearer, type Caller } from "../src/p5/auth"
import { recordGatePassHandler } from "../src/p5/gates"
import { createFirmUserHandler, setUserClaimsHandler } from "../src/p5/identity"
import { checkPermission } from "../src/p5/permission"
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

const detail = (err: HttpsError) => (err.details as { code?: string }).code

async function req(token: string | null, data: Record<string, unknown>) {
  return { auth: token ? await callableAuth(token) : undefined, data } as never
}

async function auditRows(actorId: string) {
  const snap = await adminDb().collection("audit_log").where("actorId", "==", actorId).get()
  return snap.docs.map((d) => d.data())
}

describe.skipIf(!EMULATORS)("checkPermission: exact decision and audit row per branch", () => {
  const caller = (over: Partial<Caller> = {}): Caller => ({
    uid: uniq("uid"),
    firmId: uniq("firm"),
    role: "associate",
    clearanceLevel: "confidential",
    ...over,
  })

  async function matter(firmId: string, classification: unknown, members: string[] = []) {
    const id = uniq("matter")
    await adminDb().collection("matters").doc(id).set({ firmId, classification })
    for (const uid of members) await adminDb().collection("matter_members").doc(`${id}_${uid}`).set({ matterId: id, userId: uid, firmId })
    return id
  }

  async function decide(c: Caller, action: string, matterId?: string, extra?: { scope?: "own_matters" }) {
    const decision = await checkPermission(c, action, matterId, extra)
    const rows = await auditRows(c.uid)
    expect(rows).toHaveLength(1)
    return { decision, row: rows[0] }
  }

  it.each(["research", "draft"])("an intern's %s is denied intern-channel-denied, audited at firm level", async (action) => {
    const c = caller({ role: "intern" })
    const { decision, row } = await decide(c, action)
    expect(decision).toEqual({ allow: false, reason: "intern-channel-denied" })
    expect(row).toMatchObject({ target: `firms/${c.firmId}`, classification: "internal", decision: "deny", reason: "intern-channel-denied" })
  })

  it("an intern may read a matter they are a member of", async () => {
    const c = caller({ role: "intern" })
    const m = await matter(c.firmId, "internal", [c.uid])
    expect((await decide(c, "read_matter", m)).decision).toEqual({ allow: true, reason: "ok" })
  })

  it("list_matters: staff ok, client or own_matters scope client-own-matters, before any matter check", async () => {
    const staff = caller()
    expect((await decide(staff, "list_matters")).decision).toEqual({ allow: true, reason: "ok" })
    const client = caller({ role: "client" })
    const { decision, row } = await decide(client, "list_matters")
    expect(decision).toEqual({ allow: true, reason: "client-own-matters" })
    expect(row).toMatchObject({ classification: "internal", decision: "allow" })
    expect((await decide(caller(), "list_matters", undefined, { scope: "own_matters" })).decision).toEqual({
      allow: true,
      reason: "client-own-matters",
    })
  })

  it("a client's other actions still pass the matter checks, and a member client may read", async () => {
    const client = caller({ role: "client" })
    const m = await matter(client.firmId, "internal")
    expect((await decide(client, "read_matter", m)).decision).toEqual({ allow: false, reason: "not-member" })
    const member = caller({ role: "client" })
    const own = await matter(member.firmId, "internal", [member.uid])
    expect((await decide(member, "read_matter", own)).decision).toEqual({ allow: true, reason: "ok" })
  })

  it("staff list_matters is allowed before any matter check, even with another firm's matter id", async () => {
    const staff = caller()
    const foreign = await matter(uniq("firm"), "internal")
    expect((await decide(staff, "list_matters", foreign)).decision).toEqual({ allow: true, reason: "ok" })
  })

  it("a firm-level action without a matter is allowed and audited as internal", async () => {
    const c = caller()
    const { decision, row } = await decide(c, "read_firm")
    expect(decision).toEqual({ allow: true, reason: "ok" })
    expect(row).toMatchObject({ target: `firms/${c.firmId}`, classification: "internal", decision: "allow", reason: "ok" })
  })

  it("a malformed matter id is denied invalid-matter-id, audited against that id as internal", async () => {
    for (const bad of ["", "a/b", ".", "..", "__x__"]) {
      const c = caller()
      const { decision, row } = await decide(c, "read_matter", bad)
      expect(decision).toEqual({ allow: false, reason: "invalid-matter-id" })
      expect(row).toMatchObject({ target: `matters/${bad}`, classification: "internal", reason: "invalid-matter-id" })
    }
  })

  it("ids that only resemble reserved ones are ordinary ids", async () => {
    for (const id of [`__x${uniq("m")}`, `x${uniq("m")}__`, `a__${uniq("m")}__`, `__${uniq("m")}__b`]) {
      const c = caller()
      expect((await decide(c, "read_matter", id)).decision).toEqual({ allow: false, reason: "cross-firm" })
    }
  })

  it("a matter with an unknown label is audited as privileged-restricted and denied for clearance", async () => {
    const c = caller({ clearanceLevel: "privileged-restricted" })
    const m = await matter(c.firmId, "top-secret", [c.uid])
    const { decision, row } = await decide(c, "read_matter", m)
    expect(decision).toEqual({ allow: false, reason: "clearance" })
    expect(row).toMatchObject({ classification: "privileged-restricted" })
  })

  it("a member at exactly the matter's clearance is allowed, audited with the matter's label", async () => {
    const c = caller({ clearanceLevel: "privileged" })
    const m = await matter(c.firmId, "privileged", [c.uid])
    const { decision, row } = await decide(c, "read_matter", m)
    expect(decision).toEqual({ allow: true, reason: "ok" })
    expect(row).toMatchObject({ target: `matters/${m}`, classification: "privileged" })
  })
})

describe.skipIf(!EMULATORS)("Bearer tokens and token subjects", () => {
  it("accepts several spaces after Bearer and refuses anything around the token", async () => {
    const u = await mintIdToken(null)
    await expect(verifyBearer({ authorization: `Bearer    ${u.token}` })).resolves.toMatchObject({ uid: u.uid })
    for (const header of [`xBearer ${u.token}`, `Bearer ${u.token} extra`, `Bearer\t`]) {
      await expect(verifyBearer({ authorization: header })).rejects.toMatchObject({ code: "missing_token" })
    }
  })

  it("a token whose user was deleted is invalid_token, with no subject", async () => {
    const u = await mintIdToken(null)
    await adminAuth().deleteUser(u.uid)
    await expect(verifyBearer({ authorization: `Bearer ${u.token}` })).rejects.toMatchObject({ code: "invalid_token", uid: undefined })
  })

  it("a revoked token names its subject for the audit row", async () => {
    const u = await mintIdToken(null)
    await new Promise((r) => setTimeout(r, 1100))
    await adminAuth().revokeRefreshTokens(u.uid)
    await expect(verifyBearer({ authorization: `Bearer ${u.token}` })).rejects.toMatchObject({ code: "token_revoked", uid: u.uid })
  })

  it("verifies Bearer tokens with revocation checking on (the emulator checks either way, so assert the call)", async () => {
    const u = await mintIdToken(null)
    const spy = vi.spyOn(adminAuth(), "verifyIdToken")
    try {
      await verifyBearer({ authorization: `Bearer ${u.token}` })
      expect(spy).toHaveBeenCalledWith(u.token, true)
    } finally {
      spy.mockRestore()
    }
  })

  it("an empty firmId claim is no_claims, even with an empty X-Firm-Id", async () => {
    const u = await mintIdToken({ firmId: "", role: "partner", clearanceLevel: "internal" }, { userDoc: false })
    await expect(requireAuth({ headers: { authorization: `Bearer ${u.token}`, "x-firm-id": "" } })).rejects.toMatchObject({
      status: 403,
      code: "no_claims",
    })
  })

  it("requireAuth binds with the firm's MFA policy applied (not exempt)", async () => {
    const firmId = uniq("firm")
    const u = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged" })
    await adminDb().collection("firms").doc(firmId).set({ mfaEnforcedRoles: ["partner"] })
    await expect(requireAuth({ headers: { authorization: `Bearer ${u.token}`, "x-firm-id": firmId } })).rejects.toMatchObject({
      status: 403,
      code: "mfa_required",
    })
  })
})

describe.skipIf(!EMULATORS)("verified email for firmless callers", () => {
  it("firmlessFromToken reports the email only when it is verified", async () => {
    const verified = await mintIdToken(null, { emailVerified: true })
    const decodedV = await verifyBearer({ authorization: `Bearer ${verified.token}` })
    expect((await firmlessFromToken(decodedV)).verifiedEmail).toBe(verified.email)
    const unverified = await mintIdToken(null)
    const decodedU = await verifyBearer({ authorization: `Bearer ${unverified.token}` })
    expect(await firmlessFromToken(decodedU)).toEqual({ uid: unverified.uid, claims: {}, verifiedEmail: undefined })
    expect((await firmlessFromToken({ ...decodedV, email: 5 } as never)).verifiedEmail).toBeUndefined()
  })

  it("firmlessFromToken: an unknown user is 401 invalid_token", async () => {
    await expect(firmlessFromToken({ uid: uniq("ghost") } as never)).rejects.toMatchObject({ status: 401, code: "invalid_token" })
  })

  it("callerWithoutFirm reports the email only when it is verified, and needs a numeric auth_time", async () => {
    const verified = await mintIdToken(null, { emailVerified: true })
    expect((await callerWithoutFirm(await callableAuth(verified.token))).verifiedEmail).toBe(verified.email)
    const unverified = await mintIdToken(null)
    expect((await callerWithoutFirm(await callableAuth(unverified.token))).verifiedEmail).toBeUndefined()
    const auth = (await callableAuth(verified.token)) as unknown as { uid: string; token: Record<string, unknown> }
    await expect(callerWithoutFirm({ ...auth, token: { ...auth.token, auth_time: "1" } } as never)).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    })
    await expect(
      callerWithoutFirm({ ...auth, token: { ...auth.token, email: 5, email_verified: true } } as never)
    ).resolves.toMatchObject({ verifiedEmail: undefined })
    await expect(callerWithoutFirm({ ...auth, uid: uniq("ghost") } as never)).rejects.toMatchObject({ status: 401, code: "invalid_token" })
  })
})

describe.skipIf(!EMULATORS)("rate-limit counters", () => {
  it("refuses the request over the limit, with the counter doc expiring an hour after its window", async () => {
    const uid = uniq("rl")
    const now = Date.UTC(2026, 9, 7, 10, 30, 15)
    const firm = { rateLimits: { general: 1 } }
    await rateLimit({ uid }, "general", { firm, now })
    const err = await rateLimit({ uid }, "general", { firm, now }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect(err).toMatchObject({ status: 429, retryAfter: 45 })
    const doc = (await adminDb().collection("rate_limits").doc(`${uid}_general_${windowId(now)}`).get()).data()
    expect(doc?.count).toBe(2)
    expect((doc?.expiresAt as Timestamp).toMillis()).toBe(Date.UTC(2026, 9, 7, 10, 31, 0) + 60 * 60 * 1000)
  })

  it("keys the anonymous counter on a sanitised, bounded IP", async () => {
    const now = Date.UTC(2026, 9, 7, 11, 0, 0)
    const raw = `${uniq("ip")}/../x y${"z".repeat(80)}`
    await rateLimitAnonymous(raw, now)
    const safe = raw.replace(/[^0-9A-Za-z.:-]/g, "_").slice(0, 64)
    expect(safe).toContain("_")
    expect((await adminDb().collection("rate_limits").doc(`ip:${safe}_anon_${windowId(now)}`).get()).data()?.count).toBe(1)
    await rateLimitAnonymous("///", now)
    expect((await adminDb().collection("rate_limits").doc(`ip:${"___"}_anon_${windowId(now)}`).get()).exists).toBe(true)
    const empty = Date.UTC(2026, 9, 7, 11, 1, 0)
    await rateLimitAnonymous("", empty)
    expect((await adminDb().collection("rate_limits").doc(`ip:unknown_anon_${windowId(empty)}`).get()).exists).toBe(true)
  })
})

describe.skipIf(!EMULATORS)("identity input and firm checks", () => {
  const partnerClaims = (firmId: string) => ({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })

  it("setUserClaims refuses a target whose Auth claims name another firm, even if its users doc is ours", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const target = await mintIdToken({ firmId: uniq("other"), role: "associate", clearanceLevel: "internal" }, { userDoc: false })
    await adminDb().collection("users").doc(target.uid).set({ firmId, role: "associate", clearanceLevel: "internal", active: true })
    const err = await httpsErrorOf(setUserClaimsHandler(await req(partner.token, { firmId, uid: target.uid, role: "clerk" })))
    expect([err.code, detail(err)]).toEqual(["permission-denied", "cross_firm"])
  })

  it("setUserClaims refuses a target with no Auth user as cross_firm", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const ghost = uniq("ghost")
    await adminDb().collection("users").doc(ghost).set({ firmId, role: "associate", clearanceLevel: "internal", active: true })
    const err = await httpsErrorOf(setUserClaimsHandler(await req(partner.token, { firmId, uid: ghost, role: "clerk" })))
    expect(detail(err)).toBe("cross_firm")
  })

  it("setUserClaims counts from 0 when the stored claimsVersion is not an integer", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    for (const claimsVersion of [2.5, "7"]) {
      const target = await mintIdToken({ firmId, role: "associate", clearanceLevel: "internal" }, { userDoc: false })
      await adminDb().collection("users").doc(target.uid).set({ firmId, role: "associate", clearanceLevel: "internal", active: true, claimsVersion })
      await setUserClaimsHandler(await req(partner.token, { firmId, uid: target.uid, role: "clerk" }))
      expect((await adminDb().collection("users").doc(target.uid).get()).data()?.claimsVersion).toBe(1)
      expect((await adminAuth().getUser(target.uid)).customClaims?.claimsVersion).toBe(1)
    }
  })

  it("setUserClaims prefers the server-only claims_sync version over the users doc", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const target = await mintIdToken({ firmId, role: "associate", clearanceLevel: "internal" }, { userDoc: false })
    await adminDb().collection("users").doc(target.uid).set({ firmId, role: "associate", clearanceLevel: "internal", active: true, claimsVersion: 1 })
    await adminDb().collection("claims_sync").doc(target.uid).set({ firmId, role: "associate", clearanceLevel: "internal", version: 4 })
    await setUserClaimsHandler(await req(partner.token, { firmId, uid: target.uid, role: "clerk" }))
    expect((await adminDb().collection("users").doc(target.uid).get()).data()?.claimsVersion).toBe(5)
    await adminDb().collection("claims_sync").doc(target.uid).set({ firmId, role: "clerk", clearanceLevel: "internal", version: 7.5 })
    await setUserClaimsHandler(await req(partner.token, { firmId, uid: target.uid, role: "intern" }))
    expect((await adminDb().collection("users").doc(target.uid).get()).data()?.claimsVersion).toBe(6)
  })

  it("createFirmUser trims a valid email, refuses malformed or over-long ones, and an email already in use", async () => {
    const firmId = uniq("firm")
    const partner = await mintIdToken(partnerClaims(firmId))
    const make = async (email: unknown) =>
      createFirmUserHandler(await req(partner.token, { firmId, email, role: "clerk", clearanceLevel: "internal" }))
    const email = `${uniq("n")}@example.test`
    const res = (await make(`  ${email}  `)) as { uid: string }
    expect((await adminAuth().getUser(res.uid)).email).toBe(email)
    for (const bad of ["x a@b.co", "a@b", "a@@b.co", "@b.co", `a@b.co x`, `${"a".repeat(247)}@b.co.uk`]) {
      expect(detail(await httpsErrorOf(make(bad))), bad).toBe("invalid_email")
    }
    expect(detail(await httpsErrorOf(make(email)))).toBe("already_exists")
    // 254 characters is the limit, inclusive.
    const max = `${"a".repeat(243 - 8)}${uniq("m").slice(-8)}@example.co`
    expect(max.length).toBe(254)
    await expect(make(max)).resolves.toMatchObject({ uid: expect.any(String) })
  })
})

describe.skipIf(!EMULATORS)("gate evidence validation", () => {
  const COUNTS = { tested: 1, notBuilt: 0, outOfScope: 0, global: 0, allowed: 0 }
  const EVIDENCE = { summary: "ok", commitSha: "6e66bf1", runUrl: "https://github.com/o/r/actions/runs/1", counts: COUNTS }

  async function record(evidence: unknown) {
    const admin = await mintIdToken({ platformAdmin: true })
    return recordGatePassHandler(await req(admin.token, { gate: "G-2", evidence }))
  }

  it("keeps other fields of platform/gates (merge) and audits an early refusal against platform/gates", async () => {
    await adminDb().collection("platform").doc("gates").set({ unrelated: "kept" }, { merge: true })
    await record(EVIDENCE)
    expect((await adminDb().collection("platform").doc("gates").get()).data()?.unrelated).toBe("kept")
    const admin = await mintIdToken({ platformAdmin: true })
    await httpsErrorOf(recordGatePassHandler(await req(admin.token, { gate: "G-9", evidence: EVIDENCE })))
    const rows = await auditRows(admin.uid)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ target: "platform/gates", decision: "deny", reason: "invalid_gate" })
  })

  it("accepts the boundaries: 2000-char summary (trimmed), 500-char https URL, 40-char sha", async () => {
    await expect(record({ ...EVIDENCE, summary: ` ${"s".repeat(2000)} ` })).resolves.toMatchObject({ gate: "G-2" })
    const url = `https://example.test/${"u".repeat(500 - "https://example.test/".length)}`
    expect(url.length).toBe(500)
    await expect(record({ ...EVIDENCE, runUrl: url, commitSha: "a".repeat(40) })).resolves.toMatchObject({ gate: "G-2" })
  })

  it.each([
    ["a non-string summary", { ...EVIDENCE, summary: 5 }],
    ["a sha with a prefix", { ...EVIDENCE, commitSha: "zz6e66bf1" }],
    ["a numeric sha", { ...EVIDENCE, commitSha: 1234567 }],
    ["a 501-char URL", { ...EVIDENCE, runUrl: `https://example.test/${"u".repeat(480)}` }],
    ["an http URL", { ...EVIDENCE, runUrl: "http://github.com/o/r" }],
    ["a non-string URL", { ...EVIDENCE, runUrl: 5 }],
    ["a fractional count", { ...EVIDENCE, counts: { ...COUNTS, notBuilt: 1.5 } }],
    ["a negative count", { ...EVIDENCE, counts: { ...COUNTS, global: -1 } }],
    ["a string count", { ...EVIDENCE, counts: { ...COUNTS, outOfScope: "0" } }],
    ["counts as an array", { ...EVIDENCE, counts: [1, 0, 0, 0, 0] }],
    ["evidence as an array", [EVIDENCE]],
  ])("refuses %s as invalid_evidence", async (_label, evidence) => {
    expect(detail(await httpsErrorOf(record(evidence)))).toBe("invalid_evidence")
  })

})

describe.skipIf(!EMULATORS)("idempotency claims at their boundaries", () => {
  const ROUTE = "POST /api/t/x"
  const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)

  function scope(over: Record<string, unknown> = {}) {
    return { firmId: uniq("firm"), uid: uniq("u"), route: ROUTE, key: randomUUID(), body: { a: 1 }, now: NOW, ...over }
  }

  async function seed(s: ReturnType<typeof scope>, doc: Record<string, unknown>) {
    const ref = adminDb().collection("idempotency_keys").doc(`${s.firmId || "_nofirm"}_${(s.key as string).toLowerCase()}`)
    await ref.set({ firmId: s.firmId, uid: s.uid, route: ROUTE, requestHash: requestHash(s.body), ...doc })
  }

  const ok = async () => ({ status: 200, body: { ran: true } })

  it("a firmless key is stored under _nofirm, lower-cased", async () => {
    const s = scope({ firmId: "", key: randomUUID().toUpperCase() })
    await withIdempotency(s, ok)
    const doc = (await adminDb().collection("idempotency_keys").doc(`_nofirm_${(s.key as string).toLowerCase()}`).get()).data()
    expect(doc).toMatchObject({ status: "done", route: ROUTE, response: { status: 200, body: { ran: true } } })
  })

  it("a key expiring exactly now is still live (replayed)", async () => {
    const s = scope()
    await seed(s, { status: "done", response: { status: 201, body: { first: true } }, expiresAt: Timestamp.fromMillis(NOW) })
    await expect(withIdempotency(s, ok)).resolves.toEqual({ status: 201, body: { first: true, reused: true } })
  })

  it("an in_progress claim exactly at its lease still answers 409; one ms later it is taken over", async () => {
    const live = scope()
    await seed(live, {
      status: "in_progress",
      claimedAt: Timestamp.fromMillis(NOW - IDEMPOTENCY_LEASE_MS),
      expiresAt: Timestamp.fromMillis(NOW + IDEMPOTENCY_TTL_MS),
    })
    await expect(withIdempotency(live, ok)).rejects.toMatchObject({ status: 409, code: "idempotency_in_progress" })
    const stale = scope()
    await seed(stale, {
      status: "in_progress",
      claimedAt: Timestamp.fromMillis(NOW - IDEMPOTENCY_LEASE_MS - 1),
      expiresAt: Timestamp.fromMillis(NOW + IDEMPOTENCY_TTL_MS),
    })
    await expect(withIdempotency(stale, ok)).resolves.toEqual({ status: 200, body: { ran: true } })
  })

  it.each([
    ["a non-numeric status", { status: "200", body: {} }],
    ["an array body", { status: 200, body: [1] }],
    ["a null body", { status: 200, body: null }],
    ["a null response", null],
  ])("a done claim with %s is never replayed (409)", async (_label, response) => {
    const s = scope()
    await seed(s, { status: "done", response, claimedAt: Timestamp.fromMillis(NOW), expiresAt: Timestamp.fromMillis(NOW + IDEMPOTENCY_TTL_MS) })
    await expect(withIdempotency(s, ok)).rejects.toMatchObject({ status: 409, code: "idempotency_in_progress" })
  })

  it("an in_progress claim is never replayed, even if it carries a response; a done claim is never taken over", async () => {
    const s1 = scope()
    await seed(s1, {
      status: "in_progress",
      response: { status: 200, body: { stale: true } },
      claimedAt: Timestamp.fromMillis(NOW),
      expiresAt: Timestamp.fromMillis(NOW + IDEMPOTENCY_TTL_MS),
    })
    await expect(withIdempotency(s1, ok)).rejects.toMatchObject({ code: "idempotency_in_progress" })
    const s2 = scope()
    await seed(s2, {
      status: "done",
      response: { status: "bad" },
      claimedAt: Timestamp.fromMillis(NOW - IDEMPOTENCY_LEASE_MS - 1),
      expiresAt: Timestamp.fromMillis(NOW + IDEMPOTENCY_TTL_MS),
    })
    await expect(withIdempotency(s2, ok)).rejects.toMatchObject({ code: "idempotency_in_progress" })
  })

  it("holds the key as in_progress while the handler runs", async () => {
    const s = scope()
    const ref = adminDb().collection("idempotency_keys").doc(`${s.firmId}_${(s.key as string).toLowerCase()}`)
    await withIdempotency(s, async () => {
      expect((await ref.get()).data()).toMatchObject({ status: "in_progress", uid: s.uid, route: ROUTE })
      return { status: 200, body: {} }
    })
  })

  it("redacts only a stored 2xx body", async () => {
    const a = scope()
    await withIdempotency({ ...a, redact: true }, ok)
    await expect(withIdempotency({ ...a, redact: true }, ok)).resolves.toEqual({ status: 200, body: { redacted: true, reused: true } })
    const b = scope()
    const refused = async () => ({ status: 422, body: { error: { code: "x" } } })
    await withIdempotency({ ...b, redact: true }, refused)
    await expect(withIdempotency({ ...b, redact: true }, refused)).resolves.toEqual({ status: 422, body: { error: { code: "x" }, reused: true } })
  })
})
