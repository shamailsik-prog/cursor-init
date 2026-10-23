import { readFileSync } from "node:fs"
import path from "node:path"
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { doc as firestoreDoc, getDoc } from "firebase/firestore"
import { Timestamp } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { putImmutableDocumentObject, resetDocumentObjectStoreForTests } from "@/platform/documents/documentObjectStore"
import { newStore } from "@/platform/spine/store"
import { adminApp, adminDb } from "../src/admin"
import { onJobCreatedCore } from "../src/p2/functions"
import { LOCAL_OCR_PROVIDER } from "../src/p1/ocrEngine"
import { ocrTestSeam } from "../src/p1/ocrCall"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { FakeClock, readJob, testDeps } from "./jobs"

/**
 * Audit F04. A legacy OCR row (the shape services/d1-6/uploadDocument.ts writes, with no
 * `engine: "p2"`) is picked up by the job-creation core, run through P1, and completed.
 * The extraction is the deterministic local stub: no OCR provider is configured.
 * Firebase Auth + Firestore emulators. Bytes sit in the in-process document vault.
 */

const TEXT = "IN THE HIGH COURT OF SINDH\nSynthetic plaint 2099."
const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff01"
const clock = new FakeClock(Date.parse("2026-10-23T00:00:00Z"))

type SeededDoc = { docId: string; contentHash: string; storagePath: string }

async function seedDoc(opts: {
  firmId: string
  matterId: string | null
  classification: string
  text?: string
  contentHash?: string
  objectBytesStatus?: "available" | "missing"
}): Promise<SeededDoc> {
  const store = newStore()
  const bytes = Buffer.from(opts.text ?? TEXT, "utf8")
  const realHash = store.hashKey(opts.firmId, bytes)
  // `contentHash` on the row may disagree with the bytes (the tamper case). The object is stored under the real hash.
  const contentHash = opts.contentHash ?? realHash
  const docId = uniq("f04-doc")
  let storagePath = `memory://${opts.firmId}/${docId}`
  if (opts.objectBytesStatus !== "missing") {
    const stored = await putImmutableDocumentObject({
      store,
      firmId: opts.firmId,
      docId,
      bytes,
      contentHash: realHash,
      mimeType: "text/plain",
    })
    storagePath = stored.storagePath
  }
  await adminDb().collection("documents").doc(docId).set({
    id: docId,
    firmId: opts.firmId,
    matterId: opts.matterId,
    contentHash,
    sourceChannel: "web",
    classification: opts.classification,
    storagePath,
    isImmutable: true,
    byteSize: bytes.length,
    mimeType: "text/plain",
    objectVersion: 1,
    uploadedBy: "system",
    objectBytesStatus: opts.objectBytesStatus ?? "available",
  })
  return { docId, contentHash, storagePath }
}

function legacyRow(opts: {
  id: string
  firmId: string
  documentId: string
  matterId: string | null
  classification: string
}): Record<string, unknown> {
  return {
    id: opts.id,
    firmId: opts.firmId,
    jobType: "ocr",
    documentId: opts.documentId,
    matterId: opts.matterId,
    classification: opts.classification,
    idempotencyKey: `idem-${opts.id}`,
  }
}

async function writeLegacy(row: Record<string, unknown>): Promise<void> {
  await adminDb().collection("jobs").doc(String(row.id)).set(row)
}

