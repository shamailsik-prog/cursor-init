import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
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
  setDoc,
  setLogLevel,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore"

/**
 * Phase 4a (spec P4-11): the draft store is written by Cloud Functions only. `drafts` and `draft_versions`
 * keep their read rules (a cleared member of the draft's matter) and lose every client write, so `gateResult`,
 * `status`, `locked` and `approvedBy` can no longer be forged from the client SDK; `draft_gate_results` and
 * `draft_gate_overrides` are new collections that no client can read or write.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let testEnv: RulesTestEnvironment
const RULES = readFileSync("firestore.rules", "utf8")

const FIRM = "p4a-firm"
const OTHER_FIRM = "p4a-firm-b"
const MATTER = "p4a-matter"
const MAX = "privileged-restricted"

type Caller = { uid: string; claims: Record<string, unknown> }
const caller = (uid: string, firmId: string, role: string, clearanceLevel = MAX): Caller => ({ uid, claims: { firmId, role, clearanceLevel } })

const PARTNER = caller("p4a-partner", FIRM, "partner")
const ASSOC = caller("p4a-assoc", FIRM, "associate")
const CLERK = caller("p4a-clerk", FIRM, "clerk")
const INTERN = caller("p4a-intern", FIRM, "intern")
const CLIENT = caller("p4a-client", FIRM, "client")
const ACCOUNTS = caller("p4a-accounts", FIRM, "accounts")
const NON_MEMBER = caller("p4a-nonmember", FIRM, "partner")
const LOW_CLEARANCE = caller("p4a-low", FIRM, "associate", "internal")
const FIRM_B_PARTNER = caller("p4a-b-partner", OTHER_FIRM, "partner")
const MEMBERS = [PARTNER, ASSOC, CLERK, INTERN, CLIENT, ACCOUNTS, LOW_CLEARANCE]
const EVERYONE = [...MEMBERS, NON_MEMBER, FIRM_B_PARTNER]
/**
 * Members who can read a draft of the matter through the rules (the control). The rules' read path is
 * unchanged (P4-11): staff members, an intern included, although the API's permission table denies interns.
 */
const READERS = [PARTNER, ASSOC, CLERK, INTERN]

/** A live, second-factor signed-in caller whose users/{uid} record matches its token (SEC-3). */
async function as(c: Caller) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users", c.uid), { ...c.claims, active: true }, { merge: true })
  })
  const firebase = { sign_in_provider: "password", sign_in_second_factor: "phone" } as unknown as { sign_in_provider: "password" }
  return testEnv.authenticatedContext(c.uid, { ...c.claims, firebase }).firestore()
}

const draftRow = (extra: Record<string, unknown> = {}) => ({
  firmId: FIRM,
  matterId: MATTER,
  documentTypeId: "constitutional_petition_199",
  title: "Petition",
  classification: "internal",
  status: "draft",
  currentVersion: 1,
  currentBodySha256: "0".repeat(64),
  locked: false,
  masterVersion: null,
  gateResult: null,
  createdBy: PARTNER.uid,
  ...extra,
})
const versionRow = (extra: Record<string, unknown> = {}) => ({
  firmId: FIRM,
  matterId: MATTER,
  draftId: "d1",
  version: 1,
  title: "Petition",
  body: "The petitioner submits.",
  bodySha256: "0".repeat(64),
  classification: "internal",
  kind: "create",
  createdBy: PARTNER.uid,
  ...extra,
})

beforeAll(async () => {
  setLogLevel("silent")
  testEnv = await initializeTestEnvironment({ projectId: "sikander-p4a-draft-rules", firestore: { rules: RULES } })
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, "matters", MATTER), { firmId: FIRM, title: "M", classification: "internal" })
    for (const c of MEMBERS) await setDoc(doc(db, "matter_members", `${MATTER}_${c.uid}`), { firmId: FIRM, matterId: MATTER, userId: c.uid })
    await setDoc(doc(db, "drafts", "d1"), draftRow())
    await setDoc(doc(db, "drafts", "dLocked"), draftRow({ locked: true }))
    await setDoc(doc(db, "draft_versions", "d1_1"), versionRow())
    await setDoc(doc(db, "draft_gate_results", "d1_1"), { firmId: FIRM, matterId: MATTER, draftId: "d1", version: 1, status: "OK", classification: "internal" })
    await setDoc(doc(db, "draft_gate_overrides", "d1_1"), { firmId: FIRM, matterId: MATTER, draftId: "d1", version: 1, reason: "seed", classification: "internal" })
  })
})

