import { NextResponse } from "next/server"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import {
  rankOf,
  type Classification,
  type FollowUp,
  type Matter,
  type User,
  type WorkflowOpsActivityRow,
  type WorkflowOpsAlertAttestationFreshnessStatus,
  type WorkflowOpsAlertAttestationDisputeFreshnessStatus,
  type WorkflowOpsAlertAttestationDisputeResolutionOutcome,
  type WorkflowOpsAlertAttestationDisputeRow,
  type WorkflowOpsAlertAttestationDisputeStatus,
  type WorkflowOpsAlertAttestationRow,
  type WorkflowOpsAlertAttestationStatus,
  type WorkflowOpsAlertDigestFreshnessStatus,
  type WorkflowOpsAlertDigestRow,
  type WorkflowOpsAlertDigestSeverity,
  type WorkflowOpsAlertEscalationClosureFreshnessStatus,
  type WorkflowOpsAlertClosureDebtReconciliationDigestRow,
  type WorkflowOpsAlertClosureDebtReconciliationFreshnessStatus,
  type WorkflowOpsAlertClosureDebtReconciliationStatus,
  type WorkflowOpsAlertClosureDebtVarianceDigestRow,
  type WorkflowOpsAlertClosureDebtVarianceFreshnessStatus,
  type WorkflowOpsAlertClosureDebtVarianceStatus,
  type WorkflowOpsAlertEnforcementWaiverFreshnessStatus,
  type WorkflowOpsAlertEnforcementWaiverLedgerRow,
  type WorkflowOpsAlertEnforcementWaiverStatus,
  type WorkflowOpsAlertWaiverExpiryDigestFreshnessStatus,
  type WorkflowOpsAlertWaiverExpiryDigestRow,
  type WorkflowOpsAlertWaiverExpiryDigestStatus,
  type WorkflowOpsAlertWaiverExpiryDisputeFreshnessStatus,
  type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationFreshnessStatus,
  type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow,
  type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipFreshnessStatus,
  type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow,
  type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipStatus,
  type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationFreshnessStatus,
  type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow,
  type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationStatus,
  type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationStatus,
  type WorkflowOpsAlertWaiverExpiryDisputeResolutionOutcome,
  type WorkflowOpsAlertWaiverExpiryDisputeRow,
  type WorkflowOpsAlertWaiverExpiryDisputeStatus,
  type WorkflowOpsAlertDisputeEnforcementFreshnessStatus,
  type WorkflowOpsAlertDisputeEnforcementLedgerRow,
  type WorkflowOpsAlertDisputeEnforcementStatus,
  type WorkflowOpsAlertEnforcementAttestationFreshnessStatus,
  type WorkflowOpsAlertEnforcementAttestationRow,
  type WorkflowOpsAlertEnforcementAttestationStatus,
  type WorkflowOpsAlertEscalationClosureRow,
  type WorkflowOpsAlertEscalationClosureStatus,
  type WorkflowOpsAlertEscalationFreshnessStatus,
  type WorkflowOpsAlertEscalationLedgerRow,
  type WorkflowOpsAlertEscalationStatus,
  type WorkflowOpsAlertVarianceRemediationQueueFreshnessStatus,
  type WorkflowOpsAlertVarianceRemediationQueueRow,
  type WorkflowOpsAlertVarianceRemediationQueueStatus,
  type WorkflowOpsAlertVarianceRemediationSlaLedgerFreshnessStatus,
  type WorkflowOpsAlertVarianceRemediationSlaLedgerRow,
  type WorkflowOpsAlertVarianceRemediationSlaLedgerStatus,
  type WorkflowOpsAlertVarianceRemediationSlaBreachEscalationFreshnessStatus,
  type WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow,
  type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationFreshnessStatus,
  type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow,
  type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationStatus,
  type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationFreshnessStatus,
  type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow,
  type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationStatus,
  type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryRiskStatus,
  type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointFreshnessStatus,
  type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow,
  type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointStatus,
  type WorkflowOpsAlertVarianceRemediationSlaBreachEscalationStatus,
} from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { syncFirmUsers } from "@/platform/persistence/userSync"
import { persistAuditEntriesSince } from "@/platform/persistence/auditWriteThrough"
import { checkPermission } from "@/platform/p5/checkPermission"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000
const WAIVER_EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000
const WAIVER_EXPIRY_CRITICAL_MS = 4 * 60 * 60 * 1000
const VARIANCE_REMEDIATION_SLA_WARNING_MS = 4 * 60 * 60 * 1000
const VARIANCE_REMEDIATION_SLA_BREACH_MS = 12 * 60 * 60 * 1000
const WAIVER_EXPIRY_DISPUTE_ADJUDICATION_DUE_MS = 8 * 60 * 60 * 1000
const REMEDIATION_SLA_BREACH_RESOLUTION_CHECKPOINT_DUE_MS = 6 * 60 * 60 * 1000
const WAIVER_EXPIRY_DISPUTE_ADJUDICATION_SLO_EXTENSION_MS = 8 * 60 * 60 * 1000
const REMEDIATION_SLA_BREACH_RESOLUTION_CHECKPOINT_EXPIRY_WARNING_MS = 4 * 60 * 60 * 1000

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 25
  if (!Number.isFinite(parsed) || parsed < 1) return 25
  return Math.min(parsed, 100)
}

function parseCursor(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 0
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

function normalizeTerms(value: string | null): string[] {
  if (!value) return []
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

function parseSource(value: string | null): "workflow_event" | "court_ops" | undefined {
  if (value === "workflow_event" || value === "court_ops") return value
  return undefined
}

type View =
  | "activity"
  | "alert_digests"
  | "alert_attestations"
  | "alert_escalation_ledgers"
  | "alert_attestation_disputes"
  | "alert_escalation_closures"
  | "alert_dispute_enforcement_ledgers"
  | "alert_closure_debt_reconciliation_digests"
  | "alert_enforcement_attestations"
  | "alert_closure_debt_variance_digests"
  | "alert_enforcement_waiver_ledgers"
  | "alert_variance_remediation_queues"
  | "alert_waiver_expiry_digests"
  | "alert_variance_remediation_sla_ledgers"
  | "alert_waiver_expiry_disputes"
  | "alert_variance_remediation_sla_breach_escalations"
  | "alert_waiver_expiry_dispute_adjudications"
  | "alert_variance_remediation_sla_breach_resolution_checkpoints"
  | "alert_waiver_expiry_dispute_adjudication_slo_stewardships"
  | "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations"
  | "alert_waiver_expiry_dispute_adjudication_slo_debt_remediations"
  | "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations"

function parseView(value: string | null): View | undefined {
  if (!value || value === "activity") return "activity"
  if (value === "alert_digests") return value
  if (value === "alert_attestations") return value
  if (value === "alert_escalation_ledgers") return value
  if (value === "alert_attestation_disputes") return value
  if (value === "alert_escalation_closures") return value
  if (value === "alert_dispute_enforcement_ledgers") return value
  if (value === "alert_closure_debt_reconciliation_digests") return value
  if (value === "alert_enforcement_attestations") return value
  if (value === "alert_closure_debt_variance_digests") return value
  if (value === "alert_enforcement_waiver_ledgers") return value
  if (value === "alert_variance_remediation_queues") return value
  if (value === "alert_waiver_expiry_digests") return value
  if (value === "alert_variance_remediation_sla_ledgers") return value
  if (value === "alert_waiver_expiry_disputes") return value
  if (value === "alert_variance_remediation_sla_breach_escalations") return value
  if (value === "alert_waiver_expiry_dispute_adjudications") return value
  if (value === "alert_variance_remediation_sla_breach_resolution_checkpoints") return value
  if (value === "alert_waiver_expiry_dispute_adjudication_slo_stewardships") return value
  if (value === "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations") {
    return value
  }
  if (value === "alert_waiver_expiry_dispute_adjudication_slo_debt_remediations") return value
  if (
    value ===
    "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations"
  ) {
    return value
  }
  return undefined
}

function parseSeverity(value: string | null): WorkflowOpsAlertDigestSeverity | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value
  }
  return undefined
}

function parseFreshness(value: string | null): WorkflowOpsAlertDigestFreshnessStatus | undefined {
  if (value === "fresh" || value === "stale") return value
  return undefined
}

function parseAttestationStatus(value: string | null): WorkflowOpsAlertAttestationStatus | undefined {
  if (value === "pending_attestation" || value === "attested" || value === "reopened") return value
  return undefined
}

function parseEscalationStatus(value: string | null): WorkflowOpsAlertEscalationStatus | undefined {
  if (value === "not_required" || value === "open" || value === "assigned" || value === "resolved") {
    return value
  }
  return undefined
}

function parseDisputeStatus(value: string | null): WorkflowOpsAlertAttestationDisputeStatus | undefined {
  if (
    value === "not_contested" ||
    value === "open" ||
    value === "review_assigned" ||
    value === "resolved"
  ) {
    return value
  }
  return undefined
}

function parseClosureStatus(value: string | null): WorkflowOpsAlertEscalationClosureStatus | undefined {
  if (
    value === "pending_closure" ||
    value === "checkpoint_recorded" ||
    value === "closed" ||
    value === "reopened"
  ) {
    return value
  }
  return undefined
}

function parseEnforcementStatus(
  value: string | null
): WorkflowOpsAlertDisputeEnforcementStatus | undefined {
  if (
    value === "not_required" ||
    value === "pending_enforcement" ||
    value === "in_progress" ||
    value === "enforced" ||
    value === "waived"
  ) {
    return value
  }
  return undefined
}

function parseReconciliationStatus(
  value: string | null
): WorkflowOpsAlertClosureDebtReconciliationStatus | undefined {
  if (value === "in_balance" || value === "debt_open" || value === "reconciling" || value === "reconciled") {
    return value
  }
  return undefined
}

function parseEnforcementAttestationStatus(
  value: string | null
): WorkflowOpsAlertEnforcementAttestationStatus | undefined {
  if (value === "pending_attestation" || value === "attested" || value === "reopened") {
    return value
  }
  return undefined
}

function parseVarianceStatus(value: string | null): WorkflowOpsAlertClosureDebtVarianceStatus | undefined {
  if (
    value === "within_tolerance" ||
    value === "variance_open" ||
    value === "variance_reviewing" ||
    value === "variance_resolved"
  ) {
    return value
  }
  return undefined
}

function parseWaiverStatus(value: string | null): WorkflowOpsAlertEnforcementWaiverStatus | undefined {
  if (
    value === "not_requested" ||
    value === "pending_attestation" ||
    value === "attested" ||
    value === "waived"
  ) {
    return value
  }
  return undefined
}

function parseRemediationQueueStatus(
  value: string | null
): WorkflowOpsAlertVarianceRemediationQueueStatus | undefined {
  if (value === "not_queued" || value === "queued" || value === "assigned" || value === "resolved") {
    return value
  }
  return undefined
}

function parseWaiverExpiryStatus(
  value: string | null
): WorkflowOpsAlertWaiverExpiryDigestStatus | undefined {
  if (
    value === "no_risk" ||
    value === "expires_lte_24h" ||
    value === "expires_lte_4h" ||
    value === "expired" ||
    value === "acknowledged" ||
    value === "extended"
  ) {
    return value
  }
  return undefined
}

function parseRemediationSlaStatus(
  value: string | null
): WorkflowOpsAlertVarianceRemediationSlaLedgerStatus | undefined {
  if (
    value === "not_applicable" ||
    value === "within_sla" ||
    value === "warning" ||
    value === "breached" ||
    value === "acknowledged" ||
    value === "resolved"
  ) {
    return value
  }
  return undefined
}

function parseWaiverExpiryDisputeStatus(
  value: string | null
): WorkflowOpsAlertWaiverExpiryDisputeStatus | undefined {
  if (
    value === "not_contested" ||
    value === "open" ||
    value === "review_assigned" ||
    value === "resolved"
  ) {
    return value
  }
  return undefined
}

function parseRemediationSlaBreachEscalationStatus(
  value: string | null
): WorkflowOpsAlertVarianceRemediationSlaBreachEscalationStatus | undefined {
  if (value === "not_required" || value === "open" || value === "assigned" || value === "resolved") {
    return value
  }
  return undefined
}

