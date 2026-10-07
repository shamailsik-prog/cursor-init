import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing"
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  setLogLevel,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore"

/**
 * Phase 2a (spec §5): the matter spine and Module 6 conflict collections are written only by
 * Cloud Functions (Admin SDK, which bypasses these rules). The client SDK may never write them,
 * and reads are scoped by firm, role, matter membership and clearance on the row's
 * classification (a row without classification is denied).
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let testEnv: RulesTestEnvironment
const RULES = readFileSync("firestore.rules", "utf8")

const FIRM = "p2a-firm"
const OTHER_FIRM = "p2a-firm-b"
const MATTER = "p2aM"
const MATTER_NO_MEMBERS = "p2aM2"

const PARTNER = { uid: "p2a-partner", claims: { firmId: FIRM, role: "partner", clearanceLevel: "privileged-restricted" } }
const PARTNER_LOW = { uid: "p2a-partner-low", claims: { firmId: FIRM, role: "partner", clearanceLevel: "internal" } }
const ASSOC = { uid: "p2a-assoc", claims: { firmId: FIRM, role: "associate", clearanceLevel: "internal" } }
const ASSOC_OTHER = { uid: "p2a-assoc2", claims: { firmId: FIRM, role: "associate", clearanceLevel: "internal" } }
const CLERK = { uid: "p2a-clerk", claims: { firmId: FIRM, role: "clerk", clearanceLevel: "internal" } }
const CLIENT = { uid: "p2a-client", claims: { firmId: FIRM, role: "client", clearanceLevel: "privileged-restricted" } }
const ACCOUNTS = { uid: "p2a-accounts", claims: { firmId: FIRM, role: "accounts", clearanceLevel: "privileged-restricted" } }
const FIRM_B_PARTNER = { uid: "p2a-b-partner", claims: { firmId: OTHER_FIRM, role: "partner", clearanceLevel: "privileged-restricted" } }

type Caller = { uid: string; claims: Record<string, string> }

/** A live, second-factor signed-in caller whose users/{uid} record matches its token (SEC-3). */
async function as(caller: Caller) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users", caller.uid), { ...caller.claims, active: true }, { merge: true })
  })
  const firebase = { sign_in_provider: "password", sign_in_second_factor: "phone" } as unknown as { sign_in_provider: "password" }
  return testEnv.authenticatedContext(caller.uid, { ...caller.claims, firebase }).firestore()
}

/** One seeded row per new collection, readable in principle (internal, same firm, member matter). */
const ROWS: Record<string, Record<string, unknown>> = {
  conflict_checks: { requestedBy: ASSOC.uid, result: "FLAG", identityBasis: "candidate_only", decision: "pending", boundMatterId: null, stale: false },
  conflict_events: { checkId: "cc1", kind: "decided", actorId: ASSOC.uid, detail: {} },
  matter_parties: { matterId: MATTER, role: "opposing", name: "Muhammad Ali", names: ["muhammad ali"], keys: {}, matterClassification: "internal", matterStatus: "live" },
  matter_events: { matterId: MATTER, kind: "opened", actorId: PARTNER.uid },
  entity_links: { leftId: "e1", rightId: "e2", key: "cnic", state: "candidate", disputed: false },
  entities: { canonicalName: "Acme Traders" },
  counters: { kind: "matter", year: 2026, next: 7 },
  transliteration_map: { script: "محمد", roman: ["muhammad"] },
  events: { type: "matter.created", matterId: MATTER },
}
const COLLECTIONS = Object.keys(ROWS)
const SERVER_ONLY = ["counters", "transliteration_map", "events"]

function row(name: string, classification: string | null, firmId = FIRM) {
  return { firmId, ...ROWS[name], ...(classification === null ? {} : { classification }), createdAt: Timestamp.now() }
}

