import { readFileSync } from "node:fs"
import path from "node:path"
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { doc as firestoreDoc, getDoc } from "firebase/firestore"
import { Timestamp } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  __testHookFailNextDocumentObjectRead,
  putImmutableDocumentObject,
  resetDocumentObjectStoreForTests,
} from "@/platform/documents/documentObjectStore"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"
import { newStore } from "@/platform/spine/store"
import { summarizeOcrJobs } from "@/services/d1-6/ocrStatus"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { adminApp, adminDb } from "../src/admin"
import { onJobCreatedCore } from "../src/p2/functions"
import { jobsRef } from "../src/p2/enqueue"
import { ocrDrainTestSeam } from "../src/p2/ocrDrain"
import { jobWorkerTestSeam, runJobTask } from "../src/p2/worker"
import { LOCAL_OCR_PROVIDER } from "../src/p1/ocrEngine"
import { ocrTestSeam, ocrTextId } from "../src/p1/ocrCall"
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
  ocrStatus?: string
}): Record<string, unknown> {
  return {
    id: opts.id,
    firmId: opts.firmId,
    jobType: "ocr",
    documentId: opts.documentId,
    matterId: opts.matterId,
    classification: opts.classification,
    idempotencyKey: `idem-${opts.id}`,
    ocrStatus: opts.ocrStatus ?? "queued",
  }
}

function terminalLegacyFiller(id: string, firmId: string): Record<string, unknown> {
  return {
    id,
    firmId,
    jobType: "ocr",
    documentId: `f04-filler-doc-${id}`,
    matterId: null,
    classification: "internal",
    idempotencyKey: `idem-${id}`,
    ocrStatus: "done",
    ocrResultId: `f04-filler-text-${id}`,
  }
}

/** Legacy row the sweep must close: still `queued` while its engine job is already cancelled. */
function incompleteLegacyFiller(id: string, firmId: string): Record<string, unknown> {
  return { id, firmId, jobType: "ocr", ocrStatus: "queued" }
}

function stampedLegacyFiller(id: string, firmId: string): Record<string, unknown> {
  return {
    id,
    firmId,
    jobType: "ocr",
    documentId: `f04-stamp-doc-${id}`,
    matterId: null,
    classification: "internal",
    idempotencyKey: `idem-${id}`,
    ocrStatus: "done",
    ocrResultId: `f04-stamp-text-${id}`,
  }
}

function missingFirmLegacyFiller(id: string): Record<string, unknown> {
  return { id, jobType: "ocr", ocrStatus: "queued" }
}

function unsafeFirmLegacyFiller(id: string): Record<string, unknown> {
  return { id, firmId: "../../evil", jobType: "ocr", ocrStatus: "queued" }
}

