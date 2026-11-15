import type { DOCKET_GENERATOR_FLAG } from "@/layers/L5_5_DocketGenerator/flag"

/**
 * Same fields as FilingAnnexureManifestItem in platform/spine/store.ts.
 * The layer does not import the spine. A test assigns this shape to that type.
 */
export type DocketAnnexureMetadata = {
  artifactId: string
  label: string
  required: boolean
  status: "pending" | "ready" | "blocked"
  sourceRef: string | null
  note?: string
}

export type DocketAnnexure = {
  metadata: DocketAnnexureMetadata
  /** In-memory text of the annexure. Nothing is read from a store. */
  body: string
  /**
   * 1-based position. Omit on every annexure to keep the array order.
   * A partial or conflicting set is queued; the array is not reordered.
   */
  order?: number
  /**
   * Series token already chosen by a person, such as "A" or "P/1".
   * Omit to auto-number only when the annexure rule states one series.
   */
  assignedLabel?: string
}

export type DocketPageSizeName = "legal" | "a4"

export type DocketFilingSet = {
  documentTypeId: string
  /** The document type's annexureRule text. The generator does not look the type up. */
  annexureRule: string
  /**
   * Set only when the annexure rule says the page size is per forum and a
   * person has already chosen legal or A4. Contradicting a stated size is queued.
   */
  forumPageSize?: DocketPageSizeName
  draft: { body: string }
  annexures: DocketAnnexure[]
}

export type AmbiguityCode = "order_unresolved" | "label_unresolved" | "ref_unresolved"

export type AmbiguityItem = {
  code: AmbiguityCode
  artifactId: string | null
  detail: string
}

export type DocketIndexEntry = {
  label: string
  description: string
  physicalPage: number
  printedPage: number
}

export type GenerateDocketResult = {
  flag: typeof DOCKET_GENERATOR_FLAG
  enabled: boolean
  ok: boolean
  queue: AmbiguityItem[]
  pdf: Uint8Array | null
  docx: Uint8Array | null
  pageCount: number | null
  index: DocketIndexEntry[] | null
}
