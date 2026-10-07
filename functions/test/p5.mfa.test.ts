import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { DocumentReference, Timestamp } from "firebase-admin/firestore"
import { adminAuth, adminDb } from "../src/admin"
import { HttpError } from "../src/http/errors"
import { bindHttpSession, requireAuth, verifyBearer } from "../src/p5/auth"
import { normaliseRecoveryCode } from "../src/p5/mfa"
import { EMULATORS, mintIdToken, mintMfaIdToken, uniq } from "./emu"
import { ApiError, apiCall, apiErrorOf, expectKind, viaApi } from "./api"

// U-1: the operations are driven through the HTTP api, their only entry point.
const approveMfaDisableHandler = viaApi("approveMfaDisable")
const disableMfaHandler = viaApi("disableMfa")
const enforceMfaForRoleHandler = viaApi("enforceMfaForRole")
const generateRecoveryCodesHandler = viaApi("generateRecoveryCodes")
const syncMfaStatusHandler = viaApi("syncMfaStatus")

/** Authorization + X-Firm-Id headers for a direct requireAuth / bindHttpSession call. */
const headersFor = (token: string, firmId: string) => ({ authorization: `Bearer ${token}`, "x-firm-id": firmId })

const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/

const httpsErrorOf = apiErrorOf

async function httpErrorOf(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError)
    return e as HttpError
  }
  throw new Error("expected HttpError, promise resolved")
}

const expectHttps = expectKind

