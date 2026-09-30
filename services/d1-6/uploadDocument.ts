import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import { rankOf, rankOfStoredOrMax, type SpineStore } from "@/platform/spine/store"

export function uploadDocument(
  store: SpineStore,
  input: {
    firmId: string
    matterId: string | null
    bytes: Buffer
    sourceChannel: "web" | "team_portal" | "whatsapp" | "bulk"
    classification: Classification
    idempotencyKey: string
  }
): { docId: string; reused: boolean } {
  if (!isClassification(input.classification)) {
    throw new PublicError("artefact write omitted classification")
  }
  const hash = store.hashKey(input.firmId, input.bytes)
  const existingId = store.docsByHash.get(hash)
  if (existingId) {
    const existing = store.documents.get(existingId)
    if (
      existing &&
      rankOf(input.classification) > rankOfStoredOrMax(existing.classification)
    ) {
      existing.classification = input.classification
      for (const job of store.jobs) {
        if (job.documentId === existingId) {
          job.classification = input.classification
        }
      }
    }
    return { docId: existingId, reused: true }
  }
  const id = store.id("doc")
  store.documents.set(id, {
    id,
    firmId: input.firmId,
    matterId: input.matterId,
    contentHash: hash,
    sourceChannel: input.sourceChannel,
    classification: input.classification,
  })
  store.docsByHash.set(hash, id)
  store.jobs.push({
    id: store.id("job"),
    firmId: input.firmId,
    jobType: "ocr",
    documentId: id,
    classification: input.classification,
    idempotencyKey: input.idempotencyKey,
  })
  return { docId: id, reused: false }
}

export function ocrJobsFor(store: SpineStore, docId: string) {
  return store.jobs.filter((j) => j.documentId === docId && j.jobType === "ocr")
}
