import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, it } from "vitest"
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing"
import {
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore"

let testEnv: RulesTestEnvironment

const RULES = readFileSync("firestore.rules", "utf8")

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "sikander-g0-rules",
    firestore: { rules: RULES },
  })

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, "matters", "m1"), {
      firmId: "firmA",
      title: "NHS v Example",
    })
    await setDoc(doc(db, "matter_members", "m1_member1"), {
      firmId: "firmA",
      matterId: "m1",
      userId: "member1",
    })
    await setDoc(doc(db, "documents", "loose1"), {
      firmId: "firmA",
      matterId: null,
      classification: "confidential",
    })
    await setDoc(doc(db, "master_versions", "v1"), {
      firmId: "firmA",
      body: "mirror only",
    })
  })
})

afterAll(async () => {
  await testEnv?.cleanup()
})

function authed(uid: string, claims: Record<string, string>) {
  return testEnv.authenticatedContext(uid, claims).firestore()
}

describe("Job E — Firestore rules", () => {
  it("cross-firm matter read = deny", async () => {
    const db = authed("firmB-assoc", {
      firmId: "firmB",
      role: "associate",
      clearanceLevel: "privileged",
    })
    await assertFails(getDoc(doc(db, "matters", "m1")))
  })

  it("intern cannot read loose-vault docs", async () => {
    const intern = authed("intern1", {
      firmId: "firmA",
      role: "intern",
      clearanceLevel: "confidential",
    })
    await assertFails(getDoc(doc(intern, "documents", "loose1")))
  })

  it("master_versions client write = deny", async () => {
    const partner = authed("partner1", {
      firmId: "firmA",
      role: "partner",
      clearanceLevel: "privileged",
    })
    await assertFails(
      setDoc(doc(partner, "master_versions", "v1"), {
        firmId: "firmA",
        body: "client write",
      })
    )
    await assertFails(
      setDoc(doc(partner, "master_versions", "new"), {
        firmId: "firmA",
        body: "create",
      })
    )
  })

  it("non-member cannot read a matter regardless of role", async () => {
    for (const role of ["partner", "associate", "clerk", "intern", "accounts"] as const) {
      const db = authed(`nonmember-${role}`, {
        firmId: "firmA",
        role,
        clearanceLevel: "privileged-restricted",
      })
      await assertFails(getDoc(doc(db, "matters", "m1")))
    }
  })

  it("same-firm member can read the matter", async () => {
    const db = authed("member1", {
      firmId: "firmA",
      role: "associate",
      clearanceLevel: "internal",
    })
    await assertSucceeds(getDoc(doc(db, "matters", "m1")))
  })
})