async function auditRows(actorId: string, action: string) {
  const snap = await adminDb().collection("audit_log").where("actorId", "==", actorId).where("action", "==", action).get()
  return snap.docs.map((d) => d.data())
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function req(token: string | null, data: Record<string, unknown>) {
  return apiCall(token, data)
}

const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({
  firmId,
  role,
  clearanceLevel,
})

const firmRef = (firmId: string) => adminDb().collection("firms").doc(firmId)
const userDoc = async (uid: string) => (await adminDb().collection("users").doc(uid).get()).data() ?? {}
/** Server-only recovery material (no rules match: client access denied by default). */
const enrolledUids = async (uid: string) =>
  ((await adminAuth().getUser(uid)).multiFactor?.enrolledFactors ?? []).map((f) => f.uid)
const recoveryDoc = async (uid: string) => (await adminDb().collection("mfa_recovery").doc(uid).get()).data()

async function newFirm(enforced: string[] = []): Promise<string> {
  const firmId = uniq("firm")
  await firmRef(firmId).set({ name: "F", mfaEnforcedRoles: enforced })
  return firmId
}

describe("normaliseRecoveryCode (no emulator needed)", () => {
  it("uppercases, drops separators and whitespace, maps look-alikes (O→0, I/L→1)", () => {
    expect(normaliseRecoveryCode(" abcd-efgh ijkm-np0o ")).toBe("ABCDEFGHIJKMNP00".replace("I", "1"))
    expect(normaliseRecoveryCode("il")).toBe("11")
  })
})

describe.skipIf(!EMULATORS)("MFA enforcement in requireAuth / bindHttpSession", () => {
  it("enforced role without a second factor → 403 mfa_required", async () => {
    const firmId = await newFirm(["associate"])
    const { token } = await mintIdToken(claims(firmId, "associate", "confidential"))
    const http = await httpErrorOf(requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": firmId } }))
    expect({ status: http.status, code: http.code }).toEqual({ status: 403, code: "mfa_required" })
  })

  it("enforced role with a second factor → allowed", async () => {
    const firmId = await newFirm(["associate"])
    const { uid, token } = await mintMfaIdToken(claims(firmId, "associate", "confidential"))
    const decoded = await adminAuth().verifyIdToken(token)
    expect(decoded.firebase.sign_in_second_factor).toBe("phone")
    const expected = { uid, firmId, role: "associate", clearanceLevel: "confidential" }
    expect(await requireAuth({ headers: { authorization: `Bearer ${token}`, "x-firm-id": firmId } })).toEqual(expected)
  })

  it("role not enforced (or no firm doc) → first factor is enough", async () => {
    const firmId = await newFirm(["partner"])
    const { token } = await mintIdToken(claims(firmId, "associate", "confidential"))
    await expect(requireAuth({ headers: headersFor(token, firmId) })).resolves.toMatchObject({ role: "associate" })

    const noDocFirm = uniq("firm")
    const b = await mintIdToken(claims(noDocFirm, "associate", "confidential"))
    await expect(requireAuth({ headers: headersFor(b.token, noDocFirm) })).resolves.toMatchObject({ role: "associate" })
  })

  it("mfaExempt callers skip only the second-factor rule, not identity checks", async () => {
    const firmId = await newFirm(["associate"])
    const { uid, token } = await mintIdToken(claims(firmId, "associate", "confidential"))
    const exempt = async () => (await bindHttpSession(await verifyBearer(headersFor(token, firmId)), headersFor(token, firmId), { mfaExempt: true })).caller
    await expect(exempt()).resolves.toMatchObject({ uid })
    await adminDb().collection("users").doc(uid).update({ active: false })
    const err = await httpErrorOf(exempt())
    expect(err.code).toBe("inactive_user")
  })
})

describe.skipIf(!EMULATORS)("enforceMfaForRole", () => {
  const ACTION = "identity.enforceMfaForRole"

  it("partner adds and removes a role (arrayUnion/arrayRemove); each call audited once", async () => {
    const firmId = await newFirm(["clerk"])
    const { uid, token } = await mintIdToken(claims(firmId, "partner"))
    expect(await enforceMfaForRoleHandler(await req(token, { firmId, role: "associate", enforced: true }))).toEqual({
      firmId,
      role: "associate",
      enforced: true,
    })
    await enforceMfaForRoleHandler(await req(token, { firmId, role: "associate", enforced: true }))
    expect((await firmRef(firmId).get()).data()?.mfaEnforcedRoles).toEqual(["clerk", "associate"])
    await enforceMfaForRoleHandler(await req(token, { firmId, role: "clerk", enforced: false }))
    expect((await firmRef(firmId).get()).data()?.mfaEnforcedRoles).toEqual(["associate"])

    const rows = await auditRows(uid, ACTION)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.decision === "allow" && r.target === `firms/${firmId}` && r.firmId === firmId)).toBe(true)
  })

  it("removing enforcement for partner is allowed (and audited)", async () => {
    const firmId = await newFirm([])
    const { uid, token } = await mintIdToken(claims(firmId, "partner"))
    await enforceMfaForRoleHandler(await req(token, { firmId, role: "partner", enforced: true }))
    // The caller is now subject to enforcement: needs a second factor for the next call.
    const locked = await httpsErrorOf(enforceMfaForRoleHandler(await req(token, { firmId, role: "partner", enforced: false })))
    expectHttps(locked, "permission-denied", "mfa_required")
    // Another partner, signed in with MFA, lifts it.
    const b = await mintMfaIdToken(claims(firmId, "partner"))
    await enforceMfaForRoleHandler(await req(b.token, { firmId, role: "partner", enforced: false }))
    expect((await firmRef(firmId).get()).data()?.mfaEnforcedRoles).toEqual([])
    expect((await auditRows(b.uid, ACTION))[0]).toMatchObject({ decision: "allow", reason: "ok" })
    expect((await auditRows(uid, ACTION)).map((r) => r.reason).sort()).toEqual(["mfa_required", "ok"])
  })

  it("non-partner → partner_only; bad role → invalid_role; non-boolean → invalid_enforced; missing firm → not_found", async () => {
    const firmId = await newFirm([])
    const a = await mintIdToken(claims(firmId, "associate", "confidential"))
    expectHttps(
      await httpsErrorOf(enforceMfaForRoleHandler(await req(a.token, { firmId, role: "clerk", enforced: true }))),
      "permission-denied",
      "partner_only"
    )
    const p = await mintIdToken(claims(firmId, "partner"))
    expectHttps(
      await httpsErrorOf(enforceMfaForRoleHandler(await req(p.token, { firmId, role: "admin", enforced: true }))),
      "invalid-argument",
      "invalid_role"
    )
    expectHttps(
      await httpsErrorOf(enforceMfaForRoleHandler(await req(p.token, { firmId, role: "clerk", enforced: "yes" }))),
      "invalid-argument",
      "invalid_enforced"
    )
    expect((await firmRef(firmId).get()).data()?.mfaEnforcedRoles).toEqual([])
    expect((await auditRows(a.uid, ACTION)).map((r) => r.decision)).toEqual(["deny"])
    expect(await auditRows(p.uid, ACTION)).toHaveLength(2)

    const ghostFirm = uniq("firm")
    const g = await mintIdToken(claims(ghostFirm, "partner"))
    expectHttps(
      await httpsErrorOf(enforceMfaForRoleHandler(await req(g.token, { firmId: ghostFirm, role: "clerk", enforced: true }))),
      "not-found",
      "not_found"
    )
    expect((await firmRef(ghostFirm).get()).exists).toBe(false)
  })
})

