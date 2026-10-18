/**
 * Audit F03 to closure (FA-D16-001, FA-D16-002, FA-D16-003), end to end through the real routes:
 * a partner uploads through POST /api/d1/documents and downloads through GET, with the production
 * combination of persistence and vault: Admin Firestore (the emulator, SIKANDER_PERSISTENCE_MODE=firestore)
 * for the document row and an S3-compatible vault (MinIO standing in for Cloudflare R2) for the bytes.
 *
 * "Restart" forgets everything the Next process holds (runtime store, idempotency, Firestore and S3
 * clients); only Firestore and the bucket remain, as on a fresh serverless instance.
 *
 * Runs through `npm run test:document-object-s3`, which needs the Firestore emulator and MinIO. The
 * file imports nothing that main lacks, so it also runs against main to show the RED.
 */
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as documentsGet, POST as documentsPost } from "@/app/api/d1/documents/route"
import { resetDocumentObjectStoreForTests } from "@/platform/documents/documentObjectStore"
import * as idempotency from "@/platform/http/idempotency"
import { getProductionFirestore, resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { seedFirmARuntimeRecords } from "@/tests/helpers/firestore-runtime-seed"
import {
  keyOf,
  rawVault,
  realS3Endpoint,
  startS3FaultProxy,
  type FaultProxy,
  type RawVault,
} from "@/tests/helpers/s3-document-vault"

// Admin Firestore on the emulator is slow to open on a loaded runner; the vault's own deadlines are
// asserted inside the tests, so the per-test ceiling only has to cover Firestore.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const env = process.env as Record<string, string | undefined>
const realEndpoint = realS3Endpoint()
const saved: Record<string, string | undefined> = {}
const SAVED_ENV = [
  "SIKANDER_PERSISTENCE_MODE",
  "SIKANDER_DOCUMENT_OBJECT_BACKEND",
  "SIKANDER_DOCUMENT_OBJECT_ROOT",
  "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT",
  "SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS",
  "SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS",
  "SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY",
]
let vault: RawVault
let proxy: FaultProxy

type Json = Record<string, unknown> & {
  result?: { doc: { id: string; storagePath: string; objectBytesStatus: string } }
  error?: string
  code?: string
  contentBase64?: string
}

/** Everything a Next process holds in memory is gone; Firestore and the bucket are not. */
function restart() {
  resetRuntimeStoreForTests()
  idempotency.resetIdempotencyForTests()
  resetProductionFirestoreForTests()
  setFirestorePersistenceForTests(null)
  resetDocumentObjectStoreForTests()
}

function vaultAt(endpoint: string, timeoutMs = "2000", settleMs = "4000") {
  env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT = endpoint
  env.SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS = timeoutMs
  env.SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS = settleMs
  resetDocumentObjectStoreForTests()
}

async function seedMatter(): Promise<string> {
  const db = await getProductionFirestore()
  const matterId = `mat_f03_${randomUUID()}`
  await db.collection("matters").doc(matterId).set({
    id: matterId,
    firmId: "firmA",
    clientId: "client_a",
    title: "F03 R2 vault matter",
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "engagement_unconfirmed",
    classification: "internal",
  })
  await db.collection("matter_members").doc(`${matterId}_partner_a`).set({ matterId, userId: "partner_a", firmId: "firmA" })
  return matterId
}

async function upload(matterId: string, original: Buffer): Promise<{ status: number; json: Json }> {
  const res = await documentsPost(
    new Request("http://127.0.0.1/api/d1/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        action: "ingest",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        contentBase64: original.toString("base64"),
        sourceChannel: "web",
        classification: "internal",
        mimeType: "application/pdf",
      }),
    })
  )
  return { status: res.status, json: (await res.json()) as Json }
}

async function download(docId: string): Promise<{ status: number; json: Json }> {
  const res = await documentsGet(
    new Request(`http://127.0.0.1/api/d1/documents?userId=partner_a&docId=${docId}&includeContent=true`)
  )
  return { status: res.status, json: (await res.json()) as Json }
}

async function documentRowsFor(matterId: string) {
  const db = await getProductionFirestore()
  return (await db.collection("documents").where("matterId", "==", matterId).get()).docs.map((d) => d.data())
}

function pdfBytes(label: string): Buffer {
  return Buffer.from(`%PDF-1.7\nPLAINTEXT-MARKER-F03-R2 ${label} ${randomUUID()}\n%%EOF\n`, "utf8")
}

beforeAll(async () => {
  for (const name of SAVED_ENV) saved[name] = env[name]
  vault = rawVault(realEndpoint)
  await vault.ensureBucket()
  proxy = await startS3FaultProxy(realEndpoint)
}, 60_000)

beforeEach(async () => {
  env.GCLOUD_PROJECT ??= "demo-sikander"
  env.FIREBASE_PROJECT_ID ??= "demo-sikander"
  env.SIKANDER_PERSISTENCE_MODE = "firestore"
  env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "s3"
  delete env.SIKANDER_DOCUMENT_OBJECT_ROOT
  env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = saved.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
  proxy.setMode({ kind: "pass" })
  vaultAt(realEndpoint)
  restart()
  await seedFirmARuntimeRecords()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  restart()
  await proxy.close()
  vault.close()
})

