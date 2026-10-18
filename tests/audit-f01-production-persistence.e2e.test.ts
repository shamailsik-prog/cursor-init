import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import {
  getProductionFirestore,
  resetProductionFirestoreForTests,
} from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth } from "@/tests/helpers/emulator-auth"
import { requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"
import { seedFirmARuntimeRecords } from "@/tests/helpers/firestore-runtime-seed"

requireAuthFirestoreEmulators("F01 production Admin Firestore persistence")

const env = process.env as Record<string, string | undefined>
const savedMode = env.SIKANDER_PERSISTENCE_MODE

beforeEach(async () => {
  env.GCLOUD_PROJECT ??= "demo-sikander"
  env.FIREBASE_PROJECT_ID ??= "demo-sikander"
  resetRuntimeStoreForTests()
  resetProductionFirestoreForTests()
  setFirestorePersistenceForTests(null)
  env.SIKANDER_PERSISTENCE_MODE = "firestore"
  await seedFirmARuntimeRecords()
})

afterEach(() => {
  if (savedMode === undefined) delete env.SIKANDER_PERSISTENCE_MODE
  else env.SIKANDER_PERSISTENCE_MODE = savedMode
  resetProductionFirestoreForTests()
  setFirestorePersistenceForTests(null)
})

describe("F01: production Admin Firestore persistence", () => {
  it("writes via API with emulator Auth, survives runtime reset, and reads back", async () => {
    const password = "emulator-pass-123"
    const email = "partner_a@example.test"
    try {
      await adminAuth().createUser({ uid: "partner_a", email, password })
    } catch {
      // emulator user may already exist from a prior test in the same exec
    }
    await adminAuth().setCustomUserClaims("partner_a", {
      firmId: "firmA",
      role: "partner",
      clearanceLevel: "privileged-restricted",
    })
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST
    if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST is required")
    const signInRes = await fetch(
      `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      }
    )
    if (!signInRes.ok) {
      throw new Error(`emulator sign-in failed: ${signInRes.status} ${await signInRes.text()}`)
    }
    const { idToken: token } = (await signInRes.json()) as { idToken: string }

    const createRes = await mattersPost(
      new Request("http://127.0.0.1/api/d1/matters", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Firm-Id": "firmA",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          action: "create",
          actorId: "partner_a",
          firmId: "firmA",
          clientId: "client_a",
          title: "F01 production adapter matter",
          courtId: "SHC",
          classification: "internal",
          memberUserIds: ["associate_a"],
        }),
      })
    )
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as {
      result: { matter: { id: string } }
    }
    const matterId = created.result.matter.id

    const db = await getProductionFirestore()
    const snap = await db.collection("matters").doc(matterId).get()
    expect(snap.exists).toBe(true)
    expect(snap.data(), "firestore matter row").toMatchObject({
      title: "F01 production adapter matter",
    })

    resetRuntimeStoreForTests()
    setFirestorePersistenceForTests(null)

    const listRes = await mattersGet(
      new Request(
        "http://127.0.0.1/api/d1/matters?userId=partner_a&limit=20&cursor=0",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Firm-Id": "firmA",
          },
        }
      )
    )
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as { items: Array<{ id: string; title: string }> }
    const row = listed.items.find((item) => item.id === matterId)
    expect(row?.title).toBe("F01 production adapter matter")

    const afterReset = await db.collection("matters").doc(matterId).get()
    expect(afterReset.data()?.title).toBe("F01 production adapter matter")
  })
})
