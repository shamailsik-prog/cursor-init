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
 * Phase 4b (spec P4B-18): the generation store is written by Cloud Functions only. `draft_generations` and
 * `draft_outlines` are read as `drafts` and `draft_versions` are (an author role, membership of the row's matter,
 * clearance for the row's own label and for the matter's current one) and lose every client write, so `stage`,
 * `approvedOutline`, `inFlight` and the stored outline can no longer be forged from the client SDK. `draft_sections`
 * is server-only: no client reads or writes it.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let testEnv: RulesTestEnvironment
const RULES = readFileSync("firestore.rules", "utf8")

const FIRM = "p4b-firm"
const OTHER_FIRM = "p4b-firm-b"
const MATTER = "p4b-matter"
/** A matter whose label was raised to privileged after its brief and outline were written at internal. */
const RAISED = "p4b-matter-raised"
const MAX = "privileged-restricted"

type Caller = { uid: string; claims: Record<string, unknown> }
const caller = (uid: string, firmId: string, role: string, clearanceLevel = MAX): Caller => ({ uid, claims: { firmId, role, clearanceLevel } })

const PARTNER = caller("p4b-partner", FIRM, "partner")
const ASSOC = caller("p4b-assoc", FIRM, "associate")
const CLERK = caller("p4b-clerk", FIRM, "clerk")
const INTERN = caller("p4b-intern", FIRM, "intern")
const CLIENT = caller("p4b-client", FIRM, "client")
const ACCOUNTS = caller("p4b-accounts", FIRM, "accounts")
const NON_MEMBER = caller("p4b-nonmember", FIRM, "partner")
const LOW_CLEARANCE = caller("p4b-low", FIRM, "associate", "internal")
const FIRM_B_PARTNER = caller("p4b-b-partner", OTHER_FIRM, "partner")
const MEMBERS = [PARTNER, ASSOC, CLERK, INTERN, CLIENT, ACCOUNTS, LOW_CLEARANCE]
const EVERYONE = [...MEMBERS, NON_MEMBER, FIRM_B_PARTNER]
/** Members who can read a brief and an outline of the matter through the rules (the control): the author roles, as the API (P4B-16). */
const READERS = [PARTNER, ASSOC, CLERK]

/** A live, second-factor signed-in caller whose users/{uid} record matches its token (SEC-3). */
async function as(c: Caller) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users", c.uid), { ...c.claims, active: true }, { merge: true })
  })
  const firebase = { sign_in_provider: "password", sign_in_second_factor: "phone" } as unknown as { sign_in_provider: "password" }
  return testEnv.authenticatedContext(c.uid, { ...c.claims, firebase }).firestore()
}

const briefRow = (extra: Record<string, unknown> = {}) => ({
  firmId: FIRM,
  matterId: MATTER,
  documentTypeId: "constitutional_petition_199",
  title: "Petition",
  facts: "The petitioner submits.",
  verbatim: [],
  partyNames: [],
  classification: "internal",
  stage: "facts",
  outlineVersion: 0,
  approvedOutline: null,
  sectionCount: null,
  sectionsStored: 0,
  templateId: "template_cp_199_v1",
  path: null,
  model: null,
  promptVersion: null,
  calls: 0,
  costMicroUsd: 0,
  lastAttempt: null,
  inFlight: null,
  draftId: null,
  createdBy: PARTNER.uid,
  ...extra,
})
const outlineRow = (extra: Record<string, unknown> = {}) => ({
  firmId: FIRM,
  matterId: MATTER,
  generationId: "g1",
  version: 1,
  kind: "generated",
  sections: [{ heading: "Facts", purpose: "State the facts." }],
  missingFacts: [],
  sha256: "0".repeat(64),
  classification: "internal",
  editedFrom: null,
  path: "ai",
  model: "anthropic/claude-opus-5.5",
  promptVersion: "4b.1",
  traceId: "t1",
  inputTokens: 1000,
  outputTokens: 500,
  costMicroUsd: 14000,
  usageLogId: "u1",
  createdBy: PARTNER.uid,
  ...extra,
})
const sectionRow = (extra: Record<string, unknown> = {}) => ({
  firmId: FIRM,
  matterId: MATTER,
  generationId: "g1",
  outlineVersion: 1,
  section: 1,
  heading: "Facts",
  text: "The petitioner submits.",
  textSha256: "0".repeat(64),
  classification: "internal",
  path: "ai",
  model: "anthropic/claude-opus-5.5",
  promptVersion: "4b.1",
  usageLogId: "u1",
  traceId: "t1",
  inputTokens: 1000,
  outputTokens: 500,
  costMicroUsd: 14000,
  createdBy: PARTNER.uid,
  ...extra,
})

