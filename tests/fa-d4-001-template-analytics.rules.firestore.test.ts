// Audit FA-D4-001: `draft_template_analytics` rows are keyed `template:{firmId}:{templateId}` and only the server
// writes them (Admin SDK). The rules bind a client read to the caller's firm AND to the firm-qualified id: firm A can
// never get, list or write firm B's rows, a legacy `template:{templateId}` row is not readable at all, and a row whose
// id names one firm while it is stamped with another is refused to both. Firestore emulator.
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, setLogLevel, updateDoc, where } from "firebase/firestore"

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const HAS_FIRESTORE_EMULATOR = Boolean(process.env.FIRESTORE_EMULATOR_HOST?.trim())
const RULES = readFileSync("firestore.rules", "utf8")
const COLL = "draft_template_analytics"
const FIRM_A = "fad4-rules-firm-a"
const FIRM_B = "fad4-rules-firm-b"
const T = "writ_mandamus"

type Caller = { uid: string; claims: Record<string, unknown> }
const caller = (uid: string, firmId: string, role: string): Caller => ({ uid, claims: { firmId, role, clearanceLevel: "privileged-restricted" } })
const A_PARTNER = caller("fad4-a-partner", FIRM_A, "partner")
const A_ASSOC = caller("fad4-a-assoc", FIRM_A, "associate")
const A_CLERK = caller("fad4-a-clerk", FIRM_A, "clerk")
const B_PARTNER = caller("fad4-b-partner", FIRM_B, "partner")
const A_STAFF = [A_PARTNER, A_ASSOC, A_CLERK]

const row = (firmId: string, extra: Record<string, unknown> = {}) => ({
  firmId,
  templateId: T,
  templateName: "Writ of Mandamus",
  templatePosture: "writ",
  templateCategory: "constitutional",
  composeCount: 3,
  templateSearchCount: 1,
  lastComposedAt: 10,
  lastTemplateSearchAt: 11,
  lastTemplateSearchQuery: `${firmId} secret search`,
  updatedAt: 12,
  ...extra,
})

const ID_A = `template:${FIRM_A}:${T}`
const ID_B = `template:${FIRM_B}:${T}`
const LEGACY = `template:${T}`
/** Names firm A in its id but is stamped with firm B. */
const MISMATCHED = `template:${FIRM_A}:writ_certiorari`

let env: RulesTestEnvironment

async function as(c: Caller) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users", c.uid), { ...c.claims, active: true })
  })
  return env.authenticatedContext(c.uid, c.claims).firestore()
}

describe.runIf(HAS_FIRESTORE_EMULATOR)("FA-D4-001 rules: draft_template_analytics is firm-scoped by id and by row", () => {
  beforeAll(async () => {
    setLogLevel("silent")
    env = await initializeTestEnvironment({ projectId: "demo-fa-d4-001-rules", firestore: { rules: RULES } })
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, COLL, ID_A), row(FIRM_A))
      await setDoc(doc(db, COLL, ID_B), row(FIRM_B))
      await setDoc(doc(db, COLL, LEGACY), row(FIRM_A))
      await setDoc(doc(db, COLL, MISMATCHED), row(FIRM_B, { templateId: "writ_certiorari" }))
    })
  })

  afterAll(async () => {
    await env?.cleanup()
  })

  it("control: each staff role of firm A reads firm A's own firm-qualified row, and lists firm A's rows", async () => {
    for (const c of A_STAFF) {
      const db = await as(c)
      await assertSucceeds(getDoc(doc(db, COLL, ID_A)))
      await assertSucceeds(getDocs(query(collection(db, COLL), where("firmId", "==", FIRM_A))))
    }
  })

  it("firm A cannot get or list firm B's row, and firm B cannot get firm A's", async () => {
    for (const c of A_STAFF) {
      const db = await as(c)
      await assertFails(getDoc(doc(db, COLL, ID_B)))
      await assertFails(getDocs(query(collection(db, COLL), where("firmId", "==", FIRM_B))))
    }
    const dbB = await as(B_PARTNER)
    await assertFails(getDoc(doc(dbB, COLL, ID_A)))
    await assertFails(getDocs(query(collection(dbB, COLL), where("firmId", "==", FIRM_A))))
  })

  it("no client of either firm can create, update or delete an analytics row (the server writes them)", async () => {
    for (const c of [...A_STAFF, B_PARTNER]) {
      const db = await as(c)
      const own = c.claims.firmId as string
      await assertFails(setDoc(doc(db, COLL, `template:${own}:writ_quo_warranto`), row(own, { templateId: "writ_quo_warranto" })))
      await assertFails(updateDoc(doc(db, COLL, ID_A), { composeCount: 99 }))
      await assertFails(updateDoc(doc(db, COLL, ID_B), { composeCount: 99 }))
      await assertFails(deleteDoc(doc(db, COLL, ID_A)))
      await assertFails(deleteDoc(doc(db, COLL, ID_B)))
    }
  })

  it("a legacy `template:{templateId}` row is not readable, even by the firm it is stamped with", async () => {
    const db = await as(A_PARTNER)
    await assertFails(getDoc(doc(db, COLL, LEGACY)))
  })

  it("a row whose id names firm A but is stamped with firm B is readable by neither firm", async () => {
    await assertFails(getDoc(doc(await as(A_PARTNER), COLL, MISMATCHED)))
    await assertFails(getDoc(doc(await as(B_PARTNER), COLL, MISMATCHED)))
  })

  it("a firm-A role outside the staff roles (intern) cannot read firm A's row", async () => {
    const db = await as(caller("fad4-a-intern", FIRM_A, "intern"))
    await assertFails(getDoc(doc(db, COLL, ID_A)))
  })
})
