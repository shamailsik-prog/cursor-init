import type {
  DraftRecord,
  FilingPackage,
  FilingPacketArtifactRow,
} from "@/platform/spine/store"

export function filingPacketArtifactId(packageId: string): string {
  return `packet:${packageId}`
}

export function buildFilingPacketArtifactRow(
  filingPackage: FilingPackage,
  draft: DraftRecord | null,
  opts?: { now?: number }
): FilingPacketArtifactRow {
  const draftNote = draft ? undefined : "draft record not found"
  const citationNote =
    filingPackage.citationStatus === "OK" ? undefined : "citation gate is overruled"
  const temporalNote =
    filingPackage.temporalAllOk ? undefined : "temporal gate has mismatch"
  const approvalNote =
    filingPackage.status === "approved"
      ? filingPackage.approvedBy
        ? undefined
        : "approved package missing approver"
      : "package not approved"
  const components = [
    {
      componentId: "draft_body",
      label: "Draft body",
      required: true,
      status: draft ? ("ready" as const) : ("missing" as const),
      sourceRef: draft?.id ?? null,
      ...(draftNote ? { note: draftNote } : {}),
    },
    {
      componentId: "citation_gate",
      label: "Citation gate",
      required: true,
      status:
        filingPackage.citationStatus === "OK" ? ("ready" as const) : ("missing" as const),
      sourceRef: filingPackage.id,
      ...(citationNote ? { note: citationNote } : {}),
    },
    {
      componentId: "temporal_gate",
      label: "Temporal gate",
      required: true,
      status: filingPackage.temporalAllOk ? ("ready" as const) : ("missing" as const),
      sourceRef: filingPackage.id,
      ...(temporalNote ? { note: temporalNote } : {}),
    },
    {
      componentId: "partner_approval",
      label: "Partner approval",
      required: true,
      status:
        filingPackage.status === "approved" && filingPackage.approvedBy
          ? ("ready" as const)
          : ("missing" as const),
      sourceRef: filingPackage.approvedBy,
      ...(approvalNote ? { note: approvalNote } : {}),
    },
  ]

  const blockedReasons: string[] = []
  if (filingPackage.status !== "approved") {
    blockedReasons.push(
      filingPackage.status === "rejected"
        ? "filing_package_rejected"
        : "partner_approval_pending"
    )
  }
  if (!draft) {
    blockedReasons.push("draft_record_missing")
  }
  if (filingPackage.citationStatus !== "OK") {
    blockedReasons.push("citation_gate_blocked")
  }
  if (!filingPackage.temporalAllOk) {
    blockedReasons.push("temporal_gate_blocked")
  }
  if (filingPackage.status === "approved" && !filingPackage.approvedBy) {
    blockedReasons.push("approver_missing")
  }

  return {
    id: filingPacketArtifactId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    draftId: filingPackage.draftId,
    classification: filingPackage.classification,
    readiness: blockedReasons.length === 0 ? "ready" : "blocked",
    blockedReasons,
    components,
    updatedAt: opts?.now ?? Date.now(),
  }
}
