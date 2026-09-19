import { readFileSync } from "node:fs"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing"
import { doc, getDoc } from "firebase/firestore"
import { GET, POST } from "@/app/api/d1/matters/route"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"

const RULES = readFileSync("firestore.rules", "utf8")

let env: RulesTestEnvironment

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "sikander-runtime-persistence",
    firestore: { rules: RULES },
  })
})

beforeEach(() => {
  resetRuntimeStoreForTests()
  process.env.SIKANDER_PERSISTENCE_MODE = "firestore"
})

afterEach(() => {
  delete process.env.SIKANDER_PERSISTENCE_MODE
  setFirestorePersistenceForTests(null)
})

afterAll(async () => {
  await env.cleanup()
})

describe("Runtime persistence mode", () => {
  it("routes matters create/list through Firestore adapter mode in emulator", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())

      const createRes = await POST(
        new Request("http://127.0.0.1/api/d1/matters", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "2387510e-e8e7-4a4f-b31d-5cee051f6f07",
          },
          body: JSON.stringify({
            action: "create",
            actorId: "partner_a",
            firmId: "firmA",
            clientId: "client_a",
            title: "Persisted runtime matter",
            courtId: "SHC",
            classification: "internal",
          }),
        })
      )
      expect(createRes.status).toBe(200)
      const created = (await createRes.json()) as {
        result: { matter: { id: string; title: string } }
      }
      const matterId = created.result.matter.id

      const listRes = await GET(
        new Request("http://127.0.0.1/api/d1/matters?userId=partner_a&limit=10&cursor=0")
      )
      expect(listRes.status).toBe(200)
      const listed = (await listRes.json()) as { items: Array<{ id: string }> }
      expect(listed.items.some((row) => row.id === matterId)).toBe(true)

      const dbMatter = await getDoc(doc(ctx.firestore(), "matters", matterId))
      expect(dbMatter.exists()).toBe(true)
      expect(dbMatter.data()?.title).toBe("Persisted runtime matter")
    })
  })
})
