import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
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
  setDoc,
  updateDoc,
} from "firebase/firestore"

/** F32: TTL collections must be server-only (emulator proof; replaces static rules regex). */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const RULES = readFileSync("firestore.rules", "utf8")
const manifest = JSON.parse(readFileSync("infra/deploy-manifest.json", "utf8")) as {
  firestore: { ttl: { collectionGroup: string }[] }
}
const TTL_COLLECTIONS = manifest.firestore.ttl.map((t) => t.collectionGroup)

const FIRM = "f32-ttl-firm"
const OTHER_FIRM = "f32-ttl-firm-b"
const MAX = "privileged-restricted"

type Caller = { uid: string; claims: Record<string, unknown> }
const caller = (uid: string, firmId: string, role: string): Caller => ({
  uid,
  claims: { firmId, role, clearanceLevel: MAX },
})

const PARTNER = caller("f32-ttl-partner", FIRM, "partner")
const OTHER_FIRM_PARTNER = caller("f32-ttl-other-partner", OTHER_FIRM, "partner")
const ASSOCIATE = caller("f32-ttl-assoc", FIRM, "associate")

let testEnv: RulesTestEnvironment

async function as(caller: Caller) {
  return testEnv.authenticatedContext(caller.uid, caller.claims).firestore()
}

async function seedCollection(name: string) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore()
    await setDoc(doc(admin, name, "seed"), { firmId: FIRM, expiresAt: new Date() })
  })
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
    describe(name, () => {
      it("denies same-firm partner get, list and create", async () => {
        await seedCollection(name)
        const db = await as(PARTNER)
        await assertFails(getDoc(doc(db, name, "seed")))
        await assertFails(getDocs(collection(db, name)))
        await assertFails(setDoc(doc(db, name, "forged"), { firmId: FIRM }))
      })

      it("denies unauthenticated get and list", async () => {
        await seedCollection(name)
        const db = testEnv.unauthenticatedContext().firestore()
        await assertFails(getDoc(doc(db, name, "seed")))
        await assertFails(getDocs(collection(db, name)))
      })

      it("denies cross-firm partner get and list", async () => {
        await seedCollection(name)
        const db = await as(OTHER_FIRM_PARTNER)
        await assertFails(getDoc(doc(db, name, "seed")))
        await assertFails(getDocs(collection(db, name)))
      })

      it("denies non-partner role get and list", async () => {
        await seedCollection(name)
        const db = await as(ASSOCIATE)
        await assertFails(getDoc(doc(db, name, "seed")))
        await assertFails(getDocs(collection(db, name)))
      })

      it("denies partner update and delete", async () => {
        await seedCollection(name)
        const db = await as(PARTNER)
        await assertFails(updateDoc(doc(db, name, "seed"), { firmId: FIRM }))
        await assertFails(deleteDoc(doc(db, name, "seed")))
      })
    })
  }
})