describe.skipIf(!EMULATORS)("generateRecoveryCodes", () => {
  const ACTION = "identity.generateRecoveryCodes"

  it("returns 10 distinct codes once; stores only salted HMAC-SHA-256 hashes bound to the enrolled factors; audit row has no codes", async () => {
    const firmId = await newFirm([])
    const { uid, token } = await mintMfaIdToken(claims(firmId, "associate", "confidential"))
    const { codes } = (await generateRecoveryCodesHandler(await req(token, { firmId }))) as { codes: string[] }
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const c of codes) expect(c).toMatch(CODE_RE)

    const doc = (await recoveryDoc(uid)) ?? {}
    expect(doc.generatedAt).toBeDefined()
    const user = await userDoc(uid)
    for (const k of ["recoveryCodeHashes", "recoveryCodeSalt", "recoveryCodesGeneratedAt"]) expect(user).not.toHaveProperty(k)
    expect(typeof doc.recoveryCodeSalt).toBe("string")
    const salt = Buffer.from(doc.recoveryCodeSalt as string, "base64")
    expect(salt.length).toBeGreaterThanOrEqual(16)
    const expected = codes.map((c) => ({
      hash: createHmac("sha256", salt).update(normaliseRecoveryCode(c)).digest("hex"),
      used: false,
    }))
    expect(doc.recoveryCodeHashes).toEqual(expected)
    expect(doc.factorUids).toEqual(await enrolledUids(uid))
    const stored = JSON.stringify(doc)
    for (const c of codes) {
      expect(stored).not.toContain(c)
      expect(stored).not.toContain(normaliseRecoveryCode(c))
    }

    const rows = await auditRows(uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "allow", target: `users/${uid}` })
    for (const c of codes) expect(JSON.stringify(rows[0])).not.toContain(normaliseRecoveryCode(c))
  })

  it("regenerating invalidates the previous set (new salt, new hashes)", async () => {
    const firmId = await newFirm([])
    const { uid, token } = await mintMfaIdToken(claims(firmId, "clerk", "internal"))
    const first = (await generateRecoveryCodesHandler(await req(token, { firmId }))) as { codes: string[] }
    const before = (await recoveryDoc(uid)) ?? {}
    const second = (await generateRecoveryCodesHandler(await req(token, { firmId }))) as { codes: string[] }
    const after = (await recoveryDoc(uid)) ?? {}
    expect(second.codes.some((c) => first.codes.includes(c))).toBe(false)
    expect(after.recoveryCodeSalt).not.toBe(before.recoveryCodeSalt)
    expect(after.recoveryCodeHashes).toHaveLength(10)
  })

  it("no factor enrolled yet → refused (enforced role: mfa_required; otherwise factor_required); nothing stored", async () => {
    const enforcedFirm = await newFirm(["associate"])
    const a = await mintIdToken(claims(enforcedFirm, "associate", "confidential"))
    expectHttps(
      await httpsErrorOf(generateRecoveryCodesHandler(await req(a.token, { firmId: enforcedFirm }))),
      "permission-denied",
      "mfa_required"
    )
    const firmId = await newFirm([])
    const b = await mintIdToken(claims(firmId, "associate", "confidential"))
    expectHttps(
      await httpsErrorOf(generateRecoveryCodesHandler(await req(b.token, { firmId }))),
      "permission-denied",
      "factor_required"
    )
    expect(await recoveryDoc(a.uid)).toBeUndefined()
    expect(await recoveryDoc(b.uid)).toBeUndefined()
  })

  it("P1 regression: a password-only session cannot plant codes before enrolment", async () => {
    const firmId = await newFirm(["associate"])
    const victim = await mintIdToken(claims(firmId, "associate", "confidential"), { emailVerified: true })
    // Attacker with the password only, before the victim enrols.
    await expect(generateRecoveryCodesHandler(await req(victim.token, { firmId }))).rejects.toBeInstanceOf(ApiError)
    expect(await recoveryDoc(victim.uid)).toBeUndefined()
  })

  it("once a factor is enrolled, regenerating needs a second-factor session (even if the role is not enforced)", async () => {
    const firmId = await newFirm([])
    const { uid, token, firstFactorToken } = await mintMfaIdToken(claims(firmId, "associate", "confidential"))
    const err = await httpsErrorOf(generateRecoveryCodesHandler(await req(firstFactorToken, { firmId })))
    expectHttps(err, "permission-denied", "mfa_required")
    expect(await recoveryDoc(uid)).toBeUndefined()
    await expect(generateRecoveryCodesHandler(await req(token, { firmId }))).resolves.toMatchObject({
      codes: expect.any(Array),
    })
    expect((await auditRows(uid, ACTION)).map((r) => r.reason).sort()).toEqual(["mfa_required", "ok"])
  })
})

