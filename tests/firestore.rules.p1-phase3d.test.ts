import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  assertFails,
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
} from "firebase/firestore"

/**
 * Phase 3d P1 (spec P3-72): the AI cost log, the month totals, the budget alerts, the firm's AI config and
 * (audit F07, F08) the AI spend reservations are server-only collections, and `platform/p1` (the platform kill switch) is a server-only
 * document. Cloud Functions (Admin SDK) is the only reader and writer; partners read through
 * `getAiUsage`. No client of any firm or role can read, list, create, update or delete any of them.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let testEnv: RulesTestEnvironment
const RULES = readFileSync("firestore.rules", "utf8")

const FIRM = "p3d-firm"
const OTHER_FIRM = "p3d-firm-b"
const MAX = "privileged-restricted"

type Caller = { uid: string; claims: Record<string, unknown> }
const caller = (uid: string, firmId: string, role: string, extra: Record<string, unknown> = {}): Caller => ({
  uid,
  claims: { firmId, role, clearanceLevel: MAX, ...extra },
})

const PARTNER = caller("p3d-partner", FIRM, "partner")
const PARTNER_ADMIN = caller("p3d-partner-admin", FIRM, "partner", { platformAdmin: true })
const ASSOC = caller("p3d-assoc", FIRM, "associate")
const CLERK = caller("p3d-clerk", FIRM, "clerk")
const INTERN = caller("p3d-intern", FIRM, "intern")
const CLIENT = caller("p3d-client", FIRM, "client")
const ACCOUNTS = caller("p3d-accounts", FIRM, "accounts")
const FIRM_B_PARTNER = caller("p3d-b-partner", OTHER_FIRM, "partner")
const FIRM_B_ADMIN = caller("p3d-b-admin", OTHER_FIRM, "partner", { platformAdmin: true })
const EVERYONE = [PARTNER, PARTNER_ADMIN, ASSOC, CLERK, INTERN, CLIENT, ACCOUNTS, FIRM_B_PARTNER, FIRM_B_ADMIN]

const COLLECTIONS = ["ai_usage_logs", "ai_usage_months", "ai_budget_alerts", "ai_config", "ai_reservations"] as const

/** A live, second-factor signed-in caller whose users/{uid} record matches its token (SEC-3). */
async function as(c: Caller) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users", c.uid), { ...c.claims, active: true }, { merge: true })
  })
  const firebase = { sign_in_provider: "password", sign_in_second_factor: "phone" } as unknown as { sign_in_provider: "password" }
  return testEnv.authenticatedContext(c.uid, { ...c.claims, firebase }).firestore()
}

const row = (extra: Record<string, unknown> = {}) => ({ firmId: FIRM, classification: "internal", monthKey: "2026-10", ...extra })

beforeAll(async () => {
  setLogLevel("silent")
  testEnv = await initializeTestEnvironment({ projectId: "sikander-p3d-p1-rules", firestore: { rules: RULES } })
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, "ai_usage_logs", "log1"), row({ outcome: "ok", costMicroUsd: 14000 }))
    await setDoc(doc(db, "ai_usage_months", `${FIRM}_2026-10`), row({ spentMicroUsd: 14000 }))
    await setDoc(doc(db, "ai_budget_alerts", `${FIRM}_2026-10_70`), row({ threshold: 70 }))
    await setDoc(doc(db, "ai_config", FIRM), row({ monthlyBudgetMicroUsd: 1_500_000, pkrPerUsd: 280 }))
    await setDoc(doc(db, "ai_reservations", "res1"), row({ state: "reserved", reservedMicroUsd: 81_960, usageLogId: "res1" }))
    await setDoc(doc(db, "platform", "p1"), { killSwitch: { disableAll: true, disabledModels: [], reason: "seed", setBy: "admin" } })
  })
})

afterAll(async () => {
  await testEnv?.cleanup()
})

