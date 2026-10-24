import type { DocumentData } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { HttpError } from "../http/errors"
import { aggregateClassification } from "../p1/ocrAggregate"
import type { JobDeps } from "./dispatch"
import { enqueueJob, jobIdFor } from "./enqueue"
import { JobError } from "./errors"
import { isCompleteLegacyOcrJob, loadOcrSubject, OCR_JOB_TYPE, OCR_PAYLOAD_VERSION, recordLegacyOcr } from "./ocrJob"

/**
 * Test-only. The next enqueue throws once, then the flag clears. Ignored when NODE_ENV is production.
 * FA-F04-001 uses it to prove a failed handoff is not acknowledged.
 */
export const ocrDrainTestSeam: { failEnqueueOnce?: boolean } = {}

function drainSeamAllows(): boolean {
  return process.env.NODE_ENV !== "production"
}

/**
 * Turns one legacy queued OCR row into a P2 `d3.ocr` job and dispatches it (audit F04).
 * A row the upload writer did not finish is ignored. A row already marked done is not drained again.
 * A permanent problem with the document is recorded on the legacy row and is not enqueued.
 */
export async function acceptLegacyOcrJob(jobId: string, data: DocumentData | undefined, deps: JobDeps): Promise<void> {
  if (!isCompleteLegacyOcrJob(data) || data === undefined) return
  if (data.ocrStatus === "done" && typeof data.ocrResultId === "string") return

  const firmId = data.firmId as string
  const documentId = data.documentId as string
  const matterId = data.matterId as string | null
  const classification = data.classification as Classification

  let subject
  try {
    subject = await loadOcrSubject(firmId, matterId, documentId)
  } catch (err) {
    // FA-F04-002: only a permanent JobError is recorded and acknowledged. A retryable one
    // (a transient object-store read) is rethrown so the create trigger runs the drain again.
    if (err instanceof JobError && err.permanent) {
      await recordLegacyOcr(jobId, firmId, { ocrStatus: "failed", ocrFailureCode: err.code })
      return
    }
    throw err
  }

  const labels: Classification[] = [classification, subject.documentClassification]
  if (subject.matterClassification !== null) labels.push(subject.matterClassification)
  const aggregate = aggregateClassification(labels)
  const spec = {
    firmId,
    jobType: OCR_JOB_TYPE,
    classification: aggregate,
    matterId,
    payload: {
      version: OCR_PAYLOAD_VERSION,
      legacyJobId: jobId,
      documentId,
      contentHash: subject.contentHash,
    },
    inputRefs: matterId === null ? [] : [`documents/${documentId}`],
    idempotencyKey: jobId,
    createdBy: "system" as const,
  }

  if (drainSeamAllows() && ocrDrainTestSeam.failEnqueueOnce) {
    ocrDrainTestSeam.failEnqueueOnce = false
    throw new Error("ocr_drain_unavailable")
  }

  let engineJobId: string
  try {
    const result = await adminDb().runTransaction((tx) => enqueueJob(tx, spec, { now: deps.clock() }))
    engineJobId = result.jobId
  } catch (err) {
    if (err instanceof HttpError && err.code === "job_key_conflict") {
      await deps.dispatcher.dispatch({ jobId: jobIdFor(firmId, OCR_JOB_TYPE, jobId), seq: 0 })
      return
    }
    throw err
  }

  await recordLegacyOcr(jobId, firmId, { ocrStatus: "queued" })
  await deps.dispatcher.dispatch({ jobId: engineJobId, seq: 0 })
}
