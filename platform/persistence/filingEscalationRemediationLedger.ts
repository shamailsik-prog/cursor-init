import type {
  FilingEscalationVarianceRemediationDecision,
  FilingEscalationVarianceRemediationRow,
  FilingEscalationVarianceRemediationStatus,
  FilingEscalationWaiverRolloverAttestationRow,
  FilingEscalationWaiverRolloverStatus,
  FilingPackage,
} from "@/platform/spine/store"

export function filingEscalationVarianceRemediationId(
  packageId: string,
  sequenceNo: number
): string {
  return `remediation:${packageId}:${sequenceNo}`
}

export function filingEscalationWaiverRolloverAttestationId(
  packageId: string,
  sequenceNo: number
): string {
  return `rollover:${packageId}:${sequenceNo}`
}

export function isFilingEscalationVarianceRemediationDecision(
  value: string | null
): value is FilingEscalationVarianceRemediationDecision {
  return value === "accepted_risk" || value === "rollback" || value === "temporary_override"
}

export function isFilingEscalationVarianceRemediationStatus(
  value: string | null
): value is FilingEscalationVarianceRemediationStatus {
  return value === "active" || value === "expired" || value === "superseded"
}

export function isFilingEscalationWaiverRolloverStatus(
  value: string | null
): value is FilingEscalationWaiverRolloverStatus {
  return value === "attested" || value === "not_required"
}

export function buildFilingEscalationVarianceRemediationRow(
  filingPackage: FilingPackage,
  input: {
    sequenceNo: number
    decision: FilingEscalationVarianceRemediationDecision
    justification: string
    actorId: string
    expiresAt: number
    now?: number
    linkedPolicyVarianceDigestId?: string | null
    linkedPolicyId?: string | null
    secondApproverId?: string | null
    note?: string | null
  }
): FilingEscalationVarianceRemediationRow {
  const now = input.now ?? Date.now()
  const note = input.note?.trim()
  return {
    id: filingEscalationVarianceRemediationId(filingPackage.id, input.sequenceNo),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    decision: input.decision,
    status: input.expiresAt > now ? "active" : "expired",
    linkedPolicyVarianceDigestId: input.linkedPolicyVarianceDigestId ?? null,
    linkedPolicyId: input.linkedPolicyId ?? null,
    justification: input.justification.trim(),
    decidedBy: input.actorId,
    decidedAt: now,
    expiresAt: input.expiresAt,
    secondApproverId: input.secondApproverId ?? null,
    notes: note ? [`${new Date(now).toISOString()} ${input.actorId}: ${note}`] : [],
    updatedAt: now,
  }
}

export function buildFilingEscalationWaiverRolloverAttestationRow(
  filingPackage: FilingPackage,
  input: {
    sequenceNo: number
    waiverId: string
    extensionHours: number
    previousExpiresAt: number
    newExpiresAt: number
    policyCapExpiresAt: number
    actorId: string
    secondApproverId: string
    justification: string
    now?: number
    note?: string | null
  }
): FilingEscalationWaiverRolloverAttestationRow {
  const now = input.now ?? Date.now()
  const note = input.note?.trim()
  return {
    id: filingEscalationWaiverRolloverAttestationId(filingPackage.id, input.sequenceNo),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    waiverId: input.waiverId,
    status: "attested",
    extensionHours: input.extensionHours,
    previousExpiresAt: input.previousExpiresAt,
    newExpiresAt: input.newExpiresAt,
    policyCapExpiresAt: input.policyCapExpiresAt,
    attestedBy: input.actorId,
    secondApproverId: input.secondApproverId,
    justification: input.justification.trim(),
    attestedAt: now,
    notes: note ? [`${new Date(now).toISOString()} ${input.actorId}: ${note}`] : [],
    updatedAt: now,
  }
}
