import type {
  FilingEscalationClosureAttestationRow,
  FilingEscalationClosureAttestationStatus,
  FilingEscalationClosureFollowupQueueRow,
  FilingEscalationClosureSlaExceptionDigestRow,
  FilingEscalationClosureSlaExceptionReason,
  FilingEscalationClosureSlaExceptionStatus,
  FilingEscalationClosureSlaPressureLevel,
  FilingEscalationClosureSlaWindowRow,
  FilingEscalationClosureComplianceDigestRow,
} from "@/platform/spine/store"

function sortUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b)) as T[]
}

export function filingEscalationClosureAttestationId(queueId: string, sequenceNo: number): string {
  return `closure-attestation:${queueId}:${sequenceNo}`
}

export function filingEscalationClosureSlaExceptionDigestId(queueId: string): string {
  return `closure-sla-exception:${queueId}`
}

export function isFilingEscalationClosureAttestationStatus(
  value: string | null
): value is FilingEscalationClosureAttestationStatus {
  return value === "pending_second_review" || value === "attested" || value === "rejected"
}

export function isFilingEscalationClosureSlaExceptionStatus(
  value: string | null
): value is FilingEscalationClosureSlaExceptionStatus {
  return value === "open_exception" || value === "waived" || value === "expired" || value === "cleared"
}

export function isFilingEscalationClosureSlaExceptionReason(
  value: string | null
): value is FilingEscalationClosureSlaExceptionReason {
  return (
    value === "ack_deadline_breached" ||
    value === "clear_deadline_breached" ||
    value === "auto_escalation_due" ||
    value === "attestation_pending" ||
    value === "attestation_rejected" ||
    value === "policy_override_active"
  )
}

export function buildFilingEscalationClosureAttestationRow(input: {
  digest: FilingEscalationClosureComplianceDigestRow
  queue: FilingEscalationClosureFollowupQueueRow
  slaWindow: FilingEscalationClosureSlaWindowRow
  actorId: string
  secondReviewerId?: string | null
  partnerConcurrence: boolean
  evidenceNote: string
  linkedExceptionDigestId?: string | null
  existingRowsForQueue?: FilingEscalationClosureAttestationRow[]
  now?: number
  note?: string | null
}): FilingEscalationClosureAttestationRow {
  const now = input.now ?? Date.now()
  const sequenceNo =
    (input.existingRowsForQueue ?? []).reduce((max, row) => Math.max(max, row.sequenceNo), 0) + 1
  const note = input.note?.trim()
  const notes = [`${new Date(now).toISOString()} ${input.actorId}: ${input.evidenceNote.trim()}`]
  if (note) notes.push(`${new Date(now).toISOString()} ${input.actorId}: ${note}`)
  return {
    id: filingEscalationClosureAttestationId(input.queue.id, sequenceNo),
    sequenceNo,
    firmId: input.queue.firmId,
    ownerId: input.queue.ownerId,
    digestId: input.digest.id,
    queueId: input.queue.id,
    linkedSlaWindowId: input.slaWindow.id,
    linkedExceptionDigestId: input.linkedExceptionDigestId ?? null,
    classification: input.queue.classification,
    packageIds: input.queue.packageIds,
    status: input.secondReviewerId ? "pending_second_review" : "attested",
    claimPartnerId: input.queue.claimedBy,
    claimAt: input.queue.claimedAt,
    resolutionPartnerId: input.queue.resolvedBy,
    resolutionAt: input.queue.resolvedAt,
    attestedBy: input.actorId,
    attestedAt: now,
    secondReviewerId: input.secondReviewerId ?? null,
    secondReviewedBy: input.secondReviewerId ? null : input.actorId,
    secondReviewedAt: input.secondReviewerId ? null : now,
    partnerConcurrence: input.partnerConcurrence,
    evidenceNote: input.evidenceNote.trim(),
    notes,
    updatedAt: now,
  }
}

