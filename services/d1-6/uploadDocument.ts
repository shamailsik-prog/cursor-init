import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import { putImmutableDocumentObject } from "@/platform/documents/documentObjectStore"
import { sniffMimeType } from "@/platform/documents/mimeSniff"
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
    /** The uploader's clearance; a same-scope duplicate above it is never reused (R2 N3). */
    callerClearance?: Classification
    uploadedBy: string
    mimeType?: string
  }
): Promise<{ docId: string; reused: boolean }> {
  return uploadDocumentAsync(store, input)
}

async function uploadDocumentAsync(
  store: SpineStore,
  input: {
    firmId: string
    matterId: string | null
    bytes: Buffer
    sourceChannel: "web" | "team_portal" | "whatsapp" | "bulk"
    classification: Classification
    idempotencyKey: string
    callerClearance?: Classification
    uploadedBy: string
    mimeType?: string
  }
): Promise<{ docId: string; reused: boolean }> {
  if (!isClassification(input.classification)) {
    throw new PublicError("artefact write omitted classification")
  }
  const hash = store.hashKey(input.firmId, input.bytes)
  const mimeType = input.mimeType ?? sniffMimeType(input.bytes)
  // L18 §4.2: "a duplicate returns the existing docId" — scoped to (firmId, matterId), the
  // loose vault being its own scope (E-30). R-2: a duplicate from another matter must never
  // hand the uploader that matter's record, so it becomes a new document in the caller's scope.
  const dedupKey = `${hash}|${input.matterId ?? "loose-vault"}`
  // Review R2 N3: within scope, reuse only a record the caller is cleared to read. Otherwise the
  // upload becomes a new document and the response reveals nothing about the existing one.
  const callerRank = input.callerClearance ? rankOf(input.callerClearance) : Number.POSITIVE_INFINITY
  const readable = (id: string | undefined) => {
    const doc = id ? store.documents.get(id) : undefined
    return doc && rankOfStoredOrMax(doc.classification) <= callerRank ? doc : undefined
  }
  let existing = readable(store.docsByHash.get(dedupKey))
  if (!existing && store.docsByHash.has(dedupKey)) {
    for (const doc of store.documents.values()) {
      if (
        doc.firmId === input.firmId &&
        doc.contentHash === hash &&
        (doc.matterId ?? null) === (input.matterId ?? null) &&
        readable(doc.id)
      ) {
        existing = doc
        break
      }
    }
  }
  if (existing) {
    const existingId = existing.id
    if (rankOf(input.classification) > rankOfStoredOrMax(existing.classification)) {
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
  const stored = await putImmutableDocumentObject({
    firmId: input.firmId,
    docId: id,
    bytes: input.bytes,
    contentHash: hash,
    mimeType,
  })
  store.documents.set(id, {
    id,
    firmId: input.firmId,
    matterId: input.matterId,
    contentHash: hash,
    sourceChannel: input.sourceChannel,
    classification,
    storagePath: stored.storagePath,
    isImmutable: true,
    byteSize: stored.byteSize,
    mimeType: stored.mimeType,
    objectVersion: stored.objectVersion,
    uploadedBy: input.uploadedBy,
  })
  if (!store.docsByHash.has(dedupKey)) store.docsByHash.set(dedupKey, id)
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
