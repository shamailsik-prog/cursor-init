import { getImmutableDocumentObject } from "@/platform/documents/documentObjectStore"
import type { SpineStore } from "@/platform/spine/store"

export type DocumentRow = {
  id: string
  firmId: string
  storagePath: string
  contentHash: string
  objectBytesStatus?: string
}

export type ObjectIssue = { rowId: string; kind: "missing" | "digest_mismatch" | "unreadable" | "skipped_non_s3" | "available_flag_missing" }
export type ObjectReport = { issues: ObjectIssue[]; clean: boolean }

export async function verifyDocumentObjects(opts: {
  rows: DocumentRow[]
  store: SpineStore
  productionMode?: boolean
}): Promise<ObjectReport> {
  const issues: ObjectIssue[] = []
  for (const row of opts.rows) {
    if (row.objectBytesStatus === "missing") {
      issues.push({ rowId: row.id, kind: "available_flag_missing" })
      continue
    }
    if (!row.storagePath.startsWith("s3://")) {
      if (opts.productionMode) issues.push({ rowId: row.id, kind: "skipped_non_s3" })
      continue
    }
    try {
      const bytes = await getImmutableDocumentObject(opts.store, row.firmId, row.storagePath, row.contentHash)
      if (!bytes?.length) issues.push({ rowId: row.id, kind: "missing" })
    } catch (err) {
      const msg = String((err as Error).message ?? err)
      if (msg.includes("digest") || msg.includes("hash")) issues.push({ rowId: row.id, kind: "digest_mismatch" })
      else issues.push({ rowId: row.id, kind: "unreadable" })
    }
  }
  return { issues, clean: issues.length === 0 }
}