describe.skipIf(!EMULATORS)("approveMfaDisable", () => {
  const ACTION = "identity.approveMfaDisable"

  it("a second partner approves: approval doc with 1h expiry, audited", async () => {
    const firmId = await newFirm([])
    const subject = await mintIdToken(claims(firmId, "associate", "confidential"))
    const partner = await mintIdToken(claims(firmId, "partner"))
    const t0 = Date.now()
    const { approvalId } = (await approveMfaDisableHandler(await req(partner.token, { firmId, uid: subject.uid }))) as {
      approvalId: string
    }
    const approval = (await adminDb().collection("mfa_disable_approvals").doc(approvalId).get()).data()
    expect(approval).toMatchObject({ firmId, subjectUid: subject.uid, approverUid: partner.uid, used: false })
    const ttl = (approval?.expiresAt as Timestamp).toMillis() - t0
    expect(ttl).toBeGreaterThan(59 * 60_000)
    expect(ttl).toBeLessThanOrEqual(61 * 60_000)
    const rows = await auditRows(partner.uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "allow", target: `users/${subject.uid}` })
  })

  it("self-approval → second_partner_required; non-partner → partner_only; higher-cleared subject → exceeds_own_clearance", async () => {
    const firmId = await newFirm([])
    const p = await mintIdToken(claims(firmId, "partner", "confidential"))
    expectHttps(
      await httpsErrorOf(approveMfaDisableHandler(await req(p.token, { firmId, uid: p.uid }))),
      "permission-denied",
      "second_partner_required"
    )
    const a = await mintIdToken(claims(firmId, "associate", "confidential"))
    expectHttps(
      await httpsErrorOf(approveMfaDisableHandler(await req(a.token, { firmId, uid: p.uid }))),
      "permission-denied",
      "partner_only"
    )
    const high = await mintIdToken(claims(firmId, "associate", "privileged-restricted"))
    expectHttps(
      await httpsErrorOf(approveMfaDisableHandler(await req(p.token, { firmId, uid: high.uid }))),
      "permission-denied",
      "exceeds_own_clearance"
    )
    const other = await mintIdToken(claims(uniq("firm"), "associate", "internal"))
    expectHttps(
      await httpsErrorOf(approveMfaDisableHandler(await req(p.token, { firmId, uid: other.uid }))),
      "permission-denied",
      "cross_firm"
    )
    expect((await adminDb().collection("mfa_disable_approvals").where("firmId", "==", firmId).get()).size).toBe(0)
    expect((await auditRows(p.uid, ACTION)).map((r) => r.decision)).toEqual(["deny", "deny", "deny"])
  })

  it("is not MFA-exempt: an enforced partner without a second factor → mfa_required", async () => {
    const firmId = await newFirm(["partner"])
    const subject = await mintIdToken(claims(firmId, "associate", "confidential"))
    const p = await mintIdToken(claims(firmId, "partner"))
    expectHttps(
      await httpsErrorOf(approveMfaDisableHandler(await req(p.token, { firmId, uid: subject.uid }))),
      "permission-denied",
      "mfa_required"
    )
  })
})

