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
  // L18 §4.2: "a duplicate returns the existing docId" — scoped to the same firm AND matter
  // (loose vault is its own scope). R-2: a duplicate from another matter must never hand the
  // uploader that matter's record, so it becomes a new document in the uploader's own scope.
  const dedupKey = `${hash}|${input.matterId ?? "loose-vault"}`
  const existingId = store.docsByHash.get(dedupKey)
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
  // L17.3 monotonic propagation: the same bytes already held elsewhere in the firm keep their
  // highest label on the new copy ("privilege travels with the words"); nothing else of the
  // other record (id, matter, metadata) is exposed.
  let classification: Classification = input.classification
  for (const doc of store.documents.values()) {
    if (doc.firmId !== input.firmId || doc.contentHash !== hash) continue
    if (rankOfStoredOrMax(doc.classification) > rankOf(classification)) {
      classification = doc.classification
    }
  }
  const id = store.id("doc")
  store.documents.set(id, {
    id,
    firmId: input.firmId,
    matterId: input.matterId,
    contentHash: hash,
    sourceChannel: input.sourceChannel,
    classification,
  })
  store.docsByHash.set(dedupKey, id)
  store.jobs.push({
    id: store.id("job"),
    firmId: input.firmId,
    jobType: "ocr",
    documentId: id,
    classification,
    idempotencyKey: input.idempotencyKey,
  })
  return { docId: id, reused: false }
}

export function ocrJobsFor(store: SpineStore, docId: string) {
  return store.jobs.filter((j) => j.documentId === docId && j.jobType === "ocr")
}
