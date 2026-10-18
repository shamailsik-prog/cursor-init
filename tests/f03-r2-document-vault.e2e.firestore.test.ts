/**
 * Audit F03 to closure (FA-D16-001, FA-D16-002, FA-D16-003), end to end through the real routes, run the way
 * production runs them: NODE_ENV=production, SIKANDER_AUTH_MODE=firebase with a real ID token from the Auth
 * emulator, SIKANDER_PERSISTENCE_MODE=firestore on Admin Firestore (the emulator) for the document rows, and the
 * S3-compatible vault (MinIO over TLS, standing in for Cloudflare R2: production refuses a plain-http vault) for
 * the bytes. A partner of a firm provisioned as the Functions writers provision it uploads through
 * POST /api/d1/documents and downloads through GET.
 *
 * As in tests/f01-production-identity.e2e.firestore.test.ts (#44), a production process refuses both emulator
 * hosts, so two test seams carry them in: setFirestorePersistenceForTests(adminDb()) and
 * setIdTokenVerifierForTests (firebase-admin's verifyIdToken against the Auth emulator; read loosely, so this file
 * also runs against a main without it).
 *
 * "Restart" forgets everything the Next process holds (runtime store, idempotency, session, Firestore and S3
 * clients); only Firestore and the bucket remain, as on a fresh serverless instance.
 *
 * Runs through `npm run test:document-object-s3` (Auth + Firestore emulators, MinIO over https). The file imports
 * nothing that main lacks, so it also runs against main to show the RED.
 */
