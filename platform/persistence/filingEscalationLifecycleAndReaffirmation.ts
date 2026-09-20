import type {
  FilingEscalationRemediationClosureOutcome,
  FilingEscalationRemediationLifecycleRow,
  FilingEscalationRemediationLifecycleStatus,
  FilingEscalationRolloverReaffirmationSlaReason,
  FilingEscalationRolloverReaffirmationSlaRow,
  FilingEscalationRolloverReaffirmationSlaStatus,
  FilingEscalationVarianceRemediationDecision,
  FilingEscalationVarianceRemediationRow,
  FilingEscalationWaiverRolloverAttestationRow,
  FilingEscalationBreachWaiverLedgerRow,
  FilingPackage,
} from "@/platform/spine/store"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function sortUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b)) as T[]
}

function parseLeadingIsoMillis(note: string): number | null {
  const candidate = note.split(" ")[0]
  if (!candidate) return null
  const value = Date.parse(candidate)
  return Number.isFinite(value) ? value : null
}

function extractLastReaffirmedAt(attestation: FilingEscalationWaiverRolloverAttestationRow | null): number | null {
  if (!attestation) return null
  const reaffirmationMoments = attestation.notes
    .filter((entry) => entry.toLowerCase().includes("reaffirm"))
    .map((entry) => parseLeadingIsoMillis(entry))
    .filter((value): value is number => value !== null)
    .sort((a, b) => b - a)
  if (reaffirmationMoments[0] !== undefined) return reaffirmationMoments[0]
  return attestation.attestedAt
}

export function filingEscalationRemediationLifecycleId(remediationId: string): string {
  return `remediation-lifecycle:${remediationId}`
}

export function filingEscalationRolloverReaffirmationSlaId(packageId: string): string {
  return `rollover-reaffirmation-sla:${packageId}`
}

export function isFilingEscalationRemediationLifecycleStatus(
  value: string | null
): value is FilingEscalationRemediationLifecycleStatus {
  return value === "open" || value === "closure_attested"
}

export function isFilingEscalationRemediationClosureOutcome(
  value: string | null
): value is FilingEscalationRemediationClosureOutcome {
  return value === "resolved" || value === "rolled_back" || value === "accepted_risk_retired"
}

export function isFilingEscalationRolloverReaffirmationSlaStatus(
  value: string | null
): value is FilingEscalationRolloverReaffirmationSlaStatus {
  return (
    value === "within_sla" ||
    value === "warning" ||
    value === "breached" ||
    value === "acknowledged" ||
    value === "cleared"
  )
}

export function buildFilingEscalationRemediationLifecycleRow(
  filingPackage: FilingPackage,
  remediation: FilingEscalationVarianceRemediationRow,
  input: {
    actorId: string
    now?: number
    note?: string | null
  }
): FilingEscalationRemediationLifecycleRow {
  const now = input.now ?? Date.now()
  const note = input.note?.trim()
  return {
    id: filingEscalationRemediationLifecycleId(remediation.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    remediationId: remediation.id,
    remediationDecision: remediation.decision,
    status: "open",
    linkedPolicyVarianceDigestId: remediation.linkedPolicyVarianceDigestId,
    linkedPolicyId: remediation.linkedPolicyId,
    expiresAt: remediation.expiresAt,
    openedBy: input.actorId,
    openedAt: now,
    closureOutcome: null,
    closureAttestedBy: null,
    closureAttestedAt: null,
    notes: note ? [`${new Date(now).toISOString()} ${input.actorId}: ${note}`] : [],
    updatedAt: now,
  }
}

export function buildFilingEscalationRolloverReaffirmationSlaRow(
  filingPackage: FilingPackage,
  input: {
    activeWaiver: FilingEscalationBreachWaiverLedgerRow | null
    policyCapExpiresAt: number | null
    latestAttestation: FilingEscalationWaiverRolloverAttestationRow | null
    linkedPolicyId?: string | null
    warningThresholdMs?: number
    breachThresholdMs?: number
    now?: number
    existing?: FilingEscalationRolloverReaffirmationSlaRow | null
    note?: { actorId: string; text: string } | null
  }
): FilingEscalationRolloverReaffirmationSlaRow {
  const now = input.now ?? Date.now()
  const existing = input.existing ?? null
  const warningThresholdMs = input.warningThresholdMs ?? DAY_MS
  const breachThresholdMs = input.breachThresholdMs ?? 2 * DAY_MS
  const reasons: FilingEscalationRolloverReaffirmationSlaReason[] = []
  const capCrossed =
    !!input.activeWaiver &&
    input.policyCapExpiresAt !== null &&
    input.activeWaiver.expiresAt > input.policyCapExpiresAt
  const lastReaffirmedAt = capCrossed ? extractLastReaffirmedAt(input.latestAttestation) : null
  const elapsed = capCrossed && lastReaffirmedAt !== null ? now - lastReaffirmedAt : null
  if (capCrossed && elapsed !== null) {
    if (elapsed >= breachThresholdMs) {
      reasons.push("cap_crossed_reaffirmation_breached")
    } else if (elapsed >= warningThresholdMs) {
      reasons.push("cap_crossed_reaffirmation_warning")
    }
  }
  const sortedReasons = sortUnique(reasons)
  const note = input.note?.text.trim()
  const notes = note
    ? [...(existing?.notes ?? []), `${new Date(now).toISOString()} ${input.note?.actorId}: ${note}`]
    : (existing?.notes ?? [])
  let status: FilingEscalationRolloverReaffirmationSlaStatus = existing?.status ?? "cleared"
  if (!capCrossed || sortedReasons.length === 0) {
    status = capCrossed ? "within_sla" : "cleared"
  } else if (sortedReasons.includes("cap_crossed_reaffirmation_breached")) {
    status = "breached"
  } else if (existing?.status === "acknowledged") {
    status = "acknowledged"
  } else {
    status = "warning"
  }
  return {
    id: filingEscalationRolloverReaffirmationSlaId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    status,
    reasons: sortedReasons,
    linkedWaiverId: input.activeWaiver?.id ?? null,
    linkedAttestationId: input.latestAttestation?.id ?? null,
    linkedPolicyId: input.linkedPolicyId ?? null,
    policyCapExpiresAt: input.policyCapExpiresAt,
    waiverExpiresAt: input.activeWaiver?.expiresAt ?? null,
    lastReaffirmedAt,
    elapsedSinceReaffirmationMs: elapsed,
    warningThresholdMs,
    breachThresholdMs,
    acknowledgedBy: status === "acknowledged" ? (existing?.acknowledgedBy ?? null) : null,
    acknowledgedAt: status === "acknowledged" ? (existing?.acknowledgedAt ?? null) : null,
    notes,
    lastEvaluatedAt: now,
    updatedAt: now,
  }
}

export function remediationStatusFromClosureOutcome(
  outcome: FilingEscalationRemediationClosureOutcome
): "expired" | "superseded" {
  if (outcome === "rolled_back") return "superseded"
  return "expired"
}

export function requiresSecondApproverForRemediationDecision(
  decision: FilingEscalationVarianceRemediationDecision
): boolean {
  return decision === "temporary_override"
}
