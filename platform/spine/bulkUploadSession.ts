import type { Classification } from "@/platform/p1/types"

/** Per-file progress for one L9.1 bulk-upload session. */
export type BulkUploadFileState = "pending" | "uploading" | "deduped" | "finalised" | "failed"

/**
 * One file inside a bulk-upload session. Chunk bytes live in the object store
 * under `upload-staging/`, not on this row. `docId` is set once the file is
 * deduped against the vault or finalised through `uploadDocument`.
 */
export type BulkUploadFileRow = {
  /** Same firm as the session. A row without it is not a valid session file. */
  firmId: string
  name: string
  size: number
  sha256: string
  mimeType?: string
  classification: Classification
  state: BulkUploadFileState
  chunkCount: number
  receivedChunks: number[]
  docId?: string
}

/**
 * Runtime row for `upload_sessions`. Not an original document.
 * `storagePath` is the staging prefix, not a vault object.
 * `expiresAtMs` is the bounded lifecycle of that prefix.
 */
export type BulkUploadSessionRow = {
  id: string
  firmId: string
  matterId: string | null
  callerId: string
  storagePath: string
  createdAtMs: number
  expiresAtMs: number
  files: BulkUploadFileRow[]
}

/**
 * Runtime rows for `upload_sessions`, keyed by the store object.
 * Not a field on SpineStore: that file sits on the F41 line budget.
 */
const sessionsByStore = new WeakMap<object, Map<string, BulkUploadSessionRow>>()

export function uploadSessionsOf(store: object): Map<string, BulkUploadSessionRow> {
  let rows = sessionsByStore.get(store)
  if (!rows) {
    rows = new Map()
    sessionsByStore.set(store, rows)
  }
  return rows
}