beforeAll(async () => {
  setLogLevel("silent")
  testEnv = await initializeTestEnvironment({ projectId: "sikander-d1-phase2a-rules", firestore: { rules: RULES } })
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, "matters", MATTER), { firmId: FIRM, title: "Phase 2a", classification: "internal" })
    await setDoc(doc(db, "matters", MATTER_NO_MEMBERS), { firmId: FIRM, title: "Nobody here", classification: "internal" })
    // Members of MATTER: the partner, the associate, and (forged) the client, accounts and a firm-B partner.
    for (const c of [PARTNER, PARTNER_LOW, ASSOC, CLIENT, ACCOUNTS, FIRM_B_PARTNER]) {
      await setDoc(doc(db, "matter_members", `${MATTER}_${c.uid}`), { firmId: FIRM, matterId: MATTER, userId: c.uid })
    }
    for (const name of COLLECTIONS) {
      await setDoc(doc(db, name, "rowInternal"), row(name, "internal"))
      await setDoc(doc(db, name, "rowPriv"), row(name, "privileged"))
      await setDoc(doc(db, name, "rowNoCls"), row(name, null))
    }
    // A client-role user named as requester and a firm-B row (fixture for the cross-firm list).
    await setDoc(doc(db, "conflict_checks", "rowClientOwn"), { ...row("conflict_checks", "internal"), requestedBy: CLIENT.uid })
    await setDoc(doc(db, "matter_events", "rowOtherMatter"), { ...row("matter_events", "internal"), matterId: MATTER_NO_MEMBERS })
    await setDoc(doc(db, "matter_parties", "rowOtherMatter"), { ...row("matter_parties", "internal"), matterId: MATTER_NO_MEMBERS })
    await setDoc(doc(db, "matter_parties", "rowNullMatter"), { ...row("matter_parties", "internal"), matterId: null })
    // A check by ASSOC (cleared to it) whose stored, unredacted hit names a matter ASSOC is not on.
    await setDoc(doc(db, "conflict_checks", "rowHitsHidden"), {
      ...row("conflict_checks", "internal"),
      requestedBy: ASSOC.uid,
      hits: [{ subjectIndex: 0, hitRole: "opposing", type: "direct_adverse", basis: "name", score: 0.92, identityBasis: "candidate_only",
        outcome: "POSSIBLE_CANDIDATE_REVIEW", matchedName: "Muhammad Ali", matterId: MATTER_NO_MEMBERS, matterNo: "SA/2026/0007",
        matterClassification: "internal", reliedOnLinkIds: [] }],
      boundMatterId: null,
    })
  })
})

afterAll(async () => {
  await testEnv?.cleanup()
})

describe.each(COLLECTIONS)("Phase 2a %s: no client SDK writes", (name) => {
  it("a cleared member partner cannot create, update or delete", async () => {
    const db = await as(PARTNER)
    await assertFails(setDoc(doc(db, name, "sdkNew"), { ...row(name, "privileged"), createdAt: serverTimestamp() }))
    await assertFails(updateDoc(doc(db, name, "rowInternal"), { classification: "privileged" }))
    await assertFails(deleteDoc(doc(db, name, "rowInternal")))
  })
  it("an associate and a clerk cannot create either", async () => {
    await assertFails(setDoc(doc(await as(ASSOC), name, "sdkNewA"), { ...row(name, "internal"), requestedBy: ASSOC.uid }))
    await assertFails(setDoc(doc(await as(CLERK), name, "sdkNewC"), row(name, "internal")))
  })
})

describe.each(COLLECTIONS)("Phase 2a %s: reads never cross the firm or reach client/accounts roles", (name) => {
  it("a firm-B partner (max clearance, forged membership) is denied get and list", async () => {
    const db = await as(FIRM_B_PARTNER)
    await assertFails(getDoc(doc(db, name, "rowInternal")))
    await assertFails(getDocs(query(collection(db, name), where("firmId", "==", FIRM))))
  })
  it("a client-role user (max clearance, forged membership) is denied every read", async () => {
    const db = await as(CLIENT)
    await assertFails(getDoc(doc(db, name, "rowInternal")))
    await assertFails(getDocs(query(collection(db, name), where("firmId", "==", FIRM))))
  })
  it("the register-only accounts role is denied", async () => {
    await assertFails(getDoc(doc(await as(ACCOUNTS), name, "rowInternal")))
  })
  it("a row without classification is denied even to a cleared member partner (fail closed)", async () => {
    await assertFails(getDoc(doc(await as(PARTNER), name, "rowNoCls")))
  })
})

