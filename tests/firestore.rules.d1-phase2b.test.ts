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
 * Phase 2b-A (spec §5, ruling P2-36, erratum E-41(c)): `merge_events` and `entity_aliases` are
 * server-only. confirmMerge (Cloud Functions, Admin SDK) is the only merge_events writer, and the
 * Phase 0 partner "revert-only" SDK update is withdrawn (a revert outside the 2b-B saga is a
 * half-state, L8414). No entity_aliases writer exists. Reads: merge_events by same-firm partner or
 * associate, entity_aliases by same-firm staff, both cleared to the row's classification; a row
 * without classification fails closed.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let testEnv: RulesTestEnvironment
const RULES = readFileSync("firestore.rules", "utf8")

const FIRM = "p2b-firm"
const OTHER_FIRM = "p2b-firm-b"

const PARTNER = { uid: "p2b-partner", claims: { firmId: FIRM, role: "partner", clearanceLevel: "privileged-restricted" } }
const PARTNER_LOW = { uid: "p2b-partner-low", claims: { firmId: FIRM, role: "partner", clearanceLevel: "internal" } }
const ASSOC = { uid: "p2b-assoc", claims: { firmId: FIRM, role: "associate", clearanceLevel: "internal" } }
const CLERK = { uid: "p2b-clerk", claims: { firmId: FIRM, role: "clerk", clearanceLevel: "internal" } }
const CLERK_HIGH = { uid: "p2b-clerk-high", claims: { firmId: FIRM, role: "clerk", clearanceLevel: "privileged-restricted" } }
const INTERN = { uid: "p2b-intern", claims: { firmId: FIRM, role: "intern", clearanceLevel: "privileged-restricted" } }
const CLIENT = { uid: "p2b-client", claims: { firmId: FIRM, role: "client", clearanceLevel: "privileged-restricted" } }
const ACCOUNTS = { uid: "p2b-accounts", claims: { firmId: FIRM, role: "accounts", clearanceLevel: "privileged-restricted" } }
const FIRM_B_PARTNER = { uid: "p2b-b-partner", claims: { firmId: OTHER_FIRM, role: "partner", clearanceLevel: "privileged-restricted" } }
const FIRM_B_CLERK = { uid: "p2b-b-clerk", claims: { firmId: OTHER_FIRM, role: "clerk", clearanceLevel: "privileged-restricted" } }

type Caller = { uid: string; claims: Record<string, string> }

/** A live, second-factor signed-in caller whose users/{uid} record matches its token (SEC-3). */
async function as(caller: Caller) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users", caller.uid), { ...caller.claims, active: true }, { merge: true })
  })
  const firebase = { sign_in_provider: "password", sign_in_second_factor: "phone" } as unknown as { sign_in_provider: "password" }
  return testEnv.authenticatedContext(caller.uid, { ...caller.claims, firebase }).firestore()
}

/** The confirmMerge row shape (global-constraints "Data shapes"). */
function mergeEvent(classification: string | null) {
  return {
    firmId: FIRM,
    kind: "link_confirmed",
    leftId: "e1",
    rightId: "e2",
    pairId: "e1_e2",
    linkIds: [`${FIRM}_e1_e2_cnic`],
    keys: ["cnic"],
    evidence: { note: "Same CNIC on both registrations, verified.", keyValues: { cnic: "3520112345671" } },
    score: 0.99,
    basis: "deterministic_key",
    priorState: "candidate",
    actorId: PARTNER.uid,
    actorRole: "partner",
    confirmedAt: Timestamp.now(),
    createdAt: Timestamp.now(),
    snapshot: {
      left: { entityId: "e1", canonicalName: "Acme Traders", cnic: "3520112345671", classification: "internal" },
      right: { entityId: "e2", canonicalName: "Acme Traders Pvt", cnic: "3520112345671", classification: "internal" },
    },
    reverted: false,
    ...(classification === null ? {} : { classification }),
  }
}

function alias(classification: string | null) {
  return { firmId: FIRM, entityId: "e1", kind: "name", value: "ACME", ...(classification === null ? {} : { classification }) }
}

beforeAll(async () => {
  setLogLevel("silent")
  testEnv = await initializeTestEnvironment({ projectId: "sikander-d1-phase2b-rules", firestore: { rules: RULES } })
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, "merge_events", "meInternal"), mergeEvent("internal"))
    await setDoc(doc(db, "merge_events", "meConfidential"), mergeEvent("confidential"))
    await setDoc(doc(db, "merge_events", "meNoCls"), mergeEvent(null))
    await setDoc(doc(db, "entity_aliases", "alInternal"), alias("internal"))
    await setDoc(doc(db, "entity_aliases", "alPriv"), alias("privileged"))
    await setDoc(doc(db, "entity_aliases", "alNoCls"), alias(null))
  })
})

afterAll(async () => {
  await testEnv?.cleanup()
})