describe.skipIf(!EMULATORS)("F04: a queued OCR job is picked up and completed (emulator)", () => {
  let deps: ReturnType<typeof testDeps>
  let rules: RulesTestEnvironment
  const previousKey = process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
  const previousBackend = process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND

  beforeAll(async () => {
    process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = KEY
    process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = "memory"
    const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":")
    const projectId = adminApp().options.projectId ?? process.env.GCLOUD_PROJECT
    if (!projectId) throw new Error("no emulator project id")
    rules = await initializeTestEnvironment({
      projectId,
      firestore: { rules: readFileSync(path.resolve(__dirname, "../../firestore.rules"), "utf8"), host, port: Number(port) },
    })
  })

  afterAll(async () => {
    if (previousKey === undefined) delete process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY
    else process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY = previousKey
    if (previousBackend === undefined) delete process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND
    else process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND = previousBackend
    await rules?.cleanup()
  })

  beforeEach(() => {
    clock.set(Date.parse("2026-10-23T00:00:00Z"))
    deps = testDeps(clock)
    delete ocrTestSeam.engine
    delete ocrTestSeam.timeoutMs
    resetDocumentObjectStoreForTests()
  })

  afterEach(() => {
    delete ocrTestSeam.engine
    delete ocrTestSeam.timeoutMs
    resetDocumentObjectStoreForTests()
  })

  async function firm(): Promise<string> {
    const firmId = uniq("f04-firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "F04 Firm", plan: "internal" })
    return firmId
  }

  async function matter(firmId: string, classification: string): Promise<string> {
    const matterId = uniq("f04-matter")
    await adminDb()
      .collection("matters")
      .doc(matterId)
      .set({ id: matterId, firmId, classification, title: "Synthetic recovery suit", clientId: "client-2099", courtId: "SHC" })
    return matterId
  }

  it("picks up a legacy queued OCR job, extracts through the local stub, and a second run does not extract again", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "privileged")
    const doc = await seedDoc({ firmId, matterId, classification: "privileged" })
    const jobId = uniq("f04-job")
    // The row is stored below the matter, as a stale label. The result must carry the aggregate.
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)

    await onJobCreatedCore(jobId, row, deps)
    const outcomes = await deps.dispatcher.drainDue(clock.now())
    expect(outcomes).toEqual(["done"])

    const engineJobId = deps.dispatcher.tasks[0]?.jobId
    expect(engineJobId).toBeTruthy()
    expect(engineJobId).not.toBe(jobId)
    const engineJob = await readJob(engineJobId!)
    expect(engineJob.status).toBe("done")
    expect(engineJob.jobType).toBe("d3.ocr")
    expect(engineJob.classification).toBe("privileged")
    expect(engineJob.firmId).toBe(firmId)
    expect(engineJob.matterId).toBe(matterId)

    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("done")
    expect(legacy.get("ocrClassification")).toBe("privileged")
    expect(legacy.get("classification")).toBe("internal")
    expect(legacy.get("ocrFailureCode")).toBeNull()
    const resultId = legacy.get("ocrResultId")
    expect(typeof resultId).toBe("string")
    expect(engineJob.outputRefs).toEqual([`ocr_texts/${resultId}`])
    expect(JSON.stringify(legacy.data())).not.toContain("Synthetic plaint")

    const result = await adminDb().collection("ocr_texts").doc(resultId).get()
    expect(result.exists).toBe(true)
    expect(result.data()).toMatchObject({
      firmId,
      documentId: doc.docId,
      matterId,
      classification: "privileged",
      contentHash: doc.contentHash,
      text: TEXT,
      provider: LOCAL_OCR_PROVIDER,
      lowConfidence: false,
      confidence: 1,
      legacyJobId: jobId,
      jobId: engineJobId,
    })

    const operation = await adminDb().collection("p1_ocr_operations").doc(engineJobId!).get()
    expect(operation.get("outcome")).toBe("ok")
    expect(operation.get("calls")).toBe(1)
    expect(operation.get("provider")).toBe(LOCAL_OCR_PROVIDER)
    expect(operation.get("classification")).toBe("privileged")
    expect(operation.get("reused")).toBe(false)

    const audits = await adminDb().collection("audit_log").where("target", "==", `ocr_texts/${resultId}`).get()
    expect(audits.docs.some((d) => d.get("action") === "ocr.complete" && d.get("classification") === "privileged")).toBe(true)
    expect(JSON.stringify(audits.docs.map((d) => d.data()))).not.toContain("Synthetic plaint")

    // A repeated creation trigger does not extract again.
    await onJobCreatedCore(jobId, (await adminDb().collection("jobs").doc(jobId).get()).data(), deps)
    await deps.dispatcher.drainDue(clock.now())
    expect((await adminDb().collection("p1_ocr_operations").doc(engineJobId!).get()).get("calls")).toBe(1)

    // The attempt that committed the text and then died before `done` runs the handler again.
    await adminDb().collection("jobs").doc(engineJobId!).update({
      status: "queued",
      lease: null,
      nextAttemptAt: Timestamp.fromMillis(clock.now()),
      sweepAt: Timestamp.fromMillis(clock.now()),
      finishedAt: null,
    })
    expect(await deps.dispatcher.deliver({ jobId: engineJobId!, seq: 0 })).toBe("done")
    expect((await adminDb().collection("p1_ocr_operations").doc(engineJobId!).get()).get("calls")).toBe(1)
    expect((await adminDb().collection("ocr_texts").doc(resultId).get()).get("text")).toBe(TEXT)
    expect((await adminDb().collection("jobs").doc(jobId).get()).get("ocrStatus")).toBe("done")
  })

  it("refuses another firm's document and publishes nothing", async () => {
    const firmA = await firm()
    const firmB = await firm()
    const matterB = await matter(firmB, "internal")
    const doc = await seedDoc({ firmId: firmB, matterId: matterB, classification: "internal" })
    const jobId = uniq("f04-xfirm")
    const row = legacyRow({ id: jobId, firmId: firmA, documentId: doc.docId, matterId: null, classification: "internal" })
    await writeLegacy(row)

    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual([])
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("failed")
    expect(legacy.get("ocrFailureCode")).toBe("cross_firm")
    expect((await adminDb().collection("ocr_texts").where("documentId", "==", doc.docId).get()).empty).toBe(true)
    expect((await adminDb().collection("p1_ocr_operations").where("documentId", "==", doc.docId).get()).empty).toBe(true)
  })

  it("refuses a document filed to a different matter", async () => {
    const firmId = await firm()
    const matterA = await matter(firmId, "internal")
    const matterB = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId: matterB, classification: "internal" })
    const jobId = uniq("f04-xmatter")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId: matterA, classification: "internal" })
    await writeLegacy(row)

    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual([])
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrFailureCode")).toBe("matter_mismatch")
    expect(legacy.get("ocrStatus")).toBe("failed")
    expect((await adminDb().collection("ocr_texts").where("documentId", "==", doc.docId).get()).empty).toBe(true)
  })

  it("records a missing document as a failure and does not dispatch", async () => {
    const firmId = await firm()
    const jobId = uniq("f04-missing")
    const row = legacyRow({ id: jobId, firmId, documentId: uniq("f04-absent"), matterId: null, classification: "internal" })
    await writeLegacy(row)
    await onJobCreatedCore(jobId, row, deps)
    expect(deps.dispatcher.tasks).toEqual([])
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("failed")
    expect(legacy.get("ocrFailureCode")).toBe("document_missing")
  })

  it("records an unavailable object and a hash mismatch as failures", async () => {
    const firmId = await firm()
    const missingId = uniq("f04-nobytes")
    const missing = await seedDoc({ firmId, matterId: null, classification: "confidential", objectBytesStatus: "missing" })
    const missingRow = legacyRow({ id: missingId, firmId, documentId: missing.docId, matterId: null, classification: "confidential" })
    await writeLegacy(missingRow)
    await onJobCreatedCore(missingId, missingRow, deps)

    const tamperId = uniq("f04-tamper")
    const tampered = await seedDoc({
      firmId,
      matterId: null,
      classification: "confidential",
      contentHash: "ab".repeat(32),
    })
    const tamperRow = legacyRow({ id: tamperId, firmId, documentId: tampered.docId, matterId: null, classification: "confidential" })
    await writeLegacy(tamperRow)
    await onJobCreatedCore(tamperId, tamperRow, deps)

    expect(deps.dispatcher.tasks).toEqual([])
    expect((await adminDb().collection("jobs").doc(missingId).get()).get("ocrFailureCode")).toBe("object_unavailable")
    expect((await adminDb().collection("jobs").doc(tamperId).get()).get("ocrFailureCode")).toBe("object_tampered")
  })

  it("records an engine failure, then a later attempt completes", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-retry")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    ocrTestSeam.engine = {
      id: LOCAL_OCR_PROVIDER,
      extract: async () => {
        throw new Error("synthetic extractor failure")
      },
    }

    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["failed"])
    const engineJobId = deps.dispatcher.tasks[0]!.jobId
    expect((await readJob(engineJobId)).status).toBe("failed")
    expect((await readJob(engineJobId)).lastError?.code).toBe("ocr_failed")
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("running")
    expect(legacy.get("ocrFailureCode")).toBe("ocr_failed")
    expect((await adminDb().collection("ocr_texts").where("documentId", "==", doc.docId).get()).empty).toBe(true)

    delete ocrTestSeam.engine
    clock.advance(1000)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const done = await adminDb().collection("jobs").doc(jobId).get()
    expect(done.get("ocrStatus")).toBe("done")
    expect(done.get("ocrFailureCode")).toBeNull()
    const text = await adminDb().collection("ocr_texts").doc(done.get("ocrResultId")).get()
    expect(text.get("text")).toBe(TEXT)
    expect((await adminDb().collection("p1_ocr_operations").doc(engineJobId).get()).get("calls")).toBe(2)
  })

  it("a firm kill switch blocks OCR and records the failure with no text", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    await adminDb().collection("ai_config").doc(firmId).set({
      killSwitch: { disableAll: true, disabledModels: [], reason: "stop synthetic OCR", setBy: "partner", setAt: Timestamp.fromMillis(clock.now()) },
    })
    const jobId = uniq("f04-kill")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)

    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["dead_lettered"])
    expect(deps.alerts.map((a) => a.code)).toEqual(["ocr_blocked"])
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("failed")
    expect(legacy.get("ocrFailureCode")).toBe("ocr_blocked")
    expect((await adminDb().collection("ocr_texts").where("documentId", "==", doc.docId).get()).empty).toBe(true)
    const operation = await adminDb().collection("p1_ocr_operations").where("documentId", "==", doc.docId).get()
    expect(operation.docs.map((d) => d.get("outcome"))).toEqual(["blocked"])
    expect(operation.docs[0]!.get("blockReason")).toBe("kill_switch_firm")
  })

  it("times out a hung extractor and records ocr_timeout", async () => {
    const firmId = await firm()
    const doc = await seedDoc({ firmId, matterId: null, classification: "confidential" })
    const jobId = uniq("f04-time")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId: null, classification: "confidential" })
    await writeLegacy(row)
    ocrTestSeam.timeoutMs = 30
    ocrTestSeam.engine = { id: LOCAL_OCR_PROVIDER, extract: () => new Promise(() => undefined) }

    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["failed"])
    expect((await readJob(deps.dispatcher.tasks[0]!.jobId)).lastError?.code).toBe("ocr_timeout")
    expect((await adminDb().collection("jobs").doc(jobId).get()).get("ocrFailureCode")).toBe("ocr_timeout")
  })

  it("publishes a loose-vault document without a matter reference, and the text follows clearance", async () => {
    const firmId = await firm()
    const doc = await seedDoc({ firmId, matterId: null, classification: "confidential" })
    const jobId = uniq("f04-loose")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId: null, classification: "confidential" })
    await writeLegacy(row)
    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const engineJob = await readJob(deps.dispatcher.tasks[0]!.jobId)
    expect(engineJob.matterId).toBeNull()
    expect(engineJob.outputRefs).toEqual([])
    const resultId = (await adminDb().collection("jobs").doc(jobId).get()).get("ocrResultId")
    const result = await adminDb().collection("ocr_texts").doc(resultId).get()
    expect(result.get("matterId")).toBeNull()
    expect(result.get("classification")).toBe("confidential")
    expect(result.get("text")).toBe(TEXT)

    const clerk = await mintIdToken({ firmId, role: "clerk", clearanceLevel: "confidential" })
    const associate = await mintIdToken({ firmId, role: "associate", clearanceLevel: "confidential" })
    const low = await mintIdToken({ firmId, role: "clerk", clearanceLevel: "internal" })
    const client = (uid: string, role: string, clearanceLevel: string) =>
      rules.authenticatedContext(uid, { firmId, role, clearanceLevel }).firestore()
    await assertSucceeds(getDoc(firestoreDoc(client(clerk.uid, "clerk", "confidential"), "ocr_texts", resultId)))
    await assertFails(getDoc(firestoreDoc(client(associate.uid, "associate", "confidential"), "ocr_texts", resultId)))
    await assertFails(getDoc(firestoreDoc(client(low.uid, "clerk", "internal"), "ocr_texts", resultId)))
    const text = await getDoc(firestoreDoc(client(clerk.uid, "clerk", "confidential"), "ocr_texts", resultId))
    expect(text.get("text")).toBe(TEXT)
  })

  it("hides a privileged OCR result from a member below the matter and from another firm", async () => {
    const firmId = await firm()
    const otherFirm = await firm()
    const matterId = await matter(firmId, "privileged")
    const doc = await seedDoc({ firmId, matterId, classification: "privileged" })
    const jobId = uniq("f04-clear")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const resultId = (await adminDb().collection("jobs").doc(jobId).get()).get("ocrResultId") as string
    const engineJobId = deps.dispatcher.tasks[0]!.jobId

    const cleared = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged" })
    const below = await mintIdToken({ firmId, role: "clerk", clearanceLevel: "confidential" })
    const outsider = await mintIdToken({ firmId: otherFirm, role: "partner", clearanceLevel: "privileged-restricted" })
    await adminDb().collection("matter_members").doc(`${matterId}_${cleared.uid}`).set({ firmId, matterId, userId: cleared.uid })
    await adminDb().collection("matter_members").doc(`${matterId}_${below.uid}`).set({ firmId, matterId, userId: below.uid })

    const client = (uid: string, whoFirm: string, role: string, clearanceLevel: string) =>
      rules.authenticatedContext(uid, { firmId: whoFirm, role, clearanceLevel }).firestore()

    const seen = await getDoc(firestoreDoc(client(cleared.uid, firmId, "partner", "privileged"), "ocr_texts", resultId))
    expect(seen.get("text")).toBe(TEXT)
    expect(seen.get("classification")).toBe("privileged")
    await assertFails(getDoc(firestoreDoc(client(below.uid, firmId, "clerk", "confidential"), "ocr_texts", resultId)))
    await assertFails(getDoc(firestoreDoc(client(outsider.uid, otherFirm, "partner", "privileged-restricted"), "ocr_texts", resultId)))
    await assertFails(getDoc(firestoreDoc(client(cleared.uid, firmId, "partner", "privileged"), "p1_ocr_operations", engineJobId)))
  })
})
