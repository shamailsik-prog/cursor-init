/**
 * FA-F42-R1-003 (spec R23): every firestore.rules clause that admits a reader of a matter-keyed row WITHOUT membership
 * refuses the row once its matter is tombstoned. Membership-gated clauses end at the approval's revocation; here the
 * memberships are left in place on purpose where a clause also accepts membership, so a pass proves the tombstone clause
 * itself. Each refusal has its control: the same read of a live matter succeeds (RP0). FA-F42-R1-002 (spec R22): a
 * legacy committee output (no matterId) is refused when one of its documents is gone or tombstoned.
 */
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore"

// The emulator is shared with other suites on a loaded host: seeding about 40 rows takes longer than the 15 s default.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 })

let env: RulesTestEnvironment
const FIRM = "f42rFirm"
const DEL = "f42rDeleted"
const LIVE = "f42rLive"
type Claims = { firmId: string; role: string; clearanceLevel: string }
const as = (role: string): Claims => ({ firmId: FIRM, role, clearanceLevel: "privileged-restricted" })

async function authed(uid: string, claims: Claims) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users", uid), { active: true, ...claims }, { merge: true })
  })
  const firebase = { sign_in_provider: "password", sign_in_second_factor: "phone" } as unknown as { sign_in_provider: "password" }
  return env.authenticatedContext(uid, { ...claims, firebase }).firestore()
}

/** One row of the deleted matter and one of the live matter in `collection`, with the same shape. */
async function pair(collectionName: string, data: (matterId: string) => Record<string, unknown>): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, collectionName, `${DEL}-row`), { firmId: FIRM, classification: "internal", ...data(DEL) })
    await setDoc(doc(db, collectionName, `${LIVE}-row`), { firmId: FIRM, classification: "internal", ...data(LIVE) })
  })
}

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-f42-rules-tombstone", firestore: { rules: readFileSync("firestore.rules", "utf8") } })
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    for (const m of [DEL, LIVE]) {
      await setDoc(doc(db, "matters", m), { firmId: FIRM, title: `F42 rules ${m}`, classification: "internal", clientId: "f42r-client" })
      // Memberships stay: the tombstone alone must refuse wherever a clause also accepts membership.
      for (const uid of ["f42r-partner", "f42r-assoc", "f42r-clerk"]) {
        await setDoc(doc(db, "matter_members", `${m}_${uid}`), { firmId: FIRM, matterId: m, userId: uid })
      }
      await setDoc(doc(db, "documents", `${m}-doc`), { firmId: FIRM, matterId: m, classification: "internal" })
    }
    await setDoc(doc(db, "matter_tombstones", DEL), { firmId: FIRM, matterId: DEL, requestId: "f42r-req", classification: "internal" })
  })
  await pair("intimation_register", (m) => ({ matterId: m }))
  await pair("notifications", (m) => ({ matterId: m, userId: "f42r-assoc", read: false }))
  await pair("routing_queue", (m) => ({ matterId: m }))
  await pair("matter_parties", (m) => ({ matterId: m, name: "Party" }))
  await pair("conflict_checks", (m) => ({ boundMatterId: m, subjects: [] }))
  await pair("committee_outputs", (m) => ({ matterId: m, actorId: "someone-else", text: "x", createdAt: 1 }))
  await pair("workflow_ops_activity", (m) => ({ matterId: m }))
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    // Legacy committee outputs (written before matterId was required): only documentIds link them to a matter.
    await setDoc(doc(db, "committee_outputs", "legacy-deleted-doc"), { firmId: FIRM, actorId: "someone-else", matterId: null, documentIds: [`${DEL}-doc`], classification: "internal", text: "legacy", createdAt: 1 })
    await setDoc(doc(db, "committee_outputs", "legacy-gone-doc"), { firmId: FIRM, actorId: "someone-else", matterId: null, documentIds: ["f42r-purged-doc"], classification: "internal", text: "legacy", createdAt: 1 })
    await setDoc(doc(db, "committee_outputs", "legacy-live-doc"), { firmId: FIRM, actorId: "someone-else", matterId: null, documentIds: [`${LIVE}-doc`], classification: "internal", text: "legacy", createdAt: 1 })
    await setDoc(doc(db, "committee_outputs", "legacy-too-many"), { firmId: FIRM, actorId: "someone-else", matterId: null, documentIds: [`${LIVE}-doc`, `${LIVE}-doc`, `${LIVE}-doc`, `${LIVE}-doc`], classification: "internal", text: "legacy", createdAt: 1 })
    await setDoc(doc(db, "committee_outputs", "firm-level"), { firmId: FIRM, actorId: "someone-else", matterId: null, documentIds: [], classification: "internal", text: "firm-level", createdAt: 1 })
  })
})