describe.each(SERVER_ONLY)("Phase 2a %s: server-only", (name) => {
  it("no client reads it, not even a cleared member partner", async () => {
    await assertFails(getDoc(doc(await as(PARTNER), name, "rowInternal")))
  })
})

describe("conflict_checks: same-firm partner with clearance only (the requester reads via getConflictResult)", () => {
  it("a requesting associate cannot read their own unredacted check (it names a matter they are not on); a partner can", async () => {
    // The stored row is unredacted: discloseFor (functions/src/d1/conflict/disclosure.ts) hides matterId /
    // matterNo / matterClassification / boundMatterId from a non-member non-partner, so the
    // client SDK must never hand the raw row to the requester.
    await assertFails(getDoc(doc(await as(ASSOC), "conflict_checks", "rowHitsHidden")))
    await assertFails(getDocs(query(collection(await as(ASSOC), "conflict_checks"), where("firmId", "==", FIRM), where("requestedBy", "==", ASSOC.uid))))
    await assertSucceeds(getDoc(doc(await as(PARTNER), "conflict_checks", "rowHitsHidden")))
    await assertSucceeds(getDoc(doc(await as(PARTNER), "conflict_checks", "rowInternal")))
  })
  it("no non-partner reads a check: the requester, another associate, a clerk", async () => {
    await assertFails(getDoc(doc(await as(ASSOC), "conflict_checks", "rowInternal")))
    await assertFails(getDoc(doc(await as(ASSOC_OTHER), "conflict_checks", "rowInternal")))
    await assertFails(getDoc(doc(await as(CLERK), "conflict_checks", "rowInternal")))
  })
  it("a partner below the check's classification is denied", async () => {
    await assertFails(getDoc(doc(await as(PARTNER_LOW), "conflict_checks", "rowPriv")))
    await assertSucceeds(getDoc(doc(await as(PARTNER), "conflict_checks", "rowPriv")))
  })
  it("a client-role user named as requester still cannot read it", async () => {
    await assertFails(getDoc(doc(await as(CLIENT), "conflict_checks", "rowClientOwn")))
  })
})

describe("conflict_events: same-firm partner with clearance only", () => {
  it("a partner reads; the associate who ran the check does not", async () => {
    await assertSucceeds(getDoc(doc(await as(PARTNER), "conflict_events", "rowInternal")))
    await assertFails(getDoc(doc(await as(ASSOC), "conflict_events", "rowInternal")))
    await assertFails(getDoc(doc(await as(CLERK), "conflict_events", "rowInternal")))
  })
  it("a partner below the row's classification is denied", async () => {
    await assertFails(getDoc(doc(await as(PARTNER_LOW), "conflict_events", "rowPriv")))
    await assertSucceeds(getDoc(doc(await as(PARTNER), "conflict_events", "rowPriv")))
  })
})

describe.each(["entity_links", "entities"])("%s: same-firm staff with clearance", (name) => {
  it("staff read, member or not (associate, clerk, partner)", async () => {
    await assertSucceeds(getDoc(doc(await as(ASSOC_OTHER), name, "rowInternal")))
    await assertSucceeds(getDoc(doc(await as(CLERK), name, "rowInternal")))
    await assertSucceeds(getDoc(doc(await as(PARTNER), name, "rowInternal")))
  })
  it("staff below the row's classification are denied", async () => {
    await assertFails(getDoc(doc(await as(ASSOC), name, "rowPriv")))
    await assertFails(getDoc(doc(await as(PARTNER_LOW), name, "rowPriv")))
    await assertSucceeds(getDoc(doc(await as(PARTNER), name, "rowPriv")))
  })
})

