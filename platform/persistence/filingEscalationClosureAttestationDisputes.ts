import type {
  FilingEscalationClosureAttestationDisputeRow,
  FilingEscalationClosureAttestationDisputeStatus,
  FilingEscalationClosureAttestationRow,
  FilingEscalationClosureFollowupQueueRow,
  FilingEscalationClosureSlaExceptionDigestRow,
  FilingEscalationClosureSlaExceptionEnforcementRow,
  FilingEscalationClosureSlaExceptionEnforcementStatus,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000

export function filingEscalationClosureAttestationDisputeId(
  attestationId: string,
  sequenceNo: number
): string {
  return `closure-attestation-dispute:${attestationId}:${sequenceNo}`
}

export function filingEscalationClosureSlaExceptionEnforcementId(queueId: string): string {
  return `closure-sla-exception-enforcement:${queueId}`
}

export function isFilingEscalationClosureAttestationDisputeStatus(
  value: string | null
): value is FilingEscalationClosureAttestationDisputeStatus {
  return (
    value === "open_dispute" ||
    value === "under_review" ||
    value === "resolved_upheld" ||
    value === "resolved_overturned"
  )
}

export function isFilingEscalationClosureSlaExceptionEnforcementStatus(
  value: string | null
): value is FilingEscalationClosureSlaExceptionEnforcementStatus {
  return (
    value === "countdown_active" ||
    value === "reminder_sent" ||
    value === "escalated" ||
    value === "closed"
  )
}

function deriveReviewerChain(row: FilingEscalationClosureAttestationRow): string[] {
  return [
    row.attestedBy,
    row.secondReviewerId,
    row.secondReviewedBy,
    row.claimPartnerId,
    row.resolutionPartnerId,
  ].filter((value): value is string => !!value)
}

export function buildFilingEscalationClosureAttestationDisputeRow(input: {
  attestation: FilingEscalationClosureAttestationRow
  queue: FilingEscalationClosureFollowupQueueRow
  conflictReason: string
  actorId: string
  sequenceNo: number
  exceptionDigestId?: string | null
  now?: number
  note?: string | null
}): FilingEscalationClosureAttestationDisputeRow {
  const now = input.now ?? Date.now()
  const reviewerChain = deriveReviewerChain(input.attestation)
  const baseNote = `${new Date(now).toISOString()} ${input.actorId}: ${input.conflictReason.trim()}`
  const note = input.note?.trim()
  return {
    id: filingEscalationClosureAttestationDisputeId(input.attestation.id, input.sequenceNo),
    sequenceNo: input.sequenceNo,
    firmId: input.attestation.firmId,
    ownerId: input.attestation.ownerId,
    digestId: input.attestation.digestId,
    queueId: input.attestation.queueId,
    attestationId: input.attestation.id,
    exceptionDigestId: input.exceptionDigestId ?? input.attestation.linkedExceptionDigestId,
    classification: input.attestation.classification,
    packageIds: input.attestation.packageIds,
    status: "open_dispute",
    conflictReason: input.conflictReason.trim(),
    openedBy: input.actorId,
    openedAt: now,
    reviewerChainIds: reviewerChain,
    reviewerChainSnapshot: reviewerChain.join(" -> "),
    underReviewBy: null,
    underReviewAt: null,
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    notes: note ? [baseNote, `${new Date(now).toISOString()} ${input.actorId}: ${note}`] : [baseNote],
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureSlaExceptionEnforcementRow(input: {
  queue: FilingEscalationClosureFollowupQueueRow
  exceptionDigest: FilingEscalationClosureSlaExceptionDigestRow
  latestDispute: FilingEscalationClosureAttestationDisputeRow | null
  existing?: FilingEscalationClosureSlaExceptionEnforcementRow | null
  now?: number
}): FilingEscalationClosureSlaExceptionEnforcementRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const waiverExpiresAt = input.exceptionDigest.waiverExpiresAt
  const msUntilExpiry =
    waiverExpiresAt === null ? null : Math.max(0, waiverExpiresAt - now)
  let status: FilingEscalationClosureSlaExceptionEnforcementStatus = "closed"
  if (input.exceptionDigest.status === "waived" && waiverExpiresAt !== null) {
    status = msUntilExpiry !== null && msUntilExpiry <= HOUR_MS ? "reminder_sent" : "countdown_active"
  } else if (input.exceptionDigest.status === "expired") {
    status = "escalated"
  } else if (input.exceptionDigest.status === "open_exception") {
    status = "countdown_active"
  }
  return {
    id: filingEscalationClosureSlaExceptionEnforcementId(input.queue.id),
    firmId: input.queue.firmId,
    ownerId: input.queue.ownerId,
    digestId: input.queue.digestId,
    queueId: input.queue.id,
    exceptionDigestId: input.exceptionDigest.id,
    classification: input.queue.classification,
    packageIds: input.queue.packageIds,
    status,
    waiverExpiresAt,
    msUntilExpiry,
    reminderCount:
      status === "reminder_sent"
        ? (existing?.status === "reminder_sent" ? existing.reminderCount : (existing?.reminderCount ?? 0) + 1)
        : (existing?.reminderCount ?? 0),
    escalationCount:
      status === "escalated"
        ? (existing?.status === "escalated" ? existing.escalationCount : (existing?.escalationCount ?? 0) + 1)
        : (existing?.escalationCount ?? 0),
    lastReminderAt:
      status === "reminder_sent"
        ? (existing?.status === "reminder_sent" ? existing.lastReminderAt : now)
        : (existing?.lastReminderAt ?? null),
    lastEscalatedAt:
      status === "escalated"
        ? (existing?.status === "escalated" ? existing.lastEscalatedAt : now)
        : (existing?.lastEscalatedAt ?? null),
    linkedAttestationDisputeId: input.latestDispute?.id ?? null,
    notes: existing?.notes ?? [],
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