export function buildFilingEscalationClosureSlaExceptionDigestRow(input: {
  digest: FilingEscalationClosureComplianceDigestRow
  queue: FilingEscalationClosureFollowupQueueRow
  slaWindow: FilingEscalationClosureSlaWindowRow
  latestAttestation: FilingEscalationClosureAttestationRow | null
  policyOverrideActive: boolean
  now?: number
  existing?: FilingEscalationClosureSlaExceptionDigestRow | null
  note?: { actorId: string; text: string } | null
}): FilingEscalationClosureSlaExceptionDigestRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const reasons: FilingEscalationClosureSlaExceptionReason[] = []
  if (input.slaWindow.status === "ack_breached") reasons.push("ack_deadline_breached")
  if (input.slaWindow.status === "clear_breached") reasons.push("clear_deadline_breached")
  if (input.slaWindow.status === "auto_escalation_due") reasons.push("auto_escalation_due")
  if (!input.latestAttestation || input.latestAttestation.status === "pending_second_review") {
    reasons.push("attestation_pending")
  }
  if (input.latestAttestation?.status === "rejected") {
    reasons.push("attestation_rejected")
  }
  if (input.policyOverrideActive) reasons.push("policy_override_active")
  const sortedReasons = sortUnique(reasons)
  const note = input.note?.text.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.note?.actorId}: ${note}`]
    : (existing?.notes ?? [])

  const activeAlert = input.queue.status !== "resolved" && sortedReasons.length > 0
  const waiverStillActive =
    existing?.status === "waived" && !!existing.waiverExpiresAt && existing.waiverExpiresAt > now
  const waiverExpired =
    existing?.status === "waived" && !!existing.waiverExpiresAt && existing.waiverExpiresAt <= now
  let status: FilingEscalationClosureSlaExceptionStatus = existing?.status ?? "cleared"
  if (!activeAlert) {
    status = "cleared"
  } else if (waiverStillActive) {
    status = "waived"
  } else if (waiverExpired) {
    status = "expired"
  } else {
    status = "open_exception"
  }

  let pressureLevel: FilingEscalationClosureSlaPressureLevel = "baseline"
  if (
    sortedReasons.includes("ack_deadline_breached") ||
    sortedReasons.includes("attestation_pending") ||
    sortedReasons.includes("policy_override_active")
  ) {
    pressureLevel = "elevated"
  }
  if (
    sortedReasons.includes("clear_deadline_breached") ||
    sortedReasons.includes("auto_escalation_due") ||
    sortedReasons.includes("attestation_rejected") ||
    status === "expired"
  ) {
    pressureLevel = "critical"
  }

  return {
    id: filingEscalationClosureSlaExceptionDigestId(input.queue.id),
    firmId: input.queue.firmId,
    ownerId: input.queue.ownerId,
    digestId: input.digest.id,
    queueId: input.queue.id,
    classification: input.queue.classification,
    packageIds: input.queue.packageIds,
    status,
    pressureLevel,
    reasons: sortedReasons,
    waiverReason: status === "waived" || status === "expired" ? (existing?.waiverReason ?? null) : null,
    waivedBy: status === "waived" || status === "expired" ? (existing?.waivedBy ?? null) : null,
    waivedAt: status === "waived" || status === "expired" ? (existing?.waivedAt ?? null) : null,
    waiverExpiresAt:
      status === "waived" || status === "expired" ? (existing?.waiverExpiresAt ?? null) : null,
    expiredAt:
      status === "expired"
        ? existing?.expiredAt ?? now
        : status === "waived"
          ? null
          : existing?.expiredAt ?? null,
    linkedSlaWindowId: input.slaWindow.id,
    linkedAttestationId: input.latestAttestation?.id ?? null,
    linkedConfigId: input.slaWindow.linkedConfigId,
    linkedAutoAssignmentRuleId: input.slaWindow.linkedAutoAssignmentRuleId,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}
