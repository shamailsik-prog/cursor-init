import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import {
  deleteDocumentObject,
  getImmutableDocumentObject,
  putImmutableDocumentObject,
  unremovedObjectPathOf,
  type DocumentObjectPutInput,
  type DocumentObjectPutResult,
} from "@/platform/documents/documentObjectStore"
import { sniffMimeType } from "@/platform/documents/mimeSniff"
import { rankOf, rankOfStoredOrMax, type DocumentRecord, type SpineStore } from "@/platform/spine/store"

export function uploadDocument(
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
  return uploadDocumentAsync(store, input)
}

/**
 * Writes the object; if the write landed but did not verify and the store could not remove it
 * (FA-D16-003), the delete is retried here before the error propagates, so no unverified object
 * stays addressable even though the caller never received a storagePath.
 */
async function putObjectOrDiscard(input: DocumentObjectPutInput): Promise<DocumentObjectPutResult> {
  try {
    return await putImmutableDocumentObject(input)
  } catch (err) {
    const leftover = unremovedObjectPathOf(err)
    if (leftover) await deleteDocumentObject(leftover)
    throw err
  }
}

/**
 * Whether the row's object can be read back and verified now. The recorded objectBytesStatus is
 * not trusted either way: a row marked "missing" after a transient read failure (a network
 * backend such as R2) still has its object, and the immutable key would refuse a rewrite. A row
 * without a storagePath (legacy metadata only) fails the read as a malformed path.
 */
async function storedObjectVerifies(store: SpineStore, doc: DocumentRecord): Promise<boolean> {
  try {
    await getImmutableDocumentObject(store, doc.firmId, doc.storagePath, doc.contentHash)
  } catch {
    return false
  }
  return true
}

/**
 * Writes the bytes of an existing row whose object did not verify. If an unverifiable object
 * still holds the key (tampered or corrupt), the immutable write is refused and it is preserved.
 */
async function ensureObjectBytes(
  store: SpineStore,
  doc: DocumentRecord,
  bytes: Buffer,
  contentHash: string,
  mimeType: string
): Promise<void> {
  const stored = await putObjectOrDiscard({
    store,
    firmId: doc.firmId,
    docId: doc.id,
    bytes,
    contentHash,
    mimeType,
  })
  doc.storagePath = stored.storagePath
  doc.isImmutable = true
  doc.byteSize = stored.byteSize
  doc.mimeType = stored.mimeType
  doc.objectVersion = stored.objectVersion
  doc.objectBytesStatus = "available"
}

async function commitNewDocumentIngest(
  store: SpineStore,
  input: {
    firmId: string
    matterId: string | null
    bytes: Buffer
    hash: string
    mimeType: string
    classification: Classification
    sourceChannel: DocumentRecord["sourceChannel"]
    idempotencyKey: string
    uploadedBy: string
    dedupKey: string
  }
): Promise<string> {
  const id = store.id("doc")
  let storagePath: string | undefined
  try {
    const stored = await putObjectOrDiscard({
      store,
      firmId: input.firmId,
      docId: id,
      bytes: input.bytes,
      contentHash: input.hash,
      mimeType: input.mimeType,
    })
    storagePath = stored.storagePath
    store.documents.set(id, {
      id,
      firmId: input.firmId,
      matterId: input.matterId,
      contentHash: input.hash,
      sourceChannel: input.sourceChannel,
      classification: input.classification,
      storagePath: stored.storagePath,
      isImmutable: true,
      byteSize: stored.byteSize,
      mimeType: stored.mimeType,
      objectVersion: stored.objectVersion,
      uploadedBy: input.uploadedBy,
      objectBytesStatus: "available",
    })
    store.jobs.push({
      id: store.id("job"),
      firmId: input.firmId,
      jobType: "ocr",
      documentId: id,
      matterId: input.matterId,
      classification: input.classification,
      idempotencyKey: input.idempotencyKey,
    })
    if (!store.docsByHash.has(input.dedupKey)) store.docsByHash.set(input.dedupKey, id)
    return id
  } catch (err) {
    if (storagePath) await deleteDocumentObject(storagePath)
    store.documents.delete(id)
    store.jobs = store.jobs.filter((job) => job.documentId !== id)
    throw err
  }
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
  const dedupKey = `${hash}|${input.matterId ?? "loose-vault"}`
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
    if (await storedObjectVerifies(store, existing)) {
      existing.objectBytesStatus = "available"
    } else {
      existing.objectBytesStatus = "missing"
      await ensureObjectBytes(store, existing, input.bytes, hash, mimeType)
    }
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
  let classification: Classification = input.classification
  const matter = input.matterId ? store.matters.get(input.matterId) : undefined
  if (matter && rankOfStoredOrMax(matter.classification) > rankOf(classification)) {
    classification = isClassification(matter.classification)
      ? matter.classification
      : "privileged-restricted"
  }
  const id = await commitNewDocumentIngest(store, {
    firmId: input.firmId,
    matterId: input.matterId,
    bytes: input.bytes,
    hash,
    mimeType,
    classification,
    sourceChannel: input.sourceChannel,
    idempotencyKey: input.idempotencyKey,
    uploadedBy: input.uploadedBy,
    dedupKey,
  })
  return { docId: id, reused: false }
}

export function rollbackDocumentIngest(store: SpineStore, docId: string): Promise<void> {
  const doc = store.documents.get(docId)
  if (!doc) return Promise.resolve()
  const storagePath = doc.storagePath
  store.documents.delete(docId)
  store.jobs = store.jobs.filter((job) => job.documentId !== docId)
  for (const [key, id] of store.docsByHash.entries()) {
    if (id === docId) store.docsByHash.delete(key)
  }
  return storagePath ? deleteDocumentObject(storagePath) : Promise.resolve()
}

export function ocrJobsFor(store: SpineStore, docId: string) {
  return store.jobs.filter((j) => j.documentId === docId && j.jobType === "ocr")
}
