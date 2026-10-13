import type { DocumentRecord } from "@/platform/spine/store"

type DocumentCore = Pick<
  DocumentRecord,
  "id" | "firmId" | "matterId" | "contentHash" | "sourceChannel" | "classification"
>

/** Metadata-only fixtures that do not need real object bytes. */
export function stubDocumentObject(
  core: DocumentCore,
  overrides: Partial<DocumentRecord> = {}
): DocumentRecord {
  const storagePath =
    overrides.storagePath ??
    (overrides.objectBytesStatus === "missing" ? "" : `fs://${core.firmId}/documents/${core.id}/v1`)
  const objectBytesStatus =
    overrides.objectBytesStatus ?? (storagePath ? "available" : "missing")
  return {
    ...core,
    ...overrides,
    storagePath,
    isImmutable: overrides.isImmutable ?? false,
    byteSize: overrides.byteSize ?? 0,
    mimeType: overrides.mimeType ?? "application/octet-stream",
    objectVersion: overrides.objectVersion ?? 1,
    uploadedBy: overrides.uploadedBy ?? "partner_a",
    objectBytesStatus,
  }
}
