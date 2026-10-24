// FA-F13-026: a signed-in user's documents GET must not serve a stale in-process row when Firestore holds the same id
// with a malformed stored firmId (get must throw DocumentMalformedError, not return null).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as mattersPost } from "@/app/api/d1/matters/route"
import { GET as documentsGet, POST as documentsPost } from "@/app/api/d1/documents/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { testAdminFirestore } from "@/tests/helpers/admin-firestore"

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const PROJECT = "sikander-f13-026-runtime"
const db = () => testAdminFirestore(PROJECT)
const B = "http://127.0.0.1"

let keySeq = 0
const idemKey = () => `f13-026-${String(++keySeq).padStart(12, "0")}`

const post = (body: unknown) =>
  documentsPost(
    new Request(`${B}/api/d1/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey() },
      body: JSON.stringify(body),
    })
  )

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  "F13 FA-F13-026: documents GET drops cache on malformed stored firmId",
  () => {
    beforeEach(() => {
      resetRuntimeStoreForTests()
      process.env.SIKANDER_PERSISTENCE_MODE = "firestore"
      setFirestorePersistenceForTests(db())
    })
    afterEach(() => {
      delete process.env.SIKANDER_PERSISTENCE_MODE
      setFirestorePersistenceForTests(null)
    })

    it("partner GET returns 404 and clears the stale cache when Firestore firmId is non-string", async () => {
      const created = await mattersPost(
        new Request(`${B}/api/d1/matters`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey() },
          body: JSON.stringify({
            action: "create",
            actorId: "partner_a",
            firmId: "firmA",
            clientId: "client_a",
            title: "F13-026 matter",
            courtId: "SHC",
            classification: "internal",
            memberUserIds: [],
          }),
        })
      )
      expect(created.status).toBe(200)
      const matterId = ((await created.json()) as { result: { matter: { id: string } } }).result.matter.id

      const ingested = await post({
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: Buffer.from("%PDF-f13-026%").toString("base64"),
        sourceChannel: "web",
        classification: "internal",
      })
      expect(ingested.status).toBe(200)
      const docId = ((await ingested.json()) as { result: { doc: { id: string } } }).result.doc.id

      const store = getRuntimeStore()
      const cached = store.documents.get(docId)
      expect(cached?.firmId).toBe("firmA")

      const snap = await db().collection("documents").doc(docId).get()
      await db().collection("documents").doc(docId).set({ ...snap.data(), firmId: 12 })

      const res = await documentsGet(
        new Request(`${B}/api/d1/documents?userId=partner_a&docId=${docId}&includeContent=true`)
      )
      expect(res.status).toBe(404)
      expect(store.documents.has(docId)).toBe(false)
    })
  }
)
