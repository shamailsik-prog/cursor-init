import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { getImmutableDocumentObject } from "@/platform/documents/documentObjectStore"
import { newStore } from "@/platform/spine/store"
import { adminDb } from "../admin"
import { callP1Ocr, OcrAdmissionError, ocrTextId } from "../p1/ocrCall"
import { aggregateClassification } from "../p1/ocrAggregate"
import { stageAudit } from "../p5/audit"
import { isKnownClassification, rankOf } from "../p5/classification"
import { isSafeDocId } from "../p5/common"
import { JOB_ENGINE, MAX_ATTEMPTS } from "./constants"
import { JobError } from "./errors"
import type { JobContext, JobHandler, JobResult } from "./registry"

export { aggregateClassification }

/** Versioned OCR payload (audit F04). Version 1 is the only one this handler accepts. */
export const OCR_PAYLOAD_VERSION = 1

/** P2 job type. The legacy upload row stays `jobType: "ocr"`; this is the engine job that drains it. */
export const OCR_JOB_TYPE = "d3.ocr"

const CONTENT_HASH = /^[0-9a-f]{64}$/
const PAYLOAD_KEYS = new Set(["version", "legacyJobId", "documentId", "contentHash"])

export type OcrPayload = {
  version: 1
  legacyJobId: string
  documentId: string
  contentHash: string
}

export type OcrSubject = {
  documentClassification: Classification
  matterClassification: Classification | null
  contentHash: string
  mimeType: string
  bytes: Buffer
}

export type LegacyOcrPatch = {
  ocrStatus?: "queued" | "running" | "done" | "failed"
  ocrResultId?: string
  ocrFailureCode?: string | null
  ocrClassification?: Classification
}

/**
 * The upload writer's row: no `engine` field, jobType `ocr`, and the identity fields the drain can act on.
 * An incomplete row (the bare `{ jobType: "ocr" }` the dispatch test uses) is not a job this worker drains.
 */
export function isCompleteLegacyOcrJob(data: DocumentData | undefined): boolean {
  if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) return false
  if (Object.hasOwn(data, "engine")) return false
  if (data.jobType !== "ocr") return false
  if (!isSafeDocId(data.firmId) || !isSafeDocId(data.documentId)) return false
  if (!(data.matterId === null || isSafeDocId(data.matterId))) return false
  if (!isKnownClassification(data.classification)) return false
  const key = data.idempotencyKey
  return typeof key === "string" && key.length >= 1 && key.length <= 512
}

function permanent(code: string): JobError {
  return new JobError(code, { permanent: true })
}

/**
 * Loads the document the legacy row names, then its bytes.
 * The firm is checked before the matter and before any byte read. A hash that does not match the
 * stored object is `object_tampered`; a missing or unreadable object is `object_unavailable`.
 */
export async function loadOcrSubject(
  firmId: string,
  matterId: string | null,
  documentId: string,
  expectedHash?: string
): Promise<OcrSubject> {
  const docSnap = await adminDb().collection("documents").doc(documentId).get()
  if (!docSnap.exists) throw permanent("document_missing")
  const doc = docSnap.data() ?? {}
  if (doc.firmId !== firmId) throw permanent("cross_firm")
  const docMatter = doc.matterId === undefined ? undefined : (doc.matterId as unknown)
  if (docMatter !== matterId) throw permanent("matter_mismatch")
  if (!isKnownClassification(doc.classification)) throw permanent("invalid_document")

  let matterClassification: Classification | null = null
  if (matterId !== null) {
    const matterSnap = await adminDb().collection("matters").doc(matterId).get()
    if (!matterSnap.exists) throw permanent("matter_missing")
    const matter = matterSnap.data() ?? {}
    if (matter.firmId !== firmId) throw permanent("cross_firm")
    if (!isKnownClassification(matter.classification)) throw permanent("invalid_document")
    matterClassification = matter.classification
  }

  const contentHash = doc.contentHash
  if (typeof contentHash !== "string" || !CONTENT_HASH.test(contentHash)) throw permanent("invalid_document")
  if (expectedHash !== undefined && expectedHash !== contentHash) throw permanent("invalid_document")

  const storagePath = doc.storagePath
  if (doc.objectBytesStatus !== "available" || typeof storagePath !== "string" || storagePath.length === 0) {
    throw permanent("object_unavailable")
  }

  let bytes: Buffer
  try {
    bytes = await getImmutableDocumentObject(newStore(), firmId, storagePath, contentHash)
  } catch (err) {
    const message = err instanceof Error ? err.message : ""
    if (message.includes("integrity") || message.includes("hash mismatch")) throw permanent("object_tampered")
    throw permanent("object_unavailable")
  }
  if (bytes.length === 0) throw permanent("empty_object")

  const mimeType = typeof doc.mimeType === "string" && doc.mimeType.length > 0 ? doc.mimeType : "application/octet-stream"
  return {
    documentClassification: doc.classification,
    matterClassification,
    contentHash,
    mimeType,
    bytes,
  }
}