afterAll(async () => {
  await env?.cleanup()
})

describe("FA-F42-R1-003: the rules refuse a tombstoned matter wherever they do not use membership", () => {
  it("RP1 a client cannot read its own matter row once the matter is tombstoned (control: its live matter)", async () => {
    const db = await authed("f42r-client", { firmId: FIRM, role: "client", clearanceLevel: "internal" })
    await assertFails(getDoc(doc(db, "matters", DEL)))
    await assertSucceeds(getDoc(doc(db, "matters", LIVE)))
  })

  it("RP2 the accounts role cannot read a tombstoned matter's intimation row (control: a live one)", async () => {
    const db = await authed("f42r-accounts", { firmId: FIRM, role: "accounts", clearanceLevel: "internal" })
    await assertFails(getDoc(doc(db, "intimation_register", `${DEL}-row`)))
    await assertSucceeds(getDoc(doc(db, "intimation_register", `${LIVE}-row`)))
  })

  it("RP3 a user can neither read nor mark read their notification about a tombstoned matter (control: a live one)", async () => {
    const db = await authed("f42r-assoc", as("associate"))
    await assertFails(getDoc(doc(db, "notifications", `${DEL}-row`)))
    await assertFails(updateDoc(doc(db, "notifications", `${DEL}-row`), { read: true, readAt: 1 }))
    await assertSucceeds(getDoc(doc(db, "notifications", `${LIVE}-row`)))
    await assertSucceeds(updateDoc(doc(db, "notifications", `${LIVE}-row`), { read: true, readAt: 1 }))
  })

  it("RP5 staff cannot read a tombstoned matter's routing-queue row (control: a live one)", async () => {
    const db = await authed("f42r-clerk", as("clerk"))
    await assertFails(getDoc(doc(db, "routing_queue", `${DEL}-row`)))
    await assertSucceeds(getDoc(doc(db, "routing_queue", `${LIVE}-row`)))
  })

  it("RP6 a non-member partner cannot read a tombstoned matter's registry rows (matter_parties, conflict_checks)", async () => {
    const db = await authed("f42r-outsider", as("partner"))
    await assertFails(getDoc(doc(db, "matter_parties", `${DEL}-row`)))
    await assertFails(getDoc(doc(db, "conflict_checks", `${DEL}-row`)))
    await assertSucceeds(getDoc(doc(db, "matter_parties", `${LIVE}-row`)))
    await assertSucceeds(getDoc(doc(db, "conflict_checks", `${LIVE}-row`)))
  })

  it("RP7 matterScoped refuses a tombstoned matter's row even to a member whose membership row survived", async () => {
    const db = await authed("f42r-partner", as("partner"))
    await assertFails(getDoc(doc(db, "committee_outputs", `${DEL}-row`)))
    await assertFails(getDoc(doc(db, "workflow_ops_activity", `${DEL}-row`)))
    await assertSucceeds(getDoc(doc(db, "committee_outputs", `${LIVE}-row`)))
    await assertSucceeds(getDoc(doc(db, "workflow_ops_activity", `${LIVE}-row`)))
  })

  it("RP0 control: list queries a client SDK makes still work on live rows (own notifications, a matter's intimation rows)", async () => {
    const assoc = await authed("f42r-assoc", as("associate"))
    await assertSucceeds(getDocs(query(collection(assoc, "notifications"), where("firmId", "==", FIRM), where("userId", "==", "f42r-assoc"), where("matterId", "==", LIVE))))
    const accounts = await authed("f42r-accounts", { firmId: FIRM, role: "accounts", clearanceLevel: "internal" })
    await assertSucceeds(getDocs(query(collection(accounts, "intimation_register"), where("firmId", "==", FIRM), where("matterId", "==", LIVE))))
  })
})

