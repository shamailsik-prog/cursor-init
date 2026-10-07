import { beforeEach, describe, expect, it, vi } from "vitest"
import { adminDb } from "../src/admin"
import type { Caller } from "../src/p5/auth"
import { appendAudit } from "../src/p5/audit"
import { checkPermission, requirePermission } from "../src/p5/permission"
import { EMULATORS, uniq } from "./emu"

// Pass-through spy so individual tests can make the audit write fail.
// Pass-through spy so a test can make the Firestore handle fail.
vi.mock("../src/admin", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/admin")>()
  return { ...real, adminDb: vi.fn(real.adminDb) }
})

vi.mock("../src/p5/audit", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/p5/audit")>()
  return { ...real, appendAudit: vi.fn(real.appendAudit) }
})

async function seedMatter(firmId: string, classification: string, members: string[] = []): Promise<string> {
  const matterId = uniq("matter")
  await adminDb().collection("matters").doc(matterId).set({ firmId, classification, title: "t" })
  for (const uid of members) {
    await adminDb().collection("matter_members").doc(`${matterId}_${uid}`).set({ matterId, userId: uid, firmId })
  }
  return matterId
}

async function auditRowsFor(actorId: string) {
  const snap = await adminDb().collection("audit_log").where("actorId", "==", actorId).get()
  return snap.docs.map((d) => d.data())
}

function caller(over: Partial<Caller> = {}): Caller {
  return { uid: uniq("uid"), firmId: uniq("firm"), role: "associate", clearanceLevel: "confidential", ...over }
}

describe.skipIf(!EMULATORS)("checkPermission (Firestore emulator)", () => {
  beforeEach(() => {
    vi.mocked(appendAudit).mockClear()
  })

  it("member with sufficient clearance reading a matter → allow ok, audited", async () => {
    const c = caller()
    const matterId = await seedMatter(c.firmId, "confidential", [c.uid])
    await expect(checkPermission(c, "read_matter", matterId)).resolves.toEqual({ allow: true, reason: "ok" })
    const rows = await auditRowsFor(c.uid)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      firmId: c.firmId,
      actorId: c.uid,
      action: "read_matter",
      target: `matters/${matterId}`,
      classification: "confidential",
      decision: "allow",
      reason: "ok",
    })
    expect(rows[0].occurredAt).toBeDefined()
  })

  it("non-member reading a matter → deny not-member and exactly one deny audit row", async () => {
    const c = caller()
    const matterId = await seedMatter(c.firmId, "internal")
    await expect(checkPermission(c, "read_matter", matterId)).resolves.toEqual({ allow: false, reason: "not-member" })
    const rows = await auditRowsFor(c.uid)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "deny", reason: "not-member", target: `matters/${matterId}` })
  })

  it("member with clearance below matter classification → deny clearance", async () => {
    const c = caller({ clearanceLevel: "internal" })
    const matterId = await seedMatter(c.firmId, "privileged", [c.uid])
    await expect(checkPermission(c, "read_matter", matterId)).resolves.toEqual({ allow: false, reason: "clearance" })
  })

  it("matter in another firm → deny cross-firm; missing matter → deny cross-firm", async () => {
    const c = caller()
    const otherFirmMatter = await seedMatter(uniq("firm"), "public", [c.uid])
    await expect(checkPermission(c, "read_matter", otherFirmMatter)).resolves.toEqual({
      allow: false,
      reason: "cross-firm",
    })
    await expect(checkPermission(c, "read_matter", uniq("nope"))).resolves.toEqual({
      allow: false,
      reason: "cross-firm",
    })
  })

  it("client with research → deny", async () => {
    const c = caller({ role: "client" })
    const matterId = await seedMatter(c.firmId, "public", [c.uid])
    const d = await checkPermission(c, "research", matterId)
    expect(d).toEqual({ allow: false, reason: "client-channel-denied" })
    expect(await auditRowsFor(c.uid)).toEqual([expect.objectContaining({ decision: "deny" })])
  })

  it("intern research/draft → deny intern-channel-denied", async () => {
    const c = caller({ role: "intern" })
    await expect(checkPermission(c, "draft")).resolves.toEqual({ allow: false, reason: "intern-channel-denied" })
  })

  it("own_matters scope: list_matters allowed, draft denied", async () => {
    const c = caller()
    await expect(checkPermission(c, "list_matters", undefined, { scope: "own_matters" })).resolves.toEqual({
      allow: true,
      reason: "client-own-matters",
    })
    await expect(checkPermission(c, "draft", undefined, { scope: "own_matters" })).resolves.toEqual({
      allow: false,
      reason: "client-channel-denied",
    })
  })

  it("audit write rejected → deny audit_unavailable (even when table says allow)", async () => {
    const c = caller()
    const matterId = await seedMatter(c.firmId, "internal", [c.uid])
    vi.mocked(appendAudit).mockRejectedValueOnce(new Error("firestore down"))
    await expect(checkPermission(c, "read_matter", matterId)).resolves.toEqual({
      allow: false,
      reason: "audit_unavailable",
    })
    expect(appendAudit).toHaveBeenCalledTimes(1)
  })

  it("matter with malformed classification → deny clearance (fail closed)", async () => {
    const c = caller({ clearanceLevel: "privileged-restricted" })
    const matterId = await seedMatter(c.firmId, "bogus", [c.uid])
    await expect(checkPermission(c, "read_matter", matterId)).resolves.toEqual({ allow: false, reason: "clearance" })
  })
})