function parseWaiverExpiryDisputeAdjudicationStatus(
  value: string | null
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationStatus | undefined {
  if (
    value === "not_required" ||
    value === "open" ||
    value === "panel_assigned" ||
    value === "resolved"
  ) {
    return value
  }
  return undefined
}

function parseRemediationSlaBreachResolutionCheckpointStatus(
  value: string | null
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointStatus | undefined {
  if (
    value === "not_required" ||
    value === "open" ||
    value === "checkpoint_recorded" ||
    value === "reopened"
  ) {
    return value
  }
  return undefined
}

function parseWaiverExpiryDisputeAdjudicationSloStatus(
  value: string | null
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipStatus | undefined {
  if (
    value === "not_required" ||
    value === "watch" ||
    value === "deadline_extended" ||
    value === "breach_acknowledged"
  ) {
    return value
  }
  return undefined
}

function parseRemediationSlaBreachResolutionCheckpointExpiryAttestationStatus(
  value: string | null
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationStatus | undefined {
  if (
    value === "not_required" ||
    value === "open" ||
    value === "attested" ||
    value === "expiry_acknowledged"
  ) {
    return value
  }
  return undefined
}

function parseWaiverExpiryDisputeAdjudicationSloDebtStatus(
  value: string | null
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationStatus | undefined {
  if (
    value === "not_required" ||
    value === "debt_watch" ||
    value === "remediation_recorded" ||
    value === "tier_downshifted" ||
    value === "breach_closure_attested"
  ) {
    return value
  }
  return undefined
}

function parseRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionStatus(
  value: string | null
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationStatus | undefined {
  if (
    value === "not_required" ||
    value === "exception_open" ||
    value === "exception_assigned" ||
    value === "exception_reconciled"
  ) {
    return value
  }
  return undefined
}

function parseDisputeOutcome(
  value: unknown
): WorkflowOpsAlertAttestationDisputeResolutionOutcome | undefined {
  if (value === "upheld" || value === "overturned" || value === "deferred") return value
  return undefined
}

function parseWaiverExpiryDisputeOutcome(
  value: unknown
): WorkflowOpsAlertWaiverExpiryDisputeResolutionOutcome | undefined {
  if (value === "expiry_upheld" || value === "extension_granted" || value === "deferred") {
    return value
  }
  return undefined
}

function parseSnoozedUntil(value: unknown, now: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN
  if (!Number.isFinite(parsed)) {
    throw new Error("snoozedUntil must be a unix epoch milliseconds number")
  }
  if (parsed <= now) {
    throw new Error("snoozedUntil must be in the future")
  }
  return parsed
}

function parseOptionalFutureEpochMs(
  value: unknown,
  now: number,
  fieldName: string
): number | null {
  if (value === undefined || value === null || value === "") return null
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a unix epoch milliseconds number`)
  }
  if (parsed <= now) {
    throw new Error(`${fieldName} must be in the future`)
  }
  return parsed
}

function normalizeReason(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function asFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertDigestFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function alertDigestId(matterId: string): string {
  return `workflow_ops_alert:${matterId}`
}

function alertAttestationId(matterId: string): string {
  return `workflow_ops_alert_attestation:${matterId}`
}

function alertEscalationLedgerId(matterId: string): string {
  return `workflow_ops_alert_escalation:${matterId}`
}

function alertAttestationDisputeId(matterId: string): string {
  return `workflow_ops_alert_attestation_dispute:${matterId}`
}

function alertEscalationClosureId(matterId: string): string {
  return `workflow_ops_alert_escalation_closure:${matterId}`
}

function alertDisputeEnforcementLedgerId(matterId: string): string {
  return `workflow_ops_alert_dispute_enforcement:${matterId}`
}

function alertClosureDebtReconciliationDigestId(matterId: string): string {
  return `workflow_ops_alert_closure_debt_reconciliation:${matterId}`
}

function alertEnforcementAttestationId(matterId: string): string {
  return `workflow_ops_alert_enforcement_attestation:${matterId}`
}

function alertClosureDebtVarianceDigestId(matterId: string): string {
  return `workflow_ops_alert_closure_debt_variance:${matterId}`
}

function alertEnforcementWaiverLedgerId(matterId: string): string {
  return `workflow_ops_alert_enforcement_waiver:${matterId}`
}

function alertVarianceRemediationQueueId(matterId: string): string {
  return `workflow_ops_alert_variance_remediation_queue:${matterId}`
}

function alertWaiverExpiryDigestId(matterId: string): string {
  return `workflow_ops_alert_waiver_expiry_digest:${matterId}`
}

function alertVarianceRemediationSlaLedgerId(matterId: string): string {
  return `workflow_ops_alert_variance_remediation_sla:${matterId}`
}

function alertWaiverExpiryDisputeId(matterId: string): string {
  return `workflow_ops_alert_waiver_expiry_dispute:${matterId}`
}

function alertVarianceRemediationSlaBreachEscalationId(matterId: string): string {
  return `workflow_ops_alert_variance_remediation_sla_breach_escalation:${matterId}`
}

function alertWaiverExpiryDisputeAdjudicationId(matterId: string): string {
  return `workflow_ops_alert_waiver_expiry_dispute_adjudication:${matterId}`
}

function alertVarianceRemediationSlaBreachResolutionCheckpointId(matterId: string): string {
  return `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint:${matterId}`
}

function alertWaiverExpiryDisputeAdjudicationSloStewardshipId(matterId: string): string {
  return `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo:${matterId}`
}

function alertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationId(
  matterId: string
): string {
  return `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation:${matterId}`
}

function alertWaiverExpiryDisputeAdjudicationSloDebtRemediationId(matterId: string): string {
  return `workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation:${matterId}`
}

function alertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationId(
  matterId: string
): string {
  return `workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliation:${matterId}`
}

function severityRank(value: WorkflowOpsAlertDigestSeverity): number {
  switch (value) {
    case "critical":
      return 4
    case "high":
      return 3
    case "medium":
      return 2
    case "low":
    default:
      return 1
  }
}

function strongerClassification(left: Classification, right: Classification): Classification {
  return rankOf(left) >= rankOf(right) ? left : right
}

function isResolvedStatus(status: string | null): boolean {
  if (!status) return false
  const normalized = status.toLowerCase()
  return (
    normalized.includes("resolved") ||
    normalized.includes("complete") ||
    normalized.includes("closed")
  )
}

function computeSeverity(params: {
  backlogPressureCount: number
  unresolvedFollowUpDebtCount: number
  staleQueueWindowCount: number
}): WorkflowOpsAlertDigestSeverity {
  const { backlogPressureCount, unresolvedFollowUpDebtCount, staleQueueWindowCount } = params
  if (staleQueueWindowCount >= 4 || unresolvedFollowUpDebtCount >= 4 || backlogPressureCount >= 12) {
    return "critical"
  }
  if (staleQueueWindowCount >= 2 || unresolvedFollowUpDebtCount >= 2 || backlogPressureCount >= 7) {
    return "high"
  }
  if (staleQueueWindowCount >= 1 || unresolvedFollowUpDebtCount >= 1 || backlogPressureCount >= 3) {
    return "medium"
  }
  return "low"
}

function normalizeProvenanceTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))]
}

function buildWorkflowOpsAlertDigest(params: {
  firmId: string
  matter: Matter
  actorId: string
  reason: string
  activities: WorkflowOpsActivityRow[]
  followUps: FollowUp[]
  existing: WorkflowOpsAlertDigestRow | null
  now: number
}): WorkflowOpsAlertDigestRow {
  const { firmId, matter, actorId, reason, activities, followUps, existing, now } = params
  const unresolvedFollowUps = followUps.filter((row) => row.status !== "resolved")
  const unresolvedActivities = activities.filter((row) => !isResolvedStatus(row.status))
  const staleActivities = unresolvedActivities.filter((row) => now - row.createdAt >= STALE_WINDOW_MS)

  const backlogPressureCount = unresolvedActivities.length + unresolvedFollowUps.length
  const unresolvedFollowUpDebtCount = unresolvedFollowUps.length
  const staleQueueWindowCount = staleActivities.length
  const severity = computeSeverity({
    backlogPressureCount,
    unresolvedFollowUpDebtCount,
    staleQueueWindowCount,
  })

  let classification: Classification = matter.classification
  for (const row of activities) {
    classification = strongerClassification(classification, row.classification)
  }

  return {
    id: alertDigestId(matter.id),
    firmId,
    matterId: matter.id,
    classification,
    severity,
    backlogPressureCount,
    unresolvedFollowUpDebtCount,
    staleQueueWindowCount,
    freshnessStatus: "fresh",
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `backlog:${backlogPressureCount}`,
      `unresolved_followups:${unresolvedFollowUpDebtCount}`,
      `stale_windows:${staleQueueWindowCount}`,
      `activity_rows:${activities.length}`,
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    acknowledgedAt: existing?.acknowledgedAt ?? null,
    acknowledgedBy: existing?.acknowledgedBy ?? null,
    acknowledgedReason: existing?.acknowledgedReason ?? null,
    snoozedUntil: existing?.snoozedUntil ?? null,
    snoozedBy: existing?.snoozedBy ?? null,
    snoozedReason: existing?.snoozedReason ?? null,
    updatedAt: now,
  }
}

function computeDefaultEscalationStatus(
  severity: WorkflowOpsAlertDigestSeverity
): WorkflowOpsAlertEscalationStatus {
  if (severity === "high" || severity === "critical") return "open"
  return "not_required"
}

function asAttestationFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertAttestationFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asEscalationFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertEscalationFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asDisputeFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertAttestationDisputeFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asClosureFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertEscalationClosureFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asEnforcementFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertDisputeEnforcementFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asReconciliationFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertClosureDebtReconciliationFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asEnforcementAttestationFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertEnforcementAttestationFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asVarianceFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertClosureDebtVarianceFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asEnforcementWaiverFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertEnforcementWaiverFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asVarianceRemediationQueueFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertVarianceRemediationQueueFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asWaiverExpiryFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertWaiverExpiryDigestFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asVarianceRemediationSlaFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertVarianceRemediationSlaLedgerFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asWaiverExpiryDisputeFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertWaiverExpiryDisputeFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asRemediationSlaBreachEscalationFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertVarianceRemediationSlaBreachEscalationFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asWaiverExpiryDisputeAdjudicationFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asRemediationSlaBreachResolutionCheckpointFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asWaiverExpiryDisputeAdjudicationSloFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asRemediationSlaBreachResolutionCheckpointExpiryAttestationFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asWaiverExpiryDisputeAdjudicationSloDebtRemediationFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function asRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationFreshnessStatus(
  recomputedAt: number,
  now: number
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationFreshnessStatus {
  return now - recomputedAt <= FRESH_WINDOW_MS ? "fresh" : "stale"
}

function computeDueWindowDebtMs(dueAt: number | null, now: number): number {
  if (dueAt === null || dueAt >= now) return 0
  return now - dueAt
}

function computeCheckpointExpiryRiskStatus(
  dueAt: number | null,
  now: number
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryRiskStatus {
  if (dueAt === null) return "no_risk"
  if (dueAt <= now) return "expired"
  if (dueAt - now <= REMEDIATION_SLA_BREACH_RESOLUTION_CHECKPOINT_EXPIRY_WARNING_MS) {
    return "expires_soon"
  }
  return "no_risk"
}

function buildWorkflowOpsAlertAttestationRow(params: {
  digest: WorkflowOpsAlertDigestRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertAttestationRow | null
  now: number
}): WorkflowOpsAlertAttestationRow {
  const { digest, actorId, reason, existing, now } = params
  const attestationStatus: WorkflowOpsAlertAttestationStatus =
    existing?.attestationStatus ?? "pending_attestation"
  return {
    id: alertAttestationId(digest.matterId ?? digest.id),
    firmId: digest.firmId,
    matterId: digest.matterId ?? digest.id,
    alertDigestId: digest.id,
    classification: digest.classification,
    attestationStatus,
    lastAttestedAt: existing?.lastAttestedAt ?? null,
    lastAttestedBy: existing?.lastAttestedBy ?? null,
    attestationReason: existing?.attestationReason ?? null,
    freshnessStatus: asAttestationFreshnessStatus(digest.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `digest_severity:${digest.severity}`,
      ...digest.provenanceTags.map((tag) => `digest_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertEscalationLedgerRow(params: {
  digest: WorkflowOpsAlertDigestRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertEscalationLedgerRow | null
  now: number
}): WorkflowOpsAlertEscalationLedgerRow {
  const { digest, actorId, reason, existing, now } = params
  const defaultStatus = computeDefaultEscalationStatus(digest.severity)
  const escalationStatus = existing?.escalationStatus ?? defaultStatus

  const openedAt =
    escalationStatus === "open" || escalationStatus === "assigned"
      ? existing?.openedAt ?? now
      : existing?.openedAt ?? null
  const lastStatusChangedAt = existing?.lastStatusChangedAt ?? openedAt
  const resolvedAt = escalationStatus === "resolved" ? existing?.resolvedAt ?? now : null
  const resolutionReason = escalationStatus === "resolved" ? existing?.resolutionReason ?? null : null

  return {
    id: alertEscalationLedgerId(digest.matterId ?? digest.id),
    firmId: digest.firmId,
    matterId: digest.matterId ?? digest.id,
    alertDigestId: digest.id,
    classification: digest.classification,
    escalationStatus,
    severity: digest.severity,
    ownerId: existing?.ownerId ?? null,
    openedAt,
    lastStatusChangedAt,
    resolvedAt,
    resolutionReason,
    freshnessStatus: asEscalationFreshnessStatus(digest.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `digest_severity:${digest.severity}`,
      ...digest.provenanceTags.map((tag) => `digest_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertAttestationDisputeRow(params: {
  attestation: WorkflowOpsAlertAttestationRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertAttestationDisputeRow | null
  now: number
}): WorkflowOpsAlertAttestationDisputeRow {
  const { attestation, actorId, reason, existing, now } = params
  const disputeStatus = existing?.disputeStatus ?? "not_contested"
  return {
    id: alertAttestationDisputeId(attestation.matterId),
    firmId: attestation.firmId,
    matterId: attestation.matterId,
    alertAttestationId: attestation.id,
    classification: attestation.classification,
    disputeStatus,
    reviewerId: existing?.reviewerId ?? null,
    openedAt: existing?.openedAt ?? null,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? null,
    resolvedAt: existing?.resolvedAt ?? null,
    resolutionOutcome: existing?.resolutionOutcome ?? null,
    resolutionReason: existing?.resolutionReason ?? null,
    freshnessStatus: asDisputeFreshnessStatus(attestation.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `attestation_status:${attestation.attestationStatus}`,
      ...attestation.provenanceTags.map((tag) => `attestation_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertEscalationClosureRow(params: {
  escalation: WorkflowOpsAlertEscalationLedgerRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertEscalationClosureRow | null
  now: number
}): WorkflowOpsAlertEscalationClosureRow {
  const { escalation, actorId, reason, existing, now } = params
  const closureStatus = existing?.closureStatus ?? "pending_closure"
  return {
    id: alertEscalationClosureId(escalation.matterId),
    firmId: escalation.firmId,
    matterId: escalation.matterId,
    alertEscalationLedgerId: escalation.id,
    classification: escalation.classification,
    closureStatus,
    checkpointAt: existing?.checkpointAt ?? null,
    closedAt: existing?.closedAt ?? null,
    reopenedAt: existing?.reopenedAt ?? null,
    closureReason: existing?.closureReason ?? null,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? null,
    freshnessStatus: asClosureFreshnessStatus(escalation.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `escalation_status:${escalation.escalationStatus}`,
      `digest_severity:${escalation.severity}`,
      ...escalation.provenanceTags.map((tag) => `escalation_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertDisputeEnforcementLedgerRow(params: {
  dispute: WorkflowOpsAlertAttestationDisputeRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertDisputeEnforcementLedgerRow | null
  now: number
}): WorkflowOpsAlertDisputeEnforcementLedgerRow {
  const { dispute, actorId, reason, existing, now } = params
  const requiredOutcome = dispute.disputeStatus === "resolved" ? dispute.resolutionOutcome ?? null : null
  const requiresEnforcement = requiredOutcome === "upheld" || requiredOutcome === "overturned"
  const defaultStatus: WorkflowOpsAlertDisputeEnforcementStatus = requiresEnforcement
    ? "pending_enforcement"
    : "not_required"
  let enforcementStatus = existing?.enforcementStatus ?? defaultStatus
  if (!requiresEnforcement && enforcementStatus !== "waived") {
    enforcementStatus = "not_required"
  }
  return {
    id: alertDisputeEnforcementLedgerId(dispute.matterId),
    firmId: dispute.firmId,
    matterId: dispute.matterId,
    alertAttestationDisputeId: dispute.id,
    classification: dispute.classification,
    enforcementStatus,
    requiredOutcome,
    ownerId: existing?.ownerId ?? null,
    checkpointAt: existing?.checkpointAt ?? null,
    enforcedAt: enforcementStatus === "enforced" ? existing?.enforcedAt ?? now : null,
    waivedAt: enforcementStatus === "waived" ? existing?.waivedAt ?? now : null,
    waiverReason: enforcementStatus === "waived" ? existing?.waiverReason ?? null : null,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? null,
    freshnessStatus: asEnforcementFreshnessStatus(dispute.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `dispute_status:${dispute.disputeStatus}`,
      `required_outcome:${requiredOutcome ?? "none"}`,
      ...dispute.provenanceTags.map((tag) => `dispute_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertClosureDebtReconciliationDigestRow(params: {
  closure: WorkflowOpsAlertEscalationClosureRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertClosureDebtReconciliationDigestRow | null
  now: number
}): WorkflowOpsAlertClosureDebtReconciliationDigestRow {
  const { closure, actorId, reason, existing, now } = params
  const closureReopened = closure.closureStatus === "reopened"
  const existingReopenDebtCount = existing?.reopenDebtCount ?? 0
  const defaultStatus: WorkflowOpsAlertClosureDebtReconciliationStatus = closureReopened
    ? "debt_open"
    : "in_balance"
  let reconciliationStatus = existing?.reconciliationStatus ?? defaultStatus
  if (closureReopened && reconciliationStatus === "in_balance") {
    reconciliationStatus = "debt_open"
  }
  const reopenDebtCount = closureReopened ? Math.max(existingReopenDebtCount, 1) : existingReopenDebtCount
  const outstandingDebtCount =
    reconciliationStatus === "reconciled"
      ? existing?.outstandingDebtCount ?? 0
      : closureReopened
        ? Math.max(existing?.outstandingDebtCount ?? 0, 1)
        : existing?.outstandingDebtCount ?? 0
  return {
    id: alertClosureDebtReconciliationDigestId(closure.matterId),
    firmId: closure.firmId,
    matterId: closure.matterId,
    alertEscalationClosureId: closure.id,
    classification: closure.classification,
    reconciliationStatus,
    reopenDebtCount,
    outstandingDebtCount,
    lastReopenedAt: closureReopened ? closure.reopenedAt ?? existing?.lastReopenedAt ?? now : existing?.lastReopenedAt ?? null,
    reconcilingOwnerId: existing?.reconcilingOwnerId ?? null,
    reconciliationCheckpointAt: existing?.reconciliationCheckpointAt ?? null,
    reconciledAt: reconciliationStatus === "reconciled" ? existing?.reconciledAt ?? now : null,
    reconciliationReason: reconciliationStatus === "reconciled" ? existing?.reconciliationReason ?? null : null,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? null,
    freshnessStatus: asReconciliationFreshnessStatus(closure.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `closure_status:${closure.closureStatus}`,
      `outstanding_debt:${outstandingDebtCount}`,
      ...closure.provenanceTags.map((tag) => `closure_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertEnforcementAttestationRow(params: {
  enforcement: WorkflowOpsAlertDisputeEnforcementLedgerRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertEnforcementAttestationRow | null
  now: number
}): WorkflowOpsAlertEnforcementAttestationRow {
  const { enforcement, actorId, reason, existing, now } = params
  const attestationStatus = existing?.attestationStatus ?? "pending_attestation"
  return {
    id: alertEnforcementAttestationId(enforcement.matterId),
    firmId: enforcement.firmId,
    matterId: enforcement.matterId,
    disputeEnforcementLedgerId: enforcement.id,
    classification: enforcement.classification,
    attestationStatus,
    requiredOutcome: enforcement.requiredOutcome,
    enforcementStatusSnapshot: enforcement.enforcementStatus,
    lastAttestedAt: existing?.lastAttestedAt ?? null,
    lastAttestedBy: existing?.lastAttestedBy ?? null,
    attestationReason: existing?.attestationReason ?? null,
    freshnessStatus: asEnforcementAttestationFreshnessStatus(enforcement.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `enforcement_status:${enforcement.enforcementStatus}`,
      `required_outcome:${enforcement.requiredOutcome ?? "none"}`,
      ...enforcement.provenanceTags.map((tag) => `enforcement_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertClosureDebtVarianceDigestRow(params: {
  reconciliation: WorkflowOpsAlertClosureDebtReconciliationDigestRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertClosureDebtVarianceDigestRow | null
  now: number
}): WorkflowOpsAlertClosureDebtVarianceDigestRow {
  const { reconciliation, actorId, reason, existing, now } = params
  const computedDelta = Math.max(
    reconciliation.outstandingDebtCount - reconciliation.reopenDebtCount,
    0
  )
  const defaultStatus: WorkflowOpsAlertClosureDebtVarianceStatus =
    computedDelta > 0 ? "variance_open" : "within_tolerance"
  let varianceStatus = existing?.varianceStatus ?? defaultStatus
  if (computedDelta === 0 && varianceStatus === "variance_open") {
    varianceStatus = "within_tolerance"
  }
  const outstandingVarianceCount =
    varianceStatus === "variance_resolved"
      ? existing?.outstandingVarianceCount ?? 0
      : Math.max(existing?.outstandingVarianceCount ?? 0, computedDelta)
  const varianceDelta =
    varianceStatus === "variance_resolved"
      ? existing?.varianceDelta ?? 0
      : Math.max(existing?.varianceDelta ?? 0, computedDelta)
  return {
    id: alertClosureDebtVarianceDigestId(reconciliation.matterId),
    firmId: reconciliation.firmId,
    matterId: reconciliation.matterId,
    closureDebtReconciliationDigestId: reconciliation.id,
    classification: reconciliation.classification,
    varianceStatus,
    outstandingVarianceCount,
    varianceDelta,
    reviewOwnerId: existing?.reviewOwnerId ?? null,
    varianceOpenedAt: existing?.varianceOpenedAt ?? null,
    varianceResolvedAt: varianceStatus === "variance_resolved" ? existing?.varianceResolvedAt ?? now : null,
    varianceReason: existing?.varianceReason ?? null,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? null,
    freshnessStatus: asVarianceFreshnessStatus(reconciliation.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `reconciliation_status:${reconciliation.reconciliationStatus}`,
      `variance_delta:${varianceDelta}`,
      ...reconciliation.provenanceTags.map((tag) => `reconciliation_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertEnforcementWaiverLedgerRow(params: {
  enforcement: WorkflowOpsAlertDisputeEnforcementLedgerRow
  enforcementAttestation: WorkflowOpsAlertEnforcementAttestationRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertEnforcementWaiverLedgerRow | null
  now: number
}): WorkflowOpsAlertEnforcementWaiverLedgerRow {
  const { enforcement, enforcementAttestation, actorId, reason, existing, now } = params
  const defaultStatus: WorkflowOpsAlertEnforcementWaiverStatus =
    enforcement.enforcementStatus === "waived" ? "waived" : "not_requested"
  const waiverStatus = existing?.waiverStatus ?? defaultStatus
  return {
    id: alertEnforcementWaiverLedgerId(enforcement.matterId),
    firmId: enforcement.firmId,
    matterId: enforcement.matterId,
    enforcementAttestationId: enforcementAttestation.id,
    classification: enforcement.classification,
    waiverStatus,
    requestedBy: existing?.requestedBy ?? null,
    requestedAt: existing?.requestedAt ?? null,
    attestedBy: existing?.attestedBy ?? null,
    attestedAt: existing?.attestedAt ?? null,
    waivedBy: existing?.waivedBy ?? (waiverStatus === "waived" ? actorId : null),
    waivedAt: existing?.waivedAt ?? (waiverStatus === "waived" ? now : null),
    waiverReason: existing?.waiverReason ?? enforcement.waiverReason ?? null,
    waiverExpiresAt: existing?.waiverExpiresAt ?? null,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? null,
    freshnessStatus: asEnforcementWaiverFreshnessStatus(enforcement.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `enforcement_status:${enforcement.enforcementStatus}`,
      `required_outcome:${enforcement.requiredOutcome ?? "none"}`,
      ...enforcement.provenanceTags.map((tag) => `enforcement_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertVarianceRemediationQueueRow(params: {
  variance: WorkflowOpsAlertClosureDebtVarianceDigestRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertVarianceRemediationQueueRow | null
  now: number
}): WorkflowOpsAlertVarianceRemediationQueueRow {
  const { variance, actorId, reason, existing, now } = params
  const queueStatus = existing?.queueStatus ?? "not_queued"
  return {
    id: alertVarianceRemediationQueueId(variance.matterId),
    firmId: variance.firmId,
    matterId: variance.matterId,
    closureDebtVarianceDigestId: variance.id,
    classification: variance.classification,
    queueStatus,
    queueReason: existing?.queueReason ?? null,
    queuedAt: existing?.queuedAt ?? null,
    ownerId: existing?.ownerId ?? variance.reviewOwnerId ?? null,
    assignedAt: existing?.assignedAt ?? null,
    resolvedAt: existing?.resolvedAt ?? null,
    resolutionReason: existing?.resolutionReason ?? null,
    outstandingVarianceCountSnapshot: existing?.outstandingVarianceCountSnapshot ?? variance.outstandingVarianceCount,
    varianceDeltaSnapshot: existing?.varianceDeltaSnapshot ?? variance.varianceDelta,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? null,
    freshnessStatus: asVarianceRemediationQueueFreshnessStatus(variance.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `variance_status:${variance.varianceStatus}`,
      `variance_delta:${variance.varianceDelta}`,
      ...variance.provenanceTags.map((tag) => `variance_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function computeWaiverExpiryStatus(params: {
  waiverStatus: WorkflowOpsAlertEnforcementWaiverStatus
  waiverExpiresAt: number | null
  now: number
}): {
  status: WorkflowOpsAlertWaiverExpiryDigestStatus
  msUntilExpiry: number | null
} {
  const { waiverStatus, waiverExpiresAt, now } = params
  if (waiverStatus !== "waived" || waiverExpiresAt === null) {
    return { status: "no_risk", msUntilExpiry: null }
  }
  const msUntilExpiry = waiverExpiresAt - now
  if (msUntilExpiry <= 0) return { status: "expired", msUntilExpiry }
  if (msUntilExpiry <= WAIVER_EXPIRY_CRITICAL_MS) {
    return { status: "expires_lte_4h", msUntilExpiry }
  }
  if (msUntilExpiry <= WAIVER_EXPIRY_WARNING_MS) {
    return { status: "expires_lte_24h", msUntilExpiry }
  }
  return { status: "no_risk", msUntilExpiry }
}

function buildWorkflowOpsAlertWaiverExpiryDigestRow(params: {
  waiverLedger: WorkflowOpsAlertEnforcementWaiverLedgerRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertWaiverExpiryDigestRow | null
  now: number
}): WorkflowOpsAlertWaiverExpiryDigestRow {
  const { waiverLedger, actorId, reason, existing, now } = params
  const computed = computeWaiverExpiryStatus({
    waiverStatus: waiverLedger.waiverStatus,
    waiverExpiresAt: waiverLedger.waiverExpiresAt,
    now,
  })
  let expiryStatus = computed.status
  if (
    computed.status !== "expired" &&
    (computed.status === "expires_lte_24h" || computed.status === "expires_lte_4h")
  ) {
    if (existing?.expiryStatus === "acknowledged") {
      expiryStatus = "acknowledged"
    } else if (existing?.expiryStatus === "extended") {
      expiryStatus = "extended"
    }
  }
  if (
    computed.status === "no_risk" &&
    existing?.expiryStatus === "extended" &&
    waiverLedger.waiverStatus === "waived" &&
    waiverLedger.waiverExpiresAt !== null &&
    waiverLedger.waiverExpiresAt > now
  ) {
    expiryStatus = "extended"
  }
  return {
    id: alertWaiverExpiryDigestId(waiverLedger.matterId),
    firmId: waiverLedger.firmId,
    matterId: waiverLedger.matterId,
    enforcementWaiverLedgerId: waiverLedger.id,
    classification: waiverLedger.classification,
    expiryStatus,
    waiverStatusSnapshot: waiverLedger.waiverStatus,
    waiverExpiresAt: waiverLedger.waiverExpiresAt,
    msUntilExpiry: computed.msUntilExpiry,
    acknowledgedBy: existing?.acknowledgedBy ?? null,
    acknowledgedAt: existing?.acknowledgedAt ?? null,
    extendedBy: existing?.extendedBy ?? null,
    extendedAt: existing?.extendedAt ?? null,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? null,
    freshnessStatus: asWaiverExpiryFreshnessStatus(waiverLedger.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `waiver_status:${waiverLedger.waiverStatus}`,
      `expiry_status:${computed.status}`,
      ...waiverLedger.provenanceTags.map((tag) => `waiver_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertVarianceRemediationSlaLedgerRow(params: {
  remediationQueue: WorkflowOpsAlertVarianceRemediationQueueRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertVarianceRemediationSlaLedgerRow | null
  now: number
}): WorkflowOpsAlertVarianceRemediationSlaLedgerRow {
  const { remediationQueue, actorId, reason, existing, now } = params
  const slaStartedAt =
    remediationQueue.assignedAt ??
    remediationQueue.queuedAt ??
    remediationQueue.lastStatusChangedAt ??
    null
  const elapsedMs = slaStartedAt === null ? null : Math.max(now - slaStartedAt, 0)
  const warningDueAt =
    remediationQueue.queueStatus === "not_queued" || slaStartedAt === null
      ? null
      : slaStartedAt + VARIANCE_REMEDIATION_SLA_WARNING_MS
  const breachDueAt =
    remediationQueue.queueStatus === "not_queued" || slaStartedAt === null
      ? null
      : slaStartedAt + VARIANCE_REMEDIATION_SLA_BREACH_MS
  let computedStatus: WorkflowOpsAlertVarianceRemediationSlaLedgerStatus
  if (remediationQueue.queueStatus === "not_queued") {
    computedStatus = "not_applicable"
  } else if (remediationQueue.queueStatus === "resolved") {
    computedStatus = "resolved"
  } else if (elapsedMs !== null && elapsedMs >= VARIANCE_REMEDIATION_SLA_BREACH_MS) {
    computedStatus = "breached"
  } else if (elapsedMs !== null && elapsedMs >= VARIANCE_REMEDIATION_SLA_WARNING_MS) {
    computedStatus = "warning"
  } else {
    computedStatus = "within_sla"
  }

  let slaStatus = computedStatus
  if (
    existing?.slaStatus === "acknowledged" &&
    (computedStatus === "within_sla" || computedStatus === "warning" || computedStatus === "breached")
  ) {
    slaStatus = "acknowledged"
  }

  return {
    id: alertVarianceRemediationSlaLedgerId(remediationQueue.matterId),
    firmId: remediationQueue.firmId,
    matterId: remediationQueue.matterId,
    remediationQueueId: remediationQueue.id,
    classification: remediationQueue.classification,
    slaStatus,
    queueStatusSnapshot: remediationQueue.queueStatus,
    ownerIdSnapshot: remediationQueue.ownerId,
    slaStartedAt,
    warningThresholdMs: VARIANCE_REMEDIATION_SLA_WARNING_MS,
    breachThresholdMs: VARIANCE_REMEDIATION_SLA_BREACH_MS,
    warningDueAt,
    breachDueAt,
    elapsedMs,
    acknowledgedBy: existing?.acknowledgedBy ?? null,
    acknowledgedAt: existing?.acknowledgedAt ?? null,
    resolvedBy: existing?.resolvedBy ?? null,
    resolvedAt: existing?.resolvedAt ?? null,
    resolutionReason: existing?.resolutionReason ?? null,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? null,
    freshnessStatus: asVarianceRemediationSlaFreshnessStatus(remediationQueue.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `queue_status:${remediationQueue.queueStatus}`,
      `sla_status:${computedStatus}`,
      ...remediationQueue.provenanceTags.map((tag) => `queue_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function buildWorkflowOpsAlertWaiverExpiryDisputeRow(params: {
  waiverExpiryDigest: WorkflowOpsAlertWaiverExpiryDigestRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertWaiverExpiryDisputeRow | null
  now: number
}): WorkflowOpsAlertWaiverExpiryDisputeRow {
  const { waiverExpiryDigest, actorId, reason, existing, now } = params
  const disputeStatus = existing?.disputeStatus ?? "not_contested"
  return {
    id: alertWaiverExpiryDisputeId(waiverExpiryDigest.matterId),
    firmId: waiverExpiryDigest.firmId,
    matterId: waiverExpiryDigest.matterId,
    waiverExpiryDigestId: waiverExpiryDigest.id,
    classification: waiverExpiryDigest.classification,
    disputeStatus,
    contestedExpiryStatusSnapshot: waiverExpiryDigest.expiryStatus,
    waiverExpiresAtSnapshot: waiverExpiryDigest.waiverExpiresAt,
    openedBy: existing?.openedBy ?? null,
    openedAt: existing?.openedAt ?? null,
    reviewerId: existing?.reviewerId ?? null,
    reviewAssignedAt: existing?.reviewAssignedAt ?? null,
    resolvedBy: existing?.resolvedBy ?? null,
    resolvedAt: existing?.resolvedAt ?? null,
    resolutionOutcome: existing?.resolutionOutcome ?? null,
    resolutionReason: existing?.resolutionReason ?? null,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? null,
    freshnessStatus: asWaiverExpiryDisputeFreshnessStatus(waiverExpiryDigest.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `expiry_status:${waiverExpiryDigest.expiryStatus}`,
      ...waiverExpiryDigest.provenanceTags.map((tag) => `waiver_expiry_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function computeDefaultRemediationSlaBreachEscalationStatus(
  slaStatus: WorkflowOpsAlertVarianceRemediationSlaLedgerStatus
): WorkflowOpsAlertVarianceRemediationSlaBreachEscalationStatus {
  if (slaStatus === "breached" || slaStatus === "acknowledged") return "open"
  return "not_required"
}

function buildWorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow(params: {
  remediationSlaLedger: WorkflowOpsAlertVarianceRemediationSlaLedgerRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow | null
  now: number
}): WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow {
  const { remediationSlaLedger, actorId, reason, existing, now } = params
  const computedStatus = computeDefaultRemediationSlaBreachEscalationStatus(remediationSlaLedger.slaStatus)
  let escalationStatus = existing?.escalationStatus ?? computedStatus
  if (computedStatus === "not_required" && escalationStatus !== "resolved") {
    escalationStatus = "not_required"
  }
  if (computedStatus === "open" && escalationStatus === "not_required") {
    escalationStatus = "open"
  }

  const openedAt =
    escalationStatus === "open" || escalationStatus === "assigned"
      ? existing?.openedAt ?? now
      : existing?.openedAt ?? null
  const resolvedAt = escalationStatus === "resolved" ? existing?.resolvedAt ?? now : null
  const resolutionReason = escalationStatus === "resolved" ? existing?.resolutionReason ?? null : null

  return {
    id: alertVarianceRemediationSlaBreachEscalationId(remediationSlaLedger.matterId),
    firmId: remediationSlaLedger.firmId,
    matterId: remediationSlaLedger.matterId,
    remediationSlaLedgerId: remediationSlaLedger.id,
    classification: remediationSlaLedger.classification,
    escalationStatus,
    slaStatusSnapshot: remediationSlaLedger.slaStatus,
    queueStatusSnapshot: remediationSlaLedger.queueStatusSnapshot,
    ownerId: existing?.ownerId ?? remediationSlaLedger.ownerIdSnapshot ?? null,
    openedAt,
    resolvedAt,
    resolutionReason,
    breachDueAtSnapshot: remediationSlaLedger.breachDueAt,
    elapsedMsSnapshot: remediationSlaLedger.elapsedMs,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? openedAt,
    freshnessStatus: asRemediationSlaBreachEscalationFreshnessStatus(remediationSlaLedger.recomputedAt, now),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `sla_status:${remediationSlaLedger.slaStatus}`,
      `queue_status:${remediationSlaLedger.queueStatusSnapshot}`,
      ...remediationSlaLedger.provenanceTags.map((tag) => `sla_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function computeDefaultWaiverExpiryDisputeAdjudicationStatus(
  disputeStatus: WorkflowOpsAlertWaiverExpiryDisputeStatus
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationStatus {
  if (disputeStatus === "not_contested") return "not_required"
  if (disputeStatus === "resolved") return "resolved"
  return "open"
}

function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow(params: {
  waiverExpiryDispute: WorkflowOpsAlertWaiverExpiryDisputeRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow | null
  now: number
}): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow {
  const { waiverExpiryDispute, actorId, reason, existing, now } = params
  const computedStatus = computeDefaultWaiverExpiryDisputeAdjudicationStatus(
    waiverExpiryDispute.disputeStatus
  )
  let adjudicationStatus = existing?.adjudicationStatus ?? computedStatus
  if (computedStatus === "not_required" && adjudicationStatus !== "resolved") {
    adjudicationStatus = "not_required"
  }
  if (computedStatus === "open" && adjudicationStatus === "not_required") {
    adjudicationStatus = "open"
  }

  const openedAt =
    adjudicationStatus === "open" ||
    adjudicationStatus === "panel_assigned" ||
    adjudicationStatus === "resolved"
      ? existing?.openedAt ?? now
      : null
  const dueAt =
    adjudicationStatus === "open" || adjudicationStatus === "panel_assigned"
      ? existing?.dueAt ?? (openedAt !== null ? openedAt + WAIVER_EXPIRY_DISPUTE_ADJUDICATION_DUE_MS : null)
      : null
  const resolvedAt = adjudicationStatus === "resolved" ? existing?.resolvedAt ?? now : null
  const resolutionOutcome = adjudicationStatus === "resolved" ? existing?.resolutionOutcome ?? null : null
  const resolutionReason = adjudicationStatus === "resolved" ? existing?.resolutionReason ?? null : null

  return {
    id: alertWaiverExpiryDisputeAdjudicationId(waiverExpiryDispute.matterId),
    firmId: waiverExpiryDispute.firmId,
    matterId: waiverExpiryDispute.matterId,
    waiverExpiryDisputeId: waiverExpiryDispute.id,
    classification: waiverExpiryDispute.classification,
    adjudicationStatus,
    disputeStatusSnapshot: waiverExpiryDispute.disputeStatus,
    requestedOutcome: waiverExpiryDispute.resolutionOutcome,
    panelOwnerId: existing?.panelOwnerId ?? waiverExpiryDispute.reviewerId ?? null,
    openedAt,
    dueAt,
    resolvedAt,
    resolutionOutcome,
    resolutionReason,
    reopenPressureCount: existing?.reopenPressureCount ?? 0,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? openedAt,
    freshnessStatus: asWaiverExpiryDisputeAdjudicationFreshnessStatus(
      waiverExpiryDispute.recomputedAt,
      now
    ),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `dispute_status:${waiverExpiryDispute.disputeStatus}`,
      ...waiverExpiryDispute.provenanceTags.map((tag) => `waiver_expiry_dispute_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function computeDefaultRemediationSlaBreachResolutionCheckpointStatus(
  escalationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationStatus
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointStatus {
  if (escalationStatus === "not_required") return "not_required"
  return "open"
}

function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow(params: {
  remediationSlaBreachEscalation: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow | null
  now: number
}): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow {
  const { remediationSlaBreachEscalation, actorId, reason, existing, now } = params
  const computedStatus = computeDefaultRemediationSlaBreachResolutionCheckpointStatus(
    remediationSlaBreachEscalation.escalationStatus
  )
  let checkpointStatus = existing?.checkpointStatus ?? computedStatus
  if (computedStatus === "not_required" && checkpointStatus !== "checkpoint_recorded") {
    checkpointStatus = "not_required"
  }
  if (computedStatus === "open" && checkpointStatus === "not_required") {
    checkpointStatus = "open"
  }

  const openedAt =
    checkpointStatus === "open" ||
    checkpointStatus === "reopened" ||
    checkpointStatus === "checkpoint_recorded"
      ? existing?.openedAt ?? now
      : null
  const dueAt =
    checkpointStatus === "open" || checkpointStatus === "reopened"
      ? existing?.dueAt ??
        (openedAt !== null ? openedAt + REMEDIATION_SLA_BREACH_RESOLUTION_CHECKPOINT_DUE_MS : null)
      : null
  const checkpointRecordedAt =
    checkpointStatus === "checkpoint_recorded" ? existing?.checkpointRecordedAt ?? now : null
  const reopenedAt = checkpointStatus === "reopened" ? existing?.reopenedAt ?? now : null
  const resolutionNote =
    checkpointStatus === "checkpoint_recorded" || checkpointStatus === "reopened"
      ? existing?.resolutionNote ?? null
      : null

  return {
    id: alertVarianceRemediationSlaBreachResolutionCheckpointId(remediationSlaBreachEscalation.matterId),
    firmId: remediationSlaBreachEscalation.firmId,
    matterId: remediationSlaBreachEscalation.matterId,
    remediationSlaBreachEscalationId: remediationSlaBreachEscalation.id,
    classification: remediationSlaBreachEscalation.classification,
    checkpointStatus,
    escalationStatusSnapshot: remediationSlaBreachEscalation.escalationStatus,
    ownerIdSnapshot: remediationSlaBreachEscalation.ownerId,
    checkpointOwnerId:
      existing?.checkpointOwnerId ?? remediationSlaBreachEscalation.ownerId ?? null,
    openedAt,
    dueAt,
    checkpointRecordedAt,
    reopenedAt,
    resolutionNote,
    reopenPressureCount: existing?.reopenPressureCount ?? 0,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? openedAt,
    freshnessStatus: asRemediationSlaBreachResolutionCheckpointFreshnessStatus(
      remediationSlaBreachEscalation.recomputedAt,
      now
    ),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `escalation_status:${remediationSlaBreachEscalation.escalationStatus}`,
      ...remediationSlaBreachEscalation.provenanceTags.map((tag) => `sla_breach_escalation_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function computeDefaultWaiverExpiryDisputeAdjudicationSloStatus(
  adjudicationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationStatus
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipStatus {
  if (adjudicationStatus === "not_required") return "not_required"
  return "watch"
}

function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow(params: {
  waiverExpiryDisputeAdjudication: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow | null
  now: number
}): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow {
  const { waiverExpiryDisputeAdjudication, actorId, reason, existing, now } = params
  const computedStatus = computeDefaultWaiverExpiryDisputeAdjudicationSloStatus(
    waiverExpiryDisputeAdjudication.adjudicationStatus
  )
  let sloStatus = existing?.sloStatus ?? computedStatus
  if (computedStatus === "not_required" && sloStatus !== "breach_acknowledged") {
    sloStatus = "not_required"
  }
  if (computedStatus === "watch" && sloStatus === "not_required") {
    sloStatus = "watch"
  }

  const openedAt =
    sloStatus === "watch" || sloStatus === "deadline_extended" || sloStatus === "breach_acknowledged"
      ? existing?.openedAt ?? now
      : null
  const dueAtSnapshot = waiverExpiryDisputeAdjudication.dueAt ?? existing?.extendedDueAt ?? null

  return {
    id: alertWaiverExpiryDisputeAdjudicationSloStewardshipId(waiverExpiryDisputeAdjudication.matterId),
    firmId: waiverExpiryDisputeAdjudication.firmId,
    matterId: waiverExpiryDisputeAdjudication.matterId,
    waiverExpiryDisputeAdjudicationId: waiverExpiryDisputeAdjudication.id,
    classification: waiverExpiryDisputeAdjudication.classification,
    sloStatus,
    adjudicationStatusSnapshot: waiverExpiryDisputeAdjudication.adjudicationStatus,
    panelOwnerIdSnapshot: waiverExpiryDisputeAdjudication.panelOwnerId,
    dueAtSnapshot,
    dueWindowDebtMs: computeDueWindowDebtMs(dueAtSnapshot, now),
    stewardId: existing?.stewardId ?? waiverExpiryDisputeAdjudication.panelOwnerId ?? null,
    openedAt,
    deadlineExtendedAt: sloStatus === "deadline_extended" ? existing?.deadlineExtendedAt ?? now : existing?.deadlineExtendedAt ?? null,
    extendedDueAt: sloStatus === "deadline_extended" ? existing?.extendedDueAt ?? null : existing?.extendedDueAt ?? null,
    breachAcknowledgedAt:
      sloStatus === "breach_acknowledged" ? existing?.breachAcknowledgedAt ?? now : existing?.breachAcknowledgedAt ?? null,
    sloNote: existing?.sloNote ?? null,
    reopenPressureCount:
      existing?.reopenPressureCount ?? waiverExpiryDisputeAdjudication.reopenPressureCount,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? openedAt,
    freshnessStatus: asWaiverExpiryDisputeAdjudicationSloFreshnessStatus(
      waiverExpiryDisputeAdjudication.recomputedAt,
      now
    ),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `adjudication_status:${waiverExpiryDisputeAdjudication.adjudicationStatus}`,
      ...waiverExpiryDisputeAdjudication.provenanceTags.map((tag) => `waiver_expiry_adjudication_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function computeDefaultRemediationSlaBreachResolutionCheckpointExpiryAttestationStatus(
  checkpointStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointStatus
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationStatus {
  if (checkpointStatus === "not_required") return "not_required"
  return "open"
}

function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow(params: {
  remediationSlaBreachResolutionCheckpoint: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow | null
  now: number
}): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow {
  const { remediationSlaBreachResolutionCheckpoint, actorId, reason, existing, now } = params
  const computedStatus = computeDefaultRemediationSlaBreachResolutionCheckpointExpiryAttestationStatus(
    remediationSlaBreachResolutionCheckpoint.checkpointStatus
  )
  let attestationStatus = existing?.attestationStatus ?? computedStatus
  if (computedStatus === "not_required" && attestationStatus !== "expiry_acknowledged") {
    attestationStatus = "not_required"
  }
  if (computedStatus === "open" && attestationStatus === "not_required") {
    attestationStatus = "open"
  }

  return {
    id: alertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationId(
      remediationSlaBreachResolutionCheckpoint.matterId
    ),
    firmId: remediationSlaBreachResolutionCheckpoint.firmId,
    matterId: remediationSlaBreachResolutionCheckpoint.matterId,
    remediationSlaBreachResolutionCheckpointId: remediationSlaBreachResolutionCheckpoint.id,
    classification: remediationSlaBreachResolutionCheckpoint.classification,
    attestationStatus,
    checkpointStatusSnapshot: remediationSlaBreachResolutionCheckpoint.checkpointStatus,
    dueAtSnapshot: remediationSlaBreachResolutionCheckpoint.dueAt,
    expiryRiskStatus: computeCheckpointExpiryRiskStatus(
      remediationSlaBreachResolutionCheckpoint.dueAt,
      now
    ),
    attestedBy: attestationStatus === "attested" || attestationStatus === "expiry_acknowledged"
      ? existing?.attestedBy ?? null
      : existing?.attestedBy ?? null,
    attestedAt: attestationStatus === "attested" || attestationStatus === "expiry_acknowledged"
      ? existing?.attestedAt ?? null
      : existing?.attestedAt ?? null,
    expiryAcknowledgedBy:
      attestationStatus === "expiry_acknowledged" ? existing?.expiryAcknowledgedBy ?? null : existing?.expiryAcknowledgedBy ?? null,
    expiryAcknowledgedAt:
      attestationStatus === "expiry_acknowledged" ? existing?.expiryAcknowledgedAt ?? null : existing?.expiryAcknowledgedAt ?? null,
    attestationNote: existing?.attestationNote ?? null,
    reopenPressureCount:
      existing?.reopenPressureCount ?? remediationSlaBreachResolutionCheckpoint.reopenPressureCount,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? (attestationStatus === "not_required" ? null : now),
    freshnessStatus: asRemediationSlaBreachResolutionCheckpointExpiryAttestationFreshnessStatus(
      remediationSlaBreachResolutionCheckpoint.recomputedAt,
      now
    ),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `checkpoint_status:${remediationSlaBreachResolutionCheckpoint.checkpointStatus}`,
      ...remediationSlaBreachResolutionCheckpoint.provenanceTags.map(
        (tag) => `sla_breach_resolution_checkpoint_${tag}`
      ),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function computeDefaultWaiverExpiryDisputeAdjudicationSloDebtStatus(
  sloStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipStatus
): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationStatus {
  if (sloStatus === "not_required") return "not_required"
  if (sloStatus === "breach_acknowledged") return "debt_watch"
  return "not_required"
}

function buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow(params: {
  waiverExpiryDisputeAdjudicationSlo: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow | null
  now: number
}): WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow {
  const { waiverExpiryDisputeAdjudicationSlo, actorId, reason, existing, now } = params
  const computedStatus = computeDefaultWaiverExpiryDisputeAdjudicationSloDebtStatus(
    waiverExpiryDisputeAdjudicationSlo.sloStatus
  )
  let debtStatus = existing?.debtStatus ?? computedStatus
  if (computedStatus === "not_required" && debtStatus !== "breach_closure_attested") {
    debtStatus = "not_required"
  }
  if (computedStatus === "debt_watch" && debtStatus === "not_required") {
    debtStatus = "debt_watch"
  }
  if (
    existing &&
    (existing.debtStatus === "remediation_recorded" ||
      existing.debtStatus === "tier_downshifted" ||
      existing.debtStatus === "breach_closure_attested")
  ) {
    debtStatus = existing.debtStatus
  }

  return {
    id: alertWaiverExpiryDisputeAdjudicationSloDebtRemediationId(
      waiverExpiryDisputeAdjudicationSlo.matterId
    ),
    firmId: waiverExpiryDisputeAdjudicationSlo.firmId,
    matterId: waiverExpiryDisputeAdjudicationSlo.matterId,
    waiverExpiryDisputeAdjudicationSloStewardshipId: waiverExpiryDisputeAdjudicationSlo.id,
    classification: waiverExpiryDisputeAdjudicationSlo.classification,
    debtStatus,
    sloStatusSnapshot: waiverExpiryDisputeAdjudicationSlo.sloStatus,
    dueWindowDebtMsSnapshot: waiverExpiryDisputeAdjudicationSlo.dueWindowDebtMs,
    debtRetiredMs: existing?.debtRetiredMs ?? 0,
    remediationRecordedBy: existing?.remediationRecordedBy ?? null,
    remediationRecordedAt: existing?.remediationRecordedAt ?? null,
    tierDownshiftedBy: existing?.tierDownshiftedBy ?? null,
    tierDownshiftedAt: existing?.tierDownshiftedAt ?? null,
    breachClosureAttestedBy: existing?.breachClosureAttestedBy ?? null,
    breachClosureAttestedAt: existing?.breachClosureAttestedAt ?? null,
    remediationNote: existing?.remediationNote ?? null,
    reopenPressureCount:
      existing?.reopenPressureCount ?? waiverExpiryDisputeAdjudicationSlo.reopenPressureCount,
    lastStatusChangedAt: existing?.lastStatusChangedAt ?? (debtStatus === "not_required" ? null : now),
    freshnessStatus: asWaiverExpiryDisputeAdjudicationSloDebtRemediationFreshnessStatus(
      waiverExpiryDisputeAdjudicationSlo.recomputedAt,
      now
    ),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `slo_status:${waiverExpiryDisputeAdjudicationSlo.sloStatus}`,
      ...waiverExpiryDisputeAdjudicationSlo.provenanceTags.map((tag) => `slo_stewardship_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

function computeDefaultRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionStatus(
  attestation: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow,
  now: number
): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationStatus {
  if (attestation.attestationStatus === "not_required") return "not_required"
  if (
    attestation.attestationStatus === "expiry_acknowledged" ||
    attestation.expiryRiskStatus === "expired"
  ) {
    return "exception_open"
  }
  return "not_required"
}

function buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow(params: {
  expiryAttestation: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow
  actorId: string
  reason: string
  existing: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow | null
  now: number
}): WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow {
  const { expiryAttestation, actorId, reason, existing, now } = params
  const computedStatus =
    computeDefaultRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionStatus(
      expiryAttestation,
      now
    )
  let exceptionStatus = existing?.exceptionStatus ?? computedStatus
  if (computedStatus === "not_required" && exceptionStatus !== "exception_reconciled") {
    exceptionStatus = "not_required"
  }
  if (computedStatus === "exception_open" && exceptionStatus === "not_required") {
    exceptionStatus = "exception_open"
  }
  if (
    existing &&
    (existing.exceptionStatus === "exception_open" ||
      existing.exceptionStatus === "exception_assigned" ||
      existing.exceptionStatus === "exception_reconciled")
  ) {
    exceptionStatus = existing.exceptionStatus
  }

  const overdueExceptionCount =
    expiryAttestation.expiryRiskStatus === "expired"
      ? Math.max(existing?.overdueExceptionCount ?? 0, 1)
      : existing?.overdueExceptionCount ?? 0

  return {
    id: alertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationId(
      expiryAttestation.matterId
    ),
    firmId: expiryAttestation.firmId,
    matterId: expiryAttestation.matterId,
    expiryAttestationId: expiryAttestation.id,
    classification: expiryAttestation.classification,
    exceptionStatus,
    attestationStatusSnapshot: expiryAttestation.attestationStatus,
    expiryRiskStatusSnapshot: expiryAttestation.expiryRiskStatus,
    exceptionOpenedBy: existing?.exceptionOpenedBy ?? null,
    exceptionOpenedAt: existing?.exceptionOpenedAt ?? null,
    assigneeId: existing?.assigneeId ?? null,
    assigneeAssignedAt: existing?.assigneeAssignedAt ?? null,
    reconciledBy: existing?.reconciledBy ?? null,
    reconciledAt: existing?.reconciledAt ?? null,
    overdueExceptionCount,
    reconciliationNote: existing?.reconciliationNote ?? null,
    reopenPressureCount: existing?.reopenPressureCount ?? expiryAttestation.reopenPressureCount,
    lastStatusChangedAt:
      existing?.lastStatusChangedAt ?? (exceptionStatus === "not_required" ? null : now),
    freshnessStatus:
      asRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationFreshnessStatus(
        expiryAttestation.recomputedAt,
        now
      ),
    provenanceTags: normalizeProvenanceTags([
      `reason:${reason}`,
      `attestation_status:${expiryAttestation.attestationStatus}`,
      ...expiryAttestation.provenanceTags.map((tag) => `expiry_attestation_${tag}`),
    ]),
    recomputedAt: now,
    recomputedBy: actorId,
    recomputeReason: reason,
    updatedAt: now,
  }
}

async function resolveActor(params: {
  actorId: string
  store: ReturnType<typeof getRuntimeStore>
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
}): Promise<User | null> {
  const { actorId, store, repos } = params
  const local = store.users.get(actorId)
  if (local) return local
  const persisted = await repos.users.get(actorId)
  if (!persisted) return null
  store.users.set(persisted.id, persisted)
  return persisted
}

async function resolveMatter(params: {
  matterId: string
  store: ReturnType<typeof getRuntimeStore>
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
}): Promise<Matter | null> {
  const { matterId, store, repos } = params
  const local = store.matters.get(matterId)
  if (local) return local
  const persisted = await repos.matters.get(matterId)
  if (!persisted) return null
  store.matters.set(persisted.id, persisted)
  return persisted
}

async function ensureWorkflowOpsAlertDigests(params: {
  actorId: string
  actorFirmId: string
  reason: string
  store: ReturnType<typeof getRuntimeStore>
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
}): Promise<WorkflowOpsAlertDigestRow[]> {
  const { actorId, actorFirmId, reason, store, repos } = params
  const matters = await repos.matters.listByFirm(actorFirmId)
  for (const matter of matters) {
    store.matters.set(matter.id, matter)
  }
  const matterById = new Map(matters.map((matter) => [matter.id, matter]))
  const activities = await repos.workflowOpsActivity.listByFirm(actorFirmId)
  const followUps = await repos.followUps.listByFirm(actorFirmId)
  const now = Date.now()
  const matterIds = new Set<string>()
  for (const row of activities) {
    if (row.matterId) matterIds.add(row.matterId)
  }
  for (const row of followUps) {
    matterIds.add(row.matterId)
  }
  const rows: WorkflowOpsAlertDigestRow[] = []
  for (const matterId of [...matterIds].sort((a, b) => a.localeCompare(b))) {
    const matter = matterById.get(matterId)
    if (!matter) continue
    const existing = await repos.workflowOpsAlertDigests.get(alertDigestId(matter.id))
    const digest = buildWorkflowOpsAlertDigest({
      firmId: actorFirmId,
      matter,
      actorId,
      reason,
      activities: activities.filter((row) => row.matterId === matter.id),
      followUps: followUps.filter((row) => row.matterId === matter.id),
      existing,
      now,
    })
    await repos.workflowOpsAlertDigests.upsert(digest)
    store.workflowOpsAlertDigests.set(digest.id, digest)
    rows.push(digest)
  }
  return rows
}

async function ensureWorkflowOpsAlertGovernanceRows(params: {
  digests: WorkflowOpsAlertDigestRow[]
  actorId: string
  reason: string
  store: ReturnType<typeof getRuntimeStore>
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>
}): Promise<{
  attestations: WorkflowOpsAlertAttestationRow[]
  escalationLedgers: WorkflowOpsAlertEscalationLedgerRow[]
  attestationDisputes: WorkflowOpsAlertAttestationDisputeRow[]
  escalationClosures: WorkflowOpsAlertEscalationClosureRow[]
  disputeEnforcementLedgers: WorkflowOpsAlertDisputeEnforcementLedgerRow[]
  closureDebtReconciliationDigests: WorkflowOpsAlertClosureDebtReconciliationDigestRow[]
  enforcementAttestations: WorkflowOpsAlertEnforcementAttestationRow[]
  closureDebtVarianceDigests: WorkflowOpsAlertClosureDebtVarianceDigestRow[]
  enforcementWaiverLedgers: WorkflowOpsAlertEnforcementWaiverLedgerRow[]
  varianceRemediationQueues: WorkflowOpsAlertVarianceRemediationQueueRow[]
  waiverExpiryDigests: WorkflowOpsAlertWaiverExpiryDigestRow[]
  varianceRemediationSlaLedgers: WorkflowOpsAlertVarianceRemediationSlaLedgerRow[]
  waiverExpiryDisputes: WorkflowOpsAlertWaiverExpiryDisputeRow[]
  varianceRemediationSlaBreachEscalations: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow[]
  waiverExpiryDisputeAdjudications: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow[]
  varianceRemediationSlaBreachResolutionCheckpoints: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow[]
  waiverExpiryDisputeAdjudicationSloStewardships: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow[]
  varianceRemediationSlaBreachResolutionCheckpointExpiryAttestations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow[]
  waiverExpiryDisputeAdjudicationSloDebtRemediations: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow[]
  varianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow[]
}> {
  const { digests, actorId, reason, store, repos } = params
  const now = Date.now()
  const attestations: WorkflowOpsAlertAttestationRow[] = []
  const escalationLedgers: WorkflowOpsAlertEscalationLedgerRow[] = []
  const attestationDisputes: WorkflowOpsAlertAttestationDisputeRow[] = []
  const escalationClosures: WorkflowOpsAlertEscalationClosureRow[] = []
  const disputeEnforcementLedgers: WorkflowOpsAlertDisputeEnforcementLedgerRow[] = []
  const closureDebtReconciliationDigests: WorkflowOpsAlertClosureDebtReconciliationDigestRow[] = []
  const enforcementAttestations: WorkflowOpsAlertEnforcementAttestationRow[] = []
  const closureDebtVarianceDigests: WorkflowOpsAlertClosureDebtVarianceDigestRow[] = []
  const enforcementWaiverLedgers: WorkflowOpsAlertEnforcementWaiverLedgerRow[] = []
  const varianceRemediationQueues: WorkflowOpsAlertVarianceRemediationQueueRow[] = []
  const waiverExpiryDigests: WorkflowOpsAlertWaiverExpiryDigestRow[] = []
  const varianceRemediationSlaLedgers: WorkflowOpsAlertVarianceRemediationSlaLedgerRow[] = []
  const waiverExpiryDisputes: WorkflowOpsAlertWaiverExpiryDisputeRow[] = []
  const varianceRemediationSlaBreachEscalations: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow[] = []
  const waiverExpiryDisputeAdjudications: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow[] = []
  const varianceRemediationSlaBreachResolutionCheckpoints: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow[] = []
  const waiverExpiryDisputeAdjudicationSloStewardships: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow[] = []
  const varianceRemediationSlaBreachResolutionCheckpointExpiryAttestations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow[] = []
  const waiverExpiryDisputeAdjudicationSloDebtRemediations: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow[] =
    []
  const varianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow[] =
    []

  for (const digest of digests) {
    if (!digest.matterId) continue
    const attestationKey = alertAttestationId(digest.matterId)
    const escalationKey = alertEscalationLedgerId(digest.matterId)
    const disputeKey = alertAttestationDisputeId(digest.matterId)
    const closureKey = alertEscalationClosureId(digest.matterId)
    const enforcementKey = alertDisputeEnforcementLedgerId(digest.matterId)
    const reconciliationKey = alertClosureDebtReconciliationDigestId(digest.matterId)
    const enforcementAttestationKey = alertEnforcementAttestationId(digest.matterId)
    const varianceKey = alertClosureDebtVarianceDigestId(digest.matterId)
    const waiverKey = alertEnforcementWaiverLedgerId(digest.matterId)
    const remediationQueueKey = alertVarianceRemediationQueueId(digest.matterId)
    const waiverExpiryKey = alertWaiverExpiryDigestId(digest.matterId)
    const remediationSlaKey = alertVarianceRemediationSlaLedgerId(digest.matterId)
    const waiverExpiryDisputeKey = alertWaiverExpiryDisputeId(digest.matterId)
    const remediationSlaBreachEscalationKey = alertVarianceRemediationSlaBreachEscalationId(digest.matterId)
    const waiverExpiryDisputeAdjudicationKey = alertWaiverExpiryDisputeAdjudicationId(digest.matterId)
    const remediationSlaBreachResolutionCheckpointKey =
      alertVarianceRemediationSlaBreachResolutionCheckpointId(digest.matterId)
    const waiverExpiryDisputeAdjudicationSloKey =
      alertWaiverExpiryDisputeAdjudicationSloStewardshipId(digest.matterId)
    const remediationSlaBreachResolutionCheckpointExpiryAttestationKey =
      alertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationId(digest.matterId)
    const waiverExpiryDisputeAdjudicationSloDebtRemediationKey =
      alertWaiverExpiryDisputeAdjudicationSloDebtRemediationId(digest.matterId)
    const remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationKey =
      alertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationId(
        digest.matterId
      )
    const existingAttestation = await repos.workflowOpsAlertAttestations.get(attestationKey)
    const existingEscalation = await repos.workflowOpsAlertEscalationLedgers.get(escalationKey)
    const existingDispute = await repos.workflowOpsAlertAttestationDisputes.get(disputeKey)
    const existingClosure = await repos.workflowOpsAlertEscalationClosures.get(closureKey)
    const existingEnforcement = await repos.workflowOpsAlertDisputeEnforcementLedgers.get(enforcementKey)
    const existingReconciliation =
      await repos.workflowOpsAlertClosureDebtReconciliationDigests.get(reconciliationKey)
    const existingEnforcementAttestation =
      await repos.workflowOpsAlertEnforcementAttestations.get(enforcementAttestationKey)
    const existingVariance = await repos.workflowOpsAlertClosureDebtVarianceDigests.get(varianceKey)
    const existingWaiver = await repos.workflowOpsAlertEnforcementWaiverLedgers.get(waiverKey)
    const existingRemediationQueue =
      await repos.workflowOpsAlertVarianceRemediationQueues.get(remediationQueueKey)
    const existingWaiverExpiry = await repos.workflowOpsAlertWaiverExpiryDigests.get(waiverExpiryKey)
    const existingRemediationSla = await repos.workflowOpsAlertVarianceRemediationSlaLedgers.get(
      remediationSlaKey
    )
    const existingWaiverExpiryDispute =
      await repos.workflowOpsAlertWaiverExpiryDisputes.get(waiverExpiryDisputeKey)
    const existingRemediationSlaBreachEscalation =
      await repos.workflowOpsAlertVarianceRemediationSlaBreachEscalations.get(
        remediationSlaBreachEscalationKey
      )
    const existingWaiverExpiryDisputeAdjudication =
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudications.get(
        waiverExpiryDisputeAdjudicationKey
      )
    const existingRemediationSlaBreachResolutionCheckpoint =
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.get(
        remediationSlaBreachResolutionCheckpointKey
      )
    const existingWaiverExpiryDisputeAdjudicationSlo =
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.get(
        waiverExpiryDisputeAdjudicationSloKey
      )
    const existingRemediationSlaBreachResolutionCheckpointExpiryAttestation =
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.get(
        remediationSlaBreachResolutionCheckpointExpiryAttestationKey
      )
    const existingWaiverExpiryDisputeAdjudicationSloDebtRemediation =
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.get(
        waiverExpiryDisputeAdjudicationSloDebtRemediationKey
      )
    const existingRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation =
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.get(
        remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationKey
      )

    const attestation = buildWorkflowOpsAlertAttestationRow({
      digest,
      actorId,
      reason,
      existing: existingAttestation,
      now,
    })
    const escalation = buildWorkflowOpsAlertEscalationLedgerRow({
      digest,
      actorId,
      reason,
      existing: existingEscalation,
      now,
    })
    const dispute = buildWorkflowOpsAlertAttestationDisputeRow({
      attestation,
      actorId,
      reason,
      existing: existingDispute,
      now,
    })
    const closure = buildWorkflowOpsAlertEscalationClosureRow({
      escalation,
      actorId,
      reason,
      existing: existingClosure,
      now,
    })
    const enforcementLedger = buildWorkflowOpsAlertDisputeEnforcementLedgerRow({
      dispute,
      actorId,
      reason,
      existing: existingEnforcement,
      now,
    })
    const reconciliationDigest = buildWorkflowOpsAlertClosureDebtReconciliationDigestRow({
      closure,
      actorId,
      reason,
      existing: existingReconciliation,
      now,
    })
    const enforcementAttestation = buildWorkflowOpsAlertEnforcementAttestationRow({
      enforcement: enforcementLedger,
      actorId,
      reason,
      existing: existingEnforcementAttestation,
      now,
    })
    const varianceDigest = buildWorkflowOpsAlertClosureDebtVarianceDigestRow({
      reconciliation: reconciliationDigest,
      actorId,
      reason,
      existing: existingVariance,
      now,
    })
    const waiverLedger = buildWorkflowOpsAlertEnforcementWaiverLedgerRow({
      enforcement: enforcementLedger,
      enforcementAttestation,
      actorId,
      reason,
      existing: existingWaiver,
      now,
    })
    const remediationQueue = buildWorkflowOpsAlertVarianceRemediationQueueRow({
      variance: varianceDigest,
      actorId,
      reason,
      existing: existingRemediationQueue,
      now,
    })
    const waiverExpiryDigest = buildWorkflowOpsAlertWaiverExpiryDigestRow({
      waiverLedger,
      actorId,
      reason,
      existing: existingWaiverExpiry,
      now,
    })
    const remediationSlaLedger = buildWorkflowOpsAlertVarianceRemediationSlaLedgerRow({
      remediationQueue,
      actorId,
      reason,
      existing: existingRemediationSla,
      now,
    })
    const waiverExpiryDispute = buildWorkflowOpsAlertWaiverExpiryDisputeRow({
      waiverExpiryDigest,
      actorId,
      reason,
      existing: existingWaiverExpiryDispute,
      now,
    })
    const remediationSlaBreachEscalation =
      buildWorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow({
        remediationSlaLedger,
        actorId,
        reason,
        existing: existingRemediationSlaBreachEscalation,
        now,
      })
    const waiverExpiryDisputeAdjudication = buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow({
      waiverExpiryDispute,
      actorId,
      reason,
      existing: existingWaiverExpiryDisputeAdjudication,
      now,
    })
    const remediationSlaBreachResolutionCheckpoint =
      buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow({
        remediationSlaBreachEscalation,
        actorId,
        reason,
        existing: existingRemediationSlaBreachResolutionCheckpoint,
        now,
      })
    const waiverExpiryDisputeAdjudicationSloStewardship =
      buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow({
        waiverExpiryDisputeAdjudication,
        actorId,
        reason,
        existing: existingWaiverExpiryDisputeAdjudicationSlo,
        now,
      })
    const remediationSlaBreachResolutionCheckpointExpiryAttestation =
      buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow({
        remediationSlaBreachResolutionCheckpoint,
        actorId,
        reason,
        existing: existingRemediationSlaBreachResolutionCheckpointExpiryAttestation,
        now,
      })
    const waiverExpiryDisputeAdjudicationSloDebtRemediation =
      buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow({
        waiverExpiryDisputeAdjudicationSlo: waiverExpiryDisputeAdjudicationSloStewardship,
        actorId,
        reason,
        existing: existingWaiverExpiryDisputeAdjudicationSloDebtRemediation,
        now,
      })
    const waiverExpiryDisputeAdjudicationSloDebtRemediationToPersist =
      existingWaiverExpiryDisputeAdjudicationSloDebtRemediation &&
      (existingWaiverExpiryDisputeAdjudicationSloDebtRemediation.debtStatus ===
        "remediation_recorded" ||
        existingWaiverExpiryDisputeAdjudicationSloDebtRemediation.debtStatus ===
          "tier_downshifted" ||
        existingWaiverExpiryDisputeAdjudicationSloDebtRemediation.debtStatus ===
          "breach_closure_attested")
        ? existingWaiverExpiryDisputeAdjudicationSloDebtRemediation
        : waiverExpiryDisputeAdjudicationSloDebtRemediation
    const remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation =
      buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow(
        {
          expiryAttestation: remediationSlaBreachResolutionCheckpointExpiryAttestation,
          actorId,
          reason,
          existing: existingRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation,
          now,
        }
      )
    const remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationToPersist =
      existingRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation &&
      (existingRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
        .exceptionStatus === "exception_open" ||
        existingRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
          .exceptionStatus === "exception_assigned" ||
        existingRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
          .exceptionStatus === "exception_reconciled")
        ? existingRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
        : remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation

    await repos.workflowOpsAlertAttestations.upsert(attestation)
    await repos.workflowOpsAlertEscalationLedgers.upsert(escalation)
    await repos.workflowOpsAlertAttestationDisputes.upsert(dispute)
    await repos.workflowOpsAlertEscalationClosures.upsert(closure)
    await repos.workflowOpsAlertDisputeEnforcementLedgers.upsert(enforcementLedger)
    await repos.workflowOpsAlertClosureDebtReconciliationDigests.upsert(reconciliationDigest)
    await repos.workflowOpsAlertEnforcementAttestations.upsert(enforcementAttestation)
    await repos.workflowOpsAlertClosureDebtVarianceDigests.upsert(varianceDigest)
    await repos.workflowOpsAlertEnforcementWaiverLedgers.upsert(waiverLedger)
    await repos.workflowOpsAlertVarianceRemediationQueues.upsert(remediationQueue)
    await repos.workflowOpsAlertWaiverExpiryDigests.upsert(waiverExpiryDigest)
    await repos.workflowOpsAlertVarianceRemediationSlaLedgers.upsert(remediationSlaLedger)
    await repos.workflowOpsAlertWaiverExpiryDisputes.upsert(waiverExpiryDispute)
    await repos.workflowOpsAlertVarianceRemediationSlaBreachEscalations.upsert(
      remediationSlaBreachEscalation
    )
    await repos.workflowOpsAlertWaiverExpiryDisputeAdjudications.upsert(
      waiverExpiryDisputeAdjudication
    )
    await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.upsert(
      remediationSlaBreachResolutionCheckpoint
    )
    await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.upsert(
      waiverExpiryDisputeAdjudicationSloStewardship
    )
    await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.upsert(
      remediationSlaBreachResolutionCheckpointExpiryAttestation
    )
    await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.upsert(
      waiverExpiryDisputeAdjudicationSloDebtRemediationToPersist
    )
    await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.upsert(
      remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationToPersist
    )
    store.workflowOpsAlertAttestations.set(attestation.id, attestation)
    store.workflowOpsAlertEscalationLedgers.set(escalation.id, escalation)
    store.workflowOpsAlertAttestationDisputes.set(dispute.id, dispute)
    store.workflowOpsAlertEscalationClosures.set(closure.id, closure)
    store.workflowOpsAlertDisputeEnforcementLedgers.set(enforcementLedger.id, enforcementLedger)
    store.workflowOpsAlertClosureDebtReconciliationDigests.set(
      reconciliationDigest.id,
      reconciliationDigest
    )
    store.workflowOpsAlertEnforcementAttestations.set(
      enforcementAttestation.id,
      enforcementAttestation
    )
    store.workflowOpsAlertClosureDebtVarianceDigests.set(varianceDigest.id, varianceDigest)
    store.workflowOpsAlertEnforcementWaiverLedgers.set(waiverLedger.id, waiverLedger)
    store.workflowOpsAlertVarianceRemediationQueues.set(remediationQueue.id, remediationQueue)
    store.workflowOpsAlertWaiverExpiryDigests.set(waiverExpiryDigest.id, waiverExpiryDigest)
    store.workflowOpsAlertVarianceRemediationSlaLedgers.set(
      remediationSlaLedger.id,
      remediationSlaLedger
    )
    store.workflowOpsAlertWaiverExpiryDisputes.set(waiverExpiryDispute.id, waiverExpiryDispute)
    store.workflowOpsAlertVarianceRemediationSlaBreachEscalations.set(
      remediationSlaBreachEscalation.id,
      remediationSlaBreachEscalation
    )
    store.workflowOpsAlertWaiverExpiryDisputeAdjudications.set(
      waiverExpiryDisputeAdjudication.id,
      waiverExpiryDisputeAdjudication
    )
    store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.set(
      remediationSlaBreachResolutionCheckpoint.id,
      remediationSlaBreachResolutionCheckpoint
    )
    store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.set(
      waiverExpiryDisputeAdjudicationSloStewardship.id,
      waiverExpiryDisputeAdjudicationSloStewardship
    )
    store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.set(
      remediationSlaBreachResolutionCheckpointExpiryAttestation.id,
      remediationSlaBreachResolutionCheckpointExpiryAttestation
    )
    store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.set(
      waiverExpiryDisputeAdjudicationSloDebtRemediationToPersist.id,
      waiverExpiryDisputeAdjudicationSloDebtRemediationToPersist
    )
    store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.set(
      remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationToPersist.id,
      remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationToPersist
    )
    attestations.push(attestation)
    escalationLedgers.push(escalation)
    attestationDisputes.push(dispute)
    escalationClosures.push(closure)
    disputeEnforcementLedgers.push(enforcementLedger)
    closureDebtReconciliationDigests.push(reconciliationDigest)
    enforcementAttestations.push(enforcementAttestation)
    closureDebtVarianceDigests.push(varianceDigest)
    enforcementWaiverLedgers.push(waiverLedger)
    varianceRemediationQueues.push(remediationQueue)
    waiverExpiryDigests.push(waiverExpiryDigest)
    varianceRemediationSlaLedgers.push(remediationSlaLedger)
    waiverExpiryDisputes.push(waiverExpiryDispute)
    varianceRemediationSlaBreachEscalations.push(remediationSlaBreachEscalation)
    waiverExpiryDisputeAdjudications.push(waiverExpiryDisputeAdjudication)
    varianceRemediationSlaBreachResolutionCheckpoints.push(
      remediationSlaBreachResolutionCheckpoint
    )
    waiverExpiryDisputeAdjudicationSloStewardships.push(
      waiverExpiryDisputeAdjudicationSloStewardship
    )
    varianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.push(
      remediationSlaBreachResolutionCheckpointExpiryAttestation
    )
    waiverExpiryDisputeAdjudicationSloDebtRemediations.push(
      waiverExpiryDisputeAdjudicationSloDebtRemediationToPersist
    )
    varianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.push(
      remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationToPersist
    )
  }

  return {
    attestations,
    escalationLedgers,
    attestationDisputes,
    escalationClosures,
    disputeEnforcementLedgers,
    closureDebtReconciliationDigests,
    enforcementAttestations,
    closureDebtVarianceDigests,
    enforcementWaiverLedgers,
    varianceRemediationQueues,
    waiverExpiryDigests,
    varianceRemediationSlaLedgers,
    waiverExpiryDisputes,
    varianceRemediationSlaBreachEscalations,
    waiverExpiryDisputeAdjudications,
    varianceRemediationSlaBreachResolutionCheckpoints,
    waiverExpiryDisputeAdjudicationSloStewardships,
    varianceRemediationSlaBreachResolutionCheckpointExpiryAttestations,
    waiverExpiryDisputeAdjudicationSloDebtRemediations,
    varianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations,
  }
}

type ViewActivityBody = never

type AcknowledgeWorkflowOpsAlertDigestBody = {
  action: "acknowledge_workflow_ops_alert_digest"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type SnoozeWorkflowOpsAlertDigestBody = {
  action: "snooze_workflow_ops_alert_digest"
  actorId?: string
  matterId?: string
  snoozedUntil?: unknown
  reason?: unknown
}

type AttestWorkflowOpsAlertDigestBody = {
  action: "attest_workflow_ops_alert_digest"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type OpenWorkflowOpsAlertEscalationBody = {
  action: "open_workflow_ops_alert_escalation"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AssignWorkflowOpsAlertEscalationOwnerBody = {
  action: "assign_workflow_ops_alert_escalation_owner"
  actorId?: string
  matterId?: string
  ownerId?: unknown
  reason?: unknown
}

type ResolveWorkflowOpsAlertEscalationBody = {
  action: "resolve_workflow_ops_alert_escalation"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type OpenWorkflowOpsAlertAttestationDisputeBody = {
  action: "open_workflow_ops_alert_attestation_dispute"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AssignWorkflowOpsAlertAttestationDisputeReviewerBody = {
  action: "assign_workflow_ops_alert_attestation_dispute_reviewer"
  actorId?: string
  matterId?: string
  reviewerId?: unknown
  reason?: unknown
}

type ResolveWorkflowOpsAlertAttestationDisputeBody = {
  action: "resolve_workflow_ops_alert_attestation_dispute"
  actorId?: string
  matterId?: string
  resolutionOutcome?: unknown
  reason?: unknown
}

type CheckpointWorkflowOpsAlertEscalationClosureBody = {
  action: "checkpoint_workflow_ops_alert_escalation_closure"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type CloseWorkflowOpsAlertEscalationClosureBody = {
  action: "close_workflow_ops_alert_escalation_closure"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type ReopenWorkflowOpsAlertEscalationClosureBody = {
  action: "reopen_workflow_ops_alert_escalation_closure"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type StartWorkflowOpsAlertDisputeEnforcementBody = {
  action: "start_workflow_ops_alert_dispute_enforcement"
  actorId?: string
  matterId?: string
  ownerId?: unknown
  reason?: unknown
}

type CompleteWorkflowOpsAlertDisputeEnforcementBody = {
  action: "complete_workflow_ops_alert_dispute_enforcement"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type WaiveWorkflowOpsAlertDisputeEnforcementBody = {
  action: "waive_workflow_ops_alert_dispute_enforcement"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type FlagWorkflowOpsAlertClosureReopenDebtBody = {
  action: "flag_workflow_ops_alert_closure_reopen_debt"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type StartWorkflowOpsAlertClosureDebtReconciliationBody = {
  action: "start_workflow_ops_alert_closure_debt_reconciliation"
  actorId?: string
  matterId?: string
  ownerId?: unknown
  reason?: unknown
}

type ResolveWorkflowOpsAlertClosureDebtReconciliationBody = {
  action: "resolve_workflow_ops_alert_closure_debt_reconciliation"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AttestWorkflowOpsAlertDisputeEnforcementBody = {
  action: "attest_workflow_ops_alert_dispute_enforcement"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type ReopenWorkflowOpsAlertDisputeEnforcementAttestationBody = {
  action: "reopen_workflow_ops_alert_dispute_enforcement_attestation"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type OpenWorkflowOpsAlertClosureDebtVarianceBody = {
  action: "open_workflow_ops_alert_closure_debt_variance"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AssignWorkflowOpsAlertClosureDebtVarianceOwnerBody = {
  action: "assign_workflow_ops_alert_closure_debt_variance_owner"
  actorId?: string
  matterId?: string
  ownerId?: unknown
  reason?: unknown
}

type ResolveWorkflowOpsAlertClosureDebtVarianceBody = {
  action: "resolve_workflow_ops_alert_closure_debt_variance"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type CreateWorkflowOpsAlertEnforcementWaiverBody = {
  action: "create_workflow_ops_alert_enforcement_waiver"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AttestWorkflowOpsAlertEnforcementWaiverBody = {
  action: "attest_workflow_ops_alert_enforcement_waiver"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type WaiveWorkflowOpsAlertEnforcementWaiverBody = {
  action: "waive_workflow_ops_alert_enforcement_waiver"
  actorId?: string
  matterId?: string
  waiverExpiresAt?: unknown
  reason?: unknown
}

type QueueWorkflowOpsAlertVarianceRemediationBody = {
  action: "queue_workflow_ops_alert_variance_remediation"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AssignWorkflowOpsAlertVarianceRemediationOwnerBody = {
  action: "assign_workflow_ops_alert_variance_remediation_owner"
  actorId?: string
  matterId?: string
  ownerId?: unknown
  reason?: unknown
}

type ResolveWorkflowOpsAlertVarianceRemediationBody = {
  action: "resolve_workflow_ops_alert_variance_remediation"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AcknowledgeWorkflowOpsAlertWaiverExpiryDigestBody = {
  action: "acknowledge_workflow_ops_alert_waiver_expiry_digest"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type ExtendWorkflowOpsAlertWaiverExpiryDigestBody = {
  action: "extend_workflow_ops_alert_waiver_expiry_digest"
  actorId?: string
  matterId?: string
  waiverExpiresAt?: unknown
  reason?: unknown
}

type AcknowledgeWorkflowOpsAlertVarianceRemediationSlaLedgerBody = {
  action: "acknowledge_workflow_ops_alert_variance_remediation_sla_ledger"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type ResolveWorkflowOpsAlertVarianceRemediationSlaLedgerBody = {
  action: "resolve_workflow_ops_alert_variance_remediation_sla_ledger"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type OpenWorkflowOpsAlertWaiverExpiryDisputeBody = {
  action: "open_workflow_ops_alert_waiver_expiry_dispute"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AssignWorkflowOpsAlertWaiverExpiryDisputeReviewerBody = {
  action: "assign_workflow_ops_alert_waiver_expiry_dispute_reviewer"
  actorId?: string
  matterId?: string
  reviewerId?: unknown
  reason?: unknown
}

type ResolveWorkflowOpsAlertWaiverExpiryDisputeBody = {
  action: "resolve_workflow_ops_alert_waiver_expiry_dispute"
  actorId?: string
  matterId?: string
  resolutionOutcome?: unknown
  reason?: unknown
}

type OpenWorkflowOpsAlertVarianceRemediationSlaBreachEscalationBody = {
  action: "open_workflow_ops_alert_variance_remediation_sla_breach_escalation"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AssignWorkflowOpsAlertVarianceRemediationSlaBreachEscalationOwnerBody = {
  action: "assign_workflow_ops_alert_variance_remediation_sla_breach_escalation_owner"
  actorId?: string
  matterId?: string
  ownerId?: unknown
  reason?: unknown
}

type ResolveWorkflowOpsAlertVarianceRemediationSlaBreachEscalationBody = {
  action: "resolve_workflow_ops_alert_variance_remediation_sla_breach_escalation"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type OpenWorkflowOpsAlertWaiverExpiryDisputeAdjudicationBody = {
  action: "open_workflow_ops_alert_waiver_expiry_dispute_adjudication"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AssignWorkflowOpsAlertWaiverExpiryDisputeAdjudicationPanelOwnerBody = {
  action: "assign_workflow_ops_alert_waiver_expiry_dispute_adjudication_panel_owner"
  actorId?: string
  matterId?: string
  panelOwnerId?: unknown
  reason?: unknown
}

type ResolveWorkflowOpsAlertWaiverExpiryDisputeAdjudicationBody = {
  action: "resolve_workflow_ops_alert_waiver_expiry_dispute_adjudication"
  actorId?: string
  matterId?: string
  resolutionOutcome?: unknown
  reason?: unknown
}

type OpenWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointBody = {
  action: "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint"
  actorId?: string
  matterId?: string
  checkpointOwnerId?: unknown
  reason?: unknown
}

type RecordWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointBody = {
  action: "record_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type ReopenWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointBody = {
  action: "reopen_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type OpenWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipBody = {
  action: "open_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_stewardship"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type ExtendWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDeadlineBody = {
  action: "extend_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_deadline"
  actorId?: string
  matterId?: string
  extendedDueAt?: unknown
  reason?: unknown
}

type AcknowledgeWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloBreachBody = {
  action: "acknowledge_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type OpenWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationBody = {
  action: "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AttestWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryBody = {
  action: "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AcknowledgeWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryBody = {
  action: "acknowledge_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type RecordWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationBody = {
  action: "record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation"
  actorId?: string
  matterId?: string
  debtRetiredMs?: unknown
  reason?: unknown
}

type DownshiftWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloTierBody = {
  action: "downshift_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_tier"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type AttestWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloBreachClosureBody = {
  action: "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach_closure"
  actorId?: string
  matterId?: string
  reason?: unknown
}

type OpenWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionBody =
  {
    action: "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception"
    actorId?: string
    matterId?: string
    reason?: unknown
  }

type AssignWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionOwnerBody =
  {
    action: "assign_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_owner"
    actorId?: string
    matterId?: string
    assigneeId?: unknown
    reason?: unknown
  }

type ReconcileWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionBody =
  {
    action: "reconcile_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception"
    actorId?: string
    matterId?: string
    reason?: unknown
  }

type Body =
  | ViewActivityBody
  | AcknowledgeWorkflowOpsAlertDigestBody
  | SnoozeWorkflowOpsAlertDigestBody
  | AttestWorkflowOpsAlertDigestBody
  | OpenWorkflowOpsAlertEscalationBody
  | AssignWorkflowOpsAlertEscalationOwnerBody
  | ResolveWorkflowOpsAlertEscalationBody
  | OpenWorkflowOpsAlertAttestationDisputeBody
  | AssignWorkflowOpsAlertAttestationDisputeReviewerBody
  | ResolveWorkflowOpsAlertAttestationDisputeBody
  | CheckpointWorkflowOpsAlertEscalationClosureBody
  | CloseWorkflowOpsAlertEscalationClosureBody
  | ReopenWorkflowOpsAlertEscalationClosureBody
  | StartWorkflowOpsAlertDisputeEnforcementBody
  | CompleteWorkflowOpsAlertDisputeEnforcementBody
  | WaiveWorkflowOpsAlertDisputeEnforcementBody
  | FlagWorkflowOpsAlertClosureReopenDebtBody
  | StartWorkflowOpsAlertClosureDebtReconciliationBody
  | ResolveWorkflowOpsAlertClosureDebtReconciliationBody
  | AttestWorkflowOpsAlertDisputeEnforcementBody
  | ReopenWorkflowOpsAlertDisputeEnforcementAttestationBody
  | OpenWorkflowOpsAlertClosureDebtVarianceBody
  | AssignWorkflowOpsAlertClosureDebtVarianceOwnerBody
  | ResolveWorkflowOpsAlertClosureDebtVarianceBody
  | CreateWorkflowOpsAlertEnforcementWaiverBody
  | AttestWorkflowOpsAlertEnforcementWaiverBody
  | WaiveWorkflowOpsAlertEnforcementWaiverBody
  | QueueWorkflowOpsAlertVarianceRemediationBody
  | AssignWorkflowOpsAlertVarianceRemediationOwnerBody
  | ResolveWorkflowOpsAlertVarianceRemediationBody
  | AcknowledgeWorkflowOpsAlertWaiverExpiryDigestBody
  | ExtendWorkflowOpsAlertWaiverExpiryDigestBody
  | AcknowledgeWorkflowOpsAlertVarianceRemediationSlaLedgerBody
  | ResolveWorkflowOpsAlertVarianceRemediationSlaLedgerBody
  | OpenWorkflowOpsAlertWaiverExpiryDisputeBody
  | AssignWorkflowOpsAlertWaiverExpiryDisputeReviewerBody
  | ResolveWorkflowOpsAlertWaiverExpiryDisputeBody
  | OpenWorkflowOpsAlertVarianceRemediationSlaBreachEscalationBody
  | AssignWorkflowOpsAlertVarianceRemediationSlaBreachEscalationOwnerBody
  | ResolveWorkflowOpsAlertVarianceRemediationSlaBreachEscalationBody
  | OpenWorkflowOpsAlertWaiverExpiryDisputeAdjudicationBody
  | AssignWorkflowOpsAlertWaiverExpiryDisputeAdjudicationPanelOwnerBody
  | ResolveWorkflowOpsAlertWaiverExpiryDisputeAdjudicationBody
  | OpenWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointBody
  | RecordWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointBody
  | ReopenWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointBody
  | OpenWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipBody
  | ExtendWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDeadlineBody
  | AcknowledgeWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloBreachBody
  | OpenWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationBody
  | AttestWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryBody
  | AcknowledgeWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryBody
  | RecordWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationBody
  | DownshiftWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloTierBody
  | AttestWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloBreachClosureBody
  | OpenWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionBody
  | AssignWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionOwnerBody
  | ReconcileWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionBody

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = parseView(url.searchParams.get("view"))
  if (!view) {
    return NextResponse.json({ error: "unknown view" }, { status: 400 })
  }
  const actorId = url.searchParams.get("actorId")
  const matterId = url.searchParams.get("matterId")
  const source = parseSource(url.searchParams.get("source"))
  const action = url.searchParams.get("action")
  const status = url.searchParams.get("status")
  const severity = parseSeverity(url.searchParams.get("severity"))
  const freshnessStatus = parseFreshness(url.searchParams.get("freshnessStatus"))
  const attestationStatus = parseAttestationStatus(url.searchParams.get("attestationStatus"))
  const escalationStatus = parseEscalationStatus(url.searchParams.get("escalationStatus"))
  const disputeStatus = parseDisputeStatus(url.searchParams.get("disputeStatus"))
  const closureStatus = parseClosureStatus(url.searchParams.get("closureStatus"))
  const enforcementStatus = parseEnforcementStatus(url.searchParams.get("enforcementStatus"))
  const reconciliationStatus = parseReconciliationStatus(url.searchParams.get("reconciliationStatus"))
  const enforcementAttestationStatus = parseEnforcementAttestationStatus(
    url.searchParams.get("enforcementAttestationStatus")
  )
  const varianceStatus = parseVarianceStatus(url.searchParams.get("varianceStatus"))
  const waiverStatus = parseWaiverStatus(url.searchParams.get("waiverStatus"))
  const remediationQueueStatus = parseRemediationQueueStatus(
    url.searchParams.get("remediationQueueStatus")
  )
  const waiverExpiryStatus = parseWaiverExpiryStatus(url.searchParams.get("waiverExpiryStatus"))
  const remediationSlaStatus = parseRemediationSlaStatus(
    url.searchParams.get("remediationSlaStatus")
  )
  const waiverExpiryDisputeStatus = parseWaiverExpiryDisputeStatus(
    url.searchParams.get("waiverExpiryDisputeStatus")
  )
  const remediationSlaBreachEscalationStatus = parseRemediationSlaBreachEscalationStatus(
    url.searchParams.get("remediationSlaBreachEscalationStatus")
  )
  const waiverExpiryDisputeAdjudicationStatus = parseWaiverExpiryDisputeAdjudicationStatus(
    url.searchParams.get("waiverExpiryDisputeAdjudicationStatus")
  )
  const remediationSlaBreachResolutionCheckpointStatus =
    parseRemediationSlaBreachResolutionCheckpointStatus(
      url.searchParams.get("remediationSlaBreachResolutionCheckpointStatus")
    )
  const waiverExpiryDisputeAdjudicationSloStatus = parseWaiverExpiryDisputeAdjudicationSloStatus(
    url.searchParams.get("waiverExpiryDisputeAdjudicationSloStatus")
  )
  const remediationSlaBreachResolutionCheckpointExpiryAttestationStatus =
    parseRemediationSlaBreachResolutionCheckpointExpiryAttestationStatus(
      url.searchParams.get("remediationSlaBreachResolutionCheckpointExpiryAttestationStatus")
    )
  const waiverExpiryDisputeAdjudicationSloDebtStatus = parseWaiverExpiryDisputeAdjudicationSloDebtStatus(
    url.searchParams.get("waiverExpiryDisputeAdjudicationSloDebtStatus")
  )
  const remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionStatus =
    parseRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionStatus(
      url.searchParams.get("remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionStatus")
    )
  const terms = normalizeTerms(url.searchParams.get("q"))
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))

  if (!actorId) {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }

  const actor = await resolveActor({ actorId, store, repos })
  if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
  if (actor.role === "client" || actor.role === "intern") {
    return NextResponse.json({ error: "actor role not allowed for ops reporting" }, { status: 403 })
  }

  await syncFirmUsers(store, repos, actor.firmId)
  await syncFirmMembers(store, repos, actor.firmId)
  const firmMatters = await repos.matters.listByFirm(actor.firmId)
  for (const matter of firmMatters) {
    store.matters.set(matter.id, matter)
  }

  const refreshedActor = store.users.get(actorId)
  if (!refreshedActor) {
    return NextResponse.json({ error: "unknown actor" }, { status: 404 })
  }

  if (view === "activity") {
    const all = (await repos.workflowOpsActivity.listByFirm(refreshedActor.firmId))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (source ? row.source === source : true))
      .filter((row) => (action ? row.action === action : true))
      .filter((row) => (status ? row.status === status : true))
      .filter((row) => terms.every((term) => row.tags.includes(term)))
      .filter((row) => {
        if (!row.matterId) return true
        return checkPermission(store, refreshedActor.id, "research", row.matterId).allow
      })
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null

    return NextResponse.json({
      view: "activity",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  const digests = await ensureWorkflowOpsAlertDigests({
    actorId: refreshedActor.id,
    actorFirmId: refreshedActor.firmId,
    reason: "read_scaffold_seed",
    store,
    repos,
  })
  await ensureWorkflowOpsAlertGovernanceRows({
    digests,
    actorId: refreshedActor.id,
    reason: "read_scaffold_seed",
    store,
    repos,
  })
  const now = Date.now()
  if (view === "alert_digests") {
    const all = (await repos.workflowOpsAlertDigests.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (severity ? row.severity === severity : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => {
        if (!row.matterId) return true
        return checkPermission(store, refreshedActor.id, "research", row.matterId).allow
      })
      .sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          b.updatedAt - a.updatedAt ||
          a.id.localeCompare(b.id)
      )

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null

    return NextResponse.json({
      view: "alert_digests",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_attestations") {
    const all = (await repos.workflowOpsAlertAttestations.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asAttestationFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (attestationStatus ? row.attestationStatus === attestationStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_attestations",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_escalation_ledgers") {
    const all = (await repos.workflowOpsAlertEscalationLedgers.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asEscalationFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (escalationStatus ? row.escalationStatus === escalationStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_escalation_ledgers",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_attestation_disputes") {
    const all = (await repos.workflowOpsAlertAttestationDisputes.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asDisputeFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (disputeStatus ? row.disputeStatus === disputeStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_attestation_disputes",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_escalation_closures") {
    const all = (await repos.workflowOpsAlertEscalationClosures.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asClosureFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (closureStatus ? row.closureStatus === closureStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_escalation_closures",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_dispute_enforcement_ledgers") {
    const all = (await repos.workflowOpsAlertDisputeEnforcementLedgers.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asEnforcementFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (enforcementStatus ? row.enforcementStatus === enforcementStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_dispute_enforcement_ledgers",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_closure_debt_reconciliation_digests") {
    const all = (await repos.workflowOpsAlertClosureDebtReconciliationDigests.listByFirm(
      refreshedActor.firmId
    ))
      .map((row) => ({
        ...row,
        freshnessStatus: asReconciliationFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (reconciliationStatus ? row.reconciliationStatus === reconciliationStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_closure_debt_reconciliation_digests",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_enforcement_attestations") {
    const all = (await repos.workflowOpsAlertEnforcementAttestations.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asEnforcementAttestationFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) =>
        enforcementAttestationStatus ? row.attestationStatus === enforcementAttestationStatus : true
      )
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_enforcement_attestations",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_closure_debt_variance_digests") {
    const all = (await repos.workflowOpsAlertClosureDebtVarianceDigests.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asVarianceFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (varianceStatus ? row.varianceStatus === varianceStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_closure_debt_variance_digests",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_enforcement_waiver_ledgers") {
    const all = (await repos.workflowOpsAlertEnforcementWaiverLedgers.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asEnforcementWaiverFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (waiverStatus ? row.waiverStatus === waiverStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_enforcement_waiver_ledgers",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_variance_remediation_queues") {
    const all = (await repos.workflowOpsAlertVarianceRemediationQueues.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asVarianceRemediationQueueFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (remediationQueueStatus ? row.queueStatus === remediationQueueStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_variance_remediation_queues",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_waiver_expiry_digests") {
    const all = (await repos.workflowOpsAlertWaiverExpiryDigests.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asWaiverExpiryFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (waiverExpiryStatus ? row.expiryStatus === waiverExpiryStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_waiver_expiry_digests",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_variance_remediation_sla_ledgers") {
    const all = (await repos.workflowOpsAlertVarianceRemediationSlaLedgers.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asVarianceRemediationSlaFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (remediationSlaStatus ? row.slaStatus === remediationSlaStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_variance_remediation_sla_ledgers",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_waiver_expiry_disputes") {
    const all = (await repos.workflowOpsAlertWaiverExpiryDisputes.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asWaiverExpiryDisputeFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => (waiverExpiryDisputeStatus ? row.disputeStatus === waiverExpiryDisputeStatus : true))
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_waiver_expiry_disputes",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_variance_remediation_sla_breach_escalations") {
    const all = (
      await repos.workflowOpsAlertVarianceRemediationSlaBreachEscalations.listByFirm(
        refreshedActor.firmId
      )
    )
      .map((row) => ({
        ...row,
        freshnessStatus: asRemediationSlaBreachEscalationFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) =>
        remediationSlaBreachEscalationStatus
          ? row.escalationStatus === remediationSlaBreachEscalationStatus
          : true
      )
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_variance_remediation_sla_breach_escalations",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_waiver_expiry_dispute_adjudications") {
    const all = (await repos.workflowOpsAlertWaiverExpiryDisputeAdjudications.listByFirm(refreshedActor.firmId))
      .map((row) => ({
        ...row,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) =>
        waiverExpiryDisputeAdjudicationStatus
          ? row.adjudicationStatus === waiverExpiryDisputeAdjudicationStatus
          : true
      )
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_waiver_expiry_dispute_adjudications",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_variance_remediation_sla_breach_resolution_checkpoints") {
    const all = (
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.listByFirm(
        refreshedActor.firmId
      )
    )
      .map((row) => ({
        ...row,
        freshnessStatus: asRemediationSlaBreachResolutionCheckpointFreshnessStatus(
          row.recomputedAt,
          now
        ),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) =>
        remediationSlaBreachResolutionCheckpointStatus
          ? row.checkpointStatus === remediationSlaBreachResolutionCheckpointStatus
          : true
      )
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_variance_remediation_sla_breach_resolution_checkpoints",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_waiver_expiry_dispute_adjudication_slo_stewardships") {
    const all = (
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.listByFirm(
        refreshedActor.firmId
      )
    )
      .map((row) => ({
        ...row,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationSloFreshnessStatus(row.recomputedAt, now),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) =>
        waiverExpiryDisputeAdjudicationSloStatus
          ? row.sloStatus === waiverExpiryDisputeAdjudicationSloStatus
          : true
      )
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_waiver_expiry_dispute_adjudication_slo_stewardships",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (
    view === "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations"
  ) {
    const all = (
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.listByFirm(
        refreshedActor.firmId
      )
    )
      .map((row) => ({
        ...row,
        freshnessStatus: asRemediationSlaBreachResolutionCheckpointExpiryAttestationFreshnessStatus(
          row.recomputedAt,
          now
        ),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) =>
        remediationSlaBreachResolutionCheckpointExpiryAttestationStatus
          ? row.attestationStatus === remediationSlaBreachResolutionCheckpointExpiryAttestationStatus
          : true
      )
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (view === "alert_waiver_expiry_dispute_adjudication_slo_debt_remediations") {
    const all = (
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.listByFirm(
        refreshedActor.firmId
      )
    )
      .map((row) => ({
        ...row,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationSloDebtRemediationFreshnessStatus(
          row.recomputedAt,
          now
        ),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) =>
        waiverExpiryDisputeAdjudicationSloDebtStatus
          ? row.debtStatus === waiverExpiryDisputeAdjudicationSloDebtStatus
          : true
      )
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view: "alert_waiver_expiry_dispute_adjudication_slo_debt_remediations",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  if (
    view ===
    "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations"
  ) {
    const all = (
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.listByFirm(
        refreshedActor.firmId
      )
    )
      .map((row) => ({
        ...row,
        freshnessStatus:
          asRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationFreshnessStatus(
            row.recomputedAt,
            now
          ),
      }))
      .filter((row) => rankOf(refreshedActor.clearanceLevel) >= rankOf(row.classification))
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) =>
        remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionStatus
          ? row.exceptionStatus === remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionStatus
          : true
      )
      .filter((row) => (freshnessStatus ? row.freshnessStatus === freshnessStatus : true))
      .filter((row) => checkPermission(store, refreshedActor.id, "research", row.matterId).allow)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view:
        "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations",
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  }

  return NextResponse.json({ error: "unknown view" }, { status: 400 })
}

export async function POST(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  let key: string
  try {
    key = requireIdempotencyKey(request)
  } catch (err) {
    const message = err instanceof IdempotencyError ? err.message : "Idempotency-Key header required"
    return NextResponse.json({ error: message }, { status: 400 })
  }

  let parsed: Body
  try {
    parsed = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  if (
    !parsed ||
    (parsed.action !== "acknowledge_workflow_ops_alert_digest" &&
      parsed.action !== "snooze_workflow_ops_alert_digest" &&
      parsed.action !== "attest_workflow_ops_alert_digest" &&
      parsed.action !== "open_workflow_ops_alert_escalation" &&
      parsed.action !== "assign_workflow_ops_alert_escalation_owner" &&
      parsed.action !== "resolve_workflow_ops_alert_escalation" &&
      parsed.action !== "open_workflow_ops_alert_attestation_dispute" &&
      parsed.action !== "assign_workflow_ops_alert_attestation_dispute_reviewer" &&
      parsed.action !== "resolve_workflow_ops_alert_attestation_dispute" &&
      parsed.action !== "checkpoint_workflow_ops_alert_escalation_closure" &&
      parsed.action !== "close_workflow_ops_alert_escalation_closure" &&
      parsed.action !== "reopen_workflow_ops_alert_escalation_closure" &&
      parsed.action !== "start_workflow_ops_alert_dispute_enforcement" &&
      parsed.action !== "complete_workflow_ops_alert_dispute_enforcement" &&
      parsed.action !== "waive_workflow_ops_alert_dispute_enforcement" &&
      parsed.action !== "flag_workflow_ops_alert_closure_reopen_debt" &&
      parsed.action !== "start_workflow_ops_alert_closure_debt_reconciliation" &&
      parsed.action !== "resolve_workflow_ops_alert_closure_debt_reconciliation" &&
      parsed.action !== "attest_workflow_ops_alert_dispute_enforcement" &&
      parsed.action !== "reopen_workflow_ops_alert_dispute_enforcement_attestation" &&
      parsed.action !== "open_workflow_ops_alert_closure_debt_variance" &&
      parsed.action !== "assign_workflow_ops_alert_closure_debt_variance_owner" &&
      parsed.action !== "resolve_workflow_ops_alert_closure_debt_variance" &&
      parsed.action !== "create_workflow_ops_alert_enforcement_waiver" &&
      parsed.action !== "attest_workflow_ops_alert_enforcement_waiver" &&
      parsed.action !== "waive_workflow_ops_alert_enforcement_waiver" &&
      parsed.action !== "queue_workflow_ops_alert_variance_remediation" &&
      parsed.action !== "assign_workflow_ops_alert_variance_remediation_owner" &&
      parsed.action !== "resolve_workflow_ops_alert_variance_remediation" &&
      parsed.action !== "acknowledge_workflow_ops_alert_waiver_expiry_digest" &&
      parsed.action !== "extend_workflow_ops_alert_waiver_expiry_digest" &&
      parsed.action !== "acknowledge_workflow_ops_alert_variance_remediation_sla_ledger" &&
      parsed.action !== "resolve_workflow_ops_alert_variance_remediation_sla_ledger" &&
      parsed.action !== "open_workflow_ops_alert_waiver_expiry_dispute" &&
      parsed.action !== "assign_workflow_ops_alert_waiver_expiry_dispute_reviewer" &&
      parsed.action !== "resolve_workflow_ops_alert_waiver_expiry_dispute" &&
      parsed.action !== "open_workflow_ops_alert_variance_remediation_sla_breach_escalation" &&
      parsed.action !== "assign_workflow_ops_alert_variance_remediation_sla_breach_escalation_owner" &&
      parsed.action !== "resolve_workflow_ops_alert_variance_remediation_sla_breach_escalation" &&
      parsed.action !== "open_workflow_ops_alert_waiver_expiry_dispute_adjudication" &&
      parsed.action !== "assign_workflow_ops_alert_waiver_expiry_dispute_adjudication_panel_owner" &&
      parsed.action !== "resolve_workflow_ops_alert_waiver_expiry_dispute_adjudication" &&
      parsed.action !== "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint" &&
      parsed.action !== "record_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint" &&
      parsed.action !== "reopen_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint" &&
      parsed.action !== "open_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_stewardship" &&
      parsed.action !== "extend_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_deadline" &&
      parsed.action !== "acknowledge_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach" &&
      parsed.action !== "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation" &&
      parsed.action !== "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry" &&
      parsed.action !== "acknowledge_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry" &&
      parsed.action !== "record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation" &&
      parsed.action !== "downshift_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_tier" &&
      parsed.action !== "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach_closure" &&
      parsed.action !==
        "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception" &&
      parsed.action !==
        "assign_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_owner" &&
      parsed.action !==
        "reconcile_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception")
  ) {
    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  }

  const fingerprint = JSON.stringify({
    route: "/api/d2/ops-reporting",
    action: parsed.action,
    body: parsed,
  })
  const replay = idempotency.getReplay(key, fingerprint)
  if (replay.conflict) {
    return NextResponse.json(
      { error: "Idempotency-Key reused with a different request payload" },
      { status: 409 }
    )
  }
  if (replay.body !== undefined) {
    return NextResponse.json({ result: replay.body, idempotencyKey: key, reused: true })
  }

  const actorId = parsed.actorId
  const matterId = parsed.matterId
  if (!actorId || typeof actorId !== "string") {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }
  if (!matterId || typeof matterId !== "string") {
    return NextResponse.json({ error: "matterId is required" }, { status: 400 })
  }

  const actor = await resolveActor({ actorId, store, repos })
  if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
  if (actor.role !== "partner") {
    return NextResponse.json({ error: "actor role not allowed for ops alert governance" }, { status: 403 })
  }

  await syncFirmUsers(store, repos, actor.firmId)
  await syncFirmMembers(store, repos, actor.firmId)
  const matter = await resolveMatter({ matterId, store, repos })
  if (!matter || matter.firmId !== actor.firmId) {
    return NextResponse.json({ error: "unknown matter" }, { status: 404 })
  }

  const now = Date.now()
  const seeded = await ensureWorkflowOpsAlertDigests({
    actorId: actor.id,
    actorFirmId: actor.firmId,
    reason: "post_scaffold_seed",
    store,
    repos,
  })
  const seededRow = seeded.find((row) => row.matterId === matter.id) ?? null
  const digestId = alertDigestId(matter.id)
  const current =
    seededRow ??
    store.workflowOpsAlertDigests.get(digestId) ??
    (await repos.workflowOpsAlertDigests.get(digestId))
  if (!current) {
    return NextResponse.json({ error: "no alert digest exists for matter" }, { status: 404 })
  }
  const governance = await ensureWorkflowOpsAlertGovernanceRows({
    digests: [current],
    actorId: actor.id,
    reason: "post_scaffold_seed",
    store,
    repos,
  })
  const currentAttestation =
    governance.attestations.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertAttestations.get(alertAttestationId(matter.id)) ??
    (await repos.workflowOpsAlertAttestations.get(alertAttestationId(matter.id)))
  const currentEscalation =
    governance.escalationLedgers.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertEscalationLedgers.get(alertEscalationLedgerId(matter.id)) ??
    (await repos.workflowOpsAlertEscalationLedgers.get(alertEscalationLedgerId(matter.id)))
  const currentDispute =
    governance.attestationDisputes.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertAttestationDisputes.get(alertAttestationDisputeId(matter.id)) ??
    (await repos.workflowOpsAlertAttestationDisputes.get(alertAttestationDisputeId(matter.id)))
  const currentClosure =
    governance.escalationClosures.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertEscalationClosures.get(alertEscalationClosureId(matter.id)) ??
    (await repos.workflowOpsAlertEscalationClosures.get(alertEscalationClosureId(matter.id)))
  const currentEnforcement =
    governance.disputeEnforcementLedgers.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertDisputeEnforcementLedgers.get(alertDisputeEnforcementLedgerId(matter.id)) ??
    (await repos.workflowOpsAlertDisputeEnforcementLedgers.get(alertDisputeEnforcementLedgerId(matter.id)))
  const currentReconciliation =
    governance.closureDebtReconciliationDigests.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertClosureDebtReconciliationDigests.get(
      alertClosureDebtReconciliationDigestId(matter.id)
    ) ??
    (await repos.workflowOpsAlertClosureDebtReconciliationDigests.get(
      alertClosureDebtReconciliationDigestId(matter.id)
    ))
  const currentEnforcementAttestation =
    governance.enforcementAttestations.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertEnforcementAttestations.get(alertEnforcementAttestationId(matter.id)) ??
    (await repos.workflowOpsAlertEnforcementAttestations.get(alertEnforcementAttestationId(matter.id)))
  const currentVariance =
    governance.closureDebtVarianceDigests.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertClosureDebtVarianceDigests.get(alertClosureDebtVarianceDigestId(matter.id)) ??
    (await repos.workflowOpsAlertClosureDebtVarianceDigests.get(
      alertClosureDebtVarianceDigestId(matter.id)
    ))
  const currentWaiverLedger =
    governance.enforcementWaiverLedgers.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertEnforcementWaiverLedgers.get(alertEnforcementWaiverLedgerId(matter.id)) ??
    (await repos.workflowOpsAlertEnforcementWaiverLedgers.get(alertEnforcementWaiverLedgerId(matter.id)))
  const currentVarianceRemediationQueue =
    governance.varianceRemediationQueues.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertVarianceRemediationQueues.get(alertVarianceRemediationQueueId(matter.id)) ??
    (await repos.workflowOpsAlertVarianceRemediationQueues.get(alertVarianceRemediationQueueId(matter.id)))
  const currentWaiverExpiryDigest =
    governance.waiverExpiryDigests.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertWaiverExpiryDigests.get(alertWaiverExpiryDigestId(matter.id)) ??
    (await repos.workflowOpsAlertWaiverExpiryDigests.get(alertWaiverExpiryDigestId(matter.id)))
  const currentVarianceRemediationSlaLedger =
    governance.varianceRemediationSlaLedgers.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertVarianceRemediationSlaLedgers.get(
      alertVarianceRemediationSlaLedgerId(matter.id)
    ) ??
    (await repos.workflowOpsAlertVarianceRemediationSlaLedgers.get(
      alertVarianceRemediationSlaLedgerId(matter.id)
    ))
  const currentWaiverExpiryDispute =
    governance.waiverExpiryDisputes.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertWaiverExpiryDisputes.get(alertWaiverExpiryDisputeId(matter.id)) ??
    (await repos.workflowOpsAlertWaiverExpiryDisputes.get(alertWaiverExpiryDisputeId(matter.id)))
  const currentVarianceRemediationSlaBreachEscalation =
    governance.varianceRemediationSlaBreachEscalations.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertVarianceRemediationSlaBreachEscalations.get(
      alertVarianceRemediationSlaBreachEscalationId(matter.id)
    ) ??
    (await repos.workflowOpsAlertVarianceRemediationSlaBreachEscalations.get(
      alertVarianceRemediationSlaBreachEscalationId(matter.id)
    ))
  const currentWaiverExpiryDisputeAdjudication =
    governance.waiverExpiryDisputeAdjudications.find((row) => row.matterId === matter.id) ??
    store.workflowOpsAlertWaiverExpiryDisputeAdjudications.get(
      alertWaiverExpiryDisputeAdjudicationId(matter.id)
    ) ??
    (await repos.workflowOpsAlertWaiverExpiryDisputeAdjudications.get(
      alertWaiverExpiryDisputeAdjudicationId(matter.id)
    ))
  const currentRemediationSlaBreachResolutionCheckpoint =
    governance.varianceRemediationSlaBreachResolutionCheckpoints.find(
      (row) => row.matterId === matter.id
    ) ??
    store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.get(
      alertVarianceRemediationSlaBreachResolutionCheckpointId(matter.id)
    ) ??
    (await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.get(
      alertVarianceRemediationSlaBreachResolutionCheckpointId(matter.id)
    ))
  const currentWaiverExpiryDisputeAdjudicationSlo =
    governance.waiverExpiryDisputeAdjudicationSloStewardships.find(
      (row) => row.matterId === matter.id
    ) ??
    store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.get(
      alertWaiverExpiryDisputeAdjudicationSloStewardshipId(matter.id)
    ) ??
    (await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.get(
      alertWaiverExpiryDisputeAdjudicationSloStewardshipId(matter.id)
    ))
  const currentRemediationSlaBreachResolutionCheckpointExpiryAttestation =
    governance.varianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.find(
      (row) => row.matterId === matter.id
    ) ??
    store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.get(
      alertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationId(matter.id)
    ) ??
    (await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.get(
      alertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationId(matter.id)
    ))
  const currentWaiverExpiryDisputeAdjudicationSloDebtRemediation =
    governance.waiverExpiryDisputeAdjudicationSloDebtRemediations.find(
      (row) => row.matterId === matter.id
    ) ??
    store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.get(
      alertWaiverExpiryDisputeAdjudicationSloDebtRemediationId(matter.id)
    ) ??
    (await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.get(
      alertWaiverExpiryDisputeAdjudicationSloDebtRemediationId(matter.id)
    ))
  const currentRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation =
    governance.varianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.find(
      (row) => row.matterId === matter.id
    ) ??
    store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.get(
      alertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationId(
        matter.id
      )
    ) ??
    (await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.get(
      alertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationId(
        matter.id
      )
    ))
  if (
    !currentAttestation ||
    !currentEscalation ||
    !currentDispute ||
    !currentClosure ||
    !currentEnforcement ||
    !currentReconciliation ||
    !currentEnforcementAttestation ||
    !currentVariance ||
    !currentWaiverLedger ||
    !currentVarianceRemediationQueue ||
    !currentWaiverExpiryDigest ||
    !currentVarianceRemediationSlaLedger ||
    !currentWaiverExpiryDispute ||
    !currentVarianceRemediationSlaBreachEscalation ||
    !currentWaiverExpiryDisputeAdjudication ||
    !currentRemediationSlaBreachResolutionCheckpoint ||
    !currentWaiverExpiryDisputeAdjudicationSlo ||
    !currentRemediationSlaBreachResolutionCheckpointExpiryAttestation ||
    !currentWaiverExpiryDisputeAdjudicationSloDebtRemediation ||
    !currentRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
  ) {
    return NextResponse.json({ error: "alert governance rows are unavailable for matter" }, { status: 404 })
  }

  try {
    if (parsed.action === "acknowledge_workflow_ops_alert_digest") {
      const reason = normalizeReason(parsed.reason, "alert_acknowledged")
      const next: WorkflowOpsAlertDigestRow = {
        ...current,
        freshnessStatus: asFreshnessStatus(current.recomputedAt, now),
        acknowledgedAt: now,
        acknowledgedBy: actor.id,
        acknowledgedReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertDigests.upsert(next)
      store.workflowOpsAlertDigests.set(next.id, next)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_digest_acknowledged",
        actorId: actor.id,
        target: next.matterId ?? next.id,
        classification: next.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: next,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "snooze_workflow_ops_alert_digest") {
      const snoozedUntil = parseSnoozedUntil(parsed.snoozedUntil, now)
      const reason = normalizeReason(parsed.reason, "alert_snoozed")
      const next: WorkflowOpsAlertDigestRow = {
        ...current,
        freshnessStatus: asFreshnessStatus(current.recomputedAt, now),
        snoozedUntil,
        snoozedBy: actor.id,
        snoozedReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertDigests.upsert(next)
      store.workflowOpsAlertDigests.set(next.id, next)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_digest_snoozed",
        actorId: actor.id,
        target: next.matterId ?? next.id,
        classification: next.classification,
        reason: `${reason}:${snoozedUntil}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: next,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_workflow_ops_alert_digest") {
      const reason = normalizeReason(parsed.reason, "attestation_recorded")
      const nextAttestation: WorkflowOpsAlertAttestationRow = {
        ...currentAttestation,
        attestationStatus: "attested",
        lastAttestedAt: now,
        lastAttestedBy: actor.id,
        attestationReason: reason,
        freshnessStatus: asAttestationFreshnessStatus(current.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertAttestations.upsert(nextAttestation)
      store.workflowOpsAlertAttestations.set(nextAttestation.id, nextAttestation)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_attested",
        actorId: actor.id,
        target: nextAttestation.matterId,
        classification: nextAttestation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        attestation: nextAttestation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "open_workflow_ops_alert_escalation") {
      const reason = normalizeReason(parsed.reason, "escalation_opened")
      const nextEscalation: WorkflowOpsAlertEscalationLedgerRow = {
        ...currentEscalation,
        escalationStatus: "open",
        openedAt: currentEscalation.openedAt ?? now,
        lastStatusChangedAt: now,
        resolvedAt: null,
        resolutionReason: null,
        freshnessStatus: asEscalationFreshnessStatus(current.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEscalationLedgers.upsert(nextEscalation)
      store.workflowOpsAlertEscalationLedgers.set(nextEscalation.id, nextEscalation)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_escalation_opened",
        actorId: actor.id,
        target: nextEscalation.matterId,
        classification: nextEscalation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        escalation: nextEscalation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_workflow_ops_alert_escalation_owner") {
      const ownerId = typeof parsed.ownerId === "string" ? parsed.ownerId.trim() : ""
      if (!ownerId) {
        return NextResponse.json({ error: "ownerId is required" }, { status: 400 })
      }
      const reason = normalizeReason(parsed.reason, "escalation_owner_assigned")
      const nextEscalation: WorkflowOpsAlertEscalationLedgerRow = {
        ...currentEscalation,
        escalationStatus: "assigned",
        ownerId,
        openedAt: currentEscalation.openedAt ?? now,
        lastStatusChangedAt: now,
        resolvedAt: null,
        resolutionReason: null,
        freshnessStatus: asEscalationFreshnessStatus(current.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEscalationLedgers.upsert(nextEscalation)
      store.workflowOpsAlertEscalationLedgers.set(nextEscalation.id, nextEscalation)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_escalation_owner_assigned",
        actorId: actor.id,
        target: nextEscalation.matterId,
        classification: nextEscalation.classification,
        reason: `${reason}:${ownerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        escalation: nextEscalation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "open_workflow_ops_alert_attestation_dispute") {
      const reason = normalizeReason(parsed.reason, "attestation_dispute_opened")
      const nextDispute: WorkflowOpsAlertAttestationDisputeRow = {
        ...currentDispute,
        disputeStatus: "open",
        openedAt: currentDispute.openedAt ?? now,
        lastStatusChangedAt: now,
        resolvedAt: null,
        resolutionOutcome: null,
        resolutionReason: null,
        freshnessStatus: asDisputeFreshnessStatus(currentAttestation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertAttestationDisputes.upsert(nextDispute)
      store.workflowOpsAlertAttestationDisputes.set(nextDispute.id, nextDispute)

      const nextAttestation: WorkflowOpsAlertAttestationRow = {
        ...currentAttestation,
        attestationStatus: "reopened",
        attestationReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertAttestations.upsert(nextAttestation)
      store.workflowOpsAlertAttestations.set(nextAttestation.id, nextAttestation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_attestation_dispute_opened",
        actorId: actor.id,
        target: nextDispute.matterId,
        classification: nextDispute.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        attestation: nextAttestation,
        dispute: nextDispute,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_workflow_ops_alert_attestation_dispute_reviewer") {
      const reviewerId = typeof parsed.reviewerId === "string" ? parsed.reviewerId.trim() : ""
      if (!reviewerId) {
        return NextResponse.json({ error: "reviewerId is required" }, { status: 400 })
      }
      const reason = normalizeReason(parsed.reason, "attestation_dispute_reviewer_assigned")
      const nextDispute: WorkflowOpsAlertAttestationDisputeRow = {
        ...currentDispute,
        disputeStatus: "review_assigned",
        reviewerId,
        openedAt: currentDispute.openedAt ?? now,
        lastStatusChangedAt: now,
        resolvedAt: null,
        resolutionOutcome: null,
        resolutionReason: null,
        freshnessStatus: asDisputeFreshnessStatus(currentAttestation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertAttestationDisputes.upsert(nextDispute)
      store.workflowOpsAlertAttestationDisputes.set(nextDispute.id, nextDispute)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_attestation_dispute_reviewer_assigned",
        actorId: actor.id,
        target: nextDispute.matterId,
        classification: nextDispute.classification,
        reason: `${reason}:${reviewerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        dispute: nextDispute,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_workflow_ops_alert_attestation_dispute") {
      const resolutionOutcome = parseDisputeOutcome(parsed.resolutionOutcome)
      if (!resolutionOutcome) {
        return NextResponse.json(
          { error: "resolutionOutcome must be upheld, overturned, or deferred" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "attestation_dispute_resolved")
      const nextDispute: WorkflowOpsAlertAttestationDisputeRow = {
        ...currentDispute,
        disputeStatus: "resolved",
        lastStatusChangedAt: now,
        resolvedAt: now,
        resolutionOutcome,
        resolutionReason: reason,
        freshnessStatus: asDisputeFreshnessStatus(currentAttestation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertAttestationDisputes.upsert(nextDispute)
      store.workflowOpsAlertAttestationDisputes.set(nextDispute.id, nextDispute)

      const nextAttestation: WorkflowOpsAlertAttestationRow = {
        ...currentAttestation,
        attestationStatus: resolutionOutcome === "overturned" ? "reopened" : "attested",
        attestationReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertAttestations.upsert(nextAttestation)
      store.workflowOpsAlertAttestations.set(nextAttestation.id, nextAttestation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_attestation_dispute_resolved",
        actorId: actor.id,
        target: nextDispute.matterId,
        classification: nextDispute.classification,
        reason: `${reason}:${resolutionOutcome}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        attestation: nextAttestation,
        dispute: nextDispute,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "checkpoint_workflow_ops_alert_escalation_closure") {
      const reason = normalizeReason(parsed.reason, "escalation_closure_checkpoint_recorded")
      const nextClosure: WorkflowOpsAlertEscalationClosureRow = {
        ...currentClosure,
        closureStatus: "checkpoint_recorded",
        checkpointAt: now,
        lastStatusChangedAt: now,
        freshnessStatus: asClosureFreshnessStatus(currentEscalation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEscalationClosures.upsert(nextClosure)
      store.workflowOpsAlertEscalationClosures.set(nextClosure.id, nextClosure)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_escalation_closure_checkpoint_recorded",
        actorId: actor.id,
        target: nextClosure.matterId,
        classification: nextClosure.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        closure: nextClosure,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "close_workflow_ops_alert_escalation_closure") {
      const reason = normalizeReason(parsed.reason, "escalation_closure_closed")
      const nextClosure: WorkflowOpsAlertEscalationClosureRow = {
        ...currentClosure,
        closureStatus: "closed",
        closedAt: now,
        reopenedAt: null,
        closureReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asClosureFreshnessStatus(currentEscalation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEscalationClosures.upsert(nextClosure)
      store.workflowOpsAlertEscalationClosures.set(nextClosure.id, nextClosure)

      const nextEscalation: WorkflowOpsAlertEscalationLedgerRow = {
        ...currentEscalation,
        escalationStatus: "resolved",
        lastStatusChangedAt: now,
        resolvedAt: currentEscalation.resolvedAt ?? now,
        resolutionReason: reason,
        freshnessStatus: asEscalationFreshnessStatus(current.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEscalationLedgers.upsert(nextEscalation)
      store.workflowOpsAlertEscalationLedgers.set(nextEscalation.id, nextEscalation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_escalation_closure_closed",
        actorId: actor.id,
        target: nextClosure.matterId,
        classification: nextClosure.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        escalation: nextEscalation,
        closure: nextClosure,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reopen_workflow_ops_alert_escalation_closure") {
      const reason = normalizeReason(parsed.reason, "escalation_closure_reopened")
      const nextClosure: WorkflowOpsAlertEscalationClosureRow = {
        ...currentClosure,
        closureStatus: "reopened",
        reopenedAt: now,
        closureReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asClosureFreshnessStatus(currentEscalation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEscalationClosures.upsert(nextClosure)
      store.workflowOpsAlertEscalationClosures.set(nextClosure.id, nextClosure)

      const nextEscalation: WorkflowOpsAlertEscalationLedgerRow = {
        ...currentEscalation,
        escalationStatus: "open",
        openedAt: currentEscalation.openedAt ?? now,
        lastStatusChangedAt: now,
        resolvedAt: null,
        resolutionReason: null,
        freshnessStatus: asEscalationFreshnessStatus(current.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEscalationLedgers.upsert(nextEscalation)
      store.workflowOpsAlertEscalationLedgers.set(nextEscalation.id, nextEscalation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_escalation_closure_reopened",
        actorId: actor.id,
        target: nextClosure.matterId,
        classification: nextClosure.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        escalation: nextEscalation,
        closure: nextClosure,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "start_workflow_ops_alert_dispute_enforcement") {
      const ownerId = typeof parsed.ownerId === "string" ? parsed.ownerId.trim() : currentEnforcement.ownerId
      if (
        currentDispute.disputeStatus !== "resolved" ||
        (currentDispute.resolutionOutcome !== "upheld" && currentDispute.resolutionOutcome !== "overturned")
      ) {
        return NextResponse.json(
          { error: "dispute enforcement requires a resolved dispute with upheld or overturned outcome" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "dispute_enforcement_started")
      const nextEnforcement: WorkflowOpsAlertDisputeEnforcementLedgerRow = {
        ...currentEnforcement,
        enforcementStatus: "in_progress",
        requiredOutcome: currentDispute.resolutionOutcome,
        ownerId,
        checkpointAt: now,
        enforcedAt: null,
        waivedAt: null,
        waiverReason: null,
        lastStatusChangedAt: now,
        freshnessStatus: asEnforcementFreshnessStatus(currentDispute.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertDisputeEnforcementLedgers.upsert(nextEnforcement)
      store.workflowOpsAlertDisputeEnforcementLedgers.set(nextEnforcement.id, nextEnforcement)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_dispute_enforcement_started",
        actorId: actor.id,
        target: nextEnforcement.matterId,
        classification: nextEnforcement.classification,
        reason: `${reason}:${ownerId ?? "unassigned"}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        dispute: currentDispute,
        enforcement: nextEnforcement,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "complete_workflow_ops_alert_dispute_enforcement") {
      if (currentEnforcement.enforcementStatus === "not_required") {
        return NextResponse.json({ error: "enforcement is not required for this dispute" }, { status: 400 })
      }
      const reason = normalizeReason(parsed.reason, "dispute_enforcement_completed")
      const nextEnforcement: WorkflowOpsAlertDisputeEnforcementLedgerRow = {
        ...currentEnforcement,
        enforcementStatus: "enforced",
        requiredOutcome: currentDispute.resolutionOutcome,
        enforcedAt: now,
        waivedAt: null,
        waiverReason: null,
        lastStatusChangedAt: now,
        freshnessStatus: asEnforcementFreshnessStatus(currentDispute.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertDisputeEnforcementLedgers.upsert(nextEnforcement)
      store.workflowOpsAlertDisputeEnforcementLedgers.set(nextEnforcement.id, nextEnforcement)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_dispute_enforcement_completed",
        actorId: actor.id,
        target: nextEnforcement.matterId,
        classification: nextEnforcement.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        dispute: currentDispute,
        enforcement: nextEnforcement,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "waive_workflow_ops_alert_dispute_enforcement") {
      const reason = normalizeReason(parsed.reason, "dispute_enforcement_waived")
      const nextEnforcement: WorkflowOpsAlertDisputeEnforcementLedgerRow = {
        ...currentEnforcement,
        enforcementStatus: "waived",
        waivedAt: now,
        waiverReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asEnforcementFreshnessStatus(currentDispute.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertDisputeEnforcementLedgers.upsert(nextEnforcement)
      store.workflowOpsAlertDisputeEnforcementLedgers.set(nextEnforcement.id, nextEnforcement)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_dispute_enforcement_waived",
        actorId: actor.id,
        target: nextEnforcement.matterId,
        classification: nextEnforcement.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        dispute: currentDispute,
        enforcement: nextEnforcement,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "flag_workflow_ops_alert_closure_reopen_debt") {
      const reason = normalizeReason(parsed.reason, "closure_reopen_debt_flagged")
      const nextReconciliation: WorkflowOpsAlertClosureDebtReconciliationDigestRow = {
        ...currentReconciliation,
        reconciliationStatus: "debt_open",
        reopenDebtCount: currentReconciliation.reopenDebtCount + 1,
        outstandingDebtCount: Math.max(currentReconciliation.outstandingDebtCount + 1, 1),
        lastReopenedAt: now,
        lastStatusChangedAt: now,
        freshnessStatus: asReconciliationFreshnessStatus(currentClosure.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertClosureDebtReconciliationDigests.upsert(nextReconciliation)
      store.workflowOpsAlertClosureDebtReconciliationDigests.set(nextReconciliation.id, nextReconciliation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_closure_reopen_debt_flagged",
        actorId: actor.id,
        target: nextReconciliation.matterId,
        classification: nextReconciliation.classification,
        reason: `${reason}:${nextReconciliation.outstandingDebtCount}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        closure: currentClosure,
        reconciliation: nextReconciliation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "start_workflow_ops_alert_closure_debt_reconciliation") {
      const ownerId = typeof parsed.ownerId === "string" ? parsed.ownerId.trim() : ""
      if (!ownerId) {
        return NextResponse.json({ error: "ownerId is required" }, { status: 400 })
      }
      const reason = normalizeReason(parsed.reason, "closure_debt_reconciliation_started")
      const nextReconciliation: WorkflowOpsAlertClosureDebtReconciliationDigestRow = {
        ...currentReconciliation,
        reconciliationStatus: "reconciling",
        reconcilingOwnerId: ownerId,
        reconciliationCheckpointAt: now,
        reconciledAt: null,
        reconciliationReason: null,
        lastStatusChangedAt: now,
        freshnessStatus: asReconciliationFreshnessStatus(currentClosure.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertClosureDebtReconciliationDigests.upsert(nextReconciliation)
      store.workflowOpsAlertClosureDebtReconciliationDigests.set(nextReconciliation.id, nextReconciliation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_closure_debt_reconciliation_started",
        actorId: actor.id,
        target: nextReconciliation.matterId,
        classification: nextReconciliation.classification,
        reason: `${reason}:${ownerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        closure: currentClosure,
        reconciliation: nextReconciliation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_workflow_ops_alert_closure_debt_reconciliation") {
      const reason = normalizeReason(parsed.reason, "closure_debt_reconciliation_resolved")
      const nextReconciliation: WorkflowOpsAlertClosureDebtReconciliationDigestRow = {
        ...currentReconciliation,
        reconciliationStatus: "reconciled",
        outstandingDebtCount: 0,
        reconciledAt: now,
        reconciliationReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asReconciliationFreshnessStatus(currentClosure.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertClosureDebtReconciliationDigests.upsert(nextReconciliation)
      store.workflowOpsAlertClosureDebtReconciliationDigests.set(nextReconciliation.id, nextReconciliation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_closure_debt_reconciliation_resolved",
        actorId: actor.id,
        target: nextReconciliation.matterId,
        classification: nextReconciliation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        closure: currentClosure,
        reconciliation: nextReconciliation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_workflow_ops_alert_dispute_enforcement") {
      const reason = normalizeReason(parsed.reason, "dispute_enforcement_attested")
      const nextAttestation: WorkflowOpsAlertEnforcementAttestationRow = {
        ...currentEnforcementAttestation,
        attestationStatus: "attested",
        requiredOutcome: currentEnforcement.requiredOutcome,
        enforcementStatusSnapshot: currentEnforcement.enforcementStatus,
        lastAttestedAt: now,
        lastAttestedBy: actor.id,
        attestationReason: reason,
        freshnessStatus: asEnforcementAttestationFreshnessStatus(currentEnforcement.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEnforcementAttestations.upsert(nextAttestation)
      store.workflowOpsAlertEnforcementAttestations.set(nextAttestation.id, nextAttestation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_dispute_enforcement_attested",
        actorId: actor.id,
        target: nextAttestation.matterId,
        classification: nextAttestation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        enforcement: currentEnforcement,
        enforcementAttestation: nextAttestation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reopen_workflow_ops_alert_dispute_enforcement_attestation") {
      const reason = normalizeReason(parsed.reason, "dispute_enforcement_attestation_reopened")
      const nextEnforcement: WorkflowOpsAlertDisputeEnforcementLedgerRow = {
        ...currentEnforcement,
        enforcementStatus: "in_progress",
        enforcedAt: null,
        lastStatusChangedAt: now,
        freshnessStatus: asEnforcementFreshnessStatus(currentDispute.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertDisputeEnforcementLedgers.upsert(nextEnforcement)
      store.workflowOpsAlertDisputeEnforcementLedgers.set(nextEnforcement.id, nextEnforcement)

      const nextAttestation: WorkflowOpsAlertEnforcementAttestationRow = {
        ...currentEnforcementAttestation,
        attestationStatus: "reopened",
        enforcementStatusSnapshot: nextEnforcement.enforcementStatus,
        attestationReason: reason,
        freshnessStatus: asEnforcementAttestationFreshnessStatus(nextEnforcement.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEnforcementAttestations.upsert(nextAttestation)
      store.workflowOpsAlertEnforcementAttestations.set(nextAttestation.id, nextAttestation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_dispute_enforcement_attestation_reopened",
        actorId: actor.id,
        target: nextAttestation.matterId,
        classification: nextAttestation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        enforcement: nextEnforcement,
        enforcementAttestation: nextAttestation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "open_workflow_ops_alert_closure_debt_variance") {
      const reason = normalizeReason(parsed.reason, "closure_debt_variance_opened")
      const nextVariance: WorkflowOpsAlertClosureDebtVarianceDigestRow = {
        ...currentVariance,
        varianceStatus: "variance_open",
        outstandingVarianceCount: Math.max(
          currentVariance.outstandingVarianceCount,
          currentReconciliation.outstandingDebtCount,
          1
        ),
        varianceDelta: Math.max(
          currentVariance.varianceDelta,
          currentReconciliation.outstandingDebtCount - currentReconciliation.reopenDebtCount,
          1
        ),
        varianceOpenedAt: currentVariance.varianceOpenedAt ?? now,
        varianceResolvedAt: null,
        varianceReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asVarianceFreshnessStatus(currentReconciliation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertClosureDebtVarianceDigests.upsert(nextVariance)
      store.workflowOpsAlertClosureDebtVarianceDigests.set(nextVariance.id, nextVariance)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_closure_debt_variance_opened",
        actorId: actor.id,
        target: nextVariance.matterId,
        classification: nextVariance.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        reconciliation: currentReconciliation,
        variance: nextVariance,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_workflow_ops_alert_closure_debt_variance_owner") {
      const ownerId = typeof parsed.ownerId === "string" ? parsed.ownerId.trim() : ""
      if (!ownerId) {
        return NextResponse.json({ error: "ownerId is required" }, { status: 400 })
      }
      const reason = normalizeReason(parsed.reason, "closure_debt_variance_owner_assigned")
      const nextVariance: WorkflowOpsAlertClosureDebtVarianceDigestRow = {
        ...currentVariance,
        varianceStatus: "variance_reviewing",
        reviewOwnerId: ownerId,
        varianceOpenedAt: currentVariance.varianceOpenedAt ?? now,
        varianceResolvedAt: null,
        varianceReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asVarianceFreshnessStatus(currentReconciliation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertClosureDebtVarianceDigests.upsert(nextVariance)
      store.workflowOpsAlertClosureDebtVarianceDigests.set(nextVariance.id, nextVariance)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_closure_debt_variance_owner_assigned",
        actorId: actor.id,
        target: nextVariance.matterId,
        classification: nextVariance.classification,
        reason: `${reason}:${ownerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        reconciliation: currentReconciliation,
        variance: nextVariance,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_workflow_ops_alert_closure_debt_variance") {
      const reason = normalizeReason(parsed.reason, "closure_debt_variance_resolved")
      const nextVariance: WorkflowOpsAlertClosureDebtVarianceDigestRow = {
        ...currentVariance,
        varianceStatus: "variance_resolved",
        outstandingVarianceCount: 0,
        varianceDelta: 0,
        varianceResolvedAt: now,
        varianceReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asVarianceFreshnessStatus(currentReconciliation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertClosureDebtVarianceDigests.upsert(nextVariance)
      store.workflowOpsAlertClosureDebtVarianceDigests.set(nextVariance.id, nextVariance)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_closure_debt_variance_resolved",
        actorId: actor.id,
        target: nextVariance.matterId,
        classification: nextVariance.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        reconciliation: currentReconciliation,
        variance: nextVariance,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "create_workflow_ops_alert_enforcement_waiver") {
      if (
        currentEnforcement.enforcementStatus !== "in_progress" &&
        currentEnforcement.enforcementStatus !== "enforced" &&
        currentEnforcement.enforcementStatus !== "waived"
      ) {
        return NextResponse.json(
          { error: "waiver can only be created when enforcement is in_progress, enforced, or waived" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "enforcement_waiver_created")
      const nextWaiver: WorkflowOpsAlertEnforcementWaiverLedgerRow = {
        ...currentWaiverLedger,
        waiverStatus: "pending_attestation",
        requestedBy: actor.id,
        requestedAt: currentWaiverLedger.requestedAt ?? now,
        attestedBy: null,
        attestedAt: null,
        waivedBy: null,
        waivedAt: null,
        waiverReason: reason,
        waiverExpiresAt: null,
        lastStatusChangedAt: now,
        freshnessStatus: asEnforcementWaiverFreshnessStatus(currentEnforcement.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEnforcementWaiverLedgers.upsert(nextWaiver)
      store.workflowOpsAlertEnforcementWaiverLedgers.set(nextWaiver.id, nextWaiver)
      const nextWaiverExpiryDigest = buildWorkflowOpsAlertWaiverExpiryDigestRow({
        waiverLedger: nextWaiver,
        actorId: actor.id,
        reason,
        existing: currentWaiverExpiryDigest,
        now,
      })
      await repos.workflowOpsAlertWaiverExpiryDigests.upsert(nextWaiverExpiryDigest)
      store.workflowOpsAlertWaiverExpiryDigests.set(nextWaiverExpiryDigest.id, nextWaiverExpiryDigest)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_enforcement_waiver_created",
        actorId: actor.id,
        target: nextWaiver.matterId,
        classification: nextWaiver.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        enforcement: currentEnforcement,
        enforcementWaiver: nextWaiver,
        waiverExpiryDigest: nextWaiverExpiryDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_workflow_ops_alert_enforcement_waiver") {
      if (currentWaiverLedger.waiverStatus !== "pending_attestation") {
        return NextResponse.json(
          { error: "waiver must be pending_attestation before attestation" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "enforcement_waiver_attested")
      const nextWaiver: WorkflowOpsAlertEnforcementWaiverLedgerRow = {
        ...currentWaiverLedger,
        waiverStatus: "attested",
        attestedBy: actor.id,
        attestedAt: now,
        waiverReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asEnforcementWaiverFreshnessStatus(currentEnforcement.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEnforcementWaiverLedgers.upsert(nextWaiver)
      store.workflowOpsAlertEnforcementWaiverLedgers.set(nextWaiver.id, nextWaiver)
      const nextWaiverExpiryDigest = buildWorkflowOpsAlertWaiverExpiryDigestRow({
        waiverLedger: nextWaiver,
        actorId: actor.id,
        reason,
        existing: currentWaiverExpiryDigest,
        now,
      })
      await repos.workflowOpsAlertWaiverExpiryDigests.upsert(nextWaiverExpiryDigest)
      store.workflowOpsAlertWaiverExpiryDigests.set(nextWaiverExpiryDigest.id, nextWaiverExpiryDigest)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_enforcement_waiver_attested",
        actorId: actor.id,
        target: nextWaiver.matterId,
        classification: nextWaiver.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        enforcementWaiver: nextWaiver,
        waiverExpiryDigest: nextWaiverExpiryDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "waive_workflow_ops_alert_enforcement_waiver") {
      const reason = normalizeReason(parsed.reason, "enforcement_waiver_waived")
      const waiverExpiresAt = parseOptionalFutureEpochMs(parsed.waiverExpiresAt, now, "waiverExpiresAt")
      const nextWaiver: WorkflowOpsAlertEnforcementWaiverLedgerRow = {
        ...currentWaiverLedger,
        waiverStatus: "waived",
        waivedBy: actor.id,
        waivedAt: now,
        waiverReason: reason,
        waiverExpiresAt,
        lastStatusChangedAt: now,
        freshnessStatus: asEnforcementWaiverFreshnessStatus(currentEnforcement.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEnforcementWaiverLedgers.upsert(nextWaiver)
      store.workflowOpsAlertEnforcementWaiverLedgers.set(nextWaiver.id, nextWaiver)

      const nextEnforcement: WorkflowOpsAlertDisputeEnforcementLedgerRow = {
        ...currentEnforcement,
        enforcementStatus: "waived",
        waivedAt: now,
        waiverReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asEnforcementFreshnessStatus(currentDispute.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertDisputeEnforcementLedgers.upsert(nextEnforcement)
      store.workflowOpsAlertDisputeEnforcementLedgers.set(nextEnforcement.id, nextEnforcement)
      const nextWaiverExpiryDigest = buildWorkflowOpsAlertWaiverExpiryDigestRow({
        waiverLedger: nextWaiver,
        actorId: actor.id,
        reason,
        existing: currentWaiverExpiryDigest,
        now,
      })
      await repos.workflowOpsAlertWaiverExpiryDigests.upsert(nextWaiverExpiryDigest)
      store.workflowOpsAlertWaiverExpiryDigests.set(nextWaiverExpiryDigest.id, nextWaiverExpiryDigest)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_enforcement_waiver_waived",
        actorId: actor.id,
        target: nextWaiver.matterId,
        classification: nextWaiver.classification,
        reason: `${reason}:${waiverExpiresAt ?? "no_expiry"}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        enforcement: nextEnforcement,
        enforcementWaiver: nextWaiver,
        waiverExpiryDigest: nextWaiverExpiryDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_workflow_ops_alert_waiver_expiry_digest") {
      if (
        currentWaiverExpiryDigest.expiryStatus === "no_risk" ||
        currentWaiverExpiryDigest.expiryStatus === "extended"
      ) {
        return NextResponse.json(
          { error: "waiver expiry digest must be at-risk before acknowledgment" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "waiver_expiry_acknowledged")
      const nextWaiverExpiryDigest: WorkflowOpsAlertWaiverExpiryDigestRow = {
        ...currentWaiverExpiryDigest,
        expiryStatus: "acknowledged",
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryFreshnessStatus(currentWaiverLedger.recomputedAt, now),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDigests.upsert(nextWaiverExpiryDigest)
      store.workflowOpsAlertWaiverExpiryDigests.set(nextWaiverExpiryDigest.id, nextWaiverExpiryDigest)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_digest_acknowledged",
        actorId: actor.id,
        target: nextWaiverExpiryDigest.matterId,
        classification: nextWaiverExpiryDigest.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        enforcementWaiver: currentWaiverLedger,
        waiverExpiryDigest: nextWaiverExpiryDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "extend_workflow_ops_alert_waiver_expiry_digest") {
      if (currentWaiverLedger.waiverStatus !== "waived") {
        return NextResponse.json(
          { error: "waiver expiry can only be extended when waiver status is waived" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "waiver_expiry_extended")
      const waiverExpiresAt = parseOptionalFutureEpochMs(parsed.waiverExpiresAt, now, "waiverExpiresAt")
      if (waiverExpiresAt === null) {
        return NextResponse.json({ error: "waiverExpiresAt is required" }, { status: 400 })
      }
      const nextWaiver: WorkflowOpsAlertEnforcementWaiverLedgerRow = {
        ...currentWaiverLedger,
        waivedBy: actor.id,
        waivedAt: now,
        waiverReason: reason,
        waiverExpiresAt,
        lastStatusChangedAt: now,
        freshnessStatus: asEnforcementWaiverFreshnessStatus(currentEnforcement.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertEnforcementWaiverLedgers.upsert(nextWaiver)
      store.workflowOpsAlertEnforcementWaiverLedgers.set(nextWaiver.id, nextWaiver)

      const recomputedWaiverExpiryDigest = buildWorkflowOpsAlertWaiverExpiryDigestRow({
        waiverLedger: nextWaiver,
        actorId: actor.id,
        reason,
        existing: currentWaiverExpiryDigest,
        now,
      })
      const nextWaiverExpiryDigest: WorkflowOpsAlertWaiverExpiryDigestRow = {
        ...recomputedWaiverExpiryDigest,
        expiryStatus: "extended",
        extendedBy: actor.id,
        extendedAt: now,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryFreshnessStatus(nextWaiver.recomputedAt, now),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDigests.upsert(nextWaiverExpiryDigest)
      store.workflowOpsAlertWaiverExpiryDigests.set(nextWaiverExpiryDigest.id, nextWaiverExpiryDigest)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_digest_extended",
        actorId: actor.id,
        target: nextWaiverExpiryDigest.matterId,
        classification: nextWaiverExpiryDigest.classification,
        reason: `${reason}:${waiverExpiresAt}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        enforcementWaiver: nextWaiver,
        waiverExpiryDigest: nextWaiverExpiryDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "queue_workflow_ops_alert_variance_remediation") {
      const reason = normalizeReason(parsed.reason, "variance_remediation_queued")
      const nextVariance: WorkflowOpsAlertClosureDebtVarianceDigestRow = {
        ...currentVariance,
        varianceStatus:
          currentVariance.varianceStatus === "variance_resolved" ||
          currentVariance.varianceStatus === "within_tolerance"
            ? "variance_open"
            : currentVariance.varianceStatus,
        outstandingVarianceCount: Math.max(currentVariance.outstandingVarianceCount, 1),
        varianceDelta: Math.max(currentVariance.varianceDelta, 1),
        varianceOpenedAt: currentVariance.varianceOpenedAt ?? now,
        varianceResolvedAt: null,
        varianceReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asVarianceFreshnessStatus(currentReconciliation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertClosureDebtVarianceDigests.upsert(nextVariance)
      store.workflowOpsAlertClosureDebtVarianceDigests.set(nextVariance.id, nextVariance)

      const nextQueue: WorkflowOpsAlertVarianceRemediationQueueRow = {
        ...currentVarianceRemediationQueue,
        queueStatus: "queued",
        queueReason: reason,
        queuedAt: currentVarianceRemediationQueue.queuedAt ?? now,
        ownerId: nextVariance.reviewOwnerId ?? currentVarianceRemediationQueue.ownerId,
        assignedAt: null,
        resolvedAt: null,
        resolutionReason: null,
        outstandingVarianceCountSnapshot: Math.max(nextVariance.outstandingVarianceCount, 1),
        varianceDeltaSnapshot: Math.max(nextVariance.varianceDelta, 1),
        lastStatusChangedAt: now,
        freshnessStatus: asVarianceRemediationQueueFreshnessStatus(nextVariance.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertVarianceRemediationQueues.upsert(nextQueue)
      store.workflowOpsAlertVarianceRemediationQueues.set(nextQueue.id, nextQueue)
      const nextSlaLedger = buildWorkflowOpsAlertVarianceRemediationSlaLedgerRow({
        remediationQueue: nextQueue,
        actorId: actor.id,
        reason,
        existing: currentVarianceRemediationSlaLedger,
        now,
      })
      await repos.workflowOpsAlertVarianceRemediationSlaLedgers.upsert(nextSlaLedger)
      store.workflowOpsAlertVarianceRemediationSlaLedgers.set(nextSlaLedger.id, nextSlaLedger)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_variance_remediation_queued",
        actorId: actor.id,
        target: nextQueue.matterId,
        classification: nextQueue.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        variance: nextVariance,
        remediationQueue: nextQueue,
        remediationSlaLedger: nextSlaLedger,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_workflow_ops_alert_variance_remediation_owner") {
      const ownerId = typeof parsed.ownerId === "string" ? parsed.ownerId.trim() : ""
      if (!ownerId) {
        return NextResponse.json({ error: "ownerId is required" }, { status: 400 })
      }
      if (
        currentVarianceRemediationQueue.queueStatus !== "queued" &&
        currentVarianceRemediationQueue.queueStatus !== "assigned"
      ) {
        return NextResponse.json(
          { error: "variance remediation queue must be queued before assignment" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "variance_remediation_owner_assigned")
      const nextQueue: WorkflowOpsAlertVarianceRemediationQueueRow = {
        ...currentVarianceRemediationQueue,
        queueStatus: "assigned",
        queueReason: reason,
        ownerId,
        assignedAt: now,
        resolvedAt: null,
        resolutionReason: null,
        lastStatusChangedAt: now,
        freshnessStatus: asVarianceRemediationQueueFreshnessStatus(currentVariance.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertVarianceRemediationQueues.upsert(nextQueue)
      store.workflowOpsAlertVarianceRemediationQueues.set(nextQueue.id, nextQueue)
      const nextSlaLedger = buildWorkflowOpsAlertVarianceRemediationSlaLedgerRow({
        remediationQueue: nextQueue,
        actorId: actor.id,
        reason,
        existing: currentVarianceRemediationSlaLedger,
        now,
      })
      await repos.workflowOpsAlertVarianceRemediationSlaLedgers.upsert(nextSlaLedger)
      store.workflowOpsAlertVarianceRemediationSlaLedgers.set(nextSlaLedger.id, nextSlaLedger)

      const nextVariance: WorkflowOpsAlertClosureDebtVarianceDigestRow = {
        ...currentVariance,
        varianceStatus: "variance_reviewing",
        reviewOwnerId: ownerId,
        varianceOpenedAt: currentVariance.varianceOpenedAt ?? now,
        varianceResolvedAt: null,
        varianceReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asVarianceFreshnessStatus(currentReconciliation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertClosureDebtVarianceDigests.upsert(nextVariance)
      store.workflowOpsAlertClosureDebtVarianceDigests.set(nextVariance.id, nextVariance)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_variance_remediation_owner_assigned",
        actorId: actor.id,
        target: nextQueue.matterId,
        classification: nextQueue.classification,
        reason: `${reason}:${ownerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        variance: nextVariance,
        remediationQueue: nextQueue,
        remediationSlaLedger: nextSlaLedger,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_workflow_ops_alert_variance_remediation") {
      if (
        currentVarianceRemediationQueue.queueStatus !== "queued" &&
        currentVarianceRemediationQueue.queueStatus !== "assigned"
      ) {
        return NextResponse.json(
          { error: "variance remediation queue must be queued or assigned before resolution" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "variance_remediation_resolved")
      const nextQueue: WorkflowOpsAlertVarianceRemediationQueueRow = {
        ...currentVarianceRemediationQueue,
        queueStatus: "resolved",
        queueReason: reason,
        resolvedAt: now,
        resolutionReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asVarianceRemediationQueueFreshnessStatus(currentVariance.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertVarianceRemediationQueues.upsert(nextQueue)
      store.workflowOpsAlertVarianceRemediationQueues.set(nextQueue.id, nextQueue)
      const nextSlaLedger = buildWorkflowOpsAlertVarianceRemediationSlaLedgerRow({
        remediationQueue: nextQueue,
        actorId: actor.id,
        reason,
        existing: currentVarianceRemediationSlaLedger,
        now,
      })
      await repos.workflowOpsAlertVarianceRemediationSlaLedgers.upsert(nextSlaLedger)
      store.workflowOpsAlertVarianceRemediationSlaLedgers.set(nextSlaLedger.id, nextSlaLedger)

      const nextVariance: WorkflowOpsAlertClosureDebtVarianceDigestRow = {
        ...currentVariance,
        varianceStatus: "variance_resolved",
        outstandingVarianceCount: 0,
        varianceDelta: 0,
        varianceResolvedAt: now,
        varianceReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asVarianceFreshnessStatus(currentReconciliation.recomputedAt, now),
        updatedAt: now,
      }
      await repos.workflowOpsAlertClosureDebtVarianceDigests.upsert(nextVariance)
      store.workflowOpsAlertClosureDebtVarianceDigests.set(nextVariance.id, nextVariance)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_variance_remediation_resolved",
        actorId: actor.id,
        target: nextQueue.matterId,
        classification: nextQueue.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        variance: nextVariance,
        remediationQueue: nextQueue,
        remediationSlaLedger: nextSlaLedger,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_workflow_ops_alert_variance_remediation_sla_ledger") {
      if (currentVarianceRemediationSlaLedger.slaStatus === "not_applicable") {
        return NextResponse.json(
          { error: "variance remediation SLA ledger is not applicable for current queue state" },
          { status: 400 }
        )
      }
      if (currentVarianceRemediationSlaLedger.slaStatus === "resolved") {
        return NextResponse.json(
          { error: "variance remediation SLA ledger is already resolved" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "variance_remediation_sla_acknowledged")
      const nextSlaLedger: WorkflowOpsAlertVarianceRemediationSlaLedgerRow = {
        ...currentVarianceRemediationSlaLedger,
        slaStatus: "acknowledged",
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        lastStatusChangedAt: now,
        freshnessStatus: asVarianceRemediationSlaFreshnessStatus(
          currentVarianceRemediationQueue.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertVarianceRemediationSlaLedgers.upsert(nextSlaLedger)
      store.workflowOpsAlertVarianceRemediationSlaLedgers.set(nextSlaLedger.id, nextSlaLedger)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_variance_remediation_sla_acknowledged",
        actorId: actor.id,
        target: nextSlaLedger.matterId,
        classification: nextSlaLedger.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationQueue: currentVarianceRemediationQueue,
        remediationSlaLedger: nextSlaLedger,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_workflow_ops_alert_variance_remediation_sla_ledger") {
      if (currentVarianceRemediationQueue.queueStatus !== "resolved") {
        return NextResponse.json(
          { error: "variance remediation queue must be resolved before closing SLA ledger" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "variance_remediation_sla_resolved")
      const nextSlaLedger: WorkflowOpsAlertVarianceRemediationSlaLedgerRow = {
        ...currentVarianceRemediationSlaLedger,
        slaStatus: "resolved",
        resolvedBy: actor.id,
        resolvedAt: now,
        resolutionReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asVarianceRemediationSlaFreshnessStatus(
          currentVarianceRemediationQueue.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertVarianceRemediationSlaLedgers.upsert(nextSlaLedger)
      store.workflowOpsAlertVarianceRemediationSlaLedgers.set(nextSlaLedger.id, nextSlaLedger)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_variance_remediation_sla_resolved",
        actorId: actor.id,
        target: nextSlaLedger.matterId,
        classification: nextSlaLedger.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationQueue: currentVarianceRemediationQueue,
        remediationSlaLedger: nextSlaLedger,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "open_workflow_ops_alert_waiver_expiry_dispute") {
      if (currentWaiverExpiryDigest.expiryStatus === "no_risk") {
        return NextResponse.json(
          { error: "waiver expiry dispute requires an at-risk waiver expiry digest" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "waiver_expiry_dispute_opened")
      const nextDispute: WorkflowOpsAlertWaiverExpiryDisputeRow = {
        ...currentWaiverExpiryDispute,
        disputeStatus: "open",
        openedBy: actor.id,
        openedAt: currentWaiverExpiryDispute.openedAt ?? now,
        resolvedBy: null,
        resolvedAt: null,
        resolutionOutcome: null,
        resolutionReason: null,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeFreshnessStatus(currentWaiverExpiryDigest.recomputedAt, now),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputes.upsert(nextDispute)
      store.workflowOpsAlertWaiverExpiryDisputes.set(nextDispute.id, nextDispute)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_opened",
        actorId: actor.id,
        target: nextDispute.matterId,
        classification: nextDispute.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDigest: currentWaiverExpiryDigest,
        waiverExpiryDispute: nextDispute,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_workflow_ops_alert_waiver_expiry_dispute_reviewer") {
      const reviewerId = typeof parsed.reviewerId === "string" ? parsed.reviewerId.trim() : ""
      if (!reviewerId) {
        return NextResponse.json({ error: "reviewerId is required" }, { status: 400 })
      }
      if (
        currentWaiverExpiryDispute.disputeStatus !== "open" &&
        currentWaiverExpiryDispute.disputeStatus !== "review_assigned"
      ) {
        return NextResponse.json(
          { error: "waiver expiry dispute must be open before reviewer assignment" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "waiver_expiry_dispute_reviewer_assigned")
      const nextDispute: WorkflowOpsAlertWaiverExpiryDisputeRow = {
        ...currentWaiverExpiryDispute,
        disputeStatus: "review_assigned",
        reviewerId,
        reviewAssignedAt: now,
        resolvedBy: null,
        resolvedAt: null,
        resolutionOutcome: null,
        resolutionReason: null,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeFreshnessStatus(currentWaiverExpiryDigest.recomputedAt, now),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputes.upsert(nextDispute)
      store.workflowOpsAlertWaiverExpiryDisputes.set(nextDispute.id, nextDispute)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_reviewer_assigned",
        actorId: actor.id,
        target: nextDispute.matterId,
        classification: nextDispute.classification,
        reason: `${reason}:${reviewerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDigest: currentWaiverExpiryDigest,
        waiverExpiryDispute: nextDispute,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_workflow_ops_alert_waiver_expiry_dispute") {
      if (
        currentWaiverExpiryDispute.disputeStatus !== "open" &&
        currentWaiverExpiryDispute.disputeStatus !== "review_assigned"
      ) {
        return NextResponse.json(
          { error: "waiver expiry dispute must be open before resolution" },
          { status: 400 }
        )
      }
      const resolutionOutcome =
        parseWaiverExpiryDisputeOutcome(parsed.resolutionOutcome) ?? "expiry_upheld"
      const reason = normalizeReason(parsed.reason, "waiver_expiry_dispute_resolved")
      const nextDispute: WorkflowOpsAlertWaiverExpiryDisputeRow = {
        ...currentWaiverExpiryDispute,
        disputeStatus: "resolved",
        resolvedBy: actor.id,
        resolvedAt: now,
        resolutionOutcome,
        resolutionReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeFreshnessStatus(currentWaiverExpiryDigest.recomputedAt, now),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputes.upsert(nextDispute)
      store.workflowOpsAlertWaiverExpiryDisputes.set(nextDispute.id, nextDispute)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_resolved",
        actorId: actor.id,
        target: nextDispute.matterId,
        classification: nextDispute.classification,
        reason: `${reason}:${resolutionOutcome}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDigest: currentWaiverExpiryDigest,
        waiverExpiryDispute: nextDispute,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "open_workflow_ops_alert_variance_remediation_sla_breach_escalation") {
      if (
        currentVarianceRemediationSlaLedger.slaStatus !== "breached" &&
        currentVarianceRemediationSlaLedger.slaStatus !== "acknowledged"
      ) {
        return NextResponse.json(
          { error: "SLA breach escalation requires breached or acknowledged remediation SLA status" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "variance_remediation_sla_breach_escalation_opened")
      const nextEscalation: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow = {
        ...currentVarianceRemediationSlaBreachEscalation,
        escalationStatus: "open",
        openedAt: currentVarianceRemediationSlaBreachEscalation.openedAt ?? now,
        resolvedAt: null,
        resolutionReason: null,
        lastStatusChangedAt: now,
        freshnessStatus: asRemediationSlaBreachEscalationFreshnessStatus(
          currentVarianceRemediationSlaLedger.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachEscalations.upsert(nextEscalation)
      store.workflowOpsAlertVarianceRemediationSlaBreachEscalations.set(nextEscalation.id, nextEscalation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_variance_remediation_sla_breach_escalation_opened",
        actorId: actor.id,
        target: nextEscalation.matterId,
        classification: nextEscalation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaLedger: currentVarianceRemediationSlaLedger,
        remediationSlaBreachEscalation: nextEscalation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_workflow_ops_alert_variance_remediation_sla_breach_escalation_owner") {
      const ownerId = typeof parsed.ownerId === "string" ? parsed.ownerId.trim() : ""
      if (!ownerId) {
        return NextResponse.json({ error: "ownerId is required" }, { status: 400 })
      }
      if (
        currentVarianceRemediationSlaBreachEscalation.escalationStatus !== "open" &&
        currentVarianceRemediationSlaBreachEscalation.escalationStatus !== "assigned"
      ) {
        return NextResponse.json(
          { error: "SLA breach escalation must be open before owner assignment" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "variance_remediation_sla_breach_escalation_owner_assigned")
      const nextEscalation: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow = {
        ...currentVarianceRemediationSlaBreachEscalation,
        escalationStatus: "assigned",
        ownerId,
        openedAt: currentVarianceRemediationSlaBreachEscalation.openedAt ?? now,
        resolvedAt: null,
        resolutionReason: null,
        lastStatusChangedAt: now,
        freshnessStatus: asRemediationSlaBreachEscalationFreshnessStatus(
          currentVarianceRemediationSlaLedger.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachEscalations.upsert(nextEscalation)
      store.workflowOpsAlertVarianceRemediationSlaBreachEscalations.set(nextEscalation.id, nextEscalation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_variance_remediation_sla_breach_escalation_owner_assigned",
        actorId: actor.id,
        target: nextEscalation.matterId,
        classification: nextEscalation.classification,
        reason: `${reason}:${ownerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaLedger: currentVarianceRemediationSlaLedger,
        remediationSlaBreachEscalation: nextEscalation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_workflow_ops_alert_variance_remediation_sla_breach_escalation") {
      if (
        currentVarianceRemediationSlaBreachEscalation.escalationStatus !== "open" &&
        currentVarianceRemediationSlaBreachEscalation.escalationStatus !== "assigned"
      ) {
        return NextResponse.json(
          { error: "SLA breach escalation must be open or assigned before resolution" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "variance_remediation_sla_breach_escalation_resolved")
      const nextEscalation: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow = {
        ...currentVarianceRemediationSlaBreachEscalation,
        escalationStatus: "resolved",
        resolvedAt: now,
        resolutionReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asRemediationSlaBreachEscalationFreshnessStatus(
          currentVarianceRemediationSlaLedger.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachEscalations.upsert(nextEscalation)
      store.workflowOpsAlertVarianceRemediationSlaBreachEscalations.set(nextEscalation.id, nextEscalation)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_variance_remediation_sla_breach_escalation_resolved",
        actorId: actor.id,
        target: nextEscalation.matterId,
        classification: nextEscalation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaLedger: currentVarianceRemediationSlaLedger,
        remediationSlaBreachEscalation: nextEscalation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "open_workflow_ops_alert_waiver_expiry_dispute_adjudication") {
      if (currentWaiverExpiryDispute.disputeStatus === "not_contested") {
        return NextResponse.json(
          { error: "waiver-expiry dispute adjudication requires a contested waiver-expiry dispute" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "waiver_expiry_dispute_adjudication_opened")
      const openedAt = currentWaiverExpiryDisputeAdjudication.openedAt ?? now
      const nextAdjudication: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow = {
        ...currentWaiverExpiryDisputeAdjudication,
        adjudicationStatus: "open",
        disputeStatusSnapshot: currentWaiverExpiryDispute.disputeStatus,
        requestedOutcome: currentWaiverExpiryDispute.resolutionOutcome,
        panelOwnerId:
          currentWaiverExpiryDisputeAdjudication.panelOwnerId ??
          currentWaiverExpiryDispute.reviewerId,
        openedAt,
        dueAt: openedAt + WAIVER_EXPIRY_DISPUTE_ADJUDICATION_DUE_MS,
        resolvedAt: null,
        resolutionOutcome: null,
        resolutionReason: null,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationFreshnessStatus(
          currentWaiverExpiryDispute.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudications.upsert(nextAdjudication)
      store.workflowOpsAlertWaiverExpiryDisputeAdjudications.set(nextAdjudication.id, nextAdjudication)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_adjudication_opened",
        actorId: actor.id,
        target: nextAdjudication.matterId,
        classification: nextAdjudication.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDispute: currentWaiverExpiryDispute,
        waiverExpiryDisputeAdjudication: nextAdjudication,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_workflow_ops_alert_waiver_expiry_dispute_adjudication_panel_owner") {
      const panelOwnerId = typeof parsed.panelOwnerId === "string" ? parsed.panelOwnerId.trim() : ""
      if (!panelOwnerId) {
        return NextResponse.json({ error: "panelOwnerId is required" }, { status: 400 })
      }
      if (
        currentWaiverExpiryDisputeAdjudication.adjudicationStatus !== "open" &&
        currentWaiverExpiryDisputeAdjudication.adjudicationStatus !== "panel_assigned"
      ) {
        return NextResponse.json(
          { error: "waiver-expiry dispute adjudication must be open before assigning panel owner" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "waiver_expiry_dispute_adjudication_panel_owner_assigned")
      const openedAt = currentWaiverExpiryDisputeAdjudication.openedAt ?? now
      const nextAdjudication: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow = {
        ...currentWaiverExpiryDisputeAdjudication,
        adjudicationStatus: "panel_assigned",
        disputeStatusSnapshot: currentWaiverExpiryDispute.disputeStatus,
        requestedOutcome: currentWaiverExpiryDispute.resolutionOutcome,
        panelOwnerId,
        openedAt,
        dueAt:
          currentWaiverExpiryDisputeAdjudication.dueAt ??
          openedAt + WAIVER_EXPIRY_DISPUTE_ADJUDICATION_DUE_MS,
        resolvedAt: null,
        resolutionOutcome: null,
        resolutionReason: null,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationFreshnessStatus(
          currentWaiverExpiryDispute.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudications.upsert(nextAdjudication)
      store.workflowOpsAlertWaiverExpiryDisputeAdjudications.set(nextAdjudication.id, nextAdjudication)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_adjudication_panel_owner_assigned",
        actorId: actor.id,
        target: nextAdjudication.matterId,
        classification: nextAdjudication.classification,
        reason: `${reason}:${panelOwnerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDispute: currentWaiverExpiryDispute,
        waiverExpiryDisputeAdjudication: nextAdjudication,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_workflow_ops_alert_waiver_expiry_dispute_adjudication") {
      if (
        currentWaiverExpiryDisputeAdjudication.adjudicationStatus !== "open" &&
        currentWaiverExpiryDisputeAdjudication.adjudicationStatus !== "panel_assigned"
      ) {
        return NextResponse.json(
          { error: "waiver-expiry dispute adjudication must be open or panel-assigned before resolution" },
          { status: 400 }
        )
      }
      const resolutionOutcome =
        parseWaiverExpiryDisputeOutcome(parsed.resolutionOutcome) ??
        currentWaiverExpiryDispute.resolutionOutcome ??
        "expiry_upheld"
      const reason = normalizeReason(parsed.reason, "waiver_expiry_dispute_adjudication_resolved")
      const nextAdjudication: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow = {
        ...currentWaiverExpiryDisputeAdjudication,
        adjudicationStatus: "resolved",
        disputeStatusSnapshot: currentWaiverExpiryDispute.disputeStatus,
        requestedOutcome: currentWaiverExpiryDispute.resolutionOutcome,
        resolvedAt: now,
        resolutionOutcome,
        resolutionReason: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationFreshnessStatus(
          currentWaiverExpiryDispute.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudications.upsert(nextAdjudication)
      store.workflowOpsAlertWaiverExpiryDisputeAdjudications.set(nextAdjudication.id, nextAdjudication)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_adjudication_resolved",
        actorId: actor.id,
        target: nextAdjudication.matterId,
        classification: nextAdjudication.classification,
        reason: `${reason}:${resolutionOutcome}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDispute: currentWaiverExpiryDispute,
        waiverExpiryDisputeAdjudication: nextAdjudication,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint") {
      if (currentVarianceRemediationSlaBreachEscalation.escalationStatus === "not_required") {
        return NextResponse.json(
          { error: "resolution checkpoint requires an active remediation-SLA breach escalation" },
          { status: 400 }
        )
      }
      const checkpointOwnerId =
        typeof parsed.checkpointOwnerId === "string" && parsed.checkpointOwnerId.trim().length > 0
          ? parsed.checkpointOwnerId.trim()
          : currentRemediationSlaBreachResolutionCheckpoint.checkpointOwnerId ??
            currentVarianceRemediationSlaBreachEscalation.ownerId
      const reason = normalizeReason(parsed.reason, "variance_remediation_sla_breach_resolution_checkpoint_opened")
      const openedAt = currentRemediationSlaBreachResolutionCheckpoint.openedAt ?? now
      const nextCheckpoint: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow = {
        ...currentRemediationSlaBreachResolutionCheckpoint,
        checkpointStatus: "open",
        escalationStatusSnapshot: currentVarianceRemediationSlaBreachEscalation.escalationStatus,
        ownerIdSnapshot: currentVarianceRemediationSlaBreachEscalation.ownerId,
        checkpointOwnerId: checkpointOwnerId ?? null,
        openedAt,
        dueAt: openedAt + REMEDIATION_SLA_BREACH_RESOLUTION_CHECKPOINT_DUE_MS,
        checkpointRecordedAt: null,
        reopenedAt: null,
        resolutionNote: null,
        lastStatusChangedAt: now,
        freshnessStatus: asRemediationSlaBreachResolutionCheckpointFreshnessStatus(
          currentVarianceRemediationSlaBreachEscalation.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.upsert(
        nextCheckpoint
      )
      store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.set(
        nextCheckpoint.id,
        nextCheckpoint
      )

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_variance_remediation_sla_breach_resolution_checkpoint_opened",
        actorId: actor.id,
        target: nextCheckpoint.matterId,
        classification: nextCheckpoint.classification,
        reason: checkpointOwnerId ? `${reason}:${checkpointOwnerId}` : reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaBreachEscalation: currentVarianceRemediationSlaBreachEscalation,
        remediationSlaBreachResolutionCheckpoint: nextCheckpoint,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (
      parsed.action === "record_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint"
    ) {
      if (
        currentRemediationSlaBreachResolutionCheckpoint.checkpointStatus !== "open" &&
        currentRemediationSlaBreachResolutionCheckpoint.checkpointStatus !== "reopened"
      ) {
        return NextResponse.json(
          { error: "resolution checkpoint must be open or reopened before record" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "variance_remediation_sla_breach_resolution_checkpoint_recorded")
      const nextCheckpoint: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow = {
        ...currentRemediationSlaBreachResolutionCheckpoint,
        checkpointStatus: "checkpoint_recorded",
        escalationStatusSnapshot: currentVarianceRemediationSlaBreachEscalation.escalationStatus,
        ownerIdSnapshot: currentVarianceRemediationSlaBreachEscalation.ownerId,
        checkpointRecordedAt: now,
        reopenedAt: null,
        dueAt: null,
        resolutionNote: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asRemediationSlaBreachResolutionCheckpointFreshnessStatus(
          currentVarianceRemediationSlaBreachEscalation.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.upsert(
        nextCheckpoint
      )
      store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.set(
        nextCheckpoint.id,
        nextCheckpoint
      )

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_variance_remediation_sla_breach_resolution_checkpoint_recorded",
        actorId: actor.id,
        target: nextCheckpoint.matterId,
        classification: nextCheckpoint.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaBreachEscalation: currentVarianceRemediationSlaBreachEscalation,
        remediationSlaBreachResolutionCheckpoint: nextCheckpoint,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (
      parsed.action === "reopen_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint"
    ) {
      if (currentRemediationSlaBreachResolutionCheckpoint.checkpointStatus !== "checkpoint_recorded") {
        return NextResponse.json(
          { error: "resolution checkpoint must be recorded before reopening" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(parsed.reason, "variance_remediation_sla_breach_resolution_checkpoint_reopened")
      const nextCheckpoint: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow = {
        ...currentRemediationSlaBreachResolutionCheckpoint,
        checkpointStatus: "reopened",
        escalationStatusSnapshot: currentVarianceRemediationSlaBreachEscalation.escalationStatus,
        ownerIdSnapshot: currentVarianceRemediationSlaBreachEscalation.ownerId,
        dueAt: now + REMEDIATION_SLA_BREACH_RESOLUTION_CHECKPOINT_DUE_MS,
        checkpointRecordedAt: null,
        reopenedAt: now,
        resolutionNote: reason,
        reopenPressureCount: currentRemediationSlaBreachResolutionCheckpoint.reopenPressureCount + 1,
        lastStatusChangedAt: now,
        freshnessStatus: asRemediationSlaBreachResolutionCheckpointFreshnessStatus(
          currentVarianceRemediationSlaBreachEscalation.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.upsert(
        nextCheckpoint
      )
      store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.set(
        nextCheckpoint.id,
        nextCheckpoint
      )

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_variance_remediation_sla_breach_resolution_checkpoint_reopened",
        actorId: actor.id,
        target: nextCheckpoint.matterId,
        classification: nextCheckpoint.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaBreachEscalation: currentVarianceRemediationSlaBreachEscalation,
        remediationSlaBreachResolutionCheckpoint: nextCheckpoint,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "open_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_stewardship") {
      if (currentWaiverExpiryDisputeAdjudication.adjudicationStatus === "not_required") {
        return NextResponse.json(
          { error: "adjudication SLO stewardship requires an active waiver-expiry dispute adjudication" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(
        parsed.reason,
        "waiver_expiry_dispute_adjudication_slo_stewardship_opened"
      )
      const dueAtSnapshot =
        currentWaiverExpiryDisputeAdjudication.dueAt ??
        currentWaiverExpiryDisputeAdjudicationSlo.extendedDueAt ??
        now + WAIVER_EXPIRY_DISPUTE_ADJUDICATION_DUE_MS
      const nextSlo: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow = {
        ...currentWaiverExpiryDisputeAdjudicationSlo,
        sloStatus: "watch",
        adjudicationStatusSnapshot: currentWaiverExpiryDisputeAdjudication.adjudicationStatus,
        panelOwnerIdSnapshot: currentWaiverExpiryDisputeAdjudication.panelOwnerId,
        dueAtSnapshot,
        dueWindowDebtMs: computeDueWindowDebtMs(dueAtSnapshot, now),
        stewardId:
          currentWaiverExpiryDisputeAdjudicationSlo.stewardId ??
          currentWaiverExpiryDisputeAdjudication.panelOwnerId ??
          actor.id,
        openedAt: currentWaiverExpiryDisputeAdjudicationSlo.openedAt ?? now,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationSloFreshnessStatus(
          currentWaiverExpiryDisputeAdjudication.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.upsert(nextSlo)
      store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.set(nextSlo.id, nextSlo)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_adjudication_slo_stewardship_opened",
        actorId: actor.id,
        target: nextSlo.matterId,
        classification: nextSlo.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDisputeAdjudication: currentWaiverExpiryDisputeAdjudication,
        waiverExpiryDisputeAdjudicationSlo: nextSlo,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "extend_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_deadline") {
      if (
        currentWaiverExpiryDisputeAdjudicationSlo.sloStatus !== "watch" &&
        currentWaiverExpiryDisputeAdjudicationSlo.sloStatus !== "deadline_extended"
      ) {
        return NextResponse.json(
          { error: "adjudication SLO stewardship must be watch or deadline-extended before extension" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(
        parsed.reason,
        "waiver_expiry_dispute_adjudication_slo_deadline_extended"
      )
      const baselineDueAt =
        currentWaiverExpiryDisputeAdjudicationSlo.extendedDueAt ??
        currentWaiverExpiryDisputeAdjudicationSlo.dueAtSnapshot ??
        now
      const extendedDueAt =
        parseOptionalFutureEpochMs(parsed.extendedDueAt, now, "extendedDueAt") ??
        baselineDueAt + WAIVER_EXPIRY_DISPUTE_ADJUDICATION_SLO_EXTENSION_MS
      const nextSlo: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow = {
        ...currentWaiverExpiryDisputeAdjudicationSlo,
        sloStatus: "deadline_extended",
        adjudicationStatusSnapshot: currentWaiverExpiryDisputeAdjudication.adjudicationStatus,
        panelOwnerIdSnapshot: currentWaiverExpiryDisputeAdjudication.panelOwnerId,
        dueAtSnapshot: currentWaiverExpiryDisputeAdjudication.dueAt,
        dueWindowDebtMs: computeDueWindowDebtMs(extendedDueAt, now),
        stewardId: actor.id,
        deadlineExtendedAt: now,
        extendedDueAt,
        sloNote: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationSloFreshnessStatus(
          currentWaiverExpiryDisputeAdjudication.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.upsert(nextSlo)
      store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.set(nextSlo.id, nextSlo)

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_adjudication_slo_deadline_extended",
        actorId: actor.id,
        target: nextSlo.matterId,
        classification: nextSlo.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDisputeAdjudication: currentWaiverExpiryDisputeAdjudication,
        waiverExpiryDisputeAdjudicationSlo: nextSlo,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach") {
      if (
        currentWaiverExpiryDisputeAdjudicationSlo.sloStatus !== "watch" &&
        currentWaiverExpiryDisputeAdjudicationSlo.sloStatus !== "deadline_extended"
      ) {
        return NextResponse.json(
          { error: "adjudication SLO stewardship must be watch or deadline-extended before breach acknowledgment" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(
        parsed.reason,
        "waiver_expiry_dispute_adjudication_slo_breach_acknowledged"
      )
      const dueAtForDebt =
        currentWaiverExpiryDisputeAdjudicationSlo.extendedDueAt ??
        currentWaiverExpiryDisputeAdjudicationSlo.dueAtSnapshot ??
        currentWaiverExpiryDisputeAdjudication.dueAt
      const nextSlo: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow = {
        ...currentWaiverExpiryDisputeAdjudicationSlo,
        sloStatus: "breach_acknowledged",
        adjudicationStatusSnapshot: currentWaiverExpiryDisputeAdjudication.adjudicationStatus,
        panelOwnerIdSnapshot: currentWaiverExpiryDisputeAdjudication.panelOwnerId,
        dueAtSnapshot: currentWaiverExpiryDisputeAdjudication.dueAt,
        dueWindowDebtMs: computeDueWindowDebtMs(dueAtForDebt, now),
        stewardId: actor.id,
        breachAcknowledgedAt: now,
        sloNote: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationSloFreshnessStatus(
          currentWaiverExpiryDisputeAdjudication.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.upsert(nextSlo)
      store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.set(nextSlo.id, nextSlo)
      const nextDebtRemediation = buildWorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow({
        waiverExpiryDisputeAdjudicationSlo: nextSlo,
        actorId: actor.id,
        reason,
        existing: currentWaiverExpiryDisputeAdjudicationSloDebtRemediation,
        now,
      })
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.upsert(
        nextDebtRemediation
      )
      store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.set(
        nextDebtRemediation.id,
        nextDebtRemediation
      )

      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_adjudication_slo_breach_acknowledged",
        actorId: actor.id,
        target: nextSlo.matterId,
        classification: nextSlo.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDisputeAdjudication: currentWaiverExpiryDisputeAdjudication,
        waiverExpiryDisputeAdjudicationSlo: nextSlo,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation") {
      if (
        currentWaiverExpiryDisputeAdjudicationSlo.sloStatus !== "breach_acknowledged" &&
        currentWaiverExpiryDisputeAdjudicationSloDebtRemediation.debtStatus !== "debt_watch"
      ) {
        return NextResponse.json(
          { error: "SLO debt remediation requires breach-acknowledged stewardship or debt-watch posture" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(
        parsed.reason,
        "waiver_expiry_dispute_adjudication_slo_debt_remediation_recorded"
      )
      const debtRetiredMs =
        typeof parsed.debtRetiredMs === "number" && Number.isFinite(parsed.debtRetiredMs)
          ? Math.max(0, parsed.debtRetiredMs)
          : currentWaiverExpiryDisputeAdjudicationSloDebtRemediation.dueWindowDebtMsSnapshot
      const nextDebt: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow = {
        ...currentWaiverExpiryDisputeAdjudicationSloDebtRemediation,
        debtStatus: "remediation_recorded",
        sloStatusSnapshot: currentWaiverExpiryDisputeAdjudicationSlo.sloStatus,
        dueWindowDebtMsSnapshot: currentWaiverExpiryDisputeAdjudicationSlo.dueWindowDebtMs,
        debtRetiredMs,
        remediationRecordedBy: actor.id,
        remediationRecordedAt: now,
        remediationNote: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationSloDebtRemediationFreshnessStatus(
          currentWaiverExpiryDisputeAdjudicationSlo.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.upsert(nextDebt)
      store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.set(nextDebt.id, nextDebt)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation_recorded",
        actorId: actor.id,
        target: nextDebt.matterId,
        classification: nextDebt.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDisputeAdjudicationSlo: currentWaiverExpiryDisputeAdjudicationSlo,
        waiverExpiryDisputeAdjudicationSloDebtRemediation: nextDebt,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "downshift_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_tier") {
      if (currentWaiverExpiryDisputeAdjudicationSloDebtRemediation.debtStatus !== "remediation_recorded") {
        return NextResponse.json(
          { error: "SLO tier downshift requires recorded debt remediation" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(
        parsed.reason,
        "waiver_expiry_dispute_adjudication_slo_tier_downshifted"
      )
      const nextDebt: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow = {
        ...currentWaiverExpiryDisputeAdjudicationSloDebtRemediation,
        debtStatus: "tier_downshifted",
        tierDownshiftedBy: actor.id,
        tierDownshiftedAt: now,
        remediationNote: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationSloDebtRemediationFreshnessStatus(
          currentWaiverExpiryDisputeAdjudicationSlo.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.upsert(nextDebt)
      store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.set(nextDebt.id, nextDebt)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_adjudication_slo_tier_downshifted",
        actorId: actor.id,
        target: nextDebt.matterId,
        classification: nextDebt.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDisputeAdjudicationSloDebtRemediation: nextDebt,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (
      parsed.action === "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach_closure"
    ) {
      if (
        currentWaiverExpiryDisputeAdjudicationSloDebtRemediation.debtStatus !== "remediation_recorded" &&
        currentWaiverExpiryDisputeAdjudicationSloDebtRemediation.debtStatus !== "tier_downshifted"
      ) {
        return NextResponse.json(
          { error: "SLO breach closure attestation requires remediation or tier-downshift posture" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(
        parsed.reason,
        "waiver_expiry_dispute_adjudication_slo_breach_closure_attested"
      )
      const nextDebt: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow = {
        ...currentWaiverExpiryDisputeAdjudicationSloDebtRemediation,
        debtStatus: "breach_closure_attested",
        breachClosureAttestedBy: actor.id,
        breachClosureAttestedAt: now,
        remediationNote: reason,
        lastStatusChangedAt: now,
        freshnessStatus: asWaiverExpiryDisputeAdjudicationSloDebtRemediationFreshnessStatus(
          currentWaiverExpiryDisputeAdjudicationSlo.recomputedAt,
          now
        ),
        recomputedAt: now,
        recomputedBy: actor.id,
        recomputeReason: reason,
        updatedAt: now,
      }
      await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.upsert(nextDebt)
      store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.set(nextDebt.id, nextDebt)
      const priorAuditCount = store.audit.length
      store.audit.push({
        action: "ops_reporting_alert_waiver_expiry_dispute_adjudication_slo_breach_closure_attested",
        actorId: actor.id,
        target: nextDebt.matterId,
        classification: nextDebt.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        waiverExpiryDisputeAdjudicationSloDebtRemediation: nextDebt,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (
      parsed.action ===
      "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation"
    ) {
      if (currentRemediationSlaBreachResolutionCheckpoint.checkpointStatus === "not_required") {
        return NextResponse.json(
          { error: "checkpoint expiry attestation requires an active resolution checkpoint" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(
        parsed.reason,
        "variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_opened"
      )
      const nextAttestation: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow =
        {
          ...currentRemediationSlaBreachResolutionCheckpointExpiryAttestation,
          attestationStatus: "open",
          checkpointStatusSnapshot: currentRemediationSlaBreachResolutionCheckpoint.checkpointStatus,
          dueAtSnapshot: currentRemediationSlaBreachResolutionCheckpoint.dueAt,
          expiryRiskStatus: computeCheckpointExpiryRiskStatus(
            currentRemediationSlaBreachResolutionCheckpoint.dueAt,
            now
          ),
          reopenPressureCount: currentRemediationSlaBreachResolutionCheckpoint.reopenPressureCount,
          lastStatusChangedAt: now,
          freshnessStatus: asRemediationSlaBreachResolutionCheckpointExpiryAttestationFreshnessStatus(
            currentRemediationSlaBreachResolutionCheckpoint.recomputedAt,
            now
          ),
          recomputedAt: now,
          recomputedBy: actor.id,
          recomputeReason: reason,
          updatedAt: now,
        }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.upsert(
        nextAttestation
      )
      store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.set(
        nextAttestation.id,
        nextAttestation
      )

      const priorAuditCount = store.audit.length
      store.audit.push({
        action:
          "ops_reporting_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_opened",
        actorId: actor.id,
        target: nextAttestation.matterId,
        classification: nextAttestation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaBreachResolutionCheckpoint: currentRemediationSlaBreachResolutionCheckpoint,
        remediationSlaBreachResolutionCheckpointExpiryAttestation: nextAttestation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (
      parsed.action ===
      "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry"
    ) {
      if (currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.attestationStatus !== "open") {
        return NextResponse.json(
          { error: "checkpoint expiry attestation must be open before attest" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(
        parsed.reason,
        "variance_remediation_sla_breach_resolution_checkpoint_expiry_attested"
      )
      const nextAttestation: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow =
        {
          ...currentRemediationSlaBreachResolutionCheckpointExpiryAttestation,
          attestationStatus: "attested",
          checkpointStatusSnapshot: currentRemediationSlaBreachResolutionCheckpoint.checkpointStatus,
          dueAtSnapshot: currentRemediationSlaBreachResolutionCheckpoint.dueAt,
          expiryRiskStatus: computeCheckpointExpiryRiskStatus(
            currentRemediationSlaBreachResolutionCheckpoint.dueAt,
            now
          ),
          attestedBy: actor.id,
          attestedAt: now,
          attestationNote: reason,
          reopenPressureCount: currentRemediationSlaBreachResolutionCheckpoint.reopenPressureCount,
          lastStatusChangedAt: now,
          freshnessStatus: asRemediationSlaBreachResolutionCheckpointExpiryAttestationFreshnessStatus(
            currentRemediationSlaBreachResolutionCheckpoint.recomputedAt,
            now
          ),
          recomputedAt: now,
          recomputedBy: actor.id,
          recomputeReason: reason,
          updatedAt: now,
        }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.upsert(
        nextAttestation
      )
      store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.set(
        nextAttestation.id,
        nextAttestation
      )

      const priorAuditCount = store.audit.length
      store.audit.push({
        action:
          "ops_reporting_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attested",
        actorId: actor.id,
        target: nextAttestation.matterId,
        classification: nextAttestation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaBreachResolutionCheckpoint: currentRemediationSlaBreachResolutionCheckpoint,
        remediationSlaBreachResolutionCheckpointExpiryAttestation: nextAttestation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (
      parsed.action ===
      "acknowledge_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry"
    ) {
      if (
        currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.attestationStatus !== "open" &&
        currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.attestationStatus !== "attested"
      ) {
        return NextResponse.json(
          { error: "checkpoint expiry attestation must be open or attested before acknowledgement" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(
        parsed.reason,
        "variance_remediation_sla_breach_resolution_checkpoint_expiry_acknowledged"
      )
      const nextAttestation: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow =
        {
          ...currentRemediationSlaBreachResolutionCheckpointExpiryAttestation,
          attestationStatus: "expiry_acknowledged",
          checkpointStatusSnapshot: currentRemediationSlaBreachResolutionCheckpoint.checkpointStatus,
          dueAtSnapshot: currentRemediationSlaBreachResolutionCheckpoint.dueAt,
          expiryRiskStatus: computeCheckpointExpiryRiskStatus(
            currentRemediationSlaBreachResolutionCheckpoint.dueAt,
            now
          ),
          attestedBy:
            currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.attestedBy ?? actor.id,
          attestedAt:
            currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.attestedAt ?? now,
          expiryAcknowledgedBy: actor.id,
          expiryAcknowledgedAt: now,
          attestationNote: reason,
          reopenPressureCount: currentRemediationSlaBreachResolutionCheckpoint.reopenPressureCount,
          lastStatusChangedAt: now,
          freshnessStatus: asRemediationSlaBreachResolutionCheckpointExpiryAttestationFreshnessStatus(
            currentRemediationSlaBreachResolutionCheckpoint.recomputedAt,
            now
          ),
          recomputedAt: now,
          recomputedBy: actor.id,
          recomputeReason: reason,
          updatedAt: now,
        }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.upsert(
        nextAttestation
      )
      store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.set(
        nextAttestation.id,
        nextAttestation
      )
      const nextExceptionReconciliation =
        buildWorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow(
          {
            expiryAttestation: nextAttestation,
            actorId: actor.id,
            reason,
            existing:
              currentRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation,
            now,
          }
        )
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.upsert(
        nextExceptionReconciliation
      )
      store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.set(
        nextExceptionReconciliation.id,
        nextExceptionReconciliation
      )

      const priorAuditCount = store.audit.length
      store.audit.push({
        action:
          "ops_reporting_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_acknowledged",
        actorId: actor.id,
        target: nextAttestation.matterId,
        classification: nextAttestation.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaBreachResolutionCheckpoint: currentRemediationSlaBreachResolutionCheckpoint,
        remediationSlaBreachResolutionCheckpointExpiryAttestation: nextAttestation,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (
      parsed.action ===
      "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception"
    ) {
      if (
        currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.attestationStatus !==
          "expiry_acknowledged" &&
        currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.expiryRiskStatus !== "expired"
      ) {
        return NextResponse.json(
          {
            error:
              "checkpoint expiry attestation exception requires expiry acknowledgement or expired risk",
          },
          { status: 400 }
        )
      }
      const reason = normalizeReason(
        parsed.reason,
        "variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_opened"
      )
      const nextException: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow =
        {
          ...currentRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation,
          exceptionStatus: "exception_open",
          attestationStatusSnapshot:
            currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.attestationStatus,
          expiryRiskStatusSnapshot:
            currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.expiryRiskStatus,
          exceptionOpenedBy: actor.id,
          exceptionOpenedAt: now,
          overdueExceptionCount: Math.max(
            currentRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
              .overdueExceptionCount,
            1
          ),
          reconciliationNote: reason,
          lastStatusChangedAt: now,
          freshnessStatus:
            asRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationFreshnessStatus(
              currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.recomputedAt,
              now
            ),
          recomputedAt: now,
          recomputedBy: actor.id,
          recomputeReason: reason,
          updatedAt: now,
        }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.upsert(
        nextException
      )
      store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.set(
        nextException.id,
        nextException
      )
      const priorAuditCount = store.audit.length
      store.audit.push({
        action:
          "ops_reporting_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_opened",
        actorId: actor.id,
        target: nextException.matterId,
        classification: nextException.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaBreachResolutionCheckpointExpiryAttestation:
          currentRemediationSlaBreachResolutionCheckpointExpiryAttestation,
        remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation: nextException,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (
      parsed.action ===
      "assign_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_owner"
    ) {
      if (
        currentRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
          .exceptionStatus !== "exception_open" &&
        currentRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
          .exceptionStatus !== "exception_assigned"
      ) {
        return NextResponse.json(
          { error: "exception owner assignment requires open exception posture" },
          { status: 400 }
        )
      }
      const assigneeId =
        typeof parsed.assigneeId === "string" && parsed.assigneeId.length > 0
          ? parsed.assigneeId
          : null
      if (!assigneeId) {
        return NextResponse.json({ error: "assigneeId is required" }, { status: 400 })
      }
      const reason = normalizeReason(
        parsed.reason,
        "variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_owner_assigned"
      )
      const nextException: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow =
        {
          ...currentRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation,
          exceptionStatus: "exception_assigned",
          assigneeId,
          assigneeAssignedAt: now,
          reconciliationNote: reason,
          lastStatusChangedAt: now,
          freshnessStatus:
            asRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationFreshnessStatus(
              currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.recomputedAt,
              now
            ),
          recomputedAt: now,
          recomputedBy: actor.id,
          recomputeReason: reason,
          updatedAt: now,
        }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.upsert(
        nextException
      )
      store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.set(
        nextException.id,
        nextException
      )
      const priorAuditCount = store.audit.length
      store.audit.push({
        action:
          "ops_reporting_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_owner_assigned",
        actorId: actor.id,
        target: nextException.matterId,
        classification: nextException.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation: nextException,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (
      parsed.action ===
      "reconcile_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception"
    ) {
      if (
        currentRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
          .exceptionStatus !== "exception_open" &&
        currentRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation
          .exceptionStatus !== "exception_assigned"
      ) {
        return NextResponse.json(
          { error: "exception reconciliation requires open or assigned exception posture" },
          { status: 400 }
        )
      }
      const reason = normalizeReason(
        parsed.reason,
        "variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciled"
      )
      const nextException: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow =
        {
          ...currentRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation,
          exceptionStatus: "exception_reconciled",
          reconciledBy: actor.id,
          reconciledAt: now,
          reconciliationNote: reason,
          lastStatusChangedAt: now,
          freshnessStatus:
            asRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationFreshnessStatus(
              currentRemediationSlaBreachResolutionCheckpointExpiryAttestation.recomputedAt,
              now
            ),
          recomputedAt: now,
          recomputedBy: actor.id,
          recomputeReason: reason,
          updatedAt: now,
        }
      await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.upsert(
        nextException
      )
      store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.set(
        nextException.id,
        nextException
      )
      const priorAuditCount = store.audit.length
      store.audit.push({
        action:
          "ops_reporting_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciled",
        actorId: actor.id,
        target: nextException.matterId,
        classification: nextException.classification,
        reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: parsed.action,
        digest: current,
        remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliation: nextException,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    const reason = normalizeReason(parsed.reason, "escalation_resolved")
    const nextEscalation: WorkflowOpsAlertEscalationLedgerRow = {
      ...currentEscalation,
      escalationStatus: "resolved",
      lastStatusChangedAt: now,
      resolvedAt: now,
      resolutionReason: reason,
      freshnessStatus: asEscalationFreshnessStatus(current.recomputedAt, now),
      updatedAt: now,
    }
    await repos.workflowOpsAlertEscalationLedgers.upsert(nextEscalation)
    store.workflowOpsAlertEscalationLedgers.set(nextEscalation.id, nextEscalation)
    const priorAuditCount = store.audit.length
    store.audit.push({
      action: "ops_reporting_alert_escalation_resolved",
      actorId: actor.id,
      target: nextEscalation.matterId,
      classification: nextEscalation.classification,
      reason,
    })
    await persistAuditEntriesSince(store, repos, priorAuditCount)
    const payload = {
      action: parsed.action,
      digest: current,
      escalation: nextEscalation,
    }
    idempotency.set(key, payload, fingerprint)
    return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : "ops reporting action failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
