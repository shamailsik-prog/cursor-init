import type { Classification } from "@/platform/p1/types"

/** Per-file progress for one L9.1 bulk-upload session. */
export type BulkUploadFileState = "pending" | "uploading" | "deduped" | "finalised" | "failed"

/**
 * One file inside a bulk-upload session. Chunk bytes live in the object store
 * under `upload-staging/`, not on this row. `docId` is set once the file is
 * deduped against the vault or finalised through `uploadDocument`.
 */
export type BulkUploadFileRow = {
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

/** Runtime row for `upload_sessions`. Not an original document. */
export type BulkUploadSessionRow = {
  id: string
  firmId: string
  matterId: string | null
  callerId: string
  files: BulkUploadFileRow[]
}