/**
 * Records user-visible progress on the legacy `ocr` row. A finished row stays finished.
 * `queued` does not replace `running` or `failed`. Fields left out of `patch` are not written.
 */
export async function recordLegacyOcr(jobId: string, firmId: string, patch: LegacyOcrPatch): Promise<void> {
  const ref = adminDb().collection("jobs").doc(jobId)
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return
    const data = snap.data() ?? {}
    if (data.firmId !== firmId || data.engine === JOB_ENGINE) return
    if (data.ocrStatus === "done") return
    const update: Record<string, unknown> = {}
    if (patch.ocrStatus !== undefined) {
      const current = data.ocrStatus
      const hold = patch.ocrStatus === "queued" && (current === "running" || current === "failed")
      if (!hold) update.ocrStatus = patch.ocrStatus
    }
    if (patch.ocrResultId !== undefined) update.ocrResultId = patch.ocrResultId
    if (patch.ocrFailureCode !== undefined) update.ocrFailureCode = patch.ocrFailureCode
    if (patch.ocrClassification !== undefined) update.ocrClassification = patch.ocrClassification
    if (Object.keys(update).length === 0) return
    tx.update(ref, update)
  })
}

function parse(payload: unknown): OcrPayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw permanent("invalid_payload")
  const raw = payload as Record<string, unknown>
  const keys = Object.keys(raw)
  if (keys.length !== PAYLOAD_KEYS.size || keys.some((key) => !PAYLOAD_KEYS.has(key))) throw permanent("invalid_payload")
  const { version, legacyJobId, documentId, contentHash } = raw
  if (version !== OCR_PAYLOAD_VERSION) throw permanent("invalid_payload")
  if (!isSafeDocId(legacyJobId) || !isSafeDocId(documentId)) throw permanent("invalid_payload")
  if (typeof contentHash !== "string" || !CONTENT_HASH.test(contentHash)) throw permanent("invalid_payload")
  return { version: OCR_PAYLOAD_VERSION, legacyJobId, documentId, contentHash }
}

