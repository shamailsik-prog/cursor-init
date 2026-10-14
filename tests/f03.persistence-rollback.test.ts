import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import { getProductionFirestore, resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { seedFirmARuntimeRecords } from "@/tests/helpers/firestore-runtime-seed"

const env = process.env as Record<string, string | undefined>
let savedMode: string | undefined

beforeEach(async () => {
  savedMode = env.SIKANDER_PERSISTENCE_MODE
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

describe("F03 persistence rollback guard", () => {
  it("asserts rollback rehydration against the persisted Firestore repo, not the in-memory store", async () => {
    const createRes = await mattersPost(
      new Request("http://127.0.0.1/api/d1/matters", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          action: "create",
          actorId: "partner_a",
          firmId: "firmA",
          clientId: "client_a",
          title: "F03 rollback persisted matter",
          courtId: "SHC",
          classification: "internal",
        }),
      })
    )
    expect(createRes.status).toBe(200)
    const { result } = (await createRes.json()) as { result: { matter: { id: string } } }
    const matterId = result.matter.id

    const db = await getProductionFirestore()
    expect((await db.collection("matters").doc(matterId).get()).data()?.title).toBe(
      "F03 rollback persisted matter"
    )

    resetRuntimeStoreForTests()
    setFirestorePersistenceForTests(null)

    const listRes = await mattersGet(
      new Request("http://127.0.0.1/api/d1/matters?userId=partner_a&limit=10&cursor=0")
    )
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as { items: Array<{ id: string; title: string }> }
    expect(listed.items.find((row) => row.id === matterId)?.title).toBe(
      "F03 rollback persisted matter"
    )
  })
})
