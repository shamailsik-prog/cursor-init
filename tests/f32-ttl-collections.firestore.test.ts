import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing"
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore"

/** F32: TTL collections must be server-only (emulator proof; replaces static rules regex). */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const RULES = readFileSync("firestore.rules", "utf8")
const FIRM = "f32-ttl-firm"
const PARTNER = { uid: "f32-ttl-partner", claims: { firmId: FIRM, role: "partner", clearanceLevel: "privileged-restricted" } }

const TTL_COLLECTIONS = [
  "idempotency_keys",
  "idempotency_effects",
  "rate_limits",
  "conflict_index_breaks",
  "counters",
] as const

let testEnv: RulesTestEnvironment

async function as(caller: typeof PARTNER) {
  return testEnv.authenticatedContext(caller.uid, caller.claims).firestore()
}

describe("F32 TTL collections are server-only (rules emulator)", () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: "demo-sikander",
      firestore: { rules: RULES, host: "127.0.0.1", port: 18088 },
    })
  })

  afterAll(async () => {
    await testEnv.cleanup()
  })

  for (const name of TTL_COLLECTIONS) {
    it(`denies client get, list and create on ${name}`, async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const admin = ctx.firestore()
        await setDoc(doc(admin, name, "seed"), { firmId: FIRM, expiresAt: new Date() })
      })
      const db = await as(PARTNER)
      await assertFails(getDoc(doc(db, name, "seed")))
      await assertFails(getDocs(collection(db, name)))
      await assertFails(setDoc(doc(db, name, "forged"), { firmId: FIRM }))
    })
  }
})