describe("merge_events: server-only (P2-36)", () => {
  it("a cleared partner cannot create one through the SDK (previously allowed)", async () => {
    const db = await as(PARTNER)
    await assertFails(setDoc(doc(db, "merge_events", "sdkNew"), { ...mergeEvent("internal"), createdAt: serverTimestamp() }))
  })
  it("an associate cannot create one either (previously allowed)", async () => {
    await assertFails(setDoc(doc(await as(ASSOC), "merge_events", "sdkNewA"), { ...mergeEvent("internal"), actorId: ASSOC.uid, actorRole: "associate" }))
  })
  it("the Phase 0 partner revert-only update is withdrawn", async () => {
    const db = await as(PARTNER)
    await assertFails(updateDoc(doc(db, "merge_events", "meInternal"), { reverted: true, revertedBy: PARTNER.uid, revertedAt: serverTimestamp() }))
  })
  it("no one deletes one", async () => {
    await assertFails(deleteDoc(doc(await as(PARTNER), "merge_events", "meInternal")))
  })
})

describe("merge_events: reads by same-firm partner or associate cleared to the row", () => {
  it("an internal associate reads an internal row and is denied a confidential one", async () => {
    const db = await as(ASSOC)
    await assertSucceeds(getDoc(doc(db, "merge_events", "meInternal")))
    await assertFails(getDoc(doc(db, "merge_events", "meConfidential")))
  })
  it("a partner reads only up to their clearance", async () => {
    await assertSucceeds(getDoc(doc(await as(PARTNER), "merge_events", "meConfidential")))
    await assertSucceeds(getDoc(doc(await as(PARTNER_LOW), "merge_events", "meInternal")))
    await assertFails(getDoc(doc(await as(PARTNER_LOW), "merge_events", "meConfidential")))
  })
  it("a firm list query must constrain classification within the reader's clearance", async () => {
    const db = await as(ASSOC)
    await assertSucceeds(getDocs(query(collection(db, "merge_events"), where("firmId", "==", FIRM), where("classification", "==", "internal"))))
    await assertFails(getDocs(query(collection(db, "merge_events"), where("firmId", "==", FIRM))))
  })
  it("clerk and intern are denied (even at max clearance)", async () => {
    await assertFails(getDoc(doc(await as(CLERK), "merge_events", "meInternal")))
    await assertFails(getDoc(doc(await as(CLERK_HIGH), "merge_events", "meInternal")))
    await assertFails(getDoc(doc(await as(INTERN), "merge_events", "meInternal")))
  })
  it("client and accounts are denied", async () => {
    await assertFails(getDoc(doc(await as(CLIENT), "merge_events", "meInternal")))
    await assertFails(getDoc(doc(await as(ACCOUNTS), "merge_events", "meInternal")))
  })
  it("a firm-B partner (max clearance) is denied get and list", async () => {
    const db = await as(FIRM_B_PARTNER)
    await assertFails(getDoc(doc(db, "merge_events", "meInternal")))
    await assertFails(getDocs(query(collection(db, "merge_events"), where("firmId", "==", FIRM))))
  })
  it("a row without classification is denied even to a max-clearance partner (fail closed)", async () => {
    await assertFails(getDoc(doc(await as(PARTNER), "merge_events", "meNoCls")))
  })
})

describe("entity_aliases: server-only (P2-36)", () => {
  it("an associate cannot create one through the SDK (previously allowed)", async () => {
    await assertFails(setDoc(doc(await as(ASSOC), "entity_aliases", "sdkNewA"), alias("internal")))
  })
  it("a partner and a clerk cannot create one either", async () => {
    await assertFails(setDoc(doc(await as(PARTNER), "entity_aliases", "sdkNewP"), alias("privileged")))
    await assertFails(setDoc(doc(await as(CLERK), "entity_aliases", "sdkNewC"), alias("internal")))
  })
  it("no one updates or deletes one (update was previously allowed)", async () => {
    await assertFails(updateDoc(doc(await as(PARTNER), "entity_aliases", "alInternal"), { value: "ACME LTD" }))
    await assertFails(deleteDoc(doc(await as(PARTNER), "entity_aliases", "alInternal")))
  })
})

describe("entity_aliases: reads by same-firm staff cleared to the row", () => {
  it("an internal clerk reads an internal row", async () => {
    await assertSucceeds(getDoc(doc(await as(CLERK), "entity_aliases", "alInternal")))
  })
  it("an internal reader is denied a privileged row; a cleared one reads it", async () => {
    await assertFails(getDoc(doc(await as(CLERK), "entity_aliases", "alPriv")))
    await assertFails(getDoc(doc(await as(ASSOC), "entity_aliases", "alPriv")))
    await assertSucceeds(getDoc(doc(await as(INTERN), "entity_aliases", "alPriv")))
    await assertSucceeds(getDoc(doc(await as(PARTNER), "entity_aliases", "alPriv")))
  })
  it("client and accounts are denied", async () => {
    await assertFails(getDoc(doc(await as(CLIENT), "entity_aliases", "alInternal")))
    await assertFails(getDoc(doc(await as(ACCOUNTS), "entity_aliases", "alInternal")))
  })
  it("firm-B staff (max clearance) are denied get and list", async () => {
    for (const caller of [FIRM_B_PARTNER, FIRM_B_CLERK]) {
      const db = await as(caller)
      await assertFails(getDoc(doc(db, "entity_aliases", "alInternal")))
      await assertFails(getDocs(query(collection(db, "entity_aliases"), where("firmId", "==", FIRM))))
    }
  })
  it("a row without classification is denied even to a max-clearance partner (fail closed)", async () => {
    await assertFails(getDoc(doc(await as(PARTNER), "entity_aliases", "alNoCls")))
  })
})