const PROTO_KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]

describe.skipIf(!EMULATORS)("checkPermission hardening (Firestore emulator)", () => {
  it.each(PROTO_KEYS)("matter classification %j (Object.prototype key) → deny clearance", async (key) => {
    const c = caller({ clearanceLevel: "privileged-restricted" })
    const matterId = await seedMatter(c.firmId, key, [c.uid])
    await expect(checkPermission(c, "read_matter", matterId)).resolves.toEqual({ allow: false, reason: "clearance" })
    const rows = await auditRowsFor(c.uid)
    expect(rows).toEqual([expect.objectContaining({ decision: "deny", classification: "privileged-restricted" })])
  })

  it.each(["", "a/b", "a/b/c", ".", "..", "__x__", "__proto__"])(
    "invalid matterId %j → deny invalid-matter-id, audited",
    async (matterId) => {
      const c = caller()
      await expect(checkPermission(c, "read_matter", matterId)).resolves.toEqual({
        allow: false,
        reason: "invalid-matter-id",
      })
      const rows = await auditRowsFor(c.uid)
      expect(rows).toEqual([expect.objectContaining({ decision: "deny", reason: "invalid-matter-id" })])
    }
  )

  it("Firestore read error → deny store-unavailable, audit row still written", async () => {
    const c = caller()
    // Fail the store handle used for the matter/member reads; the audit write uses a fresh, real handle.
    vi.mocked(adminDb).mockImplementationOnce(() => {
      throw new Error("firestore unreachable")
    })
    const d = await checkPermission(c, "read_matter", uniq("matter"))
    expect(d).toEqual({ allow: false, reason: "store-unavailable" })
    const rows = await auditRowsFor(c.uid)
    expect(rows).toEqual([expect.objectContaining({ decision: "deny", reason: "store-unavailable" })])
  })

  it("D1 action: intern conflict.run → 403 role_not_permitted, partner conflict.waive allowed, both audited", async () => {
    const intern = caller({ role: "intern" })
    await expect(requirePermission(intern, "conflict.run")).rejects.toMatchObject({
      status: 403,
      code: "role_not_permitted",
    })
    expect((await auditRowsFor(intern.uid))[0]).toMatchObject({
      action: "conflict.run",
      decision: "deny",
      reason: "role-not-permitted",
    })
    const partner = caller({ role: "partner" })
    await expect(requirePermission(partner, "conflict.waive")).resolves.toBeUndefined()
  })

  it("D1 matter-level action: member partner passes matter.close with a matterId; non-member is denied", async () => {
    const c = caller({ role: "partner" })
    const matterId = await seedMatter(c.firmId, "confidential", [c.uid])
    await expect(requirePermission(c, "matter.close", matterId)).resolves.toBeUndefined()
    const other = caller({ role: "partner", firmId: c.firmId })
    await expect(requirePermission(other, "matter.close", matterId)).rejects.toMatchObject({
      status: 403,
      code: "not_member",
    })
  })
})