import { randomUUID } from "node:crypto"
import { FieldValue } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as documentsGet, POST as documentsPost } from "@/app/api/d1/documents/route"
import { resetDocumentObjectStoreForTests } from "@/platform/documents/documentObjectStore"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb, mintIdToken } from "@/tests/helpers/emulator-auth"
import { requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"
import {
  keyOf,
  rawVault,
  realS3Endpoint,
  startS3FaultProxy,
  type FaultProxy,
  type RawVault,
} from "@/tests/helpers/s3-document-vault"

requireAuthFirestoreEmulators("F03 R2 document vault e2e")

// The first emulator ID-token verification also resolves firebase-admin's credentials, which alone can exceed the
// suite's 15 s default on a loaded machine (as in the F01 e2e). The vault's own deadlines are asserted inside.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 })

const env = process.env as Record<string, string | undefined>
const realEndpoint = realS3Endpoint()
const suiteKey = env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
let vault: RawVault
let proxy: FaultProxy

type Verifier = (token: string) => Promise<{ uid: string } & Record<string, unknown>>
type SessionSeams = { setIdTokenVerifierForTests?: (verifier: Verifier | null) => void }

/** The session's token-verifier seam (absent on a main without #44). */
function emulatorVerifier(on: boolean): void {
  const seam = (session as unknown as SessionSeams).setIdTokenVerifierForTests
  seam?.(
    on ? async (token) => (await adminAuth().verifyIdToken(token, true)) as Awaited<ReturnType<Verifier>> : null
  )
}

type Json = Record<string, unknown> & {
  result?: { doc: { id: string; storagePath: string; objectBytesStatus: string } }
  error?: string
  code?: string
  contentBase64?: string
}

type Partner = { firmId: string; uid: string; token: string }

/** Everything a Next process holds in memory is gone; Firestore and the bucket are not. */
function restart() {
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
  session.resetSessionStateForTests()
  resetProductionFirestoreForTests()
  resetDocumentObjectStoreForTests()
  setFirestorePersistenceForTests(adminDb())
  emulatorVerifier(true)
}

function vaultAt(endpoint: string, timeoutMs = "2000", settleMs = "4000") {
  vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT", endpoint)
  vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_S3_TIMEOUT_MS", timeoutMs)
  vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_S3_SETTLE_MS", settleMs)
  resetDocumentObjectStoreForTests()
}

/** A firm and a partner as onboardFirmOp and createFirmUserOp write them, signed in for a real ID token. */
async function provisionPartner(): Promise<Partner> {
  const firm = adminDb().collection("firms").doc()
  await firm.create({ name: `F03 firm ${firm.id}`, dataResidency: "PK", plan: "internal", createdAt: FieldValue.serverTimestamp() })
  const { uid, token } = await mintIdToken({ firmId: firm.id, role: "partner", clearanceLevel: "privileged-restricted" })
  return { firmId: firm.id, uid, token }
}

async function seedMatter(partner: Partner): Promise<string> {
  const matterId = `mat_f03_${randomUUID()}`
  await adminDb().collection("matters").doc(matterId).set({
    id: matterId,
    firmId: partner.firmId,
    clientId: `client_${matterId}`,
    title: "F03 R2 vault matter",
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "engagement_unconfirmed",
    classification: "internal",
  })
  await adminDb()
    .collection("matter_members")
    .doc(`${matterId}_${partner.uid}`)
    .set({ matterId, userId: partner.uid, firmId: partner.firmId })
  return matterId
}

function authHeaders(partner: Partner): Record<string, string> {
  return { Authorization: `Bearer ${partner.token}`, "X-Firm-Id": partner.firmId }
}

async function upload(partner: Partner, matterId: string, original: Buffer): Promise<{ status: number; json: Json }> {
  const res = await documentsPost(
    new Request("http://127.0.0.1/api/d1/documents", {
      method: "POST",
      headers: { ...authHeaders(partner), "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        action: "ingest",
        actorId: partner.uid,
        firmId: partner.firmId,
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

async function download(partner: Partner, docId: string): Promise<{ status: number; json: Json }> {
  const res = await documentsGet(
    new Request(`http://127.0.0.1/api/d1/documents?userId=${partner.uid}&docId=${docId}&includeContent=true`, {
      headers: authHeaders(partner),
    })
  )
  return { status: res.status, json: (await res.json()) as Json }
}

async function documentRowsFor(matterId: string) {
  return (await adminDb().collection("documents").where("matterId", "==", matterId).get()).docs.map((d) => d.data())
}

function pdfBytes(label: string): Buffer {
  return Buffer.from(`%PDF-1.7\nPLAINTEXT-MARKER-F03-R2 ${label} ${randomUUID()}\n%%EOF\n`, "utf8")
}

beforeAll(async () => {
  vault = rawVault(realEndpoint)
  await vault.ensureBucket()
  proxy = await startS3FaultProxy(realEndpoint)
})

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production")
  vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
  vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
  vi.stubEnv("FIREBASE_PROJECT_ID", env.FIREBASE_PROJECT_ID ?? env.GCLOUD_PROJECT ?? "demo-sikander")
  vi.stubEnv("GCLOUD_PROJECT", env.GCLOUD_PROJECT ?? "demo-sikander")
  vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_BACKEND", "r2")
  vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ROOT", "")
  vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY", suiteKey ?? "")
  proxy.setMode({ kind: "pass" })
  vaultAt(realEndpoint)
  restart()
})

afterEach(() => {
  emulatorVerifier(false)
  setFirestorePersistenceForTests(null)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
  session.resetSessionStateForTests()
  resetProductionFirestoreForTests()
  resetDocumentObjectStoreForTests()
})

afterAll(async () => {
  await proxy.close()
  vault.close()
})

describe("F03 / FA-D16-001: an upload lives in the R2 vault and survives a restart (production mode)", () => {
  it("runs as production does: an https vault, Firestore rows and a verified ID token", () => {
    expect(process.env.NODE_ENV).toBe("production")
    expect(realEndpoint.startsWith("https://")).toBe(true)
  })

  it("POST stores ciphertext in the bucket and a Firestore row that points at it; after a restart GET returns the same bytes", async () => {
    const partner = await provisionPartner()
    const matterId = await seedMatter(partner)
    const original = pdfBytes("round trip")
    const posted = await upload(partner, matterId, original)
    expect(posted.status, JSON.stringify(posted.json)).toBe(200)
    const doc = posted.json.result!.doc
    expect(doc.storagePath).toBe(`s3://${partner.firmId}/documents/${doc.id}/v1`)

    const rows = await documentRowsFor(matterId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: doc.id,
      firmId: partner.firmId,
      storagePath: `s3://${partner.firmId}/documents/${doc.id}/v1`,
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
    const got = await download(partner, doc.id)
    expect(got.status, JSON.stringify(got.json)).toBe(200)
    expect(Buffer.from(got.json.contentBase64!, "base64").equals(original)).toBe(true)
  })

  it("an ambiguous PUT that lands late still yields one row and a working download (owner review item 3)", async () => {
    const partner = await provisionPartner()
    const matterId = await seedMatter(partner)
    vaultAt(proxy.endpoint, "2000", "6000")
    proxy.setMode({ kind: "put-lands-late", delayMs: 500 })
    const original = pdfBytes("late put")
    const posted = await upload(partner, matterId, original)
    await proxy.settled()
    proxy.setMode({ kind: "pass" })
    expect(posted.status, JSON.stringify(posted.json)).toBe(200)
    expect(await documentRowsFor(matterId)).toHaveLength(1)
    vaultAt(realEndpoint)
    restart()
    const got = await download(partner, posted.json.result!.doc.id)
    expect(got.status, JSON.stringify(got.json)).toBe(200)
    expect(Buffer.from(got.json.contentBase64!, "base64").equals(original)).toBe(true)
  })

  it("a hanging vault fails the upload inside the time budget, with no row (owner review item 4)", async () => {
    const partner = await provisionPartner()
    const matterId = await seedMatter(partner)
    vaultAt(proxy.endpoint, "300", "500")
    proxy.setMode({ kind: "hang" })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const started = performance.now()
    const posted = await upload(partner, matterId, pdfBytes("hang"))
    const elapsed = performance.now() - started
    proxy.setMode({ kind: "pass" })
    expect(posted.status, JSON.stringify(posted.json)).toBe(400)
    expect(posted.json.code).toBe("REQUEST_FAILED")
    expect(elapsed).toBeLessThan(300 + 500 + 6_000)
    expect(await documentRowsFor(matterId)).toHaveLength(0)
  })
})

describe("F03 / FA-D16-002: integrity failures reach the user as an error, never as wrong bytes (production mode)", () => {
  it("a tampered object, a wrong key and a missing object each make GET answer 500; the intact object reads back", async () => {
    const partner = await provisionPartner()
    const matterId = await seedMatter(partner)
    const original = pdfBytes("integrity")
    const posted = await upload(partner, matterId, original)
    expect(posted.status, JSON.stringify(posted.json)).toBe(200)
    const doc = posted.json.result!.doc
    const key = keyOf(doc.storagePath)
    const intact = (await vault.get(key))!
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})

    const tampered = Buffer.from(intact)
    tampered[tampered.length - 1] ^= 0xff
    await vault.put(key, tampered)
    restart()
    expect(await download(partner, doc.id)).toMatchObject({ status: 500, json: { error: "document bytes unavailable" } })
    expect(errors.mock.calls.flat().join(" ")).toContain(`document bytes unavailable for ${doc.id}`)

    await vault.put(key, intact)
    restart()
    // Another valid key, derived at run time (no key-shaped literal in the repository).
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY", `${"7".repeat(62)}78`)
    expect((await download(partner, doc.id)).status).toBe(500)
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY", suiteKey ?? "")

    restart()
    const back = await download(partner, doc.id)
    expect(back.status).toBe(200)
    expect(Buffer.from(back.json.contentBase64!, "base64").equals(original)).toBe(true)

    await vault.remove(key)
    restart()
    expect((await download(partner, doc.id)).status).toBe(500)
  })

  it.each([
    ["65 hex characters", () => `${suiteKey}f`],
    ["64 hex characters and junk", () => `${suiteKey}zz`],
    ["all-zero", () => "0".repeat(64)],
  ])("an encryption key of %s refuses the upload with 503 and writes nothing", async (_label, badKey) => {
    const partner = await provisionPartner()
    const matterId = await seedMatter(partner)
    const before = (await vault.keys(`${partner.firmId}/documents/`)).length
    const key = badKey()
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY", key)
    const posted = await upload(partner, matterId, pdfBytes("bad key"))
    expect(posted.status, JSON.stringify(posted.json)).toBe(503)
    expect(posted.json.error).toMatch(/SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY/)
    expect(posted.json.error).not.toContain(key)
    expect(await documentRowsFor(matterId)).toHaveLength(0)
    expect((await vault.keys(`${partner.firmId}/documents/`)).length).toBe(before)
  })
})

describe("F03 / FA-D16-003: a failed round trip leaves neither a row nor an object (production mode)", () => {
  it("when the verify read comes back corrupted, the upload fails and the bucket holds nothing new", async () => {
    const partner = await provisionPartner()
    const matterId = await seedMatter(partner)
    vaultAt(proxy.endpoint)
    proxy.setMode({ kind: "corrupt-next-get" })
    const seenBefore = proxy.seen.length
    vi.spyOn(console, "error").mockImplementation(() => {})
    const posted = await upload(partner, matterId, pdfBytes("verify fails"))
    proxy.setMode({ kind: "pass" })
    expect(posted.status, JSON.stringify(posted.json)).toBe(400)
    expect(await documentRowsFor(matterId)).toHaveLength(0)
    expect(await vault.keys(`${partner.firmId}/documents/`)).toEqual([])
    // The PUT did reach the bucket (the verify read followed it), so the cleanup was real.
    const methods = proxy.seen.slice(seenBefore).map((r) => r.method)
    expect(methods).toContain("PUT")
    expect(methods).toContain("DELETE")
  })
})
