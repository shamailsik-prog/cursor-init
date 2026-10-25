// Audit FA-D4-001-FU1 (spec R9, R10): court-ops acknowledgement rows are keyed ops:court_ops:ack:{firmId}:{queueType}:{itemId}
// and only the server writes them (Admin SDK). The rules bind a client get of a row under that prefix to the caller's
// firm AND to the firm-qualified id built from the row's own firm, queue and item: a legacy
// ops:court_ops:ack:{queueType}:{itemId} row, a row whose id names one firm while it is stamped with another, and the row
// main let firm A plant at firm B's id are refused. Other workflow_ops_activity rows keep their rule. List stays
// firm-scoped; no client writes. Firestore emulator.
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, setLogLevel, updateDoc, where } from "firebase/firestore"

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const HAS_FIRESTORE_EMULATOR = Boolean(process.env.FIRESTORE_EMULATOR_HOST?.trim())
const RULES = readFileSync("firestore.rules", "utf8")
const COLL = "workflow_ops_activity"
const FIRM_A = "fu1-rules-firm-a"
const FIRM_B = "fu1-rules-firm-b"

type Caller = { uid: string; claims: Record<string, unknown> }
const caller = (uid: string, firmId: string, role: string): Caller => ({ uid, claims: { firmId, role, clearanceLevel: "privileged-restricted" } })
const A_PARTNER = caller("fu1-a-partner", FIRM_A, "partner")
const A_ASSOC = caller("fu1-a-assoc", FIRM_A, "associate")
const A_CLERK = caller("fu1-a-clerk", FIRM_A, "clerk")
const B_PARTNER = caller("fu1-b-partner", FIRM_B, "partner")
const A_STAFF = [A_PARTNER, A_ASSOC, A_CLERK]

const ackId = (firmId: string, queueType: string, item: string) => `ops:court_ops:ack:${firmId}:${queueType}:${item}`

function ack(firmId: string, queueType: string, item: string, extra: Record<string, unknown> = {}) {
  return {
    firmId,
    source: "court_ops",
    action: "court_ops_acknowledge",
    actorId: `${firmId}-actor`,
    classification: "internal",
    matterId: null,
    documentId: queueType === "workflow" ? item : null,
    followUpId: queueType === "follow_up" ? item : null,
    queueType,
    status: "acknowledged",
    detail: `${firmId} acknowledged`,
    tags: ["court", "ops"],
    createdAt: 10,
    ...extra,
  }
}

const ID_A = ackId(FIRM_A, "workflow", "doc_a")
const ID_A_FOLLOW = ackId(FIRM_A, "follow_up", "fu_a")
const ID_B = ackId(FIRM_B, "workflow", "doc_b")
/** The pre-fix id, stamped with firm A. */
const LEGACY = "ops:court_ops:ack:workflow:doc_l"
/** Names firm A in its id, stamped with firm B. */
const MISMATCHED = ackId(FIRM_A, "workflow", "doc_m")
/** What main let firm A write: queueType = B's firm id, id = "workflow:doc_p", landing on B's firm-qualified id. */
const PLANTED = ackId(FIRM_B, "workflow", "doc_p")
const EVENT = "ops:workflow_event:wfe_fu1"
/** At firm A's firm-qualified id, but not an acknowledgement row (another action). */
const NOT_AN_ACK = ackId(FIRM_A, "workflow", "doc_x")

let env: RulesTestEnvironment

/**
 * A client listing the rules can prove (pre-existing list rule): the caller's firm, the labels the caller is cleared
 * for, and firm-level rows (matterId null, as every acknowledgement row is).
 */
const firmList = (db: Awaited<ReturnType<typeof as>>, firmId: string) =>
  getDocs(
    query(
      collection(db, COLL),
      where("firmId", "==", firmId),
      where("classification", "in", ["public", "internal", "confidential", "privileged", "privileged-restricted"]),
      where("matterId", "==", null)
    )
  )

async function as(c: Caller) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users", c.uid), { ...c.claims, active: true })
  })
  return env.authenticatedContext(c.uid, c.claims).firestore()
}

