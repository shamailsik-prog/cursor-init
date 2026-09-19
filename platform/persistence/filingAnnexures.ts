import type {
  FilingAnnexureGenerationStatus,
  FilingAnnexureRow,
  FilingDispatchQueueRow,
  FilingPackage,
} from "@/platform/spine/store"

export function filingAnnexureId(packageId: string): string {
  return `annexure:${packageId}`
}

export function isFilingAnnexureGenerationStatus(
  value: string | null
): value is FilingAnnexureGenerationStatus {
  return value === "pending" || value === "assembling" || value === "ready" || value === "blocked"
}

export function buildFilingAnnexureRow(
  filingPackage: FilingPackage,
  dispatchQueue: FilingDispatchQueueRow | null,
  opts?: { now?: number }
): FilingAnnexureRow {
  const now = opts?.now ?? Date.now()
  const citationNote =
    filingPackage.citationStatus === "OK" ? undefined : "citation gate is not fully satisfied"
  const approvalNote = filingPackage.approvedBy ? undefined : "partner approver is missing"
  const dispatchReady = dispatchQueue ? dispatchQueue.status !== "blocked" : false
  return {
    id: filingAnnexureId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    generationStatus: dispatchReady ? "pending" : "blocked",
    manifest: [
      {
        artifactId: "annexure_draft_pdf",
        label: "Final draft PDF",
        required: true,
        status: "ready",
        sourceRef: filingPackage.draftId,
      },
      {
        artifactId: "annexure_citation_packet",
        label: "Citation packet",
        required: true,
        status: filingPackage.citationStatus === "OK" ? "ready" : "blocked",
        sourceRef: filingPackage.id,
        ...(citationNote ? { note: citationNote } : {}),
      },
      {
        artifactId: "annexure_approval_memo",
        label: "Partner approval memo",
        required: true,
        status: filingPackage.approvedBy ? "ready" : "blocked",
        sourceRef: filingPackage.approvedBy,
        ...(approvalNote ? { note: approvalNote } : {}),
      },
    ],
    signerRequirements: {
      partnerSignoffBy: null,
      partnerSignoffAt: null,
      clerkVerificationBy: null,
      clerkVerificationAt: null,
    },
    operatorNotes: dispatchReady
      ? ["annexure packaging initialized from approved dispatch queue row"]
      : ["annexure packaging blocked until dispatch queue is handoff-ready"],
    submissionTransportBoundary: "todo_firm_external_transport_blocked",
    updatedAt: now,
  }
}

export function annexureReadyForTransport(row: FilingAnnexureRow): boolean {
  const requiredReady = row.manifest
    .filter((item) => item.required)
    .every((item) => item.status === "ready")
  return (
    requiredReady &&
    Boolean(row.signerRequirements.partnerSignoffBy) &&
    Boolean(row.signerRequirements.clerkVerificationBy)
  )
}