afterAll(async () => {
  await testEnv?.cleanup()
})

/** The block of `firestore.rules` for a collection (its `match` line up to the next `match /`). */
function block(name: string): string {
  const at = RULES.indexOf(`match /${name}/{`)
  expect(at, `no match block for ${name}`).toBeGreaterThanOrEqual(0)
  const next = RULES.indexOf("match /", at + 1)
  return RULES.slice(at, next === -1 ? RULES.length : next)
}

describe("firestore.rules names the D4 draft collections explicitly (P4-11)", () => {
  it.each(["draft_gate_results", "draft_gate_overrides"])("%s has its own match block, read and write false", (name) => {
    const line = RULES.split("\n").find((l) => l.includes(`match /${name}/{`))
    expect(line, `no match block for ${name}`).toBeDefined()
    expect(line).toMatch(/allow read, write: if false;/)
  })

  it.each(["drafts", "draft_versions"])("%s: reads keep the member and clearance rule; create, update and delete are false", (name) => {
    const text = block(name)
    expect(text).toMatch(/allow read: if sameFirm\(\) && [^;]*(?:isMember|memberReader)\(/)
    expect(text).toMatch(/cleared\(resource\.data\.classification\)/)
    const writes = [...text.matchAll(/allow ((?:create|update|delete|write)[a-z, ]*):\s*if ([^;]+);/g)]
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.map((m) => m[2]!.trim())).toEqual(writes.map(() => "false"))
    expect(writes.map((m) => m[1]!).join(",")).toMatch(/create/)
    expect(writes.map((m) => m[1]!).join(",")).toMatch(/update/)
    expect(writes.map((m) => m[1]!).join(",")).toMatch(/delete/)
  })
})

