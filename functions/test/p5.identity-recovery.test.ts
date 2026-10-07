// Final audit FN-1 / FN-2: post-commit failures in the identity callables.
// FN-1: the platformAdmin onboardFirm path resumes the same firm after a claims failure.
// FN-2: every setUserClaims claims-sync failure writes an incident row, and the revert is audited.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminAuth, adminDb } from "../src/admin"
import { onboardFirmHandler, setUserClaimsHandler } from "../src/p5/identity"
import { EMULATORS, callableAuth, mintIdToken, uniq } from "./emu"

const req = async (token: string, data: Record<string, unknown>) => ({ auth: await callableAuth(token), data }) as never

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

    const res = (await onboardFirmHandler(await req(token, { name: "Second" }))) as { firmId: string }
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