beforeAll(async () => {
  setLogLevel("silent")
  testEnv = await initializeTestEnvironment({ projectId: "sikander-p4b-generation-rules", firestore: { rules: RULES } })
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, "matters", MATTER), { firmId: FIRM, title: "M", classification: "internal" })
    for (const c of MEMBERS) await setDoc(doc(db, "matter_members", `${MATTER}_${c.uid}`), { firmId: FIRM, matterId: MATTER, userId: c.uid })
    await setDoc(doc(db, "matters", RAISED), { firmId: FIRM, title: "Raised", classification: "privileged" })
    for (const c of [ASSOC, CLERK, LOW_CLEARANCE]) await setDoc(doc(db, "matter_members", `${RAISED}_${c.uid}`), { firmId: FIRM, matterId: RAISED, userId: c.uid })
    await setDoc(doc(db, "draft_generations", "g1"), briefRow())
    await setDoc(doc(db, "draft_outlines", "g1_1"), outlineRow())
    await setDoc(doc(db, "draft_sections", "g1_1_1"), sectionRow())
    await setDoc(doc(db, "draft_generations", "gRaised"), briefRow({ matterId: RAISED }))
    await setDoc(doc(db, "draft_outlines", "gRaised_1"), outlineRow({ matterId: RAISED, generationId: "gRaised" }))
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

describe("firestore.rules names the D4 generation collections explicitly (P4B-18)", () => {
  it("draft_generations and draft_outlines read as drafts do and deny create, update and delete; draft_sections is read, write false", () => {
    for (const name of ["draft_generations", "draft_outlines"]) {
      const text = block(name)
      const read = /allow read: if ([^;]+);/.exec(text)?.[1] ?? ""
      expect(read, name).toMatch(/^sameFirm\(\) && /)
      expect(read, name).toMatch(/\bisAuthor\(\)/)
      expect(read, name).toMatch(/\bisMember\(resource\.data\.matterId\)/)
      expect(read, name).toMatch(/cleared\(resource\.data\.classification\)/)
      expect(read, name).toMatch(/cleared\(get\(\/databases\/\$\(database\)\/documents\/matters\/\$\(resource\.data\.matterId\)\)\.data\.classification\)/)
      expect(read, name).not.toMatch(/memberReader|isMatterStaff|isStaff/)
      const writes = [...text.matchAll(/allow ((?:create|update|delete|write)[a-z, ]*):\s*if ([^;]+);/g)]
      expect(writes.length, name).toBeGreaterThan(0)
      expect(writes.map((m) => m[2]!.trim()), name).toEqual(writes.map(() => "false"))
      const kinds = writes.map((m) => m[1]!).join(",")
      for (const kind of ["create", "update", "delete"]) expect(kinds, name).toMatch(new RegExp(kind))
    }
    const line = RULES.split("\n").find((l) => l.includes("match /draft_sections/{"))
    expect(line, "no match block for draft_sections").toBeDefined()
    expect(line).toMatch(/allow read, write: if false;/)
  })
})