async function run(ctx: JobContext<OcrPayload>): Promise<JobResult> {
  const subject = await loadOcrSubject(ctx.job.firmId, ctx.job.matterId, ctx.payload.documentId, ctx.payload.contentHash)
  const labels: Classification[] = [ctx.job.classification, subject.documentClassification]
  if (subject.matterClassification !== null) labels.push(subject.matterClassification)
  const aggregate = aggregateClassification(labels)

  let admitted
  try {
    admitted = await callP1Ocr({
      firmId: ctx.job.firmId,
      actorId: "system",
      matterId: ctx.job.matterId,
      jobId: ctx.job.id,
      operationId: ctx.job.id,
      legacyJobId: ctx.payload.legacyJobId,
      documentId: ctx.payload.documentId,
      contentHash: subject.contentHash,
      classification: aggregate,
      sources: labels,
      bytes: subject.bytes,
      mimeType: subject.mimeType,
      now: () => ctx.now(),
    })
  } catch (err) {
    if (err instanceof OcrAdmissionError) {
      if (err.code === "classification_below_source") throw permanent("classification_mismatch")
      throw permanent("invalid_document")
    }
    throw err
  }

  if (admitted.outcome === "blocked") {
    const code = admitted.blockReason === "provider_unsupported" ? "provider_unsupported" : "ocr_blocked"
    await recordLegacyOcr(ctx.payload.legacyJobId, ctx.job.firmId, { ocrStatus: "failed", ocrFailureCode: code })
    throw permanent(code)
  }
  if (admitted.outcome !== "ok") {
    const code = admitted.failureCode === "ocr_timeout" ? "ocr_timeout" : "ocr_failed"
    const terminal = ctx.job.attempt >= MAX_ATTEMPTS
    await recordLegacyOcr(ctx.payload.legacyJobId, ctx.job.firmId, {
      ocrStatus: terminal ? "failed" : "running",
      ocrFailureCode: code,
    })
    throw new JobError(code)
  }

  const text = admitted.text ?? ""
  const resultId = ocrTextId(ctx.job.firmId, ctx.payload.documentId, subject.contentHash)
  const legacyRef = adminDb().collection("jobs").doc(ctx.payload.legacyJobId)
  const textRef = adminDb().collection("ocr_texts").doc(resultId)
  const at = Timestamp.fromMillis(ctx.now())
  const done = {
    ocrStatus: "done" as const,
    ocrResultId: resultId,
    ocrFailureCode: null,
    ocrClassification: aggregate,
  }

  await ctx.runFenced("publish", async (tx) => {
    const existing = await tx.get(textRef)
    const legacy = await tx.get(legacyRef)
    if (!existing.exists) {
      tx.create(textRef, {
        firmId: ctx.job.firmId,
        documentId: ctx.payload.documentId,
        matterId: ctx.job.matterId,
        classification: aggregate,
        contentHash: subject.contentHash,
        text,
        provider: admitted.provider,
        confidence: admitted.confidence,
        lowConfidence: admitted.lowConfidence === true,
        legacyJobId: ctx.payload.legacyJobId,
        jobId: ctx.job.id,
        mimeType: subject.mimeType,
        createdAt: at,
        updatedAt: at,
      })
    } else {
      const stored = existing.get("classification")
      if (isKnownClassification(stored) && rankOf(stored) < rankOf(aggregate)) {
        tx.update(textRef, { classification: aggregate, updatedAt: at })
      }
    }
    stageAudit(
      {
        firmId: ctx.job.firmId,
        actorId: "system",
        action: "ocr.complete",
        target: `ocr_texts/${resultId}`,
        classification: aggregate,
        decision: "allow",
        reason: "ok",
      },
      tx
    )
    if (legacy.exists && legacy.get("firmId") === ctx.job.firmId && legacy.get("engine") !== JOB_ENGINE) {
      tx.update(legacyRef, done)
    }
  })

  return {
    outputRefs: ctx.job.matterId === null ? [] : [`ocr_texts/${resultId}`],
    apply(tx) {
      tx.update(legacyRef, done)
    },
  }
}

export const ocrHandler: JobHandler<OcrPayload> = {
  jobType: OCR_JOB_TYPE,
  saga: false,
  errorCodes: {
    cross_firm: "The OCR job names another firm's document.",
    document_missing: "The document for this OCR job does not exist.",
    matter_missing: "The matter for this OCR job does not exist.",
    matter_mismatch: "The OCR job's matter does not match the document.",
    invalid_document: "The document for this OCR job is not readable.",
    object_unavailable: "The document's bytes are not available for OCR.",
    object_tampered: "The document's bytes do not match its stored hash.",
    empty_object: "The document has no bytes to read.",
    ocr_blocked: "OCR was blocked by P1 before any extraction.",
    provider_unsupported: "The configured OCR provider is not available.",
    ocr_timeout: "OCR exceeded its time limit.",
    ocr_failed: "OCR failed.",
    classification_mismatch: "The OCR call's classification is below a source.",
  },
  parse,
  run,
}