describe("firestore.rules names the P1 collections explicitly (P3-72)", () => {
  it.each(COLLECTIONS)("%s has its own match block, read and write false", (name) => {
    const block = RULES.split("\n").find((line) => line.includes(`match /${name}/{`))
    expect(block, `no match block for ${name}`).toBeDefined()
    expect(block).toMatch(/allow read, write: if false;/)
  })

  it("platform/p1 is server-only through the catch-all: no `platform` match block, and `match /{document=**}` denies read and write", () => {
    // tests/firestore.rules.test.ts (Round 4) pins that no `platform` block exists; the catch-all is what denies platform/*.
    expect(RULES).not.toMatch(/match \/platform\//)
    const catchAll = RULES.split("\n").find((line) => line.includes("match /{document=**}"))
    expect(catchAll, "no catch-all").toBeDefined()
    expect(catchAll).toMatch(/allow read, write: if false;/)
  })
})

describe.each(COLLECTIONS)("%s is server-only", (name) => {
  const id = (n: string) =>
    n === "ai_usage_logs" ? "log1" : n === "ai_usage_months" ? `${FIRM}_2026-10` : n === "ai_budget_alerts" ? `${FIRM}_2026-10_70` : n === "ai_reservations" ? "res1" : FIRM

  it("no role of the same firm, with or without the platformAdmin claim, reads, lists, writes or deletes it", async () => {
    for (const c of EVERYONE) {
      const db = await as(c)
      const who = `${c.uid} on ${name}`
      await assertFails(getDoc(doc(db, name, id(name)))).catch((e: unknown) => Promise.reject(new Error(`${who} get: ${String(e)}`)))
      await assertFails(getDocs(query(collection(db, name), where("firmId", "==", FIRM)))).catch((e: unknown) => Promise.reject(new Error(`${who} list: ${String(e)}`)))
      await assertFails(setDoc(doc(db, name, "forged"), row())).catch((e: unknown) => Promise.reject(new Error(`${who} create: ${String(e)}`)))
      await assertFails(updateDoc(doc(db, name, id(name)), { monthlyBudgetMicroUsd: 1 })).catch((e: unknown) => Promise.reject(new Error(`${who} update: ${String(e)}`)))
      await assertFails(deleteDoc(doc(db, name, id(name)))).catch((e: unknown) => Promise.reject(new Error(`${who} delete: ${String(e)}`)))
    }
  })

  it("an unauthenticated client is denied too", async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(db, name, id(name))))
    await assertFails(setDoc(doc(db, name, "forged"), row()))
  })
})

describe("platform/p1 is server-only", () => {
  it("no role of either firm, with or without the platformAdmin claim, reads, writes or deletes it", async () => {
    for (const c of EVERYONE) {
      const db = await as(c)
      await assertFails(getDoc(doc(db, "platform", "p1")))
      await assertFails(setDoc(doc(db, "platform", "p1"), { killSwitch: { disableAll: false, disabledModels: [], reason: "forged", setBy: c.uid } }))
      await assertFails(updateDoc(doc(db, "platform", "p1"), { "killSwitch.disableAll": false }))
      await assertFails(deleteDoc(doc(db, "platform", "p1")))
    }
  })

  it("an unauthenticated client is denied", async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(db, "platform", "p1")))
    await assertFails(setDoc(doc(db, "platform", "p1"), { killSwitch: { disableAll: false } }))
  })

  it("platform/gates stays server-only beside it", async () => {
    const db = await as(PARTNER_ADMIN)
    await assertFails(getDoc(doc(db, "platform", "gates")))
  })
})

describe("platform/p1Overhead and platform/p1ReconcileCursor are server-only (Copilot finding and re-audit R2-D2 on PR #40)", () => {
  // The learned request overhead raises every later reservation of a model: a client that could lower it could make
  // reservations smaller than the provider bills. The sweep cursor decides which records the reconciler reads.
  const DOCS = ["p1Overhead", "p1ReconcileCursor"] as const

  it("no role of either firm, with or without the platformAdmin claim, reads, writes or deletes either", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, "platform", "p1Overhead"), { models: { "anthropic_claude-opus-5_5": { model: "anthropic/claude-opus-5.5", inputTokens: 2_000 } } })
      await setDoc(doc(db, "platform", "p1ReconcileCursor"), { after: "res1" })
    })
    for (const c of EVERYONE) {
      const db = await as(c)
      for (const name of DOCS) {
        await assertFails(getDoc(doc(db, "platform", name)))
        await assertFails(setDoc(doc(db, "platform", name), { models: {}, after: "" }))
        await assertFails(updateDoc(doc(db, "platform", name), { "models.anthropic_claude-opus-5_5.inputTokens": 0, after: "" }))
        await assertFails(deleteDoc(doc(db, "platform", name)))
      }
    }
  })

  it("an unauthenticated client is denied", async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    for (const name of DOCS) {
      await assertFails(getDoc(doc(db, "platform", name)))
      await assertFails(setDoc(doc(db, "platform", name), { models: {} }))
    }
  })
})