describe("draft_generations, draft_outlines and draft_sections (P4B-18)", () => {
  it("control: a partner, associate and clerk member cleared for the row and the matter read a brief and an outline", async () => {
    for (const c of READERS) {
      const db = await as(c)
      await assertSucceeds(getDoc(doc(db, "draft_generations", "g1")))
      await assertSucceeds(getDoc(doc(db, "draft_outlines", "g1_1")))
    }
    // A list query constrained to the matter and a cleared label, as a client would run it.
    const db = await as(CLERK)
    await assertSucceeds(getDocs(query(collection(db, "draft_generations"), where("firmId", "==", FIRM), where("matterId", "==", MATTER), where("classification", "==", "internal"))))
    await assertSucceeds(getDocs(query(collection(db, "draft_outlines"), where("firmId", "==", FIRM), where("matterId", "==", MATTER), where("classification", "==", "internal"))))
  })

  it("an intern member, a client, accounts, a non-member and another firm's partner are denied a brief and an outline", async () => {
    for (const c of [INTERN, CLIENT, ACCOUNTS, NON_MEMBER, FIRM_B_PARTNER]) {
      const db = await as(c)
      await assertFails(getDoc(doc(db, "draft_generations", "g1"))).catch((e: unknown) => Promise.reject(new Error(`${c.uid} brief get: ${String(e)}`)))
      await assertFails(getDoc(doc(db, "draft_outlines", "g1_1"))).catch((e: unknown) => Promise.reject(new Error(`${c.uid} outline get: ${String(e)}`)))
    }
    // The same list query that a clerk member may run is refused to an intern member.
    const intern = await as(INTERN)
    await assertFails(getDocs(query(collection(intern, "draft_generations"), where("firmId", "==", FIRM), where("matterId", "==", MATTER), where("classification", "==", "internal"))))
    await assertFails(getDocs(query(collection(intern, "draft_outlines"), where("firmId", "==", FIRM), where("matterId", "==", MATTER), where("classification", "==", "internal"))))
    // A clearance below the row's own label is refused too, though the matter is readable.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "draft_generations", "gSecret"), briefRow({ classification: "privileged" }))
      await setDoc(doc(ctx.firestore(), "draft_outlines", "gSecret_1"), outlineRow({ generationId: "gSecret", classification: "privileged" }))
    })
    const low = await as(LOW_CLEARANCE)
    await assertSucceeds(getDoc(doc(low, "draft_generations", "g1"))) // internal brief, internal clearance
    await assertFails(getDoc(doc(low, "draft_generations", "gSecret")))
    await assertFails(getDoc(doc(low, "draft_outlines", "gSecret_1")))
  })

  it("cross-label: an internal-cleared member cannot read a brief or an outline of a matter raised to privileged, even when the stored label is internal", async () => {
    const low = await as(LOW_CLEARANCE)
    await assertFails(getDoc(doc(low, "draft_generations", "gRaised")))
    await assertFails(getDoc(doc(low, "draft_outlines", "gRaised_1")))
    // The control: a member cleared for the matter's raised label reads both, a clerk included.
    for (const c of [ASSOC, CLERK]) {
      const db = await as(c)
      await assertSucceeds(getDoc(doc(db, "draft_generations", "gRaised")))
      await assertSucceeds(getDoc(doc(db, "draft_outlines", "gRaised_1")))
    }
  })

  it("no client of any role creates, updates or deletes a brief or an outline, even a cleared member author", async () => {
    const forgeries: Array<Record<string, unknown>> = [
      { stage: "assembled" },
      { stage: "approved" },
      { approvedOutline: { version: 1, sha256: "f".repeat(64), by: PARTNER.uid, at: new Date(), acknowledgedMissingFacts: [] } },
      { inFlight: null },
      { inFlight: { claimId: "x", step: "outline", outlineVersion: 1, section: null, by: PARTNER.uid, leaseUntil: new Date() } },
      { draftId: "d-forged" },
      { facts: "edited" },
      { classification: "confidential" },
      { costMicroUsd: 0 },
    ]
    for (const c of EVERYONE) {
      const db = await as(c)
      const who = c.uid
      await assertFails(setDoc(doc(db, "draft_generations", `forged-${who}`), briefRow())).catch((e: unknown) => Promise.reject(new Error(`${who} brief create: ${String(e)}`)))
      await assertFails(setDoc(doc(db, "draft_outlines", `forged-${who}_1`), outlineRow({ generationId: `forged-${who}` }))).catch((e: unknown) => Promise.reject(new Error(`${who} outline create: ${String(e)}`)))
      for (const forged of forgeries) {
        await assertFails(updateDoc(doc(db, "draft_generations", "g1"), forged)).catch((e: unknown) => Promise.reject(new Error(`${who} ${JSON.stringify(Object.keys(forged))}: ${String(e)}`)))
      }
      await assertFails(updateDoc(doc(db, "draft_outlines", "g1_1"), { sha256: "f".repeat(64) }))
      await assertFails(updateDoc(doc(db, "draft_outlines", "g1_1"), { sections: [{ heading: "Forged", purpose: "p" }] }))
      await assertFails(setDoc(doc(db, "draft_generations", "g1"), briefRow({ facts: "overwritten" })))
      await assertFails(setDoc(doc(db, "draft_outlines", "g1_1"), outlineRow({ sha256: "f".repeat(64) })))
      await assertFails(deleteDoc(doc(db, "draft_generations", "g1")))
      await assertFails(deleteDoc(doc(db, "draft_outlines", "g1_1")))
      await assertFails(
        (async () => {
          const b = writeBatch(db)
          b.update(doc(db, "draft_generations", "g1"), { stage: "approved" })
          b.update(doc(db, "draft_generations", "g1"), { draftId: "d-forged" })
          await b.commit()
        })()
      )
    }
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      expect((await getDoc(doc(db, "draft_generations", `forged-${ASSOC.uid}`))).exists()).toBe(false)
      expect((await getDoc(doc(db, "draft_outlines", `forged-${ASSOC.uid}_1`))).exists()).toBe(false)
      expect((await getDoc(doc(db, "draft_generations", "g1"))).data()).toMatchObject({ facts: "The petitioner submits.", stage: "facts", draftId: null, inFlight: null })
      expect((await getDoc(doc(db, "draft_outlines", "g1_1"))).data()?.sha256).toBe("0".repeat(64))
    })
  })

  it("draft_sections is server-only: no role of either firm reads, lists, creates, updates or deletes it", async () => {
    for (const c of EVERYONE) {
      const db = await as(c)
      const who = `${c.uid} on draft_sections`
      await assertFails(getDoc(doc(db, "draft_sections", "g1_1_1"))).catch((e: unknown) => Promise.reject(new Error(`${who} get: ${String(e)}`)))
      await assertFails(getDocs(query(collection(db, "draft_sections"), where("firmId", "==", FIRM)))).catch((e: unknown) => Promise.reject(new Error(`${who} list: ${String(e)}`)))
      await assertFails(setDoc(doc(db, "draft_sections", `forged-${c.uid}_1_1`), sectionRow())).catch((e: unknown) => Promise.reject(new Error(`${who} create: ${String(e)}`)))
      await assertFails(updateDoc(doc(db, "draft_sections", "g1_1_1"), { text: "forged" })).catch((e: unknown) => Promise.reject(new Error(`${who} update: ${String(e)}`)))
      await assertFails(deleteDoc(doc(db, "draft_sections", "g1_1_1"))).catch((e: unknown) => Promise.reject(new Error(`${who} delete: ${String(e)}`)))
    }
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDoc(doc(ctx.firestore(), "draft_sections", "g1_1_1"))).data()?.text).toBe("The petitioner submits.")
    })
  })

  it("an unauthenticated client can neither read nor write any of the three", async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(db, "draft_generations", "g1")))
    await assertFails(getDoc(doc(db, "draft_outlines", "g1_1")))
    await assertFails(getDoc(doc(db, "draft_sections", "g1_1_1")))
    await assertFails(setDoc(doc(db, "draft_generations", "x"), briefRow()))
    await assertFails(setDoc(doc(db, "draft_outlines", "x_1"), outlineRow()))
    await assertFails(setDoc(doc(db, "draft_sections", "x_1_1"), sectionRow()))
  })
})