describe.runIf(HAS_FIRESTORE_EMULATOR)("FA-D4-001-FU1 rules: court-ops acknowledgement rows are firm-scoped by id and by row", () => {
  beforeAll(async () => {
    setLogLevel("silent")
    env = await initializeTestEnvironment({ projectId: "demo-fa-d4-001-fu1-rules", firestore: { rules: RULES } })
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, COLL, ID_A), ack(FIRM_A, "workflow", "doc_a"))
      await setDoc(doc(db, COLL, ID_A_FOLLOW), ack(FIRM_A, "follow_up", "fu_a"))
      await setDoc(doc(db, COLL, ID_B), ack(FIRM_B, "workflow", "doc_b"))
      await setDoc(doc(db, COLL, LEGACY), ack(FIRM_A, "workflow", "doc_l"))
      await setDoc(doc(db, COLL, MISMATCHED), ack(FIRM_B, "workflow", "doc_m"))
      await setDoc(doc(db, COLL, PLANTED), ack(FIRM_A, FIRM_B, "workflow:doc_p", { documentId: null, followUpId: null }))
      await setDoc(doc(db, COLL, NOT_AN_ACK), ack(FIRM_A, "workflow", "doc_x", { action: "court_ops_resolve_follow_up" }))
      await setDoc(doc(db, COLL, EVENT), {
        ...ack(FIRM_A, "workflow", "doc_e"),
        source: "workflow_event",
        action: "workflow_transition",
        queueType: null,
      })
    })
  })

  afterAll(async () => {
    await env?.cleanup()
  })

  it("control: each staff role of firm A gets firm A's canonical rows and its other activity rows, and lists firm A's rows", async () => {
    for (const c of A_STAFF) {
      const db = await as(c)
      await assertSucceeds(getDoc(doc(db, COLL, ID_A)))
      await assertSucceeds(getDoc(doc(db, COLL, ID_A_FOLLOW)))
      await assertSucceeds(getDoc(doc(db, COLL, EVENT)))
      const listed = await assertSucceeds(firmList(db, FIRM_A))
      expect(listed.docs.every((d) => d.data().firmId === FIRM_A)).toBe(true)
    }
  })

  it("firm A cannot get or list firm B's rows, and firm B cannot get firm A's", async () => {
    for (const c of A_STAFF) {
      const db = await as(c)
      await assertFails(getDoc(doc(db, COLL, ID_B)))
      await assertFails(firmList(db, FIRM_B))
    }
    const dbB = await as(B_PARTNER)
    await assertFails(getDoc(doc(dbB, COLL, ID_A)))
    await assertFails(firmList(dbB, FIRM_A))
  })

  it("no client of either firm can create, update or delete an acknowledgement row (the server writes them)", async () => {
    for (const c of [...A_STAFF, B_PARTNER]) {
      const db = await as(c)
      const own = c.claims.firmId as string
      await assertFails(setDoc(doc(db, COLL, ackId(own, "workflow", "doc_new")), ack(own, "workflow", "doc_new")))
      await assertFails(updateDoc(doc(db, COLL, ID_A), { detail: "rewritten" }))
      await assertFails(updateDoc(doc(db, COLL, ID_B), { detail: "rewritten" }))
      await assertFails(deleteDoc(doc(db, COLL, ID_A)))
      await assertFails(deleteDoc(doc(db, COLL, ID_B)))
    }
  })

  it("a legacy ops:court_ops:ack:{queueType}:{itemId} row cannot be got, even by the firm it is stamped with", async () => {
    await assertFails(getDoc(doc(await as(A_PARTNER), COLL, LEGACY)))
  })

  it("a row whose id names firm A but is stamped with firm B can be got by neither firm", async () => {
    await assertFails(getDoc(doc(await as(A_PARTNER), COLL, MISMATCHED)))
    await assertFails(getDoc(doc(await as(B_PARTNER), COLL, MISMATCHED)))
  })

  it("the row main let firm A plant at firm B's id can be got by neither firm", async () => {
    await assertFails(getDoc(doc(await as(A_PARTNER), COLL, PLANTED)))
    await assertFails(getDoc(doc(await as(B_PARTNER), COLL, PLANTED)))
  })

  it("a row under the acknowledgement prefix that is not an acknowledgement (another action) cannot be got", async () => {
    await assertFails(getDoc(doc(await as(A_PARTNER), COLL, NOT_AN_ACK)))
  })

  it("firm A's client and intern cannot get firm A's acknowledgement row", async () => {
    await assertFails(getDoc(doc(await as(caller("fu1-a-client", FIRM_A, "client")), COLL, ID_A)))
    await assertFails(getDoc(doc(await as(caller("fu1-a-intern", FIRM_A, "intern")), COLL, ID_A)))
  })
})
