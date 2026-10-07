import { NextResponse } from "next/server"
import { PublicError } from "@/platform/http/publicError"
import { withSession, type HandlerSession } from "@/platform/http/withSession"
import { gateByFlag, isFilingsCoreRequest } from "@/platform/flags/routeGate"
import { isFeatureEnabled } from "@/platform/flags/featureFlags"
import { REQUEST_FAILED_CODE, errorResponse, publicErrorMessage } from "@/platform/http/errors"
import { resolvePartnerOverride } from "@/services/d4-2/partnerOverride"
import { closureRowVisible } from "@/services/d4-3/closureVisibility"
import { DraftCharsetError } from "@/services/d4-2/draftCharset"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { isClassification } from "@/platform/p1/types"
import { rankOf, rankOfStoredOrMax } from "@/platform/spine/store"
import type {
  Classification,
  FilingEscalationClosureComplianceDigestRow,
  FilingEscalationClosureFollowupQueueRow,
} from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { persistAuditEntriesSince } from "@/platform/persistence/auditWriteThrough"
import { buildFilingPacketArtifactRow } from "@/platform/persistence/filingPacketArtifacts"
import {
  buildFilingDispatchQueueRow,
  filingDispatchQueueId,
  isFilingDispatchQueueStatus,
} from "@/platform/persistence/filingDispatchQueue"
import {
  annexureReadyForTransport,
  buildFilingAnnexureRow,
  filingAnnexureId,
  isFilingAnnexureGenerationStatus,
} from "@/platform/persistence/filingAnnexures"
import {
  buildFilingSubmissionReceiptRow,
  buildFilingSubmissionReconciliationRow,
  filingSubmissionReconciliationId,
  isFilingSubmissionCourtChannel,
  isFilingSubmissionDispatchOutcome,
  isFilingSubmissionReconciliationStatus,
} from "@/platform/persistence/filingSubmissionReceipts"
import {
  buildSubmissionExceptionRowFromFailure,
  filingSubmissionExceptionId,
  isFilingSubmissionExceptionSeverity,
  isFilingSubmissionExceptionStatus,
} from "@/platform/persistence/filingSubmissionExceptions"
import {
  buildFilingTransportExecutionEvidenceRow,
  isFilingTransportExecutionChannel,
  isFilingTransportExecutionOutcome,
} from "@/platform/persistence/filingTransportExecutionEvidence"
import {
  buildSubmissionSlaDigestRow,
  filingSubmissionSlaDigestId,
  isFilingSubmissionSlaDigestStatus,
} from "@/platform/persistence/filingSubmissionSlaDigests"
import {
  buildFilingEscalationOwnerRotaRow,
  filingEscalationOwnerRotaId,
  isFilingEscalationOwnerRotaStatus,
} from "@/platform/persistence/filingEscalationOwnerRota"
import {
  buildFilingEscalationWorkloadDigestRow,
  filingEscalationWorkloadDigestId,
  isFilingEscalationHandoffLagBucket,
  isFilingEscalationWorkloadDigestStatus,
} from "@/platform/persistence/filingEscalationWorkloadDigests"
import {
  buildFilingEscalationPolicyBaselineRow,
  buildFilingEscalationWaiverLedgerRow,
  DEFAULT_ESCALATION_HANDOFF_SLA_MS,
  DEFAULT_ESCALATION_OWNER_LOAD_THRESHOLD,
  DEFAULT_ESCALATION_WAIVER_WINDOW_MS,
  filingEscalationPolicyBaselineId,
  isFilingEscalationPolicyBaselineScope,
  isFilingEscalationWaiverStatus,
} from "@/platform/persistence/filingEscalationPolicyWaivers"
import {
  buildFilingEscalationPolicyVarianceDigestRow,
  buildFilingEscalationWaiverExpiryDigestRow,
  filingEscalationPolicyVarianceDigestId,
  filingEscalationWaiverExpiryDigestId,
  isFilingEscalationPolicyVarianceDigestStatus,
  isFilingEscalationWaiverExpiryDigestStatus,
} from "@/platform/persistence/filingEscalationGovernanceDigests"
import {
  buildFilingEscalationVarianceRemediationRow,
  buildFilingEscalationWaiverRolloverAttestationRow,
  isFilingEscalationVarianceRemediationDecision,
  isFilingEscalationVarianceRemediationStatus,
  isFilingEscalationWaiverRolloverStatus,
} from "@/platform/persistence/filingEscalationRemediationLedger"
import {
  buildFilingEscalationRemediationLifecycleRow,
  buildFilingEscalationRolloverReaffirmationSlaRow,
  filingEscalationRolloverReaffirmationSlaId,
  isFilingEscalationRemediationClosureOutcome,
  isFilingEscalationRemediationLifecycleStatus,
  isFilingEscalationRolloverReaffirmationSlaStatus,
  remediationStatusFromClosureOutcome,
  requiresSecondApproverForRemediationDecision,
} from "@/platform/persistence/filingEscalationLifecycleAndReaffirmation"
import {
  buildFilingEscalationClosureAutoAssignmentRuleRow,
  buildFilingEscalationClosureComplianceDigestRow,
  buildFilingEscalationClosureFollowupQueueRow,
  buildFilingEscalationClosureSlaWindowConfigRow,
  buildFilingEscalationClosureSlaWindowRow,
  DEFAULT_CLOSURE_ACK_DEADLINE_MS,
  DEFAULT_CLOSURE_AUTO_ASSIGNMENT_MAX_ACTIVE_CLAIMS,
  DEFAULT_CLOSURE_AUTO_ESCALATION_MS,
  DEFAULT_CLOSURE_CLEAR_DEADLINE_MS,
  filingEscalationClosureAutoAssignmentRuleId,
  filingEscalationClosureComplianceDigestId,
  filingEscalationClosureFollowupQueueId,
  filingEscalationClosureSlaWindowConfigId,
  isFilingEscalationClosureAutoAssignmentMode,
  isFilingEscalationClosureComplianceDigestStatus,
  isFilingEscalationClosureFollowupQueueStatus,
  isFilingEscalationClosureSlaPressureLevel,
  isFilingEscalationClosureSlaWindowScope,
  isFilingEscalationClosureSlaWindowStatus,
} from "@/platform/persistence/filingEscalationClosureCompliance"
import {
  buildFilingEscalationClosureAttestationRow,
  buildFilingEscalationClosureSlaExceptionDigestRow,
  filingEscalationClosureSlaExceptionDigestId,
  isFilingEscalationClosureAttestationStatus,
  isFilingEscalationClosureSlaExceptionReason,
  isFilingEscalationClosureSlaExceptionStatus,
} from "@/platform/persistence/filingEscalationClosureAttestationExceptions"
import {
  buildFilingEscalationClosureAttestationDisputeRow,
  buildFilingEscalationClosureSlaExceptionEnforcementRow,
  filingEscalationClosureSlaExceptionEnforcementId,
  isFilingEscalationClosureAttestationDisputeStatus,
  isFilingEscalationClosureSlaExceptionEnforcementStatus,
} from "@/platform/persistence/filingEscalationClosureAttestationDisputes"
import {
  buildFilingEscalationClosureAdjudicationQueueRow,
  buildFilingEscalationClosureEnforcementRebalanceRow,
  filingEscalationClosureAdjudicationQueueId,
  filingEscalationClosureEnforcementRebalanceId,
  isFilingEscalationClosureAdjudicationStatus,
  isFilingEscalationClosureAdjudicationVerdict,
  isFilingEscalationClosureEnforcementRebalanceStatus,
} from "@/platform/persistence/filingEscalationClosureExceptionAdjudication"
import {
  buildFilingEscalationClosureAdjudicationQuorumRow,
  buildFilingEscalationClosureRebalanceExecutionRow,
  filingEscalationClosureAdjudicationQuorumId,
  filingEscalationClosureRebalanceExecutionId,
  isFilingEscalationClosureAdjudicationQuorumStatus,
  isFilingEscalationClosureRebalanceExecutionMode,
  isFilingEscalationClosureRebalanceExecutionStatus,
} from "@/platform/persistence/filingEscalationClosureAdjudicationQuorum"
import {
  buildFilingEscalationClosureAdjudicationSloRow,
  buildFilingEscalationClosureRebalanceSafeguardRow,
  filingEscalationClosureAdjudicationSloId,
  filingEscalationClosureRebalanceSafeguardId,
  isFilingEscalationClosureAdjudicationSloEscalationTier,
  isFilingEscalationClosureAdjudicationSloStatus,
  isFilingEscalationClosureRebalanceSafeguardStatus,
  isFilingEscalationClosureRebalanceSuppressionReason,
} from "@/platform/persistence/filingEscalationClosureAdjudicationSloSafeguards"
import {
  buildFilingEscalationClosureAdjudicationSloDebtRemediationRow,
  buildFilingEscalationClosureRebalanceSafeguardExpiryRow,
  canDownshiftClosureAdjudicationSloTier,
  filingEscalationClosureAdjudicationSloDebtRemediationId,
  filingEscalationClosureRebalanceSafeguardExpiryId,
  isFilingEscalationClosureAdjudicationSloDebtRemediationStatus,
  isFilingEscalationClosureRebalanceSafeguardExpiryStatus,
} from "@/platform/persistence/filingEscalationClosureSloDebtSafeguardExpiry"
import {
  buildFilingEscalationClosureAdjudicationDebtBurndownRow,
  buildFilingEscalationClosureSafeguardExpiryAttestationRow,
  filingEscalationClosureAdjudicationDebtBurndownId,
  filingEscalationClosureSafeguardExpiryAttestationId,
  isFilingEscalationClosureAdjudicationDebtBurndownStatus,
  isFilingEscalationClosureSafeguardExpiryAttestationStatus,
} from "@/platform/persistence/filingEscalationClosureDebtBurndownExpiryAttestations"
import {
  buildFilingEscalationClosureBurndownRecalibrationRow,
  buildFilingEscalationClosureExpiryAttestationQueueRow,
  filingEscalationClosureBurndownRecalibrationId,
  filingEscalationClosureExpiryAttestationQueueId,
  isFilingEscalationClosureBurndownRecalibrationStatus,
  isFilingEscalationClosureExpiryAttestationQueueStatus,
} from "@/platform/persistence/filingEscalationClosureBurndownRecalibrationQueueOrchestration"
import {
  buildFilingEscalationClosureBurndownSettlementRow,
  buildFilingEscalationClosureExpiryAttestationQueueDrainRow,
  filingEscalationClosureBurndownSettlementId,
  filingEscalationClosureExpiryAttestationQueueDrainId,
  isFilingEscalationClosureBurndownSettlementStatus,
  isFilingEscalationClosureExpiryAttestationQueueDrainStatus,
} from "@/platform/persistence/filingEscalationClosureBurndownSettlementQueueDrainGovernance"
import {
  buildFilingEscalationClosureSettlementAttestationRow,
  buildFilingEscalationClosureQueueDrainReconciliationRow,
  filingEscalationClosureSettlementAttestationId,
  filingEscalationClosureQueueDrainReconciliationId,
  isFilingEscalationClosureSettlementAttestationStatus,
  isFilingEscalationClosureQueueDrainReconciliationStatus,
} from "@/platform/persistence/filingEscalationClosureSettlementAttestationQueueDrainReconciliationGovernance"
import {
  buildFilingEscalationClosureSettlementArbitrationRow,
  buildFilingEscalationClosureQueueReentryComplianceRow,
  filingEscalationClosureSettlementArbitrationId,
  filingEscalationClosureQueueReentryComplianceId,
  isFilingEscalationClosureSettlementArbitrationStatus,
  isFilingEscalationClosureQueueReentryComplianceStatus,
} from "@/platform/persistence/filingEscalationClosureSettlementArbitrationQueueReentryCompliance"
import {
  buildFilingEscalationRemediationExpiryDigestRow,
  buildFilingEscalationRolloverBreachWatchRow,
  filingEscalationRemediationExpiryDigestId,
  filingEscalationRolloverBreachWatchId,
  isFilingEscalationRemediationExpiryDigestStatus,
  isFilingEscalationRolloverBreachWatchStatus,
} from "@/platform/persistence/filingEscalationExpiryAndWatchDigests"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  applyFilingPackageDecision,
  createFilingPackage,
  DraftChangedError,
  draftShouldBeLocked,
  filingPackageDecisionPatch,
  PackageAlreadyDecidedError,
  planFilingPackageDecision,
} from "@/services/d4-3/filingPackage"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)
const HOUR_MS = 60 * 60 * 1000

type CreateBody = {
  action: "create_package"
  actorId?: string
  matterId?: string
  draftId?: string
  classification?: string
  citedJudgmentIds?: string[]
  temporalCitations?: Array<{
    sectionId: string
    offenceDate: string
    usedText: string
  }>
  partnerOverride?: {
    partnerId?: string
    reason?: string
  }
}

type DecideBody = {
  action: "decide_package"
  actorId?: string
  packageId?: string
  decision?: "approve" | "reject"
  reason?: string
  partnerOverride?: {
    partnerId?: string
    reason?: string
  }
}

type DispatchUpdateBody = {
  action: "dispatch_update"
  actorId?: string
  packageId?: string
  nextStatus?: "queued" | "in_progress" | "retry_pending" | "handoff_ready" | "blocked"
  assigneeId?: string | null
  note?: string
  markAttempt?: boolean
}

type AnnexureCheckpointBody = {
  action: "annexure_checkpoint"
  actorId?: string
  packageId?: string
  checkpoint?:
    | "mark_assembling"
    | "mark_artifact_ready"
    | "record_partner_signoff"
    | "record_clerk_verification"
    | "mark_ready_for_transport"
  artifactId?: string
  note?: string
}

type RecordSubmissionReceiptBody = {
  action: "record_submission_receipt"
  actorId?: string
  packageId?: string
  courtChannel?: "efiling_portal_stub" | "physical_counter_stub" | "courier_stub"
  dispatchOutcome?: "accepted" | "rejected" | "retry_scheduled"
  submissionReference?: string
  failureReason?: string
  retryHint?: string
  note?: string
}

type ReconcileSubmissionBody = {
  action: "reconcile_submission"
  actorId?: string
  packageId?: string
  status?: "open" | "reconciled" | "needs_retry"
  note?: string
}

type ClaimSubmissionExceptionBody = {
  action: "claim_submission_exception"
  actorId?: string
  packageId?: string
  note?: string
}

type EscalateSubmissionExceptionBody = {
  action: "escalate_submission_exception"
  actorId?: string
  packageId?: string
  escalationOwnerId?: string
  severity?: "medium" | "high" | "critical"
  slaHours?: number
  note?: string
}

type ResolveSubmissionExceptionBody = {
  action: "resolve_submission_exception"
  actorId?: string
  packageId?: string
  note?: string
}

type ReopenSubmissionExceptionBody = {
  action: "reopen_submission_exception"
  actorId?: string
  packageId?: string
  severity?: "medium" | "high" | "critical"
  note?: string
}

type MarkTransportBlockedBody = {
  action: "mark_transport_blocked"
  actorId?: string
  packageId?: string
  transportChannel?:
    | "efiling_portal_stub"
    | "physical_counter_stub"
    | "courier_stub"
    | "operator_followup_stub"
  channelPayloadHash?: string
  blockerTags?: string[]
  attachmentPointers?: string[]
  severity?: "medium" | "high" | "critical"
  note?: string
}

type AttachRetryPlanBody = {
  action: "attach_retry_plan"
  actorId?: string
  packageId?: string
  transportChannel?:
    | "efiling_portal_stub"
    | "physical_counter_stub"
    | "courier_stub"
    | "operator_followup_stub"
  channelPayloadHash?: string
  attachmentPointers?: string[]
  note?: string
}

type ConfirmDeliveredBody = {
  action: "confirm_delivered"
  actorId?: string
  packageId?: string
  transportChannel?:
    | "efiling_portal_stub"
    | "physical_counter_stub"
    | "courier_stub"
    | "operator_followup_stub"
  channelPayloadHash?: string
  attachmentPointers?: string[]
  relatedReceiptId?: string
  note?: string
}

type AcknowledgeBreachBody = {
  action: "acknowledge_breach"
  actorId?: string
  packageId?: string
  note?: string
}

type DeferWindowBody = {
  action: "defer_window"
  actorId?: string
  packageId?: string
  deferHours?: number
  note?: string
}

type ClearDigestBody = {
  action: "clear_digest"
  actorId?: string
  packageId?: string
  note?: string
}

type AssignPrimaryOwnerBody = {
  action: "assign_primary_owner"
  actorId?: string
  packageId?: string
  primaryOwnerId?: string
  activeWindowHours?: number
  note?: string
}

type SetBackupOwnerBody = {
  action: "set_backup_owner"
  actorId?: string
  packageId?: string
  backupOwnerId?: string
  note?: string
}

type AcknowledgeHandoffBody = {
  action: "acknowledge_handoff"
  actorId?: string
  packageId?: string
  note?: string
}

type RevokeAssignmentBody = {
  action: "revoke_assignment"
  actorId?: string
  packageId?: string
  note?: string
}

type AcknowledgeOwnerDriftBody = {
  action: "acknowledge_owner_drift"
  actorId?: string
  packageId?: string
  note?: string
}

type RebalanceAssignmentBody = {
  action: "rebalance_assignment"
  actorId?: string
  packageId?: string
  newPrimaryOwnerId?: string
  note?: string
}

type SnoozeWorkloadAlertBody = {
  action: "snooze_workload_alert"
  actorId?: string
  packageId?: string
  snoozeHours?: number
  note?: string
}

type SetPolicyBaselineBody = {
  action: "set_policy_baseline"
  actorId?: string
  packageId?: string
  ownerLoadThreshold?: number
  handoffSlaHours?: number
  waiverWindowHours?: number
  note?: string
}

type GrantBreachWaiverBody = {
  action: "grant_breach_waiver"
  actorId?: string
  packageId?: string
  durationHours?: number
  reason?: string
  note?: string
}

type RevokeBreachWaiverBody = {
  action: "revoke_breach_waiver"
  actorId?: string
  packageId?: string
  waiverId?: string
  note?: string
}

type AcknowledgePolicyVarianceBody = {
  action: "acknowledge_policy_variance"
  actorId?: string
  packageId?: string
  note?: string
}

type SnoozePolicyVarianceBody = {
  action: "snooze_policy_variance"
  actorId?: string
  packageId?: string
  snoozeHours?: number
  note?: string
}

type AcknowledgeWaiverExpiryBody = {
  action: "acknowledge_waiver_expiry"
  actorId?: string
  packageId?: string
  note?: string
}

type ExtendBreachWaiverBody = {
  action: "extend_breach_waiver"
  actorId?: string
  packageId?: string
  waiverId?: string
  extendHours?: number
  secondApproverId?: string
  rolloverJustification?: string
  rolloverNote?: string
  note?: string
}

type RecordVarianceRemediationBody = {
  action: "record_variance_remediation"
  actorId?: string
  packageId?: string
  decision?: string
  justification?: string
  expiresInHours?: number
  secondApproverId?: string
  note?: string
}

type AcknowledgeRemediationExpiryBody = {
  action: "acknowledge_remediation_expiry"
  actorId?: string
  packageId?: string
  note?: string
}

type SnoozeRemediationExpiryBody = {
  action: "snooze_remediation_expiry"
  actorId?: string
  packageId?: string
  snoozeHours?: number
  note?: string
}

type AcknowledgeRolloverBreachBody = {
  action: "acknowledge_rollover_breach"
  actorId?: string
  packageId?: string
  note?: string
}

type ReaffirmRolloverAttestationBody = {
  action: "reaffirm_rollover_attestation"
  actorId?: string
  packageId?: string
  waiverId?: string
  note?: string
}

type AttestRemediationClosureBody = {
  action: "attest_remediation_closure"
  actorId?: string
  packageId?: string
  remediationId?: string
  closureOutcome?: string
  note?: string
}

type AcknowledgeRolloverReaffirmationSlaBody = {
  action: "acknowledge_rollover_reaffirmation_sla"
  actorId?: string
  packageId?: string
  note?: string
}

type AssignClosureFollowupBody = {
  action: "assign_closure_followup"
  actorId?: string
  queueId?: string
  ownerId?: string
  assigneeId?: string
  note?: string
}

type ClaimClosureFollowupBody = {
  action: "claim_closure_followup"
  actorId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type ResolveClosureFollowupBody = {
  action: "resolve_closure_followup"
  actorId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type SetClosureSlaWindowConfigBody = {
  action: "set_closure_sla_window_config"
  actorId?: string
  ownerId?: string
  ackDeadlineHours?: number
  clearDeadlineHours?: number
  autoEscalationHours?: number
  note?: string
}

type SetClosureAutoAssignmentRuleBody = {
  action: "set_closure_auto_assignment_rule"
  actorId?: string
  ownerId?: string
  mode?: string
  enabled?: boolean
  maxActiveClaimsPerPartner?: number
  note?: string
}

type AutoAssignClosureFollowupBody = {
  action: "auto_assign_closure_followup"
  actorId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type RecordClosureAttestationBody = {
  action: "record_closure_attestation"
  actorId?: string
  queueId?: string
  ownerId?: string
  secondReviewerId?: string
  partnerConcurrence?: boolean
  evidenceNote?: string
  note?: string
}

type ReviewClosureAttestationBody = {
  action: "review_closure_attestation"
  actorId?: string
  attestationId?: string
  decision?: "approve" | "reject"
  note?: string
}

type WaiveClosureSlaExceptionBody = {
  action: "waive_closure_sla_exception"
  actorId?: string
  queueId?: string
  ownerId?: string
  waiverReason?: string
  waiverHours?: number
  note?: string
}

type OpenClosureAttestationDisputeBody = {
  action: "open_closure_attestation_dispute"
  actorId?: string
  attestationId?: string
  conflictReason?: string
  note?: string
}

type ResolveClosureAttestationDisputeBody = {
  action: "resolve_closure_attestation_dispute"
  actorId?: string
  disputeId?: string
  resolution?: "uphold" | "override"
  note?: string
}

type TickClosureSlaExceptionEnforcementBody = {
  action: "tick_closure_sla_exception_enforcement"
  actorId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type EscalateClosureDisputeToPanelBody = {
  action: "escalate_closure_dispute_to_panel"
  actorId?: string
  disputeId?: string
  panelMemberIds?: string[]
  dissentNote?: string
  note?: string
}

type RecordClosureAdjudicationVerdictBody = {
  action: "record_closure_adjudication_verdict"
  actorId?: string
  adjudicationId?: string
  verdict?: "uphold_dispute" | "override_dispute"
  dissentNote?: string
  note?: string
}

type RebalanceClosureEnforcementQueueBody = {
  action: "rebalance_closure_enforcement_queue"
  actorId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  status?: "none" | "cooldown_scheduled" | "owner_reassignment_recommended" | "throttle_active"
  recommendedOwnerId?: string
  cooldownHours?: number
  throttleHours?: number
  note?: string
}

type GovernClosureAdjudicationQuorumBody = {
  action: "govern_closure_adjudication_quorum"
  actorId?: string
  adjudicationId?: string
  requiredPanelCount?: number
  quorumWindowHours?: number
  verdictWindowHours?: number
  note?: string
}

type ExecuteClosureRebalanceOwnerTransferBody = {
  action: "execute_closure_rebalance_owner_transfer"
  actorId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type ExecuteClosureRebalanceThrottleReleaseBody = {
  action: "execute_closure_rebalance_throttle_release"
  actorId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  reopenQueue?: boolean
  note?: string
}

type ExtendClosureAdjudicationSloDeadlineBody = {
  action: "extend_closure_adjudication_slo_deadline"
  actorId?: string
  sloId?: string
  adjudicationId?: string
  extensionHours?: number
  note?: string
}

type EscalateClosureAdjudicationSloTierBody = {
  action: "escalate_closure_adjudication_slo_tier"
  actorId?: string
  sloId?: string
  adjudicationId?: string
  escalationTier?: string
  note?: string
}

type AcknowledgeClosureAdjudicationSloBreachBody = {
  action: "acknowledge_closure_adjudication_slo_breach"
  actorId?: string
  sloId?: string
  adjudicationId?: string
  note?: string
}

type ConfigureClosureRebalanceSafeguardsBody = {
  action: "configure_closure_rebalance_auto_execution_safeguard"
  actorId?: string
  safeguardId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  cooldownLockHours?: number
  duplicateSuppressionHours?: number
  note?: string
}

type AttestClosureRebalanceOverrideBody = {
  action: "attest_closure_rebalance_auto_execution_override"
  actorId?: string
  safeguardId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  reason?: string
  note?: string
}

type RecordClosureAdjudicationSloDebtRemediationBody = {
  action: "record_closure_adjudication_slo_debt_remediation"
  actorId?: string
  remediationId?: string
  sloId?: string
  adjudicationId?: string
  note?: string
}

type DownshiftClosureAdjudicationSloTierBody = {
  action: "downshift_closure_adjudication_slo_tier"
  actorId?: string
  remediationId?: string
  sloId?: string
  adjudicationId?: string
  escalationTier?: string
  note?: string
}

type AttestClosureAdjudicationSloBreachClosureBody = {
  action: "attest_closure_adjudication_slo_breach_closure"
  actorId?: string
  remediationId?: string
  sloId?: string
  adjudicationId?: string
  note?: string
}

type SetClosureRebalanceSafeguardOverrideExpiryBody = {
  action: "set_closure_rebalance_safeguard_override_expiry"
  actorId?: string
  expiryId?: string
  safeguardId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  overrideExpiryHours?: number
  note?: string
}

type AutoClearClosureRebalanceSafeguardSuppressionBody = {
  action: "auto_clear_closure_rebalance_safeguard_suppression"
  actorId?: string
  expiryId?: string
  safeguardId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type CleanupStaleClosureRebalanceSafeguardLockBody = {
  action: "cleanup_stale_closure_rebalance_safeguard_lock"
  actorId?: string
  expiryId?: string
  safeguardId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type SetClosureAdjudicationDebtBurndownTargetBody = {
  action: "set_closure_adjudication_debt_burndown_target"
  actorId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  targetHours?: number
  note?: string
}

type AttestClosureAdjudicationDebtBacklogBody = {
  action: "attest_closure_adjudication_debt_backlog"
  actorId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  note?: string
}

type CheckpointClosureAdjudicationTierNormalizationBody = {
  action: "checkpoint_closure_adjudication_tier_normalization"
  actorId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  escalationTier?: string
  note?: string
}

type AcknowledgeClosureSafeguardExpiryAttestationBody = {
  action: "acknowledge_closure_safeguard_expiry_attestation"
  actorId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type QueueClosureSafeguardOverdueExpiryExceptionBody = {
  action: "queue_closure_safeguard_overdue_expiry_exception"
  actorId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type ReconcileClosureSafeguardExpiryOverrideBody = {
  action: "reconcile_closure_safeguard_expiry_override"
  actorId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  reconciliationNote?: string
  note?: string
}

type RebaselineClosureAdjudicationBurndownForecastBody = {
  action: "rebaseline_closure_adjudication_burndown_forecast"
  actorId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  targetHours?: number
  note?: string
}

type OverrideClosureAdjudicationBurndownConfidenceBandBody = {
  action: "override_closure_adjudication_burndown_confidence_band"
  actorId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  lowerHours?: number
  upperHours?: number
  note?: string
}

type AnnotateClosureAdjudicationBurndownCheckpointRollbackBody = {
  action: "annotate_closure_adjudication_burndown_checkpoint_rollback"
  actorId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  rollbackReason?: string
  note?: string
}

type TriageClosureSafeguardExpiryAttestationQueueBody = {
  action: "triage_closure_safeguard_expiry_attestation_queue"
  actorId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type AttestClosureSafeguardExpiryQueueHandoffBody = {
  action: "attest_closure_safeguard_expiry_queue_handoff"
  actorId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  handoffToOwnerId?: string
  carryoverNote?: string
  note?: string
}

type CheckpointClosureSafeguardExpiryQueueAutoDrainBody = {
  action: "checkpoint_closure_safeguard_expiry_queue_auto_drain"
  actorId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type AcknowledgeClosureBurndownSettlementDriftBody = {
  action: "acknowledge_closure_burndown_settlement_drift"
  actorId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  note?: string
}

type AttestClosureBurndownSettlementTargetLockBody = {
  action: "attest_closure_burndown_settlement_target_lock"
  actorId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  note?: string
}

type CloseClosureBurndownRollbackResolutionBody = {
  action: "close_closure_burndown_rollback_resolution"
  actorId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  resolutionNote?: string
  note?: string
}

type EscalateClosureExpiryAttestationQueueHandoffTimeoutBody = {
  action: "escalate_closure_expiry_attestation_queue_handoff_timeout"
  actorId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type AttestClosureExpiryAttestationQueueStaleReassignmentBody = {
  action: "attest_closure_expiry_attestation_queue_stale_reassignment"
  actorId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  reassignedOwnerId?: string
  note?: string
}

type CheckpointClosureExpiryAttestationQueueForcedDrainOverrideBody = {
  action: "checkpoint_closure_expiry_attestation_queue_forced_drain_override"
  actorId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  overrideNote?: string
  note?: string
}

type CheckpointClosureSettlementPostResolutionVerificationBody = {
  action: "checkpoint_closure_settlement_post_resolution_verification"
  actorId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  note?: string
}

type AttestClosureSettlementLockReleaseBody = {
  action: "attest_closure_settlement_lock_release"
  actorId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  note?: string
}

type SafeguardClosureSettlementDisputeReopenBody = {
  action: "safeguard_closure_settlement_dispute_reopen"
  actorId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  guardNote?: string
  note?: string
}

type AttestClosureQueueDrainForcedReconciliationBody = {
  action: "attest_closure_queue_drain_forced_reconciliation"
  actorId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type CheckpointClosureQueueDrainReassignmentRollbackBody = {
  action: "checkpoint_closure_queue_drain_reassignment_rollback"
  actorId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  rollbackToOwnerId?: string
  note?: string
}

type ControlClosureQueueDrainTimeoutReentryBody = {
  action: "control_closure_queue_drain_timeout_reentry"
  actorId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  timeoutWindowHours?: number
  note?: string
}

type PetitionClosureSettlementVerificationOverrideBody = {
  action: "petition_closure_settlement_verification_override"
  actorId?: string
  arbitrationId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  overrideReason?: string
  note?: string
}

type AttestClosureSettlementArbitrationPanelConfirmationBody = {
  action: "attest_closure_settlement_arbitration_panel_confirmation"
  actorId?: string
  arbitrationId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  note?: string
}

type CheckpointClosureSettlementReopenVetoBody = {
  action: "checkpoint_closure_settlement_reopen_veto"
  actorId?: string
  arbitrationId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  vetoNote?: string
  note?: string
}

type AttestClosureQueueReentryExceptionBody = {
  action: "attest_closure_queue_reentry_exception"
  actorId?: string
  complianceId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type CheckpointClosureQueueReentryTimeoutWaiverBody = {
  action: "checkpoint_closure_queue_reentry_timeout_waiver"
  actorId?: string
  complianceId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  waiverHours?: number
  note?: string
}

type ControlClosureQueueReentryReconciliationResumeBody = {
  action: "control_closure_queue_reentry_reconciliation_resume"
  actorId?: string
  complianceId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  note?: string
}

type IssueClosureSettlementArbitrationFinalRulingBody = {
  action: "issue_closure_settlement_arbitration_final_ruling"
  actorId?: string
  arbitrationId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  rulingSummary?: string
  note?: string
}

type MemorializeClosureSettlementArbitrationDissentBody = {
  action: "memorialize_closure_settlement_arbitration_dissent"
  actorId?: string
  arbitrationId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  dissentNote?: string
  note?: string
}

type CheckpointClosureSettlementArbitrationRulingPublicationBody = {
  action: "checkpoint_closure_settlement_arbitration_ruling_publication"
  actorId?: string
  arbitrationId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  publicationChannel?: string
  note?: string
}

type LogClosureSettlementArbitrationPublicationCorrectionBody = {
  action: "log_closure_settlement_arbitration_publication_correction"
  actorId?: string
  arbitrationId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  correctionNote?: string
  note?: string
}

type CheckpointClosureSettlementArbitrationPublicationRollbackBody = {
  action: "checkpoint_closure_settlement_arbitration_publication_rollback"
  actorId?: string
  arbitrationId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  rollbackReason?: string
  note?: string
}

type ReviewClosureSettlementArbitrationDistributionAttestationBody = {
  action: "review_closure_settlement_arbitration_distribution_attestation"
  actorId?: string
  arbitrationId?: string
  settlementAttestationId?: string
  settlementId?: string
  recalibrationId?: string
  burndownId?: string
  remediationId?: string
  adjudicationId?: string
  decision?: "approved" | "revision_required"
  note?: string
}

type AssignClosureQueueReentryExceptionDebtBody = {
  action: "assign_closure_queue_reentry_exception_debt"
  actorId?: string
  complianceId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  assigneeId?: string
  note?: string
}

type AttestClosureQueueReentryDebtRetirementBody = {
  action: "attest_closure_queue_reentry_debt_retirement"
  actorId?: string
  complianceId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  retiredCount?: number
  note?: string
}

type ControlClosureQueueReentryDebtAgingAutoEscalationBody = {
  action: "control_closure_queue_reentry_debt_aging_auto_escalation"
  actorId?: string
  complianceId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  agingHours?: number
  note?: string
}

type OpenClosureQueueReentryDebtRetirementDisputeBody = {
  action: "open_closure_queue_reentry_debt_retirement_dispute"
  actorId?: string
  complianceId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  disputeReason?: string
  note?: string
}

type ResolveClosureQueueReentryDebtRetirementDisputeBody = {
  action: "resolve_closure_queue_reentry_debt_retirement_dispute"
  actorId?: string
  complianceId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  resolution?: "uphold_retirement" | "reopen_debt"
  note?: string
}

type ControlClosureQueueReentryDebtRetirementRollbackBody = {
  action: "control_closure_queue_reentry_debt_retirement_rollback"
  actorId?: string
  complianceId?: string
  reconciliationId?: string
  drainId?: string
  queueItemId?: string
  attestationId?: string
  expiryId?: string
  rebalanceId?: string
  queueId?: string
  ownerId?: string
  rollbackCount?: number
  note?: string
}

type Body =
  | CreateBody
  | DecideBody
  | DispatchUpdateBody
  | AnnexureCheckpointBody
  | RecordSubmissionReceiptBody
  | ReconcileSubmissionBody
  | ClaimSubmissionExceptionBody
  | EscalateSubmissionExceptionBody
  | ResolveSubmissionExceptionBody
  | ReopenSubmissionExceptionBody
  | MarkTransportBlockedBody
  | AttachRetryPlanBody
  | ConfirmDeliveredBody
  | AcknowledgeBreachBody
  | DeferWindowBody
  | ClearDigestBody
  | AssignPrimaryOwnerBody
  | SetBackupOwnerBody
  | AcknowledgeHandoffBody
  | RevokeAssignmentBody
  | AcknowledgeOwnerDriftBody
  | RebalanceAssignmentBody
  | SnoozeWorkloadAlertBody
  | SetPolicyBaselineBody
  | GrantBreachWaiverBody
  | RevokeBreachWaiverBody
  | AcknowledgePolicyVarianceBody
  | SnoozePolicyVarianceBody
  | AcknowledgeWaiverExpiryBody
  | ExtendBreachWaiverBody
  | RecordVarianceRemediationBody
  | AcknowledgeRemediationExpiryBody
  | SnoozeRemediationExpiryBody
  | AcknowledgeRolloverBreachBody
  | ReaffirmRolloverAttestationBody
  | AttestRemediationClosureBody
  | AcknowledgeRolloverReaffirmationSlaBody
  | AssignClosureFollowupBody
  | ClaimClosureFollowupBody
  | ResolveClosureFollowupBody
  | SetClosureSlaWindowConfigBody
  | SetClosureAutoAssignmentRuleBody
  | AutoAssignClosureFollowupBody
  | RecordClosureAttestationBody
  | ReviewClosureAttestationBody
  | WaiveClosureSlaExceptionBody
  | OpenClosureAttestationDisputeBody
  | ResolveClosureAttestationDisputeBody
  | TickClosureSlaExceptionEnforcementBody
  | EscalateClosureDisputeToPanelBody
  | RecordClosureAdjudicationVerdictBody
  | RebalanceClosureEnforcementQueueBody
  | GovernClosureAdjudicationQuorumBody
  | ExecuteClosureRebalanceOwnerTransferBody
  | ExecuteClosureRebalanceThrottleReleaseBody
  | ExtendClosureAdjudicationSloDeadlineBody
  | EscalateClosureAdjudicationSloTierBody
  | AcknowledgeClosureAdjudicationSloBreachBody
  | ConfigureClosureRebalanceSafeguardsBody
  | AttestClosureRebalanceOverrideBody
  | RecordClosureAdjudicationSloDebtRemediationBody
  | DownshiftClosureAdjudicationSloTierBody
  | AttestClosureAdjudicationSloBreachClosureBody
  | SetClosureRebalanceSafeguardOverrideExpiryBody
  | AutoClearClosureRebalanceSafeguardSuppressionBody
  | CleanupStaleClosureRebalanceSafeguardLockBody
  | SetClosureAdjudicationDebtBurndownTargetBody
  | AttestClosureAdjudicationDebtBacklogBody
  | CheckpointClosureAdjudicationTierNormalizationBody
  | AcknowledgeClosureSafeguardExpiryAttestationBody
  | QueueClosureSafeguardOverdueExpiryExceptionBody
  | ReconcileClosureSafeguardExpiryOverrideBody
  | RebaselineClosureAdjudicationBurndownForecastBody
  | OverrideClosureAdjudicationBurndownConfidenceBandBody
  | AnnotateClosureAdjudicationBurndownCheckpointRollbackBody
  | TriageClosureSafeguardExpiryAttestationQueueBody
  | AttestClosureSafeguardExpiryQueueHandoffBody
  | CheckpointClosureSafeguardExpiryQueueAutoDrainBody
  | AcknowledgeClosureBurndownSettlementDriftBody
  | AttestClosureBurndownSettlementTargetLockBody
  | CloseClosureBurndownRollbackResolutionBody
  | EscalateClosureExpiryAttestationQueueHandoffTimeoutBody
  | AttestClosureExpiryAttestationQueueStaleReassignmentBody
  | CheckpointClosureExpiryAttestationQueueForcedDrainOverrideBody
  | CheckpointClosureSettlementPostResolutionVerificationBody
  | AttestClosureSettlementLockReleaseBody
  | SafeguardClosureSettlementDisputeReopenBody
  | AttestClosureQueueDrainForcedReconciliationBody
  | CheckpointClosureQueueDrainReassignmentRollbackBody
  | ControlClosureQueueDrainTimeoutReentryBody
  | PetitionClosureSettlementVerificationOverrideBody
  | AttestClosureSettlementArbitrationPanelConfirmationBody
  | CheckpointClosureSettlementReopenVetoBody
  | AttestClosureQueueReentryExceptionBody
  | CheckpointClosureQueueReentryTimeoutWaiverBody
  | ControlClosureQueueReentryReconciliationResumeBody
  | IssueClosureSettlementArbitrationFinalRulingBody
  | MemorializeClosureSettlementArbitrationDissentBody
  | CheckpointClosureSettlementArbitrationRulingPublicationBody
  | LogClosureSettlementArbitrationPublicationCorrectionBody
  | CheckpointClosureSettlementArbitrationPublicationRollbackBody
  | ReviewClosureSettlementArbitrationDistributionAttestationBody
  | AssignClosureQueueReentryExceptionDebtBody
  | AttestClosureQueueReentryDebtRetirementBody
  | ControlClosureQueueReentryDebtAgingAutoEscalationBody
  | OpenClosureQueueReentryDebtRetirementDisputeBody
  | ResolveClosureQueueReentryDebtRetirementDisputeBody
  | ControlClosureQueueReentryDebtRetirementRollbackBody

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

function parseReadiness(value: string | null): "ready" | "blocked" | undefined {
  if (value === "ready" || value === "blocked") return value
  return undefined
}

function parseFilingsView(
  value: string | null
):
  | "packages"
  | "dispatch"
  | "annexures"
  | "submission_receipts"
  | "submission_reconciliation"
  | "submission_exceptions"
  | "transport_execution"
  | "submission_sla_digests"
  | "escalation_owner_rota"
  | "escalation_workload_digests"
  | "escalation_policy_baselines"
  | "breach_waiver_ledger"
  | "policy_variance_digests"
  | "waiver_expiry_digests"
  | "variance_remediation_ledger"
  | "waiver_rollover_attestations"
  | "remediation_expiry_digests"
  | "rollover_breach_watches"
  | "remediation_lifecycle"
  | "rollover_reaffirmation_sla"
  | "closure_compliance_digests"
  | "closure_followup_queue"
  | "closure_sla_window_configs"
  | "closure_auto_assignment_rules"
  | "closure_sla_windows"
  | "closure_attestations"
  | "closure_sla_exception_digests"
  | "closure_attestation_disputes"
  | "closure_sla_exception_enforcement"
  | "closure_adjudication_queue"
  | "closure_enforcement_rebalance"
  | "closure_adjudication_quorum"
  | "closure_rebalance_execution"
  | "closure_adjudication_slo"
  | "closure_rebalance_safeguards"
  | "closure_adjudication_slo_debt_remediation"
  | "closure_rebalance_safeguard_expiry"
  | "closure_adjudication_debt_burndown"
  | "closure_safeguard_expiry_attestations"
  | "closure_burndown_recalibration"
  | "closure_expiry_attestation_queue"
  | "closure_burndown_settlement"
  | "closure_expiry_attestation_queue_drain"
  | "closure_settlement_attestation"
  | "closure_queue_drain_reconciliation"
  | "closure_settlement_arbitration"
  | "closure_queue_reentry_compliance" {
  if (value === "dispatch") return "dispatch"
  if (value === "annexures") return "annexures"
  if (value === "submission_receipts") return "submission_receipts"
  if (value === "submission_reconciliation") return "submission_reconciliation"
  if (value === "submission_exceptions") return "submission_exceptions"
  if (value === "transport_execution") return "transport_execution"
  if (value === "submission_sla_digests") return "submission_sla_digests"
  if (value === "escalation_owner_rota") return "escalation_owner_rota"
  if (value === "escalation_workload_digests") return "escalation_workload_digests"
  if (value === "escalation_policy_baselines") return "escalation_policy_baselines"
  if (value === "breach_waiver_ledger") return "breach_waiver_ledger"
  if (value === "policy_variance_digests") return "policy_variance_digests"
  if (value === "waiver_expiry_digests") return "waiver_expiry_digests"
  if (value === "variance_remediation_ledger") return "variance_remediation_ledger"
  if (value === "waiver_rollover_attestations") return "waiver_rollover_attestations"
  if (value === "remediation_expiry_digests") return "remediation_expiry_digests"
  if (value === "rollover_breach_watches") return "rollover_breach_watches"
  if (value === "remediation_lifecycle") return "remediation_lifecycle"
  if (value === "rollover_reaffirmation_sla") return "rollover_reaffirmation_sla"
  if (value === "closure_compliance_digests") return "closure_compliance_digests"
  if (value === "closure_followup_queue") return "closure_followup_queue"
  if (value === "closure_sla_window_configs") return "closure_sla_window_configs"
  if (value === "closure_auto_assignment_rules") return "closure_auto_assignment_rules"
  if (value === "closure_sla_windows") return "closure_sla_windows"
  if (value === "closure_attestations") return "closure_attestations"
  if (value === "closure_sla_exception_digests") return "closure_sla_exception_digests"
  if (value === "closure_attestation_disputes") return "closure_attestation_disputes"
  if (value === "closure_sla_exception_enforcement") return "closure_sla_exception_enforcement"
  if (value === "closure_adjudication_queue") return "closure_adjudication_queue"
  if (value === "closure_enforcement_rebalance") return "closure_enforcement_rebalance"
  if (value === "closure_adjudication_quorum") return "closure_adjudication_quorum"
  if (value === "closure_rebalance_execution") return "closure_rebalance_execution"
  if (value === "closure_adjudication_slo") return "closure_adjudication_slo"
  if (value === "closure_rebalance_safeguards") return "closure_rebalance_safeguards"
  if (value === "closure_adjudication_slo_debt_remediation")
    return "closure_adjudication_slo_debt_remediation"
  if (value === "closure_rebalance_safeguard_expiry") return "closure_rebalance_safeguard_expiry"
  if (value === "closure_adjudication_debt_burndown")
    return "closure_adjudication_debt_burndown"
  if (value === "closure_safeguard_expiry_attestations")
    return "closure_safeguard_expiry_attestations"
  if (value === "closure_burndown_recalibration") return "closure_burndown_recalibration"
  if (value === "closure_expiry_attestation_queue") return "closure_expiry_attestation_queue"
  if (value === "closure_burndown_settlement") return "closure_burndown_settlement"
  if (value === "closure_expiry_attestation_queue_drain")
    return "closure_expiry_attestation_queue_drain"
  if (value === "closure_settlement_attestation") return "closure_settlement_attestation"
  if (value === "closure_queue_drain_reconciliation")
    return "closure_queue_drain_reconciliation"
  if (value === "closure_settlement_arbitration") return "closure_settlement_arbitration"
  if (value === "closure_queue_reentry_compliance")
    return "closure_queue_reentry_compliance"
  return "packages"
}

function buildOwnerActiveLoadCounts(
  rows: Array<{ status: string; primaryOwnerId: string | null }>
): Map<string, number> {
  const byOwner = new Map<string, number>()
  for (const row of rows) {
    if (row.status === "revoked") continue
    if (!row.primaryOwnerId) continue
    byOwner.set(row.primaryOwnerId, (byOwner.get(row.primaryOwnerId) ?? 0) + 1)
  }
  return byOwner
}

type EffectiveEscalationPolicy = {
  ownerLoadThreshold: number
  handoffSlaMs: number
  waiverWindowMs: number
  sourcePolicyId: string | null
}

function resolveEffectiveEscalationPolicy(
  packageId: string,
  packagePolicies: Map<string, EscalationPolicyOverrideShape>,
  defaultPolicy: EscalationPolicyOverrideShape | null
): EffectiveEscalationPolicy {
  const scoped = packagePolicies.get(packageId)
  if (scoped) {
    return {
      ownerLoadThreshold: scoped.ownerLoadThreshold,
      handoffSlaMs: scoped.handoffSlaMs,
      waiverWindowMs: scoped.waiverWindowMs,
      sourcePolicyId: scoped.id,
    }
  }
  if (defaultPolicy) {
    return {
      ownerLoadThreshold: defaultPolicy.ownerLoadThreshold,
      handoffSlaMs: defaultPolicy.handoffSlaMs,
      waiverWindowMs: defaultPolicy.waiverWindowMs,
      sourcePolicyId: defaultPolicy.id,
    }
  }
  return {
    ownerLoadThreshold: DEFAULT_ESCALATION_OWNER_LOAD_THRESHOLD,
    handoffSlaMs: DEFAULT_ESCALATION_HANDOFF_SLA_MS,
    waiverWindowMs: DEFAULT_ESCALATION_WAIVER_WINDOW_MS,
    sourcePolicyId: null,
  }
}

function latestByUpdatedAt<T extends { updatedAt: number }>(rows: T[]): T | null {
  if (rows.length === 0) return null
  return [...rows].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
}

type EscalationPolicyOverrideShape = {
  ownerLoadThreshold: number
  handoffSlaMs: number
  waiverWindowMs: number
  id: string
  updatedAt: number
}

function buildEscalationPolicyMaps(
  rows: Array<{
    id: string
    packageId: string | null
    scope: string
    ownerLoadThreshold: number
    handoffSlaMs: number
    waiverWindowMs: number
    updatedAt: number
  }>
): {
  defaultPolicy: EscalationPolicyOverrideShape | null
  packageOverrides: Map<string, EscalationPolicyOverrideShape>
} {
  const packageOverrides = new Map<string, EscalationPolicyOverrideShape>()
  const defaultRow = latestByUpdatedAt(rows.filter((row) => row.scope === "firm_default"))
  for (const row of rows) {
    if (row.scope !== "package_override" || !row.packageId) continue
    const existing = packageOverrides.get(row.packageId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      packageOverrides.set(row.packageId, {
        ownerLoadThreshold: row.ownerLoadThreshold,
        handoffSlaMs: row.handoffSlaMs,
        waiverWindowMs: row.waiverWindowMs,
        id: row.id,
        updatedAt: row.updatedAt,
      })
    }
  }
  return {
    defaultPolicy: defaultRow
      ? {
          ownerLoadThreshold: defaultRow.ownerLoadThreshold,
          handoffSlaMs: defaultRow.handoffSlaMs,
          waiverWindowMs: defaultRow.waiverWindowMs,
          id: defaultRow.id,
          updatedAt: defaultRow.updatedAt,
        }
      : null,
    packageOverrides,
  }
}

type ClosureSlaWindowConfigShape = {
  id: string
  ownerId: string | null
  ackDeadlineMs: number
  clearDeadlineMs: number
  autoEscalationMs: number
  updatedAt: number
}

type EffectiveClosureSlaWindowConfig = {
  ackDeadlineMs: number
  clearDeadlineMs: number
  autoEscalationMs: number
  sourceConfigId: string | null
}

function buildClosureSlaWindowConfigMaps(
  rows: Array<{
    id: string
    ownerId: string | null
    scope: string
    ackDeadlineMs: number
    clearDeadlineMs: number
    autoEscalationMs: number
    updatedAt: number
  }>
): {
  defaultConfig: ClosureSlaWindowConfigShape | null
  ownerOverrides: Map<string, ClosureSlaWindowConfigShape>
} {
  const ownerOverrides = new Map<string, ClosureSlaWindowConfigShape>()
  const defaultConfig = latestByUpdatedAt(rows.filter((row) => row.scope === "firm_default"))
  for (const row of rows) {
    if (row.scope !== "owner_override" || !row.ownerId) continue
    const existing = ownerOverrides.get(row.ownerId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      ownerOverrides.set(row.ownerId, {
        id: row.id,
        ownerId: row.ownerId,
        ackDeadlineMs: row.ackDeadlineMs,
        clearDeadlineMs: row.clearDeadlineMs,
        autoEscalationMs: row.autoEscalationMs,
        updatedAt: row.updatedAt,
      })
    }
  }
  return {
    defaultConfig: defaultConfig
      ? {
          id: defaultConfig.id,
          ownerId: defaultConfig.ownerId,
          ackDeadlineMs: defaultConfig.ackDeadlineMs,
          clearDeadlineMs: defaultConfig.clearDeadlineMs,
          autoEscalationMs: defaultConfig.autoEscalationMs,
          updatedAt: defaultConfig.updatedAt,
        }
      : null,
    ownerOverrides,
  }
}

function resolveEffectiveClosureSlaWindowConfig(
  ownerId: string,
  ownerOverrides: Map<string, ClosureSlaWindowConfigShape>,
  defaultConfig: ClosureSlaWindowConfigShape | null
): EffectiveClosureSlaWindowConfig {
  const ownerScoped = ownerOverrides.get(ownerId)
  if (ownerScoped) {
    return {
      ackDeadlineMs: ownerScoped.ackDeadlineMs,
      clearDeadlineMs: ownerScoped.clearDeadlineMs,
      autoEscalationMs: ownerScoped.autoEscalationMs,
      sourceConfigId: ownerScoped.id,
    }
  }
  if (defaultConfig) {
    return {
      ackDeadlineMs: defaultConfig.ackDeadlineMs,
      clearDeadlineMs: defaultConfig.clearDeadlineMs,
      autoEscalationMs: defaultConfig.autoEscalationMs,
      sourceConfigId: defaultConfig.id,
    }
  }
  return {
    ackDeadlineMs: DEFAULT_CLOSURE_ACK_DEADLINE_MS,
    clearDeadlineMs: DEFAULT_CLOSURE_CLEAR_DEADLINE_MS,
    autoEscalationMs: DEFAULT_CLOSURE_AUTO_ESCALATION_MS,
    sourceConfigId: null,
  }
}

type ClosureAutoAssignmentRuleShape = {
  id: string
  ownerId: string | null
  mode: "owner_rota" | "workload_aware_claim"
  enabled: boolean
  maxActiveClaimsPerPartner: number
  updatedAt: number
}

type EffectiveClosureAutoAssignmentRule = {
  mode: "owner_rota" | "workload_aware_claim"
  enabled: boolean
  maxActiveClaimsPerPartner: number
  sourceRuleId: string | null
}

function buildClosureAutoAssignmentRuleMaps(
  rows: Array<{
    id: string
    ownerId: string | null
    mode: "owner_rota" | "workload_aware_claim"
    enabled: boolean
    maxActiveClaimsPerPartner: number
    updatedAt: number
  }>
): {
  defaultRule: ClosureAutoAssignmentRuleShape | null
  ownerOverrides: Map<string, ClosureAutoAssignmentRuleShape>
} {
  const ownerOverrides = new Map<string, ClosureAutoAssignmentRuleShape>()
  const defaultRule = latestByUpdatedAt(rows.filter((row) => row.ownerId === null))
  for (const row of rows) {
    if (!row.ownerId) continue
    const existing = ownerOverrides.get(row.ownerId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      ownerOverrides.set(row.ownerId, row)
    }
  }
  return {
    defaultRule,
    ownerOverrides,
  }
}

function resolveEffectiveClosureAutoAssignmentRule(
  ownerId: string,
  ownerOverrides: Map<string, ClosureAutoAssignmentRuleShape>,
  defaultRule: ClosureAutoAssignmentRuleShape | null
): EffectiveClosureAutoAssignmentRule {
  const ownerScoped = ownerOverrides.get(ownerId)
  if (ownerScoped) {
    return {
      mode: ownerScoped.mode,
      enabled: ownerScoped.enabled,
      maxActiveClaimsPerPartner: ownerScoped.maxActiveClaimsPerPartner,
      sourceRuleId: ownerScoped.id,
    }
  }
  if (defaultRule) {
    return {
      mode: defaultRule.mode,
      enabled: defaultRule.enabled,
      maxActiveClaimsPerPartner: defaultRule.maxActiveClaimsPerPartner,
      sourceRuleId: defaultRule.id,
    }
  }
  return {
    mode: "owner_rota",
    enabled: true,
    maxActiveClaimsPerPartner: DEFAULT_CLOSURE_AUTO_ASSIGNMENT_MAX_ACTIVE_CLAIMS,
    sourceRuleId: null,
  }
}

function latestActiveRemediationByPackage<T extends {
    packageId: string
    status: string
    expiresAt: number
    updatedAt: number
  }>(
  rows: T[],
  now: number
): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    if (row.status !== "active") continue
    if (row.expiresAt <= now) continue
    const existing = result.get(row.packageId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      result.set(row.packageId, row)
    }
  }
  return result
}

function latestRolloverAttestationByWaiver<T extends { waiverId: string; updatedAt: number }>(
  rows: T[]
): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    const existing = result.get(row.waiverId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      result.set(row.waiverId, row)
    }
  }
  return result
}

function latestOpenRemediationLifecycleByPackage<
  T extends { packageId: string; status: string; updatedAt: number }
>(rows: T[]): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    if (row.status !== "open") continue
    const existing = result.get(row.packageId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      result.set(row.packageId, row)
    }
  }
  return result
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

function pickClosureAutoAssignee(input: {
  ownerId: string
  packageIds: string[]
  rule: EffectiveClosureAutoAssignmentRule
  queueLoadByPartner: Map<string, number>
  partnerIds: string[]
  rotaByPackage: Map<
    string,
    {
      status: string
      primaryOwnerId: string | null
      backupOwnerId: string | null
    }
  >
}): string | null {
  const underCap = (partnerId: string) =>
    (input.queueLoadByPartner.get(partnerId) ?? 0) < input.rule.maxActiveClaimsPerPartner
  const pickLeastLoaded = (candidateIds: string[]): string | null =>
    [...new Set(candidateIds)]
      .filter((id) => input.partnerIds.includes(id))
      .filter((id) => underCap(id))
      .sort((a, b) => {
        const loadDiff = (input.queueLoadByPartner.get(a) ?? 0) - (input.queueLoadByPartner.get(b) ?? 0)
        return loadDiff !== 0 ? loadDiff : a.localeCompare(b)
      })[0] ?? null

  if (input.rule.mode === "owner_rota") {
    const backupCandidates: string[] = []
    for (const packageId of input.packageIds) {
      const rota = input.rotaByPackage.get(packageId)
      if (!rota || rota.status === "revoked") continue
      if (rota.primaryOwnerId !== input.ownerId || !rota.backupOwnerId) continue
      backupCandidates.push(rota.backupOwnerId)
    }
    const backupChoice = pickLeastLoaded(backupCandidates)
    if (backupChoice) return backupChoice
    const ownerChoice = pickLeastLoaded([input.ownerId])
    if (ownerChoice) return ownerChoice
  }

  return pickLeastLoaded(input.partnerIds)
}

async function recomputeClosureComplianceState(
  store: ReturnType<typeof getRuntimeStore>,
  repos: Awaited<ReturnType<typeof getRuntimeRepositories>>,
  input: {
    firmId: string
    packageById: Map<string, { id: string; classification: Classification }>
    now: number
    forceAutoAssignOwnerIds?: Set<string>
  }
): Promise<{
  digestByOwner: Map<string, FilingEscalationClosureComplianceDigestRow>
  queueByOwner: Map<string, FilingEscalationClosureFollowupQueueRow>
  slaWindowByOwner: Map<string, {
    id: string
    ownerId: string
    status: "within_window" | "ack_breached" | "clear_breached" | "auto_escalation_due" | "cleared"
    pressureLevel: "baseline" | "elevated" | "critical"
    ackDeadlineAt: number | null
    clearDeadlineAt: number | null
    autoEscalateAt: number | null
    autoEscalatedToPartnerId: string | null
    linkedConfigId: string | null
    linkedAutoAssignmentRuleId: string | null
  }>
  latestAttestationByOwner: Map<string, {
    id: string
    status: "pending_second_review" | "attested" | "rejected"
    secondReviewerId: string | null
    secondReviewedBy: string | null
    secondReviewedAt: number | null
    partnerConcurrence: boolean
    evidenceNote: string
    updatedAt: number
  }>
  exceptionDigestByOwner: Map<string, {
    id: string
    ownerId: string
    queueId: string
    status: "open_exception" | "waived" | "expired" | "cleared"
    pressureLevel: "baseline" | "elevated" | "critical"
    reasons: Array<
      | "ack_deadline_breached"
      | "clear_deadline_breached"
      | "auto_escalation_due"
      | "attestation_pending"
      | "attestation_rejected"
      | "policy_override_active"
    >
    waiverReason: string | null
    waivedBy: string | null
    waivedAt: number | null
    waiverExpiresAt: number | null
    linkedAttestationId: string | null
  }>
  attestationDisputeByOwner: Map<string, {
    id: string
    status: "open_dispute" | "under_review" | "resolved_upheld" | "resolved_overturned"
    conflictReason: string
    attestationId: string
    reviewerChainSnapshot: string
    updatedAt: number
  }>
  exceptionEnforcementByOwner: Map<string, {
    id: string
    status: "countdown_active" | "reminder_sent" | "escalated" | "closed"
    reminderCount: number
    escalationCount: number
    waiverExpiresAt: number | null
    msUntilExpiry: number | null
    linkedAttestationDisputeId: string | null
  }>
  adjudicationByOwner: Map<string, {
    id: string
    status:
      | "pending_panel_assignment"
      | "panel_in_review"
      | "resolved_upheld"
      | "resolved_overturned"
    disputeId: string
    panelMemberIds: string[]
    dissentNotes: string[]
    verdict: "uphold_dispute" | "override_dispute" | null
    updatedAt: number
  }>
  rebalanceByOwner: Map<string, {
    id: string
    status: "none" | "cooldown_scheduled" | "owner_reassignment_recommended" | "throttle_active"
    triggeredByEscalationCount: number
    cooldownUntil: number | null
    recommendedOwnerId: string | null
    reopenThrottleUntil: number | null
    linkedAdjudicationQueueId: string | null
  }>
  adjudicationQuorumByOwner: Map<string, {
    id: string
    status: "quorum_pending" | "quorum_met" | "verdict_overdue" | "closed"
    requiredPanelCount: number
    confirmedPanelCount: number
    verdictDueAt: number
    breachFlags: Array<"quorum_unmet" | "verdict_overdue">
  }>
  rebalanceExecutionByOwner: Map<string, {
    id: string
    mode: "owner_transfer" | "throttle_release"
    status: "queued" | "owner_transfer_in_progress" | "throttle_release_in_progress" | "completed"
    queueReopened: boolean
    churnCount: number
    executedAt: number | null
  }>
  adjudicationSloByOwner: Map<string, {
    id: string
    status: "within_slo" | "deadline_extended" | "breach_open" | "breach_acknowledged"
    escalationTier:
      | "none"
      | "tier_1_partner_watch"
      | "tier_2_management_escalation"
      | "tier_3_executive_escalation"
    effectiveVerdictDueAt: number
    breachDebtHours: number
  }>
  rebalanceSafeguardByOwner: Map<string, {
    id: string
    status: "auto_exec_ready" | "cooldown_locked" | "duplicate_suppressed" | "override_attested"
    autoExecutionEligible: boolean
    suppressionReasons: Array<
      "cooldown_lockout_active" | "duplicate_execution_window" | "manual_override_required"
    >
    cooldownLockUntil: number | null
    duplicateSuppressionUntil: number | null
  }>
  adjudicationSloDebtRemediationByOwner: Map<string, {
    id: string
    status: "debt_open" | "debt_retirement_pending" | "debt_retired" | "breach_closure_attested"
    debtAgeHours: number
    tierDownshiftedTo:
      | "none"
      | "tier_1_partner_watch"
      | "tier_2_management_escalation"
      | "tier_3_executive_escalation"
      | null
  }>
  rebalanceSafeguardExpiryByOwner: Map<string, {
    id: string
    status: "expiry_pending" | "auto_cleared" | "override_expired" | "stale_lock_cleaned"
    suppressionExpiresAt: number | null
    overrideExpiresAt: number | null
    expiryDebtHours: number
  }>
  adjudicationDebtBurndownByOwner: Map<string, {
    id: string
    status:
      | "burndown_tracking"
      | "burndown_checkpoint_due"
      | "burndown_attested"
      | "burndown_forecast_breached"
    forecastBreachHours: number
    debtVelocityPerDay: number
    retirementTargetAt: number | null
  }>
  safeguardExpiryAttestationByOwner: Map<string, {
    id: string
    status: "attestation_open" | "attestation_acknowledged" | "attestation_overdue" | "attestation_reconciled"
    openBacklogHours: number
  }>
  burndownRecalibrationByOwner: Map<string, {
    id: string
    status:
      | "recalibration_pending"
      | "confidence_band_overridden"
      | "checkpoint_rollback_noted"
      | "recalibration_settled"
    confidenceDriftHours: number
    rebaselineTargetAt: number | null
  }>
  expiryAttestationQueueByOwner: Map<string, {
    id: string
    status: "queue_open" | "queue_triaged" | "handoff_attested" | "queue_auto_drained"
    queueAgingHours: number
    openExceptionCount: number
  }>
  burndownSettlementByOwner: Map<string, {
    id: string
    status:
      | "settlement_pending"
      | "drift_acknowledged"
      | "target_lock_attested"
      | "rollback_resolution_closed"
    settlementLatencyHours: number
  }>
  expiryAttestationQueueDrainByOwner: Map<string, {
    id: string
    status:
      | "drain_pending"
      | "handoff_timeout_escalated"
      | "stale_reassignment_attested"
      | "forced_drain_checkpointed"
    drainThroughputPerDay: number
    openQueueAgingHours: number
  }>
  settlementAttestationByOwner: Map<string, {
    id: string
    status:
      | "verification_pending"
      | "lock_release_attested"
      | "dispute_reopen_guarded"
      | "settlement_verified"
    settlementVerificationLagHours: number
  }>
  queueDrainReconciliationByOwner: Map<string, {
    id: string
    status:
      | "reconciliation_pending"
      | "forced_drain_attested"
      | "reassignment_rollback_checkpointed"
      | "timeout_reentry_controlled"
    drainReopenPressureCount: number
  }>
  settlementArbitrationByOwner: Map<string, {
    id: string
    status:
      | "arbitration_pending"
      | "verification_override_petitioned"
      | "panel_confirmation_attested"
      | "reopen_veto_checkpointed"
      | "final_ruling_issued"
      | "dissent_memorialized"
      | "ruling_publication_checkpointed"
      | "publication_correction_logged"
      | "publication_rollback_checkpointed"
      | "distribution_attestation_reviewed"
    settlementArbitrationLeadTimeHours: number
    arbitrationRulingAgingHours: number
    arbitrationPublicationExceptionBacklogCount: number
  }>
  queueReentryComplianceByOwner: Map<string, {
    id: string
    status:
      | "compliance_pending"
      | "reentry_exception_attested"
      | "timeout_waiver_checkpointed"
      | "reconciliation_resumed"
      | "exception_debt_assigned"
      | "debt_retirement_attested"
      | "debt_aging_auto_escalated"
      | "retirement_dispute_opened"
      | "retirement_dispute_resolved"
      | "retirement_rollback_controlled"
    queueReentryExceptionDebtCount: number
    queueReentryRetirementBurnCount: number
    queueReentryRetirementReconciliationDriftCount: number
  }>
}> {
  const rotaRows = await repos.filingEscalationOwnerRota.listByFirm(input.firmId)
  const rotaByPackage = new Map(rotaRows.map((row) => [row.packageId, row]))
  const ownerByPackage = new Map<string, string>()
  for (const row of rotaRows) {
    if (row.status === "revoked") continue
    if (!row.primaryOwnerId) continue
    ownerByPackage.set(row.packageId, row.primaryOwnerId)
  }
  const openLifecycles = (await repos.filingEscalationRemediationLifecycles.listByFirm(input.firmId)).filter(
    (row) => row.status === "open"
  )
  const breachedReaffirmations = (
    await repos.filingEscalationRolloverReaffirmationSlas.listByFirm(input.firmId)
  ).filter(
    (row) =>
      row.status === "breached" ||
      row.reasons.includes("cap_crossed_reaffirmation_breached")
  )
  type Aggregate = {
    classifications: Classification[]
    packageIds: string[]
    lifecycleIds: string[]
    reaffirmationIds: string[]
  }
  const aggregateByOwner = new Map<string, Aggregate>()
  const ensureAggregate = (owner: string): Aggregate => {
    const existing = aggregateByOwner.get(owner)
    if (existing) return existing
    const created: Aggregate = {
      classifications: [],
      packageIds: [],
      lifecycleIds: [],
      reaffirmationIds: [],
    }
    aggregateByOwner.set(owner, created)
    return created
  }
  for (const row of openLifecycles) {
    const owner = ownerByPackage.get(row.packageId)
    if (!owner) continue
    const aggregate = ensureAggregate(owner)
    aggregate.packageIds.push(row.packageId)
    aggregate.lifecycleIds.push(row.id)
    aggregate.classifications.push(input.packageById.get(row.packageId)?.classification ?? row.classification)
  }
  for (const row of breachedReaffirmations) {
    const owner = ownerByPackage.get(row.packageId)
    if (!owner) continue
    const aggregate = ensureAggregate(owner)
    aggregate.packageIds.push(row.packageId)
    aggregate.reaffirmationIds.push(row.id)
    aggregate.classifications.push(input.packageById.get(row.packageId)?.classification ?? row.classification)
  }
  const existingDigests = await repos.filingEscalationClosureComplianceDigests.listByFirm(input.firmId)
  const existingDigestByOwner = new Map(existingDigests.map((row) => [row.ownerId, row]))
  const existingQueues = await repos.filingEscalationClosureFollowupQueues.listByFirm(input.firmId)
  const existingQueueByDigestId = new Map(existingQueues.map((row) => [row.digestId, row]))
  const existingWindows = await repos.filingEscalationClosureSlaWindows.listByFirm(input.firmId)
  const existingWindowByDigestId = new Map(existingWindows.map((row) => [row.digestId, row]))
  const existingAttestations = await repos.filingEscalationClosureAttestations.listByFirm(input.firmId)
  const latestAttestationByQueueId = new Map<
    string,
    (typeof existingAttestations)[number]
  >()
  for (const row of existingAttestations) {
    const existing = latestAttestationByQueueId.get(row.queueId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      latestAttestationByQueueId.set(row.queueId, row)
    }
  }
  const existingExceptionDigests = await repos.filingEscalationClosureSlaExceptionDigests.listByFirm(
    input.firmId
  )
  const existingExceptionByQueueId = new Map(
    existingExceptionDigests.map((row) => [row.queueId, row])
  )
  const existingDisputes = await repos.filingEscalationClosureAttestationDisputes.listByFirm(input.firmId)
  const latestDisputeByQueueId = new Map<string, (typeof existingDisputes)[number]>()
  for (const row of existingDisputes) {
    const existing = latestDisputeByQueueId.get(row.queueId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      latestDisputeByQueueId.set(row.queueId, row)
    }
  }
  const existingEnforcementRows = await repos.filingEscalationClosureSlaExceptionEnforcement.listByFirm(
    input.firmId
  )
  const existingEnforcementByQueueId = new Map(
    existingEnforcementRows.map((row) => [row.queueId, row])
  )
  const existingAdjudicationRows = await repos.filingEscalationClosureAdjudicationQueue.listByFirm(
    input.firmId
  )
  const existingAdjudicationByDisputeId = new Map(
    existingAdjudicationRows.map((row) => [row.disputeId, row])
  )
  const existingRebalanceRows = await repos.filingEscalationClosureEnforcementRebalance.listByFirm(
    input.firmId
  )
  const existingRebalanceByQueueId = new Map(existingRebalanceRows.map((row) => [row.queueId, row]))
  const existingQuorumRows = await repos.filingEscalationClosureAdjudicationQuorum.listByFirm(
    input.firmId
  )
  const existingQuorumByAdjudicationId = new Map(
    existingQuorumRows.map((row) => [row.adjudicationId, row])
  )
  const existingExecutionRows = await repos.filingEscalationClosureRebalanceExecution.listByFirm(
    input.firmId
  )
  const existingExecutionByRebalanceId = new Map(
    existingExecutionRows.map((row) => [row.rebalanceId, row])
  )
  const existingSloRows = await repos.filingEscalationClosureAdjudicationSlo.listByFirm(input.firmId)
  const existingSloByAdjudicationId = new Map(
    existingSloRows.map((row) => [row.adjudicationId, row])
  )
  const existingSafeguardRows = await repos.filingEscalationClosureRebalanceSafeguards.listByFirm(
    input.firmId
  )
  const existingSafeguardByRebalanceId = new Map(
    existingSafeguardRows.map((row) => [row.rebalanceId, row])
  )
  const existingDebtRemediationRows =
    await repos.filingEscalationClosureAdjudicationSloDebtRemediation.listByFirm(input.firmId)
  const existingDebtRemediationBySloId = new Map(
    existingDebtRemediationRows.map((row) => [row.adjudicationSloId, row])
  )
  const existingSafeguardExpiryRows =
    await repos.filingEscalationClosureRebalanceSafeguardExpiry.listByFirm(input.firmId)
  const existingSafeguardExpiryBySafeguardId = new Map(
    existingSafeguardExpiryRows.map((row) => [row.safeguardId, row])
  )
  const existingDebtBurndownRows = await repos.filingEscalationClosureAdjudicationDebtBurndown.listByFirm(
    input.firmId
  )
  const existingDebtBurndownByRemediationId = new Map(
    existingDebtBurndownRows.map((row) => [row.remediationId, row])
  )
  const existingSafeguardAttestationRows =
    await repos.filingEscalationClosureSafeguardExpiryAttestations.listByFirm(input.firmId)
  const existingSafeguardAttestationByExpiryId = new Map(
    existingSafeguardAttestationRows.map((row) => [row.expiryId, row])
  )
  const existingBurndownRecalibrationRows =
    await repos.filingEscalationClosureBurndownRecalibration.listByFirm(input.firmId)
  const existingBurndownRecalibrationByBurndownId = new Map(
    existingBurndownRecalibrationRows.map((row) => [row.burndownId, row])
  )
  const existingExpiryQueueRows =
    await repos.filingEscalationClosureExpiryAttestationQueue.listByFirm(input.firmId)
  const existingExpiryQueueByAttestationId = new Map(
    existingExpiryQueueRows.map((row) => [row.attestationId, row])
  )
  const existingBurndownSettlementRows =
    await repos.filingEscalationClosureBurndownSettlement.listByFirm(input.firmId)
  const existingBurndownSettlementByRecalibrationId = new Map(
    existingBurndownSettlementRows.map((row) => [row.recalibrationId, row])
  )
  const existingExpiryQueueDrainRows =
    await repos.filingEscalationClosureExpiryAttestationQueueDrain.listByFirm(input.firmId)
  const existingExpiryQueueDrainByQueueItemId = new Map(
    existingExpiryQueueDrainRows.map((row) => [row.queueItemId, row])
  )
  const existingSettlementAttestationRows =
    await repos.filingEscalationClosureSettlementAttestation.listByFirm(input.firmId)
  const existingSettlementAttestationBySettlementId = new Map(
    existingSettlementAttestationRows.map((row) => [row.settlementId, row])
  )
  const existingQueueDrainReconciliationRows =
    await repos.filingEscalationClosureQueueDrainReconciliation.listByFirm(input.firmId)
  const existingQueueDrainReconciliationByQueueDrainId = new Map(
    existingQueueDrainReconciliationRows.map((row) => [row.queueDrainId, row])
  )
  const existingSettlementArbitrationRows =
    await repos.filingEscalationClosureSettlementArbitration.listByFirm(input.firmId)
  const existingSettlementArbitrationBySettlementAttestationId = new Map(
    existingSettlementArbitrationRows.map((row) => [row.settlementAttestationId, row])
  )
  const existingQueueReentryComplianceRows =
    await repos.filingEscalationClosureQueueReentryCompliance.listByFirm(input.firmId)
  const existingQueueReentryComplianceByQueueReconciliationId = new Map(
    existingQueueReentryComplianceRows.map((row) => [row.queueReconciliationId, row])
  )
  let closureSlaConfigRows = await repos.filingEscalationClosureSlaWindowConfigs.listByFirm(input.firmId)
  if (!closureSlaConfigRows.some((row) => row.ownerId === null && row.scope === "firm_default")) {
    const seededDefaultConfig = buildFilingEscalationClosureSlaWindowConfigRow({
      firmId: input.firmId,
      ownerId: null,
      classification: "internal",
      actorId: "system",
      ackDeadlineMs: DEFAULT_CLOSURE_ACK_DEADLINE_MS,
      clearDeadlineMs: DEFAULT_CLOSURE_CLEAR_DEADLINE_MS,
      autoEscalationMs: DEFAULT_CLOSURE_AUTO_ESCALATION_MS,
      now: input.now,
      note: "seeded default closure SLA window policy",
    })
    await repos.filingEscalationClosureSlaWindowConfigs.upsert(seededDefaultConfig)
    store.filingEscalationClosureSlaWindowConfigs.set(seededDefaultConfig.id, seededDefaultConfig)
    closureSlaConfigRows = [...closureSlaConfigRows, seededDefaultConfig]
  }
  let closureAutoRuleRows = await repos.filingEscalationClosureAutoAssignmentRules.listByFirm(input.firmId)
  if (!closureAutoRuleRows.some((row) => row.ownerId === null)) {
    const seededDefaultRule = buildFilingEscalationClosureAutoAssignmentRuleRow({
      firmId: input.firmId,
      ownerId: null,
      classification: "internal",
      actorId: "system",
      mode: "owner_rota",
      enabled: true,
      maxActiveClaimsPerPartner: DEFAULT_CLOSURE_AUTO_ASSIGNMENT_MAX_ACTIVE_CLAIMS,
      now: input.now,
      note: "seeded default closure follow-up auto-assignment policy",
    })
    await repos.filingEscalationClosureAutoAssignmentRules.upsert(seededDefaultRule)
    store.filingEscalationClosureAutoAssignmentRules.set(seededDefaultRule.id, seededDefaultRule)
    closureAutoRuleRows = [...closureAutoRuleRows, seededDefaultRule]
  }
  const { defaultConfig: defaultClosureSlaConfig, ownerOverrides: closureSlaConfigByOwner } =
    buildClosureSlaWindowConfigMaps(closureSlaConfigRows)
  const { defaultRule: defaultClosureAutoRule, ownerOverrides: closureAutoRuleByOwner } =
    buildClosureAutoAssignmentRuleMaps(closureAutoRuleRows)
  const partnerIds = [...store.users.values()]
    .filter((candidate) => candidate.firmId === input.firmId && candidate.role === "partner")
    .map((candidate) => candidate.id)
  const queueLoadByPartner = new Map<string, number>()
  for (const row of existingQueues) {
    if (row.status === "resolved") continue
    const accountablePartner = row.claimedBy ?? row.assignedPartnerId
    if (!accountablePartner) continue
    queueLoadByPartner.set(accountablePartner, (queueLoadByPartner.get(accountablePartner) ?? 0) + 1)
  }
  const ownerIds = new Set<string>([...aggregateByOwner.keys(), ...existingDigestByOwner.keys()])
  const digestByOwner = new Map<string, (typeof existingDigests)[number]>()
  const queueByOwner = new Map<string, (typeof existingQueues)[number]>()
  const slaWindowByOwner = new Map<
    string,
    {
      id: string
      ownerId: string
      status: "within_window" | "ack_breached" | "clear_breached" | "auto_escalation_due" | "cleared"
      pressureLevel: "baseline" | "elevated" | "critical"
      ackDeadlineAt: number | null
      clearDeadlineAt: number | null
      autoEscalateAt: number | null
      autoEscalatedToPartnerId: string | null
      linkedConfigId: string | null
      linkedAutoAssignmentRuleId: string | null
    }
  >()
  const latestAttestationByOwner = new Map<
    string,
    {
      id: string
      status: "pending_second_review" | "attested" | "rejected"
      secondReviewerId: string | null
      secondReviewedBy: string | null
      secondReviewedAt: number | null
      partnerConcurrence: boolean
      evidenceNote: string
      updatedAt: number
    }
  >()
  const exceptionDigestByOwner = new Map<
    string,
    {
      id: string
      ownerId: string
      queueId: string
      status: "open_exception" | "waived" | "expired" | "cleared"
      pressureLevel: "baseline" | "elevated" | "critical"
      reasons: Array<
        | "ack_deadline_breached"
        | "clear_deadline_breached"
        | "auto_escalation_due"
        | "attestation_pending"
        | "attestation_rejected"
        | "policy_override_active"
      >
      waiverReason: string | null
      waivedBy: string | null
      waivedAt: number | null
      waiverExpiresAt: number | null
      linkedAttestationId: string | null
    }
  >()
  const attestationDisputeByOwner = new Map<
    string,
    {
      id: string
      status: "open_dispute" | "under_review" | "resolved_upheld" | "resolved_overturned"
      conflictReason: string
      attestationId: string
      reviewerChainSnapshot: string
      updatedAt: number
    }
  >()
  const exceptionEnforcementByOwner = new Map<
    string,
    {
      id: string
      status: "countdown_active" | "reminder_sent" | "escalated" | "closed"
      reminderCount: number
      escalationCount: number
      waiverExpiresAt: number | null
      msUntilExpiry: number | null
      linkedAttestationDisputeId: string | null
    }
  >()
  const adjudicationByOwner = new Map<
    string,
    {
      id: string
      status:
        | "pending_panel_assignment"
        | "panel_in_review"
        | "resolved_upheld"
        | "resolved_overturned"
      disputeId: string
      panelMemberIds: string[]
      dissentNotes: string[]
      verdict: "uphold_dispute" | "override_dispute" | null
      updatedAt: number
    }
  >()
  const rebalanceByOwner = new Map<
    string,
    {
      id: string
      status: "none" | "cooldown_scheduled" | "owner_reassignment_recommended" | "throttle_active"
      triggeredByEscalationCount: number
      cooldownUntil: number | null
      recommendedOwnerId: string | null
      reopenThrottleUntil: number | null
      linkedAdjudicationQueueId: string | null
    }
  >()
  const adjudicationQuorumByOwner = new Map<
    string,
    {
      id: string
      status: "quorum_pending" | "quorum_met" | "verdict_overdue" | "closed"
      requiredPanelCount: number
      confirmedPanelCount: number
      verdictDueAt: number
      breachFlags: Array<"quorum_unmet" | "verdict_overdue">
    }
  >()
  const rebalanceExecutionByOwner = new Map<
    string,
    {
      id: string
      mode: "owner_transfer" | "throttle_release"
      status: "queued" | "owner_transfer_in_progress" | "throttle_release_in_progress" | "completed"
      queueReopened: boolean
      churnCount: number
      executedAt: number | null
    }
  >()
  const adjudicationSloByOwner = new Map<
    string,
    {
      id: string
      status: "within_slo" | "deadline_extended" | "breach_open" | "breach_acknowledged"
      escalationTier:
        | "none"
        | "tier_1_partner_watch"
        | "tier_2_management_escalation"
        | "tier_3_executive_escalation"
      effectiveVerdictDueAt: number
      breachDebtHours: number
    }
  >()
  const rebalanceSafeguardByOwner = new Map<
    string,
    {
      id: string
      status: "auto_exec_ready" | "cooldown_locked" | "duplicate_suppressed" | "override_attested"
      autoExecutionEligible: boolean
      suppressionReasons: Array<
        "cooldown_lockout_active" | "duplicate_execution_window" | "manual_override_required"
      >
      cooldownLockUntil: number | null
      duplicateSuppressionUntil: number | null
    }
  >()
  const adjudicationSloDebtRemediationByOwner = new Map<
    string,
    {
      id: string
      status: "debt_open" | "debt_retirement_pending" | "debt_retired" | "breach_closure_attested"
      debtAgeHours: number
      tierDownshiftedTo:
        | "none"
        | "tier_1_partner_watch"
        | "tier_2_management_escalation"
        | "tier_3_executive_escalation"
        | null
    }
  >()
  const rebalanceSafeguardExpiryByOwner = new Map<
    string,
    {
      id: string
      status: "expiry_pending" | "auto_cleared" | "override_expired" | "stale_lock_cleaned"
      suppressionExpiresAt: number | null
      overrideExpiresAt: number | null
      expiryDebtHours: number
    }
  >()
  const adjudicationDebtBurndownByOwner = new Map<
    string,
    {
      id: string
      status:
        | "burndown_tracking"
        | "burndown_checkpoint_due"
        | "burndown_attested"
        | "burndown_forecast_breached"
      forecastBreachHours: number
      debtVelocityPerDay: number
      retirementTargetAt: number | null
    }
  >()
  const safeguardExpiryAttestationByOwner = new Map<
    string,
    {
      id: string
      status:
        | "attestation_open"
        | "attestation_acknowledged"
        | "attestation_overdue"
        | "attestation_reconciled"
      openBacklogHours: number
    }
  >()
  const burndownRecalibrationByOwner = new Map<
    string,
    {
      id: string
      status:
        | "recalibration_pending"
        | "confidence_band_overridden"
        | "checkpoint_rollback_noted"
        | "recalibration_settled"
      confidenceDriftHours: number
      rebaselineTargetAt: number | null
    }
  >()
  const expiryAttestationQueueByOwner = new Map<
    string,
    {
      id: string
      status: "queue_open" | "queue_triaged" | "handoff_attested" | "queue_auto_drained"
      queueAgingHours: number
      openExceptionCount: number
    }
  >()
  const burndownSettlementByOwner = new Map<
    string,
    {
      id: string
      status:
        | "settlement_pending"
        | "drift_acknowledged"
        | "target_lock_attested"
        | "rollback_resolution_closed"
      settlementLatencyHours: number
    }
  >()
  const expiryAttestationQueueDrainByOwner = new Map<
    string,
    {
      id: string
      status:
        | "drain_pending"
        | "handoff_timeout_escalated"
        | "stale_reassignment_attested"
        | "forced_drain_checkpointed"
      drainThroughputPerDay: number
      openQueueAgingHours: number
    }
  >()
  const settlementAttestationByOwner = new Map<
    string,
    {
      id: string
      status:
        | "verification_pending"
        | "lock_release_attested"
        | "dispute_reopen_guarded"
        | "settlement_verified"
      settlementVerificationLagHours: number
    }
  >()
  const queueDrainReconciliationByOwner = new Map<
    string,
    {
      id: string
      status:
        | "reconciliation_pending"
        | "forced_drain_attested"
        | "reassignment_rollback_checkpointed"
        | "timeout_reentry_controlled"
      drainReopenPressureCount: number
    }
  >()
  const settlementArbitrationByOwner = new Map<
    string,
    {
      id: string
      status:
        | "arbitration_pending"
        | "verification_override_petitioned"
        | "panel_confirmation_attested"
        | "reopen_veto_checkpointed"
        | "final_ruling_issued"
        | "dissent_memorialized"
        | "ruling_publication_checkpointed"
        | "publication_correction_logged"
        | "publication_rollback_checkpointed"
        | "distribution_attestation_reviewed"
      settlementArbitrationLeadTimeHours: number
      arbitrationRulingAgingHours: number
      arbitrationPublicationExceptionBacklogCount: number
    }
  >()
  const queueReentryComplianceByOwner = new Map<
    string,
    {
      id: string
      status:
        | "compliance_pending"
        | "reentry_exception_attested"
        | "timeout_waiver_checkpointed"
        | "reconciliation_resumed"
        | "exception_debt_assigned"
        | "debt_retirement_attested"
        | "debt_aging_auto_escalated"
        | "retirement_dispute_opened"
        | "retirement_dispute_resolved"
        | "retirement_rollback_controlled"
      queueReentryExceptionDebtCount: number
      queueReentryRetirementBurnCount: number
      queueReentryRetirementReconciliationDriftCount: number
    }
  >()
  for (const owner of ownerIds) {
    const aggregate = aggregateByOwner.get(owner)
    const digestExisting = existingDigestByOwner.get(owner) ?? null
    const digestComputed = buildFilingEscalationClosureComplianceDigestRow({
      firmId: input.firmId,
      ownerId: owner,
      classifications: aggregate?.classifications ?? [digestExisting?.classification ?? "internal"],
      linkedPackageIds: aggregate?.packageIds ?? [],
      linkedLifecycleIds: aggregate?.lifecycleIds ?? [],
      linkedReaffirmationSlaIds: aggregate?.reaffirmationIds ?? [],
      existing: digestExisting,
      linkedFollowupQueueId: filingEscalationClosureFollowupQueueId(
        filingEscalationClosureComplianceDigestId(input.firmId, owner)
      ),
      now: input.now,
    })
    const queueExisting = existingQueueByDigestId.get(digestComputed.id) ?? null
    let queueComputed = buildFilingEscalationClosureFollowupQueueRow(digestComputed, {
      existing: queueExisting,
      now: input.now,
    })
    const digestNext = { ...digestComputed, linkedFollowupQueueId: queueComputed.id }
    const effectiveSlaConfig = resolveEffectiveClosureSlaWindowConfig(
      owner,
      closureSlaConfigByOwner,
      defaultClosureSlaConfig
    )
    const effectiveAutoRule = resolveEffectiveClosureAutoAssignmentRule(
      owner,
      closureAutoRuleByOwner,
      defaultClosureAutoRule
    )
    const resolvedConfigRow = {
      id:
        effectiveSlaConfig.sourceConfigId ??
        filingEscalationClosureSlaWindowConfigId(input.firmId, null),
      firmId: input.firmId,
      ownerId: closureSlaConfigByOwner.has(owner) ? owner : null,
      classification: digestNext.classification,
      scope: closureSlaConfigByOwner.has(owner) ? ("owner_override" as const) : ("firm_default" as const),
      ackDeadlineMs: effectiveSlaConfig.ackDeadlineMs,
      clearDeadlineMs: effectiveSlaConfig.clearDeadlineMs,
      autoEscalationMs: effectiveSlaConfig.autoEscalationMs,
      setBy: "system",
      setAt: input.now,
      notes: [],
      updatedAt: input.now,
    }
    const existingWindow = existingWindowByDigestId.get(digestNext.id) ?? null
    let slaWindowComputed = buildFilingEscalationClosureSlaWindowRow({
      digest: digestNext,
      queue: queueComputed,
      config: resolvedConfigRow,
      existing: existingWindow,
      linkedAutoAssignmentRuleId: effectiveAutoRule.sourceRuleId,
      now: input.now,
    })
    const forceAutoAssign = input.forceAutoAssignOwnerIds?.has(owner) ?? false
    const queueNeedsAutoAssignment =
      effectiveAutoRule.enabled &&
      queueComputed.status !== "resolved" &&
      (!queueComputed.assignedPartnerId || forceAutoAssign) &&
      (!queueComputed.claimedBy || forceAutoAssign) &&
      (forceAutoAssign ||
        slaWindowComputed.status === "clear_breached" ||
        slaWindowComputed.status === "auto_escalation_due")
    if (queueNeedsAutoAssignment) {
      const autoAssignee = pickClosureAutoAssignee({
        ownerId: owner,
        packageIds: queueComputed.packageIds,
        rule: effectiveAutoRule,
        queueLoadByPartner,
        partnerIds,
        rotaByPackage,
      })
      if (autoAssignee) {
        if (queueComputed.assignedPartnerId && queueComputed.assignedPartnerId !== autoAssignee) {
          queueLoadByPartner.set(
            queueComputed.assignedPartnerId,
            Math.max(0, (queueLoadByPartner.get(queueComputed.assignedPartnerId) ?? 1) - 1)
          )
        }
        if (queueComputed.assignedPartnerId !== autoAssignee) {
          queueLoadByPartner.set(autoAssignee, (queueLoadByPartner.get(autoAssignee) ?? 0) + 1)
        }
        queueComputed = {
          ...queueComputed,
          assignedPartnerId: autoAssignee,
          notes: [
            ...queueComputed.notes,
            `${new Date(input.now).toISOString()} system:auto-assign ${effectiveAutoRule.mode} -> ${autoAssignee}`,
          ],
          updatedAt: input.now,
        }
        slaWindowComputed = buildFilingEscalationClosureSlaWindowRow({
          digest: digestNext,
          queue: queueComputed,
          config: resolvedConfigRow,
          existing: existingWindow,
          linkedAutoAssignmentRuleId: effectiveAutoRule.sourceRuleId,
          autoEscalatedToPartnerId: autoAssignee,
          autoEscalationTriggeredAt: input.now,
          now: input.now,
        })
      }
    }
    const digestChanged =
      !digestExisting ||
      digestExisting.status !== digestNext.status ||
      digestExisting.pendingLifecycleCount !== digestNext.pendingLifecycleCount ||
      digestExisting.breachedReaffirmationCount !== digestNext.breachedReaffirmationCount ||
      digestExisting.linkedFollowupQueueId !== digestNext.linkedFollowupQueueId ||
      !sameStringArray(digestExisting.linkedPackageIds, digestNext.linkedPackageIds) ||
      !sameStringArray(digestExisting.linkedLifecycleIds, digestNext.linkedLifecycleIds) ||
      !sameStringArray(
        digestExisting.linkedReaffirmationSlaIds,
        digestNext.linkedReaffirmationSlaIds
      )
    if (digestChanged) {
      await repos.filingEscalationClosureComplianceDigests.upsert(digestNext)
    }
    store.filingEscalationClosureComplianceDigests.set(digestNext.id, digestNext)
    digestByOwner.set(owner, digestNext)
    const queueChanged =
      !queueExisting ||
      queueExisting.status !== queueComputed.status ||
      queueExisting.assignedPartnerId !== queueComputed.assignedPartnerId ||
      queueExisting.claimedBy !== queueComputed.claimedBy ||
      queueExisting.claimedAt !== queueComputed.claimedAt ||
      queueExisting.resolvedBy !== queueComputed.resolvedBy ||
      queueExisting.resolvedAt !== queueComputed.resolvedAt ||
      queueExisting.resolutionNote !== queueComputed.resolutionNote ||
      queueExisting.pendingLifecycleCount !== queueComputed.pendingLifecycleCount ||
      queueExisting.breachedReaffirmationCount !== queueComputed.breachedReaffirmationCount ||
      !sameStringArray(queueExisting.packageIds, queueComputed.packageIds)
    if (queueChanged) {
      await repos.filingEscalationClosureFollowupQueues.upsert(queueComputed)
    }
    store.filingEscalationClosureFollowupQueues.set(queueComputed.id, queueComputed)
    queueByOwner.set(owner, queueComputed)
    const windowChanged =
      !existingWindow ||
      existingWindow.queueId !== slaWindowComputed.queueId ||
      existingWindow.status !== slaWindowComputed.status ||
      existingWindow.pressureLevel !== slaWindowComputed.pressureLevel ||
      existingWindow.openedAt !== slaWindowComputed.openedAt ||
      existingWindow.acknowledgedAt !== slaWindowComputed.acknowledgedAt ||
      existingWindow.clearedAt !== slaWindowComputed.clearedAt ||
      existingWindow.ackDeadlineAt !== slaWindowComputed.ackDeadlineAt ||
      existingWindow.clearDeadlineAt !== slaWindowComputed.clearDeadlineAt ||
      existingWindow.autoEscalateAt !== slaWindowComputed.autoEscalateAt ||
      existingWindow.breachedAt !== slaWindowComputed.breachedAt ||
      existingWindow.autoEscalationTriggeredAt !== slaWindowComputed.autoEscalationTriggeredAt ||
      existingWindow.autoEscalatedToPartnerId !== slaWindowComputed.autoEscalatedToPartnerId ||
      existingWindow.linkedConfigId !== slaWindowComputed.linkedConfigId ||
      existingWindow.linkedAutoAssignmentRuleId !== slaWindowComputed.linkedAutoAssignmentRuleId
    if (windowChanged) {
      await repos.filingEscalationClosureSlaWindows.upsert(slaWindowComputed)
    }
    store.filingEscalationClosureSlaWindows.set(slaWindowComputed.id, slaWindowComputed)
    slaWindowByOwner.set(owner, {
      id: slaWindowComputed.id,
      ownerId: slaWindowComputed.ownerId,
      status: slaWindowComputed.status,
      pressureLevel: slaWindowComputed.pressureLevel,
      ackDeadlineAt: slaWindowComputed.ackDeadlineAt,
      clearDeadlineAt: slaWindowComputed.clearDeadlineAt,
      autoEscalateAt: slaWindowComputed.autoEscalateAt,
      autoEscalatedToPartnerId: slaWindowComputed.autoEscalatedToPartnerId,
      linkedConfigId: slaWindowComputed.linkedConfigId,
      linkedAutoAssignmentRuleId: slaWindowComputed.linkedAutoAssignmentRuleId,
    })
    const latestAttestation = latestAttestationByQueueId.get(queueComputed.id) ?? null
    if (latestAttestation) {
      latestAttestationByOwner.set(owner, {
        id: latestAttestation.id,
        status: latestAttestation.status,
        secondReviewerId: latestAttestation.secondReviewerId,
        secondReviewedBy: latestAttestation.secondReviewedBy,
        secondReviewedAt: latestAttestation.secondReviewedAt,
        partnerConcurrence: latestAttestation.partnerConcurrence,
        evidenceNote: latestAttestation.evidenceNote,
        updatedAt: latestAttestation.updatedAt,
      })
    }
    const existingException = existingExceptionByQueueId.get(queueComputed.id) ?? null
    const exceptionComputed = buildFilingEscalationClosureSlaExceptionDigestRow({
      digest: digestNext,
      queue: queueComputed,
      slaWindow: slaWindowComputed,
      latestAttestation,
      policyOverrideActive: closureSlaConfigByOwner.has(owner) || closureAutoRuleByOwner.has(owner),
      existing: existingException,
      now: input.now,
    })
    const exceptionChanged =
      !existingException ||
      existingException.status !== exceptionComputed.status ||
      existingException.pressureLevel !== exceptionComputed.pressureLevel ||
      existingException.waiverReason !== exceptionComputed.waiverReason ||
      existingException.waivedBy !== exceptionComputed.waivedBy ||
      existingException.waivedAt !== exceptionComputed.waivedAt ||
      existingException.waiverExpiresAt !== exceptionComputed.waiverExpiresAt ||
      existingException.expiredAt !== exceptionComputed.expiredAt ||
      existingException.linkedAttestationId !== exceptionComputed.linkedAttestationId ||
      existingException.linkedSlaWindowId !== exceptionComputed.linkedSlaWindowId ||
      !sameStringArray(existingException.reasons, exceptionComputed.reasons)
    if (exceptionChanged) {
      await repos.filingEscalationClosureSlaExceptionDigests.upsert(exceptionComputed)
    }
    store.filingEscalationClosureSlaExceptionDigests.set(exceptionComputed.id, exceptionComputed)
    exceptionDigestByOwner.set(owner, {
      id: exceptionComputed.id,
      ownerId: exceptionComputed.ownerId,
      queueId: exceptionComputed.queueId,
      status: exceptionComputed.status,
      pressureLevel: exceptionComputed.pressureLevel,
      reasons: exceptionComputed.reasons,
      waiverReason: exceptionComputed.waiverReason,
      waivedBy: exceptionComputed.waivedBy,
      waivedAt: exceptionComputed.waivedAt,
      waiverExpiresAt: exceptionComputed.waiverExpiresAt,
      linkedAttestationId: exceptionComputed.linkedAttestationId,
    })
    const latestDispute = latestDisputeByQueueId.get(queueComputed.id) ?? null
    if (latestDispute) {
      attestationDisputeByOwner.set(owner, {
        id: latestDispute.id,
        status: latestDispute.status,
        conflictReason: latestDispute.conflictReason,
        attestationId: latestDispute.attestationId,
        reviewerChainSnapshot: latestDispute.reviewerChainSnapshot,
        updatedAt: latestDispute.updatedAt,
      })
    }
    const existingEnforcement = existingEnforcementByQueueId.get(queueComputed.id) ?? null
    const enforcementComputed = buildFilingEscalationClosureSlaExceptionEnforcementRow({
      queue: queueComputed,
      exceptionDigest: exceptionComputed,
      latestDispute,
      existing: existingEnforcement,
      now: input.now,
    })
    const enforcementChanged =
      !existingEnforcement ||
      existingEnforcement.status !== enforcementComputed.status ||
      existingEnforcement.reminderCount !== enforcementComputed.reminderCount ||
      existingEnforcement.escalationCount !== enforcementComputed.escalationCount ||
      existingEnforcement.lastReminderAt !== enforcementComputed.lastReminderAt ||
      existingEnforcement.lastEscalatedAt !== enforcementComputed.lastEscalatedAt ||
      existingEnforcement.waiverExpiresAt !== enforcementComputed.waiverExpiresAt ||
      existingEnforcement.msUntilExpiry !== enforcementComputed.msUntilExpiry ||
      existingEnforcement.linkedAttestationDisputeId !== enforcementComputed.linkedAttestationDisputeId
    if (enforcementChanged) {
      await repos.filingEscalationClosureSlaExceptionEnforcement.upsert(enforcementComputed)
    }
    store.filingEscalationClosureSlaExceptionEnforcement.set(enforcementComputed.id, enforcementComputed)
    exceptionEnforcementByOwner.set(owner, {
      id: enforcementComputed.id,
      status: enforcementComputed.status,
      reminderCount: enforcementComputed.reminderCount,
      escalationCount: enforcementComputed.escalationCount,
      waiverExpiresAt: enforcementComputed.waiverExpiresAt,
      msUntilExpiry: enforcementComputed.msUntilExpiry,
      linkedAttestationDisputeId: enforcementComputed.linkedAttestationDisputeId,
    })
    const existingAdjudication = latestDispute
      ? (existingAdjudicationByDisputeId.get(latestDispute.id) ?? null)
      : null
    if (latestDispute) {
      const adjudicationComputed = buildFilingEscalationClosureAdjudicationQueueRow({
        dispute: latestDispute,
        queue: queueComputed,
        enforcement: enforcementComputed,
        existing: existingAdjudication,
        now: input.now,
      })
      const adjudicationChanged =
        !existingAdjudication ||
        existingAdjudication.status !== adjudicationComputed.status ||
        existingAdjudication.verdict !== adjudicationComputed.verdict ||
        existingAdjudication.verdictBy !== adjudicationComputed.verdictBy ||
        existingAdjudication.verdictAt !== adjudicationComputed.verdictAt ||
        !sameStringArray(existingAdjudication.panelMemberIds, adjudicationComputed.panelMemberIds) ||
        !sameStringArray(existingAdjudication.dissentNotes, adjudicationComputed.dissentNotes) ||
        existingAdjudication.linkedEnforcementRebalanceId !==
          adjudicationComputed.linkedEnforcementRebalanceId
      if (adjudicationChanged) {
        await repos.filingEscalationClosureAdjudicationQueue.upsert(adjudicationComputed)
      }
      store.filingEscalationClosureAdjudicationQueue.set(adjudicationComputed.id, adjudicationComputed)
      adjudicationByOwner.set(owner, {
        id: adjudicationComputed.id,
        status: adjudicationComputed.status,
        disputeId: adjudicationComputed.disputeId,
        panelMemberIds: adjudicationComputed.panelMemberIds,
        dissentNotes: adjudicationComputed.dissentNotes,
        verdict: adjudicationComputed.verdict,
        updatedAt: adjudicationComputed.updatedAt,
      })
      const existingRebalance = existingRebalanceByQueueId.get(queueComputed.id) ?? null
      const rebalanceComputed = buildFilingEscalationClosureEnforcementRebalanceRow({
        queue: queueComputed,
        enforcement: enforcementComputed,
        adjudication: adjudicationComputed,
        existing: existingRebalance,
        now: input.now,
      })
      const rebalanceChanged =
        !existingRebalance ||
        existingRebalance.status !== rebalanceComputed.status ||
        existingRebalance.triggeredByEscalationCount !== rebalanceComputed.triggeredByEscalationCount ||
        existingRebalance.cooldownUntil !== rebalanceComputed.cooldownUntil ||
        existingRebalance.recommendedOwnerId !== rebalanceComputed.recommendedOwnerId ||
        existingRebalance.reopenThrottleUntil !== rebalanceComputed.reopenThrottleUntil ||
        existingRebalance.linkedAdjudicationQueueId !== rebalanceComputed.linkedAdjudicationQueueId
      if (rebalanceChanged) {
        await repos.filingEscalationClosureEnforcementRebalance.upsert(rebalanceComputed)
      }
      store.filingEscalationClosureEnforcementRebalance.set(rebalanceComputed.id, rebalanceComputed)
      rebalanceByOwner.set(owner, {
        id: rebalanceComputed.id,
        status: rebalanceComputed.status,
        triggeredByEscalationCount: rebalanceComputed.triggeredByEscalationCount,
        cooldownUntil: rebalanceComputed.cooldownUntil,
        recommendedOwnerId: rebalanceComputed.recommendedOwnerId,
        reopenThrottleUntil: rebalanceComputed.reopenThrottleUntil,
        linkedAdjudicationQueueId: rebalanceComputed.linkedAdjudicationQueueId,
      })
      const existingQuorum = existingQuorumByAdjudicationId.get(adjudicationComputed.id) ?? null
      const quorumComputed = buildFilingEscalationClosureAdjudicationQuorumRow({
        adjudication: adjudicationComputed,
        queue: queueComputed,
        existing: existingQuorum,
        now: input.now,
      })
      const quorumChanged =
        !existingQuorum ||
        existingQuorum.status !== quorumComputed.status ||
        existingQuorum.requiredPanelCount !== quorumComputed.requiredPanelCount ||
        existingQuorum.confirmedPanelCount !== quorumComputed.confirmedPanelCount ||
        existingQuorum.quorumMetAt !== quorumComputed.quorumMetAt ||
        existingQuorum.quorumDeadlineAt !== quorumComputed.quorumDeadlineAt ||
        existingQuorum.verdictDueAt !== quorumComputed.verdictDueAt ||
        existingQuorum.verdictRecordedAt !== quorumComputed.verdictRecordedAt ||
        existingQuorum.lastGovernedAt !== quorumComputed.lastGovernedAt ||
        existingQuorum.lastGovernedBy !== quorumComputed.lastGovernedBy ||
        !sameStringArray(existingQuorum.breachFlags, quorumComputed.breachFlags)
      if (quorumChanged) {
        await repos.filingEscalationClosureAdjudicationQuorum.upsert(quorumComputed)
      }
      store.filingEscalationClosureAdjudicationQuorum.set(quorumComputed.id, quorumComputed)
      adjudicationQuorumByOwner.set(owner, {
        id: quorumComputed.id,
        status: quorumComputed.status,
        requiredPanelCount: quorumComputed.requiredPanelCount,
        confirmedPanelCount: quorumComputed.confirmedPanelCount,
        verdictDueAt: quorumComputed.verdictDueAt,
        breachFlags: quorumComputed.breachFlags,
      })
      const existingExecution = existingExecutionByRebalanceId.get(rebalanceComputed.id) ?? null
      if (existingExecution) {
        store.filingEscalationClosureRebalanceExecution.set(existingExecution.id, existingExecution)
        rebalanceExecutionByOwner.set(owner, {
          id: existingExecution.id,
          mode: existingExecution.mode,
          status: existingExecution.status,
          queueReopened: existingExecution.queueReopened,
          churnCount: existingExecution.churnCount,
          executedAt: existingExecution.executedAt,
        })
      }
      const existingSlo = existingSloByAdjudicationId.get(adjudicationComputed.id) ?? null
      const sloComputed = buildFilingEscalationClosureAdjudicationSloRow({
        adjudication: adjudicationComputed,
        queue: queueComputed,
        quorum: quorumComputed,
        existing: existingSlo,
        now: input.now,
      })
      const sloChanged =
        !existingSlo ||
        existingSlo.status !== sloComputed.status ||
        existingSlo.escalationTier !== sloComputed.escalationTier ||
        existingSlo.effectiveVerdictDueAt !== sloComputed.effectiveVerdictDueAt ||
        existingSlo.extensionCount !== sloComputed.extensionCount ||
        existingSlo.lastExtendedBy !== sloComputed.lastExtendedBy ||
        existingSlo.lastExtendedAt !== sloComputed.lastExtendedAt ||
        existingSlo.breachOpenedAt !== sloComputed.breachOpenedAt ||
        existingSlo.breachAcknowledgedBy !== sloComputed.breachAcknowledgedBy ||
        existingSlo.breachAcknowledgedAt !== sloComputed.breachAcknowledgedAt ||
        existingSlo.breachDebtHours !== sloComputed.breachDebtHours
      if (sloChanged) {
        await repos.filingEscalationClosureAdjudicationSlo.upsert(sloComputed)
      }
      store.filingEscalationClosureAdjudicationSlo.set(sloComputed.id, sloComputed)
      adjudicationSloByOwner.set(owner, {
        id: sloComputed.id,
        status: sloComputed.status,
        escalationTier: sloComputed.escalationTier,
        effectiveVerdictDueAt: sloComputed.effectiveVerdictDueAt,
        breachDebtHours: sloComputed.breachDebtHours,
      })
      const existingSafeguard = existingSafeguardByRebalanceId.get(rebalanceComputed.id) ?? null
      const safeguardComputed = buildFilingEscalationClosureRebalanceSafeguardRow({
        rebalance: rebalanceComputed,
        queue: queueComputed,
        execution: existingExecution,
        existing: existingSafeguard,
        now: input.now,
      })
      const safeguardChanged =
        !existingSafeguard ||
        existingSafeguard.status !== safeguardComputed.status ||
        existingSafeguard.cooldownLockUntil !== safeguardComputed.cooldownLockUntil ||
        existingSafeguard.duplicateSuppressionUntil !== safeguardComputed.duplicateSuppressionUntil ||
        existingSafeguard.overrideAttestedBy !== safeguardComputed.overrideAttestedBy ||
        existingSafeguard.overrideAttestedAt !== safeguardComputed.overrideAttestedAt ||
        existingSafeguard.overrideReason !== safeguardComputed.overrideReason ||
        existingSafeguard.lastAutoExecutedAt !== safeguardComputed.lastAutoExecutedAt ||
        existingSafeguard.autoExecutionEligible !== safeguardComputed.autoExecutionEligible ||
        !sameStringArray(existingSafeguard.suppressionReasons, safeguardComputed.suppressionReasons)
      if (safeguardChanged) {
        await repos.filingEscalationClosureRebalanceSafeguards.upsert(safeguardComputed)
      }
      store.filingEscalationClosureRebalanceSafeguards.set(safeguardComputed.id, safeguardComputed)
      rebalanceSafeguardByOwner.set(owner, {
        id: safeguardComputed.id,
        status: safeguardComputed.status,
        autoExecutionEligible: safeguardComputed.autoExecutionEligible,
        suppressionReasons: safeguardComputed.suppressionReasons,
        cooldownLockUntil: safeguardComputed.cooldownLockUntil,
        duplicateSuppressionUntil: safeguardComputed.duplicateSuppressionUntil,
      })
      const existingDebtRemediation = existingDebtRemediationBySloId.get(sloComputed.id) ?? null
      const debtRemediationComputed = buildFilingEscalationClosureAdjudicationSloDebtRemediationRow({
        slo: sloComputed,
        existing: existingDebtRemediation,
        now: input.now,
      })
      const debtRemediationChanged =
        !existingDebtRemediation ||
        existingDebtRemediation.status !== debtRemediationComputed.status ||
        existingDebtRemediation.debtAgeHours !== debtRemediationComputed.debtAgeHours ||
        existingDebtRemediation.debtRetiredHours !== debtRemediationComputed.debtRetiredHours ||
        existingDebtRemediation.retirementNotedBy !== debtRemediationComputed.retirementNotedBy ||
        existingDebtRemediation.retirementNotedAt !== debtRemediationComputed.retirementNotedAt ||
        existingDebtRemediation.tierDownshiftedTo !== debtRemediationComputed.tierDownshiftedTo ||
        existingDebtRemediation.tierDownshiftedBy !== debtRemediationComputed.tierDownshiftedBy ||
        existingDebtRemediation.tierDownshiftedAt !== debtRemediationComputed.tierDownshiftedAt ||
        existingDebtRemediation.breachClosureAttestedBy !==
          debtRemediationComputed.breachClosureAttestedBy ||
        existingDebtRemediation.breachClosureAttestedAt !==
          debtRemediationComputed.breachClosureAttestedAt
      if (debtRemediationChanged) {
        await repos.filingEscalationClosureAdjudicationSloDebtRemediation.upsert(
          debtRemediationComputed
        )
      }
      store.filingEscalationClosureAdjudicationSloDebtRemediation.set(
        debtRemediationComputed.id,
        debtRemediationComputed
      )
      adjudicationSloDebtRemediationByOwner.set(owner, {
        id: debtRemediationComputed.id,
        status: debtRemediationComputed.status,
        debtAgeHours: debtRemediationComputed.debtAgeHours,
        tierDownshiftedTo: debtRemediationComputed.tierDownshiftedTo,
      })
      const existingSafeguardExpiry =
        existingSafeguardExpiryBySafeguardId.get(safeguardComputed.id) ?? null
      const safeguardExpiryComputed = buildFilingEscalationClosureRebalanceSafeguardExpiryRow({
        safeguard: safeguardComputed,
        existing: existingSafeguardExpiry,
        now: input.now,
      })
      const safeguardExpiryChanged =
        !existingSafeguardExpiry ||
        existingSafeguardExpiry.status !== safeguardExpiryComputed.status ||
        existingSafeguardExpiry.suppressionExpiresAt !==
          safeguardExpiryComputed.suppressionExpiresAt ||
        existingSafeguardExpiry.overrideExpiresAt !== safeguardExpiryComputed.overrideExpiresAt ||
        existingSafeguardExpiry.autoClearedAt !== safeguardExpiryComputed.autoClearedAt ||
        existingSafeguardExpiry.staleLockCleanedBy !==
          safeguardExpiryComputed.staleLockCleanedBy ||
        existingSafeguardExpiry.staleLockCleanedAt !==
          safeguardExpiryComputed.staleLockCleanedAt ||
        existingSafeguardExpiry.expiryDebtHours !== safeguardExpiryComputed.expiryDebtHours
      if (safeguardExpiryChanged) {
        await repos.filingEscalationClosureRebalanceSafeguardExpiry.upsert(safeguardExpiryComputed)
      }
      store.filingEscalationClosureRebalanceSafeguardExpiry.set(
        safeguardExpiryComputed.id,
        safeguardExpiryComputed
      )
      rebalanceSafeguardExpiryByOwner.set(owner, {
        id: safeguardExpiryComputed.id,
        status: safeguardExpiryComputed.status,
        suppressionExpiresAt: safeguardExpiryComputed.suppressionExpiresAt,
        overrideExpiresAt: safeguardExpiryComputed.overrideExpiresAt,
        expiryDebtHours: safeguardExpiryComputed.expiryDebtHours,
      })
      const existingDebtBurndown =
        existingDebtBurndownByRemediationId.get(debtRemediationComputed.id) ?? null
      const debtBurndownComputed = buildFilingEscalationClosureAdjudicationDebtBurndownRow({
        remediation: debtRemediationComputed,
        existing: existingDebtBurndown,
        now: input.now,
      })
      const debtBurndownChanged =
        !existingDebtBurndown ||
        existingDebtBurndown.status !== debtBurndownComputed.status ||
        existingDebtBurndown.retirementTargetAt !== debtBurndownComputed.retirementTargetAt ||
        existingDebtBurndown.checkpointAt !== debtBurndownComputed.checkpointAt ||
        existingDebtBurndown.backlogAttestedBy !== debtBurndownComputed.backlogAttestedBy ||
        existingDebtBurndown.backlogAttestedAt !== debtBurndownComputed.backlogAttestedAt ||
        existingDebtBurndown.tierNormalizedBy !== debtBurndownComputed.tierNormalizedBy ||
        existingDebtBurndown.tierNormalizedAt !== debtBurndownComputed.tierNormalizedAt ||
        existingDebtBurndown.tierNormalizedTo !== debtBurndownComputed.tierNormalizedTo ||
        existingDebtBurndown.debtVelocityPerDay !== debtBurndownComputed.debtVelocityPerDay ||
        existingDebtBurndown.projectedBurndownHours !== debtBurndownComputed.projectedBurndownHours ||
        existingDebtBurndown.forecastBreachHours !== debtBurndownComputed.forecastBreachHours
      if (debtBurndownChanged) {
        await repos.filingEscalationClosureAdjudicationDebtBurndown.upsert(debtBurndownComputed)
      }
      store.filingEscalationClosureAdjudicationDebtBurndown.set(
        debtBurndownComputed.id,
        debtBurndownComputed
      )
      adjudicationDebtBurndownByOwner.set(owner, {
        id: debtBurndownComputed.id,
        status: debtBurndownComputed.status,
        forecastBreachHours: debtBurndownComputed.forecastBreachHours,
        debtVelocityPerDay: debtBurndownComputed.debtVelocityPerDay,
        retirementTargetAt: debtBurndownComputed.retirementTargetAt,
      })
      const existingSafeguardAttestation =
        existingSafeguardAttestationByExpiryId.get(safeguardExpiryComputed.id) ?? null
      const safeguardAttestationComputed = buildFilingEscalationClosureSafeguardExpiryAttestationRow({
        expiry: safeguardExpiryComputed,
        existing: existingSafeguardAttestation,
        now: input.now,
      })
      const safeguardAttestationChanged =
        !existingSafeguardAttestation ||
        existingSafeguardAttestation.status !== safeguardAttestationComputed.status ||
        existingSafeguardAttestation.acknowledgedBy !== safeguardAttestationComputed.acknowledgedBy ||
        existingSafeguardAttestation.acknowledgedAt !== safeguardAttestationComputed.acknowledgedAt ||
        existingSafeguardAttestation.overdueExceptionQueuedBy !==
          safeguardAttestationComputed.overdueExceptionQueuedBy ||
        existingSafeguardAttestation.overdueExceptionQueuedAt !==
          safeguardAttestationComputed.overdueExceptionQueuedAt ||
        existingSafeguardAttestation.overrideReconciledBy !==
          safeguardAttestationComputed.overrideReconciledBy ||
        existingSafeguardAttestation.overrideReconciledAt !==
          safeguardAttestationComputed.overrideReconciledAt ||
        existingSafeguardAttestation.latestReconciliationNote !==
          safeguardAttestationComputed.latestReconciliationNote ||
        existingSafeguardAttestation.openBacklogHours !== safeguardAttestationComputed.openBacklogHours
      if (safeguardAttestationChanged) {
        await repos.filingEscalationClosureSafeguardExpiryAttestations.upsert(
          safeguardAttestationComputed
        )
      }
      store.filingEscalationClosureSafeguardExpiryAttestations.set(
        safeguardAttestationComputed.id,
        safeguardAttestationComputed
      )
      safeguardExpiryAttestationByOwner.set(owner, {
        id: safeguardAttestationComputed.id,
        status: safeguardAttestationComputed.status,
        openBacklogHours: safeguardAttestationComputed.openBacklogHours,
      })
      const existingRecalibration =
        existingBurndownRecalibrationByBurndownId.get(debtBurndownComputed.id) ?? null
      const recalibrationComputed = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown: debtBurndownComputed,
        existing: existingRecalibration,
        now: input.now,
      })
      const recalibrationChanged =
        !existingRecalibration ||
        existingRecalibration.status !== recalibrationComputed.status ||
        existingRecalibration.rebaselineTargetAt !== recalibrationComputed.rebaselineTargetAt ||
        existingRecalibration.confidenceBandLowerHours !==
          recalibrationComputed.confidenceBandLowerHours ||
        existingRecalibration.confidenceBandUpperHours !==
          recalibrationComputed.confidenceBandUpperHours ||
        existingRecalibration.confidenceOverriddenBy !==
          recalibrationComputed.confidenceOverriddenBy ||
        existingRecalibration.confidenceOverriddenAt !==
          recalibrationComputed.confidenceOverriddenAt ||
        existingRecalibration.rollbackNotedBy !== recalibrationComputed.rollbackNotedBy ||
        existingRecalibration.rollbackNotedAt !== recalibrationComputed.rollbackNotedAt ||
        existingRecalibration.rollbackReason !== recalibrationComputed.rollbackReason ||
        existingRecalibration.settledBy !== recalibrationComputed.settledBy ||
        existingRecalibration.settledAt !== recalibrationComputed.settledAt ||
        existingRecalibration.confidenceDriftHours !== recalibrationComputed.confidenceDriftHours
      if (recalibrationChanged) {
        await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationComputed)
      }
      store.filingEscalationClosureBurndownRecalibration.set(
        recalibrationComputed.id,
        recalibrationComputed
      )
      burndownRecalibrationByOwner.set(owner, {
        id: recalibrationComputed.id,
        status: recalibrationComputed.status,
        confidenceDriftHours: recalibrationComputed.confidenceDriftHours,
        rebaselineTargetAt: recalibrationComputed.rebaselineTargetAt,
      })
      const existingExpiryQueue =
        existingExpiryQueueByAttestationId.get(safeguardAttestationComputed.id) ?? null
      const expiryQueueComputed = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: safeguardAttestationComputed,
        existing: existingExpiryQueue,
        now: input.now,
      })
      const expiryQueueChanged =
        !existingExpiryQueue ||
        existingExpiryQueue.status !== expiryQueueComputed.status ||
        existingExpiryQueue.triagedBy !== expiryQueueComputed.triagedBy ||
        existingExpiryQueue.triagedAt !== expiryQueueComputed.triagedAt ||
        existingExpiryQueue.handoffAttestedBy !== expiryQueueComputed.handoffAttestedBy ||
        existingExpiryQueue.handoffAttestedAt !== expiryQueueComputed.handoffAttestedAt ||
        existingExpiryQueue.handoffToOwnerId !== expiryQueueComputed.handoffToOwnerId ||
        existingExpiryQueue.autoDrainCheckpointAt !== expiryQueueComputed.autoDrainCheckpointAt ||
        existingExpiryQueue.queueAgingHours !== expiryQueueComputed.queueAgingHours ||
        existingExpiryQueue.openExceptionCount !== expiryQueueComputed.openExceptionCount ||
        existingExpiryQueue.reconciliationCarryoverNote !==
          expiryQueueComputed.reconciliationCarryoverNote
      if (expiryQueueChanged) {
        await repos.filingEscalationClosureExpiryAttestationQueue.upsert(expiryQueueComputed)
      }
      store.filingEscalationClosureExpiryAttestationQueue.set(
        expiryQueueComputed.id,
        expiryQueueComputed
      )
      expiryAttestationQueueByOwner.set(owner, {
        id: expiryQueueComputed.id,
        status: expiryQueueComputed.status,
        queueAgingHours: expiryQueueComputed.queueAgingHours,
        openExceptionCount: expiryQueueComputed.openExceptionCount,
      })
      const existingSettlement =
        existingBurndownSettlementByRecalibrationId.get(recalibrationComputed.id) ?? null
      const settlementComputed = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationComputed,
        existing: existingSettlement,
        now: input.now,
      })
      const settlementChanged =
        !existingSettlement ||
        existingSettlement.status !== settlementComputed.status ||
        existingSettlement.driftAcknowledgedBy !== settlementComputed.driftAcknowledgedBy ||
        existingSettlement.driftAcknowledgedAt !== settlementComputed.driftAcknowledgedAt ||
        existingSettlement.targetLockAttestedBy !== settlementComputed.targetLockAttestedBy ||
        existingSettlement.targetLockAttestedAt !== settlementComputed.targetLockAttestedAt ||
        existingSettlement.rollbackResolutionClosedBy !== settlementComputed.rollbackResolutionClosedBy ||
        existingSettlement.rollbackResolutionClosedAt !== settlementComputed.rollbackResolutionClosedAt ||
        existingSettlement.rollbackResolutionNote !== settlementComputed.rollbackResolutionNote ||
        existingSettlement.settlementLatencyHours !== settlementComputed.settlementLatencyHours
      if (settlementChanged) {
        await repos.filingEscalationClosureBurndownSettlement.upsert(settlementComputed)
      }
      store.filingEscalationClosureBurndownSettlement.set(settlementComputed.id, settlementComputed)
      burndownSettlementByOwner.set(owner, {
        id: settlementComputed.id,
        status: settlementComputed.status,
        settlementLatencyHours: settlementComputed.settlementLatencyHours,
      })
      const existingQueueDrain =
        existingExpiryQueueDrainByQueueItemId.get(expiryQueueComputed.id) ?? null
      const queueDrainComputed = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: expiryQueueComputed,
        existing: existingQueueDrain,
        now: input.now,
      })
      const queueDrainChanged =
        !existingQueueDrain ||
        existingQueueDrain.status !== queueDrainComputed.status ||
        existingQueueDrain.handoffTimeoutEscalatedBy !== queueDrainComputed.handoffTimeoutEscalatedBy ||
        existingQueueDrain.handoffTimeoutEscalatedAt !== queueDrainComputed.handoffTimeoutEscalatedAt ||
        existingQueueDrain.staleReassignmentAttestedBy !== queueDrainComputed.staleReassignmentAttestedBy ||
        existingQueueDrain.staleReassignmentAttestedAt !== queueDrainComputed.staleReassignmentAttestedAt ||
        existingQueueDrain.reassignedOwnerId !== queueDrainComputed.reassignedOwnerId ||
        existingQueueDrain.forcedDrainCheckpointedBy !== queueDrainComputed.forcedDrainCheckpointedBy ||
        existingQueueDrain.forcedDrainCheckpointedAt !== queueDrainComputed.forcedDrainCheckpointedAt ||
        existingQueueDrain.forcedDrainOverrideNote !== queueDrainComputed.forcedDrainOverrideNote ||
        existingQueueDrain.drainThroughputPerDay !== queueDrainComputed.drainThroughputPerDay ||
        existingQueueDrain.openQueueAgingHours !== queueDrainComputed.openQueueAgingHours
      if (queueDrainChanged) {
        await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainComputed)
      }
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(
        queueDrainComputed.id,
        queueDrainComputed
      )
      expiryAttestationQueueDrainByOwner.set(owner, {
        id: queueDrainComputed.id,
        status: queueDrainComputed.status,
        drainThroughputPerDay: queueDrainComputed.drainThroughputPerDay,
        openQueueAgingHours: queueDrainComputed.openQueueAgingHours,
      })
      const existingSettlementAttestation =
        existingSettlementAttestationBySettlementId.get(settlementComputed.id) ?? null
      const settlementAttestationComputed = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementComputed,
        existing: existingSettlementAttestation,
        now: input.now,
      })
      const settlementAttestationChanged =
        !existingSettlementAttestation ||
        existingSettlementAttestation.status !== settlementAttestationComputed.status ||
        existingSettlementAttestation.postResolutionCheckpointedBy !==
          settlementAttestationComputed.postResolutionCheckpointedBy ||
        existingSettlementAttestation.postResolutionCheckpointedAt !==
          settlementAttestationComputed.postResolutionCheckpointedAt ||
        existingSettlementAttestation.lockReleaseAttestedBy !==
          settlementAttestationComputed.lockReleaseAttestedBy ||
        existingSettlementAttestation.lockReleaseAttestedAt !==
          settlementAttestationComputed.lockReleaseAttestedAt ||
        existingSettlementAttestation.disputeReopenGuardedBy !==
          settlementAttestationComputed.disputeReopenGuardedBy ||
        existingSettlementAttestation.disputeReopenGuardedAt !==
          settlementAttestationComputed.disputeReopenGuardedAt ||
        existingSettlementAttestation.disputeReopenGuardNote !==
          settlementAttestationComputed.disputeReopenGuardNote ||
        existingSettlementAttestation.settlementVerificationLagHours !==
          settlementAttestationComputed.settlementVerificationLagHours
      if (settlementAttestationChanged) {
        await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationComputed)
      }
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationComputed.id,
        settlementAttestationComputed
      )
      settlementAttestationByOwner.set(owner, {
        id: settlementAttestationComputed.id,
        status: settlementAttestationComputed.status,
        settlementVerificationLagHours: settlementAttestationComputed.settlementVerificationLagHours,
      })
      const existingQueueDrainReconciliation =
        existingQueueDrainReconciliationByQueueDrainId.get(queueDrainComputed.id) ?? null
      const queueDrainReconciliationComputed = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainComputed,
        existing: existingQueueDrainReconciliation,
        now: input.now,
      })
      const queueDrainReconciliationChanged =
        !existingQueueDrainReconciliation ||
        existingQueueDrainReconciliation.status !== queueDrainReconciliationComputed.status ||
        existingQueueDrainReconciliation.forcedDrainAttestedBy !==
          queueDrainReconciliationComputed.forcedDrainAttestedBy ||
        existingQueueDrainReconciliation.forcedDrainAttestedAt !==
          queueDrainReconciliationComputed.forcedDrainAttestedAt ||
        existingQueueDrainReconciliation.reassignmentRollbackCheckpointedBy !==
          queueDrainReconciliationComputed.reassignmentRollbackCheckpointedBy ||
        existingQueueDrainReconciliation.reassignmentRollbackCheckpointedAt !==
          queueDrainReconciliationComputed.reassignmentRollbackCheckpointedAt ||
        existingQueueDrainReconciliation.rollbackToOwnerId !==
          queueDrainReconciliationComputed.rollbackToOwnerId ||
        existingQueueDrainReconciliation.timeoutReentryControlledBy !==
          queueDrainReconciliationComputed.timeoutReentryControlledBy ||
        existingQueueDrainReconciliation.timeoutReentryControlledAt !==
          queueDrainReconciliationComputed.timeoutReentryControlledAt ||
        existingQueueDrainReconciliation.timeoutReentryWindowHours !==
          queueDrainReconciliationComputed.timeoutReentryWindowHours ||
        existingQueueDrainReconciliation.drainReopenPressureCount !==
          queueDrainReconciliationComputed.drainReopenPressureCount
      if (queueDrainReconciliationChanged) {
        await repos.filingEscalationClosureQueueDrainReconciliation.upsert(
          queueDrainReconciliationComputed
        )
      }
      store.filingEscalationClosureQueueDrainReconciliation.set(
        queueDrainReconciliationComputed.id,
        queueDrainReconciliationComputed
      )
      queueDrainReconciliationByOwner.set(owner, {
        id: queueDrainReconciliationComputed.id,
        status: queueDrainReconciliationComputed.status,
        drainReopenPressureCount: queueDrainReconciliationComputed.drainReopenPressureCount,
      })
      const existingSettlementArbitration =
        existingSettlementArbitrationBySettlementAttestationId.get(settlementAttestationComputed.id) ?? null
      const settlementArbitrationComputed = buildFilingEscalationClosureSettlementArbitrationRow({
        settlementAttestation: settlementAttestationComputed,
        existing: existingSettlementArbitration,
        now: input.now,
      })
      const settlementArbitrationChanged =
        !existingSettlementArbitration ||
        existingSettlementArbitration.status !== settlementArbitrationComputed.status ||
        existingSettlementArbitration.verificationOverridePetitionedBy !==
          settlementArbitrationComputed.verificationOverridePetitionedBy ||
        existingSettlementArbitration.verificationOverridePetitionedAt !==
          settlementArbitrationComputed.verificationOverridePetitionedAt ||
        existingSettlementArbitration.panelConfirmationAttestedBy !==
          settlementArbitrationComputed.panelConfirmationAttestedBy ||
        existingSettlementArbitration.panelConfirmationAttestedAt !==
          settlementArbitrationComputed.panelConfirmationAttestedAt ||
        existingSettlementArbitration.reopenVetoCheckpointedBy !==
          settlementArbitrationComputed.reopenVetoCheckpointedBy ||
        existingSettlementArbitration.reopenVetoCheckpointedAt !==
          settlementArbitrationComputed.reopenVetoCheckpointedAt ||
        existingSettlementArbitration.reopenVetoNote !== settlementArbitrationComputed.reopenVetoNote ||
        existingSettlementArbitration.settlementArbitrationLeadTimeHours !==
          settlementArbitrationComputed.settlementArbitrationLeadTimeHours
      if (settlementArbitrationChanged) {
        await repos.filingEscalationClosureSettlementArbitration.upsert(settlementArbitrationComputed)
      }
      store.filingEscalationClosureSettlementArbitration.set(
        settlementArbitrationComputed.id,
        settlementArbitrationComputed
      )
      settlementArbitrationByOwner.set(owner, {
        id: settlementArbitrationComputed.id,
        status: settlementArbitrationComputed.status,
        settlementArbitrationLeadTimeHours:
          settlementArbitrationComputed.settlementArbitrationLeadTimeHours,
        arbitrationRulingAgingHours: settlementArbitrationComputed.arbitrationRulingAgingHours ?? 0,
        arbitrationPublicationExceptionBacklogCount:
          settlementArbitrationComputed.arbitrationPublicationExceptionBacklogCount ?? 0,
      })
      const existingQueueReentryCompliance =
        existingQueueReentryComplianceByQueueReconciliationId.get(queueDrainReconciliationComputed.id) ??
        null
      const queueReentryComplianceComputed = buildFilingEscalationClosureQueueReentryComplianceRow({
        queueReconciliation: queueDrainReconciliationComputed,
        existing: existingQueueReentryCompliance,
        now: input.now,
      })
      const queueReentryComplianceChanged =
        !existingQueueReentryCompliance ||
        existingQueueReentryCompliance.status !== queueReentryComplianceComputed.status ||
        existingQueueReentryCompliance.reentryExceptionAttestedBy !==
          queueReentryComplianceComputed.reentryExceptionAttestedBy ||
        existingQueueReentryCompliance.reentryExceptionAttestedAt !==
          queueReentryComplianceComputed.reentryExceptionAttestedAt ||
        existingQueueReentryCompliance.timeoutWaiverCheckpointedBy !==
          queueReentryComplianceComputed.timeoutWaiverCheckpointedBy ||
        existingQueueReentryCompliance.timeoutWaiverCheckpointedAt !==
          queueReentryComplianceComputed.timeoutWaiverCheckpointedAt ||
        existingQueueReentryCompliance.timeoutWaiverHours !==
          queueReentryComplianceComputed.timeoutWaiverHours ||
        existingQueueReentryCompliance.reconciliationResumedBy !==
          queueReentryComplianceComputed.reconciliationResumedBy ||
        existingQueueReentryCompliance.reconciliationResumedAt !==
          queueReentryComplianceComputed.reconciliationResumedAt ||
        existingQueueReentryCompliance.queueReentryExceptionDebtCount !==
          queueReentryComplianceComputed.queueReentryExceptionDebtCount
      if (queueReentryComplianceChanged) {
        await repos.filingEscalationClosureQueueReentryCompliance.upsert(queueReentryComplianceComputed)
      }
      store.filingEscalationClosureQueueReentryCompliance.set(
        queueReentryComplianceComputed.id,
        queueReentryComplianceComputed
      )
      queueReentryComplianceByOwner.set(owner, {
        id: queueReentryComplianceComputed.id,
        status: queueReentryComplianceComputed.status,
        queueReentryExceptionDebtCount: queueReentryComplianceComputed.queueReentryExceptionDebtCount,
        queueReentryRetirementBurnCount: queueReentryComplianceComputed.queueReentryRetirementBurnCount ?? 0,
        queueReentryRetirementReconciliationDriftCount:
          queueReentryComplianceComputed.queueReentryRetirementReconciliationDriftCount ?? 0,
      })
    }
  }
  return {
    digestByOwner,
    queueByOwner,
    slaWindowByOwner,
    latestAttestationByOwner,
    exceptionDigestByOwner,
    attestationDisputeByOwner,
    exceptionEnforcementByOwner,
    adjudicationByOwner,
    rebalanceByOwner,
    adjudicationQuorumByOwner,
    rebalanceExecutionByOwner,
    adjudicationSloByOwner,
    rebalanceSafeguardByOwner,
    adjudicationSloDebtRemediationByOwner,
    rebalanceSafeguardExpiryByOwner,
    adjudicationDebtBurndownByOwner,
    safeguardExpiryAttestationByOwner,
    burndownRecalibrationByOwner,
    expiryAttestationQueueByOwner,
    burndownSettlementByOwner,
    expiryAttestationQueueDrainByOwner,
    settlementAttestationByOwner,
    queueDrainReconciliationByOwner,
    settlementArbitrationByOwner,
    queueReentryComplianceByOwner,
  }
}

// Erratum E-24 (L18 §9.1 rule 4): only the core package path (isFilingsCoreRequest) stays live
// while LEGACY_GOVERNANCE_CHAINS is off. The gate runs inside withSession, so auth applies first.
const handleGetGated = gateByFlag("LEGACY_GOVERNANCE_CHAINS", handleGet, isFilingsCoreRequest)

export async function GET(request: Request) {
  return withSession(request, handleGetGated)
}

async function handleGet(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = parseFilingsView(url.searchParams.get("view"))
  const userId = url.searchParams.get("userId")
  const matterId = url.searchParams.get("matterId") ?? undefined
  const readiness = parseReadiness(url.searchParams.get("readiness"))
  const dispatchStatus = url.searchParams.get("dispatchStatus")
  const assigneeId = url.searchParams.get("assigneeId")
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  try {
    const user = store.users.get(userId)
    if (!user) {
      return NextResponse.json({ error: "unknown user" }, { status: 404 })
    }
    await syncFirmMembers(store, repos, user.firmId)
    const firmPackages = await repos.filings.listByFirm(user.firmId)
    const artifactRows = await repos.filingPacketArtifacts.listByFirm(user.firmId)
    const artifactByPackage = new Map(artifactRows.map((row) => [row.packageId, row]))
    // GET is side-effect free: rows missing for legacy packages are derived for this response
    // only. create_package / decide_package (POST) persist them.
    for (const filingPackage of firmPackages) {
      if (artifactByPackage.has(filingPackage.id)) continue
      const draft =
        store.drafts.get(filingPackage.draftId) ?? (await repos.drafts.get(filingPackage.draftId))
      // Anchor derived timestamps to the package (FilingPackage has no updatedAt) so repeated
      // GETs return identical rows.
      artifactByPackage.set(
        filingPackage.id,
        buildFilingPacketArtifactRow(filingPackage, draft, { now: filingPackage.createdAt })
      )
    }
    const queueRows = await repos.filingDispatchQueue.listByFirm(user.firmId)
    const queueByPackage = new Map(queueRows.map((row) => [row.packageId, row]))
    for (const filingPackage of firmPackages) {
      if (filingPackage.status !== "approved" || queueByPackage.has(filingPackage.id)) continue
      queueByPackage.set(
        filingPackage.id,
        buildFilingDispatchQueueRow(filingPackage, { now: filingPackage.createdAt })
      )
    }
    if (view === "dispatch") {
      const visible = [...queueByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .filter((row) => {
          if (!dispatchStatus || !isFilingDispatchQueueStatus(dispatchStatus)) return true
          return row.status === dispatchStatus
        })
        .filter((row) => (assigneeId ? row.assigneeId === assigneeId : true))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "annexures") {
      const annexureStatus = url.searchParams.get("annexureStatus")
      const packageId = url.searchParams.get("packageId")
      const annexureRows = await repos.filingAnnexures.listByFirm(user.firmId)
      const annexureByPackage = new Map(annexureRows.map((row) => [row.packageId, row]))
      for (const filingPackage of firmPackages) {
        if (filingPackage.status !== "approved" || annexureByPackage.has(filingPackage.id)) continue
        const queueRow = queueByPackage.get(filingPackage.id) ?? null
        if (!queueRow || queueRow.status === "blocked") continue
        const annexure = buildFilingAnnexureRow(filingPackage, queueRow)
        await repos.filingAnnexures.upsert(annexure)
        store.filingAnnexures.set(annexure.id, annexure)
        annexureByPackage.set(filingPackage.id, annexure)
      }
      const visible = [...annexureByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .filter((row) => {
          if (!annexureStatus || !isFilingAnnexureGenerationStatus(annexureStatus)) return true
          return row.generationStatus === annexureStatus
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "submission_receipts") {
      const packageId = url.searchParams.get("packageId")
      const dispatchOutcome = url.searchParams.get("dispatchOutcome")
      const receiptRows = await repos.filingSubmissionReceipts.listByFirm(user.firmId)
      const visible = receiptRows
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!dispatchOutcome || !isFilingSubmissionDispatchOutcome(dispatchOutcome)) return true
          return row.dispatchOutcome === dispatchOutcome
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.recordedAt - a.recordedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "submission_reconciliation") {
      const packageId = url.searchParams.get("packageId")
      const reconciliationStatus = url.searchParams.get("reconciliationStatus")
      const annexureRows = await repos.filingAnnexures.listByFirm(user.firmId)
      const readyAnnexureByPackage = new Map(
        annexureRows
          .filter((row) => row.generationStatus === "ready")
          .map((row) => [row.packageId, row])
      )
      const receiptRows = await repos.filingSubmissionReceipts.listByFirm(user.firmId)
      const receiptsByPackage = new Map<string, typeof receiptRows>()
      for (const receipt of receiptRows) {
        const current = receiptsByPackage.get(receipt.packageId) ?? []
        current.push(receipt)
        receiptsByPackage.set(receipt.packageId, current)
      }
      const persistedRows = await repos.filingSubmissionReconciliation.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      for (const filingPackage of firmPackages) {
        if (filingPackage.status !== "approved") continue
        if (!readyAnnexureByPackage.has(filingPackage.id)) continue
        const receipts = receiptsByPackage.get(filingPackage.id) ?? []
        const existing = rowsByPackage.get(filingPackage.id)
        const computed = buildFilingSubmissionReconciliationRow(filingPackage, receipts, {
          notes: existing?.notes ?? [],
        })
        const hasNewAttempt =
          !existing ||
          existing.totalAttempts !== computed.totalAttempts ||
          existing.latestReceiptId !== computed.latestReceiptId
        const changed =
          !existing ||
          existing.totalAttempts !== computed.totalAttempts ||
          existing.latestReceiptId !== computed.latestReceiptId ||
          existing.latestSubmissionReference !== computed.latestSubmissionReference ||
          existing.latestDispatchOutcome !== computed.latestDispatchOutcome
        const next = changed
          ? existing
            ? {
                ...computed,
                status: hasNewAttempt ? computed.status : existing.status,
                notes: existing.notes,
                updatedAt: Date.now(),
              }
            : computed
          : existing
        if (changed || !existing) {
          await repos.filingSubmissionReconciliation.upsert(next)
        }
        store.filingSubmissionReconciliation.set(next.id, next)
        rowsByPackage.set(filingPackage.id, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (
            !reconciliationStatus ||
            !isFilingSubmissionReconciliationStatus(reconciliationStatus)
          ) {
            return true
          }
          return row.status === reconciliationStatus
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "submission_exceptions") {
      const packageId = url.searchParams.get("packageId")
      const exceptionStatus = url.searchParams.get("exceptionStatus")
      const severity = url.searchParams.get("severity")
      const escalationOwnerId = url.searchParams.get("escalationOwnerId")
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const persistedRows = await repos.filingSubmissionExceptions.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const receiptRows = await repos.filingSubmissionReceipts.listByFirm(user.firmId)
      const receiptById = new Map(receiptRows.map((row) => [row.id, row]))
      const latestFailingReceiptByPackage = new Map<string, (typeof receiptRows)[number]>()
      for (const row of receiptRows) {
        if (row.dispatchOutcome === "accepted") continue
        const current = latestFailingReceiptByPackage.get(row.packageId)
        if (!current || row.attemptNo > current.attemptNo) {
          latestFailingReceiptByPackage.set(row.packageId, row)
        }
      }
      const reconciliationRows = await repos.filingSubmissionReconciliation.listByFirm(user.firmId)
      const reconciliationByPackage = new Map(
        reconciliationRows.map((row) => [row.packageId, row])
      )
      const needsRetryReconciliationByPackage = new Map(
        reconciliationRows
          .filter((row) => row.status === "needs_retry")
          .map((row) => [row.packageId, row])
      )
      for (const [pkgId, reconciliation] of needsRetryReconciliationByPackage.entries()) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const linkedReceipt =
          (reconciliation.latestReceiptId
            ? receiptById.get(reconciliation.latestReceiptId)
            : undefined) ?? null
        const next = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source: "reconciliation_needs_retry",
            receipt: linkedReceipt,
            reconciliation,
            actorId: "system_sync",
            now: reconciliation.updatedAt,
          },
          existing
        )
        const changed =
          !existing ||
          existing.source !== next.source ||
          existing.latestReceiptId !== next.latestReceiptId ||
          existing.latestReconciliationId !== next.latestReconciliationId ||
          existing.lastRaisedAt !== next.lastRaisedAt ||
          existing.status === "resolved"
        if (changed) {
          await repos.filingSubmissionExceptions.upsert(next)
        }
        store.filingSubmissionExceptions.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      for (const [pkgId, receipt] of latestFailingReceiptByPackage.entries()) {
        if (needsRetryReconciliationByPackage.has(pkgId)) continue
        if (reconciliationByPackage.get(pkgId)?.status === "reconciled") continue
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const source =
          receipt.dispatchOutcome === "rejected"
            ? ("receipt_rejected" as const)
            : ("receipt_retry_scheduled" as const)
        const next = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source,
            receipt,
            reconciliation: null,
            actorId: "system_sync",
            now: receipt.recordedAt,
          },
          existing
        )
        const changed =
          !existing ||
          existing.source !== next.source ||
          existing.latestReceiptId !== next.latestReceiptId ||
          existing.lastRaisedAt !== next.lastRaisedAt ||
          existing.status === "resolved"
        if (changed) {
          await repos.filingSubmissionExceptions.upsert(next)
        }
        store.filingSubmissionExceptions.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingSubmissionExceptionStatus(exceptionStatus)) return true
          return row.status === exceptionStatus
        })
        .filter((row) => {
          if (!isFilingSubmissionExceptionSeverity(severity)) return true
          return row.severity === severity
        })
        .filter((row) => (escalationOwnerId ? row.escalationOwnerId === escalationOwnerId : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => a.slaTargetAt - b.slaTargetAt || b.updatedAt - a.updatedAt)
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "transport_execution") {
      const packageId = url.searchParams.get("packageId")
      const outcome = url.searchParams.get("outcome")
      const blockerTag = url.searchParams.get("blockerTag")?.trim().toLowerCase()
      const rows = await repos.filingTransportExecutionEvidence.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingTransportExecutionOutcome(outcome)) return true
          return row.outcome === outcome
        })
        .filter((row) => {
          if (!blockerTag) return true
          return row.deterministicBlockerTags.includes(blockerTag)
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "submission_sla_digests") {
      const packageId = url.searchParams.get("packageId")
      const digestStatus = url.searchParams.get("digestStatus")
      const ownerId = url.searchParams.get("ownerId")
      const reason = url.searchParams.get("reason")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const exceptionRows = await repos.filingSubmissionExceptions.listByFirm(user.firmId)
      const exceptionByPackage = new Map(exceptionRows.map((row) => [row.packageId, row]))
      const evidenceRows = await repos.filingTransportExecutionEvidence.listByFirm(user.firmId)
      const evidenceByPackage = new Map<string, typeof evidenceRows>()
      for (const row of evidenceRows) {
        const current = evidenceByPackage.get(row.packageId) ?? []
        current.push(row)
        evidenceByPackage.set(row.packageId, current)
      }
      const persistedDigestRows = await repos.filingSubmissionSlaDigests.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedDigestRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...exceptionByPackage.keys(),
        ...evidenceByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const evidence = (evidenceByPackage.get(pkgId) ?? []).sort(
          (a, b) => a.createdAt - b.createdAt || a.sequenceNo - b.sequenceNo
        )
        const latestEvidence = evidence[evidence.length - 1] ?? null
        const deliveredEvidenceAt = evidence
          .filter((row) => row.outcome === "confirm_delivered")
          .reduce((max, row) => (row.createdAt > max ? row.createdAt : max), 0)
        const computed = buildSubmissionSlaDigestRow(filingPackage, {
          exception: exceptionByPackage.get(pkgId) ?? null,
          latestEvidence,
          deliveredEvidenceAt: deliveredEvidenceAt > 0 ? deliveredEvidenceAt : null,
          now,
          existing,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.staleRetryPlan !== computed.staleRetryPlan ||
          existing.outstandingOwnerId !== computed.outstandingOwnerId ||
          existing.linkedExceptionId !== computed.linkedExceptionId ||
          existing.linkedEvidenceId !== computed.linkedEvidenceId ||
          existing.deferUntil !== computed.deferUntil ||
          JSON.stringify(existing.breachReasons) !== JSON.stringify(computed.breachReasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingSubmissionSlaDigests.upsert(next)
        }
        store.filingSubmissionSlaDigests.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingSubmissionSlaDigestStatus(digestStatus)) return true
          return row.status === digestStatus
        })
        .filter((row) => (ownerId ? row.outstandingOwnerId === ownerId : true))
        .filter((row) => (reason ? row.breachReasons.includes(reason as typeof row.breachReasons[number]) : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => a.status.localeCompare(b.status) || a.breachWindowStartedAt - b.breachWindowStartedAt)
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "escalation_owner_rota") {
      const packageId = url.searchParams.get("packageId")
      const ownerId = url.searchParams.get("ownerId")
      const rotaStatus = url.searchParams.get("rotaStatus")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const exceptionRows = await repos.filingSubmissionExceptions.listByFirm(user.firmId)
      const exceptionByPackage = new Map(exceptionRows.map((row) => [row.packageId, row]))
      const digestRows = await repos.filingSubmissionSlaDigests.listByFirm(user.firmId)
      const digestByPackage = new Map(digestRows.map((row) => [row.packageId, row]))
      const persistedRows = await repos.filingEscalationOwnerRota.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...exceptionByPackage.keys(),
        ...digestByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const exception = exceptionByPackage.get(pkgId) ?? null
        const digest = digestByPackage.get(pkgId) ?? null
        const existing = rowsByPackage.get(pkgId) ?? null
        const seedPrimary =
          existing?.primaryOwnerId ?? exception?.escalationOwnerId ?? digest?.outstandingOwnerId ?? null
        const seedBackup = existing?.backupOwnerId ?? null
        if (!existing && !seedPrimary && !seedBackup) continue
        const computed = buildFilingEscalationOwnerRotaRow(filingPackage, {
          now,
          existing,
          primaryOwnerId: seedPrimary,
          backupOwnerId: seedBackup,
          linkedExceptionId: exception?.id ?? null,
          linkedDigestId: digest?.id ?? null,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.primaryOwnerId !== computed.primaryOwnerId ||
          existing.backupOwnerId !== computed.backupOwnerId ||
          existing.activeWindowEndAt !== computed.activeWindowEndAt ||
          existing.linkedExceptionId !== computed.linkedExceptionId ||
          existing.linkedDigestId !== computed.linkedDigestId ||
          existing.handoffRequired !== computed.handoffRequired ||
          existing.handoffAcknowledgedBy !== computed.handoffAcknowledgedBy ||
          existing.handoffAcknowledgedAt !== computed.handoffAcknowledgedAt
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationOwnerRota.upsert(next)
        }
        store.filingEscalationOwnerRota.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationOwnerRotaStatus(rotaStatus)) return true
          return row.status === rotaStatus
        })
        .filter((row) => {
          if (!ownerId) return true
          return row.primaryOwnerId === ownerId || row.backupOwnerId === ownerId
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_compliance_digests") {
      const packageId = url.searchParams.get("packageId")
      const ownerId = url.searchParams.get("ownerId")
      const digestStatus = url.searchParams.get("digestStatus")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const {
        digestByOwner,
        slaWindowByOwner,
        exceptionDigestByOwner,
        attestationDisputeByOwner,
        exceptionEnforcementByOwner,
        adjudicationByOwner,
        rebalanceByOwner,
        adjudicationQuorumByOwner,
        rebalanceExecutionByOwner,
        adjudicationSloByOwner,
        rebalanceSafeguardByOwner,
        adjudicationSloDebtRemediationByOwner,
        rebalanceSafeguardExpiryByOwner,
        adjudicationDebtBurndownByOwner,
        safeguardExpiryAttestationByOwner,
        burndownRecalibrationByOwner,
        expiryAttestationQueueByOwner,
        burndownSettlementByOwner,
        expiryAttestationQueueDrainByOwner,
        settlementAttestationByOwner,
        queueDrainReconciliationByOwner,
        settlementArbitrationByOwner,
        queueReentryComplianceByOwner,
      } =
        await recomputeClosureComplianceState(store, repos, {
        firmId: user.firmId,
        packageById,
        now,
        })
      const visible = [...digestByOwner.values()]
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (packageId ? row.linkedPackageIds.includes(packageId) : true))
        .filter((row) => {
          if (!isFilingEscalationClosureComplianceDigestStatus(digestStatus)) return true
          return row.status === digestStatus
        })
        .filter((row) => {
          if (row.linkedPackageIds.length === 0) return user.role === "partner"
          return row.linkedPackageIds.some((pkgId) => {
            const filingPackage = packageById.get(pkgId)
            if (!filingPackage) return false
            const permission = checkPermission(store, user.id, "draft", filingPackage.matterId)
            if (!permission.allow) return false
            return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(filingPackage.classification)
          })
        })
        .map((row) => {
          const window = slaWindowByOwner.get(row.ownerId)
          const exceptionDigest = exceptionDigestByOwner.get(row.ownerId)
          const dispute = attestationDisputeByOwner.get(row.ownerId)
          const enforcement = exceptionEnforcementByOwner.get(row.ownerId)
          const adjudication = adjudicationByOwner.get(row.ownerId)
          const rebalance = rebalanceByOwner.get(row.ownerId)
          const quorum = adjudicationQuorumByOwner.get(row.ownerId)
          const execution = rebalanceExecutionByOwner.get(row.ownerId)
          const slo = adjudicationSloByOwner.get(row.ownerId)
          const safeguard = rebalanceSafeguardByOwner.get(row.ownerId)
          const remediation = adjudicationSloDebtRemediationByOwner.get(row.ownerId)
          const safeguardExpiry = rebalanceSafeguardExpiryByOwner.get(row.ownerId)
          const debtBurndown = adjudicationDebtBurndownByOwner.get(row.ownerId)
          const safeguardAttestation = safeguardExpiryAttestationByOwner.get(row.ownerId)
          const burndownRecalibration = burndownRecalibrationByOwner.get(row.ownerId)
          const expiryQueue = expiryAttestationQueueByOwner.get(row.ownerId)
          const burndownSettlement = burndownSettlementByOwner.get(row.ownerId)
          const expiryQueueDrain = expiryAttestationQueueDrainByOwner.get(row.ownerId)
          const settlementAttestation = settlementAttestationByOwner.get(row.ownerId)
          const queueDrainReconciliation = queueDrainReconciliationByOwner.get(row.ownerId)
          const settlementArbitration = settlementArbitrationByOwner.get(row.ownerId)
          const queueReentryCompliance = queueReentryComplianceByOwner.get(row.ownerId)
          return {
            ...row,
            slaWindowStatus: window?.status ?? "cleared",
            slaPressureLevel: window?.pressureLevel ?? "baseline",
            slaAckDeadlineAt: window?.ackDeadlineAt ?? null,
            slaClearDeadlineAt: window?.clearDeadlineAt ?? null,
            slaAutoEscalateAt: window?.autoEscalateAt ?? null,
            slaAutoEscalatedToPartnerId: window?.autoEscalatedToPartnerId ?? null,
            slaExceptionStatus: exceptionDigest?.status ?? "cleared",
            slaExceptionPressureLevel: exceptionDigest?.pressureLevel ?? "baseline",
            slaExceptionReasons: exceptionDigest?.reasons ?? [],
            attestationDisputeStatus: dispute?.status ?? null,
            attestationDisputeConflictReason: dispute?.conflictReason ?? null,
            slaExceptionEnforcementStatus: enforcement?.status ?? "closed",
            slaExceptionReminderCount: enforcement?.reminderCount ?? 0,
            slaExceptionEscalationCount: enforcement?.escalationCount ?? 0,
            closureAdjudicationStatus: adjudication?.status ?? null,
            closureAdjudicationVerdict: adjudication?.verdict ?? null,
            closureAdjudicationPanelBacklog: adjudication
              ? Math.max(0, adjudication.panelMemberIds.length - 1)
              : 0,
            closureEnforcementRebalanceStatus: rebalance?.status ?? "none",
            closureEnforcementRebalanceCooldownUntil: rebalance?.cooldownUntil ?? null,
            closureEnforcementRebalanceReopenThrottleUntil: rebalance?.reopenThrottleUntil ?? null,
            closureAdjudicationQuorumStatus: quorum?.status ?? null,
            closureAdjudicationBreachFlags: quorum?.breachFlags ?? [],
            closureAdjudicationThroughputScore:
              adjudication &&
              (adjudication.status === "resolved_upheld" || adjudication.status === "resolved_overturned")
                ? 1
                : 0,
            closureRebalanceExecutionStatus: execution?.status ?? null,
            closureRebalanceExecutionMode: execution?.mode ?? null,
            closureRebalanceChurnCount: execution?.churnCount ?? 0,
            closureAdjudicationSloStatus: slo?.status ?? null,
            closureAdjudicationSloEscalationTier: slo?.escalationTier ?? "none",
            closureAdjudicationSloDebtHours: slo?.breachDebtHours ?? 0,
            closureRebalanceSafeguardStatus: safeguard?.status ?? "auto_exec_ready",
            closureRebalanceAutoExecutionEligible: safeguard?.autoExecutionEligible ?? true,
            closureRebalanceSuppressionReasons: safeguard?.suppressionReasons ?? [],
            closureAdjudicationSloDebtRemediationStatus: remediation?.status ?? "debt_retired",
            closureAdjudicationSloDebtAgeHours: remediation?.debtAgeHours ?? 0,
            closureRebalanceSafeguardExpiryStatus: safeguardExpiry?.status ?? "expiry_pending",
            closureRebalanceSafeguardExpiryDebtHours: safeguardExpiry?.expiryDebtHours ?? 0,
            closureAdjudicationDebtBurndownStatus: debtBurndown?.status ?? "burndown_tracking",
            closureAdjudicationDebtBurndownForecastBreachHours:
              debtBurndown?.forecastBreachHours ?? 0,
            closureAdjudicationDebtBurndownVelocityPerDay: debtBurndown?.debtVelocityPerDay ?? 0,
            closureSafeguardExpiryAttestationStatus:
              safeguardAttestation?.status ?? "attestation_open",
            closureSafeguardExpiryAttestationBacklogHours:
              safeguardAttestation?.openBacklogHours ?? 0,
            closureBurndownRecalibrationStatus:
              burndownRecalibration?.status ?? "recalibration_pending",
            closureBurndownConfidenceDriftHours:
              burndownRecalibration?.confidenceDriftHours ?? 0,
            closureExpiryAttestationQueueStatus: expiryQueue?.status ?? "queue_open",
            closureExpiryAttestationQueueAgingHours: expiryQueue?.queueAgingHours ?? 0,
            closureExpiryAttestationQueueOpenExceptions: expiryQueue?.openExceptionCount ?? 0,
            closureBurndownSettlementStatus:
              burndownSettlement?.status ?? "settlement_pending",
            closureBurndownSettlementLatencyHours:
              burndownSettlement?.settlementLatencyHours ?? 0,
            closureExpiryAttestationQueueDrainStatus:
              expiryQueueDrain?.status ?? "drain_pending",
            closureExpiryAttestationQueueDrainThroughputPerDay:
              expiryQueueDrain?.drainThroughputPerDay ?? 0,
            closureSettlementAttestationStatus:
              settlementAttestation?.status ?? "verification_pending",
            closureSettlementVerificationLagHours:
              settlementAttestation?.settlementVerificationLagHours ?? 0,
            closureQueueDrainReconciliationStatus:
              queueDrainReconciliation?.status ?? "reconciliation_pending",
            closureQueueDrainReopenPressureCount:
              queueDrainReconciliation?.drainReopenPressureCount ?? 0,
            closureSettlementArbitrationStatus:
              settlementArbitration?.status ?? "arbitration_pending",
            closureSettlementArbitrationLeadTimeHours:
              settlementArbitration?.settlementArbitrationLeadTimeHours ?? 0,
            closureArbitrationRulingAgingHours:
              settlementArbitration?.arbitrationRulingAgingHours ?? 0,
            closureArbitrationPublicationExceptionBacklogCount:
              settlementArbitration?.arbitrationPublicationExceptionBacklogCount ?? 0,
            closureQueueReentryComplianceStatus:
              queueReentryCompliance?.status ?? "compliance_pending",
            closureQueueReentryExceptionDebtCount:
              queueReentryCompliance?.queueReentryExceptionDebtCount ?? 0,
            closureQueueReentryRetirementBurnCount:
              queueReentryCompliance?.queueReentryRetirementBurnCount ?? 0,
            closureQueueReentryRetirementReconciliationDriftCount:
              queueReentryCompliance?.queueReentryRetirementReconciliationDriftCount ?? 0,
            closureCriticalPath:
              (adjudication?.status === "panel_in_review" &&
                (adjudication.dissentNotes.length > 0 || adjudication.panelMemberIds.length < 2)) ||
              rebalance?.status === "throttle_active",
          }
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_followup_queue") {
      const packageId = url.searchParams.get("packageId")
      const ownerId = url.searchParams.get("ownerId")
      const queueStatus = url.searchParams.get("queueStatus")
      const assigneeId = url.searchParams.get("assigneeId")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const {
        queueByOwner,
        slaWindowByOwner,
        exceptionDigestByOwner,
        attestationDisputeByOwner,
        exceptionEnforcementByOwner,
        adjudicationByOwner,
        rebalanceByOwner,
        adjudicationQuorumByOwner,
        rebalanceExecutionByOwner,
        adjudicationSloByOwner,
        rebalanceSafeguardByOwner,
        adjudicationSloDebtRemediationByOwner,
        rebalanceSafeguardExpiryByOwner,
        adjudicationDebtBurndownByOwner,
        safeguardExpiryAttestationByOwner,
        burndownRecalibrationByOwner,
        expiryAttestationQueueByOwner,
        burndownSettlementByOwner,
        expiryAttestationQueueDrainByOwner,
        settlementAttestationByOwner,
        queueDrainReconciliationByOwner,
        settlementArbitrationByOwner,
        queueReentryComplianceByOwner,
      } =
        await recomputeClosureComplianceState(store, repos, {
        firmId: user.firmId,
        packageById,
        now,
        })
      const visible = [...queueByOwner.values()]
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (assigneeId ? row.assignedPartnerId === assigneeId : true))
        .filter((row) => (packageId ? row.packageIds.includes(packageId) : true))
        .filter((row) => {
          if (!isFilingEscalationClosureFollowupQueueStatus(queueStatus)) return true
          return row.status === queueStatus
        })
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .map((row) => {
          const window = slaWindowByOwner.get(row.ownerId)
          const exceptionDigest = exceptionDigestByOwner.get(row.ownerId)
          const dispute = attestationDisputeByOwner.get(row.ownerId)
          const enforcement = exceptionEnforcementByOwner.get(row.ownerId)
          const adjudication = adjudicationByOwner.get(row.ownerId)
          const rebalance = rebalanceByOwner.get(row.ownerId)
          const quorum = adjudicationQuorumByOwner.get(row.ownerId)
          const execution = rebalanceExecutionByOwner.get(row.ownerId)
          const slo = adjudicationSloByOwner.get(row.ownerId)
          const safeguard = rebalanceSafeguardByOwner.get(row.ownerId)
          const remediation = adjudicationSloDebtRemediationByOwner.get(row.ownerId)
          const safeguardExpiry = rebalanceSafeguardExpiryByOwner.get(row.ownerId)
          const debtBurndown = adjudicationDebtBurndownByOwner.get(row.ownerId)
          const safeguardAttestation = safeguardExpiryAttestationByOwner.get(row.ownerId)
          const burndownRecalibration = burndownRecalibrationByOwner.get(row.ownerId)
          const expiryQueue = expiryAttestationQueueByOwner.get(row.ownerId)
          const burndownSettlement = burndownSettlementByOwner.get(row.ownerId)
          const expiryQueueDrain = expiryAttestationQueueDrainByOwner.get(row.ownerId)
          const settlementAttestation = settlementAttestationByOwner.get(row.ownerId)
          const queueDrainReconciliation = queueDrainReconciliationByOwner.get(row.ownerId)
          const settlementArbitration = settlementArbitrationByOwner.get(row.ownerId)
          const queueReentryCompliance = queueReentryComplianceByOwner.get(row.ownerId)
          return {
            ...row,
            slaWindowStatus: window?.status ?? "cleared",
            slaPressureLevel: window?.pressureLevel ?? "baseline",
            slaAckDeadlineAt: window?.ackDeadlineAt ?? null,
            slaClearDeadlineAt: window?.clearDeadlineAt ?? null,
            slaAutoEscalateAt: window?.autoEscalateAt ?? null,
            slaAutoEscalatedToPartnerId: window?.autoEscalatedToPartnerId ?? null,
            slaExceptionStatus: exceptionDigest?.status ?? "cleared",
            slaExceptionPressureLevel: exceptionDigest?.pressureLevel ?? "baseline",
            slaExceptionReasons: exceptionDigest?.reasons ?? [],
            attestationDisputeStatus: dispute?.status ?? null,
            attestationDisputeConflictReason: dispute?.conflictReason ?? null,
            slaExceptionEnforcementStatus: enforcement?.status ?? "closed",
            slaExceptionReminderCount: enforcement?.reminderCount ?? 0,
            slaExceptionEscalationCount: enforcement?.escalationCount ?? 0,
            closureAdjudicationStatus: adjudication?.status ?? null,
            closureAdjudicationVerdict: adjudication?.verdict ?? null,
            closureEnforcementRebalanceStatus: rebalance?.status ?? "none",
            closureEnforcementRebalanceCooldownUntil: rebalance?.cooldownUntil ?? null,
            closureEnforcementRebalanceReopenThrottleUntil: rebalance?.reopenThrottleUntil ?? null,
            closureAdjudicationQuorumStatus: quorum?.status ?? null,
            closureAdjudicationBreachFlags: quorum?.breachFlags ?? [],
            closureAdjudicationThroughputScore:
              adjudication &&
              (adjudication.status === "resolved_upheld" || adjudication.status === "resolved_overturned")
                ? 1
                : 0,
            closureRebalanceExecutionStatus: execution?.status ?? null,
            closureRebalanceExecutionMode: execution?.mode ?? null,
            closureRebalanceChurnCount: execution?.churnCount ?? 0,
            closureAdjudicationSloStatus: slo?.status ?? null,
            closureAdjudicationSloEscalationTier: slo?.escalationTier ?? "none",
            closureAdjudicationSloDebtHours: slo?.breachDebtHours ?? 0,
            closureRebalanceSafeguardStatus: safeguard?.status ?? "auto_exec_ready",
            closureRebalanceAutoExecutionEligible: safeguard?.autoExecutionEligible ?? true,
            closureRebalanceSuppressionReasons: safeguard?.suppressionReasons ?? [],
            closureAdjudicationSloDebtRemediationStatus: remediation?.status ?? "debt_retired",
            closureAdjudicationSloDebtAgeHours: remediation?.debtAgeHours ?? 0,
            closureRebalanceSafeguardExpiryStatus: safeguardExpiry?.status ?? "expiry_pending",
            closureRebalanceSafeguardExpiryDebtHours: safeguardExpiry?.expiryDebtHours ?? 0,
            closureAdjudicationDebtBurndownStatus: debtBurndown?.status ?? "burndown_tracking",
            closureAdjudicationDebtBurndownForecastBreachHours:
              debtBurndown?.forecastBreachHours ?? 0,
            closureAdjudicationDebtBurndownVelocityPerDay: debtBurndown?.debtVelocityPerDay ?? 0,
            closureSafeguardExpiryAttestationStatus:
              safeguardAttestation?.status ?? "attestation_open",
            closureSafeguardExpiryAttestationBacklogHours:
              safeguardAttestation?.openBacklogHours ?? 0,
            closureBurndownRecalibrationStatus:
              burndownRecalibration?.status ?? "recalibration_pending",
            closureBurndownConfidenceDriftHours:
              burndownRecalibration?.confidenceDriftHours ?? 0,
            closureExpiryAttestationQueueStatus: expiryQueue?.status ?? "queue_open",
            closureExpiryAttestationQueueAgingHours: expiryQueue?.queueAgingHours ?? 0,
            closureExpiryAttestationQueueOpenExceptions: expiryQueue?.openExceptionCount ?? 0,
            closureBurndownSettlementStatus:
              burndownSettlement?.status ?? "settlement_pending",
            closureBurndownSettlementLatencyHours:
              burndownSettlement?.settlementLatencyHours ?? 0,
            closureExpiryAttestationQueueDrainStatus:
              expiryQueueDrain?.status ?? "drain_pending",
            closureExpiryAttestationQueueDrainThroughputPerDay:
              expiryQueueDrain?.drainThroughputPerDay ?? 0,
            closureSettlementAttestationStatus:
              settlementAttestation?.status ?? "verification_pending",
            closureSettlementVerificationLagHours:
              settlementAttestation?.settlementVerificationLagHours ?? 0,
            closureQueueDrainReconciliationStatus:
              queueDrainReconciliation?.status ?? "reconciliation_pending",
            closureQueueDrainReopenPressureCount:
              queueDrainReconciliation?.drainReopenPressureCount ?? 0,
            closureSettlementArbitrationStatus:
              settlementArbitration?.status ?? "arbitration_pending",
            closureSettlementArbitrationLeadTimeHours:
              settlementArbitration?.settlementArbitrationLeadTimeHours ?? 0,
            closureArbitrationRulingAgingHours:
              settlementArbitration?.arbitrationRulingAgingHours ?? 0,
            closureArbitrationPublicationExceptionBacklogCount:
              settlementArbitration?.arbitrationPublicationExceptionBacklogCount ?? 0,
            closureQueueReentryComplianceStatus:
              queueReentryCompliance?.status ?? "compliance_pending",
            closureQueueReentryExceptionDebtCount:
              queueReentryCompliance?.queueReentryExceptionDebtCount ?? 0,
            closureQueueReentryRetirementBurnCount:
              queueReentryCompliance?.queueReentryRetirementBurnCount ?? 0,
            closureQueueReentryRetirementReconciliationDriftCount:
              queueReentryCompliance?.queueReentryRetirementReconciliationDriftCount ?? 0,
            closureCriticalPath:
              (adjudication?.status === "panel_in_review" &&
                (adjudication.dissentNotes.length > 0 || adjudication.panelMemberIds.length < 2)) ||
              rebalance?.status === "throttle_active",
          }
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_sla_window_configs") {
      const ownerId = url.searchParams.get("ownerId")
      const scope = url.searchParams.get("scope")
      const rows = await repos.filingEscalationClosureSlaWindowConfigs.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (isFilingEscalationClosureSlaWindowScope(scope) ? row.scope === scope : true))
        .filter((row) => rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_auto_assignment_rules") {
      const ownerId = url.searchParams.get("ownerId")
      const mode = url.searchParams.get("mode")
      const rows = await repos.filingEscalationClosureAutoAssignmentRules.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (isFilingEscalationClosureAutoAssignmentMode(mode) ? row.mode === mode : true))
        .filter((row) => rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_sla_windows") {
      const ownerId = url.searchParams.get("ownerId")
      const packageId = url.searchParams.get("packageId")
      const windowStatus = url.searchParams.get("windowStatus")
      const pressureLevel = url.searchParams.get("pressureLevel")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const {
        digestByOwner,
        queueByOwner,
        slaWindowByOwner,
        exceptionDigestByOwner,
        attestationDisputeByOwner,
        exceptionEnforcementByOwner,
        adjudicationByOwner,
        rebalanceByOwner,
        adjudicationQuorumByOwner,
        rebalanceExecutionByOwner,
        adjudicationSloByOwner,
        rebalanceSafeguardByOwner,
        adjudicationSloDebtRemediationByOwner,
        rebalanceSafeguardExpiryByOwner,
        adjudicationDebtBurndownByOwner,
        safeguardExpiryAttestationByOwner,
        burndownRecalibrationByOwner,
        expiryAttestationQueueByOwner,
        burndownSettlementByOwner,
        expiryAttestationQueueDrainByOwner,
        settlementAttestationByOwner,
        queueDrainReconciliationByOwner,
        settlementArbitrationByOwner,
        queueReentryComplianceByOwner,
      } =
        await recomputeClosureComplianceState(
        store,
        repos,
        {
          firmId: user.firmId,
          packageById,
          now,
        }
        )
      const visible = [...slaWindowByOwner.values()]
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) =>
          isFilingEscalationClosureSlaWindowStatus(windowStatus) ? row.status === windowStatus : true
        )
        .filter((row) =>
          isFilingEscalationClosureSlaPressureLevel(pressureLevel)
            ? row.pressureLevel === pressureLevel
            : true
        )
        .filter((row) => {
          const digest = digestByOwner.get(row.ownerId)
          if (!digest) return false
          return packageId ? digest.linkedPackageIds.includes(packageId) : true
        })
        .filter((row) => {
          const digest = digestByOwner.get(row.ownerId)
          if (!digest) return false
          if (digest.linkedPackageIds.length === 0) return user.role === "partner"
          return digest.linkedPackageIds.some((pkgId) => {
            const filingPackage = packageById.get(pkgId)
            if (!filingPackage) return false
            const permission = checkPermission(store, user.id, "draft", filingPackage.matterId)
            if (!permission.allow) return false
            return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(filingPackage.classification)
          })
        })
        .map((row) => {
          const digest = digestByOwner.get(row.ownerId)
          const queue = queueByOwner.get(row.ownerId)
          const exceptionDigest = exceptionDigestByOwner.get(row.ownerId)
          const dispute = attestationDisputeByOwner.get(row.ownerId)
          const enforcement = exceptionEnforcementByOwner.get(row.ownerId)
          const adjudication = adjudicationByOwner.get(row.ownerId)
          const rebalance = rebalanceByOwner.get(row.ownerId)
          const quorum = adjudicationQuorumByOwner.get(row.ownerId)
          const execution = rebalanceExecutionByOwner.get(row.ownerId)
          const slo = adjudicationSloByOwner.get(row.ownerId)
          const safeguard = rebalanceSafeguardByOwner.get(row.ownerId)
          const remediation = adjudicationSloDebtRemediationByOwner.get(row.ownerId)
          const safeguardExpiry = rebalanceSafeguardExpiryByOwner.get(row.ownerId)
          const debtBurndown = adjudicationDebtBurndownByOwner.get(row.ownerId)
          const safeguardAttestation = safeguardExpiryAttestationByOwner.get(row.ownerId)
          const burndownRecalibration = burndownRecalibrationByOwner.get(row.ownerId)
          const expiryQueue = expiryAttestationQueueByOwner.get(row.ownerId)
          const burndownSettlement = burndownSettlementByOwner.get(row.ownerId)
          const expiryQueueDrain = expiryAttestationQueueDrainByOwner.get(row.ownerId)
          const settlementAttestation = settlementAttestationByOwner.get(row.ownerId)
          const queueDrainReconciliation = queueDrainReconciliationByOwner.get(row.ownerId)
          const settlementArbitration = settlementArbitrationByOwner.get(row.ownerId)
          const queueReentryCompliance = queueReentryComplianceByOwner.get(row.ownerId)
          return {
            ...row,
            digestId: digest?.id ?? null,
            queueId: queue?.id ?? null,
            packageIds: digest?.linkedPackageIds ?? [],
            assignedPartnerId: queue?.assignedPartnerId ?? null,
            queueStatus: queue?.status ?? "resolved",
            exceptionDigestStatus: exceptionDigest?.status ?? "cleared",
            exceptionDigestPressureLevel: exceptionDigest?.pressureLevel ?? "baseline",
            exceptionDigestReasons: exceptionDigest?.reasons ?? [],
            attestationDisputeStatus: dispute?.status ?? null,
            attestationDisputeConflictReason: dispute?.conflictReason ?? null,
            exceptionEnforcementStatus: enforcement?.status ?? "closed",
            exceptionReminderCount: enforcement?.reminderCount ?? 0,
            exceptionEscalationCount: enforcement?.escalationCount ?? 0,
            closureAdjudicationStatus: adjudication?.status ?? null,
            closureAdjudicationVerdict: adjudication?.verdict ?? null,
            closureEnforcementRebalanceStatus: rebalance?.status ?? "none",
            closureEnforcementRebalanceCooldownUntil: rebalance?.cooldownUntil ?? null,
            closureEnforcementRebalanceReopenThrottleUntil: rebalance?.reopenThrottleUntil ?? null,
            closureAdjudicationQuorumStatus: quorum?.status ?? null,
            closureAdjudicationBreachFlags: quorum?.breachFlags ?? [],
            closureAdjudicationThroughputScore:
              adjudication &&
              (adjudication.status === "resolved_upheld" || adjudication.status === "resolved_overturned")
                ? 1
                : 0,
            closureRebalanceExecutionStatus: execution?.status ?? null,
            closureRebalanceExecutionMode: execution?.mode ?? null,
            closureRebalanceChurnCount: execution?.churnCount ?? 0,
            closureAdjudicationSloStatus: slo?.status ?? null,
            closureAdjudicationSloEscalationTier: slo?.escalationTier ?? "none",
            closureAdjudicationSloDebtHours: slo?.breachDebtHours ?? 0,
            closureRebalanceSafeguardStatus: safeguard?.status ?? "auto_exec_ready",
            closureRebalanceAutoExecutionEligible: safeguard?.autoExecutionEligible ?? true,
            closureRebalanceSuppressionReasons: safeguard?.suppressionReasons ?? [],
            closureAdjudicationSloDebtRemediationStatus: remediation?.status ?? "debt_retired",
            closureAdjudicationSloDebtAgeHours: remediation?.debtAgeHours ?? 0,
            closureRebalanceSafeguardExpiryStatus: safeguardExpiry?.status ?? "expiry_pending",
            closureRebalanceSafeguardExpiryDebtHours: safeguardExpiry?.expiryDebtHours ?? 0,
            closureAdjudicationDebtBurndownStatus: debtBurndown?.status ?? "burndown_tracking",
            closureAdjudicationDebtBurndownForecastBreachHours:
              debtBurndown?.forecastBreachHours ?? 0,
            closureAdjudicationDebtBurndownVelocityPerDay: debtBurndown?.debtVelocityPerDay ?? 0,
            closureSafeguardExpiryAttestationStatus:
              safeguardAttestation?.status ?? "attestation_open",
            closureSafeguardExpiryAttestationBacklogHours:
              safeguardAttestation?.openBacklogHours ?? 0,
            closureBurndownRecalibrationStatus:
              burndownRecalibration?.status ?? "recalibration_pending",
            closureBurndownConfidenceDriftHours:
              burndownRecalibration?.confidenceDriftHours ?? 0,
            closureExpiryAttestationQueueStatus: expiryQueue?.status ?? "queue_open",
            closureExpiryAttestationQueueAgingHours: expiryQueue?.queueAgingHours ?? 0,
            closureExpiryAttestationQueueOpenExceptions: expiryQueue?.openExceptionCount ?? 0,
            closureBurndownSettlementStatus:
              burndownSettlement?.status ?? "settlement_pending",
            closureBurndownSettlementLatencyHours:
              burndownSettlement?.settlementLatencyHours ?? 0,
            closureExpiryAttestationQueueDrainStatus:
              expiryQueueDrain?.status ?? "drain_pending",
            closureExpiryAttestationQueueDrainThroughputPerDay:
              expiryQueueDrain?.drainThroughputPerDay ?? 0,
            closureSettlementAttestationStatus:
              settlementAttestation?.status ?? "verification_pending",
            closureSettlementVerificationLagHours:
              settlementAttestation?.settlementVerificationLagHours ?? 0,
            closureQueueDrainReconciliationStatus:
              queueDrainReconciliation?.status ?? "reconciliation_pending",
            closureQueueDrainReopenPressureCount:
              queueDrainReconciliation?.drainReopenPressureCount ?? 0,
            closureSettlementArbitrationStatus:
              settlementArbitration?.status ?? "arbitration_pending",
            closureSettlementArbitrationLeadTimeHours:
              settlementArbitration?.settlementArbitrationLeadTimeHours ?? 0,
            closureArbitrationRulingAgingHours:
              settlementArbitration?.arbitrationRulingAgingHours ?? 0,
            closureArbitrationPublicationExceptionBacklogCount:
              settlementArbitration?.arbitrationPublicationExceptionBacklogCount ?? 0,
            closureQueueReentryComplianceStatus:
              queueReentryCompliance?.status ?? "compliance_pending",
            closureQueueReentryExceptionDebtCount:
              queueReentryCompliance?.queueReentryExceptionDebtCount ?? 0,
            closureQueueReentryRetirementBurnCount:
              queueReentryCompliance?.queueReentryRetirementBurnCount ?? 0,
            closureQueueReentryRetirementReconciliationDriftCount:
              queueReentryCompliance?.queueReentryRetirementReconciliationDriftCount ?? 0,
            closureCriticalPath:
              (adjudication?.status === "panel_in_review" &&
                (adjudication.dissentNotes.length > 0 || adjudication.panelMemberIds.length < 2)) ||
              rebalance?.status === "throttle_active",
          }
        })
        .sort((a, b) => {
          const aDeadline = a.autoEscalateAt ?? a.clearDeadlineAt ?? a.ackDeadlineAt ?? 0
          const bDeadline = b.autoEscalateAt ?? b.clearDeadlineAt ?? b.ackDeadlineAt ?? 0
          return aDeadline - bDeadline || a.id.localeCompare(b.id)
        })
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_attestations") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const packageId = url.searchParams.get("packageId")
      const attestationStatus = url.searchParams.get("attestationStatus")
      const rows = await repos.filingEscalationClosureAttestations.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) =>
          isFilingEscalationClosureAttestationStatus(attestationStatus)
            ? row.status === attestationStatus
            : true
        )
        .filter((row) => (packageId ? row.packageIds.includes(packageId) : true))
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => firmPackages.find((item) => item.id === pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_sla_exception_digests") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const packageId = url.searchParams.get("packageId")
      const exceptionStatus = url.searchParams.get("exceptionStatus")
      const pressureLevel = url.searchParams.get("pressureLevel")
      const reason = url.searchParams.get("reason")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const { exceptionDigestByOwner } = await recomputeClosureComplianceState(store, repos, {
        firmId: user.firmId,
        packageById,
        now,
      })
      const rows = [...exceptionDigestByOwner.values()]
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) =>
          isFilingEscalationClosureSlaExceptionStatus(exceptionStatus)
            ? row.status === exceptionStatus
            : true
        )
        .filter((row) =>
          isFilingEscalationClosureSlaPressureLevel(pressureLevel)
            ? row.pressureLevel === pressureLevel
            : true
        )
        .filter((row) =>
          reason && isFilingEscalationClosureSlaExceptionReason(reason)
            ? row.reasons.includes(reason)
            : true
        )
        .map((row) => store.filingEscalationClosureSlaExceptionDigests.get(row.id) ?? null)
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (packageId ? row.packageIds.includes(packageId) : true))
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_attestation_disputes") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const attestationId = url.searchParams.get("attestationId")
      const disputeStatus = url.searchParams.get("disputeStatus")
      const rows = await repos.filingEscalationClosureAttestationDisputes.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (attestationId ? row.attestationId === attestationId : true))
        .filter((row) =>
          isFilingEscalationClosureAttestationDisputeStatus(disputeStatus)
            ? row.status === disputeStatus
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_sla_exception_enforcement") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const enforcementStatus = url.searchParams.get("enforcementStatus")
      const rows = await repos.filingEscalationClosureSlaExceptionEnforcement.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) =>
          isFilingEscalationClosureSlaExceptionEnforcementStatus(enforcementStatus)
            ? row.status === enforcementStatus
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => {
          const aDue = a.waiverExpiresAt ?? Number.MAX_SAFE_INTEGER
          const bDue = b.waiverExpiresAt ?? Number.MAX_SAFE_INTEGER
          return aDue - bDue || a.id.localeCompare(b.id)
        })
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_adjudication_queue") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const disputeId = url.searchParams.get("disputeId")
      const adjudicationStatus = url.searchParams.get("adjudicationStatus")
      const rows = await repos.filingEscalationClosureAdjudicationQueue.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (disputeId ? row.disputeId === disputeId : true))
        .filter((row) =>
          isFilingEscalationClosureAdjudicationStatus(adjudicationStatus)
            ? row.status === adjudicationStatus
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_enforcement_rebalance") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const rebalanceStatus = url.searchParams.get("rebalanceStatus")
      const rows = await repos.filingEscalationClosureEnforcementRebalance.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) =>
          isFilingEscalationClosureEnforcementRebalanceStatus(rebalanceStatus)
            ? row.status === rebalanceStatus
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_adjudication_quorum") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const adjudicationId = url.searchParams.get("adjudicationId")
      const quorumStatus = url.searchParams.get("quorumStatus")
      const rows = await repos.filingEscalationClosureAdjudicationQuorum.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (adjudicationId ? row.adjudicationId === adjudicationId : true))
        .filter((row) =>
          isFilingEscalationClosureAdjudicationQuorumStatus(quorumStatus)
            ? row.status === quorumStatus
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_rebalance_execution") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const rebalanceId = url.searchParams.get("rebalanceId")
      const executionStatus = url.searchParams.get("executionStatus")
      const mode = url.searchParams.get("mode")
      const rows = await repos.filingEscalationClosureRebalanceExecution.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (rebalanceId ? row.rebalanceId === rebalanceId : true))
        .filter((row) =>
          isFilingEscalationClosureRebalanceExecutionStatus(executionStatus)
            ? row.status === executionStatus
            : true
        )
        .filter((row) =>
          isFilingEscalationClosureRebalanceExecutionMode(mode) ? row.mode === mode : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_adjudication_slo") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const adjudicationId = url.searchParams.get("adjudicationId")
      const sloStatus = url.searchParams.get("sloStatus")
      const escalationTier = url.searchParams.get("escalationTier")
      const rows = await repos.filingEscalationClosureAdjudicationSlo.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (adjudicationId ? row.adjudicationId === adjudicationId : true))
        .filter((row) =>
          isFilingEscalationClosureAdjudicationSloStatus(sloStatus) ? row.status === sloStatus : true
        )
        .filter((row) =>
          isFilingEscalationClosureAdjudicationSloEscalationTier(escalationTier)
            ? row.escalationTier === escalationTier
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_rebalance_safeguards") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const rebalanceId = url.searchParams.get("rebalanceId")
      const safeguardStatus = url.searchParams.get("safeguardStatus")
      const suppressionReason = url.searchParams.get("suppressionReason")
      const rows = await repos.filingEscalationClosureRebalanceSafeguards.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (rebalanceId ? row.rebalanceId === rebalanceId : true))
        .filter((row) =>
          isFilingEscalationClosureRebalanceSafeguardStatus(safeguardStatus)
            ? row.status === safeguardStatus
            : true
        )
        .filter((row) =>
          suppressionReason && isFilingEscalationClosureRebalanceSuppressionReason(suppressionReason)
            ? row.suppressionReasons.includes(suppressionReason)
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_adjudication_slo_debt_remediation") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const adjudicationId = url.searchParams.get("adjudicationId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureAdjudicationSloDebtRemediation.listByFirm(
        user.firmId
      )
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (adjudicationId ? row.adjudicationId === adjudicationId : true))
        .filter((row) =>
          isFilingEscalationClosureAdjudicationSloDebtRemediationStatus(status)
            ? row.status === status
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_rebalance_safeguard_expiry") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const rebalanceId = url.searchParams.get("rebalanceId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureRebalanceSafeguardExpiry.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (rebalanceId ? row.rebalanceId === rebalanceId : true))
        .filter((row) =>
          isFilingEscalationClosureRebalanceSafeguardExpiryStatus(status)
            ? row.status === status
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_adjudication_debt_burndown") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const adjudicationId = url.searchParams.get("adjudicationId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureAdjudicationDebtBurndown.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (adjudicationId ? row.adjudicationId === adjudicationId : true))
        .filter((row) =>
          isFilingEscalationClosureAdjudicationDebtBurndownStatus(status)
            ? row.status === status
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_safeguard_expiry_attestations") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const rebalanceId = url.searchParams.get("rebalanceId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureSafeguardExpiryAttestations.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (rebalanceId ? row.rebalanceId === rebalanceId : true))
        .filter((row) =>
          isFilingEscalationClosureSafeguardExpiryAttestationStatus(status)
            ? row.status === status
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_burndown_recalibration") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const adjudicationId = url.searchParams.get("adjudicationId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureBurndownRecalibration.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (adjudicationId ? row.adjudicationId === adjudicationId : true))
        .filter((row) =>
          isFilingEscalationClosureBurndownRecalibrationStatus(status) ? row.status === status : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_expiry_attestation_queue") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const rebalanceId = url.searchParams.get("rebalanceId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureExpiryAttestationQueue.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (rebalanceId ? row.rebalanceId === rebalanceId : true))
        .filter((row) =>
          isFilingEscalationClosureExpiryAttestationQueueStatus(status) ? row.status === status : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_burndown_settlement") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const adjudicationId = url.searchParams.get("adjudicationId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureBurndownSettlement.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (adjudicationId ? row.adjudicationId === adjudicationId : true))
        .filter((row) =>
          isFilingEscalationClosureBurndownSettlementStatus(status) ? row.status === status : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_expiry_attestation_queue_drain") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const rebalanceId = url.searchParams.get("rebalanceId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureExpiryAttestationQueueDrain.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (rebalanceId ? row.rebalanceId === rebalanceId : true))
        .filter((row) =>
          isFilingEscalationClosureExpiryAttestationQueueDrainStatus(status)
            ? row.status === status
            : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_settlement_attestation") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const adjudicationId = url.searchParams.get("adjudicationId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureSettlementAttestation.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (adjudicationId ? row.adjudicationId === adjudicationId : true))
        .filter((row) =>
          isFilingEscalationClosureSettlementAttestationStatus(status) ? row.status === status : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_queue_drain_reconciliation") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const rebalanceId = url.searchParams.get("rebalanceId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureQueueDrainReconciliation.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (rebalanceId ? row.rebalanceId === rebalanceId : true))
        .filter((row) =>
          isFilingEscalationClosureQueueDrainReconciliationStatus(status) ? row.status === status : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_settlement_arbitration") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const adjudicationId = url.searchParams.get("adjudicationId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureSettlementArbitration.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (adjudicationId ? row.adjudicationId === adjudicationId : true))
        .filter((row) =>
          isFilingEscalationClosureSettlementArbitrationStatus(status) ? row.status === status : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "closure_queue_reentry_compliance") {
      const ownerId = url.searchParams.get("ownerId")
      const queueId = url.searchParams.get("queueId")
      const rebalanceId = url.searchParams.get("rebalanceId")
      const status = url.searchParams.get("status")
      const rows = await repos.filingEscalationClosureQueueReentryCompliance.listByFirm(user.firmId)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const visible = rows
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => (queueId ? row.queueId === queueId : true))
        .filter((row) => (rebalanceId ? row.rebalanceId === rebalanceId : true))
        .filter((row) =>
          isFilingEscalationClosureQueueReentryComplianceStatus(status) ? row.status === status : true
        )
        .filter((row) =>
          closureRowVisible(store, user, row.packageIds, (pkgId) => packageById.get(pkgId))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "escalation_workload_digests") {
      const packageId = url.searchParams.get("packageId")
      const ownerId = url.searchParams.get("ownerId")
      const workloadStatus = url.searchParams.get("workloadStatus")
      const reason = url.searchParams.get("reason")
      const handoffLagBucket = url.searchParams.get("handoffLagBucket")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const {
        queueByOwner: closureQueueByOwner,
        slaWindowByOwner,
        exceptionDigestByOwner,
        attestationDisputeByOwner,
        exceptionEnforcementByOwner,
        adjudicationByOwner,
        rebalanceByOwner,
        adjudicationQuorumByOwner,
        rebalanceExecutionByOwner,
        adjudicationSloByOwner,
        rebalanceSafeguardByOwner,
        adjudicationSloDebtRemediationByOwner,
        rebalanceSafeguardExpiryByOwner,
        adjudicationDebtBurndownByOwner,
        safeguardExpiryAttestationByOwner,
        burndownRecalibrationByOwner,
        expiryAttestationQueueByOwner,
        burndownSettlementByOwner,
        expiryAttestationQueueDrainByOwner,
        settlementAttestationByOwner,
        queueDrainReconciliationByOwner,
        settlementArbitrationByOwner,
        queueReentryComplianceByOwner,
      } =
        await recomputeClosureComplianceState(store, repos, {
          firmId: user.firmId,
          packageById,
          now,
        })
      const rotaRows = await repos.filingEscalationOwnerRota.listByFirm(user.firmId)
      const rotaByPackage = new Map(rotaRows.map((row) => [row.packageId, row]))
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(rotaRows)
      const slaRows = await repos.filingSubmissionSlaDigests.listByFirm(user.firmId)
      const slaByPackage = new Map(slaRows.map((row) => [row.packageId, row]))
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides: policyOverridesByPackage } =
        buildEscalationPolicyMaps(policyRows)
      const waiverRows = await repos.filingEscalationBreachWaivers.listByFirm(user.firmId)
      const activeWaiverByPackage = new Map<string, (typeof waiverRows)[number]>()
      for (const row of waiverRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = {
            ...row,
            status: "expired" as const,
            updatedAt: now,
          }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
          continue
        }
        if (row.status !== "active" || row.expiresAt <= now) continue
        const current = activeWaiverByPackage.get(row.packageId)
        if (!current || row.updatedAt > current.updatedAt) {
          activeWaiverByPackage.set(row.packageId, row)
        }
      }
      const policyVarianceRows = await repos.filingEscalationPolicyVarianceDigests.listByFirm(user.firmId)
      const policyVarianceByPackage = new Map(policyVarianceRows.map((row) => [row.packageId, row]))
      const waiverExpiryRows = await repos.filingEscalationWaiverExpiryDigests.listByFirm(user.firmId)
      const waiverExpiryByPackage = new Map(waiverExpiryRows.map((row) => [row.packageId, row]))
      const remediationExpiryRows = await repos.filingEscalationRemediationExpiryDigests.listByFirm(
        user.firmId
      )
      const remediationExpiryByPackage = new Map(
        remediationExpiryRows.map((row) => [row.packageId, row])
      )
      const rolloverWatchRows = await repos.filingEscalationRolloverBreachWatches.listByFirm(user.firmId)
      const rolloverWatchByPackage = new Map(rolloverWatchRows.map((row) => [row.packageId, row]))
      const remediationRows = await repos.filingEscalationVarianceRemediations.listByFirm(user.firmId)
      for (const row of remediationRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationVarianceRemediations.upsert(expired)
          store.filingEscalationVarianceRemediations.set(expired.id, expired)
        }
      }
      const activeRemediationByPackage = latestActiveRemediationByPackage(
        await repos.filingEscalationVarianceRemediations.listByFirm(user.firmId),
        now
      )
      const lifecycleRows = await repos.filingEscalationRemediationLifecycles.listByFirm(user.firmId)
      const openLifecycleByPackage = latestOpenRemediationLifecycleByPackage(lifecycleRows)
      const rolloverRows = await repos.filingEscalationWaiverRolloverAttestations.listByFirm(user.firmId)
      const rolloverByWaiverId = latestRolloverAttestationByWaiver(rolloverRows)
      const reaffirmationRows = await repos.filingEscalationRolloverReaffirmationSlas.listByFirm(
        user.firmId
      )
      const reaffirmationByPackage = new Map(reaffirmationRows.map((row) => [row.packageId, row]))
      const persistedRows = await repos.filingEscalationWorkloadDigests.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...rotaByPackage.keys(),
        ...slaByPackage.keys(),
        ...policyOverridesByPackage.keys(),
        ...activeWaiverByPackage.keys(),
        ...policyVarianceByPackage.keys(),
        ...waiverExpiryByPackage.keys(),
        ...activeRemediationByPackage.keys(),
        ...remediationExpiryByPackage.keys(),
        ...rolloverWatchByPackage.keys(),
        ...openLifecycleByPackage.keys(),
        ...reaffirmationByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const rota = rotaByPackage.get(pkgId) ?? null
        const slaDigest = slaByPackage.get(pkgId) ?? null
        const existing = rowsByPackage.get(pkgId) ?? null
        if (!rota && !slaDigest && !existing) continue
        const ownerLoadCount =
          rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
        const policy = resolveEffectiveEscalationPolicy(
          pkgId,
          policyOverridesByPackage,
          defaultPolicy
        )
        const activeWaiver = activeWaiverByPackage.get(pkgId) ?? null
        const defaultPolicyRow =
          policyRows.find((row) => row.id === defaultPolicy?.id) ?? null
        const packagePolicyRow = latestByUpdatedAt(
          policyRows.filter((row) => row.scope === "package_override" && row.packageId === pkgId)
        )
        const existingPolicyVariance = policyVarianceByPackage.get(pkgId) ?? null
        const computedPolicyVariance = buildFilingEscalationPolicyVarianceDigestRow(filingPackage, {
          firmDefaultPolicy: defaultPolicyRow,
          packagePolicy: packagePolicyRow,
          existing: existingPolicyVariance,
          now,
        })
        const policyVarianceChanged =
          !existingPolicyVariance ||
          existingPolicyVariance.status !== computedPolicyVariance.status ||
          existingPolicyVariance.firmDefaultPolicyId !== computedPolicyVariance.firmDefaultPolicyId ||
          existingPolicyVariance.packagePolicyId !== computedPolicyVariance.packagePolicyId ||
          existingPolicyVariance.ownerLoadThresholdDefault !==
            computedPolicyVariance.ownerLoadThresholdDefault ||
          existingPolicyVariance.ownerLoadThresholdEffective !==
            computedPolicyVariance.ownerLoadThresholdEffective ||
          existingPolicyVariance.handoffSlaMsDefault !== computedPolicyVariance.handoffSlaMsDefault ||
          existingPolicyVariance.handoffSlaMsEffective !== computedPolicyVariance.handoffSlaMsEffective ||
          existingPolicyVariance.waiverWindowMsDefault !== computedPolicyVariance.waiverWindowMsDefault ||
          existingPolicyVariance.waiverWindowMsEffective !== computedPolicyVariance.waiverWindowMsEffective ||
          existingPolicyVariance.snoozeUntil !== computedPolicyVariance.snoozeUntil ||
          JSON.stringify(existingPolicyVariance.varianceReasons) !==
            JSON.stringify(computedPolicyVariance.varianceReasons)
        const nextPolicyVariance = policyVarianceChanged ? computedPolicyVariance : existingPolicyVariance
        if (policyVarianceChanged && nextPolicyVariance) {
          await repos.filingEscalationPolicyVarianceDigests.upsert(nextPolicyVariance)
        }
        if (nextPolicyVariance) {
          store.filingEscalationPolicyVarianceDigests.set(nextPolicyVariance.id, nextPolicyVariance)
          policyVarianceByPackage.set(pkgId, nextPolicyVariance)
        }
        const existingWaiverExpiry = waiverExpiryByPackage.get(pkgId) ?? null
        const computedWaiverExpiry = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
          activeWaiver,
          linkedPolicyId: policy.sourcePolicyId,
          existing: existingWaiverExpiry,
          now,
        })
        const waiverExpiryChanged =
          !existingWaiverExpiry ||
          existingWaiverExpiry.status !== computedWaiverExpiry.status ||
          existingWaiverExpiry.linkedWaiverId !== computedWaiverExpiry.linkedWaiverId ||
          existingWaiverExpiry.linkedPolicyId !== computedWaiverExpiry.linkedPolicyId ||
          existingWaiverExpiry.waiverExpiresAt !== computedWaiverExpiry.waiverExpiresAt ||
          existingWaiverExpiry.msUntilExpiry !== computedWaiverExpiry.msUntilExpiry ||
          JSON.stringify(existingWaiverExpiry.reasons) !== JSON.stringify(computedWaiverExpiry.reasons)
        const nextWaiverExpiry = waiverExpiryChanged ? computedWaiverExpiry : existingWaiverExpiry
        if (waiverExpiryChanged && nextWaiverExpiry) {
          await repos.filingEscalationWaiverExpiryDigests.upsert(nextWaiverExpiry)
        }
        if (nextWaiverExpiry) {
          store.filingEscalationWaiverExpiryDigests.set(nextWaiverExpiry.id, nextWaiverExpiry)
          waiverExpiryByPackage.set(pkgId, nextWaiverExpiry)
        }
        const activeRemediation = activeRemediationByPackage.get(pkgId) ?? null
        const existingRemediationExpiry = remediationExpiryByPackage.get(pkgId) ?? null
        const computedRemediationExpiry = buildFilingEscalationRemediationExpiryDigestRow(
          filingPackage,
          {
            activeRemediation,
            pendingClosureLifecycle: openLifecycleByPackage.get(pkgId) ?? null,
            linkedPolicyId: policy.sourcePolicyId,
            existing: existingRemediationExpiry,
            now,
          }
        )
        const remediationExpiryChanged =
          !existingRemediationExpiry ||
          existingRemediationExpiry.status !== computedRemediationExpiry.status ||
          existingRemediationExpiry.linkedRemediationId !== computedRemediationExpiry.linkedRemediationId ||
          existingRemediationExpiry.linkedLifecycleId !== computedRemediationExpiry.linkedLifecycleId ||
          existingRemediationExpiry.linkedPolicyVarianceDigestId !==
            computedRemediationExpiry.linkedPolicyVarianceDigestId ||
          existingRemediationExpiry.linkedPolicyId !== computedRemediationExpiry.linkedPolicyId ||
          existingRemediationExpiry.remediationExpiresAt !==
            computedRemediationExpiry.remediationExpiresAt ||
          existingRemediationExpiry.msUntilExpiry !== computedRemediationExpiry.msUntilExpiry ||
          existingRemediationExpiry.snoozeUntil !== computedRemediationExpiry.snoozeUntil ||
          JSON.stringify(existingRemediationExpiry.reasons) !==
            JSON.stringify(computedRemediationExpiry.reasons)
        const nextRemediationExpiry = remediationExpiryChanged
          ? computedRemediationExpiry
          : existingRemediationExpiry
        if (remediationExpiryChanged && nextRemediationExpiry) {
          await repos.filingEscalationRemediationExpiryDigests.upsert(nextRemediationExpiry)
        }
        if (nextRemediationExpiry) {
          store.filingEscalationRemediationExpiryDigests.set(
            nextRemediationExpiry.id,
            nextRemediationExpiry
          )
          remediationExpiryByPackage.set(pkgId, nextRemediationExpiry)
        }
        const activeWaiverPolicyCapExpiresAt = activeWaiver
          ? activeWaiver.grantedAt + policy.waiverWindowMs
          : null
        const latestRolloverAttestation = activeWaiver
          ? rolloverByWaiverId.get(activeWaiver.id) ?? null
          : null
        const reaffirmationWarningThresholdMs = Math.max(HOUR_MS, Math.floor(policy.waiverWindowMs / 2))
        const reaffirmationBreachThresholdMs = Math.max(2 * HOUR_MS, policy.waiverWindowMs)
        const existingReaffirmation = reaffirmationByPackage.get(pkgId) ?? null
        const computedReaffirmation = buildFilingEscalationRolloverReaffirmationSlaRow(filingPackage, {
          activeWaiver,
          policyCapExpiresAt: activeWaiverPolicyCapExpiresAt,
          latestAttestation: latestRolloverAttestation,
          linkedPolicyId: policy.sourcePolicyId,
          warningThresholdMs: reaffirmationWarningThresholdMs,
          breachThresholdMs: reaffirmationBreachThresholdMs,
          existing: existingReaffirmation,
          now,
        })
        const reaffirmationChanged =
          !existingReaffirmation ||
          existingReaffirmation.status !== computedReaffirmation.status ||
          existingReaffirmation.linkedWaiverId !== computedReaffirmation.linkedWaiverId ||
          existingReaffirmation.linkedAttestationId !== computedReaffirmation.linkedAttestationId ||
          existingReaffirmation.linkedPolicyId !== computedReaffirmation.linkedPolicyId ||
          existingReaffirmation.policyCapExpiresAt !== computedReaffirmation.policyCapExpiresAt ||
          existingReaffirmation.waiverExpiresAt !== computedReaffirmation.waiverExpiresAt ||
          existingReaffirmation.lastReaffirmedAt !== computedReaffirmation.lastReaffirmedAt ||
          existingReaffirmation.elapsedSinceReaffirmationMs !==
            computedReaffirmation.elapsedSinceReaffirmationMs ||
          existingReaffirmation.warningThresholdMs !== computedReaffirmation.warningThresholdMs ||
          existingReaffirmation.breachThresholdMs !== computedReaffirmation.breachThresholdMs ||
          JSON.stringify(existingReaffirmation.reasons) !== JSON.stringify(computedReaffirmation.reasons)
        const nextReaffirmation = reaffirmationChanged ? computedReaffirmation : existingReaffirmation
        if (reaffirmationChanged && nextReaffirmation) {
          await repos.filingEscalationRolloverReaffirmationSlas.upsert(nextReaffirmation)
        }
        if (nextReaffirmation) {
          store.filingEscalationRolloverReaffirmationSlas.set(nextReaffirmation.id, nextReaffirmation)
          reaffirmationByPackage.set(pkgId, nextReaffirmation)
        }
        const existingRolloverWatch = rolloverWatchByPackage.get(pkgId) ?? null
        const computedRolloverWatch = buildFilingEscalationRolloverBreachWatchRow(filingPackage, {
          activeWaiver,
          policyCapExpiresAt: activeWaiverPolicyCapExpiresAt,
          latestAttestation: latestRolloverAttestation,
          linkedPolicyId: policy.sourcePolicyId,
          existing: existingRolloverWatch,
          now,
        })
        const rolloverWatchChanged =
          !existingRolloverWatch ||
          existingRolloverWatch.status !== computedRolloverWatch.status ||
          existingRolloverWatch.linkedWaiverId !== computedRolloverWatch.linkedWaiverId ||
          existingRolloverWatch.linkedAttestationId !== computedRolloverWatch.linkedAttestationId ||
          existingRolloverWatch.linkedPolicyId !== computedRolloverWatch.linkedPolicyId ||
          existingRolloverWatch.policyCapExpiresAt !== computedRolloverWatch.policyCapExpiresAt ||
          existingRolloverWatch.waiverExpiresAt !== computedRolloverWatch.waiverExpiresAt ||
          existingRolloverWatch.attestationUpdatedAt !== computedRolloverWatch.attestationUpdatedAt ||
          JSON.stringify(existingRolloverWatch.reasons) !==
            JSON.stringify(computedRolloverWatch.reasons)
        const nextRolloverWatch = rolloverWatchChanged
          ? computedRolloverWatch
          : existingRolloverWatch
        if (rolloverWatchChanged && nextRolloverWatch) {
          await repos.filingEscalationRolloverBreachWatches.upsert(nextRolloverWatch)
        }
        if (nextRolloverWatch) {
          store.filingEscalationRolloverBreachWatches.set(nextRolloverWatch.id, nextRolloverWatch)
          rolloverWatchByPackage.set(pkgId, nextRolloverWatch)
        }
        const computedBase = buildFilingEscalationWorkloadDigestRow(filingPackage, {
          rota,
          slaDigest,
          ownerLoadCount,
          ownerLoadThreshold: policy.ownerLoadThreshold,
          handoffSlaMs: policy.handoffSlaMs,
          now,
          existing,
        })
        const ownerClosureQueue = rota?.primaryOwnerId
          ? closureQueueByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerClosureSlaWindow = rota?.primaryOwnerId
          ? slaWindowByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerClosureException = rota?.primaryOwnerId
          ? exceptionDigestByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerClosureDispute = rota?.primaryOwnerId
          ? attestationDisputeByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerExceptionEnforcement = rota?.primaryOwnerId
          ? exceptionEnforcementByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerAdjudication = rota?.primaryOwnerId
          ? adjudicationByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerRebalance = rota?.primaryOwnerId
          ? rebalanceByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerAdjudicationQuorum = rota?.primaryOwnerId
          ? adjudicationQuorumByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerRebalanceExecution = rota?.primaryOwnerId
          ? rebalanceExecutionByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerAdjudicationSlo = rota?.primaryOwnerId
          ? adjudicationSloByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerRebalanceSafeguard = rota?.primaryOwnerId
          ? rebalanceSafeguardByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerSloDebtRemediation = rota?.primaryOwnerId
          ? adjudicationSloDebtRemediationByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerSafeguardExpiry = rota?.primaryOwnerId
          ? rebalanceSafeguardExpiryByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerDebtBurndown = rota?.primaryOwnerId
          ? adjudicationDebtBurndownByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerSafeguardAttestation = rota?.primaryOwnerId
          ? safeguardExpiryAttestationByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerBurndownRecalibration = rota?.primaryOwnerId
          ? burndownRecalibrationByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerExpiryAttestationQueue = rota?.primaryOwnerId
          ? expiryAttestationQueueByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerBurndownSettlement = rota?.primaryOwnerId
          ? burndownSettlementByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerExpiryAttestationQueueDrain = rota?.primaryOwnerId
          ? expiryAttestationQueueDrainByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerSettlementAttestation = rota?.primaryOwnerId
          ? settlementAttestationByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerQueueDrainReconciliation = rota?.primaryOwnerId
          ? queueDrainReconciliationByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerSettlementArbitration = rota?.primaryOwnerId
          ? settlementArbitrationByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const ownerQueueReentryCompliance = rota?.primaryOwnerId
          ? queueReentryComplianceByOwner.get(rota.primaryOwnerId) ?? null
          : null
        const closureQueueElevated =
          !!ownerClosureQueue &&
          ownerClosureQueue.status !== "resolved" &&
          (ownerClosureQueue.pendingLifecycleCount > 0 ||
            ownerClosureQueue.breachedReaffirmationCount > 0)
        const closureSlaElevated =
          !!ownerClosureSlaWindow &&
          ownerClosureSlaWindow.status !== "cleared" &&
          (ownerClosureSlaWindow.pressureLevel === "elevated" ||
            ownerClosureSlaWindow.pressureLevel === "critical")
        const closureSlaCritical =
          !!ownerClosureSlaWindow &&
          ownerClosureSlaWindow.status !== "cleared" &&
          ownerClosureSlaWindow.pressureLevel === "critical"
        const closureExceptionElevated =
          !!ownerClosureException &&
          ownerClosureException.status !== "cleared" &&
          (ownerClosureException.pressureLevel === "elevated" ||
            ownerClosureException.pressureLevel === "critical")
        const closureExceptionCritical =
          !!ownerClosureException &&
          ownerClosureException.status !== "cleared" &&
          (ownerClosureException.pressureLevel === "critical" ||
            ownerClosureException.status === "expired" ||
            ownerClosureException.reasons.includes("attestation_rejected"))
        const closureDisputeElevated =
          !!ownerClosureDispute &&
          (ownerClosureDispute.status === "open_dispute" ||
            ownerClosureDispute.status === "under_review")
        const closureDisputeCritical =
          !!ownerClosureDispute && ownerClosureDispute.status === "open_dispute"
        const exceptionEnforcementElevated =
          !!ownerExceptionEnforcement &&
          (ownerExceptionEnforcement.status === "reminder_sent" ||
            ownerExceptionEnforcement.status === "escalated")
        const exceptionEnforcementCritical =
          !!ownerExceptionEnforcement && ownerExceptionEnforcement.status === "escalated"
        const adjudicationBacklogCritical =
          !!ownerAdjudication &&
          ownerAdjudication.status === "panel_in_review" &&
          (ownerAdjudication.panelMemberIds.length < 2 || ownerAdjudication.dissentNotes.length > 0)
        const adjudicationBacklogElevated =
          !!ownerAdjudication &&
          (ownerAdjudication.status === "pending_panel_assignment" ||
            ownerAdjudication.status === "panel_in_review")
        const rebalancePressureCritical =
          !!ownerRebalance && ownerRebalance.status === "throttle_active"
        const rebalancePressureElevated =
          !!ownerRebalance &&
          (ownerRebalance.status === "cooldown_scheduled" ||
            ownerRebalance.status === "owner_reassignment_recommended")
        const quorumBreachCritical =
          !!ownerAdjudicationQuorum &&
          (ownerAdjudicationQuorum.status === "verdict_overdue" ||
            ownerAdjudicationQuorum.breachFlags.includes("quorum_unmet"))
        const quorumBreachElevated =
          !!ownerAdjudicationQuorum &&
          ownerAdjudicationQuorum.status !== "closed" &&
          (ownerAdjudicationQuorum.breachFlags.length > 0 ||
            ownerAdjudicationQuorum.status === "quorum_pending")
        const executionChurnCritical =
          !!ownerRebalanceExecution && ownerRebalanceExecution.churnCount >= 4
        const executionChurnElevated =
          !!ownerRebalanceExecution && ownerRebalanceExecution.churnCount >= 2
        const sloDebtCritical =
          !!ownerAdjudicationSlo &&
          (ownerAdjudicationSlo.breachDebtHours >= 8 ||
            ownerAdjudicationSlo.escalationTier === "tier_2_management_escalation" ||
            ownerAdjudicationSlo.escalationTier === "tier_3_executive_escalation")
        const sloDebtElevated =
          !!ownerAdjudicationSlo &&
          (ownerAdjudicationSlo.breachDebtHours > 0 ||
            ownerAdjudicationSlo.status === "breach_open" ||
            ownerAdjudicationSlo.status === "breach_acknowledged")
        const safeguardSuppressionCritical =
          !!ownerRebalanceSafeguard &&
          ownerRebalanceSafeguard.status === "duplicate_suppressed"
        const safeguardSuppressionElevated =
          !!ownerRebalanceSafeguard &&
          (ownerRebalanceSafeguard.status === "cooldown_locked" ||
            ownerRebalanceSafeguard.status === "duplicate_suppressed")
        const remediationDebtCritical =
          !!ownerSloDebtRemediation &&
          (ownerSloDebtRemediation.status === "debt_open" && ownerSloDebtRemediation.debtAgeHours >= 12)
        const remediationDebtElevated =
          !!ownerSloDebtRemediation &&
          (ownerSloDebtRemediation.status === "debt_open" ||
            ownerSloDebtRemediation.status === "debt_retirement_pending")
        const safeguardExpiryCritical =
          !!ownerSafeguardExpiry &&
          (ownerSafeguardExpiry.status === "override_expired" ||
            (ownerSafeguardExpiry.status === "expiry_pending" &&
              ownerSafeguardExpiry.expiryDebtHours >= 4))
        const safeguardExpiryElevated =
          !!ownerSafeguardExpiry &&
          (ownerSafeguardExpiry.status === "override_expired" ||
            ownerSafeguardExpiry.status === "stale_lock_cleaned" ||
            ownerSafeguardExpiry.expiryDebtHours > 0)
        const debtBurndownCritical =
          !!ownerDebtBurndown && ownerDebtBurndown.status === "burndown_forecast_breached"
        const debtBurndownElevated =
          !!ownerDebtBurndown &&
          (ownerDebtBurndown.status === "burndown_checkpoint_due" ||
            ownerDebtBurndown.status === "burndown_forecast_breached")
        const expiryAttestationCritical =
          !!ownerSafeguardAttestation && ownerSafeguardAttestation.status === "attestation_overdue"
        const expiryAttestationElevated =
          !!ownerSafeguardAttestation &&
          (ownerSafeguardAttestation.status === "attestation_open" ||
            ownerSafeguardAttestation.status === "attestation_overdue")
        const burndownRecalibrationCritical =
          !!ownerBurndownRecalibration &&
          ownerBurndownRecalibration.status === "checkpoint_rollback_noted"
        const burndownRecalibrationElevated =
          !!ownerBurndownRecalibration &&
          (ownerBurndownRecalibration.status === "confidence_band_overridden" ||
            ownerBurndownRecalibration.status === "checkpoint_rollback_noted" ||
            ownerBurndownRecalibration.confidenceDriftHours > 0)
        const attestationQueueCritical =
          !!ownerExpiryAttestationQueue &&
          (ownerExpiryAttestationQueue.openExceptionCount > 0 ||
            ownerExpiryAttestationQueue.queueAgingHours >= 4)
        const attestationQueueElevated =
          !!ownerExpiryAttestationQueue &&
          (ownerExpiryAttestationQueue.status === "queue_open" ||
            ownerExpiryAttestationQueue.status === "queue_triaged" ||
            ownerExpiryAttestationQueue.queueAgingHours > 0)
        const burndownSettlementCritical =
          !!ownerBurndownSettlement &&
          ownerBurndownSettlement.status === "rollback_resolution_closed" &&
          ownerBurndownSettlement.settlementLatencyHours >= 8
        const burndownSettlementElevated =
          !!ownerBurndownSettlement &&
          (ownerBurndownSettlement.status === "drift_acknowledged" ||
            ownerBurndownSettlement.status === "target_lock_attested" ||
            ownerBurndownSettlement.status === "rollback_resolution_closed")
        const queueDrainCritical =
          !!ownerExpiryAttestationQueueDrain &&
          (ownerExpiryAttestationQueueDrain.status === "handoff_timeout_escalated" ||
            ownerExpiryAttestationQueueDrain.openQueueAgingHours >= 4)
        const queueDrainElevated =
          !!ownerExpiryAttestationQueueDrain &&
          (ownerExpiryAttestationQueueDrain.status !== "drain_pending" ||
            ownerExpiryAttestationQueueDrain.openQueueAgingHours > 0)
        const settlementAttestationCritical =
          !!ownerSettlementAttestation &&
          ownerSettlementAttestation.status === "dispute_reopen_guarded" &&
          ownerSettlementAttestation.settlementVerificationLagHours >= 8
        const settlementAttestationElevated =
          !!ownerSettlementAttestation &&
          (ownerSettlementAttestation.status === "lock_release_attested" ||
            ownerSettlementAttestation.status === "dispute_reopen_guarded")
        const queueReconciliationCritical =
          !!ownerQueueDrainReconciliation &&
          (ownerQueueDrainReconciliation.status === "reassignment_rollback_checkpointed" ||
            ownerQueueDrainReconciliation.drainReopenPressureCount >= 3)
        const queueReconciliationElevated =
          !!ownerQueueDrainReconciliation &&
          (ownerQueueDrainReconciliation.status !== "reconciliation_pending" ||
            ownerQueueDrainReconciliation.drainReopenPressureCount > 0)
        const settlementArbitrationCritical =
          !!ownerSettlementArbitration &&
          (
            (ownerSettlementArbitration.status === "reopen_veto_checkpointed" &&
              ownerSettlementArbitration.settlementArbitrationLeadTimeHours >= 8) ||
            ((ownerSettlementArbitration.status === "final_ruling_issued" ||
              ownerSettlementArbitration.status === "dissent_memorialized") &&
              ownerSettlementArbitration.arbitrationRulingAgingHours >= 8) ||
            ownerSettlementArbitration.status === "publication_rollback_checkpointed" ||
            ownerSettlementArbitration.arbitrationPublicationExceptionBacklogCount >= 2
          )
        const settlementArbitrationElevated =
          !!ownerSettlementArbitration &&
          (ownerSettlementArbitration.status === "panel_confirmation_attested" ||
            ownerSettlementArbitration.status === "reopen_veto_checkpointed" ||
            ownerSettlementArbitration.status === "final_ruling_issued" ||
            ownerSettlementArbitration.status === "dissent_memorialized" ||
            ownerSettlementArbitration.status === "ruling_publication_checkpointed" ||
            ownerSettlementArbitration.status === "publication_correction_logged" ||
            ownerSettlementArbitration.status === "publication_rollback_checkpointed" ||
            ownerSettlementArbitration.status === "distribution_attestation_reviewed" ||
            ownerSettlementArbitration.arbitrationPublicationExceptionBacklogCount > 0)
        const queueReentryComplianceCritical =
          !!ownerQueueReentryCompliance &&
          (
            ownerQueueReentryCompliance.status === "timeout_waiver_checkpointed" ||
            ownerQueueReentryCompliance.status === "debt_aging_auto_escalated" ||
            ownerQueueReentryCompliance.status === "retirement_rollback_controlled" ||
            ownerQueueReentryCompliance.queueReentryExceptionDebtCount >= 3 ||
            ownerQueueReentryCompliance.queueReentryRetirementReconciliationDriftCount >= 3
          )
        const queueReentryComplianceElevated =
          !!ownerQueueReentryCompliance &&
          (
            ownerQueueReentryCompliance.status !== "compliance_pending" ||
            ownerQueueReentryCompliance.queueReentryExceptionDebtCount > 0 ||
            ownerQueueReentryCompliance.queueReentryRetirementBurnCount > 0 ||
            ownerQueueReentryCompliance.queueReentryRetirementReconciliationDriftCount > 0
          )
        const closureQueueCritical =
          (closureQueueElevated && !!ownerClosureQueue && ownerClosureQueue.breachedReaffirmationCount > 0) ||
          closureSlaCritical ||
          closureExceptionCritical ||
          closureDisputeCritical ||
          exceptionEnforcementCritical ||
          adjudicationBacklogCritical ||
          rebalancePressureCritical ||
          quorumBreachCritical ||
          executionChurnCritical ||
          sloDebtCritical ||
          safeguardSuppressionCritical ||
          remediationDebtCritical ||
          safeguardExpiryCritical ||
          debtBurndownCritical ||
          expiryAttestationCritical ||
          burndownRecalibrationCritical ||
          attestationQueueCritical ||
          burndownSettlementCritical ||
          queueDrainCritical ||
          settlementAttestationCritical ||
          queueReconciliationCritical ||
          settlementArbitrationCritical ||
          queueReentryComplianceCritical
        const computedBaseWithQueue =
          (
            closureQueueElevated ||
            closureSlaElevated ||
            closureExceptionElevated ||
            closureDisputeElevated ||
            exceptionEnforcementElevated ||
            adjudicationBacklogElevated ||
            rebalancePressureElevated ||
            quorumBreachElevated ||
            executionChurnElevated ||
            sloDebtElevated ||
            safeguardSuppressionElevated ||
            remediationDebtElevated ||
            safeguardExpiryElevated ||
            debtBurndownElevated ||
            expiryAttestationElevated ||
            burndownRecalibrationElevated ||
            attestationQueueElevated ||
            burndownSettlementElevated ||
            queueDrainElevated ||
            settlementAttestationElevated ||
            queueReconciliationElevated ||
            settlementArbitrationElevated ||
            queueReentryComplianceElevated
          ) &&
          !computedBase.alertReasons.includes("closure_compliance_pressure")
            ? {
                ...computedBase,
                status: computedBase.status === "cleared" ? ("open_alert" as const) : computedBase.status,
                alertReasons: [...computedBase.alertReasons, "closure_compliance_pressure" as const].sort((a, b) =>
                  a.localeCompare(b)
                ),
                updatedAt: now,
                lastEvaluatedAt: now,
              }
            : computedBase
        const waiverExpiringCritical =
          !!nextWaiverExpiry &&
          nextWaiverExpiry.status !== "cleared" &&
          (nextWaiverExpiry.reasons.includes("already_expired") ||
            nextWaiverExpiry.reasons.includes("expires_lte_4h"))
        const policyVarianceCritical =
          !!nextPolicyVariance &&
          nextPolicyVariance.status !== "cleared" &&
          nextPolicyVariance.varianceReasons.includes("handoff_sla_override")
        const remediationExpiryCritical =
          !!nextRemediationExpiry &&
          nextRemediationExpiry.status !== "cleared" &&
          (nextRemediationExpiry.reasons.includes("already_expired") ||
            nextRemediationExpiry.reasons.includes("expires_lte_4h") ||
            nextRemediationExpiry.reasons.includes("closure_attestation_pending")) &&
          !(
            nextRemediationExpiry.status === "snoozed" &&
            nextRemediationExpiry.snoozeUntil &&
            nextRemediationExpiry.snoozeUntil > now
          )
        const reaffirmationSlaBreachCritical =
          !!nextReaffirmation &&
          (nextReaffirmation.status === "breached" ||
            nextReaffirmation.reasons.includes("cap_crossed_reaffirmation_breached"))
        const reaffirmationSlaWarning =
          !!nextReaffirmation &&
          (nextReaffirmation.status === "warning" ||
            nextReaffirmation.reasons.includes("cap_crossed_reaffirmation_warning"))
        const rolloverBreachCritical =
          !!nextRolloverWatch &&
          nextRolloverWatch.status !== "cleared" &&
          nextRolloverWatch.reasons.length > 0
        const noActiveRemediationForVariance =
          !!nextPolicyVariance &&
          nextPolicyVariance.status !== "cleared" &&
          !activeRemediation
        const longLivedTemporaryOverride =
          !!activeRemediation &&
          activeRemediation.decision === "temporary_override" &&
          activeRemediation.expiresAt - activeRemediation.decidedAt > policy.waiverWindowMs
        const severityTier: "baseline" | "elevated" | "critical" =
          closureQueueCritical ||
          reaffirmationSlaBreachCritical ||
          rolloverBreachCritical ||
          remediationExpiryCritical ||
          longLivedTemporaryOverride ||
          noActiveRemediationForVariance
            ? "critical"
            : waiverExpiringCritical ||
                policyVarianceCritical ||
                reaffirmationSlaWarning ||
                closureQueueElevated ||
                closureSlaElevated ||
                closureExceptionElevated ||
                closureDisputeElevated ||
                exceptionEnforcementElevated ||
                adjudicationBacklogElevated ||
                rebalancePressureElevated ||
                quorumBreachElevated ||
                executionChurnElevated ||
                sloDebtElevated ||
                safeguardSuppressionElevated ||
                remediationDebtElevated ||
                safeguardExpiryElevated
              ? "elevated"
              : "baseline"
        let computed =
          activeWaiver && computedBaseWithQueue.alertReasons.length > 0
            ? {
                ...computedBaseWithQueue,
                status: "snoozed" as const,
                snoozeUntil: activeWaiver.expiresAt,
                updatedAt: now,
                lastEvaluatedAt: now,
              }
            : computedBaseWithQueue
        if (severityTier === "critical" && computed.status !== "open_alert") {
          computed = {
            ...computed,
            status: "open_alert",
            snoozeUntil: null,
            updatedAt: now,
            lastEvaluatedAt: now,
          }
        } else if (severityTier === "elevated" && computed.status === "snoozed") {
          computed = {
            ...computed,
            status: "open_alert",
            snoozeUntil: null,
            updatedAt: now,
            lastEvaluatedAt: now,
          }
        }
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.ownerId !== computed.ownerId ||
          existing.ownerLoadCount !== computed.ownerLoadCount ||
          existing.ownerLoadThreshold !== computed.ownerLoadThreshold ||
          existing.snoozeUntil !== computed.snoozeUntil ||
          existing.handoffLagBucket !== computed.handoffLagBucket ||
          existing.handoffLagMs !== computed.handoffLagMs ||
          existing.linkedRotaId !== computed.linkedRotaId ||
          existing.linkedDigestId !== computed.linkedDigestId ||
          JSON.stringify(existing.alertReasons) !== JSON.stringify(computed.alertReasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationWorkloadDigests.upsert(next)
        }
        store.filingEscalationWorkloadDigests.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => {
          if (!isFilingEscalationWorkloadDigestStatus(workloadStatus)) return true
          return row.status === workloadStatus
        })
        .filter((row) =>
          reason
            ? row.alertReasons.includes(reason as (typeof row.alertReasons)[number])
            : true
        )
        .filter((row) => {
          if (!isFilingEscalationHandoffLagBucket(handoffLagBucket)) return true
          return row.handoffLagBucket === handoffLagBucket
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .map((row) => {
          const quorum = row.ownerId ? adjudicationQuorumByOwner.get(row.ownerId) ?? null : null
          const execution = row.ownerId ? rebalanceExecutionByOwner.get(row.ownerId) ?? null : null
          const slo = row.ownerId ? adjudicationSloByOwner.get(row.ownerId) ?? null : null
          const safeguard = row.ownerId ? rebalanceSafeguardByOwner.get(row.ownerId) ?? null : null
          const remediation = row.ownerId
            ? adjudicationSloDebtRemediationByOwner.get(row.ownerId) ?? null
            : null
          const safeguardExpiry = row.ownerId
            ? rebalanceSafeguardExpiryByOwner.get(row.ownerId) ?? null
            : null
          const debtBurndown = row.ownerId
            ? adjudicationDebtBurndownByOwner.get(row.ownerId) ?? null
            : null
          const safeguardAttestation = row.ownerId
            ? safeguardExpiryAttestationByOwner.get(row.ownerId) ?? null
            : null
          const burndownRecalibration = row.ownerId
            ? burndownRecalibrationByOwner.get(row.ownerId) ?? null
            : null
          const expiryQueue = row.ownerId
            ? expiryAttestationQueueByOwner.get(row.ownerId) ?? null
            : null
          const burndownSettlement = row.ownerId
            ? burndownSettlementByOwner.get(row.ownerId) ?? null
            : null
          const expiryQueueDrain = row.ownerId
            ? expiryAttestationQueueDrainByOwner.get(row.ownerId) ?? null
            : null
          const settlementAttestation = row.ownerId
            ? settlementAttestationByOwner.get(row.ownerId) ?? null
            : null
          const queueDrainReconciliation = row.ownerId
            ? queueDrainReconciliationByOwner.get(row.ownerId) ?? null
            : null
          const settlementArbitration = row.ownerId
            ? settlementArbitrationByOwner.get(row.ownerId) ?? null
            : null
          const queueReentryCompliance = row.ownerId
            ? queueReentryComplianceByOwner.get(row.ownerId) ?? null
            : null
          const adjudication = row.ownerId ? adjudicationByOwner.get(row.ownerId) ?? null : null
          return {
            ...row,
            closureAdjudicationQuorumStatus: quorum?.status ?? null,
            closureAdjudicationBreachFlags: quorum?.breachFlags ?? [],
            closureAdjudicationThroughputScore:
              adjudication &&
              (adjudication.status === "resolved_upheld" || adjudication.status === "resolved_overturned")
                ? 1
                : 0,
            closureRebalanceExecutionStatus: execution?.status ?? null,
            closureRebalanceExecutionMode: execution?.mode ?? null,
            closureRebalanceChurnCount: execution?.churnCount ?? 0,
            closureAdjudicationSloStatus: slo?.status ?? null,
            closureAdjudicationSloEscalationTier: slo?.escalationTier ?? "none",
            closureAdjudicationSloDebtHours: slo?.breachDebtHours ?? 0,
            closureRebalanceSafeguardStatus: safeguard?.status ?? "auto_exec_ready",
            closureRebalanceAutoExecutionEligible: safeguard?.autoExecutionEligible ?? true,
            closureRebalanceSuppressionReasons: safeguard?.suppressionReasons ?? [],
            closureAdjudicationSloDebtRemediationStatus: remediation?.status ?? "debt_retired",
            closureAdjudicationSloDebtAgeHours: remediation?.debtAgeHours ?? 0,
            closureRebalanceSafeguardExpiryStatus: safeguardExpiry?.status ?? "expiry_pending",
            closureRebalanceSafeguardExpiryDebtHours: safeguardExpiry?.expiryDebtHours ?? 0,
            closureAdjudicationDebtBurndownStatus: debtBurndown?.status ?? "burndown_tracking",
            closureAdjudicationDebtBurndownForecastBreachHours:
              debtBurndown?.forecastBreachHours ?? 0,
            closureAdjudicationDebtBurndownVelocityPerDay: debtBurndown?.debtVelocityPerDay ?? 0,
            closureSafeguardExpiryAttestationStatus:
              safeguardAttestation?.status ?? "attestation_open",
            closureSafeguardExpiryAttestationBacklogHours:
              safeguardAttestation?.openBacklogHours ?? 0,
            closureBurndownRecalibrationStatus:
              burndownRecalibration?.status ?? "recalibration_pending",
            closureBurndownConfidenceDriftHours:
              burndownRecalibration?.confidenceDriftHours ?? 0,
            closureExpiryAttestationQueueStatus: expiryQueue?.status ?? "queue_open",
            closureExpiryAttestationQueueAgingHours: expiryQueue?.queueAgingHours ?? 0,
            closureExpiryAttestationQueueOpenExceptions: expiryQueue?.openExceptionCount ?? 0,
            closureBurndownSettlementStatus:
              burndownSettlement?.status ?? "settlement_pending",
            closureBurndownSettlementLatencyHours:
              burndownSettlement?.settlementLatencyHours ?? 0,
            closureExpiryAttestationQueueDrainStatus:
              expiryQueueDrain?.status ?? "drain_pending",
            closureExpiryAttestationQueueDrainThroughputPerDay:
              expiryQueueDrain?.drainThroughputPerDay ?? 0,
            closureSettlementAttestationStatus:
              settlementAttestation?.status ?? "verification_pending",
            closureSettlementVerificationLagHours:
              settlementAttestation?.settlementVerificationLagHours ?? 0,
            closureQueueDrainReconciliationStatus:
              queueDrainReconciliation?.status ?? "reconciliation_pending",
            closureQueueDrainReopenPressureCount:
              queueDrainReconciliation?.drainReopenPressureCount ?? 0,
            closureSettlementArbitrationStatus:
              settlementArbitration?.status ?? "arbitration_pending",
            closureSettlementArbitrationLeadTimeHours:
              settlementArbitration?.settlementArbitrationLeadTimeHours ?? 0,
            closureArbitrationRulingAgingHours:
              settlementArbitration?.arbitrationRulingAgingHours ?? 0,
            closureArbitrationPublicationExceptionBacklogCount:
              settlementArbitration?.arbitrationPublicationExceptionBacklogCount ?? 0,
            closureQueueReentryComplianceStatus:
              queueReentryCompliance?.status ?? "compliance_pending",
            closureQueueReentryExceptionDebtCount:
              queueReentryCompliance?.queueReentryExceptionDebtCount ?? 0,
            closureQueueReentryRetirementBurnCount:
              queueReentryCompliance?.queueReentryRetirementBurnCount ?? 0,
            closureQueueReentryRetirementReconciliationDriftCount:
              queueReentryCompliance?.queueReentryRetirementReconciliationDriftCount ?? 0,
          }
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "escalation_policy_baselines") {
      const scope = url.searchParams.get("scope")
      const packageId = url.searchParams.get("packageId")
      const rows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationPolicyBaselineScope(scope)) return true
          return row.scope === scope
        })
        .filter((row) => {
          if (!matterId) return true
          if (!row.matterId) return true
          return row.matterId === matterId
        })
        .filter((row) => {
          if (row.matterId) {
            const permission = checkPermission(store, user.id, "draft", row.matterId)
            if (!permission.allow) return false
          }
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "breach_waiver_ledger") {
      const packageId = url.searchParams.get("packageId")
      const waiverStatus = url.searchParams.get("waiverStatus")
      const now = Date.now()
      const rows = await repos.filingEscalationBreachWaivers.listByFirm(user.firmId)
      const normalized: typeof rows = []
      for (const row of rows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
          normalized.push(expired)
          continue
        }
        normalized.push(row)
      }
      const visible = normalized
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationWaiverStatus(waiverStatus)) return true
          return row.status === waiverStatus
        })
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.grantedAt - a.grantedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "policy_variance_digests") {
      const packageId = url.searchParams.get("packageId")
      const varianceStatus = url.searchParams.get("varianceStatus")
      const reason = url.searchParams.get("reason")
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const persistedRows = await repos.filingEscalationPolicyVarianceDigests.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...packageOverrides.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const defaultPolicyRow = defaultPolicy
          ? policyRows.find((row) => row.id === defaultPolicy.id) ?? null
          : null
        const packagePolicyRow = latestByUpdatedAt(
          policyRows.filter((row) => row.scope === "package_override" && row.packageId === pkgId)
        )
        const computed = buildFilingEscalationPolicyVarianceDigestRow(filingPackage, {
          firmDefaultPolicy: defaultPolicyRow,
          packagePolicy: packagePolicyRow,
          existing,
          now,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.firmDefaultPolicyId !== computed.firmDefaultPolicyId ||
          existing.packagePolicyId !== computed.packagePolicyId ||
          existing.ownerLoadThresholdDefault !== computed.ownerLoadThresholdDefault ||
          existing.ownerLoadThresholdEffective !== computed.ownerLoadThresholdEffective ||
          existing.handoffSlaMsDefault !== computed.handoffSlaMsDefault ||
          existing.handoffSlaMsEffective !== computed.handoffSlaMsEffective ||
          existing.waiverWindowMsDefault !== computed.waiverWindowMsDefault ||
          existing.waiverWindowMsEffective !== computed.waiverWindowMsEffective ||
          existing.snoozeUntil !== computed.snoozeUntil ||
          JSON.stringify(existing.varianceReasons) !== JSON.stringify(computed.varianceReasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationPolicyVarianceDigests.upsert(next)
        }
        store.filingEscalationPolicyVarianceDigests.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationPolicyVarianceDigestStatus(varianceStatus)) return true
          return row.status === varianceStatus
        })
        .filter((row) =>
          reason
            ? row.varianceReasons.includes(reason as (typeof row.varianceReasons)[number])
            : true
        )
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "waiver_expiry_digests") {
      const packageId = url.searchParams.get("packageId")
      const expiryStatus = url.searchParams.get("expiryStatus")
      const reason = url.searchParams.get("reason")
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const waiverRows = await repos.filingEscalationBreachWaivers.listByFirm(user.firmId)
      const activeWaiverByPackage = new Map<string, (typeof waiverRows)[number]>()
      for (const row of waiverRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
          continue
        }
        if (row.status !== "active" || row.expiresAt <= now) continue
        const current = activeWaiverByPackage.get(row.packageId)
        if (!current || row.updatedAt > current.updatedAt) {
          activeWaiverByPackage.set(row.packageId, row)
        }
      }
      const persistedRows = await repos.filingEscalationWaiverExpiryDigests.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...activeWaiverByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const policy = resolveEffectiveEscalationPolicy(pkgId, packageOverrides, defaultPolicy)
        const computed = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
          activeWaiver: activeWaiverByPackage.get(pkgId) ?? null,
          linkedPolicyId: policy.sourcePolicyId,
          existing,
          now,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.linkedWaiverId !== computed.linkedWaiverId ||
          existing.linkedPolicyId !== computed.linkedPolicyId ||
          existing.waiverExpiresAt !== computed.waiverExpiresAt ||
          existing.msUntilExpiry !== computed.msUntilExpiry ||
          JSON.stringify(existing.reasons) !== JSON.stringify(computed.reasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationWaiverExpiryDigests.upsert(next)
        }
        store.filingEscalationWaiverExpiryDigests.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationWaiverExpiryDigestStatus(expiryStatus)) return true
          return row.status === expiryStatus
        })
        .filter((row) =>
          reason ? row.reasons.includes(reason as (typeof row.reasons)[number]) : true
        )
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "variance_remediation_ledger") {
      const packageId = url.searchParams.get("packageId")
      const remediationStatus = url.searchParams.get("remediationStatus")
      const decision = url.searchParams.get("decision")
      const now = Date.now()
      const rows = await repos.filingEscalationVarianceRemediations.listByFirm(user.firmId)
      const normalized: typeof rows = []
      for (const row of rows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationVarianceRemediations.upsert(expired)
          store.filingEscalationVarianceRemediations.set(expired.id, expired)
          normalized.push(expired)
          continue
        }
        normalized.push(row)
      }
      const visible = normalized
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationVarianceRemediationStatus(remediationStatus)) return true
          return row.status === remediationStatus
        })
        .filter((row) => {
          if (!isFilingEscalationVarianceRemediationDecision(decision)) return true
          return row.decision === decision
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "waiver_rollover_attestations") {
      const packageId = url.searchParams.get("packageId")
      const rolloverStatus = url.searchParams.get("rolloverStatus")
      const waiverId = url.searchParams.get("waiverId")
      const rows = await repos.filingEscalationWaiverRolloverAttestations.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => (waiverId ? row.waiverId === waiverId : true))
        .filter((row) => {
          if (!isFilingEscalationWaiverRolloverStatus(rolloverStatus)) return true
          return row.status === rolloverStatus
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "remediation_expiry_digests") {
      const packageId = url.searchParams.get("packageId")
      const expiryStatus = url.searchParams.get("expiryStatus")
      const reason = url.searchParams.get("reason")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const remediationRows = await repos.filingEscalationVarianceRemediations.listByFirm(user.firmId)
      for (const row of remediationRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationVarianceRemediations.upsert(expired)
          store.filingEscalationVarianceRemediations.set(expired.id, expired)
        }
      }
      const activeRemediationByPackage = latestActiveRemediationByPackage(
        await repos.filingEscalationVarianceRemediations.listByFirm(user.firmId),
        now
      )
      const lifecycleRows = await repos.filingEscalationRemediationLifecycles.listByFirm(user.firmId)
      const openLifecycleByPackage = latestOpenRemediationLifecycleByPackage(lifecycleRows)
      const persistedRows = await repos.filingEscalationRemediationExpiryDigests.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...activeRemediationByPackage.keys(),
        ...openLifecycleByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const policy = resolveEffectiveEscalationPolicy(pkgId, packageOverrides, defaultPolicy)
        const computed = buildFilingEscalationRemediationExpiryDigestRow(filingPackage, {
          activeRemediation: activeRemediationByPackage.get(pkgId) ?? null,
          pendingClosureLifecycle: openLifecycleByPackage.get(pkgId) ?? null,
          linkedPolicyId: policy.sourcePolicyId,
          existing,
          now,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.linkedRemediationId !== computed.linkedRemediationId ||
          existing.linkedLifecycleId !== computed.linkedLifecycleId ||
          existing.linkedPolicyVarianceDigestId !== computed.linkedPolicyVarianceDigestId ||
          existing.linkedPolicyId !== computed.linkedPolicyId ||
          existing.remediationExpiresAt !== computed.remediationExpiresAt ||
          existing.msUntilExpiry !== computed.msUntilExpiry ||
          existing.snoozeUntil !== computed.snoozeUntil ||
          JSON.stringify(existing.reasons) !== JSON.stringify(computed.reasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationRemediationExpiryDigests.upsert(next)
        }
        store.filingEscalationRemediationExpiryDigests.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationRemediationExpiryDigestStatus(expiryStatus)) return true
          return row.status === expiryStatus
        })
        .filter((row) =>
          reason ? row.reasons.includes(reason as (typeof row.reasons)[number]) : true
        )
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "remediation_lifecycle") {
      const packageId = url.searchParams.get("packageId")
      const lifecycleStatus = url.searchParams.get("lifecycleStatus")
      const closureOutcome = url.searchParams.get("closureOutcome")
      const rows = await repos.filingEscalationRemediationLifecycles.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationRemediationLifecycleStatus(lifecycleStatus)) return true
          return row.status === lifecycleStatus
        })
        .filter((row) => {
          if (!isFilingEscalationRemediationClosureOutcome(closureOutcome)) return true
          return row.closureOutcome === closureOutcome
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "rollover_reaffirmation_sla") {
      const packageId = url.searchParams.get("packageId")
      const statusFilter = url.searchParams.get("status")
      const reason = url.searchParams.get("reason")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const waiverRows = await repos.filingEscalationBreachWaivers.listByFirm(user.firmId)
      const activeWaiverByPackage = new Map<string, (typeof waiverRows)[number]>()
      for (const row of waiverRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
          continue
        }
        if (row.status !== "active" || row.expiresAt <= now) continue
        const current = activeWaiverByPackage.get(row.packageId)
        if (!current || row.updatedAt > current.updatedAt) {
          activeWaiverByPackage.set(row.packageId, row)
        }
      }
      const rolloverRows = await repos.filingEscalationWaiverRolloverAttestations.listByFirm(user.firmId)
      const rolloverByWaiverId = latestRolloverAttestationByWaiver(rolloverRows)
      const persistedRows = await repos.filingEscalationRolloverReaffirmationSlas.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...activeWaiverByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const policy = resolveEffectiveEscalationPolicy(pkgId, packageOverrides, defaultPolicy)
        const activeWaiver = activeWaiverByPackage.get(pkgId) ?? null
        const latestAttestation = activeWaiver ? rolloverByWaiverId.get(activeWaiver.id) ?? null : null
        const policyCapExpiresAt = activeWaiver ? activeWaiver.grantedAt + policy.waiverWindowMs : null
        const warningThresholdMs = Math.max(HOUR_MS, Math.floor(policy.waiverWindowMs / 2))
        const breachThresholdMs = Math.max(2 * HOUR_MS, policy.waiverWindowMs)
        const existing = rowsByPackage.get(pkgId) ?? null
        const computed = buildFilingEscalationRolloverReaffirmationSlaRow(filingPackage, {
          activeWaiver,
          policyCapExpiresAt,
          latestAttestation,
          linkedPolicyId: policy.sourcePolicyId,
          warningThresholdMs,
          breachThresholdMs,
          existing,
          now,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.linkedWaiverId !== computed.linkedWaiverId ||
          existing.linkedAttestationId !== computed.linkedAttestationId ||
          existing.linkedPolicyId !== computed.linkedPolicyId ||
          existing.policyCapExpiresAt !== computed.policyCapExpiresAt ||
          existing.waiverExpiresAt !== computed.waiverExpiresAt ||
          existing.lastReaffirmedAt !== computed.lastReaffirmedAt ||
          existing.elapsedSinceReaffirmationMs !== computed.elapsedSinceReaffirmationMs ||
          existing.warningThresholdMs !== computed.warningThresholdMs ||
          existing.breachThresholdMs !== computed.breachThresholdMs ||
          JSON.stringify(existing.reasons) !== JSON.stringify(computed.reasons)
        const next = changed ? computed : existing
        if (!next) continue
        if (changed) {
          await repos.filingEscalationRolloverReaffirmationSlas.upsert(next)
        }
        store.filingEscalationRolloverReaffirmationSlas.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationRolloverReaffirmationSlaStatus(statusFilter)) return true
          return row.status === statusFilter
        })
        .filter((row) =>
          reason ? row.reasons.includes(reason as (typeof row.reasons)[number]) : true
        )
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "rollover_breach_watches") {
      const packageId = url.searchParams.get("packageId")
      const watchStatus = url.searchParams.get("watchStatus")
      const reason = url.searchParams.get("reason")
      const waiverId = url.searchParams.get("waiverId")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const waiverRows = await repos.filingEscalationBreachWaivers.listByFirm(user.firmId)
      const activeWaiverByPackage = new Map<string, (typeof waiverRows)[number]>()
      for (const row of waiverRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
          continue
        }
        if (row.status !== "active" || row.expiresAt <= now) continue
        const current = activeWaiverByPackage.get(row.packageId)
        if (!current || row.updatedAt > current.updatedAt) {
          activeWaiverByPackage.set(row.packageId, row)
        }
      }
      const rolloverRows = await repos.filingEscalationWaiverRolloverAttestations.listByFirm(user.firmId)
      const rolloverByWaiverId = latestRolloverAttestationByWaiver(rolloverRows)
      const persistedRows = await repos.filingEscalationRolloverBreachWatches.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...activeWaiverByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const policy = resolveEffectiveEscalationPolicy(pkgId, packageOverrides, defaultPolicy)
        const activeWaiver = activeWaiverByPackage.get(pkgId) ?? null
        const latestAttestation = activeWaiver ? rolloverByWaiverId.get(activeWaiver.id) ?? null : null
        const policyCapExpiresAt = activeWaiver ? activeWaiver.grantedAt + policy.waiverWindowMs : null
        const computed = buildFilingEscalationRolloverBreachWatchRow(filingPackage, {
          activeWaiver,
          policyCapExpiresAt,
          latestAttestation,
          linkedPolicyId: policy.sourcePolicyId,
          existing,
          now,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.linkedWaiverId !== computed.linkedWaiverId ||
          existing.linkedAttestationId !== computed.linkedAttestationId ||
          existing.linkedPolicyId !== computed.linkedPolicyId ||
          existing.policyCapExpiresAt !== computed.policyCapExpiresAt ||
          existing.waiverExpiresAt !== computed.waiverExpiresAt ||
          existing.attestationUpdatedAt !== computed.attestationUpdatedAt ||
          JSON.stringify(existing.reasons) !== JSON.stringify(computed.reasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationRolloverBreachWatches.upsert(next)
        }
        store.filingEscalationRolloverBreachWatches.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => (waiverId ? row.linkedWaiverId === waiverId : true))
        .filter((row) => {
          if (!isFilingEscalationRolloverBreachWatchStatus(watchStatus)) return true
          return row.status === watchStatus
        })
        .filter((row) =>
          reason ? row.reasons.includes(reason as (typeof row.reasons)[number]) : true
        )
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }

    const visible = firmPackages
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => {
        const permission = checkPermission(store, user.id, "draft", row.matterId)
        if (!permission.allow) return false
        return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
      })
      .filter((row) => {
        if (!readiness) return true
        const artifact = artifactByPackage.get(row.id)
        if (!artifact) return readiness === "blocked"
        return artifact.readiness === readiness
      })
      .map((row) => ({
        ...row,
        packetArtifact: artifactByPackage.get(row.id) ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const items = visible.slice(cursor, cursor + limit)
    const nextCursor =
      cursor + items.length < visible.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view,
      items,
      total: visible.length,
      limit,
      cursor,
      nextCursor,
    })
  } catch (err) {
    const message = publicErrorMessage(err, "filings read failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}

// Erratum E-24 (L18 §9.1 rule 4): only the core package path (isFilingsCoreRequest) stays live
// while LEGACY_GOVERNANCE_CHAINS is off. The gate runs inside withSession, so auth applies first.
const handlePostGated = gateByFlag("LEGACY_GOVERNANCE_CHAINS", handlePost, isFilingsCoreRequest)

export async function POST(request: Request) {
  return withSession(request, handlePostGated)
}

async function handlePost(request: Request, session: HandlerSession | null) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  let key: string
  try {
    key = requireIdempotencyKey(request)
  } catch (err) {
    const message =
      err instanceof IdempotencyError ? err.message : "Idempotency-Key header required"
    return NextResponse.json({ error: message }, { status: 400 })
  }

  let parsed: Body
  try {
    parsed = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!parsed.action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 })
  }

  const fingerprint = JSON.stringify({
    route: "/api/d4/filings",
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

  try {
    if (parsed.action === "create_package") {
      if (
        !parsed.actorId ||
        !parsed.matterId ||
        !parsed.draftId ||
        !isClassification(parsed.classification)
      ) {
        return NextResponse.json(
          { error: "actorId, matterId, draftId, and classification are required" },
          { status: 400 }
        )
      }
      // The override partner is the authenticated caller (L17.1 human control), never a body field.
      const resolvedOverride = resolvePartnerOverride(
        store,
        parsed.partnerOverride,
        session?.userId ?? undefined
      )
      if (!resolvedOverride.ok) {
        return errorResponse(resolvedOverride.status, resolvedOverride.code, resolvedOverride.error)
      }
      const partnerOverride = resolvedOverride.override
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const priorAuditCount = store.audit.length
      const created = createFilingPackage(store, {
        actorId: parsed.actorId,
        matterId: parsed.matterId,
        draftId: parsed.draftId,
        preflight: {
          actorId: parsed.actorId,
          matterId: parsed.matterId,
          classification: parsed.classification,
          citedJudgmentIds: parsed.citedJudgmentIds ?? [],
          temporalCitations: parsed.temporalCitations ?? [],
          partnerOverride,
        },
      })
      await repos.filings.create(created.filingPackage)
      // Review R1 #5: the draft is locked against body edits while the package is live.
      await repos.drafts.setLocked(created.filingPackage.draftId, true)
      const draft =
        store.drafts.get(created.filingPackage.draftId) ??
        (await repos.drafts.get(created.filingPackage.draftId))
      const packetArtifact = buildFilingPacketArtifactRow(created.filingPackage, draft)
      await repos.filingPacketArtifacts.upsert(packetArtifact)
      store.filingPacketArtifacts.set(packetArtifact.id, packetArtifact)
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "create_package",
        filingPackage:
          (await repos.filings.get(created.filingPackage.id)) ?? created.filingPackage,
        packetArtifact: (await repos.filingPacketArtifacts.get(packetArtifact.id)) ?? packetArtifact,
        preflight: created.preflight,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "decide_package") {
      if (!parsed.actorId || !parsed.packageId || !parsed.decision || !parsed.reason) {
        return NextResponse.json(
          { error: "actorId, packageId, decision, and reason are required" },
          { status: 400 }
        )
      }
      const resolvedOverride = resolvePartnerOverride(
        store,
        parsed.partnerOverride,
        session?.userId ?? undefined
      )
      if (!resolvedOverride.ok) {
        return errorResponse(resolvedOverride.status, resolvedOverride.code, resolvedOverride.error)
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      // Captured before the decision so its audit rows (approve/reject, gate override) persist.
      const priorAuditCount = store.audit.length
      // Final audit F2: decide against the durable package status, never a stale spine copy.
      const durablePackage = await repos.filings.get(parsed.packageId)
      if (durablePackage) store.filingPackages.set(durablePackage.id, durablePackage)
      const pendingPackage = store.filingPackages.get(parsed.packageId)
      // Review R1 #5: approve against the durable copy of the draft, never a stale in-memory one.
      const pendingDraft = pendingPackage
        ? ((await repos.drafts.get(pendingPackage.draftId)) ??
          store.drafts.get(pendingPackage.draftId))
        : undefined
      const decision = planFilingPackageDecision(store, {
        actorId: parsed.actorId,
        packageId: parsed.packageId,
        decision: parsed.decision,
        reason: parsed.reason,
        ...(pendingDraft ? { draftBody: pendingDraft.body, draftTitle: pendingDraft.title } : {}),
        ...(resolvedOverride.override ? { partnerOverride: resolvedOverride.override } : {}),
      })
      // One-shot: the decision applies only if the durable package is still pending (a
      // conditional update; a transaction in Firestore mode). A concurrent decision that lost
      // the race is refused and changes nothing (no lock change, no decision audit row).
      const won = await repos.filings.decideIfPending(
        decision.decided.id,
        filingPackageDecisionPatch(decision.decided)
      )
      if (won.kind === "already_decided") throw new PackageAlreadyDecidedError()
      if (won.kind === "missing") await repos.filings.create(decision.decided)
      const filingPackage = applyFilingPackageDecision(store, {
        ...decision,
        decided: won.kind === "decided" ? won.row : decision.decided,
      })
      await repos.drafts.setLocked(
        filingPackage.draftId,
        draftShouldBeLocked(store, filingPackage.draftId)
      )
      const draft =
        store.drafts.get(filingPackage.draftId) ?? (await repos.drafts.get(filingPackage.draftId))
      const packetArtifact = buildFilingPacketArtifactRow(filingPackage, draft)
      await repos.filingPacketArtifacts.upsert(packetArtifact)
      store.filingPacketArtifacts.set(packetArtifact.id, packetArtifact)
      // Erratum E-24: the filing-transport pipeline (dispatch queue, annexures) is frozen behind
      // LEGACY_GOVERNANCE_CHAINS. With the flag off an approval stops at filing readiness: no
      // dispatch-queue or annexure row is written and neither field is returned.
      const transportLive = isFeatureEnabled("LEGACY_GOVERNANCE_CHAINS", actor.firmId)
      const dispatchQueueRow =
        transportLive && filingPackage.status === "approved"
          ? buildFilingDispatchQueueRow(filingPackage)
          : null
      const annexureRow =
        dispatchQueueRow && dispatchQueueRow.status !== "blocked"
          ? buildFilingAnnexureRow(filingPackage, dispatchQueueRow)
          : null
      if (dispatchQueueRow) {
        await repos.filingDispatchQueue.upsert(dispatchQueueRow)
        store.filingDispatchQueue.set(dispatchQueueRow.id, dispatchQueueRow)
      }
      if (annexureRow) {
        await repos.filingAnnexures.upsert(annexureRow)
        store.filingAnnexures.set(annexureRow.id, annexureRow)
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "decide_package",
        filingPackage: (await repos.filings.get(filingPackage.id)) ?? filingPackage,
        packetArtifact: (await repos.filingPacketArtifacts.get(packetArtifact.id)) ?? packetArtifact,
        ...(transportLive
          ? {
              dispatchQueue:
                dispatchQueueRow &&
                ((await repos.filingDispatchQueue.get(dispatchQueueRow.id)) ?? dispatchQueueRow),
              annexure:
                annexureRow && ((await repos.filingAnnexures.get(annexureRow.id)) ?? annexureRow),
            }
          : {}),
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "dispatch_update") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      if (parsed.nextStatus && !isFilingDispatchQueueStatus(parsed.nextStatus)) {
        return NextResponse.json({ error: "invalid dispatch status" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "associate", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "dispatch queue updates require partner, associate, or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm dispatch update denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      if (filingPackage.status !== "approved") {
        return NextResponse.json(
          { error: "dispatch queue can only be updated for approved filing packages" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const existing =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      if (parsed.assigneeId !== undefined && parsed.assigneeId !== null) {
        const assignee =
          store.users.get(parsed.assigneeId) ?? (await repos.users.get(parsed.assigneeId))
        if (!assignee || assignee.firmId !== actor.firmId) {
          return NextResponse.json({ error: "unknown assignee in actor firm" }, { status: 404 })
        }
      }
      const now = Date.now()
      const note = parsed.note?.trim()
      const nextStatus = parsed.nextStatus ?? existing.status
      const updated = {
        ...existing,
        status: nextStatus,
        assigneeId: parsed.assigneeId === undefined ? existing.assigneeId : parsed.assigneeId,
        retryCount: existing.retryCount + (parsed.markAttempt ? 1 : 0),
        lastAttemptAt: parsed.markAttempt ? now : existing.lastAttemptAt,
        operatorNotes: note
          ? [...existing.operatorNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`]
          : existing.operatorNotes,
        externalDispatchState:
          nextStatus === "handoff_ready"
            ? ("ready_for_firm_dispatch" as const)
            : ("blocked_todo_firm" as const),
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updated)
      store.filingDispatchQueue.set(updated.id, updated)
      const existingAnnexure =
        (await repos.filingAnnexures.get(filingAnnexureId(filingPackage.id))) ??
        buildFilingAnnexureRow(filingPackage, updated)
      const annexure = {
        ...existingAnnexure,
        generationStatus:
          nextStatus === "blocked"
            ? ("blocked" as const)
            : existingAnnexure.generationStatus === "blocked"
              ? ("pending" as const)
              : existingAnnexure.generationStatus,
        operatorNotes:
          nextStatus === "blocked"
            ? [...existingAnnexure.operatorNotes, "dispatch queue moved to blocked status"]
            : existingAnnexure.operatorNotes,
        updatedAt: now,
      }
      await repos.filingAnnexures.upsert(annexure)
      store.filingAnnexures.set(annexure.id, annexure)
      store.audit.push({
        action: "filing_dispatch_update",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: parsed.note?.trim() || parsed.nextStatus || "dispatch queue update",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "dispatch_update",
        dispatchQueue: (await repos.filingDispatchQueue.get(updated.id)) ?? updated,
        annexure: (await repos.filingAnnexures.get(annexure.id)) ?? annexure,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "annexure_checkpoint") {
      if (!parsed.actorId || !parsed.packageId || !parsed.checkpoint) {
        return NextResponse.json(
          { error: "actorId, packageId, and checkpoint are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "associate", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "annexure checkpoints require partner, associate, or clerk role" },
          { status: 403 }
        )
      }
      if (parsed.checkpoint === "record_partner_signoff" && actor.role !== "partner") {
        return NextResponse.json({ error: "partner role required for partner signoff checkpoint" }, { status: 403 })
      }
      if (parsed.checkpoint === "record_clerk_verification" && !["clerk", "partner"].includes(actor.role)) {
        return NextResponse.json({ error: "clerk or partner role required for clerk verification checkpoint" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm annexure checkpoint denied" }, { status: 403 })
      }
      if (filingPackage.status !== "approved") {
        return NextResponse.json(
          { error: "annexure checkpoints require approved filing package" },
          { status: 422 }
        )
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const persistedQueue = await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))
      const queueRow = persistedQueue ?? buildFilingDispatchQueueRow(filingPackage)
      if (!persistedQueue) {
        await repos.filingDispatchQueue.upsert(queueRow)
        store.filingDispatchQueue.set(queueRow.id, queueRow)
      }
      if (queueRow.status === "blocked") {
        return NextResponse.json(
          { error: "annexure checkpoints require non-blocked dispatch queue state" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const existing =
        (await repos.filingAnnexures.get(filingAnnexureId(filingPackage.id))) ??
        buildFilingAnnexureRow(filingPackage, queueRow)
      const now = Date.now()
      const trimmedNote = parsed.note?.trim()
      const nextManifest = [...existing.manifest]
      let generationStatus = existing.generationStatus
      const signerRequirements = { ...existing.signerRequirements }
      if (parsed.checkpoint === "mark_assembling") {
        generationStatus = "assembling"
      } else if (parsed.checkpoint === "mark_artifact_ready") {
        if (!parsed.artifactId) {
          return NextResponse.json({ error: "artifactId is required for mark_artifact_ready" }, { status: 400 })
        }
        const idx = nextManifest.findIndex((item) => item.artifactId === parsed.artifactId)
        if (idx < 0) {
          return NextResponse.json({ error: "unknown annexure artifactId" }, { status: 404 })
        }
        const { note: _ignoredNote, ...withoutNote } = nextManifest[idx]
        nextManifest[idx] = { ...withoutNote, status: "ready" }
      } else if (parsed.checkpoint === "record_partner_signoff") {
        signerRequirements.partnerSignoffBy = actor.id
        signerRequirements.partnerSignoffAt = now
      } else if (parsed.checkpoint === "record_clerk_verification") {
        signerRequirements.clerkVerificationBy = actor.id
        signerRequirements.clerkVerificationAt = now
      } else if (parsed.checkpoint === "mark_ready_for_transport") {
        const candidate = {
          ...existing,
          manifest: nextManifest,
          signerRequirements,
        }
        if (!annexureReadyForTransport(candidate)) {
          return NextResponse.json(
            { error: "annexure is not ready: required artifacts/signoffs missing" },
            { status: 422 }
          )
        }
        generationStatus = "ready"
      }
      const checkpointNote = trimmedNote
        ? `${new Date(now).toISOString()} ${actor.id}: ${parsed.checkpoint} (${trimmedNote})`
        : `${new Date(now).toISOString()} ${actor.id}: ${parsed.checkpoint}`
      const updated = {
        ...existing,
        generationStatus,
        manifest: nextManifest,
        signerRequirements,
        operatorNotes: [...existing.operatorNotes, checkpointNote],
        submissionTransportBoundary: "todo_firm_external_transport_blocked" as const,
        updatedAt: now,
      }
      await repos.filingAnnexures.upsert(updated)
      store.filingAnnexures.set(updated.id, updated)
      store.audit.push({
        action: "filing_annexure_checkpoint",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: parsed.checkpoint,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "annexure_checkpoint",
        annexure: (await repos.filingAnnexures.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "record_submission_receipt") {
      if (
        !parsed.actorId ||
        !parsed.packageId ||
        !parsed.courtChannel ||
        !parsed.dispatchOutcome ||
        !parsed.submissionReference
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, packageId, courtChannel, dispatchOutcome, and submissionReference are required",
          },
          { status: 400 }
        )
      }
      if (!isFilingSubmissionCourtChannel(parsed.courtChannel)) {
        return NextResponse.json({ error: "invalid courtChannel" }, { status: 400 })
      }
      if (!isFilingSubmissionDispatchOutcome(parsed.dispatchOutcome)) {
        return NextResponse.json({ error: "invalid dispatchOutcome" }, { status: 400 })
      }
      if (parsed.dispatchOutcome === "rejected" && !parsed.failureReason?.trim()) {
        return NextResponse.json(
          { error: "failureReason is required when dispatchOutcome is rejected" },
          { status: 400 }
        )
      }
      if (parsed.dispatchOutcome === "retry_scheduled" && !parsed.retryHint?.trim()) {
        return NextResponse.json(
          { error: "retryHint is required when dispatchOutcome is retry_scheduled" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "record_submission_receipt requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm receipt record denied" }, { status: 403 })
      }
      if (filingPackage.status !== "approved") {
        return NextResponse.json(
          { error: "submission receipt can only be recorded for approved filing packages" },
          { status: 422 }
        )
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const annexure =
        (await repos.filingAnnexures.get(filingAnnexureId(filingPackage.id))) ??
        store.filingAnnexures.get(filingAnnexureId(filingPackage.id))
      if (!annexure || annexure.generationStatus !== "ready") {
        return NextResponse.json(
          { error: "submission receipt requires annexure generationStatus=ready" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const existingReceipts = await repos.filingSubmissionReceipts.listByPackageId(filingPackage.id)
      const highestAttempt = existingReceipts.reduce(
        (max, row) => (row.attemptNo > max ? row.attemptNo : max),
        0
      )
      const receipt = buildFilingSubmissionReceiptRow(
        filingPackage,
        {
          attemptNo: highestAttempt + 1,
          courtChannel: parsed.courtChannel,
          dispatchOutcome: parsed.dispatchOutcome,
          submissionReference: parsed.submissionReference.trim(),
          failureReason: parsed.failureReason?.trim() || null,
          retryHint: parsed.retryHint?.trim() || null,
          actorId: actor.id,
        },
        { now: Date.now() }
      )
      await repos.filingSubmissionReceipts.upsert(receipt)
      store.filingSubmissionReceipts.set(receipt.id, receipt)
      const existingReconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const note = parsed.note?.trim()
      const reconciliation = buildFilingSubmissionReconciliationRow(
        filingPackage,
        [...existingReceipts, receipt],
        {
          notes: note
            ? [
                ...(existingReconciliation?.notes ?? []),
                `${new Date(receipt.recordedAt).toISOString()} ${actor.id}: ${note}`,
              ]
            : existingReconciliation?.notes ?? [],
        }
      )
      await repos.filingSubmissionReconciliation.upsert(reconciliation)
      store.filingSubmissionReconciliation.set(reconciliation.id, reconciliation)
      let submissionException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (parsed.dispatchOutcome !== "accepted") {
        const source =
          parsed.dispatchOutcome === "rejected"
            ? ("receipt_rejected" as const)
            : ("receipt_retry_scheduled" as const)
        const nextException = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source,
            receipt,
            reconciliation,
            actorId: actor.id,
            note: note ? `auto-raised from receipt outcome ${parsed.dispatchOutcome}: ${note}` : undefined,
            now: receipt.recordedAt,
          },
          submissionException
        )
        await repos.filingSubmissionExceptions.upsert(nextException)
        store.filingSubmissionExceptions.set(nextException.id, nextException)
        submissionException = nextException
      }
      const dispatchQueue = await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))
      const dispatchStatus =
        parsed.dispatchOutcome === "accepted"
          ? ("handoff_ready" as const)
          : ("retry_pending" as const)
      const updatedDispatchQueue = dispatchQueue
        ? {
            ...dispatchQueue,
            status: dispatchStatus,
            operatorNotes: [
              ...dispatchQueue.operatorNotes,
              `${new Date(receipt.recordedAt).toISOString()} ${actor.id}: receipt ${receipt.id} (${parsed.dispatchOutcome})`,
            ],
            updatedAt: Date.now(),
          }
        : null
      if (updatedDispatchQueue) {
        await repos.filingDispatchQueue.upsert(updatedDispatchQueue)
        store.filingDispatchQueue.set(updatedDispatchQueue.id, updatedDispatchQueue)
      }
      store.audit.push({
        action: "filing_submission_receipt_record",
        actorId: actor.id,
        target: receipt.id,
        classification: filingPackage.classification,
        reason: parsed.dispatchOutcome,
      })
      store.audit.push({
        action: "filing_submission_reconciliation_update",
        actorId: actor.id,
        target: reconciliation.id,
        classification: filingPackage.classification,
        reason: reconciliation.status,
      })
      if (submissionException && parsed.dispatchOutcome !== "accepted") {
        store.audit.push({
          action: "filing_submission_exception_raise",
          actorId: actor.id,
          target: submissionException.id,
          classification: filingPackage.classification,
          reason: `${submissionException.source}:${submissionException.severity}`,
        })
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "record_submission_receipt",
        receipt: (await repos.filingSubmissionReceipts.get(receipt.id)) ?? receipt,
        reconciliation:
          (await repos.filingSubmissionReconciliation.get(reconciliation.id)) ?? reconciliation,
        submissionException:
          submissionException &&
          ((await repos.filingSubmissionExceptions.get(submissionException.id)) ?? submissionException),
        dispatchQueue: updatedDispatchQueue
          ? (await repos.filingDispatchQueue.get(updatedDispatchQueue.id)) ?? updatedDispatchQueue
          : null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reconcile_submission") {
      if (!parsed.actorId || !parsed.packageId || !parsed.status) {
        return NextResponse.json(
          { error: "actorId, packageId, and status are required" },
          { status: 400 }
        )
      }
      if (!isFilingSubmissionReconciliationStatus(parsed.status)) {
        return NextResponse.json({ error: "invalid reconciliation status" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "reconcile_submission requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm reconciliation denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const receipts = await repos.filingSubmissionReceipts.listByPackageId(filingPackage.id)
      const current =
        (await repos.filingSubmissionReconciliation.get(
          filingSubmissionReconciliationId(filingPackage.id)
        )) ?? buildFilingSubmissionReconciliationRow(filingPackage, receipts)
      const note = parsed.note?.trim()
      const updated = {
        ...current,
        status: parsed.status,
        notes: note
          ? [...current.notes, `${new Date().toISOString()} ${actor.id}: ${note}`]
          : current.notes,
        updatedAt: Date.now(),
      }
      await repos.filingSubmissionReconciliation.upsert(updated)
      store.filingSubmissionReconciliation.set(updated.id, updated)
      let submissionException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (parsed.status === "needs_retry") {
        const latestReceipt =
          (updated.latestReceiptId &&
            (await repos.filingSubmissionReceipts.get(updated.latestReceiptId))) ||
          null
        const nextException = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source: "reconciliation_needs_retry",
            receipt: latestReceipt,
            reconciliation: updated,
            actorId: actor.id,
            note: note ? `auto-raised from reconciliation: ${note}` : undefined,
            now: updated.updatedAt,
          },
          submissionException
        )
        await repos.filingSubmissionExceptions.upsert(nextException)
        store.filingSubmissionExceptions.set(nextException.id, nextException)
        submissionException = nextException
      } else if (parsed.status === "reconciled" && submissionException) {
        const now = Date.now()
        const resolved = {
          ...submissionException,
          status: "resolved" as const,
          resolvedBy: actor.id,
          resolvedAt: now,
          resolutionNotes: [
            ...submissionException.resolutionNotes,
            `${new Date(now).toISOString()} ${actor.id}: auto-resolved from reconciliation`,
          ],
          updatedAt: now,
        }
        await repos.filingSubmissionExceptions.upsert(resolved)
        store.filingSubmissionExceptions.set(resolved.id, resolved)
        submissionException = resolved
      }
      store.audit.push({
        action: "filing_submission_reconcile",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: parsed.status,
      })
      if (submissionException && parsed.status === "needs_retry") {
        store.audit.push({
          action: "filing_submission_exception_raise",
          actorId: actor.id,
          target: submissionException.id,
          classification: filingPackage.classification,
          reason: `${submissionException.source}:${submissionException.severity}`,
        })
      }
      if (submissionException && parsed.status === "reconciled") {
        store.audit.push({
          action: "filing_submission_exception_resolve",
          actorId: actor.id,
          target: submissionException.id,
          classification: filingPackage.classification,
          reason: "auto_reconciled",
        })
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "reconcile_submission",
        reconciliation: (await repos.filingSubmissionReconciliation.get(updated.id)) ?? updated,
        submissionException:
          submissionException &&
          ((await repos.filingSubmissionExceptions.get(submissionException.id)) ?? submissionException),
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "claim_submission_exception") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "claim_submission_exception requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm exception claim denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim()
      const updated = {
        ...existing,
        status: "claimed" as const,
        escalationOwnerId: existing.escalationOwnerId ?? actor.id,
        claimedBy: actor.id,
        claimedAt: now,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNotes: note
          ? [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`]
          : existing.resolutionNotes,
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_claim",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "claim_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "escalate_submission_exception") {
      if (!parsed.actorId || !parsed.packageId || !parsed.escalationOwnerId) {
        return NextResponse.json(
          { error: "actorId, packageId, and escalationOwnerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "escalate_submission_exception requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm exception escalation denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const escalationOwner =
        store.users.get(parsed.escalationOwnerId) ?? (await repos.users.get(parsed.escalationOwnerId))
      if (!escalationOwner || escalationOwner.firmId !== actor.firmId || escalationOwner.role !== "partner") {
        return NextResponse.json(
          { error: "escalationOwnerId must be a partner in actor firm" },
          { status: 422 }
        )
      }
      if (parsed.severity && !isFilingSubmissionExceptionSeverity(parsed.severity)) {
        return NextResponse.json({ error: "invalid severity" }, { status: 400 })
      }
      if (parsed.slaHours !== undefined) {
        const parsedHours = Number(parsed.slaHours)
        if (!Number.isFinite(parsedHours) || parsedHours < 1 || parsedHours > 168) {
          return NextResponse.json(
            { error: "slaHours must be between 1 and 168" },
            { status: 400 }
          )
        }
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim()
      const updated = {
        ...existing,
        status: "escalated" as const,
        severity: parsed.severity ?? existing.severity,
        escalationOwnerId: escalationOwner.id,
        escalatedBy: actor.id,
        escalatedAt: now,
        slaTargetAt: parsed.slaHours ? now + parsed.slaHours * 60 * 60 * 1000 : existing.slaTargetAt,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNotes: note
          ? [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`]
          : existing.resolutionNotes,
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_escalate",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: `${updated.severity}:${updated.escalationOwnerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "escalate_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_submission_exception") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "resolve_submission_exception requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm exception resolution denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim() || "exception resolved by operator"
      const updated = {
        ...existing,
        status: "resolved" as const,
        resolvedBy: actor.id,
        resolvedAt: now,
        resolutionNotes: [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_resolve",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "resolve_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reopen_submission_exception") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "reopen_submission_exception requires partner or clerk role" },
          { status: 403 }
        )
      }
      if (parsed.severity && !isFilingSubmissionExceptionSeverity(parsed.severity)) {
        return NextResponse.json({ error: "invalid severity" }, { status: 400 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm exception reopen denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim() || "exception reopened by operator"
      const updatedSeverity = parsed.severity ?? existing.severity
      const updated = {
        ...existing,
        status: "open" as const,
        severity: updatedSeverity,
        resolvedBy: null,
        resolvedAt: null,
        lastRaisedAt: now,
        slaTargetAt: now + (updatedSeverity === "critical" ? 2 : updatedSeverity === "high" ? 8 : 24) * 60 * 60 * 1000,
        resolutionNotes: [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_reopen",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.severity,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "reopen_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "mark_transport_blocked") {
      if (!parsed.actorId || !parsed.packageId || !parsed.transportChannel || !parsed.channelPayloadHash) {
        return NextResponse.json(
          { error: "actorId, packageId, transportChannel, and channelPayloadHash are required" },
          { status: 400 }
        )
      }
      if (!isFilingTransportExecutionChannel(parsed.transportChannel)) {
        return NextResponse.json({ error: "invalid transportChannel" }, { status: 400 })
      }
      if (parsed.severity && !isFilingSubmissionExceptionSeverity(parsed.severity)) {
        return NextResponse.json({ error: "invalid severity" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "mark_transport_blocked requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm transport block denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const evidenceRows = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const nextSequenceNo = evidenceRows.reduce((max, row) => Math.max(max, row.sequenceNo), 0) + 1
      const currentException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const reconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const nextException = buildSubmissionExceptionRowFromFailure(
        filingPackage,
        {
          source: "dispatch_transport_blocked",
          receipt: null,
          reconciliation,
          actorId: actor.id,
          note: parsed.note ?? "transport blocked during deterministic handoff",
          now,
        },
        currentException
      )
      const normalizedException = {
        ...nextException,
        severity: parsed.severity ?? nextException.severity,
      }
      await repos.filingSubmissionExceptions.upsert(normalizedException)
      store.filingSubmissionExceptions.set(normalizedException.id, normalizedException)
      const existingQueue =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      const updatedQueue = {
        ...existingQueue,
        status: "blocked" as const,
        externalDispatchState: "blocked_todo_firm" as const,
        operatorNotes: [
          ...existingQueue.operatorNotes,
          `${new Date(now).toISOString()} ${actor.id}: transport blocked`,
        ],
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updatedQueue)
      store.filingDispatchQueue.set(updatedQueue.id, updatedQueue)
      const evidence = buildFilingTransportExecutionEvidenceRow(
        filingPackage,
        {
          sequenceNo: nextSequenceNo,
          outcome: "transport_blocked",
          transportOperatorId: actor.id,
          transportChannel: parsed.transportChannel,
          channelPayloadHash: parsed.channelPayloadHash,
          deterministicBlockerTags: parsed.blockerTags,
          attachmentPointers: parsed.attachmentPointers,
          relatedReconciliationId: reconciliation?.id ?? null,
          relatedExceptionId: normalizedException.id,
          note: parsed.note,
        },
        { now }
      )
      await repos.filingTransportExecutionEvidence.upsert(evidence)
      store.filingTransportExecutionEvidence.set(evidence.id, evidence)
      store.audit.push({
        action: "filing_transport_execution_evidence_record",
        actorId: actor.id,
        target: evidence.id,
        classification: filingPackage.classification,
        reason: evidence.outcome,
      })
      store.audit.push({
        action: "filing_dispatch_closure_update",
        actorId: actor.id,
        target: updatedQueue.id,
        classification: filingPackage.classification,
        reason: "transport_blocked",
      })
      store.audit.push({
        action: "filing_submission_exception_raise",
        actorId: actor.id,
        target: normalizedException.id,
        classification: filingPackage.classification,
        reason: `${normalizedException.source}:${normalizedException.severity}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "mark_transport_blocked",
        evidence: (await repos.filingTransportExecutionEvidence.get(evidence.id)) ?? evidence,
        dispatchQueue: (await repos.filingDispatchQueue.get(updatedQueue.id)) ?? updatedQueue,
        submissionException:
          (await repos.filingSubmissionExceptions.get(normalizedException.id)) ?? normalizedException,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attach_retry_plan") {
      if (!parsed.actorId || !parsed.packageId || !parsed.transportChannel || !parsed.channelPayloadHash) {
        return NextResponse.json(
          { error: "actorId, packageId, transportChannel, and channelPayloadHash are required" },
          { status: 400 }
        )
      }
      if (!isFilingTransportExecutionChannel(parsed.transportChannel)) {
        return NextResponse.json({ error: "invalid transportChannel" }, { status: 400 })
      }
      if (!parsed.attachmentPointers?.some((entry) => entry.trim().length > 0)) {
        return NextResponse.json({ error: "attachmentPointers must include at least one entry" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "attach_retry_plan requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm retry plan attach denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const evidenceRows = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const nextSequenceNo = evidenceRows.reduce((max, row) => Math.max(max, row.sequenceNo), 0) + 1
      const currentException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const reconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const nextException = buildSubmissionExceptionRowFromFailure(
        filingPackage,
        {
          source: "dispatch_retry_plan",
          receipt: null,
          reconciliation,
          actorId: actor.id,
          note: parsed.note ?? "retry plan attached",
          now,
        },
        currentException
      )
      const normalizedException = {
        ...nextException,
        status: "escalated" as const,
        escalationOwnerId:
          actor.role === "partner" ? actor.id : (currentException?.escalationOwnerId ?? nextException.escalationOwnerId),
        escalatedBy: actor.id,
        escalatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(normalizedException)
      store.filingSubmissionExceptions.set(normalizedException.id, normalizedException)
      const existingQueue =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      const updatedQueue = {
        ...existingQueue,
        status: "retry_pending" as const,
        externalDispatchState: "blocked_todo_firm" as const,
        operatorNotes: [
          ...existingQueue.operatorNotes,
          `${new Date(now).toISOString()} ${actor.id}: retry plan attached`,
        ],
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updatedQueue)
      store.filingDispatchQueue.set(updatedQueue.id, updatedQueue)
      const evidence = buildFilingTransportExecutionEvidenceRow(
        filingPackage,
        {
          sequenceNo: nextSequenceNo,
          outcome: "retry_plan_attached",
          transportOperatorId: actor.id,
          transportChannel: parsed.transportChannel,
          channelPayloadHash: parsed.channelPayloadHash,
          attachmentPointers: parsed.attachmentPointers,
          relatedReconciliationId: reconciliation?.id ?? null,
          relatedExceptionId: normalizedException.id,
          note: parsed.note,
        },
        { now }
      )
      await repos.filingTransportExecutionEvidence.upsert(evidence)
      store.filingTransportExecutionEvidence.set(evidence.id, evidence)
      store.audit.push({
        action: "filing_transport_execution_evidence_record",
        actorId: actor.id,
        target: evidence.id,
        classification: filingPackage.classification,
        reason: evidence.outcome,
      })
      store.audit.push({
        action: "filing_dispatch_closure_update",
        actorId: actor.id,
        target: updatedQueue.id,
        classification: filingPackage.classification,
        reason: "retry_plan_attached",
      })
      store.audit.push({
        action: "filing_submission_exception_escalate",
        actorId: actor.id,
        target: normalizedException.id,
        classification: filingPackage.classification,
        reason: normalizedException.severity,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attach_retry_plan",
        evidence: (await repos.filingTransportExecutionEvidence.get(evidence.id)) ?? evidence,
        dispatchQueue: (await repos.filingDispatchQueue.get(updatedQueue.id)) ?? updatedQueue,
        submissionException:
          (await repos.filingSubmissionExceptions.get(normalizedException.id)) ?? normalizedException,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "confirm_delivered") {
      if (!parsed.actorId || !parsed.packageId || !parsed.transportChannel || !parsed.channelPayloadHash) {
        return NextResponse.json(
          { error: "actorId, packageId, transportChannel, and channelPayloadHash are required" },
          { status: 400 }
        )
      }
      if (!isFilingTransportExecutionChannel(parsed.transportChannel)) {
        return NextResponse.json({ error: "invalid transportChannel" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "confirm_delivered requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm delivery confirm denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const evidenceRows = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const nextSequenceNo = evidenceRows.reduce((max, row) => Math.max(max, row.sequenceNo), 0) + 1
      const reconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const currentException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const resolvedException = currentException
        ? {
            ...currentException,
            status: "resolved" as const,
            resolvedBy: actor.id,
            resolvedAt: now,
            resolutionNotes: [
              ...currentException.resolutionNotes,
              `${new Date(now).toISOString()} ${actor.id}: deterministic delivery confirmed`,
            ],
            updatedAt: now,
          }
        : null
      if (resolvedException) {
        await repos.filingSubmissionExceptions.upsert(resolvedException)
        store.filingSubmissionExceptions.set(resolvedException.id, resolvedException)
      }
      if (reconciliation) {
        const nextReconciliation = {
          ...reconciliation,
          status: "reconciled" as const,
          notes: [
            ...reconciliation.notes,
            `${new Date(now).toISOString()} ${actor.id}: deterministic delivery confirmed`,
          ],
          updatedAt: now,
        }
        await repos.filingSubmissionReconciliation.upsert(nextReconciliation)
        store.filingSubmissionReconciliation.set(nextReconciliation.id, nextReconciliation)
      }
      const existingQueue =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      const updatedQueue = {
        ...existingQueue,
        status: "handoff_ready" as const,
        externalDispatchState: "ready_for_firm_dispatch" as const,
        operatorNotes: [
          ...existingQueue.operatorNotes,
          `${new Date(now).toISOString()} ${actor.id}: deterministic delivery confirmed`,
        ],
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updatedQueue)
      store.filingDispatchQueue.set(updatedQueue.id, updatedQueue)
      const evidence = buildFilingTransportExecutionEvidenceRow(
        filingPackage,
        {
          sequenceNo: nextSequenceNo,
          outcome: "confirm_delivered",
          transportOperatorId: actor.id,
          transportChannel: parsed.transportChannel,
          channelPayloadHash: parsed.channelPayloadHash,
          attachmentPointers: parsed.attachmentPointers,
          relatedReceiptId: parsed.relatedReceiptId?.trim() || null,
          relatedReconciliationId: reconciliation?.id ?? null,
          relatedExceptionId: resolvedException?.id ?? null,
          note: parsed.note,
        },
        { now }
      )
      await repos.filingTransportExecutionEvidence.upsert(evidence)
      store.filingTransportExecutionEvidence.set(evidence.id, evidence)
      store.audit.push({
        action: "filing_transport_execution_evidence_record",
        actorId: actor.id,
        target: evidence.id,
        classification: filingPackage.classification,
        reason: evidence.outcome,
      })
      store.audit.push({
        action: "filing_dispatch_closure_update",
        actorId: actor.id,
        target: updatedQueue.id,
        classification: filingPackage.classification,
        reason: "confirm_delivered",
      })
      if (resolvedException) {
        store.audit.push({
          action: "filing_submission_exception_resolve",
          actorId: actor.id,
          target: resolvedException.id,
          classification: filingPackage.classification,
          reason: "confirm_delivered",
        })
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "confirm_delivered",
        evidence: (await repos.filingTransportExecutionEvidence.get(evidence.id)) ?? evidence,
        dispatchQueue: (await repos.filingDispatchQueue.get(updatedQueue.id)) ?? updatedQueue,
        submissionException:
          resolvedException &&
          ((await repos.filingSubmissionExceptions.get(resolvedException.id)) ?? resolvedException),
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_breach") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "acknowledge_breach requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm digest acknowledge denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existingDigest =
        (await repos.filingSubmissionSlaDigests.get(filingSubmissionSlaDigestId(filingPackage.id))) ??
        null
      const exception = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const evidence = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const latestEvidence = [...evidence].sort((a, b) => b.createdAt - a.createdAt || b.sequenceNo - a.sequenceNo)[0] ?? null
      const deliveredEvidenceAt = evidence
        .filter((row) => row.outcome === "confirm_delivered")
        .reduce((max, row) => (row.createdAt > max ? row.createdAt : max), 0)
      const digest = buildSubmissionSlaDigestRow(filingPackage, {
        exception,
        latestEvidence,
        deliveredEvidenceAt: deliveredEvidenceAt > 0 ? deliveredEvidenceAt : null,
        existing: existingDigest,
        now,
      })
      if (digest.breachReasons.length === 0) {
        return NextResponse.json({ error: "no active SLA breach to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "breach acknowledged by partner"
      const updated = {
        ...digest,
        status: "acknowledged" as const,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        deferUntil: null,
        deferredBy: null,
        deferredAt: null,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingSubmissionSlaDigests.upsert(updated)
      store.filingSubmissionSlaDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_sla_digest_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.breachReasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_breach",
        digest: (await repos.filingSubmissionSlaDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "defer_window") {
      if (!parsed.actorId || !parsed.packageId || parsed.deferHours === undefined) {
        return NextResponse.json(
          { error: "actorId, packageId, and deferHours are required" },
          { status: 400 }
        )
      }
      const deferHours = Number(parsed.deferHours)
      if (!Number.isFinite(deferHours) || deferHours < 1 || deferHours > 168) {
        return NextResponse.json({ error: "deferHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "defer_window requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm digest defer denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const persistedDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const exception = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const evidence = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const latestEvidence = [...evidence].sort((a, b) => b.createdAt - a.createdAt || b.sequenceNo - a.sequenceNo)[0] ?? null
      const deliveredEvidenceAt = evidence
        .filter((row) => row.outcome === "confirm_delivered")
        .reduce((max, row) => (row.createdAt > max ? row.createdAt : max), 0)
      const existingDigest = buildSubmissionSlaDigestRow(filingPackage, {
        exception,
        latestEvidence,
        deliveredEvidenceAt: deliveredEvidenceAt > 0 ? deliveredEvidenceAt : null,
        existing: persistedDigest,
        now,
      })
      if (!existingDigest) {
        return NextResponse.json({ error: "sla digest not found for package" }, { status: 404 })
      }
      if (existingDigest.breachReasons.length === 0) {
        return NextResponse.json({ error: "cannot defer a cleared digest" }, { status: 422 })
      }
      const note = parsed.note?.trim() || `breach deferred by ${deferHours}h`
      const updated = {
        ...existingDigest,
        status: "deferred" as const,
        deferUntil: now + deferHours * 60 * 60 * 1000,
        deferredBy: actor.id,
        deferredAt: now,
        notes: [...existingDigest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingSubmissionSlaDigests.upsert(updated)
      store.filingSubmissionSlaDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_sla_digest_defer",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: String(deferHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "defer_window",
        digest: (await repos.filingSubmissionSlaDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "clear_digest") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "clear_digest requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm digest clear denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const persistedDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const exception = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const evidence = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const latestEvidence = [...evidence].sort((a, b) => b.createdAt - a.createdAt || b.sequenceNo - a.sequenceNo)[0] ?? null
      const deliveredEvidenceAt = evidence
        .filter((row) => row.outcome === "confirm_delivered")
        .reduce((max, row) => (row.createdAt > max ? row.createdAt : max), 0)
      const existingDigest = buildSubmissionSlaDigestRow(filingPackage, {
        exception,
        latestEvidence,
        deliveredEvidenceAt: deliveredEvidenceAt > 0 ? deliveredEvidenceAt : null,
        existing: persistedDigest,
        now,
      })
      if (!existingDigest) {
        return NextResponse.json({ error: "sla digest not found for package" }, { status: 404 })
      }
      const note = parsed.note?.trim() || "digest cleared by partner"
      const updated = {
        ...existingDigest,
        status: "cleared" as const,
        breachReasons: [],
        staleRetryPlan: false,
        deferUntil: null,
        clearedBy: actor.id,
        clearedAt: now,
        notes: [...existingDigest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingSubmissionSlaDigests.upsert(updated)
      store.filingSubmissionSlaDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_sla_digest_clear",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: "cleared",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "clear_digest",
        digest: (await repos.filingSubmissionSlaDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_primary_owner") {
      if (!parsed.actorId || !parsed.packageId || !parsed.primaryOwnerId) {
        return NextResponse.json(
          { error: "actorId, packageId, and primaryOwnerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "assign_primary_owner requires partner role" },
          { status: 403 }
        )
      }
      const primaryOwner = store.users.get(parsed.primaryOwnerId)
      if (!primaryOwner) {
        return NextResponse.json({ error: "unknown primary owner" }, { status: 404 })
      }
      if (primaryOwner.firmId !== actor.firmId || primaryOwner.role !== "partner") {
        return NextResponse.json(
          { error: "primary owner must be a partner in the same firm" },
          { status: 403 }
        )
      }
      const activeWindowHours =
        parsed.activeWindowHours === undefined ? 24 : Number(parsed.activeWindowHours)
      if (!Number.isFinite(activeWindowHours) || activeWindowHours < 1 || activeWindowHours > 336) {
        return NextResponse.json(
          { error: "activeWindowHours must be between 1 and 336" },
          { status: 400 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm rota assignment denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existing =
        (await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))) ??
        null
      const linkedException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const linkedDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const note = parsed.note?.trim() || `primary owner assigned to ${primaryOwner.id}`
      const reassignedPrimary = !!existing && existing.primaryOwnerId !== primaryOwner.id
      const base = buildFilingEscalationOwnerRotaRow(filingPackage, {
        now,
        existing,
        primaryOwnerId: primaryOwner.id,
        backupOwnerId: existing?.backupOwnerId ?? null,
        linkedExceptionId: linkedException?.id ?? null,
        linkedDigestId: linkedDigest?.id ?? null,
        activeWindowMs: activeWindowHours * 60 * 60 * 1000,
        actorId: actor.id,
        note,
      })
      const updated = {
        ...base,
        status: "active" as const,
        activeWindowStartAt: now,
        activeWindowEndAt: now + activeWindowHours * 60 * 60 * 1000,
        handoffRequired: reassignedPrimary && existing?.primaryOwnerId !== null,
        handoffAcknowledgedBy:
          reassignedPrimary && existing?.primaryOwnerId !== null ? null : base.handoffAcknowledgedBy,
        handoffAcknowledgedAt:
          reassignedPrimary && existing?.primaryOwnerId !== null ? null : base.handoffAcknowledgedAt,
        lastAssignedBy: actor.id,
        lastAssignedAt: now,
        revokedBy: null,
        revokedAt: null,
        updatedAt: now,
      }
      await repos.filingEscalationOwnerRota.upsert(updated)
      store.filingEscalationOwnerRota.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_rota_assign_primary",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: primaryOwner.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "assign_primary_owner",
        rota: (await repos.filingEscalationOwnerRota.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "set_backup_owner") {
      if (!parsed.actorId || !parsed.packageId || !parsed.backupOwnerId) {
        return NextResponse.json(
          { error: "actorId, packageId, and backupOwnerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "set_backup_owner requires partner role" }, { status: 403 })
      }
      const backupOwner = store.users.get(parsed.backupOwnerId)
      if (!backupOwner) {
        return NextResponse.json({ error: "unknown backup owner" }, { status: 404 })
      }
      if (backupOwner.firmId !== actor.firmId || backupOwner.role !== "partner") {
        return NextResponse.json(
          { error: "backup owner must be a partner in the same firm" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm rota backup denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existing =
        (await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))) ??
        null
      const linkedException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const linkedDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const note = parsed.note?.trim() || `backup owner set to ${backupOwner.id}`
      const backupChanged = !existing || existing.backupOwnerId !== backupOwner.id
      const base = buildFilingEscalationOwnerRotaRow(filingPackage, {
        now,
        existing,
        primaryOwnerId:
          existing?.primaryOwnerId ?? linkedException?.escalationOwnerId ?? linkedDigest?.outstandingOwnerId ?? null,
        backupOwnerId: backupOwner.id,
        linkedExceptionId: linkedException?.id ?? null,
        linkedDigestId: linkedDigest?.id ?? null,
        actorId: actor.id,
        note,
      })
      const handoffRequired = backupChanged && !!base.primaryOwnerId
      const updated = {
        ...base,
        status: "active" as const,
        handoffRequired,
        handoffAcknowledgedBy: handoffRequired ? null : base.handoffAcknowledgedBy,
        handoffAcknowledgedAt: handoffRequired ? null : base.handoffAcknowledgedAt,
        lastAssignedBy: actor.id,
        lastAssignedAt: now,
        revokedBy: null,
        revokedAt: null,
        updatedAt: now,
      }
      await repos.filingEscalationOwnerRota.upsert(updated)
      store.filingEscalationOwnerRota.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_rota_set_backup",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: backupOwner.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "set_backup_owner",
        rota: (await repos.filingEscalationOwnerRota.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_handoff") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_handoff requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm handoff acknowledge denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const existing = await repos.filingEscalationOwnerRota.get(
        filingEscalationOwnerRotaId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "escalation rota not found for package" }, { status: 404 })
      }
      if (existing.status === "revoked") {
        return NextResponse.json({ error: "cannot acknowledge a revoked assignment" }, { status: 422 })
      }
      if (existing.primaryOwnerId !== actor.id && existing.backupOwnerId !== actor.id) {
        return NextResponse.json({ error: "actor must be assigned in rota to acknowledge handoff" }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const note = parsed.note?.trim() || "handoff acknowledged"
      const updated = {
        ...existing,
        status: "handoff_acknowledged" as const,
        handoffRequired: false,
        handoffAcknowledgedBy: actor.id,
        handoffAcknowledgedAt: now,
        notes: [...existing.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationOwnerRota.upsert(updated)
      store.filingEscalationOwnerRota.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_rota_acknowledge_handoff",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: "handoff_acknowledged",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_handoff",
        rota: (await repos.filingEscalationOwnerRota.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "revoke_assignment") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "revoke_assignment requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm rota revoke denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const existing = await repos.filingEscalationOwnerRota.get(
        filingEscalationOwnerRotaId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "escalation rota not found for package" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const note = parsed.note?.trim() || "assignment revoked"
      const updated = {
        ...existing,
        status: "revoked" as const,
        primaryOwnerId: null,
        backupOwnerId: null,
        activeWindowEndAt: now,
        handoffRequired: false,
        handoffAcknowledgedBy: null,
        handoffAcknowledgedAt: null,
        revokedBy: actor.id,
        revokedAt: now,
        notes: [...existing.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationOwnerRota.upsert(updated)
      store.filingEscalationOwnerRota.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_rota_revoke_assignment",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: "revoked",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "revoke_assignment",
        rota: (await repos.filingEscalationOwnerRota.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_owner_drift") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_owner_drift requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json(
          { error: "cross-firm workload acknowledgement denied" },
          { status: 403 }
        )
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const rota = await repos.filingEscalationOwnerRota.get(
        filingEscalationOwnerRotaId(filingPackage.id)
      )
      const slaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const existing = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(
        await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      )
      const ownerLoadCount =
        rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
      const digest = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota,
        slaDigest,
        ownerLoadCount,
        existing,
        now,
      })
      if (digest.alertReasons.length === 0) {
        return NextResponse.json({ error: "no active workload alert to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "owner drift acknowledged"
      const updated = {
        ...digest,
        status: "acknowledged" as const,
        snoozeUntil: null,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationWorkloadDigests.upsert(updated)
      store.filingEscalationWorkloadDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_workload_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.alertReasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_owner_drift",
        workloadDigest: (await repos.filingEscalationWorkloadDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "rebalance_assignment") {
      if (!parsed.actorId || !parsed.packageId || !parsed.newPrimaryOwnerId) {
        return NextResponse.json(
          { error: "actorId, packageId, and newPrimaryOwnerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "rebalance_assignment requires partner role" }, { status: 403 })
      }
      const newPrimary = store.users.get(parsed.newPrimaryOwnerId)
      if (!newPrimary) {
        return NextResponse.json({ error: "unknown new primary owner" }, { status: 404 })
      }
      if (newPrimary.firmId !== actor.firmId || newPrimary.role !== "partner") {
        return NextResponse.json(
          { error: "newPrimaryOwnerId must be a partner in the same firm" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm workload rebalance denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existingRota =
        (await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))) ??
        null
      const linkedException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const linkedSlaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const changedOwner = existingRota?.primaryOwnerId !== newPrimary.id
      const note = parsed.note?.trim() || `workload rebalanced to ${newPrimary.id}`
      const baseRota = buildFilingEscalationOwnerRotaRow(filingPackage, {
        now,
        existing: existingRota,
        primaryOwnerId: newPrimary.id,
        backupOwnerId: existingRota?.backupOwnerId ?? null,
        linkedExceptionId: linkedException?.id ?? null,
        linkedDigestId: linkedSlaDigest?.id ?? null,
        actorId: actor.id,
        note,
      })
      const updatedRota = {
        ...baseRota,
        status: "active" as const,
        handoffRequired: changedOwner && existingRota?.primaryOwnerId !== null,
        handoffAcknowledgedBy: null,
        handoffAcknowledgedAt: null,
        lastAssignedBy: actor.id,
        lastAssignedAt: now,
        revokedBy: null,
        revokedAt: null,
        updatedAt: now,
      }
      await repos.filingEscalationOwnerRota.upsert(updatedRota)
      store.filingEscalationOwnerRota.set(updatedRota.id, updatedRota)
      const allRotaRows = await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(allRotaRows)
      const existingDigest = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const ownerLoadCount =
        updatedRota.primaryOwnerId ? (ownerLoadByOwner.get(updatedRota.primaryOwnerId) ?? 0) : 0
      const computedDigest = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota: updatedRota,
        slaDigest: linkedSlaDigest,
        ownerLoadCount,
        existing: existingDigest,
        now,
      })
      const digestNote = `assignment rebalanced to ${newPrimary.id}`
      const updatedDigest = {
        ...computedDigest,
        status: computedDigest.alertReasons.length === 0 ? ("cleared" as const) : ("acknowledged" as const),
        snoozeUntil: null,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        rebalancedBy: actor.id,
        rebalancedAt: now,
        notes: [...computedDigest.notes, `${new Date(now).toISOString()} ${actor.id}: ${digestNote}`],
        updatedAt: now,
      }
      await repos.filingEscalationWorkloadDigests.upsert(updatedDigest)
      store.filingEscalationWorkloadDigests.set(updatedDigest.id, updatedDigest)
      store.audit.push({
        action: "filing_escalation_workload_rebalance",
        actorId: actor.id,
        target: updatedDigest.id,
        classification: filingPackage.classification,
        reason: newPrimary.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "rebalance_assignment",
        rota: (await repos.filingEscalationOwnerRota.get(updatedRota.id)) ?? updatedRota,
        workloadDigest:
          (await repos.filingEscalationWorkloadDigests.get(updatedDigest.id)) ?? updatedDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "snooze_workload_alert") {
      if (!parsed.actorId || !parsed.packageId || parsed.snoozeHours === undefined) {
        return NextResponse.json(
          { error: "actorId, packageId, and snoozeHours are required" },
          { status: 400 }
        )
      }
      const snoozeHours = Number(parsed.snoozeHours)
      if (!Number.isFinite(snoozeHours) || snoozeHours < 1 || snoozeHours > 168) {
        return NextResponse.json({ error: "snoozeHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "snooze_workload_alert requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm workload snooze denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const rota = await repos.filingEscalationOwnerRota.get(
        filingEscalationOwnerRotaId(filingPackage.id)
      )
      const slaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const existing = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(
        await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      )
      const ownerLoadCount =
        rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
      const digest = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota,
        slaDigest,
        ownerLoadCount,
        existing,
        now,
      })
      if (digest.alertReasons.length === 0) {
        return NextResponse.json({ error: "no active workload alert to snooze" }, { status: 422 })
      }
      const note = parsed.note?.trim() || `workload alert snoozed for ${snoozeHours}h`
      const updated = {
        ...digest,
        status: "snoozed" as const,
        snoozeUntil: now + snoozeHours * 60 * 60 * 1000,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationWorkloadDigests.upsert(updated)
      store.filingEscalationWorkloadDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_workload_snooze",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: String(snoozeHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "snooze_workload_alert",
        workloadDigest: (await repos.filingEscalationWorkloadDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "set_policy_baseline") {
      if (!parsed.actorId) {
        return NextResponse.json({ error: "actorId is required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "set_policy_baseline requires partner role" }, { status: 403 })
      }
      const ownerLoadThreshold =
        parsed.ownerLoadThreshold === undefined ? undefined : Number(parsed.ownerLoadThreshold)
      const handoffSlaHours =
        parsed.handoffSlaHours === undefined ? undefined : Number(parsed.handoffSlaHours)
      const waiverWindowHours =
        parsed.waiverWindowHours === undefined ? undefined : Number(parsed.waiverWindowHours)
      if (
        ownerLoadThreshold !== undefined &&
        (!Number.isFinite(ownerLoadThreshold) || ownerLoadThreshold < 1 || ownerLoadThreshold > 20)
      ) {
        return NextResponse.json({ error: "ownerLoadThreshold must be between 1 and 20" }, { status: 400 })
      }
      if (
        handoffSlaHours !== undefined &&
        (!Number.isFinite(handoffSlaHours) || handoffSlaHours < 1 || handoffSlaHours > 72)
      ) {
        return NextResponse.json({ error: "handoffSlaHours must be between 1 and 72" }, { status: 400 })
      }
      if (
        waiverWindowHours !== undefined &&
        (!Number.isFinite(waiverWindowHours) || waiverWindowHours < 1 || waiverWindowHours > 168)
      ) {
        return NextResponse.json({ error: "waiverWindowHours must be between 1 and 168" }, { status: 400 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      let filingPackage: Awaited<ReturnType<typeof repos.filings.get>> | null = null
      if (parsed.packageId) {
        filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
        if (!filingPackage) {
          return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
        }
        if (filingPackage.firmId !== actor.firmId) {
          return NextResponse.json({ error: "cross-firm policy baseline denied" }, { status: 403 })
        }
        const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
        if (!permission.allow) {
          return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
        }
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const id = filingEscalationPolicyBaselineId({ firmId: actor.firmId, packageId: parsed.packageId ?? null })
      const existing = await repos.filingEscalationPolicyBaselines.get(id)
      const policy = buildFilingEscalationPolicyBaselineRow({
        firmId: actor.firmId,
        actorId: actor.id,
        packageId: filingPackage?.id ?? null,
        matterId: filingPackage?.matterId ?? null,
        classification: filingPackage?.classification ?? "internal",
        ownerLoadThreshold: ownerLoadThreshold === undefined ? undefined : ownerLoadThreshold,
        handoffSlaMs: handoffSlaHours === undefined ? undefined : handoffSlaHours * 60 * 60 * 1000,
        waiverWindowMs: waiverWindowHours === undefined ? undefined : waiverWindowHours * 60 * 60 * 1000,
        now,
        existing,
        note: parsed.note ?? null,
      })
      await repos.filingEscalationPolicyBaselines.upsert(policy)
      store.filingEscalationPolicyBaselines.set(policy.id, policy)
      store.audit.push({
        action: "filing_escalation_policy_set",
        actorId: actor.id,
        target: policy.id,
        classification: policy.classification,
        reason: policy.scope,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "set_policy_baseline",
        policy: (await repos.filingEscalationPolicyBaselines.get(policy.id)) ?? policy,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "grant_breach_waiver") {
      if (!parsed.actorId || !parsed.packageId || !parsed.reason?.trim()) {
        return NextResponse.json(
          { error: "actorId, packageId, and reason are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "grant_breach_waiver requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm waiver grant denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(
        filingPackage.id,
        packageOverrides,
        defaultPolicy
      )
      const durationHours =
        parsed.durationHours === undefined ? policy.waiverWindowMs / (60 * 60 * 1000) : Number(parsed.durationHours)
      if (!Number.isFinite(durationHours) || durationHours < 1 || durationHours > 168) {
        return NextResponse.json({ error: "durationHours must be between 1 and 168" }, { status: 400 })
      }
      const existingWaivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const activeWaiver = existingWaivers.find((row) => row.status === "active" && row.expiresAt > now) ?? null
      if (activeWaiver) {
        return NextResponse.json({ error: "an active waiver already exists for this package" }, { status: 409 })
      }
      const sequenceNo = existingWaivers.length + 1
      const slaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const existingWorkload = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const rota = await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(
        await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      )
      const ownerLoadCount =
        rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
      const baseWorkload = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota,
        slaDigest,
        ownerLoadCount,
        ownerLoadThreshold: policy.ownerLoadThreshold,
        handoffSlaMs: policy.handoffSlaMs,
        existing: existingWorkload,
        now,
      })
      const waiver = buildFilingEscalationWaiverLedgerRow(filingPackage, {
        actorId: actor.id,
        sequenceNo,
        reason: parsed.reason,
        durationMs: durationHours * 60 * 60 * 1000,
        now,
        linkedSlaDigestId: slaDigest?.id ?? null,
        linkedWorkloadDigestId: baseWorkload.id,
        note: parsed.note ?? null,
      })
      await repos.filingEscalationBreachWaivers.upsert(waiver)
      store.filingEscalationBreachWaivers.set(waiver.id, waiver)
      const existingExpiryDigest = await repos.filingEscalationWaiverExpiryDigests.get(
        filingEscalationWaiverExpiryDigestId(filingPackage.id)
      )
      const waiverExpiryComputed = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
        activeWaiver: waiver,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingExpiryDigest,
        now,
      })
      const waiverExpiryDigest = {
        ...waiverExpiryComputed,
        status: waiverExpiryComputed.status,
        extendedBy: null,
        extendedAt: null,
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationWaiverExpiryDigests.upsert(waiverExpiryDigest)
      store.filingEscalationWaiverExpiryDigests.set(waiverExpiryDigest.id, waiverExpiryDigest)
      const workloadDigest =
        baseWorkload.alertReasons.length > 0
          ? {
              ...baseWorkload,
              status: "snoozed" as const,
              snoozeUntil: waiver.expiresAt,
              notes: [
                ...baseWorkload.notes,
                `${new Date(now).toISOString()} ${actor.id}: waiver granted (${waiver.id})`,
              ],
              updatedAt: now,
              lastEvaluatedAt: now,
            }
          : baseWorkload
      await repos.filingEscalationWorkloadDigests.upsert(workloadDigest)
      store.filingEscalationWorkloadDigests.set(workloadDigest.id, workloadDigest)
      store.audit.push({
        action: "filing_escalation_waiver_grant",
        actorId: actor.id,
        target: waiver.id,
        classification: filingPackage.classification,
        reason: waiver.reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "grant_breach_waiver",
        waiver: (await repos.filingEscalationBreachWaivers.get(waiver.id)) ?? waiver,
        waiverExpiryDigest:
          (await repos.filingEscalationWaiverExpiryDigests.get(waiverExpiryDigest.id)) ??
          waiverExpiryDigest,
        workloadDigest:
          (await repos.filingEscalationWorkloadDigests.get(workloadDigest.id)) ?? workloadDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "revoke_breach_waiver") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "revoke_breach_waiver requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm waiver revoke denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const target =
        (parsed.waiverId
          ? waivers.find((row) => row.id === parsed.waiverId)
          : [...waivers]
              .filter((row) => row.status === "active" && row.expiresAt > now)
              .sort((a, b) => b.updatedAt - a.updatedAt)[0]) ?? null
      if (!target) {
        return NextResponse.json({ error: "no matching active waiver found for package" }, { status: 404 })
      }
      const revoked = {
        ...target,
        status: "revoked" as const,
        revokedBy: actor.id,
        revokedAt: now,
        notes: [
          ...target.notes,
          `${new Date(now).toISOString()} ${actor.id}: ${parsed.note?.trim() || "waiver revoked"}`,
        ],
        updatedAt: now,
      }
      await repos.filingEscalationBreachWaivers.upsert(revoked)
      store.filingEscalationBreachWaivers.set(revoked.id, revoked)
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(
        filingPackage.id,
        packageOverrides,
        defaultPolicy
      )
      const rota = await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))
      const slaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const existingWorkload = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(
        await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      )
      const ownerLoadCount =
        rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
      const recomputed = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota,
        slaDigest,
        ownerLoadCount,
        ownerLoadThreshold: policy.ownerLoadThreshold,
        handoffSlaMs: policy.handoffSlaMs,
        existing: existingWorkload,
        now,
      })
      const workloadDigest = {
        ...recomputed,
        status:
          recomputed.alertReasons.length === 0
            ? ("cleared" as const)
            : ("open_alert" as const),
        snoozeUntil: null,
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationWorkloadDigests.upsert(workloadDigest)
      store.filingEscalationWorkloadDigests.set(workloadDigest.id, workloadDigest)
      const remainingActiveWaiver =
        [...waivers]
          .filter(
            (row) =>
              row.id !== revoked.id &&
              row.status === "active" &&
              row.expiresAt > now
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const existingExpiryDigest = await repos.filingEscalationWaiverExpiryDigests.get(
        filingEscalationWaiverExpiryDigestId(filingPackage.id)
      )
      const waiverExpiryDigest = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
        activeWaiver: remainingActiveWaiver,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingExpiryDigest,
        now,
      })
      await repos.filingEscalationWaiverExpiryDigests.upsert(waiverExpiryDigest)
      store.filingEscalationWaiverExpiryDigests.set(waiverExpiryDigest.id, waiverExpiryDigest)
      store.audit.push({
        action: "filing_escalation_waiver_revoke",
        actorId: actor.id,
        target: revoked.id,
        classification: filingPackage.classification,
        reason: revoked.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "revoke_breach_waiver",
        waiver: (await repos.filingEscalationBreachWaivers.get(revoked.id)) ?? revoked,
        waiverExpiryDigest:
          (await repos.filingEscalationWaiverExpiryDigests.get(waiverExpiryDigest.id)) ??
          waiverExpiryDigest,
        workloadDigest:
          (await repos.filingEscalationWorkloadDigests.get(workloadDigest.id)) ?? workloadDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "record_variance_remediation") {
      const decision = parsed.decision ?? null
      if (
        !parsed.actorId ||
        !parsed.packageId ||
        !parsed.justification?.trim() ||
        !isFilingEscalationVarianceRemediationDecision(decision) ||
        parsed.expiresInHours === undefined
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, packageId, decision, justification, and expiresInHours are required",
          },
          { status: 400 }
        )
      }
      const expiresInHours = Number(parsed.expiresInHours)
      if (!Number.isFinite(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
        return NextResponse.json({ error: "expiresInHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "record_variance_remediation requires partner role" },
          { status: 403 }
        )
      }
      // Four-eyes: the second approver may not be the actor. TODO(E-24 chain
      // freeze): the second approval is still asserted by id in this request
      // rather than confirmed by the approver's own authenticated session; that
      // flow is out of scope while this chain is slated for freeze.
      if (parsed.secondApproverId && parsed.secondApproverId === actor.id) {
        return NextResponse.json(
          { error: "second approver must be a different partner", code: "self_approval_forbidden" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm remediation denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const secondApprover =
        parsed.secondApproverId !== undefined ? store.users.get(parsed.secondApproverId) : null
      if (parsed.secondApproverId && !secondApprover) {
        return NextResponse.json({ error: "unknown second approver" }, { status: 404 })
      }
      if (secondApprover) {
        if (
          secondApprover.firmId !== actor.firmId ||
          secondApprover.role !== "partner"
        ) {
          return NextResponse.json(
            { error: "second approver must be a partner in the same firm" },
            { status: 403 }
          )
        }
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      if (requiresSecondApproverForRemediationDecision(decision) && !secondApprover) {
        return NextResponse.json(
          { error: "temporary_override remediation requires a second approver" },
          { status: 422 }
        )
      }
      const existingRemediations = await repos.filingEscalationVarianceRemediations.listByPackageId(
        filingPackage.id
      )
      for (const row of existingRemediations) {
        if (row.status !== "active") continue
        const superseded = { ...row, status: "superseded" as const, updatedAt: now }
        await repos.filingEscalationVarianceRemediations.upsert(superseded)
        store.filingEscalationVarianceRemediations.set(superseded.id, superseded)
      }
      const policyVarianceDigest = await repos.filingEscalationPolicyVarianceDigests.get(
        filingEscalationPolicyVarianceDigestId(filingPackage.id)
      )
      const remediation = buildFilingEscalationVarianceRemediationRow(filingPackage, {
        sequenceNo: existingRemediations.length + 1,
        decision,
        justification: parsed.justification,
        actorId: actor.id,
        expiresAt: now + expiresInHours * 60 * 60 * 1000,
        now,
        linkedPolicyVarianceDigestId: policyVarianceDigest?.id ?? null,
        linkedPolicyId: policy.sourcePolicyId,
        secondApproverId: secondApprover?.id ?? null,
        note: parsed.note ?? null,
      })
      await repos.filingEscalationVarianceRemediations.upsert(remediation)
      store.filingEscalationVarianceRemediations.set(remediation.id, remediation)
      const lifecycle = buildFilingEscalationRemediationLifecycleRow(filingPackage, remediation, {
        actorId: actor.id,
        now,
        note: "remediation lifecycle opened",
      })
      await repos.filingEscalationRemediationLifecycles.upsert(lifecycle)
      store.filingEscalationRemediationLifecycles.set(lifecycle.id, lifecycle)
      if (parsed.decision === "rollback") {
        const rollbackOwnerLoad = defaultPolicy?.ownerLoadThreshold ?? DEFAULT_ESCALATION_OWNER_LOAD_THRESHOLD
        const rollbackHandoffSla = defaultPolicy?.handoffSlaMs ?? DEFAULT_ESCALATION_HANDOFF_SLA_MS
        const rollbackWaiverWindow = defaultPolicy?.waiverWindowMs ?? DEFAULT_ESCALATION_WAIVER_WINDOW_MS
        const rollbackPolicy = buildFilingEscalationPolicyBaselineRow({
          firmId: actor.firmId,
          actorId: actor.id,
          packageId: filingPackage.id,
          matterId: filingPackage.matterId,
          classification: filingPackage.classification,
          ownerLoadThreshold: rollbackOwnerLoad,
          handoffSlaMs: rollbackHandoffSla,
          waiverWindowMs: rollbackWaiverWindow,
          note: "rollback remediation recorded",
          now,
        })
        await repos.filingEscalationPolicyBaselines.upsert(rollbackPolicy)
        store.filingEscalationPolicyBaselines.set(rollbackPolicy.id, rollbackPolicy)
      }
      const recomputedVariance = buildFilingEscalationPolicyVarianceDigestRow(filingPackage, {
        firmDefaultPolicy:
          defaultPolicy ? policyRows.find((row) => row.id === defaultPolicy.id) ?? null : null,
        packagePolicy: latestByUpdatedAt(
          policyRows.filter((row) => row.scope === "package_override" && row.packageId === filingPackage.id)
        ),
        existing: policyVarianceDigest,
        now,
      })
      const varianceDigest =
        remediation.decision === "accepted_risk" || remediation.decision === "temporary_override"
          ? {
              ...recomputedVariance,
              status: "snoozed" as const,
              snoozeUntil: remediation.expiresAt,
              updatedAt: now,
              lastEvaluatedAt: now,
              notes: [
                ...recomputedVariance.notes,
                `${new Date(now).toISOString()} ${actor.id}: remediation recorded (${remediation.id})`,
              ],
            }
          : recomputedVariance
      await repos.filingEscalationPolicyVarianceDigests.upsert(varianceDigest)
      store.filingEscalationPolicyVarianceDigests.set(varianceDigest.id, varianceDigest)
      store.audit.push({
        action: "filing_variance_remediation_record",
        actorId: actor.id,
        target: remediation.id,
        classification: filingPackage.classification,
        reason: remediation.decision,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "record_variance_remediation",
        remediation:
          (await repos.filingEscalationVarianceRemediations.get(remediation.id)) ?? remediation,
        remediationLifecycle:
          (await repos.filingEscalationRemediationLifecycles.get(lifecycle.id)) ?? lifecycle,
        policyVarianceDigest:
          (await repos.filingEscalationPolicyVarianceDigests.get(varianceDigest.id)) ??
          varianceDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_remediation_closure") {
      const closureOutcome = parsed.closureOutcome ?? null
      if (
        !parsed.actorId ||
        !parsed.packageId ||
        !isFilingEscalationRemediationClosureOutcome(closureOutcome) ||
        !parsed.note?.trim()
      ) {
        return NextResponse.json(
          { error: "actorId, packageId, closureOutcome, and note are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_remediation_closure requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm remediation closure denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const lifecycles = await repos.filingEscalationRemediationLifecycles.listByPackageId(filingPackage.id)
      const targetLifecycle =
        (parsed.remediationId
          ? lifecycles.find(
              (row) => row.remediationId === parsed.remediationId && row.status === "open"
            )
          : [...lifecycles]
              .filter((row) => row.status === "open")
              .sort((a, b) => b.updatedAt - a.updatedAt)[0]) ?? null
      if (!targetLifecycle) {
        return NextResponse.json({ error: "no open remediation lifecycle found" }, { status: 404 })
      }
      const closureNote = parsed.note.trim()
      const closedLifecycle = {
        ...targetLifecycle,
        status: "closure_attested" as const,
        closureOutcome,
        closureAttestedBy: actor.id,
        closureAttestedAt: now,
        notes: [
          ...targetLifecycle.notes,
          `${new Date(now).toISOString()} ${actor.id}: closure ${closureOutcome} ${closureNote}`,
        ],
        updatedAt: now,
      }
      await repos.filingEscalationRemediationLifecycles.upsert(closedLifecycle)
      store.filingEscalationRemediationLifecycles.set(closedLifecycle.id, closedLifecycle)
      const remediation = await repos.filingEscalationVarianceRemediations.get(targetLifecycle.remediationId)
      if (remediation) {
        const updatedRemediation = {
          ...remediation,
          status: remediationStatusFromClosureOutcome(closureOutcome),
          updatedAt: now,
        }
        await repos.filingEscalationVarianceRemediations.upsert(updatedRemediation)
        store.filingEscalationVarianceRemediations.set(updatedRemediation.id, updatedRemediation)
      }
      const activeRemediation =
        [...(await repos.filingEscalationVarianceRemediations.listByPackageId(filingPackage.id))]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const pendingClosureLifecycle = latestByUpdatedAt(
        (await repos.filingEscalationRemediationLifecycles.listByPackageId(filingPackage.id)).filter(
          (row) => row.status === "open"
        )
      )
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const existingDigest = await repos.filingEscalationRemediationExpiryDigests.get(
        filingEscalationRemediationExpiryDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationRemediationExpiryDigestRow(filingPackage, {
        activeRemediation,
        pendingClosureLifecycle,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingDigest,
        now,
      })
      await repos.filingEscalationRemediationExpiryDigests.upsert(digest)
      store.filingEscalationRemediationExpiryDigests.set(digest.id, digest)
      store.audit.push({
        action: "filing_remediation_closure_attest",
        actorId: actor.id,
        target: closedLifecycle.id,
        classification: filingPackage.classification,
        reason: parsed.closureOutcome,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_remediation_closure",
        remediationLifecycle:
          (await repos.filingEscalationRemediationLifecycles.get(closedLifecycle.id)) ??
          closedLifecycle,
        remediationExpiryDigest:
          (await repos.filingEscalationRemediationExpiryDigests.get(digest.id)) ?? digest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_remediation_expiry") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_remediation_expiry requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm remediation expiry denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const remediations = await repos.filingEscalationVarianceRemediations.listByPackageId(filingPackage.id)
      for (const row of remediations) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationVarianceRemediations.upsert(expired)
          store.filingEscalationVarianceRemediations.set(expired.id, expired)
        }
      }
      const activeRemediation =
        [...(await repos.filingEscalationVarianceRemediations.listByPackageId(filingPackage.id))]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const pendingClosureLifecycle = latestByUpdatedAt(
        (await repos.filingEscalationRemediationLifecycles.listByPackageId(filingPackage.id)).filter(
          (row) => row.status === "open"
        )
      )
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const existing = await repos.filingEscalationRemediationExpiryDigests.get(
        filingEscalationRemediationExpiryDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationRemediationExpiryDigestRow(filingPackage, {
        activeRemediation,
        pendingClosureLifecycle,
        linkedPolicyId: policy.sourcePolicyId,
        existing,
        now,
      })
      if (digest.reasons.length === 0) {
        return NextResponse.json({ error: "no remediation expiry alert to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "remediation expiry acknowledged"
      const updated = {
        ...digest,
        status: "acknowledged" as const,
        snoozeUntil: null,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationRemediationExpiryDigests.upsert(updated)
      store.filingEscalationRemediationExpiryDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_remediation_expiry_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.reasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_remediation_expiry",
        remediationExpiryDigest:
          (await repos.filingEscalationRemediationExpiryDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "snooze_remediation_expiry") {
      if (!parsed.actorId || !parsed.packageId || parsed.snoozeHours === undefined) {
        return NextResponse.json(
          { error: "actorId, packageId, and snoozeHours are required" },
          { status: 400 }
        )
      }
      const snoozeHours = Number(parsed.snoozeHours)
      if (!Number.isFinite(snoozeHours) || snoozeHours < 1 || snoozeHours > 168) {
        return NextResponse.json({ error: "snoozeHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "snooze_remediation_expiry requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm remediation expiry snooze denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const remediations = await repos.filingEscalationVarianceRemediations.listByPackageId(filingPackage.id)
      for (const row of remediations) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationVarianceRemediations.upsert(expired)
          store.filingEscalationVarianceRemediations.set(expired.id, expired)
        }
      }
      const activeRemediation =
        [...(await repos.filingEscalationVarianceRemediations.listByPackageId(filingPackage.id))]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const pendingClosureLifecycle = latestByUpdatedAt(
        (await repos.filingEscalationRemediationLifecycles.listByPackageId(filingPackage.id)).filter(
          (row) => row.status === "open"
        )
      )
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const existing = await repos.filingEscalationRemediationExpiryDigests.get(
        filingEscalationRemediationExpiryDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationRemediationExpiryDigestRow(filingPackage, {
        activeRemediation,
        pendingClosureLifecycle,
        linkedPolicyId: policy.sourcePolicyId,
        existing,
        now,
      })
      if (digest.reasons.length === 0) {
        return NextResponse.json({ error: "no remediation expiry alert to snooze" }, { status: 422 })
      }
      const note = parsed.note?.trim() || `remediation expiry snoozed for ${snoozeHours}h`
      const updated = {
        ...digest,
        status: "snoozed" as const,
        snoozeUntil: now + snoozeHours * 60 * 60 * 1000,
        acknowledgedBy: null,
        acknowledgedAt: null,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationRemediationExpiryDigests.upsert(updated)
      store.filingEscalationRemediationExpiryDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_remediation_expiry_snooze",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: String(snoozeHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "snooze_remediation_expiry",
        remediationExpiryDigest:
          (await repos.filingEscalationRemediationExpiryDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_rollover_breach") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "acknowledge_rollover_breach requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm rollover breach denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      for (const row of waivers) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
        }
      }
      const activeWaiver =
        [...(await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id))]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const latestAttestation = activeWaiver
        ? latestByUpdatedAt(
            (await repos.filingEscalationWaiverRolloverAttestations.listByPackageId(filingPackage.id)).filter(
              (row) => row.waiverId === activeWaiver.id
            )
          )
        : null
      const existing = await repos.filingEscalationRolloverBreachWatches.get(
        filingEscalationRolloverBreachWatchId(filingPackage.id)
      )
      const watch = buildFilingEscalationRolloverBreachWatchRow(filingPackage, {
        activeWaiver,
        policyCapExpiresAt: activeWaiver ? activeWaiver.grantedAt + policy.waiverWindowMs : null,
        latestAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        existing,
        now,
      })
      if (watch.reasons.length === 0) {
        return NextResponse.json({ error: "no rollover breach watch to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "rollover breach acknowledged"
      const updated = {
        ...watch,
        status: "acknowledged" as const,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...watch.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationRolloverBreachWatches.upsert(updated)
      store.filingEscalationRolloverBreachWatches.set(updated.id, updated)
      store.audit.push({
        action: "filing_rollover_breach_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.reasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_rollover_breach",
        rolloverBreachWatch:
          (await repos.filingEscalationRolloverBreachWatches.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reaffirm_rollover_attestation") {
      if (!parsed.actorId || !parsed.packageId || !parsed.note?.trim()) {
        return NextResponse.json(
          { error: "actorId, packageId, and note are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "reaffirm_rollover_attestation requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm rollover reaffirmation denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const activeWaiver =
        (parsed.waiverId
          ? waivers.find((row) => row.id === parsed.waiverId && row.status === "active" && row.expiresAt > now)
          : [...waivers]
              .filter((row) => row.status === "active" && row.expiresAt > now)
              .sort((a, b) => b.updatedAt - a.updatedAt)[0]) ?? null
      if (!activeWaiver) {
        return NextResponse.json({ error: "no active waiver found for reaffirmation" }, { status: 404 })
      }
      const attestations = await repos.filingEscalationWaiverRolloverAttestations.listByPackageId(
        filingPackage.id
      )
      const latestAttestation =
        [...attestations]
          .filter((row) => row.waiverId === activeWaiver.id)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      if (!latestAttestation) {
        return NextResponse.json({ error: "no rollover attestation found to reaffirm" }, { status: 404 })
      }
      const reaffirmationText = parsed.note.trim()
      const updatedAttestation = {
        ...latestAttestation,
        notes: [
          ...latestAttestation.notes,
          `${new Date(now).toISOString()} ${actor.id}: reaffirmation ${reaffirmationText}`,
        ],
        updatedAt: now,
      }
      await repos.filingEscalationWaiverRolloverAttestations.upsert(updatedAttestation)
      store.filingEscalationWaiverRolloverAttestations.set(updatedAttestation.id, updatedAttestation)
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const existingWatch = await repos.filingEscalationRolloverBreachWatches.get(
        filingEscalationRolloverBreachWatchId(filingPackage.id)
      )
      const watch = buildFilingEscalationRolloverBreachWatchRow(filingPackage, {
        activeWaiver,
        policyCapExpiresAt: activeWaiver.grantedAt + policy.waiverWindowMs,
        latestAttestation: updatedAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingWatch,
        now,
      })
      await repos.filingEscalationRolloverBreachWatches.upsert(watch)
      store.filingEscalationRolloverBreachWatches.set(watch.id, watch)
      const warningThresholdMs = Math.max(HOUR_MS, Math.floor(policy.waiverWindowMs / 2))
      const breachThresholdMs = Math.max(2 * HOUR_MS, policy.waiverWindowMs)
      const existingSla = await repos.filingEscalationRolloverReaffirmationSlas.get(
        filingEscalationRolloverReaffirmationSlaId(filingPackage.id)
      )
      const reaffirmationSla = buildFilingEscalationRolloverReaffirmationSlaRow(filingPackage, {
        activeWaiver,
        policyCapExpiresAt: activeWaiver.grantedAt + policy.waiverWindowMs,
        latestAttestation: updatedAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        warningThresholdMs,
        breachThresholdMs,
        existing: existingSla,
        now,
      })
      await repos.filingEscalationRolloverReaffirmationSlas.upsert(reaffirmationSla)
      store.filingEscalationRolloverReaffirmationSlas.set(reaffirmationSla.id, reaffirmationSla)
      store.audit.push({
        action: "filing_rollover_reaffirmation_record",
        actorId: actor.id,
        target: updatedAttestation.id,
        classification: filingPackage.classification,
        reason: activeWaiver.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "reaffirm_rollover_attestation",
        rolloverAttestation:
          (await repos.filingEscalationWaiverRolloverAttestations.get(updatedAttestation.id)) ??
          updatedAttestation,
        rolloverBreachWatch:
          (await repos.filingEscalationRolloverBreachWatches.get(watch.id)) ?? watch,
        rolloverReaffirmationSla:
          (await repos.filingEscalationRolloverReaffirmationSlas.get(reaffirmationSla.id)) ??
          reaffirmationSla,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_rollover_reaffirmation_sla") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_rollover_reaffirmation_sla requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm reaffirmation SLA denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const activeWaiver =
        [...waivers]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const latestAttestation = activeWaiver
        ? latestByUpdatedAt(
            (await repos.filingEscalationWaiverRolloverAttestations.listByPackageId(filingPackage.id)).filter(
              (row) => row.waiverId === activeWaiver.id
            )
          )
        : null
      const warningThresholdMs = Math.max(HOUR_MS, Math.floor(policy.waiverWindowMs / 2))
      const breachThresholdMs = Math.max(2 * HOUR_MS, policy.waiverWindowMs)
      const existing = await repos.filingEscalationRolloverReaffirmationSlas.get(
        filingEscalationRolloverReaffirmationSlaId(filingPackage.id)
      )
      const row = buildFilingEscalationRolloverReaffirmationSlaRow(filingPackage, {
        activeWaiver,
        policyCapExpiresAt: activeWaiver ? activeWaiver.grantedAt + policy.waiverWindowMs : null,
        latestAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        warningThresholdMs,
        breachThresholdMs,
        existing,
        now,
      })
      if (row.reasons.length === 0) {
        return NextResponse.json({ error: "no reaffirmation SLA alert to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "rollover reaffirmation SLA acknowledged"
      const updated = {
        ...row,
        status: "acknowledged" as const,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...row.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationRolloverReaffirmationSlas.upsert(updated)
      store.filingEscalationRolloverReaffirmationSlas.set(updated.id, updated)
      store.audit.push({
        action: "filing_rollover_reaffirmation_sla_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.reasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_rollover_reaffirmation_sla",
        rolloverReaffirmationSla:
          (await repos.filingEscalationRolloverReaffirmationSlas.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "set_closure_sla_window_config") {
      if (!parsed.actorId) {
        return NextResponse.json({ error: "actorId is required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "set_closure_sla_window_config requires partner role" },
          { status: 403 }
        )
      }
      const owner =
        parsed.ownerId !== undefined
          ? store.users.get(parsed.ownerId) ?? (await repos.users.get(parsed.ownerId))
          : null
      if (
        parsed.ownerId !== undefined &&
        (!owner || owner.firmId !== actor.firmId || owner.role !== "partner")
      ) {
        return NextResponse.json({ error: "ownerId must reference a partner in actor firm" }, { status: 422 })
      }
      const parseHours = (value: number | undefined): number | undefined => {
        if (value === undefined) return undefined
        const numeric = Number(value)
        if (!Number.isFinite(numeric) || numeric < 0.5 || numeric > 168) {
          throw new PublicError("hours must be between 0.5 and 168")
        }
        return Math.round(numeric * HOUR_MS)
      }
      let ackDeadlineMs: number | undefined
      let clearDeadlineMs: number | undefined
      let autoEscalationMs: number | undefined
      try {
        ackDeadlineMs = parseHours(parsed.ackDeadlineHours)
        clearDeadlineMs = parseHours(parsed.clearDeadlineHours)
        autoEscalationMs = parseHours(parsed.autoEscalationHours)
      } catch (error) {
        return NextResponse.json({ error: String((error as Error).message) }, { status: 400 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existing = await repos.filingEscalationClosureSlaWindowConfigs.get(
        filingEscalationClosureSlaWindowConfigId(actor.firmId, owner?.id ?? null)
      )
      const updated = buildFilingEscalationClosureSlaWindowConfigRow({
        firmId: actor.firmId,
        ownerId: owner?.id ?? null,
        classification: actor.clearanceLevel,
        actorId: actor.id,
        ackDeadlineMs,
        clearDeadlineMs,
        autoEscalationMs,
        existing,
        now,
        note: parsed.note,
      })
      await repos.filingEscalationClosureSlaWindowConfigs.upsert(updated)
      store.filingEscalationClosureSlaWindowConfigs.set(updated.id, updated)
      store.audit.push({
        action: "filing_closure_sla_window_config_set",
        actorId: actor.id,
        target: updated.id,
        classification: updated.classification,
        reason: updated.ownerId ?? "firm_default",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "set_closure_sla_window_config",
        closureSlaWindowConfig:
          (await repos.filingEscalationClosureSlaWindowConfigs.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "set_closure_auto_assignment_rule") {
      if (!parsed.actorId) {
        return NextResponse.json({ error: "actorId is required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "set_closure_auto_assignment_rule requires partner role" },
          { status: 403 }
        )
      }
      const owner =
        parsed.ownerId !== undefined
          ? store.users.get(parsed.ownerId) ?? (await repos.users.get(parsed.ownerId))
          : null
      if (
        parsed.ownerId !== undefined &&
        (!owner || owner.firmId !== actor.firmId || owner.role !== "partner")
      ) {
        return NextResponse.json({ error: "ownerId must reference a partner in actor firm" }, { status: 422 })
      }
      const requestedMode = parsed.mode ?? null
      if (!isFilingEscalationClosureAutoAssignmentMode(requestedMode) && parsed.mode !== undefined) {
        return NextResponse.json(
          { error: "mode must be owner_rota or workload_aware_claim" },
          { status: 400 }
        )
      }
      const mode = isFilingEscalationClosureAutoAssignmentMode(requestedMode)
        ? requestedMode
        : undefined
      const maxActiveClaims = Number(
        parsed.maxActiveClaimsPerPartner ?? DEFAULT_CLOSURE_AUTO_ASSIGNMENT_MAX_ACTIVE_CLAIMS
      )
      if (!Number.isFinite(maxActiveClaims) || maxActiveClaims < 1 || maxActiveClaims > 50) {
        return NextResponse.json(
          { error: "maxActiveClaimsPerPartner must be between 1 and 50" },
          { status: 400 }
        )
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existing = await repos.filingEscalationClosureAutoAssignmentRules.get(
        filingEscalationClosureAutoAssignmentRuleId(actor.firmId, owner?.id ?? null)
      )
      const updated = buildFilingEscalationClosureAutoAssignmentRuleRow({
        firmId: actor.firmId,
        ownerId: owner?.id ?? null,
        classification: actor.clearanceLevel,
        actorId: actor.id,
        mode,
        enabled: parsed.enabled,
        maxActiveClaimsPerPartner: Math.floor(maxActiveClaims),
        existing,
        now,
        note: parsed.note,
      })
      await repos.filingEscalationClosureAutoAssignmentRules.upsert(updated)
      store.filingEscalationClosureAutoAssignmentRules.set(updated.id, updated)
      store.audit.push({
        action: "filing_closure_auto_assignment_rule_set",
        actorId: actor.id,
        target: updated.id,
        classification: updated.classification,
        reason: `${updated.mode}:${updated.enabled ? "enabled" : "disabled"}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "set_closure_auto_assignment_rule",
        closureAutoAssignmentRule:
          (await repos.filingEscalationClosureAutoAssignmentRules.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "auto_assign_closure_followup") {
      if (!parsed.actorId || (!parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId and queueId or ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "auto_assign_closure_followup requires partner role" }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const ownerIdFromQueueId = parsed.queueId
        ? (await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId))?.ownerId ?? null
        : null
      const ownerId = parsed.ownerId ?? ownerIdFromQueueId
      if (!ownerId) {
        return NextResponse.json({ error: "closure follow-up queue row not found" }, { status: 404 })
      }
      const queueBefore = parsed.queueId
        ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
        : null
      const { queueByOwner, slaWindowByOwner } = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
        forceAutoAssignOwnerIds: new Set([ownerId]),
      })
      const queue = queueByOwner.get(ownerId) ?? null
      if (!queue || queue.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure follow-up queue row not found" }, { status: 404 })
      }
      if (!queue.assignedPartnerId) {
        return NextResponse.json({ error: "no eligible closure follow-up auto-assignee found" }, { status: 422 })
      }
      const assignedChanged = (queueBefore?.assignedPartnerId ?? null) !== queue.assignedPartnerId
      if (assignedChanged) {
        store.audit.push({
          action: "filing_closure_followup_auto_assign",
          actorId: actor.id,
          target: queue.id,
          classification: queue.classification,
          reason: queue.assignedPartnerId,
        })
        await persistAuditEntriesSince(store, repos, priorAuditCount)
      }
      const payload = {
        action: "auto_assign_closure_followup",
        autoAssigned: assignedChanged,
        closureFollowupQueue: (await repos.filingEscalationClosureFollowupQueues.get(queue.id)) ?? queue,
        closureSlaWindow: slaWindowByOwner.get(ownerId) ?? null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_closure_followup") {
      if (!parsed.actorId || !parsed.assigneeId || (!parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId, assigneeId, and queueId or ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "assign_closure_followup requires partner role" }, { status: 403 })
      }
      const assignee = store.users.get(parsed.assigneeId)
      if (!assignee || assignee.firmId !== actor.firmId || assignee.role !== "partner") {
        return NextResponse.json({ error: "assignee must be a partner in the same firm" }, { status: 422 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const { queueByOwner } = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const queue =
        (parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? queueByOwner.get(parsed.ownerId) ?? null
            : null) ?? null
      if (!queue || queue.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure follow-up queue row not found" }, { status: 404 })
      }
      const note = parsed.note?.trim() || `closure follow-up assigned to ${assignee.id}`
      const updated = {
        ...queue,
        assignedPartnerId: assignee.id,
        notes: [...queue.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationClosureFollowupQueues.upsert(updated)
      store.filingEscalationClosureFollowupQueues.set(updated.id, updated)
      store.audit.push({
        action: "filing_closure_followup_assign",
        actorId: actor.id,
        target: updated.id,
        classification: updated.classification,
        reason: assignee.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "assign_closure_followup",
        closureFollowupQueue:
          (await repos.filingEscalationClosureFollowupQueues.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "claim_closure_followup") {
      if (!parsed.actorId || (!parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId and queueId or ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "claim_closure_followup requires partner role" }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const { queueByOwner } = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const queue =
        (parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? queueByOwner.get(parsed.ownerId) ?? null
            : null) ?? null
      if (!queue || queue.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure follow-up queue row not found" }, { status: 404 })
      }
      if (queue.status === "resolved") {
        return NextResponse.json({ error: "closure follow-up queue is already resolved" }, { status: 422 })
      }
      if (queue.assignedPartnerId && queue.assignedPartnerId !== actor.id) {
        return NextResponse.json({ error: "queue is assigned to a different partner" }, { status: 403 })
      }
      const note = parsed.note?.trim() || "closure follow-up claimed"
      const updated = {
        ...queue,
        status: "claimed" as const,
        claimedBy: actor.id,
        claimedAt: now,
        notes: [...queue.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationClosureFollowupQueues.upsert(updated)
      store.filingEscalationClosureFollowupQueues.set(updated.id, updated)
      store.audit.push({
        action: "filing_closure_followup_claim",
        actorId: actor.id,
        target: updated.id,
        classification: updated.classification,
        reason: updated.ownerId,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "claim_closure_followup",
        closureFollowupQueue:
          (await repos.filingEscalationClosureFollowupQueues.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_closure_followup") {
      if (!parsed.actorId || !parsed.note?.trim() || (!parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId, note, and queueId or ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "resolve_closure_followup requires partner role" }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const { queueByOwner } = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const queue =
        (parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? queueByOwner.get(parsed.ownerId) ?? null
            : null) ?? null
      if (!queue || queue.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure follow-up queue row not found" }, { status: 404 })
      }
      if (queue.status === "resolved") {
        return NextResponse.json({ error: "closure follow-up queue is already resolved" }, { status: 422 })
      }
      const resolution = parsed.note.trim()
      const updated = {
        ...queue,
        status: "resolved" as const,
        resolvedBy: actor.id,
        resolvedAt: now,
        resolutionNote: resolution,
        notes: [...queue.notes, `${new Date(now).toISOString()} ${actor.id}: ${resolution}`],
        updatedAt: now,
      }
      await repos.filingEscalationClosureFollowupQueues.upsert(updated)
      store.filingEscalationClosureFollowupQueues.set(updated.id, updated)
      store.audit.push({
        action: "filing_closure_followup_resolve",
        actorId: actor.id,
        target: updated.id,
        classification: updated.classification,
        reason: updated.ownerId,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "resolve_closure_followup",
        closureFollowupQueue:
          (await repos.filingEscalationClosureFollowupQueues.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "record_closure_attestation") {
      if (!parsed.actorId || !parsed.evidenceNote?.trim() || (!parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId, evidenceNote, and queueId or ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "record_closure_attestation requires partner role" }, { status: 403 })
      }
      const secondReviewerId = parsed.secondReviewerId?.trim() || null
      if (secondReviewerId === actor.id) {
        return NextResponse.json({ error: "second reviewer must differ from actor" }, { status: 422 })
      }
      if (secondReviewerId) {
        const secondReviewer =
          store.users.get(secondReviewerId) ?? (await repos.users.get(secondReviewerId))
        if (
          !secondReviewer ||
          secondReviewer.firmId !== actor.firmId ||
          secondReviewer.role !== "partner"
        ) {
          return NextResponse.json(
            { error: "secondReviewerId must reference a partner in actor firm" },
            { status: 422 }
          )
        }
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const queue =
        (parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null) ?? null
      if (!queue || queue.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure follow-up queue row not found" }, { status: 404 })
      }
      if (queue.status !== "resolved") {
        return NextResponse.json(
          { error: "closure follow-up queue must be resolved before attestation" },
          { status: 422 }
        )
      }
      const digest = closureState.digestByOwner.get(queue.ownerId) ?? null
      const slaWindowRef = closureState.slaWindowByOwner.get(queue.ownerId) ?? null
      const slaWindow = slaWindowRef
        ? store.filingEscalationClosureSlaWindows.get(slaWindowRef.id) ?? null
        : null
      if (!digest || !slaWindow) {
        return NextResponse.json({ error: "closure compliance state unavailable" }, { status: 422 })
      }
      const existingRowsForQueue = await repos.filingEscalationClosureAttestations.listByQueueId(queue.id)
      const linkedExceptionId = filingEscalationClosureSlaExceptionDigestId(queue.id)
      const row = buildFilingEscalationClosureAttestationRow({
        digest,
        queue,
        slaWindow,
        actorId: actor.id,
        secondReviewerId,
        partnerConcurrence: parsed.partnerConcurrence ?? true,
        evidenceNote: parsed.evidenceNote,
        linkedExceptionDigestId: linkedExceptionId,
        existingRowsForQueue,
        now,
        note: parsed.note,
      })
      await repos.filingEscalationClosureAttestations.upsert(row)
      store.filingEscalationClosureAttestations.set(row.id, row)
      store.audit.push({
        action: "filing_closure_attestation_record",
        actorId: actor.id,
        target: row.id,
        classification: row.classification,
        reason: row.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const refreshedState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const exceptionRef = refreshedState.exceptionDigestByOwner.get(queue.ownerId)
      const payload = {
        action: "record_closure_attestation",
        closureAttestation: (await repos.filingEscalationClosureAttestations.get(row.id)) ?? row,
        closureSlaExceptionDigest: exceptionRef
          ? (await repos.filingEscalationClosureSlaExceptionDigests.get(exceptionRef.id)) ??
            store.filingEscalationClosureSlaExceptionDigests.get(exceptionRef.id) ??
            null
          : null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "review_closure_attestation") {
      if (!parsed.actorId || !parsed.attestationId || !parsed.decision) {
        return NextResponse.json(
          { error: "actorId, attestationId, and decision are required" },
          { status: 400 }
        )
      }
      if (parsed.decision !== "approve" && parsed.decision !== "reject") {
        return NextResponse.json({ error: "decision must be approve or reject" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "review_closure_attestation requires partner role" }, { status: 403 })
      }
      const attestation = await repos.filingEscalationClosureAttestations.get(parsed.attestationId)
      if (!attestation) {
        return NextResponse.json({ error: "closure attestation not found" }, { status: 404 })
      }
      if (attestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm closure attestation denied" }, { status: 403 })
      }
      if (attestation.status !== "pending_second_review") {
        return NextResponse.json(
          { error: "closure attestation is not awaiting second review" },
          { status: 422 }
        )
      }
      if (attestation.secondReviewerId && attestation.secondReviewerId !== actor.id) {
        return NextResponse.json(
          { error: "only the designated second reviewer may review this attestation" },
          { status: 403 }
        )
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const note =
        parsed.note?.trim() ||
        (parsed.decision === "approve"
          ? "closure attestation second review approved"
          : "closure attestation second review rejected")
      const updated = {
        ...attestation,
        status: parsed.decision === "approve" ? ("attested" as const) : ("rejected" as const),
        secondReviewedBy: actor.id,
        secondReviewedAt: now,
        notes: [...attestation.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationClosureAttestations.upsert(updated)
      store.filingEscalationClosureAttestations.set(updated.id, updated)
      store.audit.push({
        action: "filing_closure_attestation_review",
        actorId: actor.id,
        target: updated.id,
        classification: updated.classification,
        reason: updated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const refreshedState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const exceptionRef = refreshedState.exceptionDigestByOwner.get(updated.ownerId)
      const payload = {
        action: "review_closure_attestation",
        closureAttestation:
          (await repos.filingEscalationClosureAttestations.get(updated.id)) ?? updated,
        closureSlaExceptionDigest: exceptionRef
          ? (await repos.filingEscalationClosureSlaExceptionDigests.get(exceptionRef.id)) ??
            store.filingEscalationClosureSlaExceptionDigests.get(exceptionRef.id) ??
            null
          : null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "waive_closure_sla_exception") {
      if (
        !parsed.actorId ||
        !parsed.waiverReason?.trim() ||
        parsed.waiverHours === undefined ||
        (!parsed.queueId && !parsed.ownerId)
      ) {
        return NextResponse.json(
          { error: "actorId, waiverReason, waiverHours, and queueId or ownerId are required" },
          { status: 400 }
        )
      }
      const waiverHours = Number(parsed.waiverHours)
      if (!Number.isFinite(waiverHours) || waiverHours < 1 || waiverHours > 168) {
        return NextResponse.json({ error: "waiverHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "waive_closure_sla_exception requires partner role" }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const queue =
        (parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null) ?? null
      if (!queue || queue.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure follow-up queue row not found" }, { status: 404 })
      }
      const exceptionRef = closureState.exceptionDigestByOwner.get(queue.ownerId)
      if (!exceptionRef) {
        return NextResponse.json({ error: "closure SLA exception digest not found" }, { status: 404 })
      }
      const existing =
        (await repos.filingEscalationClosureSlaExceptionDigests.get(exceptionRef.id)) ??
        store.filingEscalationClosureSlaExceptionDigests.get(exceptionRef.id) ??
        null
      if (!existing) {
        return NextResponse.json({ error: "closure SLA exception digest not found" }, { status: 404 })
      }
      if (existing.status === "cleared") {
        return NextResponse.json({ error: "no active closure SLA exception to waive" }, { status: 422 })
      }
      const note = parsed.note?.trim() || `closure SLA exception waived for ${waiverHours}h`
      const updated = {
        ...existing,
        status: "waived" as const,
        waiverReason: parsed.waiverReason.trim(),
        waivedBy: actor.id,
        waivedAt: now,
        waiverExpiresAt: now + waiverHours * HOUR_MS,
        expiredAt: null,
        notes: [...existing.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationClosureSlaExceptionDigests.upsert(updated)
      store.filingEscalationClosureSlaExceptionDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_closure_sla_exception_waive",
        actorId: actor.id,
        target: updated.id,
        classification: updated.classification,
        reason: parsed.waiverReason.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const refreshedState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const refreshedRef = refreshedState.exceptionDigestByOwner.get(queue.ownerId)
      const payload = {
        action: "waive_closure_sla_exception",
        closureSlaExceptionDigest: refreshedRef
          ? (await repos.filingEscalationClosureSlaExceptionDigests.get(refreshedRef.id)) ??
            store.filingEscalationClosureSlaExceptionDigests.get(refreshedRef.id) ??
            null
          : null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "open_closure_attestation_dispute") {
      if (!parsed.actorId || !parsed.attestationId || !parsed.conflictReason?.trim()) {
        return NextResponse.json(
          { error: "actorId, attestationId, and conflictReason are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "open_closure_attestation_dispute requires partner role" },
          { status: 403 }
        )
      }
      const attestation = await repos.filingEscalationClosureAttestations.get(parsed.attestationId)
      if (!attestation) {
        return NextResponse.json({ error: "closure attestation not found" }, { status: 404 })
      }
      if (attestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm closure attestation denied" }, { status: 403 })
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(attestation.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existingDisputes = await repos.filingEscalationClosureAttestationDisputes.listByAttestationId(
        attestation.id
      )
      const sequenceNo =
        existingDisputes.reduce((max, row) => Math.max(max, row.sequenceNo), 0) + 1
      const dispute = buildFilingEscalationClosureAttestationDisputeRow({
        attestation,
        queue,
        conflictReason: parsed.conflictReason,
        actorId: actor.id,
        sequenceNo,
        exceptionDigestId: attestation.linkedExceptionDigestId,
        now,
        note: parsed.note,
      })
      await repos.filingEscalationClosureAttestationDisputes.upsert(dispute)
      store.filingEscalationClosureAttestationDisputes.set(dispute.id, dispute)
      const attestationUpdated = {
        ...attestation,
        status: "pending_second_review" as const,
        secondReviewedBy: null,
        secondReviewedAt: null,
        notes: [
          ...attestation.notes,
          `${new Date(now).toISOString()} ${actor.id}: dispute opened ${parsed.conflictReason.trim()}`,
        ],
        updatedAt: now,
      }
      await repos.filingEscalationClosureAttestations.upsert(attestationUpdated)
      store.filingEscalationClosureAttestations.set(attestationUpdated.id, attestationUpdated)
      let queueUpdated = queue
      if (queue.status === "resolved") {
        queueUpdated = {
          ...queue,
          status: "open" as const,
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
          notes: [...queue.notes, `${new Date(now).toISOString()} ${actor.id}: reopened by dispute`],
          updatedAt: now,
        }
        await repos.filingEscalationClosureFollowupQueues.upsert(queueUpdated)
        store.filingEscalationClosureFollowupQueues.set(queueUpdated.id, queueUpdated)
      }
      store.audit.push({
        action: "filing_closure_attestation_dispute_open",
        actorId: actor.id,
        target: dispute.id,
        classification: dispute.classification,
        reason: dispute.conflictReason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const exceptionRef = closureState.exceptionDigestByOwner.get(queueUpdated.ownerId)
      const enforcementRef = closureState.exceptionEnforcementByOwner.get(queueUpdated.ownerId)
      const payload = {
        action: "open_closure_attestation_dispute",
        closureAttestationDispute:
          (await repos.filingEscalationClosureAttestationDisputes.get(dispute.id)) ?? dispute,
        closureAttestation:
          (await repos.filingEscalationClosureAttestations.get(attestationUpdated.id)) ??
          attestationUpdated,
        closureFollowupQueue:
          (await repos.filingEscalationClosureFollowupQueues.get(queueUpdated.id)) ?? queueUpdated,
        closureSlaExceptionDigest: exceptionRef
          ? (await repos.filingEscalationClosureSlaExceptionDigests.get(exceptionRef.id)) ?? null
          : null,
        closureSlaExceptionEnforcement: enforcementRef
          ? (await repos.filingEscalationClosureSlaExceptionEnforcement.get(enforcementRef.id)) ?? null
          : null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_closure_attestation_dispute") {
      if (!parsed.actorId || !parsed.disputeId || !parsed.resolution) {
        return NextResponse.json(
          { error: "actorId, disputeId, and resolution are required" },
          { status: 400 }
        )
      }
      if (parsed.resolution !== "uphold" && parsed.resolution !== "override") {
        return NextResponse.json({ error: "resolution must be uphold or override" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "resolve_closure_attestation_dispute requires partner role" },
          { status: 403 }
        )
      }
      const dispute = await repos.filingEscalationClosureAttestationDisputes.get(parsed.disputeId)
      if (!dispute) {
        return NextResponse.json({ error: "closure attestation dispute not found" }, { status: 404 })
      }
      if (dispute.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm closure dispute denied" }, { status: 403 })
      }
      if (dispute.status === "resolved_upheld" || dispute.status === "resolved_overturned") {
        return NextResponse.json({ error: "closure attestation dispute is already resolved" }, { status: 422 })
      }
      const attestation = await repos.filingEscalationClosureAttestations.get(dispute.attestationId)
      if (!attestation) {
        return NextResponse.json({ error: "linked closure attestation not found" }, { status: 404 })
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(dispute.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const note =
        parsed.note?.trim() ||
        (parsed.resolution === "uphold"
          ? "closure attestation dispute upheld"
          : "closure attestation dispute overridden")
      const disputeUpdated = {
        ...dispute,
        status:
          parsed.resolution === "uphold"
            ? ("resolved_upheld" as const)
            : ("resolved_overturned" as const),
        underReviewBy: actor.id,
        underReviewAt: dispute.underReviewAt ?? now,
        resolvedBy: actor.id,
        resolvedAt: now,
        resolutionNote: note,
        notes: [...dispute.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationClosureAttestationDisputes.upsert(disputeUpdated)
      store.filingEscalationClosureAttestationDisputes.set(disputeUpdated.id, disputeUpdated)
      const attestationUpdated = {
        ...attestation,
        status: parsed.resolution === "uphold" ? ("attested" as const) : ("rejected" as const),
        secondReviewedBy: actor.id,
        secondReviewedAt: now,
        notes: [...attestation.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationClosureAttestations.upsert(attestationUpdated)
      store.filingEscalationClosureAttestations.set(attestationUpdated.id, attestationUpdated)
      const queueUpdated =
        parsed.resolution === "uphold"
          ? {
              ...queue,
              status: "resolved" as const,
              resolvedBy: queue.resolvedBy ?? actor.id,
              resolvedAt: queue.resolvedAt ?? now,
              resolutionNote: queue.resolutionNote ?? note,
              notes: [...queue.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
              updatedAt: now,
            }
          : {
              ...queue,
              status: "open" as const,
              resolvedBy: null,
              resolvedAt: null,
              resolutionNote: null,
              notes: [...queue.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
              updatedAt: now,
            }
      await repos.filingEscalationClosureFollowupQueues.upsert(queueUpdated)
      store.filingEscalationClosureFollowupQueues.set(queueUpdated.id, queueUpdated)
      store.audit.push({
        action: "filing_closure_attestation_dispute_resolve",
        actorId: actor.id,
        target: disputeUpdated.id,
        classification: disputeUpdated.classification,
        reason: disputeUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const exceptionRef = closureState.exceptionDigestByOwner.get(queueUpdated.ownerId)
      const enforcementRef = closureState.exceptionEnforcementByOwner.get(queueUpdated.ownerId)
      const payload = {
        action: "resolve_closure_attestation_dispute",
        closureAttestationDispute:
          (await repos.filingEscalationClosureAttestationDisputes.get(disputeUpdated.id)) ??
          disputeUpdated,
        closureAttestation:
          (await repos.filingEscalationClosureAttestations.get(attestationUpdated.id)) ??
          attestationUpdated,
        closureFollowupQueue:
          (await repos.filingEscalationClosureFollowupQueues.get(queueUpdated.id)) ?? queueUpdated,
        closureSlaExceptionDigest: exceptionRef
          ? (await repos.filingEscalationClosureSlaExceptionDigests.get(exceptionRef.id)) ?? null
          : null,
        closureSlaExceptionEnforcement: enforcementRef
          ? (await repos.filingEscalationClosureSlaExceptionEnforcement.get(enforcementRef.id)) ?? null
          : null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "escalate_closure_dispute_to_panel") {
      if (!parsed.actorId || !parsed.disputeId || !parsed.panelMemberIds?.length) {
        return NextResponse.json(
          { error: "actorId, disputeId, and panelMemberIds are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "escalate_closure_dispute_to_panel requires partner role" },
          { status: 403 }
        )
      }
      const dispute = await repos.filingEscalationClosureAttestationDisputes.get(parsed.disputeId)
      if (!dispute) {
        return NextResponse.json({ error: "closure attestation dispute not found" }, { status: 404 })
      }
      if (dispute.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm closure dispute denied" }, { status: 403 })
      }
      if (dispute.status === "resolved_upheld" || dispute.status === "resolved_overturned") {
        return NextResponse.json({ error: "closure attestation dispute is already resolved" }, { status: 422 })
      }
      const panelMemberIds = [...new Set(parsed.panelMemberIds)]
      if (panelMemberIds.some((candidate) => {
        const member = store.users.get(candidate)
        return !member || member.firmId !== actor.firmId || member.role !== "partner"
      })) {
        return NextResponse.json(
          { error: "panelMemberIds must be partner users from same firm" },
          { status: 422 }
        )
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(dispute.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existingAdjudication = await repos.filingEscalationClosureAdjudicationQueue.get(
        filingEscalationClosureAdjudicationQueueId(dispute.id)
      )
      const enforcement = await repos.filingEscalationClosureSlaExceptionEnforcement.get(
        filingEscalationClosureSlaExceptionEnforcementId(queue.id)
      )
      const adjudicationUpdated = buildFilingEscalationClosureAdjudicationQueueRow({
        dispute,
        queue,
        enforcement,
        existing: existingAdjudication,
        panelMemberIds,
        actorId: actor.id,
        dissentNote: parsed.dissentNote,
        note: parsed.note ?? "dispute escalated to adjudication panel",
        now,
      })
      await repos.filingEscalationClosureAdjudicationQueue.upsert(adjudicationUpdated)
      store.filingEscalationClosureAdjudicationQueue.set(adjudicationUpdated.id, adjudicationUpdated)
      const disputeUpdated = {
        ...dispute,
        status: "under_review" as const,
        underReviewBy: actor.id,
        underReviewAt: dispute.underReviewAt ?? now,
        notes: [...dispute.notes, `${new Date(now).toISOString()} ${actor.id}: escalated to panel`],
        updatedAt: now,
      }
      await repos.filingEscalationClosureAttestationDisputes.upsert(disputeUpdated)
      store.filingEscalationClosureAttestationDisputes.set(disputeUpdated.id, disputeUpdated)
      store.audit.push({
        action: "filing_closure_adjudication_panel_escalate",
        actorId: actor.id,
        target: adjudicationUpdated.id,
        classification: adjudicationUpdated.classification,
        reason: panelMemberIds.join(","),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const refreshed = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const rebalanceRef = refreshed.rebalanceByOwner.get(queue.ownerId)
      const payload = {
        action: "escalate_closure_dispute_to_panel",
        closureAttestationDispute:
          (await repos.filingEscalationClosureAttestationDisputes.get(disputeUpdated.id)) ??
          disputeUpdated,
        closureAdjudicationQueue:
          (await repos.filingEscalationClosureAdjudicationQueue.get(adjudicationUpdated.id)) ??
          adjudicationUpdated,
        closureEnforcementRebalance: rebalanceRef
          ? (await repos.filingEscalationClosureEnforcementRebalance.get(rebalanceRef.id)) ?? null
          : null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "record_closure_adjudication_verdict") {
      if (!parsed.actorId || !parsed.adjudicationId || !parsed.verdict) {
        return NextResponse.json(
          { error: "actorId, adjudicationId, and verdict are required" },
          { status: 400 }
        )
      }
      if (!isFilingEscalationClosureAdjudicationVerdict(parsed.verdict)) {
        return NextResponse.json(
          { error: "verdict must be uphold_dispute or override_dispute" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "record_closure_adjudication_verdict requires partner role" },
          { status: 403 }
        )
      }
      const adjudication = await repos.filingEscalationClosureAdjudicationQueue.get(parsed.adjudicationId)
      if (!adjudication) {
        return NextResponse.json({ error: "closure adjudication row not found" }, { status: 404 })
      }
      if (adjudication.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm closure adjudication denied" }, { status: 403 })
      }
      if (adjudication.verdict) {
        return NextResponse.json({ error: "closure adjudication verdict already recorded" }, { status: 422 })
      }
      const dispute = await repos.filingEscalationClosureAttestationDisputes.get(adjudication.disputeId)
      if (!dispute) {
        return NextResponse.json({ error: "linked closure attestation dispute not found" }, { status: 404 })
      }
      const attestation = await repos.filingEscalationClosureAttestations.get(adjudication.attestationId)
      if (!attestation) {
        return NextResponse.json({ error: "linked closure attestation not found" }, { status: 404 })
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(adjudication.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const enforcement = await repos.filingEscalationClosureSlaExceptionEnforcement.get(
        filingEscalationClosureSlaExceptionEnforcementId(queue.id)
      )
      const adjudicationUpdated = buildFilingEscalationClosureAdjudicationQueueRow({
        dispute,
        queue,
        enforcement,
        existing: adjudication,
        panelMemberIds: adjudication.panelMemberIds,
        actorId: actor.id,
        verdict: parsed.verdict,
        dissentNote: parsed.dissentNote,
        note: parsed.note ?? `panel verdict ${parsed.verdict}`,
        now,
      })
      await repos.filingEscalationClosureAdjudicationQueue.upsert(adjudicationUpdated)
      store.filingEscalationClosureAdjudicationQueue.set(adjudicationUpdated.id, adjudicationUpdated)
      const disputeStatus =
        parsed.verdict === "uphold_dispute"
          ? ("resolved_upheld" as const)
          : ("resolved_overturned" as const)
      const disputeUpdated = {
        ...dispute,
        status: disputeStatus,
        underReviewBy: dispute.underReviewBy ?? actor.id,
        underReviewAt: dispute.underReviewAt ?? now,
        resolvedBy: actor.id,
        resolvedAt: now,
        resolutionNote: parsed.note?.trim() ?? `panel verdict ${parsed.verdict}`,
        notes: [...dispute.notes, `${new Date(now).toISOString()} ${actor.id}: panel verdict ${parsed.verdict}`],
        updatedAt: now,
      }
      await repos.filingEscalationClosureAttestationDisputes.upsert(disputeUpdated)
      store.filingEscalationClosureAttestationDisputes.set(disputeUpdated.id, disputeUpdated)
      const attestationUpdated = {
        ...attestation,
        status: parsed.verdict === "uphold_dispute" ? ("attested" as const) : ("rejected" as const),
        secondReviewedBy: actor.id,
        secondReviewedAt: now,
        notes: [...attestation.notes, `${new Date(now).toISOString()} ${actor.id}: panel verdict ${parsed.verdict}`],
        updatedAt: now,
      }
      await repos.filingEscalationClosureAttestations.upsert(attestationUpdated)
      store.filingEscalationClosureAttestations.set(attestationUpdated.id, attestationUpdated)
      const queueUpdated =
        parsed.verdict === "uphold_dispute"
          ? {
              ...queue,
              status: "resolved" as const,
              resolvedBy: queue.resolvedBy ?? actor.id,
              resolvedAt: queue.resolvedAt ?? now,
              resolutionNote: queue.resolutionNote ?? "closure adjudication upheld dispute",
              notes: [...queue.notes, `${new Date(now).toISOString()} ${actor.id}: queue resolved by panel verdict`],
              updatedAt: now,
            }
          : {
              ...queue,
              status: "open" as const,
              resolvedBy: null,
              resolvedAt: null,
              resolutionNote: null,
              notes: [...queue.notes, `${new Date(now).toISOString()} ${actor.id}: queue reopened by panel verdict`],
              updatedAt: now,
            }
      await repos.filingEscalationClosureFollowupQueues.upsert(queueUpdated)
      store.filingEscalationClosureFollowupQueues.set(queueUpdated.id, queueUpdated)
      store.audit.push({
        action: "filing_closure_adjudication_verdict_record",
        actorId: actor.id,
        target: adjudicationUpdated.id,
        classification: adjudicationUpdated.classification,
        reason: parsed.verdict,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const refreshed = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const rebalanceRef = refreshed.rebalanceByOwner.get(queueUpdated.ownerId)
      const payload = {
        action: "record_closure_adjudication_verdict",
        closureAdjudicationQueue:
          (await repos.filingEscalationClosureAdjudicationQueue.get(adjudicationUpdated.id)) ??
          adjudicationUpdated,
        closureAttestationDispute:
          (await repos.filingEscalationClosureAttestationDisputes.get(disputeUpdated.id)) ??
          disputeUpdated,
        closureAttestation:
          (await repos.filingEscalationClosureAttestations.get(attestationUpdated.id)) ??
          attestationUpdated,
        closureFollowupQueue:
          (await repos.filingEscalationClosureFollowupQueues.get(queueUpdated.id)) ?? queueUpdated,
        closureEnforcementRebalance: rebalanceRef
          ? (await repos.filingEscalationClosureEnforcementRebalance.get(rebalanceRef.id)) ?? null
          : null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "rebalance_closure_enforcement_queue") {
      if (!parsed.actorId || (!parsed.rebalanceId && !parsed.queueId && !parsed.ownerId) || !parsed.status) {
        return NextResponse.json(
          { error: "actorId, status, and rebalanceId or queueId/ownerId are required" },
          { status: 400 }
        )
      }
      if (!isFilingEscalationClosureEnforcementRebalanceStatus(parsed.status)) {
        return NextResponse.json(
          { error: "status must be a valid closure enforcement rebalance status" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "rebalance_closure_enforcement_queue requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const selectedRebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : null) ?? null
      const queue =
        (selectedRebalance
          ? await repos.filingEscalationClosureFollowupQueues.get(selectedRebalance.queueId)
          : parsed.queueId
            ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
            : parsed.ownerId
              ? closureState.queueByOwner.get(parsed.ownerId) ?? null
              : null) ?? null
      if (!queue || queue.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure follow-up queue row not found" }, { status: 404 })
      }
      const enforcementRef = closureState.exceptionEnforcementByOwner.get(queue.ownerId)
      if (!enforcementRef) {
        return NextResponse.json({ error: "closure SLA exception enforcement not found" }, { status: 404 })
      }
      const enforcement = await repos.filingEscalationClosureSlaExceptionEnforcement.get(enforcementRef.id)
      if (!enforcement) {
        return NextResponse.json({ error: "closure SLA exception enforcement not found" }, { status: 404 })
      }
      let recommendedOwnerId = parsed.recommendedOwnerId?.trim() || null
      if (recommendedOwnerId) {
        const recommendedOwner = store.users.get(recommendedOwnerId)
        if (!recommendedOwner || recommendedOwner.firmId !== actor.firmId || recommendedOwner.role !== "partner") {
          return NextResponse.json(
            { error: "recommendedOwnerId must be a partner in the same firm" },
            { status: 422 }
          )
        }
      }
      if (parsed.status !== "owner_reassignment_recommended") {
        recommendedOwnerId = null
      }
      const priorAuditCount = store.audit.length
      const existingRebalance =
        selectedRebalance ??
        (await repos.filingEscalationClosureEnforcementRebalance.get(
          filingEscalationClosureEnforcementRebalanceId(queue.id)
        ))
      const adjudicationRef = closureState.adjudicationByOwner.get(queue.ownerId)
      const adjudication = adjudicationRef
        ? await repos.filingEscalationClosureAdjudicationQueue.get(adjudicationRef.id)
        : null
      const rebalanceUpdated = buildFilingEscalationClosureEnforcementRebalanceRow({
        queue,
        enforcement,
        adjudication,
        existing: existingRebalance,
        statusOverride: parsed.status,
        recommendedOwnerId,
        cooldownHours: parsed.cooldownHours,
        throttleHours: parsed.throttleHours,
        actorId: actor.id,
        note:
          parsed.note ??
          `manual rebalance ${parsed.status}${
            recommendedOwnerId ? ` -> ${recommendedOwnerId}` : ""
          }`,
        now,
      })
      await repos.filingEscalationClosureEnforcementRebalance.upsert(rebalanceUpdated)
      store.filingEscalationClosureEnforcementRebalance.set(rebalanceUpdated.id, rebalanceUpdated)
      store.audit.push({
        action: "filing_closure_enforcement_rebalance_set",
        actorId: actor.id,
        target: rebalanceUpdated.id,
        classification: rebalanceUpdated.classification,
        reason: rebalanceUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const refreshed = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const refreshedRef = refreshed.rebalanceByOwner.get(queue.ownerId)
      const payload = {
        action: "rebalance_closure_enforcement_queue",
        closureEnforcementRebalance: refreshedRef
          ? (await repos.filingEscalationClosureEnforcementRebalance.get(refreshedRef.id)) ??
            rebalanceUpdated
          : rebalanceUpdated,
        closureFollowupQueue:
          (await repos.filingEscalationClosureFollowupQueues.get(queue.id)) ?? queue,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "govern_closure_adjudication_quorum") {
      if (!parsed.actorId || !parsed.adjudicationId) {
        return NextResponse.json(
          { error: "actorId and adjudicationId are required" },
          { status: 400 }
        )
      }
      const requiredPanelCount =
        parsed.requiredPanelCount === undefined ? undefined : Number(parsed.requiredPanelCount)
      if (
        requiredPanelCount !== undefined &&
        (!Number.isFinite(requiredPanelCount) || requiredPanelCount < 2 || requiredPanelCount > 7)
      ) {
        return NextResponse.json(
          { error: "requiredPanelCount must be between 2 and 7" },
          { status: 400 }
        )
      }
      const quorumWindowHours =
        parsed.quorumWindowHours === undefined ? undefined : Number(parsed.quorumWindowHours)
      if (
        quorumWindowHours !== undefined &&
        (!Number.isFinite(quorumWindowHours) || quorumWindowHours < 0 || quorumWindowHours > 168)
      ) {
        return NextResponse.json(
          { error: "quorumWindowHours must be between 0 and 168" },
          { status: 400 }
        )
      }
      const verdictWindowHours =
        parsed.verdictWindowHours === undefined ? undefined : Number(parsed.verdictWindowHours)
      if (
        verdictWindowHours !== undefined &&
        (!Number.isFinite(verdictWindowHours) || verdictWindowHours < 0 || verdictWindowHours > 168)
      ) {
        return NextResponse.json(
          { error: "verdictWindowHours must be between 0 and 168" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "govern_closure_adjudication_quorum requires partner role" },
          { status: 403 }
        )
      }
      const adjudication = await repos.filingEscalationClosureAdjudicationQueue.get(parsed.adjudicationId)
      if (!adjudication) {
        return NextResponse.json({ error: "closure adjudication row not found" }, { status: 404 })
      }
      if (adjudication.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm closure adjudication denied" }, { status: 403 })
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(adjudication.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existingQuorum = await repos.filingEscalationClosureAdjudicationQuorum.get(
        filingEscalationClosureAdjudicationQuorumId(adjudication.id)
      )
      const quorumUpdated = buildFilingEscalationClosureAdjudicationQuorumRow({
        adjudication,
        queue,
        existing: existingQuorum,
        requiredPanelCount,
        quorumWindowHours,
        verdictWindowHours,
        actorId: actor.id,
        now,
        note: parsed.note ?? "adjudication quorum governance tick",
      })
      await repos.filingEscalationClosureAdjudicationQuorum.upsert(quorumUpdated)
      store.filingEscalationClosureAdjudicationQuorum.set(quorumUpdated.id, quorumUpdated)
      store.audit.push({
        action: "filing_closure_adjudication_quorum_govern",
        actorId: actor.id,
        target: quorumUpdated.id,
        classification: quorumUpdated.classification,
        reason: quorumUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "govern_closure_adjudication_quorum",
        closureAdjudicationQuorum:
          (await repos.filingEscalationClosureAdjudicationQuorum.get(quorumUpdated.id)) ??
          quorumUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "execute_closure_rebalance_owner_transfer") {
      if (!parsed.actorId || (!parsed.rebalanceId && !parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId and rebalanceId or queueId/ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "execute_closure_rebalance_owner_transfer requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      if (!rebalance || rebalance.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure enforcement rebalance row not found" }, { status: 404 })
      }
      if (
        rebalance.status !== "owner_reassignment_recommended" ||
        !rebalance.recommendedOwnerId
      ) {
        return NextResponse.json(
          { error: "rebalance row is not in owner_reassignment_recommended state" },
          { status: 422 }
        )
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(rebalance.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const executionId = filingEscalationClosureRebalanceExecutionId(rebalance.id)
      const safeguardId = filingEscalationClosureRebalanceSafeguardId(rebalance.id)
      const existingExecution = await repos.filingEscalationClosureRebalanceExecution.get(executionId)
      const existingSafeguard = await repos.filingEscalationClosureRebalanceSafeguards.get(safeguardId)
      const safeguardCurrent = buildFilingEscalationClosureRebalanceSafeguardRow({
        rebalance,
        queue,
        execution: existingExecution,
        existing: existingSafeguard,
        now,
      })
      if (
        safeguardCurrent.status === "cooldown_locked" ||
        safeguardCurrent.status === "duplicate_suppressed"
      ) {
        return NextResponse.json(
          { error: `rebalance execution suppressed by safeguard status ${safeguardCurrent.status}` },
          { status: 422 }
        )
      }
      const recommendedOwner = store.users.get(rebalance.recommendedOwnerId)
      if (
        !recommendedOwner ||
        recommendedOwner.firmId !== actor.firmId ||
        recommendedOwner.role !== "partner"
      ) {
        return NextResponse.json(
          { error: "recommended owner is not an active partner in this firm" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const queueUpdated = {
        ...queue,
        assignedPartnerId: recommendedOwner.id,
        claimedBy: null,
        claimedAt: null,
        notes: [...queue.notes, `${new Date(now).toISOString()} ${actor.id}: rebalance owner transfer to ${recommendedOwner.id}`],
        updatedAt: now,
      }
      await repos.filingEscalationClosureFollowupQueues.upsert(queueUpdated)
      store.filingEscalationClosureFollowupQueues.set(queueUpdated.id, queueUpdated)
      const rebalanceUpdated = {
        ...rebalance,
        status: "none" as const,
        recommendedOwnerId: null,
        lastRebalancedBy: actor.id,
        lastRebalancedAt: now,
        notes: [...rebalance.notes, `${new Date(now).toISOString()} ${actor.id}: owner transfer executed`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationClosureEnforcementRebalance.upsert(rebalanceUpdated)
      store.filingEscalationClosureEnforcementRebalance.set(rebalanceUpdated.id, rebalanceUpdated)
      const executionUpdated = buildFilingEscalationClosureRebalanceExecutionRow({
        rebalance: rebalanceUpdated,
        queue: queueUpdated,
        existing: existingExecution,
        mode: "owner_transfer",
        status: "completed",
        targetOwnerId: recommendedOwner.id,
        appliedOwnerId: recommendedOwner.id,
        actorId: actor.id,
        note: parsed.note ?? `rebalance owner transfer executed -> ${recommendedOwner.id}`,
        now,
      })
      await repos.filingEscalationClosureRebalanceExecution.upsert(executionUpdated)
      store.filingEscalationClosureRebalanceExecution.set(executionUpdated.id, executionUpdated)
      const safeguardUpdated = buildFilingEscalationClosureRebalanceSafeguardRow({
        rebalance: rebalanceUpdated,
        queue: queueUpdated,
        execution: executionUpdated,
        existing: existingSafeguard,
        now,
      })
      await repos.filingEscalationClosureRebalanceSafeguards.upsert(safeguardUpdated)
      store.filingEscalationClosureRebalanceSafeguards.set(safeguardUpdated.id, safeguardUpdated)
      store.audit.push({
        action: "filing_closure_rebalance_owner_transfer_execute",
        actorId: actor.id,
        target: executionUpdated.id,
        classification: executionUpdated.classification,
        reason: recommendedOwner.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "execute_closure_rebalance_owner_transfer",
        closureFollowupQueue:
          (await repos.filingEscalationClosureFollowupQueues.get(queueUpdated.id)) ?? queueUpdated,
        closureEnforcementRebalance:
          (await repos.filingEscalationClosureEnforcementRebalance.get(rebalanceUpdated.id)) ??
          rebalanceUpdated,
        closureRebalanceExecution:
          (await repos.filingEscalationClosureRebalanceExecution.get(executionUpdated.id)) ??
          executionUpdated,
        closureRebalanceSafeguard:
          (await repos.filingEscalationClosureRebalanceSafeguards.get(safeguardUpdated.id)) ??
          safeguardUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "execute_closure_rebalance_throttle_release") {
      if (!parsed.actorId || (!parsed.rebalanceId && !parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId and rebalanceId or queueId/ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "execute_closure_rebalance_throttle_release requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      if (!rebalance || rebalance.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure enforcement rebalance row not found" }, { status: 404 })
      }
      if (rebalance.status !== "throttle_active") {
        return NextResponse.json(
          { error: "rebalance row is not in throttle_active state" },
          { status: 422 }
        )
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(rebalance.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const executionId = filingEscalationClosureRebalanceExecutionId(rebalance.id)
      const safeguardId = filingEscalationClosureRebalanceSafeguardId(rebalance.id)
      const existingExecution = await repos.filingEscalationClosureRebalanceExecution.get(executionId)
      const existingSafeguard = await repos.filingEscalationClosureRebalanceSafeguards.get(safeguardId)
      const safeguardCurrent = buildFilingEscalationClosureRebalanceSafeguardRow({
        rebalance,
        queue,
        execution: existingExecution,
        existing: existingSafeguard,
        now,
      })
      if (
        safeguardCurrent.status === "cooldown_locked" ||
        safeguardCurrent.status === "duplicate_suppressed"
      ) {
        return NextResponse.json(
          { error: `rebalance execution suppressed by safeguard status ${safeguardCurrent.status}` },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const reopenQueue = parsed.reopenQueue ?? true
      const queueUpdated =
        reopenQueue && queue.status === "resolved"
          ? {
              ...queue,
              status: "open" as const,
              resolvedBy: null,
              resolvedAt: null,
              resolutionNote: null,
              notes: [...queue.notes, `${new Date(now).toISOString()} ${actor.id}: throttle release reopened queue`],
              updatedAt: now,
            }
          : queue
      if (queueUpdated !== queue) {
        await repos.filingEscalationClosureFollowupQueues.upsert(queueUpdated)
        store.filingEscalationClosureFollowupQueues.set(queueUpdated.id, queueUpdated)
      }
      const rebalanceUpdated = {
        ...rebalance,
        status: "none" as const,
        reopenThrottleUntil: null,
        lastRebalancedBy: actor.id,
        lastRebalancedAt: now,
        notes: [...rebalance.notes, `${new Date(now).toISOString()} ${actor.id}: throttle release executed`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationClosureEnforcementRebalance.upsert(rebalanceUpdated)
      store.filingEscalationClosureEnforcementRebalance.set(rebalanceUpdated.id, rebalanceUpdated)
      const executionUpdated = buildFilingEscalationClosureRebalanceExecutionRow({
        rebalance: rebalanceUpdated,
        queue: queueUpdated,
        existing: existingExecution,
        mode: "throttle_release",
        status: "completed",
        targetOwnerId: null,
        appliedOwnerId: queueUpdated.assignedPartnerId,
        reopenQueue: reopenQueue && queue.status === "resolved",
        actorId: actor.id,
        note: parsed.note ?? "rebalance throttle release executed",
        now,
      })
      await repos.filingEscalationClosureRebalanceExecution.upsert(executionUpdated)
      store.filingEscalationClosureRebalanceExecution.set(executionUpdated.id, executionUpdated)
      const safeguardUpdated = buildFilingEscalationClosureRebalanceSafeguardRow({
        rebalance: rebalanceUpdated,
        queue: queueUpdated,
        execution: executionUpdated,
        existing: existingSafeguard,
        now,
      })
      await repos.filingEscalationClosureRebalanceSafeguards.upsert(safeguardUpdated)
      store.filingEscalationClosureRebalanceSafeguards.set(safeguardUpdated.id, safeguardUpdated)
      store.audit.push({
        action: "filing_closure_rebalance_throttle_release_execute",
        actorId: actor.id,
        target: executionUpdated.id,
        classification: executionUpdated.classification,
        reason: String(reopenQueue),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "execute_closure_rebalance_throttle_release",
        closureFollowupQueue:
          (await repos.filingEscalationClosureFollowupQueues.get(queueUpdated.id)) ?? queueUpdated,
        closureEnforcementRebalance:
          (await repos.filingEscalationClosureEnforcementRebalance.get(rebalanceUpdated.id)) ??
          rebalanceUpdated,
        closureRebalanceExecution:
          (await repos.filingEscalationClosureRebalanceExecution.get(executionUpdated.id)) ??
          executionUpdated,
        closureRebalanceSafeguard:
          (await repos.filingEscalationClosureRebalanceSafeguards.get(safeguardUpdated.id)) ??
          safeguardUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "extend_closure_adjudication_slo_deadline") {
      if (!parsed.actorId || (!parsed.sloId && !parsed.adjudicationId) || parsed.extensionHours === undefined) {
        return NextResponse.json(
          { error: "actorId, extensionHours, and sloId or adjudicationId are required" },
          { status: 400 }
        )
      }
      const extensionHours = Number(parsed.extensionHours)
      if (!Number.isFinite(extensionHours) || extensionHours < 1 || extensionHours > 168) {
        return NextResponse.json({ error: "extensionHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "extend_closure_adjudication_slo_deadline requires partner role" },
          { status: 403 }
        )
      }
      const existingSlo = parsed.sloId
        ? await repos.filingEscalationClosureAdjudicationSlo.get(parsed.sloId)
        : null
      const adjudicationId = parsed.adjudicationId ?? existingSlo?.adjudicationId ?? null
      if (!adjudicationId) {
        return NextResponse.json({ error: "closure adjudication ID could not be resolved" }, { status: 404 })
      }
      const adjudication = await repos.filingEscalationClosureAdjudicationQueue.get(adjudicationId)
      if (!adjudication) {
        return NextResponse.json({ error: "closure adjudication row not found" }, { status: 404 })
      }
      if (adjudication.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm closure adjudication denied" }, { status: 403 })
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(adjudication.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const quorum = await repos.filingEscalationClosureAdjudicationQuorum.get(
        filingEscalationClosureAdjudicationQuorumId(adjudication.id)
      )
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const sloUpdated = buildFilingEscalationClosureAdjudicationSloRow({
        adjudication,
        queue,
        quorum,
        existing: existingSlo,
        extensionHours,
        extensionApprovedBy: actor.id,
        now,
        note: parsed.note ?? `SLO deadline extended by ${extensionHours}h`,
      })
      await repos.filingEscalationClosureAdjudicationSlo.upsert(sloUpdated)
      store.filingEscalationClosureAdjudicationSlo.set(sloUpdated.id, sloUpdated)
      store.audit.push({
        action: "filing_closure_adjudication_slo_deadline_extend",
        actorId: actor.id,
        target: sloUpdated.id,
        classification: sloUpdated.classification,
        reason: String(extensionHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "extend_closure_adjudication_slo_deadline",
        closureAdjudicationSlo:
          (await repos.filingEscalationClosureAdjudicationSlo.get(sloUpdated.id)) ?? sloUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "escalate_closure_adjudication_slo_tier") {
      if (!parsed.actorId || (!parsed.sloId && !parsed.adjudicationId) || !parsed.escalationTier) {
        return NextResponse.json(
          { error: "actorId, escalationTier, and sloId or adjudicationId are required" },
          { status: 400 }
        )
      }
      if (!isFilingEscalationClosureAdjudicationSloEscalationTier(parsed.escalationTier)) {
        return NextResponse.json(
          { error: "escalationTier must be a valid adjudication SLO escalation tier" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "escalate_closure_adjudication_slo_tier requires partner role" },
          { status: 403 }
        )
      }
      const existingSlo = parsed.sloId
        ? await repos.filingEscalationClosureAdjudicationSlo.get(parsed.sloId)
        : null
      const adjudicationId = parsed.adjudicationId ?? existingSlo?.adjudicationId ?? null
      if (!adjudicationId) {
        return NextResponse.json({ error: "closure adjudication ID could not be resolved" }, { status: 404 })
      }
      const adjudication = await repos.filingEscalationClosureAdjudicationQueue.get(adjudicationId)
      if (!adjudication) {
        return NextResponse.json({ error: "closure adjudication row not found" }, { status: 404 })
      }
      if (adjudication.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm closure adjudication denied" }, { status: 403 })
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(adjudication.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const quorum = await repos.filingEscalationClosureAdjudicationQuorum.get(
        filingEscalationClosureAdjudicationQuorumId(adjudication.id)
      )
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const sloUpdated = buildFilingEscalationClosureAdjudicationSloRow({
        adjudication,
        queue,
        quorum,
        existing: existingSlo,
        escalationTierOverride: parsed.escalationTier,
        now,
        note: parsed.note ?? `SLO escalation tier set to ${parsed.escalationTier}`,
      })
      await repos.filingEscalationClosureAdjudicationSlo.upsert(sloUpdated)
      store.filingEscalationClosureAdjudicationSlo.set(sloUpdated.id, sloUpdated)
      store.audit.push({
        action: "filing_closure_adjudication_slo_tier_escalate",
        actorId: actor.id,
        target: sloUpdated.id,
        classification: sloUpdated.classification,
        reason: parsed.escalationTier,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "escalate_closure_adjudication_slo_tier",
        closureAdjudicationSlo:
          (await repos.filingEscalationClosureAdjudicationSlo.get(sloUpdated.id)) ?? sloUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_closure_adjudication_slo_breach") {
      if (!parsed.actorId || (!parsed.sloId && !parsed.adjudicationId)) {
        return NextResponse.json(
          { error: "actorId and sloId or adjudicationId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_closure_adjudication_slo_breach requires partner role" },
          { status: 403 }
        )
      }
      const existingSlo = parsed.sloId
        ? await repos.filingEscalationClosureAdjudicationSlo.get(parsed.sloId)
        : null
      const adjudicationId = parsed.adjudicationId ?? existingSlo?.adjudicationId ?? null
      if (!adjudicationId) {
        return NextResponse.json({ error: "closure adjudication ID could not be resolved" }, { status: 404 })
      }
      const adjudication = await repos.filingEscalationClosureAdjudicationQueue.get(adjudicationId)
      if (!adjudication) {
        return NextResponse.json({ error: "closure adjudication row not found" }, { status: 404 })
      }
      if (adjudication.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm closure adjudication denied" }, { status: 403 })
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(adjudication.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const quorum = await repos.filingEscalationClosureAdjudicationQuorum.get(
        filingEscalationClosureAdjudicationQuorumId(adjudication.id)
      )
      const now = Date.now()
      const candidate = buildFilingEscalationClosureAdjudicationSloRow({
        adjudication,
        queue,
        quorum,
        existing: existingSlo,
        now,
      })
      if (candidate.breachDebtHours <= 0 && candidate.status !== "breach_open") {
        return NextResponse.json({ error: "no active adjudication SLO breach to acknowledge" }, { status: 422 })
      }
      const priorAuditCount = store.audit.length
      const sloUpdated = buildFilingEscalationClosureAdjudicationSloRow({
        adjudication,
        queue,
        quorum,
        existing: existingSlo,
        acknowledgeBreachBy: actor.id,
        now,
        note: parsed.note ?? "Adjudication SLO breach acknowledged by partner",
      })
      await repos.filingEscalationClosureAdjudicationSlo.upsert(sloUpdated)
      store.filingEscalationClosureAdjudicationSlo.set(sloUpdated.id, sloUpdated)
      store.audit.push({
        action: "filing_closure_adjudication_slo_breach_acknowledge",
        actorId: actor.id,
        target: sloUpdated.id,
        classification: sloUpdated.classification,
        reason: sloUpdated.escalationTier,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_closure_adjudication_slo_breach",
        closureAdjudicationSlo:
          (await repos.filingEscalationClosureAdjudicationSlo.get(sloUpdated.id)) ?? sloUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "configure_closure_rebalance_auto_execution_safeguard") {
      if (!parsed.actorId || (!parsed.safeguardId && !parsed.rebalanceId && !parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId and safeguardId/rebalanceId/queueId/ownerId are required" },
          { status: 400 }
        )
      }
      const cooldownLockHours =
        parsed.cooldownLockHours === undefined ? undefined : Number(parsed.cooldownLockHours)
      if (
        cooldownLockHours !== undefined &&
        (!Number.isFinite(cooldownLockHours) || cooldownLockHours < 0 || cooldownLockHours > 168)
      ) {
        return NextResponse.json(
          { error: "cooldownLockHours must be between 0 and 168" },
          { status: 400 }
        )
      }
      const duplicateSuppressionHours =
        parsed.duplicateSuppressionHours === undefined ? undefined : Number(parsed.duplicateSuppressionHours)
      if (
        duplicateSuppressionHours !== undefined &&
        (!Number.isFinite(duplicateSuppressionHours) ||
          duplicateSuppressionHours < 0 ||
          duplicateSuppressionHours > 168)
      ) {
        return NextResponse.json(
          { error: "duplicateSuppressionHours must be between 0 and 168" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "configure_closure_rebalance_auto_execution_safeguard requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const safeguardFromId = parsed.safeguardId
        ? await repos.filingEscalationClosureRebalanceSafeguards.get(parsed.safeguardId)
        : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : safeguardFromId
            ? await repos.filingEscalationClosureEnforcementRebalance.get(safeguardFromId.rebalanceId)
            : queueFromSelector
              ? await repos.filingEscalationClosureEnforcementRebalance.get(
                  filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
                )
              : null) ?? null
      if (!rebalance || rebalance.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure enforcement rebalance row not found" }, { status: 404 })
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(rebalance.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const execution = await repos.filingEscalationClosureRebalanceExecution.get(
        filingEscalationClosureRebalanceExecutionId(rebalance.id)
      )
      const existingSafeguard = await repos.filingEscalationClosureRebalanceSafeguards.get(
        filingEscalationClosureRebalanceSafeguardId(rebalance.id)
      )
      const priorAuditCount = store.audit.length
      const safeguardUpdated = buildFilingEscalationClosureRebalanceSafeguardRow({
        rebalance,
        queue,
        execution,
        existing: existingSafeguard,
        cooldownLockHours,
        duplicateSuppressionHours,
        now,
        note: parsed.note ?? "auto-execution safeguard configuration updated",
      })
      await repos.filingEscalationClosureRebalanceSafeguards.upsert(safeguardUpdated)
      store.filingEscalationClosureRebalanceSafeguards.set(safeguardUpdated.id, safeguardUpdated)
      store.audit.push({
        action: "filing_closure_rebalance_safeguard_configure",
        actorId: actor.id,
        target: safeguardUpdated.id,
        classification: safeguardUpdated.classification,
        reason: safeguardUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "configure_closure_rebalance_auto_execution_safeguard",
        closureRebalanceSafeguard:
          (await repos.filingEscalationClosureRebalanceSafeguards.get(safeguardUpdated.id)) ??
          safeguardUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_closure_rebalance_auto_execution_override") {
      if (
        !parsed.actorId ||
        (!parsed.safeguardId && !parsed.rebalanceId && !parsed.queueId && !parsed.ownerId) ||
        !parsed.reason?.trim()
      ) {
        return NextResponse.json(
          { error: "actorId, reason, and safeguardId/rebalanceId/queueId/ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_closure_rebalance_auto_execution_override requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const safeguardFromId = parsed.safeguardId
        ? await repos.filingEscalationClosureRebalanceSafeguards.get(parsed.safeguardId)
        : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : safeguardFromId
            ? await repos.filingEscalationClosureEnforcementRebalance.get(safeguardFromId.rebalanceId)
            : queueFromSelector
              ? await repos.filingEscalationClosureEnforcementRebalance.get(
                  filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
                )
              : null) ?? null
      if (!rebalance || rebalance.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure enforcement rebalance row not found" }, { status: 404 })
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(rebalance.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const execution = await repos.filingEscalationClosureRebalanceExecution.get(
        filingEscalationClosureRebalanceExecutionId(rebalance.id)
      )
      const existingSafeguard = await repos.filingEscalationClosureRebalanceSafeguards.get(
        filingEscalationClosureRebalanceSafeguardId(rebalance.id)
      )
      const priorAuditCount = store.audit.length
      const safeguardUpdated = buildFilingEscalationClosureRebalanceSafeguardRow({
        rebalance,
        queue,
        execution,
        existing: existingSafeguard,
        overrideAttestedBy: actor.id,
        overrideReason: parsed.reason.trim(),
        now,
        note: parsed.note ?? `override attested: ${parsed.reason.trim()}`,
      })
      await repos.filingEscalationClosureRebalanceSafeguards.upsert(safeguardUpdated)
      store.filingEscalationClosureRebalanceSafeguards.set(safeguardUpdated.id, safeguardUpdated)
      store.audit.push({
        action: "filing_closure_rebalance_override_attest",
        actorId: actor.id,
        target: safeguardUpdated.id,
        classification: safeguardUpdated.classification,
        reason: parsed.reason.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_closure_rebalance_auto_execution_override",
        closureRebalanceSafeguard:
          (await repos.filingEscalationClosureRebalanceSafeguards.get(safeguardUpdated.id)) ??
          safeguardUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "record_closure_adjudication_slo_debt_remediation") {
      if (!parsed.actorId || (!parsed.remediationId && !parsed.sloId && !parsed.adjudicationId)) {
        return NextResponse.json(
          { error: "actorId and remediationId/sloId/adjudicationId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "record_closure_adjudication_slo_debt_remediation requires partner role" },
          { status: 403 }
        )
      }
      const existingRemediation = parsed.remediationId
        ? await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(parsed.remediationId)
        : null
      const adjudicationId = parsed.adjudicationId ?? existingRemediation?.adjudicationId ?? null
      const resolvedSloId = parsed.sloId ?? existingRemediation?.adjudicationSloId ?? null
      if (!adjudicationId && !resolvedSloId) {
        return NextResponse.json(
          { error: "closure adjudication or SLO selector could not be resolved" },
          { status: 404 }
        )
      }
      const adjudication = adjudicationId
        ? await repos.filingEscalationClosureAdjudicationQueue.get(adjudicationId)
        : null
      const sloFromId = resolvedSloId
        ? await repos.filingEscalationClosureAdjudicationSlo.get(resolvedSloId)
        : null
      const sloFromAdjudication = adjudication
        ? await repos.filingEscalationClosureAdjudicationSlo.get(
            filingEscalationClosureAdjudicationSloId(adjudication.id)
          )
        : null
      const slo = sloFromId ?? sloFromAdjudication
      if (!slo || slo.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication SLO row not found" }, { status: 404 })
      }
      if (slo.breachDebtHours <= 0) {
        return NextResponse.json(
          { error: "no active SLO debt remains for remediation note" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const remediationUpdated = buildFilingEscalationClosureAdjudicationSloDebtRemediationRow({
        slo,
        existing: existingRemediation,
        retirementNotedBy: actor.id,
        now,
        note: parsed.note ?? "SLO debt remediation note recorded",
      })
      await repos.filingEscalationClosureAdjudicationSloDebtRemediation.upsert(remediationUpdated)
      store.filingEscalationClosureAdjudicationSloDebtRemediation.set(
        remediationUpdated.id,
        remediationUpdated
      )
      store.audit.push({
        action: "filing_closure_adjudication_slo_debt_remediation_record",
        actorId: actor.id,
        target: remediationUpdated.id,
        classification: remediationUpdated.classification,
        reason: remediationUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "record_closure_adjudication_slo_debt_remediation",
        closureAdjudicationSloDebtRemediation:
          (await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(remediationUpdated.id)) ??
          remediationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "downshift_closure_adjudication_slo_tier") {
      if (
        !parsed.actorId ||
        (!parsed.remediationId && !parsed.sloId && !parsed.adjudicationId) ||
        !parsed.escalationTier
      ) {
        return NextResponse.json(
          { error: "actorId, escalationTier, and remediationId/sloId/adjudicationId are required" },
          { status: 400 }
        )
      }
      if (!isFilingEscalationClosureAdjudicationSloEscalationTier(parsed.escalationTier)) {
        return NextResponse.json(
          { error: "escalationTier must be a valid adjudication SLO escalation tier" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "downshift_closure_adjudication_slo_tier requires partner role" },
          { status: 403 }
        )
      }
      const existingRemediation = parsed.remediationId
        ? await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(parsed.remediationId)
        : null
      const adjudicationId = parsed.adjudicationId ?? existingRemediation?.adjudicationId ?? null
      const resolvedSloId = parsed.sloId ?? existingRemediation?.adjudicationSloId ?? null
      const adjudication = adjudicationId
        ? await repos.filingEscalationClosureAdjudicationQueue.get(adjudicationId)
        : null
      const existingSlo =
        (resolvedSloId
          ? await repos.filingEscalationClosureAdjudicationSlo.get(resolvedSloId)
          : null) ??
        (adjudication
          ? await repos.filingEscalationClosureAdjudicationSlo.get(
              filingEscalationClosureAdjudicationSloId(adjudication.id)
            )
          : null)
      if (!existingSlo || existingSlo.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication SLO row not found" }, { status: 404 })
      }
      if (
        !canDownshiftClosureAdjudicationSloTier({
          currentTier: existingSlo.escalationTier,
          nextTier: parsed.escalationTier,
        })
      ) {
        return NextResponse.json(
          { error: "downshift tier must be lower than or equal to current SLO escalation tier" },
          { status: 422 }
        )
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(existingSlo.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const adjudicationRow = adjudication
        ? adjudication
        : await repos.filingEscalationClosureAdjudicationQueue.get(existingSlo.adjudicationId)
      if (!adjudicationRow) {
        return NextResponse.json({ error: "closure adjudication row not found" }, { status: 404 })
      }
      const quorum = await repos.filingEscalationClosureAdjudicationQuorum.get(
        filingEscalationClosureAdjudicationQuorumId(adjudicationRow.id)
      )
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const sloUpdated = buildFilingEscalationClosureAdjudicationSloRow({
        adjudication: adjudicationRow,
        queue,
        quorum,
        existing: existingSlo,
        escalationTierOverride: parsed.escalationTier,
        now,
        note: parsed.note ?? `SLO escalation tier downshifted to ${parsed.escalationTier}`,
      })
      await repos.filingEscalationClosureAdjudicationSlo.upsert(sloUpdated)
      store.filingEscalationClosureAdjudicationSlo.set(sloUpdated.id, sloUpdated)
      const remediationUpdated = buildFilingEscalationClosureAdjudicationSloDebtRemediationRow({
        slo: sloUpdated,
        existing: existingRemediation,
        tierDownshiftedTo: parsed.escalationTier,
        tierDownshiftedBy: actor.id,
        now,
        note: parsed.note ?? `debt-remediation tier downshift to ${parsed.escalationTier}`,
      })
      await repos.filingEscalationClosureAdjudicationSloDebtRemediation.upsert(remediationUpdated)
      store.filingEscalationClosureAdjudicationSloDebtRemediation.set(
        remediationUpdated.id,
        remediationUpdated
      )
      store.audit.push({
        action: "filing_closure_adjudication_slo_tier_downshift",
        actorId: actor.id,
        target: remediationUpdated.id,
        classification: remediationUpdated.classification,
        reason: parsed.escalationTier,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "downshift_closure_adjudication_slo_tier",
        closureAdjudicationSlo:
          (await repos.filingEscalationClosureAdjudicationSlo.get(sloUpdated.id)) ?? sloUpdated,
        closureAdjudicationSloDebtRemediation:
          (await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(remediationUpdated.id)) ??
          remediationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_closure_adjudication_slo_breach_closure") {
      if (!parsed.actorId || (!parsed.remediationId && !parsed.sloId && !parsed.adjudicationId)) {
        return NextResponse.json(
          { error: "actorId and remediationId/sloId/adjudicationId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_closure_adjudication_slo_breach_closure requires partner role" },
          { status: 403 }
        )
      }
      const existingRemediation = parsed.remediationId
        ? await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(parsed.remediationId)
        : null
      const adjudicationId = parsed.adjudicationId ?? existingRemediation?.adjudicationId ?? null
      const resolvedSloId = parsed.sloId ?? existingRemediation?.adjudicationSloId ?? null
      const adjudication = adjudicationId
        ? await repos.filingEscalationClosureAdjudicationQueue.get(adjudicationId)
        : null
      const slo =
        (resolvedSloId
          ? await repos.filingEscalationClosureAdjudicationSlo.get(resolvedSloId)
          : null) ??
        (adjudication
          ? await repos.filingEscalationClosureAdjudicationSlo.get(
              filingEscalationClosureAdjudicationSloId(adjudication.id)
            )
          : null)
      if (!slo || slo.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication SLO row not found" }, { status: 404 })
      }
      if (slo.breachDebtHours > 0 || slo.status === "breach_open" || slo.status === "breach_acknowledged") {
        return NextResponse.json(
          { error: "SLO debt still open; breach closure attestation is not yet allowed" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const remediationUpdated = buildFilingEscalationClosureAdjudicationSloDebtRemediationRow({
        slo,
        existing: existingRemediation,
        breachClosureAttestedBy: actor.id,
        now,
        note: parsed.note ?? "SLO breach closure attested",
      })
      await repos.filingEscalationClosureAdjudicationSloDebtRemediation.upsert(remediationUpdated)
      store.filingEscalationClosureAdjudicationSloDebtRemediation.set(
        remediationUpdated.id,
        remediationUpdated
      )
      store.audit.push({
        action: "filing_closure_adjudication_slo_breach_closure_attest",
        actorId: actor.id,
        target: remediationUpdated.id,
        classification: remediationUpdated.classification,
        reason: remediationUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_closure_adjudication_slo_breach_closure",
        closureAdjudicationSloDebtRemediation:
          (await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(remediationUpdated.id)) ??
          remediationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "set_closure_rebalance_safeguard_override_expiry") {
      if (!parsed.actorId || (!parsed.expiryId && !parsed.safeguardId && !parsed.rebalanceId && !parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId and expiryId/safeguardId/rebalanceId/queueId/ownerId are required" },
          { status: 400 }
        )
      }
      const overrideExpiryHours =
        parsed.overrideExpiryHours === undefined ? undefined : Number(parsed.overrideExpiryHours)
      if (
        overrideExpiryHours !== undefined &&
        (!Number.isFinite(overrideExpiryHours) || overrideExpiryHours < 0 || overrideExpiryHours > 168)
      ) {
        return NextResponse.json(
          { error: "overrideExpiryHours must be between 0 and 168" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "set_closure_rebalance_safeguard_override_expiry requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : null
      const safeguardFromId =
        (parsed.safeguardId
          ? await repos.filingEscalationClosureRebalanceSafeguards.get(parsed.safeguardId)
          : null) ??
        (existingExpiry
          ? await repos.filingEscalationClosureRebalanceSafeguards.get(existingExpiry.safeguardId)
          : null)
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : safeguardFromId
            ? await repos.filingEscalationClosureEnforcementRebalance.get(safeguardFromId.rebalanceId)
            : queueFromSelector
              ? await repos.filingEscalationClosureEnforcementRebalance.get(
                  filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
                )
              : null) ?? null
      if (!rebalance || rebalance.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure enforcement rebalance row not found" }, { status: 404 })
      }
      const safeguard =
        safeguardFromId ??
        (await repos.filingEscalationClosureRebalanceSafeguards.get(
          filingEscalationClosureRebalanceSafeguardId(rebalance.id)
        ))
      if (!safeguard) {
        return NextResponse.json({ error: "closure rebalance safeguard row not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const expiryUpdated = buildFilingEscalationClosureRebalanceSafeguardExpiryRow({
        safeguard,
        existing: existingExpiry,
        overrideExpiryHours,
        now,
        note: parsed.note ?? "rebalance safeguard override expiry updated",
      })
      await repos.filingEscalationClosureRebalanceSafeguardExpiry.upsert(expiryUpdated)
      store.filingEscalationClosureRebalanceSafeguardExpiry.set(expiryUpdated.id, expiryUpdated)
      store.audit.push({
        action: "filing_closure_rebalance_safeguard_override_expiry_set",
        actorId: actor.id,
        target: expiryUpdated.id,
        classification: expiryUpdated.classification,
        reason: String(overrideExpiryHours ?? 0),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "set_closure_rebalance_safeguard_override_expiry",
        closureRebalanceSafeguardExpiry:
          (await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(expiryUpdated.id)) ??
          expiryUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "auto_clear_closure_rebalance_safeguard_suppression") {
      if (!parsed.actorId || (!parsed.expiryId && !parsed.safeguardId && !parsed.rebalanceId && !parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId and expiryId/safeguardId/rebalanceId/queueId/ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "auto_clear_closure_rebalance_safeguard_suppression requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : null
      const safeguardFromId =
        (parsed.safeguardId
          ? await repos.filingEscalationClosureRebalanceSafeguards.get(parsed.safeguardId)
          : null) ??
        (existingExpiry
          ? await repos.filingEscalationClosureRebalanceSafeguards.get(existingExpiry.safeguardId)
          : null)
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : safeguardFromId
            ? await repos.filingEscalationClosureEnforcementRebalance.get(safeguardFromId.rebalanceId)
            : queueFromSelector
              ? await repos.filingEscalationClosureEnforcementRebalance.get(
                  filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
                )
              : null) ?? null
      if (!rebalance || rebalance.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure enforcement rebalance row not found" }, { status: 404 })
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(rebalance.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const execution = await repos.filingEscalationClosureRebalanceExecution.get(
        filingEscalationClosureRebalanceExecutionId(rebalance.id)
      )
      const existingSafeguard =
        safeguardFromId ??
        (await repos.filingEscalationClosureRebalanceSafeguards.get(
          filingEscalationClosureRebalanceSafeguardId(rebalance.id)
        ))
      if (!existingSafeguard) {
        return NextResponse.json({ error: "closure rebalance safeguard row not found" }, { status: 404 })
      }
      if (
        existingSafeguard.cooldownLockUntil === null &&
        existingSafeguard.duplicateSuppressionUntil === null
      ) {
        return NextResponse.json(
          { error: "no active safeguard suppression to auto-clear" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const safeguardUpdated = buildFilingEscalationClosureRebalanceSafeguardRow({
        rebalance,
        queue,
        execution,
        existing: existingSafeguard,
        cooldownLockHours: 0,
        duplicateSuppressionHours: 0,
        now,
        note: parsed.note ?? "safeguard suppression windows auto-cleared",
      })
      await repos.filingEscalationClosureRebalanceSafeguards.upsert(safeguardUpdated)
      store.filingEscalationClosureRebalanceSafeguards.set(safeguardUpdated.id, safeguardUpdated)
      const expiryUpdated = buildFilingEscalationClosureRebalanceSafeguardExpiryRow({
        safeguard: safeguardUpdated,
        existing: existingExpiry,
        clearSuppression: true,
        now,
        note: parsed.note ?? "safeguard suppression auto-clear recorded",
      })
      await repos.filingEscalationClosureRebalanceSafeguardExpiry.upsert(expiryUpdated)
      store.filingEscalationClosureRebalanceSafeguardExpiry.set(expiryUpdated.id, expiryUpdated)
      store.audit.push({
        action: "filing_closure_rebalance_safeguard_suppression_auto_clear",
        actorId: actor.id,
        target: expiryUpdated.id,
        classification: expiryUpdated.classification,
        reason: expiryUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "auto_clear_closure_rebalance_safeguard_suppression",
        closureRebalanceSafeguard:
          (await repos.filingEscalationClosureRebalanceSafeguards.get(safeguardUpdated.id)) ??
          safeguardUpdated,
        closureRebalanceSafeguardExpiry:
          (await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(expiryUpdated.id)) ??
          expiryUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "cleanup_stale_closure_rebalance_safeguard_lock") {
      if (!parsed.actorId || (!parsed.expiryId && !parsed.safeguardId && !parsed.rebalanceId && !parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId and expiryId/safeguardId/rebalanceId/queueId/ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "cleanup_stale_closure_rebalance_safeguard_lock requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : null
      const safeguardFromId =
        (parsed.safeguardId
          ? await repos.filingEscalationClosureRebalanceSafeguards.get(parsed.safeguardId)
          : null) ??
        (existingExpiry
          ? await repos.filingEscalationClosureRebalanceSafeguards.get(existingExpiry.safeguardId)
          : null)
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : safeguardFromId
            ? await repos.filingEscalationClosureEnforcementRebalance.get(safeguardFromId.rebalanceId)
            : queueFromSelector
              ? await repos.filingEscalationClosureEnforcementRebalance.get(
                  filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
                )
              : null) ?? null
      if (!rebalance || rebalance.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure enforcement rebalance row not found" }, { status: 404 })
      }
      const queue = await repos.filingEscalationClosureFollowupQueues.get(rebalance.queueId)
      if (!queue) {
        return NextResponse.json({ error: "linked closure follow-up queue not found" }, { status: 404 })
      }
      const execution = await repos.filingEscalationClosureRebalanceExecution.get(
        filingEscalationClosureRebalanceExecutionId(rebalance.id)
      )
      const existingSafeguard =
        safeguardFromId ??
        (await repos.filingEscalationClosureRebalanceSafeguards.get(
          filingEscalationClosureRebalanceSafeguardId(rebalance.id)
        ))
      if (!existingSafeguard) {
        return NextResponse.json({ error: "closure rebalance safeguard row not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const safeguardUpdated = buildFilingEscalationClosureRebalanceSafeguardRow({
        rebalance,
        queue,
        execution,
        existing: existingSafeguard,
        cooldownLockHours: 0,
        duplicateSuppressionHours: 0,
        now,
        note: parsed.note ?? "stale safeguard lock cleaned",
      })
      await repos.filingEscalationClosureRebalanceSafeguards.upsert(safeguardUpdated)
      store.filingEscalationClosureRebalanceSafeguards.set(safeguardUpdated.id, safeguardUpdated)
      const expiryUpdated = buildFilingEscalationClosureRebalanceSafeguardExpiryRow({
        safeguard: safeguardUpdated,
        existing: existingExpiry,
        clearSuppression: true,
        staleLockCleanedBy: actor.id,
        now,
        note: parsed.note ?? "stale safeguard lock cleanup attested",
      })
      await repos.filingEscalationClosureRebalanceSafeguardExpiry.upsert(expiryUpdated)
      store.filingEscalationClosureRebalanceSafeguardExpiry.set(expiryUpdated.id, expiryUpdated)
      store.audit.push({
        action: "filing_closure_rebalance_safeguard_stale_lock_cleanup",
        actorId: actor.id,
        target: expiryUpdated.id,
        classification: expiryUpdated.classification,
        reason: expiryUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "cleanup_stale_closure_rebalance_safeguard_lock",
        closureRebalanceSafeguard:
          (await repos.filingEscalationClosureRebalanceSafeguards.get(safeguardUpdated.id)) ??
          safeguardUpdated,
        closureRebalanceSafeguardExpiry:
          (await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(expiryUpdated.id)) ??
          expiryUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "set_closure_adjudication_debt_burndown_target") {
      if (
        !parsed.actorId ||
        (!parsed.burndownId && !parsed.remediationId && !parsed.adjudicationId) ||
        parsed.targetHours === undefined
      ) {
        return NextResponse.json(
          { error: "actorId, targetHours, and burndownId/remediationId/adjudicationId are required" },
          { status: 400 }
        )
      }
      const targetHours = Number(parsed.targetHours)
      if (!Number.isFinite(targetHours) || targetHours < 0 || targetHours > 336) {
        return NextResponse.json({ error: "targetHours must be between 0 and 336" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "set_closure_adjudication_debt_burndown_target requires partner role" },
          { status: 403 }
        )
      }
      const existingBurndown = parsed.burndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(parsed.burndownId)
        : null
      const remediationId = parsed.remediationId ?? existingBurndown?.remediationId ?? null
      const adjudicationId = parsed.adjudicationId ?? existingBurndown?.adjudicationId ?? null
      const remediationFromId = remediationId
        ? await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(remediationId)
        : null
      const remediationFromAdjudication = adjudicationId
        ? await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(
            filingEscalationClosureAdjudicationSloDebtRemediationId(
              filingEscalationClosureAdjudicationSloId(adjudicationId)
            )
          )
        : null
      const remediation = remediationFromId ?? remediationFromAdjudication
      if (!remediation || remediation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt remediation row not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const burndownUpdated = buildFilingEscalationClosureAdjudicationDebtBurndownRow({
        remediation,
        existing: existingBurndown,
        retirementTargetHours: targetHours,
        now,
        note: parsed.note ?? `debt burndown target set to ${targetHours} hours`,
      })
      await repos.filingEscalationClosureAdjudicationDebtBurndown.upsert(burndownUpdated)
      store.filingEscalationClosureAdjudicationDebtBurndown.set(burndownUpdated.id, burndownUpdated)
      store.audit.push({
        action: "filing_closure_adjudication_debt_burndown_target_set",
        actorId: actor.id,
        target: burndownUpdated.id,
        classification: burndownUpdated.classification,
        reason: String(targetHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "set_closure_adjudication_debt_burndown_target",
        closureAdjudicationDebtBurndown:
          (await repos.filingEscalationClosureAdjudicationDebtBurndown.get(burndownUpdated.id)) ??
          burndownUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_closure_adjudication_debt_backlog") {
      if (!parsed.actorId || (!parsed.burndownId && !parsed.remediationId && !parsed.adjudicationId)) {
        return NextResponse.json(
          { error: "actorId and burndownId/remediationId/adjudicationId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_closure_adjudication_debt_backlog requires partner role" },
          { status: 403 }
        )
      }
      const existingBurndown = parsed.burndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(parsed.burndownId)
        : null
      const remediationId = parsed.remediationId ?? existingBurndown?.remediationId ?? null
      const adjudicationId = parsed.adjudicationId ?? existingBurndown?.adjudicationId ?? null
      const remediationFromId = remediationId
        ? await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(remediationId)
        : null
      const remediationFromAdjudication = adjudicationId
        ? await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(
            filingEscalationClosureAdjudicationSloDebtRemediationId(
              filingEscalationClosureAdjudicationSloId(adjudicationId)
            )
          )
        : null
      const remediation = remediationFromId ?? remediationFromAdjudication
      if (!remediation || remediation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt remediation row not found" }, { status: 404 })
      }
      if (remediation.debtAgeHours <= 0) {
        return NextResponse.json({ error: "no debt backlog available for attestation" }, { status: 422 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const burndownUpdated = buildFilingEscalationClosureAdjudicationDebtBurndownRow({
        remediation,
        existing: existingBurndown,
        backlogAttestedBy: actor.id,
        now,
        note: parsed.note ?? "debt backlog attested",
      })
      await repos.filingEscalationClosureAdjudicationDebtBurndown.upsert(burndownUpdated)
      store.filingEscalationClosureAdjudicationDebtBurndown.set(burndownUpdated.id, burndownUpdated)
      store.audit.push({
        action: "filing_closure_adjudication_debt_backlog_attest",
        actorId: actor.id,
        target: burndownUpdated.id,
        classification: burndownUpdated.classification,
        reason: burndownUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_closure_adjudication_debt_backlog",
        closureAdjudicationDebtBurndown:
          (await repos.filingEscalationClosureAdjudicationDebtBurndown.get(burndownUpdated.id)) ??
          burndownUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "checkpoint_closure_adjudication_tier_normalization") {
      if (
        !parsed.actorId ||
        (!parsed.burndownId && !parsed.remediationId && !parsed.adjudicationId) ||
        !parsed.escalationTier
      ) {
        return NextResponse.json(
          { error: "actorId, escalationTier, and burndownId/remediationId/adjudicationId are required" },
          { status: 400 }
        )
      }
      if (!isFilingEscalationClosureAdjudicationSloEscalationTier(parsed.escalationTier)) {
        return NextResponse.json(
          { error: "escalationTier must be a valid adjudication SLO escalation tier" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "checkpoint_closure_adjudication_tier_normalization requires partner role" },
          { status: 403 }
        )
      }
      const existingBurndown = parsed.burndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(parsed.burndownId)
        : null
      const remediationId = parsed.remediationId ?? existingBurndown?.remediationId ?? null
      const adjudicationId = parsed.adjudicationId ?? existingBurndown?.adjudicationId ?? null
      const remediationFromId = remediationId
        ? await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(remediationId)
        : null
      const remediationFromAdjudication = adjudicationId
        ? await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(
            filingEscalationClosureAdjudicationSloDebtRemediationId(
              filingEscalationClosureAdjudicationSloId(adjudicationId)
            )
          )
        : null
      const remediation = remediationFromId ?? remediationFromAdjudication
      if (!remediation || remediation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt remediation row not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const burndownUpdated = buildFilingEscalationClosureAdjudicationDebtBurndownRow({
        remediation,
        existing: existingBurndown,
        tierNormalizedBy: actor.id,
        tierNormalizedTo: parsed.escalationTier,
        now,
        note: parsed.note ?? `tier normalization checkpoint: ${parsed.escalationTier}`,
      })
      await repos.filingEscalationClosureAdjudicationDebtBurndown.upsert(burndownUpdated)
      store.filingEscalationClosureAdjudicationDebtBurndown.set(burndownUpdated.id, burndownUpdated)
      store.audit.push({
        action: "filing_closure_adjudication_tier_normalization_checkpoint",
        actorId: actor.id,
        target: burndownUpdated.id,
        classification: burndownUpdated.classification,
        reason: parsed.escalationTier,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "checkpoint_closure_adjudication_tier_normalization",
        closureAdjudicationDebtBurndown:
          (await repos.filingEscalationClosureAdjudicationDebtBurndown.get(burndownUpdated.id)) ??
          burndownUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_closure_safeguard_expiry_attestation") {
      if (
        !parsed.actorId ||
        (!parsed.attestationId && !parsed.expiryId && !parsed.rebalanceId && !parsed.queueId && !parsed.ownerId)
      ) {
        return NextResponse.json(
          { error: "actorId and attestationId/expiryId/rebalanceId/queueId/ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_closure_safeguard_expiry_attestation requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingAttestation = parsed.attestationId
        ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
        : null
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedExpiry =
        existingExpiry ??
        (rebalance
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(
              filingEscalationClosureRebalanceSafeguardExpiryId(
                filingEscalationClosureRebalanceSafeguardId(rebalance.id)
              )
            )
          : null)
      if (!resolvedExpiry || resolvedExpiry.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry row not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const attestationUpdated = buildFilingEscalationClosureSafeguardExpiryAttestationRow({
        expiry: resolvedExpiry,
        existing: existingAttestation,
        acknowledgedBy: actor.id,
        now,
        note: parsed.note ?? "safeguard expiry attestation acknowledged",
      })
      await repos.filingEscalationClosureSafeguardExpiryAttestations.upsert(attestationUpdated)
      store.filingEscalationClosureSafeguardExpiryAttestations.set(
        attestationUpdated.id,
        attestationUpdated
      )
      store.audit.push({
        action: "filing_closure_safeguard_expiry_attestation_acknowledge",
        actorId: actor.id,
        target: attestationUpdated.id,
        classification: attestationUpdated.classification,
        reason: attestationUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_closure_safeguard_expiry_attestation",
        closureSafeguardExpiryAttestation:
          (await repos.filingEscalationClosureSafeguardExpiryAttestations.get(attestationUpdated.id)) ??
          attestationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "queue_closure_safeguard_overdue_expiry_exception") {
      if (
        !parsed.actorId ||
        (!parsed.attestationId && !parsed.expiryId && !parsed.rebalanceId && !parsed.queueId && !parsed.ownerId)
      ) {
        return NextResponse.json(
          { error: "actorId and attestationId/expiryId/rebalanceId/queueId/ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "queue_closure_safeguard_overdue_expiry_exception requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingAttestation = parsed.attestationId
        ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
        : null
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedExpiry =
        existingExpiry ??
        (rebalance
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(
              filingEscalationClosureRebalanceSafeguardExpiryId(
                filingEscalationClosureRebalanceSafeguardId(rebalance.id)
              )
            )
          : null)
      if (!resolvedExpiry || resolvedExpiry.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry row not found" }, { status: 404 })
      }
      if (resolvedExpiry.expiryDebtHours <= 0 && resolvedExpiry.status !== "override_expired") {
        return NextResponse.json(
          { error: "safeguard expiry is not overdue; exception queueing is unavailable" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const attestationUpdated = buildFilingEscalationClosureSafeguardExpiryAttestationRow({
        expiry: resolvedExpiry,
        existing: existingAttestation,
        queueOverdueExceptionBy: actor.id,
        now,
        note: parsed.note ?? "overdue safeguard expiry exception queued",
      })
      await repos.filingEscalationClosureSafeguardExpiryAttestations.upsert(attestationUpdated)
      store.filingEscalationClosureSafeguardExpiryAttestations.set(
        attestationUpdated.id,
        attestationUpdated
      )
      store.audit.push({
        action: "filing_closure_safeguard_overdue_expiry_exception_queue",
        actorId: actor.id,
        target: attestationUpdated.id,
        classification: attestationUpdated.classification,
        reason: attestationUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "queue_closure_safeguard_overdue_expiry_exception",
        closureSafeguardExpiryAttestation:
          (await repos.filingEscalationClosureSafeguardExpiryAttestations.get(attestationUpdated.id)) ??
          attestationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reconcile_closure_safeguard_expiry_override") {
      if (
        !parsed.actorId ||
        (!parsed.attestationId && !parsed.expiryId && !parsed.rebalanceId && !parsed.queueId && !parsed.ownerId)
      ) {
        return NextResponse.json(
          { error: "actorId and attestationId/expiryId/rebalanceId/queueId/ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "reconcile_closure_safeguard_expiry_override requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingAttestation = parsed.attestationId
        ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
        : null
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedExpiry =
        existingExpiry ??
        (rebalance
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(
              filingEscalationClosureRebalanceSafeguardExpiryId(
                filingEscalationClosureRebalanceSafeguardId(rebalance.id)
              )
            )
          : null)
      if (!resolvedExpiry || resolvedExpiry.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry row not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const attestationUpdated = buildFilingEscalationClosureSafeguardExpiryAttestationRow({
        expiry: resolvedExpiry,
        existing: existingAttestation,
        reconcileOverrideBy: actor.id,
        reconciliationNote: parsed.reconciliationNote,
        now,
        note: parsed.note ?? parsed.reconciliationNote ?? "expiry override reconciled",
      })
      await repos.filingEscalationClosureSafeguardExpiryAttestations.upsert(attestationUpdated)
      store.filingEscalationClosureSafeguardExpiryAttestations.set(
        attestationUpdated.id,
        attestationUpdated
      )
      store.audit.push({
        action: "filing_closure_safeguard_expiry_override_reconcile",
        actorId: actor.id,
        target: attestationUpdated.id,
        classification: attestationUpdated.classification,
        reason: attestationUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "reconcile_closure_safeguard_expiry_override",
        closureSafeguardExpiryAttestation:
          (await repos.filingEscalationClosureSafeguardExpiryAttestations.get(attestationUpdated.id)) ??
          attestationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "rebaseline_closure_adjudication_burndown_forecast") {
      if (
        !parsed.actorId ||
        (!parsed.recalibrationId && !parsed.burndownId && !parsed.remediationId && !parsed.adjudicationId) ||
        parsed.targetHours === undefined
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, targetHours, and recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const targetHours = Number(parsed.targetHours)
      if (!Number.isFinite(targetHours) || targetHours < 0 || targetHours > 336) {
        return NextResponse.json({ error: "targetHours must be between 0 and 336" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "rebaseline_closure_adjudication_burndown_forecast requires partner role" },
          { status: 403 }
        )
      }
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const recalibrationExistingByBurndown =
        await repos.filingEscalationClosureBurndownRecalibration.get(
          filingEscalationClosureBurndownRecalibrationId(burndown.id)
        )
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing: existingRecalibration ?? recalibrationExistingByBurndown,
        rebaselineTargetHours: targetHours,
        now,
        note: parsed.note ?? `burndown forecast re-baselined to ${targetHours} hours`,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      store.audit.push({
        action: "filing_closure_burndown_recalibration_rebaseline",
        actorId: actor.id,
        target: recalibrationUpdated.id,
        classification: recalibrationUpdated.classification,
        reason: String(targetHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "rebaseline_closure_adjudication_burndown_forecast",
        closureBurndownRecalibration:
          (await repos.filingEscalationClosureBurndownRecalibration.get(recalibrationUpdated.id)) ??
          recalibrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "override_closure_adjudication_burndown_confidence_band") {
      if (
        !parsed.actorId ||
        (!parsed.recalibrationId && !parsed.burndownId && !parsed.remediationId && !parsed.adjudicationId) ||
        parsed.lowerHours === undefined ||
        parsed.upperHours === undefined
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, lowerHours, upperHours, and recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const lowerHours = Number(parsed.lowerHours)
      const upperHours = Number(parsed.upperHours)
      if (
        !Number.isFinite(lowerHours) ||
        !Number.isFinite(upperHours) ||
        lowerHours < 0 ||
        upperHours < lowerHours ||
        upperHours > 336
      ) {
        return NextResponse.json(
          { error: "confidence band must satisfy 0 <= lowerHours <= upperHours <= 336" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "override_closure_adjudication_burndown_confidence_band requires partner role" },
          { status: 403 }
        )
      }
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const recalibrationExistingByBurndown =
        await repos.filingEscalationClosureBurndownRecalibration.get(
          filingEscalationClosureBurndownRecalibrationId(burndown.id)
        )
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing: existingRecalibration ?? recalibrationExistingByBurndown,
        confidenceBandLowerHours: lowerHours,
        confidenceBandUpperHours: upperHours,
        confidenceOverriddenBy: actor.id,
        now,
        note: parsed.note ?? `confidence band overridden to ${lowerHours}-${upperHours} hours`,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      store.audit.push({
        action: "filing_closure_burndown_recalibration_confidence_override",
        actorId: actor.id,
        target: recalibrationUpdated.id,
        classification: recalibrationUpdated.classification,
        reason: `${lowerHours}-${upperHours}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "override_closure_adjudication_burndown_confidence_band",
        closureBurndownRecalibration:
          (await repos.filingEscalationClosureBurndownRecalibration.get(recalibrationUpdated.id)) ??
          recalibrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "annotate_closure_adjudication_burndown_checkpoint_rollback") {
      if (
        !parsed.actorId ||
        (!parsed.recalibrationId && !parsed.burndownId && !parsed.remediationId && !parsed.adjudicationId) ||
        !parsed.rollbackReason?.trim()
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, rollbackReason, and recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "annotate_closure_adjudication_burndown_checkpoint_rollback requires partner role" },
          { status: 403 }
        )
      }
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const recalibrationExistingByBurndown =
        await repos.filingEscalationClosureBurndownRecalibration.get(
          filingEscalationClosureBurndownRecalibrationId(burndown.id)
        )
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing: existingRecalibration ?? recalibrationExistingByBurndown,
        rollbackNotedBy: actor.id,
        rollbackReason: parsed.rollbackReason.trim(),
        now,
        note: parsed.note ?? `checkpoint rollback annotated: ${parsed.rollbackReason.trim()}`,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      store.audit.push({
        action: "filing_closure_burndown_recalibration_checkpoint_rollback",
        actorId: actor.id,
        target: recalibrationUpdated.id,
        classification: recalibrationUpdated.classification,
        reason: parsed.rollbackReason.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "annotate_closure_adjudication_burndown_checkpoint_rollback",
        closureBurndownRecalibration:
          (await repos.filingEscalationClosureBurndownRecalibration.get(recalibrationUpdated.id)) ??
          recalibrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "triage_closure_safeguard_expiry_attestation_queue") {
      if (
        !parsed.actorId ||
        (!parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "triage_closure_safeguard_expiry_attestation_queue requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const existingQueueByAttestation =
        await repos.filingEscalationClosureExpiryAttestationQueue.get(
          filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
        )
      const priorAuditCount = store.audit.length
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing: existingQueueItem ?? existingQueueByAttestation,
        triagedBy: actor.id,
        now,
        note: parsed.note ?? "expiry attestation queue item triaged",
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      store.audit.push({
        action: "filing_closure_expiry_attestation_queue_triage",
        actorId: actor.id,
        target: queueUpdated.id,
        classification: queueUpdated.classification,
        reason: queueUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "triage_closure_safeguard_expiry_attestation_queue",
        closureExpiryAttestationQueue:
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(queueUpdated.id)) ??
          queueUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_closure_safeguard_expiry_queue_handoff") {
      if (
        !parsed.actorId ||
        !parsed.handoffToOwnerId?.trim() ||
        (!parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, handoffToOwnerId, and queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_closure_safeguard_expiry_queue_handoff requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const existingQueueByAttestation =
        await repos.filingEscalationClosureExpiryAttestationQueue.get(
          filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
        )
      const priorAuditCount = store.audit.length
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing: existingQueueItem ?? existingQueueByAttestation,
        handoffAttestedBy: actor.id,
        handoffToOwnerId: parsed.handoffToOwnerId.trim(),
        reconciliationCarryoverNote: parsed.carryoverNote,
        now,
        note: parsed.note ?? "expiry attestation queue handoff attested",
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      store.audit.push({
        action: "filing_closure_expiry_attestation_queue_handoff_attest",
        actorId: actor.id,
        target: queueUpdated.id,
        classification: queueUpdated.classification,
        reason: parsed.handoffToOwnerId.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_closure_safeguard_expiry_queue_handoff",
        closureExpiryAttestationQueue:
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(queueUpdated.id)) ??
          queueUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "checkpoint_closure_safeguard_expiry_queue_auto_drain") {
      if (
        !parsed.actorId ||
        (!parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "checkpoint_closure_safeguard_expiry_queue_auto_drain requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      if (resolvedAttestation.openBacklogHours > 0) {
        return NextResponse.json(
          { error: "attestation backlog still open; queue auto-drain checkpoint is unavailable" },
          { status: 422 }
        )
      }
      const existingQueueByAttestation =
        await repos.filingEscalationClosureExpiryAttestationQueue.get(
          filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
        )
      const priorAuditCount = store.audit.length
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing: existingQueueItem ?? existingQueueByAttestation,
        autoDrainCheckpointBy: actor.id,
        now,
        note: parsed.note ?? "expiry attestation queue auto-drain checkpoint recorded",
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      store.audit.push({
        action: "filing_closure_expiry_attestation_queue_auto_drain_checkpoint",
        actorId: actor.id,
        target: queueUpdated.id,
        classification: queueUpdated.classification,
        reason: queueUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "checkpoint_closure_safeguard_expiry_queue_auto_drain",
        closureExpiryAttestationQueue:
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(queueUpdated.id)) ??
          queueUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_closure_burndown_settlement_drift") {
      if (
        !parsed.actorId ||
        (!parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_closure_burndown_settlement_drift requires partner role" },
          { status: 403 }
        )
      }
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        driftAcknowledgedBy: actor.id,
        now,
        note: parsed.note ?? "burndown settlement drift acknowledged",
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      store.audit.push({
        action: "filing_closure_burndown_settlement_drift_acknowledge",
        actorId: actor.id,
        target: settlementUpdated.id,
        classification: settlementUpdated.classification,
        reason: settlementUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_closure_burndown_settlement_drift",
        closureBurndownSettlement:
          (await repos.filingEscalationClosureBurndownSettlement.get(settlementUpdated.id)) ??
          settlementUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_closure_burndown_settlement_target_lock") {
      if (
        !parsed.actorId ||
        (!parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_closure_burndown_settlement_target_lock requires partner role" },
          { status: 403 }
        )
      }
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        targetLockAttestedBy: actor.id,
        now,
        note: parsed.note ?? "burndown settlement target lock attested",
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      store.audit.push({
        action: "filing_closure_burndown_settlement_target_lock_attest",
        actorId: actor.id,
        target: settlementUpdated.id,
        classification: settlementUpdated.classification,
        reason: settlementUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_closure_burndown_settlement_target_lock",
        closureBurndownSettlement:
          (await repos.filingEscalationClosureBurndownSettlement.get(settlementUpdated.id)) ??
          settlementUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "close_closure_burndown_rollback_resolution") {
      if (
        !parsed.actorId ||
        (!parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId) ||
        !parsed.resolutionNote?.trim()
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, resolutionNote, and settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "close_closure_burndown_rollback_resolution requires partner role" },
          { status: 403 }
        )
      }
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        settledBy: actor.id,
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        rollbackResolutionClosedBy: actor.id,
        rollbackResolutionNote: parsed.resolutionNote.trim(),
        now,
        note: parsed.note ?? parsed.resolutionNote.trim(),
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      store.audit.push({
        action: "filing_closure_burndown_settlement_rollback_resolution_close",
        actorId: actor.id,
        target: settlementUpdated.id,
        classification: settlementUpdated.classification,
        reason: parsed.resolutionNote.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "close_closure_burndown_rollback_resolution",
        closureBurndownSettlement:
          (await repos.filingEscalationClosureBurndownSettlement.get(settlementUpdated.id)) ??
          settlementUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "escalate_closure_expiry_attestation_queue_handoff_timeout") {
      if (
        !parsed.actorId ||
        (!parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "escalate_closure_expiry_attestation_queue_handoff_timeout requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const priorAuditCount = store.audit.length
      const drainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        handoffTimeoutEscalatedBy: actor.id,
        now,
        note: parsed.note ?? "expiry attestation queue handoff timeout escalated",
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(drainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(drainUpdated.id, drainUpdated)
      store.audit.push({
        action: "filing_closure_expiry_attestation_queue_handoff_timeout_escalate",
        actorId: actor.id,
        target: drainUpdated.id,
        classification: drainUpdated.classification,
        reason: drainUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "escalate_closure_expiry_attestation_queue_handoff_timeout",
        closureExpiryAttestationQueueDrain:
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(drainUpdated.id)) ??
          drainUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_closure_expiry_attestation_queue_stale_reassignment") {
      if (
        !parsed.actorId ||
        !parsed.reassignedOwnerId?.trim() ||
        (!parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, reassignedOwnerId, and drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_closure_expiry_attestation_queue_stale_reassignment requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        handoffAttestedBy: actor.id,
        handoffToOwnerId: parsed.reassignedOwnerId.trim(),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const priorAuditCount = store.audit.length
      const drainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        staleReassignmentAttestedBy: actor.id,
        reassignedOwnerId: parsed.reassignedOwnerId.trim(),
        now,
        note: parsed.note ?? "expiry attestation queue stale reassignment attested",
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(drainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(drainUpdated.id, drainUpdated)
      store.audit.push({
        action: "filing_closure_expiry_attestation_queue_stale_reassignment_attest",
        actorId: actor.id,
        target: drainUpdated.id,
        classification: drainUpdated.classification,
        reason: parsed.reassignedOwnerId.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_closure_expiry_attestation_queue_stale_reassignment",
        closureExpiryAttestationQueueDrain:
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(drainUpdated.id)) ??
          drainUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "checkpoint_closure_expiry_attestation_queue_forced_drain_override") {
      if (
        !parsed.actorId ||
        (!parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "checkpoint_closure_expiry_attestation_queue_forced_drain_override requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        autoDrainCheckpointBy: actor.id,
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const priorAuditCount = store.audit.length
      const drainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        forcedDrainCheckpointedBy: actor.id,
        forcedDrainOverrideNote: parsed.overrideNote,
        now,
        note: parsed.note ?? parsed.overrideNote ?? "forced drain override checkpoint recorded",
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(drainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(drainUpdated.id, drainUpdated)
      store.audit.push({
        action: "filing_closure_expiry_attestation_queue_forced_drain_checkpoint",
        actorId: actor.id,
        target: drainUpdated.id,
        classification: drainUpdated.classification,
        reason: drainUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "checkpoint_closure_expiry_attestation_queue_forced_drain_override",
        closureExpiryAttestationQueueDrain:
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(drainUpdated.id)) ??
          drainUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "checkpoint_closure_settlement_post_resolution_verification") {
      if (
        !parsed.actorId ||
        (!parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "checkpoint_closure_settlement_post_resolution_verification requires partner role" },
          { status: 403 }
        )
      }
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        postResolutionCheckpointedBy: actor.id,
        now,
        note: parsed.note ?? "post-resolution settlement verification checkpoint recorded",
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      store.audit.push({
        action: "filing_closure_settlement_attestation_post_resolution_checkpoint",
        actorId: actor.id,
        target: settlementAttestationUpdated.id,
        classification: settlementAttestationUpdated.classification,
        reason: settlementAttestationUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "checkpoint_closure_settlement_post_resolution_verification",
        closureSettlementAttestation:
          (await repos.filingEscalationClosureSettlementAttestation.get(
            settlementAttestationUpdated.id
          )) ?? settlementAttestationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_closure_settlement_lock_release") {
      if (
        !parsed.actorId ||
        (!parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_closure_settlement_lock_release requires partner role" },
          { status: 403 }
        )
      }
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        lockReleaseAttestedBy: actor.id,
        now,
        note: parsed.note ?? "settlement lock release attested",
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      store.audit.push({
        action: "filing_closure_settlement_attestation_lock_release_attest",
        actorId: actor.id,
        target: settlementAttestationUpdated.id,
        classification: settlementAttestationUpdated.classification,
        reason: settlementAttestationUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_closure_settlement_lock_release",
        closureSettlementAttestation:
          (await repos.filingEscalationClosureSettlementAttestation.get(
            settlementAttestationUpdated.id
          )) ?? settlementAttestationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "safeguard_closure_settlement_dispute_reopen") {
      if (
        !parsed.actorId ||
        !parsed.guardNote?.trim() ||
        (!parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, guardNote, and settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "safeguard_closure_settlement_dispute_reopen requires partner role" },
          { status: 403 }
        )
      }
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        disputeReopenGuardedBy: actor.id,
        disputeReopenGuardNote: parsed.guardNote.trim(),
        now,
        note: parsed.note ?? parsed.guardNote.trim(),
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      store.audit.push({
        action: "filing_closure_settlement_attestation_dispute_reopen_safeguard",
        actorId: actor.id,
        target: settlementAttestationUpdated.id,
        classification: settlementAttestationUpdated.classification,
        reason: parsed.guardNote.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "safeguard_closure_settlement_dispute_reopen",
        closureSettlementAttestation:
          (await repos.filingEscalationClosureSettlementAttestation.get(
            settlementAttestationUpdated.id
          )) ?? settlementAttestationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_closure_queue_drain_forced_reconciliation") {
      if (
        !parsed.actorId ||
        (!parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_closure_queue_drain_forced_reconciliation requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const priorAuditCount = store.audit.length
      const reconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        forcedDrainAttestedBy: actor.id,
        now,
        note: parsed.note ?? "forced queue drain reconciliation attested",
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(reconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        reconciliationUpdated.id,
        reconciliationUpdated
      )
      store.audit.push({
        action: "filing_closure_queue_drain_reconciliation_forced_attest",
        actorId: actor.id,
        target: reconciliationUpdated.id,
        classification: reconciliationUpdated.classification,
        reason: reconciliationUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_closure_queue_drain_forced_reconciliation",
        closureQueueDrainReconciliation:
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(reconciliationUpdated.id)) ??
          reconciliationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "checkpoint_closure_queue_drain_reassignment_rollback") {
      if (
        !parsed.actorId ||
        !parsed.rollbackToOwnerId?.trim() ||
        (!parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, rollbackToOwnerId, and reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "checkpoint_closure_queue_drain_reassignment_rollback requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const priorAuditCount = store.audit.length
      const reconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        reassignmentRollbackCheckpointedBy: actor.id,
        rollbackToOwnerId: parsed.rollbackToOwnerId.trim(),
        now,
        note: parsed.note ?? "queue drain reassignment rollback checkpointed",
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(reconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        reconciliationUpdated.id,
        reconciliationUpdated
      )
      store.audit.push({
        action: "filing_closure_queue_drain_reconciliation_reassignment_rollback_checkpoint",
        actorId: actor.id,
        target: reconciliationUpdated.id,
        classification: reconciliationUpdated.classification,
        reason: parsed.rollbackToOwnerId.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "checkpoint_closure_queue_drain_reassignment_rollback",
        closureQueueDrainReconciliation:
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(reconciliationUpdated.id)) ??
          reconciliationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "control_closure_queue_drain_timeout_reentry") {
      if (
        !parsed.actorId ||
        parsed.timeoutWindowHours === undefined ||
        (!parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, timeoutWindowHours, and reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const timeoutWindowHours = Number(parsed.timeoutWindowHours)
      if (!Number.isFinite(timeoutWindowHours) || timeoutWindowHours < 1 || timeoutWindowHours > 168) {
        return NextResponse.json({ error: "timeoutWindowHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "control_closure_queue_drain_timeout_reentry requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const priorAuditCount = store.audit.length
      const reconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        timeoutReentryControlledBy: actor.id,
        timeoutReentryWindowHours: timeoutWindowHours,
        now,
        note: parsed.note ?? `queue drain timeout re-entry controlled for ${timeoutWindowHours} hours`,
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(reconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        reconciliationUpdated.id,
        reconciliationUpdated
      )
      store.audit.push({
        action: "filing_closure_queue_drain_reconciliation_timeout_reentry_control",
        actorId: actor.id,
        target: reconciliationUpdated.id,
        classification: reconciliationUpdated.classification,
        reason: String(timeoutWindowHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "control_closure_queue_drain_timeout_reentry",
        closureQueueDrainReconciliation:
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(reconciliationUpdated.id)) ??
          reconciliationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "petition_closure_settlement_verification_override") {
      if (
        !parsed.actorId ||
        !parsed.overrideReason?.trim() ||
        (!parsed.arbitrationId &&
          !parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, overrideReason, and arbitrationId/settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "petition_closure_settlement_verification_override requires partner role" },
          { status: 403 }
        )
      }
      const existingArbitration = parsed.arbitrationId
        ? await repos.filingEscalationClosureSettlementArbitration.get(parsed.arbitrationId)
        : null
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : existingArbitration
          ? await repos.filingEscalationClosureSettlementAttestation.get(
              existingArbitration.settlementAttestationId
            )
          : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      const arbitrationUpdated = buildFilingEscalationClosureSettlementArbitrationRow({
        settlementAttestation: settlementAttestationUpdated,
        existing:
          existingArbitration ??
          (await repos.filingEscalationClosureSettlementArbitration.get(
            filingEscalationClosureSettlementArbitrationId(settlementAttestationUpdated.id)
          )),
        verificationOverridePetitionedBy: actor.id,
        now,
        note: parsed.note ?? parsed.overrideReason.trim(),
      })
      await repos.filingEscalationClosureSettlementArbitration.upsert(arbitrationUpdated)
      store.filingEscalationClosureSettlementArbitration.set(arbitrationUpdated.id, arbitrationUpdated)
      store.audit.push({
        action: "filing_closure_settlement_arbitration_verification_override_petition",
        actorId: actor.id,
        target: arbitrationUpdated.id,
        classification: arbitrationUpdated.classification,
        reason: parsed.overrideReason.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "petition_closure_settlement_verification_override",
        closureSettlementArbitration:
          (await repos.filingEscalationClosureSettlementArbitration.get(arbitrationUpdated.id)) ??
          arbitrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_closure_settlement_arbitration_panel_confirmation") {
      if (
        !parsed.actorId ||
        (!parsed.arbitrationId &&
          !parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and arbitrationId/settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_closure_settlement_arbitration_panel_confirmation requires partner role" },
          { status: 403 }
        )
      }
      const existingArbitration = parsed.arbitrationId
        ? await repos.filingEscalationClosureSettlementArbitration.get(parsed.arbitrationId)
        : null
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : existingArbitration
          ? await repos.filingEscalationClosureSettlementAttestation.get(
              existingArbitration.settlementAttestationId
            )
          : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      const arbitrationUpdated = buildFilingEscalationClosureSettlementArbitrationRow({
        settlementAttestation: settlementAttestationUpdated,
        existing:
          existingArbitration ??
          (await repos.filingEscalationClosureSettlementArbitration.get(
            filingEscalationClosureSettlementArbitrationId(settlementAttestationUpdated.id)
          )),
        panelConfirmationAttestedBy: actor.id,
        now,
        note: parsed.note ?? "settlement arbitration panel confirmation attested",
      })
      await repos.filingEscalationClosureSettlementArbitration.upsert(arbitrationUpdated)
      store.filingEscalationClosureSettlementArbitration.set(arbitrationUpdated.id, arbitrationUpdated)
      store.audit.push({
        action: "filing_closure_settlement_arbitration_panel_confirmation_attest",
        actorId: actor.id,
        target: arbitrationUpdated.id,
        classification: arbitrationUpdated.classification,
        reason: arbitrationUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_closure_settlement_arbitration_panel_confirmation",
        closureSettlementArbitration:
          (await repos.filingEscalationClosureSettlementArbitration.get(arbitrationUpdated.id)) ??
          arbitrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "checkpoint_closure_settlement_reopen_veto") {
      if (
        !parsed.actorId ||
        !parsed.vetoNote?.trim() ||
        (!parsed.arbitrationId &&
          !parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, vetoNote, and arbitrationId/settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "checkpoint_closure_settlement_reopen_veto requires partner role" },
          { status: 403 }
        )
      }
      const existingArbitration = parsed.arbitrationId
        ? await repos.filingEscalationClosureSettlementArbitration.get(parsed.arbitrationId)
        : null
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : existingArbitration
          ? await repos.filingEscalationClosureSettlementAttestation.get(
              existingArbitration.settlementAttestationId
            )
          : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      const arbitrationUpdated = buildFilingEscalationClosureSettlementArbitrationRow({
        settlementAttestation: settlementAttestationUpdated,
        existing:
          existingArbitration ??
          (await repos.filingEscalationClosureSettlementArbitration.get(
            filingEscalationClosureSettlementArbitrationId(settlementAttestationUpdated.id)
          )),
        reopenVetoCheckpointedBy: actor.id,
        reopenVetoNote: parsed.vetoNote.trim(),
        now,
        note: parsed.note ?? parsed.vetoNote.trim(),
      })
      await repos.filingEscalationClosureSettlementArbitration.upsert(arbitrationUpdated)
      store.filingEscalationClosureSettlementArbitration.set(arbitrationUpdated.id, arbitrationUpdated)
      store.audit.push({
        action: "filing_closure_settlement_arbitration_reopen_veto_checkpoint",
        actorId: actor.id,
        target: arbitrationUpdated.id,
        classification: arbitrationUpdated.classification,
        reason: parsed.vetoNote.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "checkpoint_closure_settlement_reopen_veto",
        closureSettlementArbitration:
          (await repos.filingEscalationClosureSettlementArbitration.get(arbitrationUpdated.id)) ??
          arbitrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "issue_closure_settlement_arbitration_final_ruling") {
      if (
        !parsed.actorId ||
        !parsed.rulingSummary?.trim() ||
        (!parsed.arbitrationId &&
          !parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, rulingSummary, and arbitrationId/settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "issue_closure_settlement_arbitration_final_ruling requires partner role" },
          { status: 403 }
        )
      }
      const existingArbitration = parsed.arbitrationId
        ? await repos.filingEscalationClosureSettlementArbitration.get(parsed.arbitrationId)
        : null
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : existingArbitration
          ? await repos.filingEscalationClosureSettlementAttestation.get(
              existingArbitration.settlementAttestationId
            )
          : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      const arbitrationUpdated = buildFilingEscalationClosureSettlementArbitrationRow({
        settlementAttestation: settlementAttestationUpdated,
        existing:
          existingArbitration ??
          (await repos.filingEscalationClosureSettlementArbitration.get(
            filingEscalationClosureSettlementArbitrationId(settlementAttestationUpdated.id)
          )),
        finalRulingIssuedBy: actor.id,
        finalRulingSummary: parsed.rulingSummary.trim(),
        now,
        note: parsed.note ?? parsed.rulingSummary.trim(),
      })
      await repos.filingEscalationClosureSettlementArbitration.upsert(arbitrationUpdated)
      store.filingEscalationClosureSettlementArbitration.set(arbitrationUpdated.id, arbitrationUpdated)
      store.audit.push({
        action: "filing_closure_settlement_arbitration_final_ruling_issue",
        actorId: actor.id,
        target: arbitrationUpdated.id,
        classification: arbitrationUpdated.classification,
        reason: parsed.rulingSummary.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "issue_closure_settlement_arbitration_final_ruling",
        closureSettlementArbitration:
          (await repos.filingEscalationClosureSettlementArbitration.get(arbitrationUpdated.id)) ??
          arbitrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "memorialize_closure_settlement_arbitration_dissent") {
      if (
        !parsed.actorId ||
        !parsed.dissentNote?.trim() ||
        (!parsed.arbitrationId &&
          !parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, dissentNote, and arbitrationId/settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "memorialize_closure_settlement_arbitration_dissent requires partner role" },
          { status: 403 }
        )
      }
      const existingArbitration = parsed.arbitrationId
        ? await repos.filingEscalationClosureSettlementArbitration.get(parsed.arbitrationId)
        : null
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : existingArbitration
          ? await repos.filingEscalationClosureSettlementAttestation.get(
              existingArbitration.settlementAttestationId
            )
          : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      const arbitrationUpdated = buildFilingEscalationClosureSettlementArbitrationRow({
        settlementAttestation: settlementAttestationUpdated,
        existing:
          existingArbitration ??
          (await repos.filingEscalationClosureSettlementArbitration.get(
            filingEscalationClosureSettlementArbitrationId(settlementAttestationUpdated.id)
          )),
        dissentMemorializedBy: actor.id,
        dissentMemorializedNote: parsed.dissentNote.trim(),
        now,
        note: parsed.note ?? parsed.dissentNote.trim(),
      })
      await repos.filingEscalationClosureSettlementArbitration.upsert(arbitrationUpdated)
      store.filingEscalationClosureSettlementArbitration.set(arbitrationUpdated.id, arbitrationUpdated)
      store.audit.push({
        action: "filing_closure_settlement_arbitration_dissent_memorialize",
        actorId: actor.id,
        target: arbitrationUpdated.id,
        classification: arbitrationUpdated.classification,
        reason: parsed.dissentNote.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "memorialize_closure_settlement_arbitration_dissent",
        closureSettlementArbitration:
          (await repos.filingEscalationClosureSettlementArbitration.get(arbitrationUpdated.id)) ??
          arbitrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "checkpoint_closure_settlement_arbitration_ruling_publication") {
      if (
        !parsed.actorId ||
        !parsed.publicationChannel?.trim() ||
        (!parsed.arbitrationId &&
          !parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, publicationChannel, and arbitrationId/settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "checkpoint_closure_settlement_arbitration_ruling_publication requires partner role" },
          { status: 403 }
        )
      }
      const existingArbitration = parsed.arbitrationId
        ? await repos.filingEscalationClosureSettlementArbitration.get(parsed.arbitrationId)
        : null
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : existingArbitration
          ? await repos.filingEscalationClosureSettlementAttestation.get(
              existingArbitration.settlementAttestationId
            )
          : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      const arbitrationUpdated = buildFilingEscalationClosureSettlementArbitrationRow({
        settlementAttestation: settlementAttestationUpdated,
        existing:
          existingArbitration ??
          (await repos.filingEscalationClosureSettlementArbitration.get(
            filingEscalationClosureSettlementArbitrationId(settlementAttestationUpdated.id)
          )),
        rulingPublicationCheckpointedBy: actor.id,
        rulingPublicationChannel: parsed.publicationChannel.trim(),
        now,
        note: parsed.note ?? `ruling publication checkpointed via ${parsed.publicationChannel.trim()}`,
      })
      await repos.filingEscalationClosureSettlementArbitration.upsert(arbitrationUpdated)
      store.filingEscalationClosureSettlementArbitration.set(arbitrationUpdated.id, arbitrationUpdated)
      store.audit.push({
        action: "filing_closure_settlement_arbitration_ruling_publication_checkpoint",
        actorId: actor.id,
        target: arbitrationUpdated.id,
        classification: arbitrationUpdated.classification,
        reason: parsed.publicationChannel.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "checkpoint_closure_settlement_arbitration_ruling_publication",
        closureSettlementArbitration:
          (await repos.filingEscalationClosureSettlementArbitration.get(arbitrationUpdated.id)) ??
          arbitrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "log_closure_settlement_arbitration_publication_correction") {
      if (
        !parsed.actorId ||
        !parsed.correctionNote?.trim() ||
        (!parsed.arbitrationId &&
          !parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, correctionNote, and arbitrationId/settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "log_closure_settlement_arbitration_publication_correction requires partner role" },
          { status: 403 }
        )
      }
      const existingArbitration = parsed.arbitrationId
        ? await repos.filingEscalationClosureSettlementArbitration.get(parsed.arbitrationId)
        : null
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : existingArbitration
          ? await repos.filingEscalationClosureSettlementAttestation.get(
              existingArbitration.settlementAttestationId
            )
          : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      const arbitrationUpdated = buildFilingEscalationClosureSettlementArbitrationRow({
        settlementAttestation: settlementAttestationUpdated,
        existing:
          existingArbitration ??
          (await repos.filingEscalationClosureSettlementArbitration.get(
            filingEscalationClosureSettlementArbitrationId(settlementAttestationUpdated.id)
          )),
        publicationCorrectionLoggedBy: actor.id,
        publicationCorrectionNote: parsed.correctionNote.trim(),
        now,
        note: parsed.note ?? parsed.correctionNote.trim(),
      })
      await repos.filingEscalationClosureSettlementArbitration.upsert(arbitrationUpdated)
      store.filingEscalationClosureSettlementArbitration.set(arbitrationUpdated.id, arbitrationUpdated)
      store.audit.push({
        action: "filing_closure_settlement_arbitration_publication_correction_log",
        actorId: actor.id,
        target: arbitrationUpdated.id,
        classification: arbitrationUpdated.classification,
        reason: parsed.correctionNote.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "log_closure_settlement_arbitration_publication_correction",
        closureSettlementArbitration:
          (await repos.filingEscalationClosureSettlementArbitration.get(arbitrationUpdated.id)) ??
          arbitrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "checkpoint_closure_settlement_arbitration_publication_rollback") {
      if (
        !parsed.actorId ||
        !parsed.rollbackReason?.trim() ||
        (!parsed.arbitrationId &&
          !parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, rollbackReason, and arbitrationId/settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "checkpoint_closure_settlement_arbitration_publication_rollback requires partner role" },
          { status: 403 }
        )
      }
      const existingArbitration = parsed.arbitrationId
        ? await repos.filingEscalationClosureSettlementArbitration.get(parsed.arbitrationId)
        : null
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : existingArbitration
          ? await repos.filingEscalationClosureSettlementAttestation.get(
              existingArbitration.settlementAttestationId
            )
          : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      const arbitrationUpdated = buildFilingEscalationClosureSettlementArbitrationRow({
        settlementAttestation: settlementAttestationUpdated,
        existing:
          existingArbitration ??
          (await repos.filingEscalationClosureSettlementArbitration.get(
            filingEscalationClosureSettlementArbitrationId(settlementAttestationUpdated.id)
          )),
        publicationRollbackCheckpointedBy: actor.id,
        publicationRollbackReason: parsed.rollbackReason.trim(),
        now,
        note: parsed.note ?? parsed.rollbackReason.trim(),
      })
      await repos.filingEscalationClosureSettlementArbitration.upsert(arbitrationUpdated)
      store.filingEscalationClosureSettlementArbitration.set(arbitrationUpdated.id, arbitrationUpdated)
      store.audit.push({
        action: "filing_closure_settlement_arbitration_publication_rollback_checkpoint",
        actorId: actor.id,
        target: arbitrationUpdated.id,
        classification: arbitrationUpdated.classification,
        reason: parsed.rollbackReason.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "checkpoint_closure_settlement_arbitration_publication_rollback",
        closureSettlementArbitration:
          (await repos.filingEscalationClosureSettlementArbitration.get(arbitrationUpdated.id)) ??
          arbitrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "review_closure_settlement_arbitration_distribution_attestation") {
      if (
        !parsed.actorId ||
        !parsed.decision ||
        (!parsed.arbitrationId &&
          !parsed.settlementAttestationId &&
          !parsed.settlementId &&
          !parsed.recalibrationId &&
          !parsed.burndownId &&
          !parsed.remediationId &&
          !parsed.adjudicationId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, decision, and arbitrationId/settlementAttestationId/settlementId/recalibrationId/burndownId/remediationId/adjudicationId are required",
          },
          { status: 400 }
        )
      }
      if (parsed.decision !== "approved" && parsed.decision !== "revision_required") {
        return NextResponse.json({ error: "decision must be approved or revision_required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          {
            error:
              "review_closure_settlement_arbitration_distribution_attestation requires partner role",
          },
          { status: 403 }
        )
      }
      const existingArbitration = parsed.arbitrationId
        ? await repos.filingEscalationClosureSettlementArbitration.get(parsed.arbitrationId)
        : null
      const existingSettlementAttestation = parsed.settlementAttestationId
        ? await repos.filingEscalationClosureSettlementAttestation.get(parsed.settlementAttestationId)
        : existingArbitration
          ? await repos.filingEscalationClosureSettlementAttestation.get(
              existingArbitration.settlementAttestationId
            )
          : null
      const existingSettlement = parsed.settlementId
        ? await repos.filingEscalationClosureBurndownSettlement.get(parsed.settlementId)
        : existingSettlementAttestation
          ? await repos.filingEscalationClosureBurndownSettlement.get(
              existingSettlementAttestation.settlementId
            )
          : null
      const existingRecalibration = parsed.recalibrationId
        ? await repos.filingEscalationClosureBurndownRecalibration.get(parsed.recalibrationId)
        : existingSettlement
          ? await repos.filingEscalationClosureBurndownRecalibration.get(existingSettlement.recalibrationId)
          : null
      const resolvedBurndownId =
        parsed.burndownId ??
        existingRecalibration?.burndownId ??
        (parsed.remediationId
          ? filingEscalationClosureAdjudicationDebtBurndownId(parsed.remediationId)
          : parsed.adjudicationId
            ? filingEscalationClosureAdjudicationDebtBurndownId(
                filingEscalationClosureAdjudicationSloDebtRemediationId(
                  filingEscalationClosureAdjudicationSloId(parsed.adjudicationId)
                )
              )
            : null)
      const burndown = resolvedBurndownId
        ? await repos.filingEscalationClosureAdjudicationDebtBurndown.get(resolvedBurndownId)
        : null
      if (!burndown || burndown.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure adjudication debt burndown row not found" }, { status: 404 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const recalibrationUpdated = buildFilingEscalationClosureBurndownRecalibrationRow({
        burndown,
        existing:
          existingRecalibration ??
          (await repos.filingEscalationClosureBurndownRecalibration.get(
            filingEscalationClosureBurndownRecalibrationId(burndown.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownRecalibration.upsert(recalibrationUpdated)
      store.filingEscalationClosureBurndownRecalibration.set(recalibrationUpdated.id, recalibrationUpdated)
      const settlementUpdated = buildFilingEscalationClosureBurndownSettlementRow({
        recalibration: recalibrationUpdated,
        existing:
          existingSettlement ??
          (await repos.filingEscalationClosureBurndownSettlement.get(
            filingEscalationClosureBurndownSettlementId(recalibrationUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureBurndownSettlement.upsert(settlementUpdated)
      store.filingEscalationClosureBurndownSettlement.set(settlementUpdated.id, settlementUpdated)
      const settlementAttestationUpdated = buildFilingEscalationClosureSettlementAttestationRow({
        settlement: settlementUpdated,
        existing:
          existingSettlementAttestation ??
          (await repos.filingEscalationClosureSettlementAttestation.get(
            filingEscalationClosureSettlementAttestationId(settlementUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureSettlementAttestation.upsert(settlementAttestationUpdated)
      store.filingEscalationClosureSettlementAttestation.set(
        settlementAttestationUpdated.id,
        settlementAttestationUpdated
      )
      const arbitrationUpdated = buildFilingEscalationClosureSettlementArbitrationRow({
        settlementAttestation: settlementAttestationUpdated,
        existing:
          existingArbitration ??
          (await repos.filingEscalationClosureSettlementArbitration.get(
            filingEscalationClosureSettlementArbitrationId(settlementAttestationUpdated.id)
          )),
        distributionAttestationReviewedBy: actor.id,
        distributionAttestationDecision: parsed.decision,
        now,
        note: parsed.note ?? `distribution attestation reviewed: ${parsed.decision}`,
      })
      await repos.filingEscalationClosureSettlementArbitration.upsert(arbitrationUpdated)
      store.filingEscalationClosureSettlementArbitration.set(arbitrationUpdated.id, arbitrationUpdated)
      store.audit.push({
        action: "filing_closure_settlement_arbitration_distribution_attestation_review",
        actorId: actor.id,
        target: arbitrationUpdated.id,
        classification: arbitrationUpdated.classification,
        reason: parsed.decision,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "review_closure_settlement_arbitration_distribution_attestation",
        closureSettlementArbitration:
          (await repos.filingEscalationClosureSettlementArbitration.get(arbitrationUpdated.id)) ??
          arbitrationUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_closure_queue_reentry_exception") {
      if (
        !parsed.actorId ||
        (!parsed.complianceId &&
          !parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and complianceId/reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_closure_queue_reentry_exception requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingCompliance = parsed.complianceId
        ? await repos.filingEscalationClosureQueueReentryCompliance.get(parsed.complianceId)
        : null
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : existingCompliance
          ? await repos.filingEscalationClosureQueueDrainReconciliation.get(
              existingCompliance.queueReconciliationId
            )
          : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const queueDrainReconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(queueDrainReconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        queueDrainReconciliationUpdated.id,
        queueDrainReconciliationUpdated
      )
      const priorAuditCount = store.audit.length
      const complianceUpdated = buildFilingEscalationClosureQueueReentryComplianceRow({
        queueReconciliation: queueDrainReconciliationUpdated,
        existing:
          existingCompliance ??
          (await repos.filingEscalationClosureQueueReentryCompliance.get(
            filingEscalationClosureQueueReentryComplianceId(queueDrainReconciliationUpdated.id)
          )),
        reentryExceptionAttestedBy: actor.id,
        now,
        note: parsed.note ?? "queue re-entry exception attested",
      })
      await repos.filingEscalationClosureQueueReentryCompliance.upsert(complianceUpdated)
      store.filingEscalationClosureQueueReentryCompliance.set(complianceUpdated.id, complianceUpdated)
      store.audit.push({
        action: "filing_closure_queue_reentry_compliance_exception_attest",
        actorId: actor.id,
        target: complianceUpdated.id,
        classification: complianceUpdated.classification,
        reason: complianceUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_closure_queue_reentry_exception",
        closureQueueReentryCompliance:
          (await repos.filingEscalationClosureQueueReentryCompliance.get(complianceUpdated.id)) ??
          complianceUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "checkpoint_closure_queue_reentry_timeout_waiver") {
      if (
        !parsed.actorId ||
        parsed.waiverHours === undefined ||
        (!parsed.complianceId &&
          !parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, waiverHours, and complianceId/reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const waiverHours = Number(parsed.waiverHours)
      if (!Number.isFinite(waiverHours) || waiverHours < 1 || waiverHours > 168) {
        return NextResponse.json({ error: "waiverHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "checkpoint_closure_queue_reentry_timeout_waiver requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingCompliance = parsed.complianceId
        ? await repos.filingEscalationClosureQueueReentryCompliance.get(parsed.complianceId)
        : null
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : existingCompliance
          ? await repos.filingEscalationClosureQueueDrainReconciliation.get(
              existingCompliance.queueReconciliationId
            )
          : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const queueDrainReconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(queueDrainReconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        queueDrainReconciliationUpdated.id,
        queueDrainReconciliationUpdated
      )
      const priorAuditCount = store.audit.length
      const complianceUpdated = buildFilingEscalationClosureQueueReentryComplianceRow({
        queueReconciliation: queueDrainReconciliationUpdated,
        existing:
          existingCompliance ??
          (await repos.filingEscalationClosureQueueReentryCompliance.get(
            filingEscalationClosureQueueReentryComplianceId(queueDrainReconciliationUpdated.id)
          )),
        timeoutWaiverCheckpointedBy: actor.id,
        timeoutWaiverHours: waiverHours,
        now,
        note: parsed.note ?? `queue re-entry timeout waiver checkpointed for ${waiverHours} hours`,
      })
      await repos.filingEscalationClosureQueueReentryCompliance.upsert(complianceUpdated)
      store.filingEscalationClosureQueueReentryCompliance.set(complianceUpdated.id, complianceUpdated)
      store.audit.push({
        action: "filing_closure_queue_reentry_compliance_timeout_waiver_checkpoint",
        actorId: actor.id,
        target: complianceUpdated.id,
        classification: complianceUpdated.classification,
        reason: String(waiverHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "checkpoint_closure_queue_reentry_timeout_waiver",
        closureQueueReentryCompliance:
          (await repos.filingEscalationClosureQueueReentryCompliance.get(complianceUpdated.id)) ??
          complianceUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "control_closure_queue_reentry_reconciliation_resume") {
      if (
        !parsed.actorId ||
        (!parsed.complianceId &&
          !parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and complianceId/reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "control_closure_queue_reentry_reconciliation_resume requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingCompliance = parsed.complianceId
        ? await repos.filingEscalationClosureQueueReentryCompliance.get(parsed.complianceId)
        : null
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : existingCompliance
          ? await repos.filingEscalationClosureQueueDrainReconciliation.get(
              existingCompliance.queueReconciliationId
            )
          : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const queueDrainReconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(queueDrainReconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        queueDrainReconciliationUpdated.id,
        queueDrainReconciliationUpdated
      )
      const priorAuditCount = store.audit.length
      const complianceUpdated = buildFilingEscalationClosureQueueReentryComplianceRow({
        queueReconciliation: queueDrainReconciliationUpdated,
        existing:
          existingCompliance ??
          (await repos.filingEscalationClosureQueueReentryCompliance.get(
            filingEscalationClosureQueueReentryComplianceId(queueDrainReconciliationUpdated.id)
          )),
        reconciliationResumedBy: actor.id,
        now,
        note: parsed.note ?? "queue re-entry reconciliation resumed",
      })
      await repos.filingEscalationClosureQueueReentryCompliance.upsert(complianceUpdated)
      store.filingEscalationClosureQueueReentryCompliance.set(complianceUpdated.id, complianceUpdated)
      store.audit.push({
        action: "filing_closure_queue_reentry_compliance_reconciliation_resume_control",
        actorId: actor.id,
        target: complianceUpdated.id,
        classification: complianceUpdated.classification,
        reason: complianceUpdated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "control_closure_queue_reentry_reconciliation_resume",
        closureQueueReentryCompliance:
          (await repos.filingEscalationClosureQueueReentryCompliance.get(complianceUpdated.id)) ??
          complianceUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_closure_queue_reentry_exception_debt") {
      if (
        !parsed.actorId ||
        (!parsed.complianceId &&
          !parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and complianceId/reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "assign_closure_queue_reentry_exception_debt requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingCompliance = parsed.complianceId
        ? await repos.filingEscalationClosureQueueReentryCompliance.get(parsed.complianceId)
        : null
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : existingCompliance
          ? await repos.filingEscalationClosureQueueDrainReconciliation.get(
              existingCompliance.queueReconciliationId
            )
          : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const queueDrainReconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(queueDrainReconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        queueDrainReconciliationUpdated.id,
        queueDrainReconciliationUpdated
      )
      const priorAuditCount = store.audit.length
      const complianceUpdated = buildFilingEscalationClosureQueueReentryComplianceRow({
        queueReconciliation: queueDrainReconciliationUpdated,
        existing:
          existingCompliance ??
          (await repos.filingEscalationClosureQueueReentryCompliance.get(
            filingEscalationClosureQueueReentryComplianceId(queueDrainReconciliationUpdated.id)
          )),
        exceptionDebtAssignedBy: actor.id,
        debtAssigneeId: parsed.assigneeId?.trim() || actor.id,
        now,
        note: parsed.note ?? `queue re-entry exception debt assigned to ${parsed.assigneeId?.trim() || actor.id}`,
      })
      await repos.filingEscalationClosureQueueReentryCompliance.upsert(complianceUpdated)
      store.filingEscalationClosureQueueReentryCompliance.set(complianceUpdated.id, complianceUpdated)
      store.audit.push({
        action: "filing_closure_queue_reentry_debt_assignment",
        actorId: actor.id,
        target: complianceUpdated.id,
        classification: complianceUpdated.classification,
        reason: parsed.assigneeId?.trim() || actor.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "assign_closure_queue_reentry_exception_debt",
        closureQueueReentryCompliance:
          (await repos.filingEscalationClosureQueueReentryCompliance.get(complianceUpdated.id)) ??
          complianceUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_closure_queue_reentry_debt_retirement") {
      if (
        !parsed.actorId ||
        (!parsed.complianceId &&
          !parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and complianceId/reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const retiredCountRaw = parsed.retiredCount ?? 1
      if (!Number.isFinite(retiredCountRaw) || retiredCountRaw < 1 || retiredCountRaw > 500) {
        return NextResponse.json({ error: "retiredCount must be between 1 and 500" }, { status: 400 })
      }
      const retiredCount = Math.floor(retiredCountRaw)
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_closure_queue_reentry_debt_retirement requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingCompliance = parsed.complianceId
        ? await repos.filingEscalationClosureQueueReentryCompliance.get(parsed.complianceId)
        : null
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : existingCompliance
          ? await repos.filingEscalationClosureQueueDrainReconciliation.get(
              existingCompliance.queueReconciliationId
            )
          : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const queueDrainReconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(queueDrainReconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        queueDrainReconciliationUpdated.id,
        queueDrainReconciliationUpdated
      )
      const priorAuditCount = store.audit.length
      const cumulativeRetiredCount = (existingCompliance?.debtRetiredCount ?? 0) + retiredCount
      const complianceUpdated = buildFilingEscalationClosureQueueReentryComplianceRow({
        queueReconciliation: queueDrainReconciliationUpdated,
        existing:
          existingCompliance ??
          (await repos.filingEscalationClosureQueueReentryCompliance.get(
            filingEscalationClosureQueueReentryComplianceId(queueDrainReconciliationUpdated.id)
          )),
        debtRetirementAttestedBy: actor.id,
        debtRetiredCount: cumulativeRetiredCount,
        now,
        note: parsed.note ?? `queue re-entry debt retirement attested for ${retiredCount} items`,
      })
      await repos.filingEscalationClosureQueueReentryCompliance.upsert(complianceUpdated)
      store.filingEscalationClosureQueueReentryCompliance.set(complianceUpdated.id, complianceUpdated)
      store.audit.push({
        action: "filing_closure_queue_reentry_debt_retirement_attest",
        actorId: actor.id,
        target: complianceUpdated.id,
        classification: complianceUpdated.classification,
        reason: String(retiredCount),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_closure_queue_reentry_debt_retirement",
        closureQueueReentryCompliance:
          (await repos.filingEscalationClosureQueueReentryCompliance.get(complianceUpdated.id)) ??
          complianceUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "control_closure_queue_reentry_debt_aging_auto_escalation") {
      if (
        !parsed.actorId ||
        parsed.agingHours === undefined ||
        (!parsed.complianceId &&
          !parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, agingHours, and complianceId/reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const agingHours = Number(parsed.agingHours)
      if (!Number.isFinite(agingHours) || agingHours < 1 || agingHours > 168) {
        return NextResponse.json({ error: "agingHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "control_closure_queue_reentry_debt_aging_auto_escalation requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingCompliance = parsed.complianceId
        ? await repos.filingEscalationClosureQueueReentryCompliance.get(parsed.complianceId)
        : null
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : existingCompliance
          ? await repos.filingEscalationClosureQueueDrainReconciliation.get(
              existingCompliance.queueReconciliationId
            )
          : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const queueDrainReconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(queueDrainReconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        queueDrainReconciliationUpdated.id,
        queueDrainReconciliationUpdated
      )
      const priorAuditCount = store.audit.length
      const complianceUpdated = buildFilingEscalationClosureQueueReentryComplianceRow({
        queueReconciliation: queueDrainReconciliationUpdated,
        existing:
          existingCompliance ??
          (await repos.filingEscalationClosureQueueReentryCompliance.get(
            filingEscalationClosureQueueReentryComplianceId(queueDrainReconciliationUpdated.id)
          )),
        debtAgingAutoEscalatedBy: actor.id,
        debtAgingEscalationHours: agingHours,
        now,
        note: parsed.note ?? `queue re-entry debt aging auto-escalation set to ${agingHours} hours`,
      })
      await repos.filingEscalationClosureQueueReentryCompliance.upsert(complianceUpdated)
      store.filingEscalationClosureQueueReentryCompliance.set(complianceUpdated.id, complianceUpdated)
      store.audit.push({
        action: "filing_closure_queue_reentry_debt_aging_auto_escalation_control",
        actorId: actor.id,
        target: complianceUpdated.id,
        classification: complianceUpdated.classification,
        reason: String(agingHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "control_closure_queue_reentry_debt_aging_auto_escalation",
        closureQueueReentryCompliance:
          (await repos.filingEscalationClosureQueueReentryCompliance.get(complianceUpdated.id)) ??
          complianceUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "open_closure_queue_reentry_debt_retirement_dispute") {
      if (
        !parsed.actorId ||
        !parsed.disputeReason?.trim() ||
        (!parsed.complianceId &&
          !parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, disputeReason, and complianceId/reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "open_closure_queue_reentry_debt_retirement_dispute requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingCompliance = parsed.complianceId
        ? await repos.filingEscalationClosureQueueReentryCompliance.get(parsed.complianceId)
        : null
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : existingCompliance
          ? await repos.filingEscalationClosureQueueDrainReconciliation.get(
              existingCompliance.queueReconciliationId
            )
          : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const queueDrainReconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(queueDrainReconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        queueDrainReconciliationUpdated.id,
        queueDrainReconciliationUpdated
      )
      const priorAuditCount = store.audit.length
      const complianceUpdated = buildFilingEscalationClosureQueueReentryComplianceRow({
        queueReconciliation: queueDrainReconciliationUpdated,
        existing:
          existingCompliance ??
          (await repos.filingEscalationClosureQueueReentryCompliance.get(
            filingEscalationClosureQueueReentryComplianceId(queueDrainReconciliationUpdated.id)
          )),
        retirementDisputeOpenedBy: actor.id,
        retirementDisputeReason: parsed.disputeReason.trim(),
        now,
        note: parsed.note ?? parsed.disputeReason.trim(),
      })
      await repos.filingEscalationClosureQueueReentryCompliance.upsert(complianceUpdated)
      store.filingEscalationClosureQueueReentryCompliance.set(complianceUpdated.id, complianceUpdated)
      store.audit.push({
        action: "filing_closure_queue_reentry_debt_retirement_dispute_open",
        actorId: actor.id,
        target: complianceUpdated.id,
        classification: complianceUpdated.classification,
        reason: parsed.disputeReason.trim(),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "open_closure_queue_reentry_debt_retirement_dispute",
        closureQueueReentryCompliance:
          (await repos.filingEscalationClosureQueueReentryCompliance.get(complianceUpdated.id)) ??
          complianceUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_closure_queue_reentry_debt_retirement_dispute") {
      if (
        !parsed.actorId ||
        !parsed.resolution ||
        (!parsed.complianceId &&
          !parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, resolution, and complianceId/reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      if (parsed.resolution !== "uphold_retirement" && parsed.resolution !== "reopen_debt") {
        return NextResponse.json({ error: "resolution must be uphold_retirement or reopen_debt" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "resolve_closure_queue_reentry_debt_retirement_dispute requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingCompliance = parsed.complianceId
        ? await repos.filingEscalationClosureQueueReentryCompliance.get(parsed.complianceId)
        : null
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : existingCompliance
          ? await repos.filingEscalationClosureQueueDrainReconciliation.get(
              existingCompliance.queueReconciliationId
            )
          : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const queueDrainReconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(queueDrainReconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        queueDrainReconciliationUpdated.id,
        queueDrainReconciliationUpdated
      )
      const priorAuditCount = store.audit.length
      const complianceUpdated = buildFilingEscalationClosureQueueReentryComplianceRow({
        queueReconciliation: queueDrainReconciliationUpdated,
        existing:
          existingCompliance ??
          (await repos.filingEscalationClosureQueueReentryCompliance.get(
            filingEscalationClosureQueueReentryComplianceId(queueDrainReconciliationUpdated.id)
          )),
        retirementDisputeResolvedBy: actor.id,
        retirementDisputeResolution: parsed.resolution,
        now,
        note: parsed.note ?? `retirement dispute resolved: ${parsed.resolution}`,
      })
      await repos.filingEscalationClosureQueueReentryCompliance.upsert(complianceUpdated)
      store.filingEscalationClosureQueueReentryCompliance.set(complianceUpdated.id, complianceUpdated)
      store.audit.push({
        action: "filing_closure_queue_reentry_debt_retirement_dispute_resolve",
        actorId: actor.id,
        target: complianceUpdated.id,
        classification: complianceUpdated.classification,
        reason: parsed.resolution,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "resolve_closure_queue_reentry_debt_retirement_dispute",
        closureQueueReentryCompliance:
          (await repos.filingEscalationClosureQueueReentryCompliance.get(complianceUpdated.id)) ??
          complianceUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "control_closure_queue_reentry_debt_retirement_rollback") {
      if (
        !parsed.actorId ||
        (!parsed.complianceId &&
          !parsed.reconciliationId &&
          !parsed.drainId &&
          !parsed.queueItemId &&
          !parsed.attestationId &&
          !parsed.expiryId &&
          !parsed.rebalanceId &&
          !parsed.queueId &&
          !parsed.ownerId)
      ) {
        return NextResponse.json(
          {
            error:
              "actorId and complianceId/reconciliationId/drainId/queueItemId/attestationId/expiryId/rebalanceId/queueId/ownerId are required",
          },
          { status: 400 }
        )
      }
      const rollbackCountRaw = parsed.rollbackCount ?? 1
      if (!Number.isFinite(rollbackCountRaw) || rollbackCountRaw < 1 || rollbackCountRaw > 500) {
        return NextResponse.json({ error: "rollbackCount must be between 1 and 500" }, { status: 400 })
      }
      const rollbackCount = Math.floor(rollbackCountRaw)
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "control_closure_queue_reentry_debt_retirement_rollback requires partner role" },
          { status: 403 }
        )
      }
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const existingCompliance = parsed.complianceId
        ? await repos.filingEscalationClosureQueueReentryCompliance.get(parsed.complianceId)
        : null
      const existingReconciliation = parsed.reconciliationId
        ? await repos.filingEscalationClosureQueueDrainReconciliation.get(parsed.reconciliationId)
        : existingCompliance
          ? await repos.filingEscalationClosureQueueDrainReconciliation.get(
              existingCompliance.queueReconciliationId
            )
          : null
      const existingDrain = parsed.drainId
        ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(parsed.drainId)
        : existingReconciliation
          ? await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
              existingReconciliation.queueDrainId
            )
          : null
      const existingQueueItem = parsed.queueItemId
        ? await repos.filingEscalationClosureExpiryAttestationQueue.get(parsed.queueItemId)
        : existingDrain
          ? await repos.filingEscalationClosureExpiryAttestationQueue.get(existingDrain.queueItemId)
          : null
      const existingAttestation =
        (parsed.attestationId
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(parsed.attestationId)
          : null) ??
        (existingQueueItem
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(existingQueueItem.attestationId)
          : null)
      const existingExpiry = parsed.expiryId
        ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(parsed.expiryId)
        : existingAttestation
          ? await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(existingAttestation.expiryId)
          : null
      const queueFromSelector =
        parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null
      const rebalance =
        (parsed.rebalanceId
          ? await repos.filingEscalationClosureEnforcementRebalance.get(parsed.rebalanceId)
          : queueFromSelector
            ? await repos.filingEscalationClosureEnforcementRebalance.get(
                filingEscalationClosureEnforcementRebalanceId(queueFromSelector.id)
              )
            : null) ?? null
      const resolvedAttestation =
        existingAttestation ??
        (existingExpiry
          ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
              filingEscalationClosureSafeguardExpiryAttestationId(existingExpiry.id)
            )
          : rebalance
            ? await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
                filingEscalationClosureSafeguardExpiryAttestationId(
                  filingEscalationClosureRebalanceSafeguardExpiryId(
                    filingEscalationClosureRebalanceSafeguardId(rebalance.id)
                  )
                )
              )
            : null)
      if (!resolvedAttestation || resolvedAttestation.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure safeguard expiry attestation row not found" }, { status: 404 })
      }
      const queueUpdated = buildFilingEscalationClosureExpiryAttestationQueueRow({
        attestation: resolvedAttestation,
        existing:
          existingQueueItem ??
          (await repos.filingEscalationClosureExpiryAttestationQueue.get(
            filingEscalationClosureExpiryAttestationQueueId(resolvedAttestation.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert(queueUpdated)
      store.filingEscalationClosureExpiryAttestationQueue.set(queueUpdated.id, queueUpdated)
      const queueDrainUpdated = buildFilingEscalationClosureExpiryAttestationQueueDrainRow({
        queueItem: queueUpdated,
        existing:
          existingDrain ??
          (await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
            filingEscalationClosureExpiryAttestationQueueDrainId(queueUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert(queueDrainUpdated)
      store.filingEscalationClosureExpiryAttestationQueueDrain.set(queueDrainUpdated.id, queueDrainUpdated)
      const queueDrainReconciliationUpdated = buildFilingEscalationClosureQueueDrainReconciliationRow({
        queueDrain: queueDrainUpdated,
        existing:
          existingReconciliation ??
          (await repos.filingEscalationClosureQueueDrainReconciliation.get(
            filingEscalationClosureQueueDrainReconciliationId(queueDrainUpdated.id)
          )),
        now,
      })
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert(queueDrainReconciliationUpdated)
      store.filingEscalationClosureQueueDrainReconciliation.set(
        queueDrainReconciliationUpdated.id,
        queueDrainReconciliationUpdated
      )
      const priorAuditCount = store.audit.length
      const cumulativeRollbackCount = (existingCompliance?.retirementRollbackCount ?? 0) + rollbackCount
      const complianceUpdated = buildFilingEscalationClosureQueueReentryComplianceRow({
        queueReconciliation: queueDrainReconciliationUpdated,
        existing:
          existingCompliance ??
          (await repos.filingEscalationClosureQueueReentryCompliance.get(
            filingEscalationClosureQueueReentryComplianceId(queueDrainReconciliationUpdated.id)
          )),
        retirementRollbackControlledBy: actor.id,
        retirementRollbackCount: cumulativeRollbackCount,
        now,
        note: parsed.note ?? `retirement rollback controls checkpointed for ${rollbackCount} items`,
      })
      await repos.filingEscalationClosureQueueReentryCompliance.upsert(complianceUpdated)
      store.filingEscalationClosureQueueReentryCompliance.set(complianceUpdated.id, complianceUpdated)
      store.audit.push({
        action: "filing_closure_queue_reentry_debt_retirement_rollback_control",
        actorId: actor.id,
        target: complianceUpdated.id,
        classification: complianceUpdated.classification,
        reason: String(rollbackCount),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "control_closure_queue_reentry_debt_retirement_rollback",
        closureQueueReentryCompliance:
          (await repos.filingEscalationClosureQueueReentryCompliance.get(complianceUpdated.id)) ??
          complianceUpdated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "tick_closure_sla_exception_enforcement") {
      if (!parsed.actorId || (!parsed.queueId && !parsed.ownerId)) {
        return NextResponse.json(
          { error: "actorId and queueId or ownerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "tick_closure_sla_exception_enforcement requires partner role" },
          { status: 403 }
        )
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const packageRows = await repos.filings.listByFirm(actor.firmId)
      const packageById = new Map(packageRows.map((row) => [row.id, row]))
      const closureState = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const queue =
        (parsed.queueId
          ? await repos.filingEscalationClosureFollowupQueues.get(parsed.queueId)
          : parsed.ownerId
            ? closureState.queueByOwner.get(parsed.ownerId) ?? null
            : null) ?? null
      if (!queue || queue.firmId !== actor.firmId) {
        return NextResponse.json({ error: "closure follow-up queue row not found" }, { status: 404 })
      }
      const exceptionRef = closureState.exceptionDigestByOwner.get(queue.ownerId)
      if (!exceptionRef) {
        return NextResponse.json({ error: "closure SLA exception digest not found" }, { status: 404 })
      }
      const existingDigest = await repos.filingEscalationClosureSlaExceptionDigests.get(exceptionRef.id)
      if (!existingDigest) {
        return NextResponse.json({ error: "closure SLA exception digest not found" }, { status: 404 })
      }
      let digestUpdated = existingDigest
      if (existingDigest.status === "expired") {
        digestUpdated = {
          ...existingDigest,
          status: "open_exception" as const,
          waiverReason: null,
          waivedBy: null,
          waivedAt: null,
          waiverExpiresAt: null,
          notes: [
            ...existingDigest.notes,
            `${new Date(now).toISOString()} ${actor.id}: enforcement reopened expired exception`,
          ],
          updatedAt: now,
          lastEvaluatedAt: now,
        }
        await repos.filingEscalationClosureSlaExceptionDigests.upsert(digestUpdated)
        store.filingEscalationClosureSlaExceptionDigests.set(digestUpdated.id, digestUpdated)
      }
      store.audit.push({
        action: "filing_closure_sla_exception_enforcement_tick",
        actorId: actor.id,
        target: filingEscalationClosureSlaExceptionEnforcementId(queue.id),
        classification: queue.classification,
        reason: parsed.note?.trim() || "enforcement tick",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const refreshed = await recomputeClosureComplianceState(store, repos, {
        firmId: actor.firmId,
        packageById,
        now,
      })
      const refreshedExceptionRef = refreshed.exceptionDigestByOwner.get(queue.ownerId)
      const refreshedEnforcementRef = refreshed.exceptionEnforcementByOwner.get(queue.ownerId)
      const payload = {
        action: "tick_closure_sla_exception_enforcement",
        closureSlaExceptionDigest: refreshedExceptionRef
          ? (await repos.filingEscalationClosureSlaExceptionDigests.get(refreshedExceptionRef.id)) ??
            digestUpdated
          : digestUpdated,
        closureSlaExceptionEnforcement: refreshedEnforcementRef
          ? (await repos.filingEscalationClosureSlaExceptionEnforcement.get(refreshedEnforcementRef.id)) ??
            null
          : null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_policy_variance") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_policy_variance requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm policy variance denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy } = buildEscalationPolicyMaps(policyRows)
      const defaultPolicyRow = defaultPolicy
        ? policyRows.find((row) => row.id === defaultPolicy.id) ?? null
        : null
      const packagePolicyRow = latestByUpdatedAt(
        policyRows.filter(
          (row) => row.scope === "package_override" && row.packageId === filingPackage.id
        )
      )
      const existing = await repos.filingEscalationPolicyVarianceDigests.get(
        filingEscalationPolicyVarianceDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationPolicyVarianceDigestRow(filingPackage, {
        firmDefaultPolicy: defaultPolicyRow,
        packagePolicy: packagePolicyRow,
        existing,
        now,
      })
      if (digest.varianceReasons.length === 0) {
        return NextResponse.json({ error: "no active policy variance to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "policy variance acknowledged"
      const updated = {
        ...digest,
        status: "acknowledged" as const,
        snoozeUntil: null,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationPolicyVarianceDigests.upsert(updated)
      store.filingEscalationPolicyVarianceDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_policy_variance_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.varianceReasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_policy_variance",
        policyVarianceDigest:
          (await repos.filingEscalationPolicyVarianceDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "snooze_policy_variance") {
      if (!parsed.actorId || !parsed.packageId || parsed.snoozeHours === undefined) {
        return NextResponse.json(
          { error: "actorId, packageId, and snoozeHours are required" },
          { status: 400 }
        )
      }
      const snoozeHours = Number(parsed.snoozeHours)
      if (!Number.isFinite(snoozeHours) || snoozeHours < 1 || snoozeHours > 168) {
        return NextResponse.json({ error: "snoozeHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "snooze_policy_variance requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm policy variance snooze denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy } = buildEscalationPolicyMaps(policyRows)
      const defaultPolicyRow = defaultPolicy
        ? policyRows.find((row) => row.id === defaultPolicy.id) ?? null
        : null
      const packagePolicyRow = latestByUpdatedAt(
        policyRows.filter(
          (row) => row.scope === "package_override" && row.packageId === filingPackage.id
        )
      )
      const existing = await repos.filingEscalationPolicyVarianceDigests.get(
        filingEscalationPolicyVarianceDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationPolicyVarianceDigestRow(filingPackage, {
        firmDefaultPolicy: defaultPolicyRow,
        packagePolicy: packagePolicyRow,
        existing,
        now,
      })
      if (digest.varianceReasons.length === 0) {
        return NextResponse.json({ error: "no active policy variance to snooze" }, { status: 422 })
      }
      const note = parsed.note?.trim() || `policy variance snoozed for ${snoozeHours}h`
      const updated = {
        ...digest,
        status: "snoozed" as const,
        snoozeUntil: now + snoozeHours * 60 * 60 * 1000,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationPolicyVarianceDigests.upsert(updated)
      store.filingEscalationPolicyVarianceDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_policy_variance_snooze",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: String(snoozeHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "snooze_policy_variance",
        policyVarianceDigest:
          (await repos.filingEscalationPolicyVarianceDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_waiver_expiry") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_waiver_expiry requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm waiver expiry denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const activeWaiver =
        [...waivers]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const existing = await repos.filingEscalationWaiverExpiryDigests.get(
        filingEscalationWaiverExpiryDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
        activeWaiver,
        linkedPolicyId: policy.sourcePolicyId,
        existing,
        now,
      })
      if (digest.reasons.length === 0) {
        return NextResponse.json({ error: "no waiver expiry alert to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "waiver expiry acknowledged"
      const updated = {
        ...digest,
        status: "acknowledged" as const,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationWaiverExpiryDigests.upsert(updated)
      store.filingEscalationWaiverExpiryDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_waiver_expiry_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.reasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_waiver_expiry",
        waiverExpiryDigest:
          (await repos.filingEscalationWaiverExpiryDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "extend_breach_waiver") {
      if (!parsed.actorId || !parsed.packageId || parsed.extendHours === undefined) {
        return NextResponse.json(
          { error: "actorId, packageId, and extendHours are required" },
          { status: 400 }
        )
      }
      const extendHours = Number(parsed.extendHours)
      if (!Number.isFinite(extendHours) || extendHours < 1 || extendHours > 168) {
        return NextResponse.json({ error: "extendHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "extend_breach_waiver requires partner role" }, { status: 403 })
      }
      // Four-eyes: the second approver may not be the actor. TODO(E-24 chain
      // freeze): the second approval is still asserted by id in this request
      // rather than confirmed by the approver's own authenticated session; that
      // flow is out of scope while this chain is slated for freeze.
      if (parsed.secondApproverId && parsed.secondApproverId === actor.id) {
        return NextResponse.json(
          { error: "second approver must be a different partner", code: "self_approval_forbidden" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm waiver extension denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const target =
        (parsed.waiverId
          ? waivers.find((row) => row.id === parsed.waiverId)
          : [...waivers]
              .filter((row) => row.status === "active" && row.expiresAt > now)
              .sort((a, b) => b.updatedAt - a.updatedAt)[0]) ?? null
      if (!target || target.status !== "active" || target.expiresAt <= now) {
        return NextResponse.json({ error: "no matching active waiver found for extension" }, { status: 404 })
      }
      const note = parsed.note?.trim() || `waiver extended by ${extendHours}h`
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const previousExpiresAt = target.expiresAt
      const nextExpiresAt = target.expiresAt + extendHours * 60 * 60 * 1000
      const policyCapExpiresAt = target.grantedAt + policy.waiverWindowMs
      const rolloverCrossesCap = nextExpiresAt > policyCapExpiresAt
      let secondApprover: (typeof actor) | null = null
      if (rolloverCrossesCap) {
        if (!parsed.secondApproverId || !parsed.rolloverJustification?.trim()) {
          return NextResponse.json(
            {
              error:
                "secondApproverId and rolloverJustification are required when extension exceeds policy cap window",
            },
            { status: 422 }
          )
        }
        secondApprover = store.users.get(parsed.secondApproverId) ?? null
        if (!secondApprover) {
          return NextResponse.json({ error: "unknown second approver" }, { status: 404 })
        }
        if (
          secondApprover.firmId !== actor.firmId ||
          secondApprover.role !== "partner"
        ) {
          return NextResponse.json(
            { error: "second approver must be a partner in the same firm" },
            { status: 403 }
          )
        }
      }
      const extendedWaiver = {
        ...target,
        expiresAt: nextExpiresAt,
        notes: [...target.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationBreachWaivers.upsert(extendedWaiver)
      store.filingEscalationBreachWaivers.set(extendedWaiver.id, extendedWaiver)
      let rolloverAttestation: Awaited<
        ReturnType<typeof repos.filingEscalationWaiverRolloverAttestations.get>
      > | null = null
      if (rolloverCrossesCap && secondApprover) {
        const existingAttestations = await repos.filingEscalationWaiverRolloverAttestations.listByPackageId(
          filingPackage.id
        )
        const attestation = buildFilingEscalationWaiverRolloverAttestationRow(filingPackage, {
          sequenceNo: existingAttestations.length + 1,
          waiverId: extendedWaiver.id,
          extensionHours: extendHours,
          previousExpiresAt,
          newExpiresAt: nextExpiresAt,
          policyCapExpiresAt,
          actorId: actor.id,
          secondApproverId: secondApprover.id,
          justification: parsed.rolloverJustification ?? "",
          now,
          note: parsed.rolloverNote ?? null,
        })
        await repos.filingEscalationWaiverRolloverAttestations.upsert(attestation)
        store.filingEscalationWaiverRolloverAttestations.set(attestation.id, attestation)
        rolloverAttestation = attestation
      }
      const existingExpiry = await repos.filingEscalationWaiverExpiryDigests.get(
        filingEscalationWaiverExpiryDigestId(filingPackage.id)
      )
      const computedExpiry = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
        activeWaiver: extendedWaiver,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingExpiry,
        now,
      })
      const expiryDigest = {
        ...computedExpiry,
        status: "extended" as const,
        extendedBy: actor.id,
        extendedAt: now,
        notes: [...computedExpiry.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationWaiverExpiryDigests.upsert(expiryDigest)
      store.filingEscalationWaiverExpiryDigests.set(expiryDigest.id, expiryDigest)
      const existingRolloverWatch = await repos.filingEscalationRolloverBreachWatches.get(
        filingEscalationRolloverBreachWatchId(filingPackage.id)
      )
      const rolloverWatch = buildFilingEscalationRolloverBreachWatchRow(filingPackage, {
        activeWaiver: extendedWaiver,
        policyCapExpiresAt,
        latestAttestation: rolloverAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingRolloverWatch,
        now,
      })
      await repos.filingEscalationRolloverBreachWatches.upsert(rolloverWatch)
      store.filingEscalationRolloverBreachWatches.set(rolloverWatch.id, rolloverWatch)
      const warningThresholdMs = Math.max(HOUR_MS, Math.floor(policy.waiverWindowMs / 2))
      const breachThresholdMs = Math.max(2 * HOUR_MS, policy.waiverWindowMs)
      const existingReaffirmationSla = await repos.filingEscalationRolloverReaffirmationSlas.get(
        filingEscalationRolloverReaffirmationSlaId(filingPackage.id)
      )
      const reaffirmationSla = buildFilingEscalationRolloverReaffirmationSlaRow(filingPackage, {
        activeWaiver: extendedWaiver,
        policyCapExpiresAt,
        latestAttestation: rolloverAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        warningThresholdMs,
        breachThresholdMs,
        existing: existingReaffirmationSla,
        now,
      })
      await repos.filingEscalationRolloverReaffirmationSlas.upsert(reaffirmationSla)
      store.filingEscalationRolloverReaffirmationSlas.set(reaffirmationSla.id, reaffirmationSla)
      const rota = await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))
      const slaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const existingWorkload = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(
        await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      )
      const ownerLoadCount =
        rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
      const baseWorkload = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota,
        slaDigest,
        ownerLoadCount,
        ownerLoadThreshold: policy.ownerLoadThreshold,
        handoffSlaMs: policy.handoffSlaMs,
        existing: existingWorkload,
        now,
      })
      const workloadDigest =
        baseWorkload.alertReasons.length > 0
          ? {
              ...baseWorkload,
              status: "snoozed" as const,
              snoozeUntil: extendedWaiver.expiresAt,
              updatedAt: now,
              lastEvaluatedAt: now,
            }
          : baseWorkload
      const normalizedWorkloadDigest =
        ((rolloverWatch.status !== "cleared" && rolloverWatch.reasons.length > 0) ||
          reaffirmationSla.status === "breached" ||
          reaffirmationSla.reasons.includes("cap_crossed_reaffirmation_breached")) &&
        workloadDigest.status === "snoozed"
          ? {
              ...workloadDigest,
              status: "open_alert" as const,
              snoozeUntil: null,
              updatedAt: now,
              lastEvaluatedAt: now,
            }
          : workloadDigest
      await repos.filingEscalationWorkloadDigests.upsert(normalizedWorkloadDigest)
      store.filingEscalationWorkloadDigests.set(normalizedWorkloadDigest.id, normalizedWorkloadDigest)
      store.audit.push({
        action: "filing_escalation_waiver_extend",
        actorId: actor.id,
        target: extendedWaiver.id,
        classification: filingPackage.classification,
        reason: String(extendHours),
      })
      if (rolloverAttestation) {
        store.audit.push({
          action: "filing_waiver_rollover_attest",
          actorId: actor.id,
          target: rolloverAttestation.id,
          classification: filingPackage.classification,
          reason: rolloverAttestation.secondApproverId,
        })
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "extend_breach_waiver",
        waiver: (await repos.filingEscalationBreachWaivers.get(extendedWaiver.id)) ?? extendedWaiver,
        waiverExpiryDigest:
          (await repos.filingEscalationWaiverExpiryDigests.get(expiryDigest.id)) ?? expiryDigest,
        rolloverAttestation:
          rolloverAttestation
            ? (await repos.filingEscalationWaiverRolloverAttestations.get(rolloverAttestation.id)) ??
              rolloverAttestation
            : null,
        rolloverBreachWatch:
          (await repos.filingEscalationRolloverBreachWatches.get(rolloverWatch.id)) ?? rolloverWatch,
        rolloverReaffirmationSla:
          (await repos.filingEscalationRolloverReaffirmationSlas.get(reaffirmationSla.id)) ??
          reaffirmationSla,
        workloadDigest:
          (await repos.filingEscalationWorkloadDigests.get(normalizedWorkloadDigest.id)) ??
          normalizedWorkloadDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    if (err instanceof DraftCharsetError) {
      return NextResponse.json(
        { error: err.message, code: err.code, violations: err.violations },
        { status: 422 }
      )
    }
    if (err instanceof DraftChangedError || err instanceof PackageAlreadyDecidedError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 })
    }
    const message = publicErrorMessage(err, "filing package write failed")
    const status = /preflight blocked/.test(message) ? 422 : 400
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status })
  }
}
