/**
 * Re-audit R1-D4 (LOW): the production combination, proven in the repository — Firestore
 * persistence (F01) with the R2 document backend (FA-D16-001), against the Firestore emulator and
 * an S3-compatible server (MinIO).
 *
 * Runs only through `npm run test:document-vault-firestore` (firebase emulators:exec + the
 * SIKANDER_TEST_S3_* MinIO settings; CI job `document-vault-s3`). vitest.config.ts leaves it out
 * of the plain unit run when either is missing; run directly without them it fails, never skips.
 *
 * Flow: upload through POST /api/d1/documents into a matter → the Firestore row holds an r2://
 * storagePath and the bucket holds only ciphertext → every piece of process state is wiped
 * (runtime store, document object store, cached Admin Firestore handle) → GET downloads the
 * document byte-identical, with the stored hash.
 */
import { randomBytes, randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/d1/documents/route"
import { resetDocumentObjectStoreForTests } from "@/platform/documents/documentObjectStore"
import { getProductionFirestore, resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { getRuntimeRepositories, setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import type { DocumentRecord } from "@/platform/spine/store"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { createMatter } from "@/services/d1-2/matters"
import { seedFirmARuntimeRecords } from "@/tests/helpers/firestore-runtime-seed"
import { createS3TestClient, type S3TestClient } from "@/tests/helpers/s3TestClient"

const env = process.env as Record<string, string | undefined>
const endpoint = env.SIKANDER_TEST_S3_ENDPOINT?.trim()
const accessKeyId = env.SIKANDER_TEST_S3_ACCESS_KEY_ID?.trim()
const secretAccessKey = env.SIKANDER_TEST_S3_SECRET_ACCESS_KEY?.trim()
const region = env.SIKANDER_TEST_S3_REGION?.trim() || "us-east-1"
const BUCKET = `fa-d16-fs-r2-${randomBytes(4).toString("hex")}`
const MANAGED = [
  "SIKANDER_PERSISTENCE_MODE",
  "SIKANDER_DOCUMENT_OBJECT_BACKEND",
  "SIKANDER_DOCUMENT_OBJECT_ROOT",
  "SIKANDER_R2_ENDPOINT",
  "SIKANDER_R2_BUCKET",
  "SIKANDER_R2_ACCESS_KEY_ID",
  "SIKANDER_R2_SECRET_ACCESS_KEY",
  "SIKANDER_R2_REGION",
  "GCLOUD_PROJECT",
  "FIREBASE_PROJECT_ID",
]

let s3: S3TestClient
let saved: Record<string, string | undefined>

beforeAll(async () => {
  if (!env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set: run npm run test:document-vault-firestore")
  }
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("SIKANDER_TEST_S3_* must point at an S3-compatible server (npm run test:document-vault-firestore)")
  }
  s3 = createS3TestClient({ endpoint, accessKeyId, secretAccessKey, region })
  await s3.createBucket(BUCKET)
})

afterAll(async () => {
  if (s3) await s3.emptyAndDeleteBucket(BUCKET)
})

/** Drops every piece of in-process state: the next request behaves like a fresh instance. */
function wipeProcessState() {
  resetRuntimeStoreForTests()
  resetDocumentObjectStoreForTests()
  resetProductionFirestoreForTests()
  setFirestorePersistenceForTests(null)
}

beforeEach(async () => {
  saved = Object.fromEntries(MANAGED.map((n) => [n, env[n]]))
  env.GCLOUD_PROJECT ??= "demo-fad16-vault"
  env.FIREBASE_PROJECT_ID ??= env.GCLOUD_PROJECT
  env.SIKANDER_PERSISTENCE_MODE = "firestore"
  env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "r2"
  delete env.SIKANDER_DOCUMENT_OBJECT_ROOT
  env.SIKANDER_R2_ENDPOINT = endpoint
  env.SIKANDER_R2_BUCKET = BUCKET
  env.SIKANDER_R2_ACCESS_KEY_ID = accessKeyId
  env.SIKANDER_R2_SECRET_ACCESS_KEY = secretAccessKey
  env.SIKANDER_R2_REGION = region
  wipeProcessState()
  await seedFirmARuntimeRecords()
})

afterEach(() => {
  for (const [n, v] of Object.entries(saved)) {
    if (v === undefined) delete env[n]
    else env[n] = v
  }
  wipeProcessState()
})

describe("R1-D4: Firestore persistence + R2 document backend", () => {
  it("upload persists an r2:// row in Firestore; after a full wipe the download is byte-identical", async () => {
    // The matter and the membership live in Firestore, as in production.
    const store = getRuntimeStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client_a",
      title: "FA-D16 Firestore + R2 matter",
      courtId: "SHC",
      classification: "internal",
    })
    const repos = await getRuntimeRepositories(store)
    await repos.matters.create(matter)
    await repos.members.upsert({ matterId: matter.id, userId: "partner_a", firmId: "firmA" })

    const original = Buffer.concat([
      Buffer.from("%PDF-1.7\nPLAINTEXT-MARKER-FIRESTORE-R2\n"),
      randomBytes(3000),
      Buffer.from("\n%%EOF\n"),
    ])
    const ingest = await POST(
      new Request("http://127.0.0.1/api/d1/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          action: "ingest",
          actorId: "partner_a",
          firmId: "firmA",
          matterId: matter.id,
          contentBase64: original.toString("base64"),
          sourceChannel: "web",
          classification: "internal",
        }),
      })
    )
    const ingestBody = (await ingest.json()) as { result?: { doc: DocumentRecord }; error?: string }
    expect(ingest.status, JSON.stringify(ingestBody)).toBe(200)
    const doc = ingestBody.result!.doc
    expect(doc.storagePath).toMatch(/^r2:\/\/firmA\/documents\/doc_[0-9a-f-]{36}\/v1$/)

    // The row is in Firestore itself, not only in the process.
    const db = await getProductionFirestore()
    const row = (await db.collection("documents").doc(doc.id).get()).data() as DocumentRecord | undefined
    expect(row).toMatchObject({
      firmId: "firmA",
      matterId: matter.id,
      storagePath: doc.storagePath,
      contentHash: doc.contentHash,
      objectBytesStatus: "available",
      isImmutable: true,
      byteSize: original.length,
    })
    const key = `${doc.storagePath.slice("r2://".length)}.enc`
    expect(await s3.listKeys(BUCKET)).toEqual([key])
    const remote = await s3.getObject(BUCKET, key)
    expect(remote.body.includes(Buffer.from("PLAINTEXT-MARKER"))).toBe(false)

    wipeProcessState()
    expect(getRuntimeStore().documents.has(doc.id)).toBe(false)

    const download = await GET(
      new Request(`http://127.0.0.1/api/d1/documents?userId=partner_a&docId=${doc.id}&includeContent=true`)
    )
    const body = (await download.json()) as { contentBase64?: string; contentHash?: string; error?: string }
    expect(download.status, JSON.stringify(body.error)).toBe(200)
    const bytes = Buffer.from(body.contentBase64!, "base64")
    expect(bytes.equals(original)).toBe(true)
    expect(body.contentHash).toBe(doc.contentHash)
    expect(getRuntimeStore().hashKey("firmA", bytes)).toBe(doc.contentHash)
  })
})