describe.skipIf(!EMULATORS)("disableMfa", () => {
  const ACTION = "identity.disableMfa"

  /** Firm enforcing MFA for associates; subject enrolled with codes; partner B available. */
  async function setup() {
    const firmId = await newFirm(["associate"])
    const subject = await mintMfaIdToken(claims(firmId, "associate", "confidential"))
    await adminDb().collection("users").doc(subject.uid).update({ mfaEnabled: true })
    const { codes } = (await generateRecoveryCodesHandler(await req(subject.token, { firmId }))) as { codes: string[] }
    const partnerB = await mintIdToken(claims(firmId, "partner"))
    const approve = async (uid = subject.uid, as = partnerB) =>
      ((await approveMfaDisableHandler(await req(as.token, { firmId, uid }))) as { approvalId: string }).approvalId
    return { firmId, subject, codes, partnerB, approve }
  }

  it("subject who lost the device (first factor only) + code + another partner's approval → MFA removed", async () => {
    const { firmId, subject, codes, approve } = await setup()
    const approvalId = await approve()
    await sleep(1100) // revocation granularity is one second

    const res = await disableMfaHandler(
      await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[3].toLowerCase(), approvalId })
    )
    expect(res).toEqual({ uid: subject.uid, mfaEnabled: false })

    const user = await adminAuth().getUser(subject.uid)
    expect(user.multiFactor?.enrolledFactors ?? []).toHaveLength(0)
    expect((await userDoc(subject.uid)).mfaEnabled).toBe(false)
    // All remaining codes are invalidated: only the consumed code's (used) hash is kept.
    const hashes = (await recoveryDoc(subject.uid))?.recoveryCodeHashes as { used: boolean }[]
    expect(hashes).toHaveLength(1)
    expect(hashes[0].used).toBe(true)
    expect((await adminDb().collection("mfa_disable_approvals").doc(approvalId).get()).data()?.used).toBe(true)

    // Sessions are revoked.
    const err = await httpErrorOf(requireAuth({ headers: headersFor(subject.token, firmId) }))
    expect(err.code).toBe("token_revoked")

    const rows = await auditRows(subject.uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "allow", reason: "ok", target: `users/${subject.uid}`, firmId })
    expect(JSON.stringify(rows[0])).not.toContain(normaliseRecoveryCode(codes[3]))
  })

  it("a partner may run it for the subject, with a different partner's approval", async () => {
    const { firmId, subject, codes, approve } = await setup()
    const partnerC = await mintIdToken(claims(firmId, "partner"))
    const approvalId = await approve()
    await expect(
      disableMfaHandler(await req(partnerC.token, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
    ).resolves.toEqual({ uid: subject.uid, mfaEnabled: false })
  })

  it("the approving partner cannot also be the caller → second_partner_required", async () => {
    const { firmId, subject, codes, partnerB, approve } = await setup()
    const approvalId = await approve()
    const err = await httpsErrorOf(
      disableMfaHandler(await req(partnerB.token, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
    )
    expectHttps(err, "permission-denied", "second_partner_required")
    expect((await adminAuth().getUser(subject.uid)).multiFactor?.enrolledFactors).toHaveLength(1)
  })

  it("an approval by the subject partner themself → second_partner_required", async () => {
    const firmId = await newFirm([])
    const subject = await mintMfaIdToken(claims(firmId, "partner"))
    const { codes } = (await generateRecoveryCodesHandler(await req(subject.token, { firmId }))) as { codes: string[] }
    const forged = adminDb().collection("mfa_disable_approvals").doc()
    await forged.set({
      firmId,
      subjectUid: subject.uid,
      approverUid: subject.uid,
      used: false,
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 3600_000),
    })
    const err = await httpsErrorOf(
      disableMfaHandler(await req(subject.token, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId: forged.id }))
    )
    expectHttps(err, "permission-denied", "second_partner_required")
    expect((await recoveryDoc(subject.uid))?.recoveryCodeHashes.every((h: { used: boolean }) => !h.used)).toBe(true)
    const rows = await auditRows(subject.uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "deny", reason: "second_partner_required" })
  })

  it("missing, expired, used, other-subject or other-firm approvals → second_partner_required", async () => {
    const { firmId, subject, codes, partnerB, approve } = await setup()
    const col = adminDb().collection("mfa_disable_approvals")
    const call = async (approvalId: unknown) =>
      httpsErrorOf(
        disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
      )
    const base = {
      firmId,
      subjectUid: subject.uid,
      approverUid: partnerB.uid,
      used: false,
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 3600_000),
    }
    const variants = [
      { expiresAt: Timestamp.fromMillis(Date.now() - 1000) },
      { used: true },
      { subjectUid: partnerB.uid },
      { firmId: uniq("firm") },
    ]
    const ids = ["no-such-approval", undefined]
    for (const v of variants) {
      const ref = col.doc()
      await ref.set({ ...base, ...v })
      ids.push(ref.id)
    }
    for (const id of ids) expectHttps(await call(id), "permission-denied", "second_partner_required")
    // Unused and untouched: a valid approval still works afterwards.
    await expect(
      disableMfaHandler(
        await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId: await approve() })
      )
    ).resolves.toMatchObject({ mfaEnabled: false })
  })

  it("an approver no longer an active partner → second_partner_required", async () => {
    const { firmId, subject, codes, partnerB, approve } = await setup()
    const approvalId = await approve()
    await adminDb().collection("users").doc(partnerB.uid).update({ active: false })
    const err = await httpsErrorOf(
      disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
    )
    expectHttps(err, "permission-denied", "second_partner_required")
    expect((await adminDb().collection("mfa_disable_approvals").doc(approvalId).get()).data()?.used).toBe(false)
  })

  it("wrong code → invalid_code; reused code → code_used; other codes are dead after a disable; nothing consumes the approval", async () => {
    const { firmId, subject, codes, approve } = await setup()
    const first = await approve()
    await disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[1], approvalId: first }))

    const approvalId = await approve()
    await sleep(1100) // the old sessions were revoked; a new sign-in must post-date that
    const again = await callableAuthFor(subject.email)
    const wrong = await httpsErrorOf(
      disableMfaHandler(apiCall(again, { firmId, uid: subject.uid, recoveryCode: "0000-0000-0000-0000", approvalId }))
    )
    expectHttps(wrong, "permission-denied", "invalid_code")
    const reused = await httpsErrorOf(
      disableMfaHandler(apiCall(again, { firmId, uid: subject.uid, recoveryCode: codes[1], approvalId }))
    )
    expectHttps(reused, "failed-precondition", "code_used")
    // disableMfa invalidated the remaining codes: an unused one from the old set no longer works.
    const stale = await httpsErrorOf(
      disableMfaHandler(apiCall(again, { firmId, uid: subject.uid, recoveryCode: codes[2], approvalId }))
    )
    expectHttps(stale, "permission-denied", "invalid_code")
    expect((await adminDb().collection("mfa_disable_approvals").doc(approvalId).get()).data()?.used).toBe(false)
    const reasons = (await auditRows(subject.uid, ACTION)).map((r) => r.reason).sort()
    expect(reasons).toEqual(["code_used", "invalid_code", "invalid_code", "ok"])
  })

  it("a failure after commit is resumable: same caller, same approval, no code, while factors remain", async () => {
    const { firmId, subject, codes, approve } = await setup()
    const approvalId = await approve()
    const spy = vi.spyOn(adminAuth(), "updateUser").mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "auth/internal-error" }))
    const first = await httpsErrorOf(
      disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
    )
    spy.mockRestore()
    expectHttps(first, "internal", "internal")
    expect((await adminAuth().getUser(subject.uid)).multiFactor?.enrolledFactors).toHaveLength(1)

    // Another caller cannot ride on the used approval.
    const partnerC = await mintIdToken(claims(firmId, "partner"))
    expectHttps(
      await httpsErrorOf(disableMfaHandler(await req(partnerC.token, { firmId, uid: subject.uid, approvalId }))),
      "permission-denied",
      "second_partner_required"
    )

    // The same caller retries without a code and finishes the job.
    await expect(
      disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, approvalId }))
    ).resolves.toEqual({ uid: subject.uid, mfaEnabled: false })
    expect((await adminAuth().getUser(subject.uid)).multiFactor?.enrolledFactors ?? []).toHaveLength(0)
    expect((await userDoc(subject.uid)).mfaEnabled).toBe(false)

    const rows = await auditRows(subject.uid, ACTION)
    expect(rows.map((r) => `${r.decision}:${r.reason}`).sort()).toEqual(["allow:ok", "allow:resume", "deny:mfa_disable_incomplete"])
  })

  it("no resume once completed (even after re-enrolling) or after expiry", async () => {
    const { firmId, subject, codes, approve } = await setup()
    const approvalId = await approve()
    await disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
    const approvals = adminDb().collection("mfa_disable_approvals").doc(approvalId)
    expect((await approvals.get()).data()?.completed).toBe(true)
    await sleep(1100)
    const again = await callableAuthFor(subject.email)
    const retry = async () =>
      httpsErrorOf(disableMfaHandler(apiCall(again, { firmId, uid: subject.uid, approvalId })))
    expectHttps(await retry(), "permission-denied", "second_partner_required") // completed, factors gone

    await adminAuth().updateUser(subject.uid, {
      multiFactor: { enrolledFactors: [{ uid: "f2", phoneNumber: "+15555550101", factorId: "phone" }] },
    })
    expectHttps(await retry(), "permission-denied", "second_partner_required") // completed

    await approvals.update({ completed: false, expiresAt: Timestamp.fromMillis(Date.now() - 1000) })
    expectHttps(await retry(), "permission-denied", "second_partner_required") // expired
    expect((await adminAuth().getUser(subject.uid)).multiFactor?.enrolledFactors).toHaveLength(1)
  })

  it("P1 defence in depth: codes bound to factors that are no longer enrolled → invalid_code", async () => {
    const { firmId, subject, codes, approve } = await setup()
    // The factor set the codes were generated for is replaced by another one.
    await adminAuth().updateUser(subject.uid, {
      multiFactor: { enrolledFactors: [{ uid: "other-factor", phoneNumber: "+15555550199", factorId: "phone" }] },
    })
    const approvalId = await approve()
    const err = await httpsErrorOf(
      disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
    )
    expectHttps(err, "permission-denied", "invalid_code")
    expect(await enrolledUids(subject.uid)).toEqual(["other-factor"])
  })

  it.each(["updateUser", "approvalMark", "usersDoc", "revoke"] as const)(
    "P2 regression: a failure at %s after commit is resumable by the same caller and completes the job",
    async (step) => {
      const { firmId, subject, codes, approve } = await setup()
      const approvalId = await approve()
      const factorAtCommit = await enrolledUids(subject.uid)
      const restore = injectFailure(step)
      const first = await httpsErrorOf(
        disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
      )
      restore()
      expectHttps(first, "internal", "internal")
      const approval = adminDb().collection("mfa_disable_approvals").doc(approvalId)
      expect((await approval.get()).data()).toMatchObject({ used: true, factorUids: factorAtCommit })
      expect((await approval.get()).data()?.completed).not.toBe(true)

      const validBefore = (await adminAuth().getUser(subject.uid)).tokensValidAfterTime
      await sleep(1100)
      await expect(
        disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, approvalId }))
      ).resolves.toEqual({ uid: subject.uid, mfaEnabled: false })
      const user = await adminAuth().getUser(subject.uid)
      expect(user.multiFactor?.enrolledFactors ?? []).toHaveLength(0)
      expect(user.tokensValidAfterTime).not.toBe(validBefore)
      expect((await userDoc(subject.uid)).mfaEnabled).toBe(false)
      expect((await approval.get()).data()?.completed).toBe(true)
      const rows = (await auditRows(subject.uid, ACTION)).map((r) => `${r.decision}:${r.reason}`).sort()
      expect(rows).toEqual(["allow:ok", "allow:resume", "deny:mfa_disable_incomplete"])
    }
  )

  it("a resume never removes a factor enrolled after the commit", async () => {
    const { firmId, subject, codes, approve } = await setup()
    const approvalId = await approve()
    const restore = injectFailure("updateUser")
    await httpsErrorOf(
      disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
    )
    restore()
    const old = (await adminAuth().getUser(subject.uid)).multiFactor!.enrolledFactors[0]
    await adminAuth().updateUser(subject.uid, {
      multiFactor: {
        enrolledFactors: [
          { uid: old.uid, phoneNumber: (old as unknown as { phoneNumber: string }).phoneNumber, factorId: "phone" },
          { uid: "new-factor", phoneNumber: "+15555550177", factorId: "phone" },
        ],
      },
    })
    await expect(
      disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, approvalId }))
    ).resolves.toEqual({ uid: subject.uid, mfaEnabled: true })
    expect(await enrolledUids(subject.uid)).toEqual(["new-factor"])
    expect((await userDoc(subject.uid)).mfaEnabled).toBe(true)
  })

  it("only the subject is MFA-exempt: a partner acting for someone else needs a second factor when partners are enforced", async () => {
    const { firmId, subject, codes, approve } = await setup()
    await firmRef(firmId).update({ mfaEnforcedRoles: ["associate", "partner"] })
    const partnerC = await mintIdToken(claims(firmId, "partner"))
    const approvalId = await approve(subject.uid, await mintMfaIdToken(claims(firmId, "partner")))
    const err = await httpsErrorOf(
      disableMfaHandler(await req(partnerC.token, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
    )
    expectHttps(err, "permission-denied", "mfa_required")
    // The subject (first factor only, enforced role) still can.
    await expect(
      disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
    ).resolves.toMatchObject({ mfaEnabled: false })
  })

  it("5 wrong codes void the approval (approval_voided), even for the right code afterwards", async () => {
    const { firmId, subject, codes, approve } = await setup()
    const approvalId = await approve()
    const call = async (recoveryCode: string) =>
      httpsErrorOf(disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode, approvalId })))
    for (let i = 0; i < 5; i++) expectHttps(await call("0000-0000-0000-0000"), "permission-denied", "invalid_code")
    expect((await adminDb().collection("mfa_disable_approvals").doc(approvalId).get()).data()?.codeAttempts).toBe(5)
    expectHttps(await call(codes[0]), "permission-denied", "approval_voided")
    expect(await enrolledUids(subject.uid)).toHaveLength(1)
    // A fresh approval works.
    await expect(
      disableMfaHandler(
        await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId: await approve() })
      )
    ).resolves.toMatchObject({ mfaEnabled: false })
  })

  it("the attempt cap holds under concurrency: 30 parallel wrong codes → at most 5 invalid_code, the rest approval_voided", async () => {
    const { firmId, subject, approve } = await setup()
    const approvalId = await approve()
    const auth = subject.firstFactorToken
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        disableMfaHandler(apiCall(auth, { firmId, uid: subject.uid, recoveryCode: "0000-0000-0000-0000", approvalId }))
      )
    )
    const codes = results.map((r) => {
      expect(r.status).toBe("rejected")
      return { code: ((r as PromiseRejectedResult).reason as ApiError).code }
    })
    const invalid = codes.filter((c) => c.code === "invalid_code").length
    const voided = codes.filter((c) => c.code === "approval_voided").length
    expect(invalid).toBeLessThanOrEqual(5)
    expect(invalid + voided).toBe(30)
    expect((await adminDb().collection("mfa_disable_approvals").doc(approvalId).get()).data()?.codeAttempts).toBe(5)
  })

  it("an approver demoted below the subject's clearance after approving → second_partner_required", async () => {
    const { firmId, subject, codes, partnerB, approve } = await setup()
    const approvalId = await approve()
    await adminDb().collection("users").doc(partnerB.uid).update({ clearanceLevel: "internal" })
    const err = await httpsErrorOf(
      disableMfaHandler(await req(subject.firstFactorToken, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId }))
    )
    expectHttps(err, "permission-denied", "second_partner_required")
  })

  it("caller neither the subject nor a partner → partner_only", async () => {
    const { firmId, subject, codes, approve } = await setup()
    const peer = await mintIdToken(claims(firmId, "clerk", "internal"))
    const err = await httpsErrorOf(
      disableMfaHandler(await req(peer.token, { firmId, uid: subject.uid, recoveryCode: codes[0], approvalId: await approve() }))
    )
    expectHttps(err, "permission-denied", "partner_only")
  })
})