describe("FA-F42-R1-003: list queries cannot reach a tombstoned matter's rows through a non-membership clause", () => {
  // A list rule is evaluated once against the query: an unconstrained matterId read with a default would admit every
  // row, so these clauses read it directly in `list` (spec R23). Only a query constrained to a live matter (or null) passes.
  const listOf = (db: Awaited<ReturnType<typeof authed>>, name: string, ...filters: Array<[string, unknown]>) =>
    getDocs(query(collection(db, name), where("firmId", "==", FIRM), ...filters.map(([k, v]) => where(k, "==", v))))

  it("RP8 own notifications: an unconstrained list and one constrained to the tombstoned matter are refused", async () => {
    const db = await authed("f42r-assoc", as("associate"))
    await assertFails(listOf(db, "notifications", ["userId", "f42r-assoc"]))
    await assertFails(listOf(db, "notifications", ["userId", "f42r-assoc"], ["matterId", DEL]))
    await assertSucceeds(listOf(db, "notifications", ["userId", "f42r-assoc"], ["matterId", LIVE]))
  })

  it("RP9 the accounts register, the routing queue and a partner's registry rows: lists of the tombstoned matter are refused", async () => {
    const accounts = await authed("f42r-accounts", { firmId: FIRM, role: "accounts", clearanceLevel: "internal" })
    await assertFails(listOf(accounts, "intimation_register"))
    await assertFails(listOf(accounts, "intimation_register", ["matterId", DEL]))
    await assertSucceeds(listOf(accounts, "intimation_register", ["matterId", LIVE]))
    const clerk = await authed("f42r-clerk", as("clerk"))
    await assertFails(listOf(clerk, "routing_queue"))
    await assertFails(listOf(clerk, "routing_queue", ["matterId", DEL]))
    await assertSucceeds(listOf(clerk, "routing_queue", ["matterId", LIVE]))
    // These two also read the row's label, so a list must constrain classification as well (as before this change).
    const partner = await authed("f42r-outsider", as("partner"))
    const internal: [string, unknown] = ["classification", "internal"]
    await assertFails(listOf(partner, "matter_parties", internal, ["matterId", DEL]))
    await assertSucceeds(listOf(partner, "matter_parties", internal, ["matterId", LIVE]))
    await assertFails(listOf(partner, "conflict_checks", internal, ["boundMatterId", DEL]))
    await assertSucceeds(listOf(partner, "conflict_checks", internal, ["boundMatterId", LIVE]))
  })
})

describe("FA-F42-R1-002: a legacy committee output (no matterId) is refused when its documents are gone or tombstoned", () => {
  it("RP4a a partner cannot read a legacy output whose document belongs to a tombstoned matter", async () => {
    const db = await authed("f42r-outsider", as("partner"))
    await assertFails(getDoc(doc(db, "committee_outputs", "legacy-deleted-doc")))
  })

  it("RP4c a partner cannot read a legacy output whose document is gone (purged)", async () => {
    const db = await authed("f42r-outsider", as("partner"))
    await assertFails(getDoc(doc(db, "committee_outputs", "legacy-gone-doc")))
  })

  it("RP4d a legacy output naming more documents than the rules can check is refused (fail closed)", async () => {
    const db = await authed("f42r-outsider", as("partner"))
    await assertFails(getDoc(doc(db, "committee_outputs", "legacy-too-many")))
  })

  it("RP4 control: a legacy output whose document is live, and a firm-level output with no documents, stay readable", async () => {
    const db = await authed("f42r-outsider", as("partner"))
    await assertSucceeds(getDoc(doc(db, "committee_outputs", "legacy-live-doc")))
    await assertSucceeds(getDoc(doc(db, "committee_outputs", "firm-level")))
  })
})