async function writeCancelledLegacyStuck(id: string, firmId: string): Promise<void> {
  const { jobIdFor } = await import("../src/p2/enqueue")
  const { JOB_ENGINE } = await import("../src/p2/constants")
  const { OCR_JOB_TYPE } = await import("../src/p2/ocrJob")
  const documentId = `f04-filler-doc-${id}`
  const row = legacyRow({ id, firmId, documentId, matterId: null, classification: "internal", ocrStatus: "queued" })
  const engineJobId = jobIdFor(firmId, OCR_JOB_TYPE, id)
  const batch = adminDb().batch()
  batch.set(adminDb().collection("jobs").doc(id), row)
  batch.set(adminDb().collection("jobs").doc(engineJobId), {
    engine: JOB_ENGINE,
    firmId,
    jobType: OCR_JOB_TYPE,
    status: "cancelled",
    payload: { version: 1, legacyJobId: id, documentId, contentHash: KEY },
  })
  await batch.commit()
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

  beforeEach(async () => {
    clock.set(Date.parse("2026-10-23T00:00:00Z"))
    deps = testDeps(clock)
    await adminDb().collection("system").doc("ocrStatusBackfill").delete()
    delete ocrTestSeam.engine
    delete ocrTestSeam.timeoutMs
    ocrDrainTestSeam.failEnqueueOnce = false
    resetDocumentObjectStoreForTests()
  })

  afterEach(() => {
    delete ocrTestSeam.engine
    delete ocrTestSeam.timeoutMs
    ocrDrainTestSeam.failEnqueueOnce = false
    delete jobWorkerTestSeam.beforeCommit
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

  it("FA-F04-006: prod-like runtime blocks upload→OCR with provider_unsupported (no stub text)", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-prod-stub")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)

    await onJobCreatedCore(jobId, row, deps)
    const previousProfile = process.env.SIKANDER_DEPLOY_PROFILE
    process.env.SIKANDER_DEPLOY_PROFILE = "staging"
    try {
      expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["dead_lettered"])
      const legacy = await adminDb().collection("jobs").doc(jobId).get()
      expect(legacy.get("ocrStatus")).toBe("failed")
      expect(legacy.get("ocrFailureCode")).toBe("provider_unsupported")
      expect((await adminDb().collection("ocr_texts").where("documentId", "==", doc.docId).get()).empty).toBe(true)
      const operation = await adminDb().collection("p1_ocr_operations").doc(deps.dispatcher.tasks[0]!.jobId).get()
      expect(operation.get("outcome")).toBe("blocked")
      expect(operation.get("blockReason")).toBe("provider_unsupported")
      expect(operation.get("provider")).toBeNull()
    } finally {
      if (previousProfile === undefined) delete process.env.SIKANDER_DEPLOY_PROFILE
      else process.env.SIKANDER_DEPLOY_PROFILE = previousProfile
    }
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

  it("FA-F04-001: a failed enqueue is not acknowledged, and the retry then completes", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-handoff")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    ocrDrainTestSeam.failEnqueueOnce = true

    await expect(onJobCreatedCore(jobId, row, deps)).rejects.toThrow(/ocr_drain_unavailable/)
    expect(deps.dispatcher.tasks).toEqual([])
    const stuck = await adminDb().collection("jobs").doc(jobId).get()
    expect(stuck.get("ocrStatus")).not.toBe("done")
    expect(stuck.get("ocrStatus")).not.toBe("failed")

    await onJobCreatedCore(jobId, stuck.data(), deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const done = await adminDb().collection("jobs").doc(jobId).get()
    expect(done.get("ocrStatus")).toBe("done")
    const result = await adminDb().collection("ocr_texts").doc(done.get("ocrResultId")).get()
    expect(result.get("text")).toBe(TEXT)
    const engineJobId = deps.dispatcher.tasks[0]!.jobId
    expect((await adminDb().collection("p1_ocr_operations").doc(engineJobId).get()).get("calls")).toBe(1)
  })

  it("FA-F04-002: a transient object-store error is retried, and a missing object stays permanent", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-transient")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    __testHookFailNextDocumentObjectRead()

    await expect(onJobCreatedCore(jobId, row, deps)).rejects.toThrow(/object_unavailable/)
    expect(deps.dispatcher.tasks).toEqual([])
    const mid = await adminDb().collection("jobs").doc(jobId).get()
    expect(mid.get("ocrStatus")).not.toBe("failed")
    expect(mid.get("ocrFailureCode")).not.toBe("object_unavailable")

    await onJobCreatedCore(jobId, mid.data(), deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    expect((await adminDb().collection("jobs").doc(jobId).get()).get("ocrStatus")).toBe("done")

    const absentId = uniq("f04-notfound")
    const absent = await seedDoc({ firmId, matterId, classification: "internal" })
    await adminDb().collection("documents").doc(absent.docId).update({ storagePath: `memory://${firmId}/missing-object` })
    const absentRow = legacyRow({ id: absentId, firmId, documentId: absent.docId, matterId, classification: "internal" })
    await writeLegacy(absentRow)
    await expect(onJobCreatedCore(absentId, absentRow, deps)).resolves.toBeUndefined()
    expect((await adminDb().collection("jobs").doc(absentId).get()).get("ocrFailureCode")).toBe("object_unavailable")
    expect((await adminDb().collection("jobs").doc(absentId).get()).get("ocrStatus")).toBe("failed")
    expect(deps.dispatcher.tasks).toHaveLength(1)
  })

  it("FA-F04-003: raising the document label denies a reader cleared only for the stored OCR label", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-relabel")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const resultId = (await adminDb().collection("jobs").doc(jobId).get()).get("ocrResultId") as string
    expect((await adminDb().collection("ocr_texts").doc(resultId).get()).get("classification")).toBe("internal")

    await adminDb().collection("documents").doc(doc.docId).update({ classification: "confidential" })

    const internalClerk = await mintIdToken({ firmId, role: "clerk", clearanceLevel: "internal" })
    const confidentialClerk = await mintIdToken({ firmId, role: "clerk", clearanceLevel: "confidential" })
    await adminDb().collection("matter_members").doc(`${matterId}_${internalClerk.uid}`).set({ firmId, matterId, userId: internalClerk.uid })
    await adminDb().collection("matter_members").doc(`${matterId}_${confidentialClerk.uid}`).set({ firmId, matterId, userId: confidentialClerk.uid })

    const client = (uid: string, clearanceLevel: string) =>
      rules.authenticatedContext(uid, { firmId, role: "clerk", clearanceLevel }).firestore()

    await assertFails(getDoc(firestoreDoc(client(internalClerk.uid, "internal"), "ocr_texts", resultId)))
    const seen = await getDoc(firestoreDoc(client(confidentialClerk.uid, "confidential"), "ocr_texts", resultId))
    expect(seen.get("text")).toBe(TEXT)
  })

  it("FA-F04-004: a long Urdu document is drained and the stored text stays inside a UTF-8 byte cap", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const ch = "\u{FBAB}"
    const urdu = ch.repeat(600_000)
    const doc = await seedDoc({ firmId, matterId, classification: "internal", text: urdu })
    const jobId = uniq("f04-urdu")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)

    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("done")
    const text = (await adminDb().collection("ocr_texts").doc(legacy.get("ocrResultId")).get()).get("text") as string
    const cap = 900 * 1024
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(cap)
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text)
    expect(text.endsWith(ch)).toBe(true)
    expect(text.length).toBeLessThan(urdu.length)
    const engineJobId = deps.dispatcher.tasks[0]!.jobId
    const operationText = (await adminDb().collection("p1_ocr_operations").doc(engineJobId).get()).get("text") as string
    expect(Buffer.byteLength(operationText, "utf8")).toBeLessThanOrEqual(cap)
  }, 60_000)

  it("FA-F04-005: the worker drains the job row a real upload persisted", async () => {
    const firmId = await firm()
    const store = newStore()
    const text = "IN THE HIGH COURT OF SINDH\nUpload writer 2099."
    const uploaded = await uploadDocument(store, {
      firmId,
      matterId: null,
      bytes: Buffer.from(text, "utf8"),
      sourceChannel: "web",
      classification: "confidential",
      idempotencyKey: "7c2a9e14-6b0d-4f38-9a71-2d5e8c0b4a16",
      uploadedBy: "partner-f04",
    })
    expect(uploaded.reused).toBe(false)
    const memDoc = store.documents.get(uploaded.docId)
    const memJob = store.jobs.find((job) => job.documentId === uploaded.docId && job.jobType === "ocr")
    expect(memDoc).toBeTruthy()
    expect(memJob).toBeTruthy()
    const repos = createFirestoreRepositories(adminDb() as never)
    await repos.documents.create(memDoc!)
    await repos.jobs.create(memJob!)

    const snap = await adminDb().collection("jobs").doc(memJob!.id).get()
    expect(snap.exists).toBe(true)
    const persisted = snap.data()
    expect(persisted?.idempotencyKey).toBe("7c2a9e14-6b0d-4f38-9a71-2d5e8c0b4a16")
    expect(Object.hasOwn(persisted ?? {}, "engine")).toBe(false)

    await onJobCreatedCore(memJob!.id, persisted, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const legacy = await adminDb().collection("jobs").doc(memJob!.id).get()
    expect(legacy.get("ocrStatus")).toBe("done")
    const result = await adminDb().collection("ocr_texts").doc(legacy.get("ocrResultId")).get()
    expect(result.get("text")).toBe(text)

    const firmDocs = await repos.documents.listByFirm(firmId)
    const firmJobs = await repos.jobs.listByFirm(firmId)
    const items = firmDocs.map((document) => {
      const summary = summarizeOcrJobs(firmJobs.filter((job) => job.jobType === "ocr" && job.documentId === document.id))
      return { id: document.id, ocrJobs: summary.ocrJobs, ocrStatus: summary.ocrStatus }
    })
    expect(items.find((item) => item.id === uploaded.docId)).toEqual({
      id: uploaded.docId,
      ocrJobs: 1,
      ocrStatus: "done",
    })
  })

  it("FA-F04-007: create-time drain still hands off without running the sweep", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-create-only")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)

    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("done")
    expect((await adminDb().collection("ocr_texts").doc(legacy.get("ocrResultId")).get()).get("text")).toBe(TEXT)
  })

  it("FA-F04-007: a sweep drains an older legacy row the create trigger never saw", async () => {
    const { sweepLegacyOcr } = await import("../src/p2/ocrSweep")
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-older")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    expect((await adminDb().collection("jobs").doc(jobId).get()).get("ocrStatus")).toBe("queued")

    await sweepLegacyOcr(deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("done")
    const result = await adminDb().collection("ocr_texts").doc(legacy.get("ocrResultId")).get()
    expect(result.get("text")).toBe(TEXT)
  })

  it("FA-F04-007: the sweep picks up a row whose engine retries are exhausted", async () => {
    const { sweepLegacyOcr } = await import("../src/p2/ocrSweep")
    const { jobIdFor } = await import("../src/p2/enqueue")
    const { OCR_JOB_TYPE } = await import("../src/p2/ocrJob")
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-exhausted")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    await onJobCreatedCore(jobId, row, deps)
    const engineJobId = deps.dispatcher.tasks[0]!.jobId
    expect(engineJobId).toBe(jobIdFor(firmId, OCR_JOB_TYPE, jobId))
    // The handler never ran. The engine row is already dead-lettered and the legacy row is still running.
    await adminDb().collection("jobs").doc(engineJobId).update({
      status: "dead_lettered",
      attempts: 4,
      manualRetries: 0,
      nextAttemptAt: null,
      sweepAt: null,
      finishedAt: Timestamp.fromMillis(clock.now()),
      lastError: { code: "ocr_failed", message: "retries exhausted" },
    })
    await adminDb().collection("jobs").doc(jobId).update({ ocrStatus: "running", ocrFailureCode: "ocr_failed" })

    await sweepLegacyOcr(deps)
    const revived = await readJob(engineJobId)
    expect(revived.status).toBe("queued")
    expect(revived.manualRetries).toBe(1)
    expect(await deps.dispatcher.drainDue(clock.now())).toContain("done")
    expect((await adminDb().collection("jobs").doc(jobId).get()).get("ocrStatus")).toBe("done")
    expect((await adminDb().collection("ocr_texts").where("documentId", "==", doc.docId).get()).docs[0]?.get("text")).toBe(TEXT)
  })

  it("FA-F04-007: a dead-lettered OCR job at the manual retry cap is closed instead of requeued", async () => {
    const { sweepLegacyOcr } = await import("../src/p2/ocrSweep")
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-cap")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    await onJobCreatedCore(jobId, row, deps)
    const engineJobId = deps.dispatcher.tasks[0]!.jobId
    await adminDb().collection("jobs").doc(engineJobId).update({
      status: "dead_lettered",
      attempts: 4,
      manualRetries: 3,
      nextAttemptAt: null,
      sweepAt: null,
      finishedAt: Timestamp.fromMillis(clock.now()),
      lastError: { code: "ocr_failed", message: "retries exhausted" },
    })
    await adminDb().collection("jobs").doc(jobId).update({ ocrStatus: "running", ocrFailureCode: "ocr_failed" })

    await sweepLegacyOcr(deps)
    expect((await readJob(engineJobId)).status).toBe("dead_lettered")
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("failed")
    expect(legacy.get("ocrFailureCode")).toBe("ocr_failed")
    expect(await deps.dispatcher.drainDue(clock.now())).not.toContain("done")
    expect((await adminDb().collection("ocr_texts").where("documentId", "==", doc.docId).get()).empty).toBe(true)
  })

  it("FA-F04-008: over-cap text records truncated on the operation row and the result row", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const ch = "\u{FBAB}"
    const over = ch.repeat(310_000)
    const longDoc = await seedDoc({ firmId, matterId, classification: "internal", text: over })
    const longId = uniq("f04-trunc")
    const longRow = legacyRow({ id: longId, firmId, documentId: longDoc.docId, matterId, classification: "internal" })
    await writeLegacy(longRow)
    await onJobCreatedCore(longId, longRow, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const longLegacy = await adminDb().collection("jobs").doc(longId).get()
    const longText = await adminDb().collection("ocr_texts").doc(longLegacy.get("ocrResultId")).get()
    const longOp = await adminDb().collection("p1_ocr_operations").doc(deps.dispatcher.tasks[0]!.jobId).get()
    expect(longText.get("truncated")).toBe(true)
    expect(longOp.get("truncated")).toBe(true)
    expect(Buffer.byteLength(longText.get("text"), "utf8")).toBeLessThanOrEqual(900 * 1024)
    expect((longText.get("text") as string).length).toBeLessThan(over.length)

    const shortDoc = await seedDoc({ firmId, matterId, classification: "internal" })
    const shortId = uniq("f04-whole")
    const shortRow = legacyRow({ id: shortId, firmId, documentId: shortDoc.docId, matterId, classification: "internal" })
    await writeLegacy(shortRow)
    await onJobCreatedCore(shortId, shortRow, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toContain("done")
    const shortLegacy = await adminDb().collection("jobs").doc(shortId).get()
    const shortText = await adminDb().collection("ocr_texts").doc(shortLegacy.get("ocrResultId")).get()
    const shortEngine = deps.dispatcher.tasks.find((task) => task.jobId !== deps.dispatcher.tasks[0]!.jobId)
    const shortOp = await adminDb().collection("p1_ocr_operations").doc(shortEngine!.jobId).get()
    expect(shortText.get("truncated")).toBe(false)
    expect(shortText.get("text")).toBe(TEXT)
    expect(shortOp.get("truncated")).toBe(false)
  }, 60_000)

  it("FA-F04-009 O4: a stricter document label applied mid-job is the label on the published text", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-o4")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    ocrTestSeam.engine = {
      id: LOCAL_OCR_PROVIDER,
      extract: async () => {
        await adminDb().collection("documents").doc(doc.docId).update({ classification: "confidential" })
        return { text: TEXT, confidence: 1, lowConfidence: false, provider: LOCAL_OCR_PROVIDER }
      },
    }
    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const resultId = (await adminDb().collection("jobs").doc(jobId).get()).get("ocrResultId") as string
    expect((await adminDb().collection("ocr_texts").doc(resultId).get()).get("classification")).toBe("confidential")
  })

  it("FA-F04-009 O6: a stricter matter label applied mid-job is the label on the published text", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-o6")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    ocrTestSeam.engine = {
      id: LOCAL_OCR_PROVIDER,
      extract: async () => {
        await adminDb().collection("matters").doc(matterId).update({ classification: "privileged" })
        return { text: TEXT, confidence: 1, lowConfidence: false, provider: LOCAL_OCR_PROVIDER }
      },
    }
    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const resultId = (await adminDb().collection("jobs").doc(jobId).get()).get("ocrResultId") as string
    const result = await adminDb().collection("ocr_texts").doc(resultId).get()
    expect(result.get("classification")).toBe("privileged")
    expect((await adminDb().collection("documents").doc(doc.docId).get()).get("classification")).toBe("internal")
  })

  it("FA-F04-009 O11: the legacy row and the completion audit use the label re-checked at publish", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-o11")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    ocrTestSeam.engine = {
      id: LOCAL_OCR_PROVIDER,
      extract: async () => {
        await adminDb().collection("documents").doc(doc.docId).update({ classification: "confidential" })
        return { text: TEXT, confidence: 1, lowConfidence: false, provider: LOCAL_OCR_PROVIDER }
      },
    }
    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrClassification")).toBe("confidential")
    const resultId = legacy.get("ocrResultId") as string
    const audits = await adminDb().collection("audit_log").where("target", "==", `ocr_texts/${resultId}`).get()
    expect(audits.docs.some((entry) => entry.get("action") === "ocr.complete" && entry.get("classification") === "confidential")).toBe(true)
    expect(audits.docs.some((entry) => entry.get("action") === "ocr.complete" && entry.get("classification") === "internal")).toBe(false)
  })

  it("a label lowered mid-job does not publish the text under the lower label", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "confidential")
    const doc = await seedDoc({ firmId, matterId, classification: "confidential" })
    const jobId = uniq("f04-lower")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "confidential" })
    await writeLegacy(row)
    ocrTestSeam.engine = {
      id: LOCAL_OCR_PROVIDER,
      extract: async () => {
        await adminDb().collection("documents").doc(doc.docId).update({ classification: "internal" })
        await adminDb().collection("matters").doc(matterId).update({ classification: "internal" })
        return { text: TEXT, confidence: 1, lowConfidence: false, provider: LOCAL_OCR_PROVIDER }
      },
    }
    await onJobCreatedCore(jobId, row, deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrClassification")).toBe("confidential")
    expect((await adminDb().collection("ocr_texts").doc(legacy.get("ocrResultId")).get()).get("classification")).toBe("confidential")
  })

  it("FA-F04-012: the sweep drains a missed row after five hundred one cancelled or incomplete OCR rows sort earlier", async () => {
    const { sweepLegacyOcr } = await import("../src/p2/ocrSweep")
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const targetId = "f04-stuck-0502"
    const target = legacyRow({ id: targetId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    const badFirmIds: string[] = []
    for (let start = 1; start <= 501; start += 500) {
      const end = Math.min(start + 499, 501)
      for (let i = start; i <= end; i++) {
        const id = `f04-stuck-${String(i).padStart(4, "0")}`
        if (i % 3 === 0) {
          badFirmIds.push(id)
          await writeLegacy(i % 2 === 0 ? missingFirmLegacyFiller(id) : unsafeFirmLegacyFiller(id))
        } else if (i % 2 === 0) await writeCancelledLegacyStuck(id, firmId)
        else await writeLegacy(incompleteLegacyFiller(id, firmId))
      }
    }
    await writeLegacy(target)

    for (let pass = 0; pass < 3; pass++) {
      await sweepLegacyOcr(deps)
      if ((await adminDb().collection("jobs").doc(targetId).get()).get("ocrStatus") === "done") break
    }
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const legacy = await adminDb().collection("jobs").doc(targetId).get()
    expect(legacy.get("ocrStatus")).toBe("done")
    expect((await adminDb().collection("ocr_texts").doc(legacy.get("ocrResultId")).get()).get("text")).toBe(TEXT)
    for (const id of badFirmIds) {
      const row = await adminDb().collection("jobs").doc(id).get()
      expect(row.get("ocrStatus")).toBe("failed")
      expect(row.get("ocrFailureCode")).toBe("invalid_job")
    }
  }, 120_000)

  it("FA-F04-016: ocrStatus backfill reaches legacy rows after five hundred stamped OCR rows", async () => {
    const { backfillLegacyOcrStatusForSweep, legacyOcrStatusBackfillTestSeam } = await import("../src/p2/legacyOcrStatusBackfill")
    const { sweepLegacyOcr } = await import("../src/p2/ocrSweep")
    await adminDb().collection("system").doc("ocrStatusBackfill").delete()
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    for (let start = 1; start <= 501; start += 500) {
      const batch = adminDb().batch()
      const end = Math.min(start + 499, 501)
      for (let i = start; i <= end; i++) {
        const id = `f04-bf-${String(i).padStart(4, "0")}`
        batch.set(adminDb().collection("jobs").doc(id), stampedLegacyFiller(id, firmId))
      }
      await batch.commit()
    }
    const jobId = `zz-unstamped-${uniq("late")}`
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    delete row.ocrStatus
    await writeLegacy(row)

    for (let pass = 0; pass < 8; pass++) {
      await backfillLegacyOcrStatusForSweep()
      if ((await adminDb().collection("jobs").doc(jobId).get()).data()?.ocrStatus !== undefined) break
    }
    expect((await adminDb().collection("jobs").doc(jobId).get()).get("ocrStatus")).toBe("queued")
    await sweepLegacyOcr(deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    expect((await adminDb().collection("jobs").doc(jobId).get()).get("ocrStatus")).toBe("done")

    legacyOcrStatusBackfillTestSeam.queryPages = 0
    await backfillLegacyOcrStatusForSweep()
    expect(legacyOcrStatusBackfillTestSeam.queryPages).toBe(0)
  }, 120_000)

  it("FA-F04-013: the sweep drains a legacy row that predates ocrStatus on the upload row", async () => {
    const { backfillLegacyOcrStatusForSweep } = await import("../src/p2/legacyOcrStatusBackfill")
    const { sweepLegacyOcr } = await import("../src/p2/ocrSweep")
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = `f04-0000-unstamped-${uniq("x")}`
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    delete row.ocrStatus
    await writeLegacy(row)
    expect((await adminDb().collection("jobs").doc(jobId).get()).data()?.ocrStatus).toBeUndefined()

    await backfillLegacyOcrStatusForSweep()
    expect((await adminDb().collection("jobs").doc(jobId).get()).get("ocrStatus")).toBe("queued")
    await sweepLegacyOcr(deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("done")
    expect((await adminDb().collection("ocr_texts").doc(legacy.get("ocrResultId")).get()).get("text")).toBe(TEXT)
  })

  it("FA-F04-010: the sweep drains a missed row after five hundred one terminal OCR rows sort earlier", async () => {
    const { sweepLegacyOcr } = await import("../src/p2/ocrSweep")
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const targetId = "f04-pad-0502"
    const target = legacyRow({ id: targetId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    for (let start = 1; start <= 501; start += 500) {
      const batch = adminDb().batch()
      const end = Math.min(start + 499, 501)
      for (let i = start; i <= end; i++) {
        const id = `f04-pad-${String(i).padStart(4, "0")}`
        batch.set(adminDb().collection("jobs").doc(id), terminalLegacyFiller(id, firmId))
      }
      await batch.commit()
    }
    await writeLegacy(target)

    await sweepLegacyOcr(deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const legacy = await adminDb().collection("jobs").doc(targetId).get()
    expect(legacy.get("ocrStatus")).toBe("done")
    expect((await adminDb().collection("ocr_texts").doc(legacy.get("ocrResultId")).get()).get("text")).toBe(TEXT)
  }, 120_000)

  it("FA-F04-011: a retry after publish commits keeps the label stored on ocr_texts", async () => {
    const firmId = await firm()
    const matterId = await matter(firmId, "internal")
    const doc = await seedDoc({ firmId, matterId, classification: "internal" })
    const jobId = uniq("f04-011")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId, classification: "internal" })
    await writeLegacy(row)
    ocrTestSeam.engine = {
      id: LOCAL_OCR_PROVIDER,
      extract: async () => {
        await adminDb().collection("documents").doc(doc.docId).update({ classification: "confidential" })
        return { text: TEXT, confidence: 1, lowConfidence: false, provider: LOCAL_OCR_PROVIDER }
      },
    }
    let finishCommits = 0
    jobWorkerTestSeam.beforeCommit = async ({ fallback }) => {
      if (!fallback && finishCommits++ === 0) {
        throw Object.assign(new Error("seam: finish commit aborted after publish"), { code: 10 })
      }
    }

    await onJobCreatedCore(jobId, row, deps)
    const engineJobId = deps.dispatcher.tasks[0]!.jobId
    const task = { jobId: engineJobId, seq: 0 }
    await expect(deps.dispatcher.deliver(task)).rejects.toMatchObject({ code: 10 })

    const resultId = ocrTextId(firmId, doc.docId, doc.contentHash)
    expect((await adminDb().collection("ocr_texts").doc(resultId).get()).get("classification")).toBe("confidential")

    await adminDb().collection("documents").doc(doc.docId).update({ classification: "internal" })
    await adminDb().collection("matters").doc(matterId).update({ classification: "internal" })
    const engine = await readJob(engineJobId)
    expect(engine.lease?.owner).toBeTruthy()
    await jobsRef().doc(engineJobId).update({
      lease: { owner: engine.lease!.owner, expiresAt: Timestamp.fromMillis(clock.now() - 1) },
      sweepAt: Timestamp.fromMillis(clock.now()),
    })

    expect(await runJobTask(task, deps)).toBe("done")
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrClassification")).toBe("confidential")
    expect((await adminDb().collection("ocr_texts").doc(resultId).get()).get("classification")).toBe("confidential")
    const audits = await adminDb().collection("audit_log").where("target", "==", `ocr_texts/${resultId}`).get()
    expect(audits.docs.some((entry) => entry.get("action") === "ocr.complete" && entry.get("classification") === "confidential")).toBe(true)
  })

  const CANCEL_NOTE = "Cancelled: superseded by a newer request."

  it("FA-F04-015: cancelJob on a queued d3.ocr job closes the legacy upload row and writes allow audit", async () => {
    const { viaApi } = await import("./api")
    const { jobAuditRows } = await import("./jobs")
    const cancelApi = viaApi("cancelJob", { now: () => clock.now() })
    const firmId = await firm()
    const doc = await seedDoc({ firmId, matterId: null, classification: "internal" })
    const jobId = uniq("f04-cancel")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId: null, classification: "internal" })
    await writeLegacy(row)
    await onJobCreatedCore(jobId, row, deps)
    const engineJobId = deps.dispatcher.tasks[0]!.jobId
    const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
    const view = await cancelApi({ token: partner.token, data: { firmId, jobId: engineJobId, note: CANCEL_NOTE } } as never)
    expect(view).toMatchObject({ jobId: engineJobId, status: "cancelled" })
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("failed")
    expect(legacy.get("ocrFailureCode")).toBe("cancelled")
    expect((await jobAuditRows(engineJobId)).some((row) => row.decision === "allow" && row.action === "job.cancel")).toBe(true)
  })

  it("FA-F04-015: cancelJob leaves a legacy upload row that is already done unchanged", async () => {
    const { viaApi } = await import("./api")
    const cancelApi = viaApi("cancelJob", { now: () => clock.now() })
    const firmId = await firm()
    const doc = await seedDoc({ firmId, matterId: null, classification: "internal" })
    const jobId = uniq("f04-cancel-done")
    const row = legacyRow({ id: jobId, firmId, documentId: doc.docId, matterId: null, classification: "internal" })
    await writeLegacy(row)
    await onJobCreatedCore(jobId, row, deps)
    const engineJobId = deps.dispatcher.tasks[0]!.jobId
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["done"])
    const doneLegacy = await adminDb().collection("jobs").doc(jobId).get()
    const resultId = doneLegacy.get("ocrResultId")
    await jobsRef().doc(engineJobId).update({
      status: "queued",
      lease: null,
      nextAttemptAt: Timestamp.fromMillis(clock.now()),
      sweepAt: Timestamp.fromMillis(clock.now()),
      finishedAt: null,
      cancellation: null,
    })
    const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
    expect((await cancelApi({ token: partner.token, data: { firmId, jobId: engineJobId, note: CANCEL_NOTE } } as never)).status).toBe("cancelled")
    const legacy = await adminDb().collection("jobs").doc(jobId).get()
    expect(legacy.get("ocrStatus")).toBe("done")
    expect(legacy.get("ocrResultId")).toBe(resultId)
    expect(legacy.get("ocrFailureCode")).toBeNull()
  })
})
