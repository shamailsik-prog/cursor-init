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
  return {
    storagePath: overrides.storagePath ?? `r2://${core.firmId}/documents/${core.id}/v1`,
    isImmutable: overrides.isImmutable ?? false,
    byteSize: overrides.byteSize ?? 0,
    mimeType: overrides.mimeType ?? "application/octet-stream",
    objectVersion: overrides.objectVersion ?? 1,
    uploadedBy: overrides.uploadedBy ?? "partner_a",
    ...core,
    ...overrides,
  }
}