describe("matter_parties: same-firm, cleared, and a partner or a member of the party's matter", () => {
  it("a cleared member associate reads; a cleared non-member associate or clerk does not", async () => {
    await assertSucceeds(getDoc(doc(await as(ASSOC), "matter_parties", "rowInternal")))
    await assertFails(getDoc(doc(await as(ASSOC_OTHER), "matter_parties", "rowInternal")))
    await assertFails(getDoc(doc(await as(CLERK), "matter_parties", "rowInternal")))
    await assertSucceeds(getDoc(doc(await as(PARTNER), "matter_parties", "rowInternal")))
  })
  it("a partner who is not a member of the party's matter can read (conflict review)", async () => {
    await assertSucceeds(getDoc(doc(await as(PARTNER), "matter_parties", "rowOtherMatter")))
    await assertFails(getDoc(doc(await as(ASSOC), "matter_parties", "rowOtherMatter")))
  })
  it("a standalone registry row (matterId null) is partner-only", async () => {
    await assertFails(getDoc(doc(await as(ASSOC), "matter_parties", "rowNullMatter")))
    await assertFails(getDoc(doc(await as(CLERK), "matter_parties", "rowNullMatter")))
    await assertSucceeds(getDoc(doc(await as(PARTNER), "matter_parties", "rowNullMatter")))
  })
  it("a member below the row's classification is denied, partner included", async () => {
    await assertFails(getDoc(doc(await as(ASSOC), "matter_parties", "rowPriv")))
    await assertFails(getDoc(doc(await as(PARTNER_LOW), "matter_parties", "rowPriv")))
    await assertSucceeds(getDoc(doc(await as(PARTNER), "matter_parties", "rowPriv")))
  })
})

describe("matter_events: members of the matter with clearance", () => {
  it("a member associate reads; a non-member associate does not", async () => {
    await assertSucceeds(getDoc(doc(await as(ASSOC), "matter_events", "rowInternal")))
    await assertFails(getDoc(doc(await as(ASSOC_OTHER), "matter_events", "rowInternal")))
  })
  it("no role is exempt: a partner who is not a member of the event's matter is denied", async () => {
    await assertFails(getDoc(doc(await as(PARTNER), "matter_events", "rowOtherMatter")))
  })
  it("a member below the row's classification is denied", async () => {
    await assertFails(getDoc(doc(await as(ASSOC), "matter_events", "rowPriv")))
    await assertSucceeds(getDoc(doc(await as(PARTNER), "matter_events", "rowPriv")))
  })
})

describe("matter_members create stamps createdAt (listMatters orders by it)", () => {
  const NEW = { uid: "p2a-new", claims: { firmId: FIRM, role: "associate", clearanceLevel: "internal" } }
  beforeAll(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", NEW.uid), { ...NEW.claims, active: true })
    })
  })
  const member = { firmId: FIRM, matterId: MATTER, userId: NEW.uid }
  it("a member partner's create without createdAt is denied", async () => {
    await assertFails(setDoc(doc(await as(PARTNER), "matter_members", `${MATTER}_${NEW.uid}`), member))
  })
  it("a client-chosen createdAt (not the request time) is denied", async () => {
    const past = Timestamp.fromDate(new Date("2020-01-01T00:00:00Z"))
    await assertFails(setDoc(doc(await as(PARTNER), "matter_members", `${MATTER}_${NEW.uid}`), { ...member, createdAt: past }))
  })
  it("createdAt == request.time (serverTimestamp) is allowed", async () => {
    await assertSucceeds(setDoc(doc(await as(PARTNER), "matter_members", `${MATTER}_${NEW.uid}`), { ...member, createdAt: serverTimestamp() }))
  })
  it("createdAt is frozen: a member partner cannot rewrite it on update", async () => {
    const past = Timestamp.fromDate(new Date("2020-01-01T00:00:00Z"))
    await assertFails(updateDoc(doc(await as(PARTNER), "matter_members", `${MATTER}_${NEW.uid}`), { createdAt: past }))
    await assertFails(updateDoc(doc(await as(PARTNER), "matter_members", `${MATTER}_${NEW.uid}`), { createdAt: serverTimestamp() }))
  })
  it("an update leaving createdAt alone is still allowed (control)", async () => {
    await assertSucceeds(updateDoc(doc(await as(PARTNER), "matter_members", `${MATTER}_${NEW.uid}`), { note: "lead" }))
  })
})
