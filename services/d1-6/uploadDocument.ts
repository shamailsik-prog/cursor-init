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
  // L18 §4.2: "a duplicate returns the existing docId" — scoped to (firmId, matterId), the
  // loose vault being its own scope (E-30). R-2: a duplicate from another matter must never
  // hand the uploader that matter's record, so it becomes a new document in the caller's scope.
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
  // Review R1 #3 / erratum E-30 (§4.2 vs R-2 resolved for isolation): the label is
  // max(caller label, matter floor). Copies of the same bytes in other matters are never
  // consulted — doing so turned the §4.2 dedup key into a cross-matter existence oracle.
  let classification: Classification = input.classification
  const matter = input.matterId ? store.matters.get(input.matterId) : undefined
  if (matter && rankOfStoredOrMax(matter.classification) > rankOf(classification)) {
    classification = isClassification(matter.classification)
      ? matter.classification
      : "privileged-restricted"
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
    matterId: input.matterId,
    classification,
    idempotencyKey: input.idempotencyKey,
  })
  return { docId: id, reused: false }
}

export function ocrJobsFor(store: SpineStore, docId: string) {
  return store.jobs.filter((j) => j.documentId === docId && j.jobType === "ocr")
}
