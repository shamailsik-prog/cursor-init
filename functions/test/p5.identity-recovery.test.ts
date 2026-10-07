// Final audit FN-1 / FN-2: post-commit failures in the identity operations, driven through the
// HTTP api (U-1: their only entry point).
// FN-1: the platformAdmin onboardFirm path resumes the same firm after a claims failure.
// FN-2: every setUserClaims claims-sync failure writes an incident row, and the revert is audited.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminAuth, adminDb } from "../src/admin"
import { apiCall, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

const onboardFirmHandler = viaApi<{ firmId: string }>("onboardFirm")
const setUserClaimsHandler = viaApi("setUserClaims")
const req = async (token: string, data: Record<string, unknown>) => apiCall(token, data)

async function auditRows(actorId: string, action: string) {
  const snap = await adminDb().collection("audit_log").where("actorId", "==", actorId).where("action", "==", action).get()
  return snap.docs.map((d) => d.data())
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe.skipIf(!EMULATORS)("FN-1: platformAdmin onboardFirm is resumable", () => {
  const bootstrapRef = () => adminDb().collection("platform").doc("bootstrap")
  const gatesRef = () => adminDb().collection("platform").doc("gates")

  beforeEach(async () => {
    await bootstrapRef().delete()
    // A first firm exists (bootstrap) and G-2 has passed, so a platformAdmin may onboard another.
    const first = await mintIdToken(null)
    await onboardFirmHandler(await req(first.token, { name: "First" }))
    await gatesRef().set({ g2PassedAt: Timestamp.now() })
  })

  afterEach(async () => {
    await gatesRef().delete()
    await bootstrapRef().delete()
  })

  it("a claims failure followed by a retry leaves exactly one firm for the caller and resumes it", async () => {
    const { uid, token } = await mintIdToken({ platformAdmin: true })
    vi.spyOn(logger, "error").mockImplementation(() => undefined)
    const spy = vi.spyOn(adminAuth(), "setCustomUserClaims").mockRejectedValueOnce(new Error("injected"))
    await expect(onboardFirmHandler(await req(token, { name: "Second" }))).rejects.toBeDefined()
    spy.mockRestore()
    const pending = (await adminDb().collection("platform_onboarding").doc(uid).get()).data()
    expect(typeof pending?.firmId).toBe("string")

    const res = await onboardFirmHandler(await req(token, { name: "Second" }))
    expect(res.firmId).toBe(pending?.firmId)

    const rows = await auditRows(uid, "identity.onboardFirm")
    const allows = rows.filter((r) => r.decision === "allow")
    expect(allows.map((r) => r.reason).sort()).toEqual(["ok", "onboarding_resume"])
    const firmIds = new Set(allows.map((r) => String(r.target).replace("firms/", "")))
    expect([...firmIds]).toEqual([res.firmId])
    const userDoc = (await adminDb().collection("users").doc(uid).get()).data()
    expect(userDoc?.firmId).toBe(res.firmId)
    expect((await adminAuth().getUser(uid)).customClaims).toMatchObject({ firmId: res.firmId, platformAdmin: true })
  })
})

describe.skipIf(!EMULATORS)("FN-2: setUserClaims failures and reverts are audited", () => {
  const ACTION = "identity.setUserClaims"

  async function setup() {
    const firmId = uniq("firm")
    const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
    const target = await mintIdToken({ firmId, role: "associate", clearanceLevel: "internal" })
    vi.spyOn(logger, "error").mockImplementation(() => undefined)
    return { firmId, partner, target }
  }

  it("an Auth outage (not claims_sync_failed) writes an incident row and a revert row", async () => {
    const { firmId, partner, target } = await setup()
    vi.spyOn(adminAuth(), "setCustomUserClaims").mockRejectedValueOnce(new Error("auth down"))
    await expect(
      setUserClaimsHandler(await req(partner.token, { firmId, uid: target.uid, clearanceLevel: "confidential" }))
    ).rejects.toBeDefined()
    const doc = (await adminDb().collection("users").doc(target.uid).get()).data()
    expect(doc?.clearanceLevel).toBe("internal")
    const rows = await auditRows(partner.uid, ACTION)
    expect(rows.map((r) => `${r.decision}:${r.reason}`).sort()).toEqual([
      "allow:ok",
      "deny:claims_change_reverted",
      "deny:claims_sync_error",
    ])
  })

  it("a sync failure whose change was superseded by a newer one is audited as not reverted", async () => {
    const { firmId, partner, target } = await setup()
    const users = adminDb().collection("users")
    vi.spyOn(adminAuth(), "setCustomUserClaims").mockImplementationOnce(async () => {
      await users.doc(target.uid).update({ role: "intern", claimsVersion: 2 })
      await adminDb()
        .collection("claims_sync")
        .doc(target.uid)
        .set({ version: 2, firmId, role: "intern", clearanceLevel: "internal" })
      throw new Error("injected claims failure")
    })
    await expect(
      setUserClaimsHandler(await req(partner.token, { firmId, uid: target.uid, role: "clerk" }))
    ).rejects.toBeDefined()
    const rows = await auditRows(partner.uid, ACTION)
    expect(rows.map((r) => `${r.decision}:${r.reason}`).sort()).toEqual([
      "allow:ok",
      "deny:claims_revert_superseded",
      "deny:claims_sync_error",
    ])
  })
})
