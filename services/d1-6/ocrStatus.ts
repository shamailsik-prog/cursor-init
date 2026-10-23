/** User-visible OCR progress for one document, derived from its legacy `ocr` jobs (audit F04). */

export type OcrProgress = "none" | "queued" | "running" | "done" | "failed"

export type OcrJobLike = { jobType: string; ocrStatus?: string | null }

/**
 * One status for the document's OCR jobs. A missing `ocrStatus` is queued: the upload writer
 * leaves it unset until the worker records progress. Any failure is shown ahead of a sibling
 * that is still running. All of them done is the only done.
 */
export function summarizeOcrJobs(jobs: readonly OcrJobLike[]): { ocrJobs: number; ocrStatus: OcrProgress } {
  const ocr = jobs.filter((job) => job.jobType === "ocr")
  if (ocr.length === 0) return { ocrJobs: 0, ocrStatus: "none" }
  const statuses = ocr.map((job) => job.ocrStatus)
  if (statuses.every((status) => status === "done")) return { ocrJobs: ocr.length, ocrStatus: "done" }
  if (statuses.some((status) => status === "failed")) return { ocrJobs: ocr.length, ocrStatus: "failed" }
  if (statuses.some((status) => status === "running")) return { ocrJobs: ocr.length, ocrStatus: "running" }
  return { ocrJobs: ocr.length, ocrStatus: "queued" }
}