/** Signs the (MFA-less, after disableMfa) user in again with the shared emulator password; returns the ID token. */
async function callableAuthFor(email: string): Promise<string> {
  const res = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "emulator-pass-123", returnSecureToken: true }),
    }
  )
  const body = (await res.json()) as { idToken: string }
  return body.idToken
}

describe.skipIf(!EMULATORS)("syncMfaStatus", () => {
  const ACTION = "identity.syncMfaStatus"

  it("sets users.mfaEnabled from the Auth user's enrolled factors (MFA-exempt, audited)", async () => {
    const firmId = await newFirm(["associate"])
    const { uid, firstFactorToken } = await mintMfaIdToken(claims(firmId, "associate", "confidential"))
    expect((await userDoc(uid)).mfaEnabled).toBeUndefined()
    await expect(syncMfaStatusHandler(await req(firstFactorToken, { firmId }))).resolves.toEqual({ uid, mfaEnabled: true })
    expect((await userDoc(uid)).mfaEnabled).toBe(true)

    await adminAuth().updateUser(uid, { multiFactor: { enrolledFactors: null } })
    await expect(syncMfaStatusHandler(await req(firstFactorToken, { firmId }))).resolves.toEqual({ uid, mfaEnabled: false })
    expect((await userDoc(uid)).mfaEnabled).toBe(false)

    const rows = await auditRows(uid, ACTION)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.decision === "allow" && r.target === `users/${uid}`)).toBe(true)
  })

  it("unauthenticated → missing_token, audited as a deny", async () => {
    const err = await httpsErrorOf(syncMfaStatusHandler(await req(null, { firmId: "f" })))
    expectHttps(err, "unauthenticated", "missing_token")
  })
})

/**
 * Makes one post-commit step of disableMfa fail once. The Firestore steps are
 * DocumentReference.update calls in order: approval mark, users doc, completed.
 */
function injectFailure(step: "updateUser" | "approvalMark" | "usersDoc" | "revoke"): () => void {
  const boom = () => Promise.reject(Object.assign(new Error("injected"), { code: "injected" }))
  if (step === "updateUser") {
    const spy = vi.spyOn(adminAuth(), "updateUser").mockImplementationOnce(boom)
    return () => spy.mockRestore()
  }
  if (step === "revoke") {
    const spy = vi.spyOn(adminAuth(), "revokeRefreshTokens").mockImplementationOnce(boom)
    return () => spy.mockRestore()
  }
  const target = step === "approvalMark" ? "mfa_disable_approvals" : "users"
  const real = DocumentReference.prototype.update
  let fired = false
  const impl = function (this: DocumentReference, ...args: unknown[]) {
    if (!fired && this.parent.id === target) {
      fired = true
      return boom()
    }
    return (real as (...a: unknown[]) => Promise<unknown>).apply(this, args)
  }
  const spy = vi.spyOn(DocumentReference.prototype, "update").mockImplementation(impl as never)
  return () => spy.mockRestore()
}