describe("F03 / FA-D16-001: an upload lives in the R2 vault and survives a restart", () => {
  it("POST stores ciphertext in the bucket and a Firestore row that points at it; after a restart GET returns the same bytes", async () => {
    const matterId = await seedMatter()
    const original = pdfBytes("round trip")
    const posted = await upload(matterId, original)
    expect(posted.status).toBe(200)
    const doc = posted.json.result!.doc
    expect(doc.storagePath).toBe(`s3://firmA/documents/${doc.id}/v1`)

    const rows = await documentRowsFor(matterId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: doc.id,
      storagePath: `s3://firmA/documents/${doc.id}/v1`,
      objectBytesStatus: "available",
      isImmutable: true,
      byteSize: original.length,
      objectVersion: 1,
    })

    const stored = await vault.get(keyOf(doc.storagePath))
    expect(stored).not.toBeNull()
    expect(stored!.includes(Buffer.from("PLAINTEXT-MARKER-F03-R2"))).toBe(false)
    expect(stored!.length).toBe(original.length + 1 + 12 + 16)

    restart()
    const got = await download(doc.id)
    expect(got.status).toBe(200)
    expect(Buffer.from(got.json.contentBase64!, "base64").equals(original)).toBe(true)
  })

  it("an ambiguous PUT that lands late still yields one row and a working download (owner review item 3)", async () => {
    const matterId = await seedMatter()
    vaultAt(proxy.endpoint, "2000", "6000")
    proxy.setMode({ kind: "put-lands-late", delayMs: 500 })
    const original = pdfBytes("late put")
    const posted = await upload(matterId, original)
    await proxy.settled()
    proxy.setMode({ kind: "pass" })
    expect(posted.status).toBe(200)
    expect(await documentRowsFor(matterId)).toHaveLength(1)
    restart()
    vaultAt(realEndpoint)
    const got = await download(posted.json.result!.doc.id)
    expect(got.status).toBe(200)
    expect(Buffer.from(got.json.contentBase64!, "base64").equals(original)).toBe(true)
  })

  it("a hanging vault fails the upload inside the time budget, with no row (owner review item 4)", async () => {
    const matterId = await seedMatter()
    vaultAt(proxy.endpoint, "300", "500")
    proxy.setMode({ kind: "hang" })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const started = performance.now()
    const posted = await upload(matterId, pdfBytes("hang"))
    const elapsed = performance.now() - started
    proxy.setMode({ kind: "pass" })
    expect(posted.status).toBe(400)
    expect(posted.json.code).toBe("REQUEST_FAILED")
    expect(elapsed).toBeLessThan(300 + 500 + 6_000)
    expect(await documentRowsFor(matterId)).toHaveLength(0)
  })
})

describe("F03 / FA-D16-002: integrity failures reach the user as an error, never as wrong bytes", () => {
  it("a tampered object, a wrong key and a missing object each make GET answer 500; the intact object reads back", async () => {
    const matterId = await seedMatter()
    const original = pdfBytes("integrity")
    const posted = await upload(matterId, original)
    expect(posted.status).toBe(200)
    const doc = posted.json.result!.doc
    const key = keyOf(doc.storagePath)
    const intact = (await vault.get(key))!
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})

    const tampered = Buffer.from(intact)
    tampered[tampered.length - 1] ^= 0xff
    await vault.put(key, tampered)
    restart()
    expect(await download(doc.id)).toMatchObject({ status: 500, json: { error: "document bytes unavailable" } })
    expect(errors.mock.calls.flat().join(" ")).toContain(`document bytes unavailable for ${doc.id}`)

    await vault.put(key, intact)
    restart()
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY", "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff1")
    expect((await download(doc.id)).status).toBe(500)
    vi.unstubAllEnvs()

    restart()
    const back = await download(doc.id)
    expect(back.status).toBe(200)
    expect(Buffer.from(back.json.contentBase64!, "base64").equals(original)).toBe(true)

    await vault.remove(key)
    restart()
    expect((await download(doc.id)).status).toBe(500)
  })

  it.each([
    ["65 hex characters", "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00f"],
    ["64 hex characters and junk", "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00zz"],
    ["all-zero", "0".repeat(64)],
  ])("an encryption key of %s refuses the upload with 503 and writes nothing", async (_label, key) => {
    const matterId = await seedMatter()
    const before = (await vault.keys("firmA/documents/")).length
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY", key)
    const posted = await upload(matterId, pdfBytes("bad key"))
    expect(posted.status).toBe(503)
    expect(posted.json.error).toMatch(/SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY/)
    expect(posted.json.error).not.toContain(key)
    expect(await documentRowsFor(matterId)).toHaveLength(0)
    expect((await vault.keys("firmA/documents/")).length).toBe(before)
  })
})

describe("F03 / FA-D16-003: a failed round trip leaves neither a row nor an object", () => {
  it("when the verify read comes back corrupted, the upload fails and the bucket holds nothing new", async () => {
    const matterId = await seedMatter()
    const before = new Set(await vault.keys("firmA/documents/"))
    vaultAt(proxy.endpoint)
    proxy.setMode({ kind: "corrupt-next-get" })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const posted = await upload(matterId, pdfBytes("verify fails"))
    proxy.setMode({ kind: "pass" })
    expect(posted.status).toBe(400)
    expect(await documentRowsFor(matterId)).toHaveLength(0)
    const after = (await vault.keys("firmA/documents/")).filter((k) => !before.has(k))
    expect(after).toEqual([])
    // The PUT did reach the bucket (the verify read followed it), so the cleanup was real.
    expect(proxy.seen.some((r) => r.method === "PUT")).toBe(true)
    expect(proxy.seen.some((r) => r.method === "DELETE")).toBe(true)
  })
})
