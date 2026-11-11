/**
 * FA-DATA-002: a stored matter_members classification cannot fall or be removed, and the
 * caller must be cleared for the label they write. A legacy row with no stored label stays
 * updatable (FA-F13-016).
 */
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { deleteField, doc, getDoc, setDoc, setLogLevel, Timestamp, updateDoc } from "firebase/firestore"

const EMU = Boolean(process.env.FIRESTORE_EMULATOR_HOST)
const RULES = readFileSync("firestore.rules", "utf8")
const FIRM = "fa-data-002"
const MATTER = "faData002Matter"

const PARTNER = { uid: "fa002-partner", claims: { firmId: FIRM, role: "partner", clearanceLevel: "privileged-restricted" } }
const PARTNER_LOW = { uid: "fa002-partner-low", claims: { firmId: FIRM, role: "partner", clearanceLevel: "internal" } }
const ASSIGNEE = { uid: "fa002-assignee", claims: { firmId: FIRM, role: "associate", clearanceLevel: "internal" } }

type Caller = { uid: string; claims: Record<string, string> }

describe.skipIf(!EMU)("matter_members classification is monotonic (FA-DATA-002)", () => {
  let testEnv: RulesTestEnvironment

  beforeAll(async () => {
    setLogLevel("silent")
    testEnv = await initializeTestEnvironment({
      projectId: "sikander-fa-data-002-members",
      firestore: { rules: RULES },
    })
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, "matters", MATTER), { firmId: FIRM, title: "FA-DATA-002", classification: "internal" })
      for (const caller of [PARTNER, PARTNER_LOW, ASSIGNEE]) {
        await setDoc(doc(db, "users", caller.uid), { ...caller.claims, active: true })
      }
      for (const caller of [PARTNER, PARTNER_LOW]) {
        await setDoc(doc(db, "matter_members", `${MATTER}_${caller.uid}`), {
          firmId: FIRM,
          matterId: MATTER,
          userId: caller.uid,
          addedBy: PARTNER.uid,
          classification: "internal",
          createdAt: Timestamp.now(),
        })
      }
    })
  }, 120_000)

  afterAll(async () => {
    await testEnv?.cleanup()
  })

  async function as(caller: Caller) {
    const firebase = { sign_in_provider: "password", sign_in_second_factor: "phone" } as unknown as { sign_in_provider: "password" }
    return testEnv.authenticatedContext(caller.uid, { ...caller.claims, firebase }).firestore()
  }

  const memberId = `${MATTER}_${ASSIGNEE.uid}`

  async function seed(data: Record<string, unknown>) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "matter_members", memberId), {
        firmId: FIRM,
        matterId: MATTER,
        userId: ASSIGNEE.uid,
        addedBy: PARTNER.uid,
        createdAt: Timestamp.now(),
        ...data,
      })
    })
  }

  it("denies a stored label being lowered", async () => {
    await seed({ classification: "privileged-restricted" })
    await assertFails(updateDoc(doc(await as(PARTNER), "matter_members", memberId), { classification: "public" }))
    await assertFails(updateDoc(doc(await as(PARTNER), "matter_members", memberId), { classification: "privileged" }))
  })

  it("allows a cleared raise and a same-rank note update", async () => {
    await seed({ classification: "internal" })
    await assertSucceeds(updateDoc(doc(await as(PARTNER), "matter_members", memberId), { classification: "confidential" }))
    await assertSucceeds(updateDoc(doc(await as(PARTNER), "matter_members", memberId), { note: "lead" }))
  })

  it("still denies removing a stored classification", async () => {
    await seed({ classification: "internal" })
    await assertFails(updateDoc(doc(await as(PARTNER), "matter_members", memberId), { classification: deleteField() }))
  })

  it("denies a raise above the caller's clearance, and a note update on a label the caller is not cleared for", async () => {
    await seed({ classification: "internal" })
    await assertFails(updateDoc(doc(await as(PARTNER_LOW), "matter_members", memberId), { classification: "privileged" }))
    await seed({ classification: "privileged" })
    await assertFails(updateDoc(doc(await as(PARTNER_LOW), "matter_members", memberId), { note: "lead" }))
  })

  it("keeps a legacy row without classification updatable", async () => {
    await seed({})
    await assertSucceeds(updateDoc(doc(await as(PARTNER), "matter_members", memberId), { note: "legacy" }))
    const snap = await getDoc(doc(await as(PARTNER), "matter_members", memberId))
    expect(snap.data()?.note).toBe("legacy")
    expect(snap.data()).not.toHaveProperty("classification")
  })
})