describe("drafts and draft_versions: readable by a cleared member, writable by no client (P4-11)", () => {
  it("control: a partner, associate, clerk and intern member read a draft and its versions", async () => {
    for (const c of READERS) {
      const db = await as(c)
      await assertSucceeds(getDoc(doc(db, "drafts", "d1")))
      await assertSucceeds(getDoc(doc(db, "draft_versions", "d1_1")))
    }
  })

  it("reads are unchanged: a client, accounts, a non-member and another firm's partner are denied, and a clearance below the draft's", async () => {
    for (const c of [CLIENT, ACCOUNTS, NON_MEMBER, FIRM_B_PARTNER]) {
      const db = await as(c)
      await assertFails(getDoc(doc(db, "drafts", "d1")))
      await assertFails(getDoc(doc(db, "draft_versions", "d1_1")))
    }
    const low = await as(LOW_CLEARANCE)
    await assertSucceeds(getDoc(doc(low, "drafts", "d1"))) // internal draft, internal clearance
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "drafts", "dSecret"), draftRow({ classification: "privileged" }))
      await setDoc(doc(ctx.firestore(), "draft_versions", "dSecret_1"), versionRow({ draftId: "dSecret", classification: "privileged" }))
    })
    await assertFails(getDoc(doc(low, "drafts", "dSecret")))
    await assertFails(getDoc(doc(low, "draft_versions", "dSecret_1")))
  })

  it("no client of any role creates a draft or a version (even a cleared member author at the matter's own label)", async () => {
    for (const c of EVERYONE) {
      const db = await as(c)
      const who = c.uid
      await assertFails(setDoc(doc(db, "drafts", `forged-${who}`), draftRow())).catch((e: unknown) => Promise.reject(new Error(`${who} drafts create: ${String(e)}`)))
      await assertFails(setDoc(doc(db, "draft_versions", `forged-${who}_1`), versionRow({ draftId: `forged-${who}` }))).catch((e: unknown) => Promise.reject(new Error(`${who} draft_versions create: ${String(e)}`)))
    }
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDoc(doc(ctx.firestore(), "drafts", `forged-${ASSOC.uid}`))).exists()).toBe(false)
    })
  })

  it("no client updates a draft: not its body fields, not the gate summary, status, lock or approval, not by batch", async () => {
    const forgeries: Array<Record<string, unknown>> = [
      { title: "edited" },
      { currentVersion: 99 },
      { currentBodySha256: "f".repeat(64) },
      { gateResult: { version: 1, bodySha256: "0".repeat(64), status: "OK", gatedAt: new Date(), overridden: false } },
      { status: "approved" },
      { approvedBy: PARTNER.uid, approvedAt: new Date(), approvedVersion: 1 },
      { locked: false },
      { locked: true },
      { classification: "confidential" },
      { body: "smuggled" },
    ]
    for (const c of EVERYONE) {
      const db = await as(c)
      for (const forged of forgeries) {
        await assertFails(updateDoc(doc(db, "drafts", "d1"), forged)).catch((e: unknown) => Promise.reject(new Error(`${c.uid} ${JSON.stringify(Object.keys(forged))}: ${String(e)}`)))
      }
      await assertFails(updateDoc(doc(db, "drafts", "dLocked"), { locked: false }))
      await assertFails(
        (async () => {
          const b = writeBatch(db)
          b.update(doc(db, "drafts", "d1"), { status: "approved" })
          b.update(doc(db, "drafts", "d1"), { locked: true })
          await b.commit()
        })()
      )
    }
  })

  it("no client overwrites or deletes a draft or a version", async () => {
    for (const c of EVERYONE) {
      const db = await as(c)
      await assertFails(setDoc(doc(db, "drafts", "d1"), draftRow({ title: "overwritten" })))
      await assertFails(setDoc(doc(db, "draft_versions", "d1_1"), versionRow({ body: "overwritten" })))
      await assertFails(updateDoc(doc(db, "draft_versions", "d1_1"), { body: "edited" }))
      await assertFails(deleteDoc(doc(db, "drafts", "d1")))
      await assertFails(deleteDoc(doc(db, "draft_versions", "d1_1")))
    }
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDoc(doc(ctx.firestore(), "drafts", "d1"))).data()?.title).toBe("Petition")
      expect((await getDoc(doc(ctx.firestore(), "draft_versions", "d1_1"))).data()?.body).toBe("The petitioner submits.")
    })
  })

  it("an unauthenticated client can neither read nor write them", async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(db, "drafts", "d1")))
    await assertFails(setDoc(doc(db, "drafts", "x"), draftRow()))
    await assertFails(setDoc(doc(db, "draft_versions", "x_1"), versionRow()))
  })
})

describe.each(["draft_gate_results", "draft_gate_overrides"])("%s is server-only (P4-11)", (name) => {
  it("no role of either firm reads, lists, creates, updates or deletes it", async () => {
    for (const c of EVERYONE) {
      const db = await as(c)
      const who = `${c.uid} on ${name}`
      await assertFails(getDoc(doc(db, name, "d1_1"))).catch((e: unknown) => Promise.reject(new Error(`${who} get: ${String(e)}`)))
      await assertFails(getDocs(query(collection(db, name), where("firmId", "==", FIRM)))).catch((e: unknown) => Promise.reject(new Error(`${who} list: ${String(e)}`)))
      await assertFails(setDoc(doc(db, name, "forged"), { firmId: FIRM, matterId: MATTER, draftId: "d1", version: 1, status: "OK" })).catch((e: unknown) => Promise.reject(new Error(`${who} create: ${String(e)}`)))
      await assertFails(updateDoc(doc(db, name, "d1_1"), { status: "OK" })).catch((e: unknown) => Promise.reject(new Error(`${who} update: ${String(e)}`)))
      await assertFails(deleteDoc(doc(db, name, "d1_1"))).catch((e: unknown) => Promise.reject(new Error(`${who} delete: ${String(e)}`)))
    }
  })

  it("an unauthenticated client is denied too", async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(db, name, "d1_1")))
    await assertFails(setDoc(doc(db, name, "forged"), { firmId: FIRM }))
  })
})
