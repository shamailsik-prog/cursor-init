import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing"
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
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
const LOW_CLEARANCE = "public"

const EXPIRED_SEED_ID = "seed"

type Caller = { uid: string; claims: Record<string, unknown> }
const caller = (
  uid: string,
  firmId: string,
  role: string,
  clearanceLevel: string = MAX,
  extra: Record<string, unknown> = {},
): Caller => ({
  uid,
  claims: { firmId, role, clearanceLevel, ...extra },
})

const PARTNER = caller("f32-ttl-partner", FIRM, "partner")
const OTHER_FIRM_PARTNER = caller("f32-ttl-other-partner", OTHER_FIRM, "partner")
const ASSOCIATE = caller("f32-ttl-assoc", FIRM, "associate")
const LOW_CLEARANCE_PARTNER = caller("f32-ttl-low-partner", FIRM, "partner", LOW_CLEARANCE)
const PLATFORM_ADMIN_PARTNER = caller("f32-ttl-platform-admin", FIRM, "partner", MAX, { platformAdmin: true })
const WHITELIST_UID = "f32-ttl-whitelist-uid"
const WHITELISTED_PARTNER = caller(WHITELIST_UID, FIRM, "partner")
const VICTIM_DOC_ID = "victim"

type ActorKey =
  | "unauthenticated"
  | "crossFirmPartner"
  | "nonPartner"
  | "sameFirmPartner"
  | "lowClearancePartner"

let testEnv: RulesTestEnvironment

async function dbFor(actor: ActorKey) {
  switch (actor) {
    case "unauthenticated":
      return testEnv.unauthenticatedContext().firestore()
    case "crossFirmPartner":
      return testEnv.authenticatedContext(OTHER_FIRM_PARTNER.uid, OTHER_FIRM_PARTNER.claims).firestore()
    case "nonPartner":
      return testEnv.authenticatedContext(ASSOCIATE.uid, ASSOCIATE.claims).firestore()
    case "sameFirmPartner":
      return testEnv.authenticatedContext(PARTNER.uid, PARTNER.claims).firestore()
    case "lowClearancePartner":
      return testEnv.authenticatedContext(LOW_CLEARANCE_PARTNER.uid, LOW_CLEARANCE_PARTNER.claims).firestore()
  }
}

async function seedDoc(
  collectionName: string,
  docId: string,
  data: { firmId?: string; expiresAt: Date },
) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore()
    await setDoc(doc(admin, collectionName, docId), data)
  })
}

const ACTORS: ActorKey[] = [
  "unauthenticated",
  "crossFirmPartner",
  "nonPartner",
  "sameFirmPartner",
  "lowClearancePartner",
]

const LIST_LIMITS = [1, 5, 25] as const

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
      for (const actor of ACTORS) {
        it(`denies ${actor} create with firmId and future expiry`, async () => {
          const db = await dbFor(actor)
          const docId = `${actor}-create-firm-${name}`
          await assertFails(
            setDoc(doc(db, name, docId), { firmId: FIRM, expiresAt: new Date(Date.now() + 86_400_000) }),
          )
        })

        it(`denies ${actor} create without firmId`, async () => {
          const db = await dbFor(actor)
          const docId = `${actor}-create-nofirm-${name}`
          await assertFails(setDoc(doc(db, name, docId), { expiresAt: new Date(Date.now() + 86_400_000) }))
        })

        it(`denies ${actor} create with past expiry`, async () => {
          const db = await dbFor(actor)
          const docId = `${actor}-create-expired-${name}`
          await assertFails(
            setDoc(doc(db, name, docId), { firmId: FIRM, expiresAt: new Date(Date.now() - 86_400_000) }),
          )
        })

        it(`denies ${actor} update on seeded doc`, async () => {
          const docId = `${actor}-update-${name}`
          await seedDoc(name, docId, { firmId: FIRM, expiresAt: new Date(Date.now() + 86_400_000) })
          const db = await dbFor(actor)
          await assertFails(updateDoc(doc(db, name, docId), { firmId: FIRM }))
        })

        it(`denies ${actor} delete on seeded doc`, async () => {
          const docId = `${actor}-delete-${name}`
          await seedDoc(name, docId, { firmId: FIRM, expiresAt: new Date(Date.now() + 86_400_000) })
          const db = await dbFor(actor)
          await assertFails(deleteDoc(doc(db, name, docId)))
        })

        it(`denies ${actor} get on unexpired doc`, async () => {
          const docId = `${actor}-live-read-${name}`
          await seedDoc(name, docId, { firmId: FIRM, expiresAt: new Date(Date.now() + 7 * 86_400_000) })
          const db = await dbFor(actor)
          await assertFails(getDoc(doc(db, name, docId)))
        })

        for (const listLimit of LIST_LIMITS) {
          it(`denies ${actor} collection list with limit ${listLimit}`, async () => {
            const docId = `${actor}-list-${listLimit}-${name}`
            await seedDoc(name, docId, { firmId: FIRM, expiresAt: new Date(Date.now() + 7 * 86_400_000) })
            const db = await dbFor(actor)
            await assertFails(getDocs(query(collection(db, name), limit(listLimit))))
          })
        }

        it(`denies ${actor} collection-group list with limit 1`, async () => {
          const docId = `${actor}-cg-list-${name}`
          await seedDoc(name, docId, { firmId: FIRM, expiresAt: new Date(Date.now() + 7 * 86_400_000) })
          const db = await dbFor(actor)
          await assertFails(getDocs(query(collectionGroup(db, name), limit(1))))
        })

        it(`denies ${actor} get on expired seed doc`, async () => {
          await seedDoc(name, EXPIRED_SEED_ID, { firmId: FIRM, expiresAt: new Date(Date.now() - 86_400_000) })
          const db = await dbFor(actor)
          await assertFails(getDoc(doc(db, name, EXPIRED_SEED_ID)))
        })
      }
    })
  }

  describe("mutant bypass killers (R116-001)", () => {
    for (const name of TTL_COLLECTIONS) {
      it(`denies platformAdmin partner read of doc ${VICTIM_DOC_ID} on ${name}`, async () => {
        await seedDoc(name, VICTIM_DOC_ID, { firmId: FIRM, expiresAt: new Date(Date.now() + 86_400_000) })
        const db = testEnv.authenticatedContext(PLATFORM_ADMIN_PARTNER.uid, PLATFORM_ADMIN_PARTNER.claims).firestore()
        await assertFails(getDoc(doc(db, name, VICTIM_DOC_ID)))
        await assertFails(getDocs(query(collection(db, name), limit(1))))
      })

      it(`denies whitelisted uid read of doc ${VICTIM_DOC_ID} on ${name}`, async () => {
        await seedDoc(name, VICTIM_DOC_ID, { firmId: FIRM, expiresAt: new Date(Date.now() + 86_400_000) })
        const db = testEnv.authenticatedContext(WHITELISTED_PARTNER.uid, WHITELISTED_PARTNER.claims).firestore()
        await assertFails(getDoc(doc(db, name, VICTIM_DOC_ID)))
      })

      it(`denies platformAdmin create on ${name} doc ${VICTIM_DOC_ID}`, async () => {
        const db = testEnv.authenticatedContext(PLATFORM_ADMIN_PARTNER.uid, PLATFORM_ADMIN_PARTNER.claims).firestore()
        await assertFails(
          setDoc(doc(db, name, VICTIM_DOC_ID), { firmId: FIRM, expiresAt: new Date(Date.now() + 86_400_000) }),
        )
      })
    }
  })
})
