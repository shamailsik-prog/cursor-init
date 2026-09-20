import { createHash, randomUUID } from "node:crypto"
import type { Classification } from "@/platform/p1/types"
import { classificationRank } from "@/platform/p1/types"

export type Role =
  | "partner"
  | "associate"
  | "clerk"
  | "intern"
  | "accounts"
  | "client"

export type User = {
  id: string
  firmId: string
  role: Role
  clearanceLevel: Classification
}

export type MatterMember = {
  matterId: string
  userId: string
  firmId: string
}

export type Matter = {
  id: string
  firmId: string
  clientId: string
  title: string
  courtId: string
  caseNumber: string | null
  caseNumberStatus: "pending" | "recorded"
  status: "engagement_unconfirmed" | "live"
  classification: Classification
}

export type DocumentRecord = {
  id: string
  firmId: string
  matterId: string | null
  contentHash: string
  sourceChannel: "web" | "team_portal" | "whatsapp" | "bulk"
  classification: Classification
}

export type Job = {
  id: string
  firmId: string
  jobType: string
  documentId: string
  classification: Classification
  idempotencyKey: string
}

export type Entity = {
  id: string
  firmId: string
  canonicalName: string
  cnic: string
  phone: string
  classification: Classification
}

export type EntityLink = {
  firmId: string
  leftId: string
  rightId: string
  identityBasis: "cnic"
  band: "confirmed-candidate"
  score: number
}

export type FollowUp = {
  id: string
  firmId: string
  matterId: string
  courtId: string
  raw: string
  kind: "case_number_reject" | "l4_10_silence"
  status?: "open" | "resolved"
  resolvedBy?: string | null
  resolvedAt?: number | null
}

export type Intimation = {
  id: string
  firmId: string
  matterId: string
  notifiedAt: number
  confirmedAt: number | null
}

export type AuditEntry = {
  id?: string
  firmId?: string
  action: string
  actorId: string
  target: string
  classification: Classification
  reason?: string
  at?: number
}

export type StatuteSectionVersion = {
  sectionId: string
  versionNo: number
  effectiveFrom: string
  effectiveTo: string | null
  text: string
}

export type Judgment = {
  id: string
  title: string
  benchType: "single" | "division" | "full" | "larger"
}

export type TreatmentRow = {
  treatingId: string
  treatedId: string
  treatment: "overruled" | "followed" | "applied"
  treatingBenchType: "single" | "division" | "full" | "larger"
}

export type EmbeddingRow = {
  entityId: string
  model: string
  vector: number[]
}

export type DraftRecord = {
  id: string
  firmId: string
  matterId: string
  templateId: string
  title: string
  body: string
  classification: Classification
  createdBy: string
  createdAt: number
  status: "draft"
}

export type WorkflowStatus =
  | "queued"
  | "processing"
  | "review_required"
  | "complete"

export type DocumentWorkflow = {
  documentId: string
  firmId: string
  matterId: string | null
  status: WorkflowStatus
  reviewerId: string | null
  updatedAt: number
}

export type WorkflowEvent = {
  id: string
  documentId: string
  firmId: string
  matterId: string | null
  actorId: string
  action:
    | "workflow_created"
    | "status_transition"
    | "reviewer_assigned"
    | "classification_confirmed"
    | "classification_declassified"
  status: WorkflowStatus
  classification: Classification
  reason?: string
  at: number
}

export type FilingPackage = {
  id: string
  firmId: string
  matterId: string
  draftId: string
  classification: Classification
  citationStatus: "OK" | "OVERRULED"
  temporalAllOk: boolean
  status: "pending_partner_approval" | "approved" | "rejected"
  createdBy: string
  createdAt: number
  approvedBy: string | null
  approvalReason: string | null
}

export type FilingPacketArtifactComponent = {
  componentId: string
  label: string
  required: boolean
  status: "ready" | "missing"
  sourceRef: string | null
  note?: string
}

export type FilingPacketArtifactRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  draftId: string
  classification: Classification
  readiness: "ready" | "blocked"
  blockedReasons: string[]
  components: FilingPacketArtifactComponent[]
  updatedAt: number
}

export type FilingDispatchQueueStatus =
  | "queued"
  | "in_progress"
  | "retry_pending"
  | "handoff_ready"
  | "blocked"

export type FilingDispatchQueueRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  status: FilingDispatchQueueStatus
  assigneeId: string | null
  retryCount: number
  lastAttemptAt: number | null
  operatorNotes: string[]
  externalDispatchState: "blocked_todo_firm" | "ready_for_firm_dispatch"
  updatedAt: number
}

export type FilingAnnexureGenerationStatus = "pending" | "assembling" | "ready" | "blocked"

export type FilingAnnexureManifestItem = {
  artifactId: string
  label: string
  required: boolean
  status: "pending" | "ready" | "blocked"
  sourceRef: string | null
  note?: string
}

export type FilingAnnexureRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  generationStatus: FilingAnnexureGenerationStatus
  manifest: FilingAnnexureManifestItem[]
  signerRequirements: {
    partnerSignoffBy: string | null
    partnerSignoffAt: number | null
    clerkVerificationBy: string | null
    clerkVerificationAt: number | null
  }
  operatorNotes: string[]
  submissionTransportBoundary: "todo_firm_external_transport_blocked"
  updatedAt: number
}

export type FilingSubmissionDispatchOutcome = "accepted" | "rejected" | "retry_scheduled"

export type FilingSubmissionCourtChannel =
  | "efiling_portal_stub"
  | "physical_counter_stub"
  | "courier_stub"

export type FilingSubmissionReceiptRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  attemptNo: number
  courtChannel: FilingSubmissionCourtChannel
  dispatchOutcome: FilingSubmissionDispatchOutcome
  submissionReference: string
  failureReason: string | null
  retryHint: string | null
  recordedBy: string
  recordedAt: number
  submissionTransportBoundary: "todo_firm_external_transport_blocked"
}

export type FilingSubmissionReconciliationStatus = "open" | "reconciled" | "needs_retry"

export type FilingSubmissionReconciliationRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  totalAttempts: number
  latestReceiptId: string | null
  latestSubmissionReference: string | null
  latestDispatchOutcome: FilingSubmissionDispatchOutcome | null
  status: FilingSubmissionReconciliationStatus
  notes: string[]
  updatedAt: number
}

export type FilingSubmissionExceptionSeverity = "medium" | "high" | "critical"

export type FilingSubmissionExceptionStatus = "open" | "claimed" | "escalated" | "resolved"

export type FilingSubmissionExceptionSource =
  | "receipt_retry_scheduled"
  | "receipt_rejected"
  | "reconciliation_needs_retry"
  | "dispatch_transport_blocked"
  | "dispatch_retry_plan"

export type FilingSubmissionExceptionRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  status: FilingSubmissionExceptionStatus
  severity: FilingSubmissionExceptionSeverity
  source: FilingSubmissionExceptionSource
  latestReceiptId: string | null
  latestReconciliationId: string | null
  escalationOwnerId: string | null
  firstRaisedAt: number
  lastRaisedAt: number
  slaTargetAt: number
  claimedBy: string | null
  claimedAt: number | null
  escalatedBy: string | null
  escalatedAt: number | null
  resolvedBy: string | null
  resolvedAt: number | null
  resolutionNotes: string[]
  updatedAt: number
}

export type FilingTransportExecutionOutcome =
  | "confirm_delivered"
  | "transport_blocked"
  | "retry_plan_attached"

export type FilingTransportExecutionChannel =
  | FilingSubmissionCourtChannel
  | "operator_followup_stub"

export type FilingTransportExecutionEvidenceRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  sequenceNo: number
  dispatchQueueId: string
  outcome: FilingTransportExecutionOutcome
  transportOperatorId: string
  transportChannel: FilingTransportExecutionChannel
  channelPayloadHash: string
  deterministicBlockerTags: string[]
  attachmentPointers: string[]
  relatedReceiptId: string | null
  relatedReconciliationId: string | null
  relatedExceptionId: string | null
  note: string | null
  createdAt: number
}

export type FilingSubmissionSlaDigestStatus =
  | "open_breach"
  | "acknowledged"
  | "deferred"
  | "cleared"

export type FilingSubmissionSlaDigestReason =
  | "sla_overdue"
  | "transport_blocked"
  | "retry_plan_stale"

export type FilingSubmissionSlaDigestRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  status: FilingSubmissionSlaDigestStatus
  breachReasons: FilingSubmissionSlaDigestReason[]
  staleRetryPlan: boolean
  outstandingOwnerId: string | null
  linkedExceptionId: string | null
  linkedEvidenceId: string | null
  breachWindowStartedAt: number
  deferUntil: number | null
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  deferredBy: string | null
  deferredAt: number | null
  clearedBy: string | null
  clearedAt: number | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationOwnerRotaStatus = "active" | "handoff_acknowledged" | "revoked"

export type FilingEscalationOwnerRotaRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  status: FilingEscalationOwnerRotaStatus
  primaryOwnerId: string | null
  backupOwnerId: string | null
  activeWindowStartAt: number
  activeWindowEndAt: number | null
  handoffRequired: boolean
  handoffAcknowledgedBy: string | null
  handoffAcknowledgedAt: number | null
  lastAssignedBy: string | null
  lastAssignedAt: number | null
  revokedBy: string | null
  revokedAt: number | null
  linkedExceptionId: string | null
  linkedDigestId: string | null
  notes: string[]
  updatedAt: number
}

export type FilingEscalationWorkloadDigestStatus =
  | "open_alert"
  | "acknowledged"
  | "snoozed"
  | "cleared"

export type FilingEscalationWorkloadAlertReason =
  | "overloaded_owner"
  | "unassigned_breach"
  | "handoff_lag"
  | "closure_compliance_pressure"

export type FilingEscalationHandoffLagBucket =
  | "none"
  | "lt_4h"
  | "between_4h_12h"
  | "gte_12h"

export type FilingEscalationWorkloadDigestRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  status: FilingEscalationWorkloadDigestStatus
  alertReasons: FilingEscalationWorkloadAlertReason[]
  ownerId: string | null
  ownerLoadCount: number
  ownerLoadThreshold: number
  handoffLagMs: number | null
  handoffLagBucket: FilingEscalationHandoffLagBucket
  snoozeUntil: number | null
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  rebalancedBy: string | null
  rebalancedAt: number | null
  linkedRotaId: string | null
  linkedDigestId: string | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationPolicyBaselineScope = "firm_default" | "package_override"

export type FilingEscalationPolicyBaselineRow = {
  id: string
  firmId: string
  packageId: string | null
  matterId: string | null
  classification: Classification
  scope: FilingEscalationPolicyBaselineScope
  ownerLoadThreshold: number
  handoffSlaMs: number
  waiverWindowMs: number
  setBy: string
  setAt: number
  notes: string[]
  updatedAt: number
}

export type FilingEscalationWaiverStatus = "active" | "revoked" | "expired"

export type FilingEscalationBreachWaiverLedgerRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  status: FilingEscalationWaiverStatus
  reason: string
  grantedBy: string
  grantedAt: number
  expiresAt: number
  revokedBy: string | null
  revokedAt: number | null
  linkedSlaDigestId: string | null
  linkedWorkloadDigestId: string | null
  notes: string[]
  updatedAt: number
}

export type FilingEscalationPolicyVarianceDigestStatus =
  | "open_alert"
  | "acknowledged"
  | "snoozed"
  | "cleared"

export type FilingEscalationPolicyVarianceReason =
  | "owner_load_threshold_override"
  | "handoff_sla_override"
  | "waiver_window_override"

export type FilingEscalationPolicyVarianceDigestRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  status: FilingEscalationPolicyVarianceDigestStatus
  varianceReasons: FilingEscalationPolicyVarianceReason[]
  firmDefaultPolicyId: string | null
  packagePolicyId: string | null
  ownerLoadThresholdDefault: number
  ownerLoadThresholdEffective: number
  handoffSlaMsDefault: number
  handoffSlaMsEffective: number
  waiverWindowMsDefault: number
  waiverWindowMsEffective: number
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  snoozeUntil: number | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationWaiverExpiryDigestStatus =
  | "open_expiry"
  | "acknowledged"
  | "extended"
  | "cleared"

export type FilingEscalationWaiverExpiryReason =
  | "expires_lte_24h"
  | "expires_lte_4h"
  | "already_expired"

export type FilingEscalationWaiverExpiryDigestRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  status: FilingEscalationWaiverExpiryDigestStatus
  reasons: FilingEscalationWaiverExpiryReason[]
  linkedWaiverId: string | null
  linkedPolicyId: string | null
  waiverExpiresAt: number | null
  msUntilExpiry: number | null
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  extendedBy: string | null
  extendedAt: number | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationVarianceRemediationDecision =
  | "accepted_risk"
  | "rollback"
  | "temporary_override"

export type FilingEscalationVarianceRemediationStatus = "active" | "expired" | "superseded"

export type FilingEscalationVarianceRemediationRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  decision: FilingEscalationVarianceRemediationDecision
  status: FilingEscalationVarianceRemediationStatus
  linkedPolicyVarianceDigestId: string | null
  linkedPolicyId: string | null
  justification: string
  decidedBy: string
  decidedAt: number
  expiresAt: number
  secondApproverId: string | null
  notes: string[]
  updatedAt: number
}

export type FilingEscalationWaiverRolloverStatus = "attested" | "not_required"

export type FilingEscalationWaiverRolloverAttestationRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  waiverId: string
  status: FilingEscalationWaiverRolloverStatus
  extensionHours: number
  previousExpiresAt: number
  newExpiresAt: number
  policyCapExpiresAt: number
  attestedBy: string
  secondApproverId: string
  justification: string
  attestedAt: number
  notes: string[]
  updatedAt: number
}

export type FilingEscalationRemediationExpiryDigestStatus =
  | "open_expiry"
  | "acknowledged"
  | "snoozed"
  | "cleared"

export type FilingEscalationRemediationExpiryReason =
  | "expires_lte_24h"
  | "expires_lte_4h"
  | "already_expired"
  | "closure_attestation_pending"

export type FilingEscalationRemediationExpiryDigestRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  status: FilingEscalationRemediationExpiryDigestStatus
  reasons: FilingEscalationRemediationExpiryReason[]
  linkedRemediationId: string | null
  linkedLifecycleId: string | null
  linkedPolicyVarianceDigestId: string | null
  linkedPolicyId: string | null
  remediationExpiresAt: number | null
  msUntilExpiry: number | null
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  snoozeUntil: number | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationRolloverBreachWatchStatus = "open_breach" | "acknowledged" | "cleared"

export type FilingEscalationRolloverBreachWatchReason =
  | "cap_crossed_without_attestation"
  | "reaffirmation_note_stale"

export type FilingEscalationRolloverBreachWatchRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  status: FilingEscalationRolloverBreachWatchStatus
  reasons: FilingEscalationRolloverBreachWatchReason[]
  linkedWaiverId: string | null
  linkedAttestationId: string | null
  linkedPolicyId: string | null
  policyCapExpiresAt: number | null
  waiverExpiresAt: number | null
  attestationUpdatedAt: number | null
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationRemediationClosureOutcome =
  | "resolved"
  | "rolled_back"
  | "accepted_risk_retired"

export type FilingEscalationRemediationLifecycleStatus = "open" | "closure_attested"

export type FilingEscalationRemediationLifecycleRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  remediationId: string
  remediationDecision: FilingEscalationVarianceRemediationDecision
  status: FilingEscalationRemediationLifecycleStatus
  linkedPolicyVarianceDigestId: string | null
  linkedPolicyId: string | null
  expiresAt: number
  openedBy: string
  openedAt: number
  closureOutcome: FilingEscalationRemediationClosureOutcome | null
  closureAttestedBy: string | null
  closureAttestedAt: number | null
  notes: string[]
  updatedAt: number
}

export type FilingEscalationRolloverReaffirmationSlaStatus =
  | "within_sla"
  | "warning"
  | "breached"
  | "acknowledged"
  | "cleared"

export type FilingEscalationRolloverReaffirmationSlaReason =
  | "cap_crossed_reaffirmation_warning"
  | "cap_crossed_reaffirmation_breached"

export type FilingEscalationRolloverReaffirmationSlaRow = {
  id: string
  firmId: string
  packageId: string
  matterId: string
  classification: Classification
  status: FilingEscalationRolloverReaffirmationSlaStatus
  reasons: FilingEscalationRolloverReaffirmationSlaReason[]
  linkedWaiverId: string | null
  linkedAttestationId: string | null
  linkedPolicyId: string | null
  policyCapExpiresAt: number | null
  waiverExpiresAt: number | null
  lastReaffirmedAt: number | null
  elapsedSinceReaffirmationMs: number | null
  warningThresholdMs: number
  breachThresholdMs: number
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureComplianceDigestStatus =
  | "open_alert"
  | "acknowledged"
  | "cleared"

export type FilingEscalationClosureComplianceDigestRow = {
  id: string
  firmId: string
  ownerId: string
  classification: Classification
  status: FilingEscalationClosureComplianceDigestStatus
  pendingLifecycleCount: number
  breachedReaffirmationCount: number
  linkedPackageIds: string[]
  linkedLifecycleIds: string[]
  linkedReaffirmationSlaIds: string[]
  linkedFollowupQueueId: string | null
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureFollowupQueueStatus = "open" | "claimed" | "resolved"

export type FilingEscalationClosureFollowupQueueRow = {
  id: string
  firmId: string
  ownerId: string
  digestId: string
  classification: Classification
  status: FilingEscalationClosureFollowupQueueStatus
  packageIds: string[]
  pendingLifecycleCount: number
  breachedReaffirmationCount: number
  assignedPartnerId: string | null
  claimedBy: string | null
  claimedAt: number | null
  resolvedBy: string | null
  resolvedAt: number | null
  resolutionNote: string | null
  notes: string[]
  updatedAt: number
}

export type FilingEscalationClosureSlaWindowStatus =
  | "within_window"
  | "ack_breached"
  | "clear_breached"
  | "auto_escalation_due"
  | "cleared"

export type FilingEscalationClosureSlaPressureLevel = "baseline" | "elevated" | "critical"

export type FilingEscalationClosureSlaWindowScope = "firm_default" | "owner_override"

export type FilingEscalationClosureSlaWindowConfigRow = {
  id: string
  firmId: string
  ownerId: string | null
  classification: Classification
  scope: FilingEscalationClosureSlaWindowScope
  ackDeadlineMs: number
  clearDeadlineMs: number
  autoEscalationMs: number
  setBy: string
  setAt: number
  notes: string[]
  updatedAt: number
}

export type FilingEscalationClosureAutoAssignmentMode = "owner_rota" | "workload_aware_claim"

export type FilingEscalationClosureAutoAssignmentRuleRow = {
  id: string
  firmId: string
  ownerId: string | null
  classification: Classification
  mode: FilingEscalationClosureAutoAssignmentMode
  enabled: boolean
  maxActiveClaimsPerPartner: number
  setBy: string
  setAt: number
  notes: string[]
  updatedAt: number
}

export type FilingEscalationClosureSlaWindowRow = {
  id: string
  firmId: string
  ownerId: string
  digestId: string
  queueId: string
  classification: Classification
  status: FilingEscalationClosureSlaWindowStatus
  pressureLevel: FilingEscalationClosureSlaPressureLevel
  openedAt: number | null
  acknowledgedAt: number | null
  clearedAt: number | null
  ackDeadlineAt: number | null
  clearDeadlineAt: number | null
  autoEscalateAt: number | null
  breachedAt: number | null
  autoEscalationTriggeredAt: number | null
  autoEscalatedToPartnerId: string | null
  linkedConfigId: string | null
  linkedAutoAssignmentRuleId: string | null
  notes: string[]
  updatedAt: number
}

export type FilingEscalationClosureAttestationStatus =
  | "pending_second_review"
  | "attested"
  | "rejected"

export type FilingEscalationClosureAttestationRow = {
  id: string
  sequenceNo: number
  firmId: string
  ownerId: string
  digestId: string
  queueId: string
  linkedSlaWindowId: string
  linkedExceptionDigestId: string | null
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureAttestationStatus
  claimPartnerId: string | null
  claimAt: number | null
  resolutionPartnerId: string | null
  resolutionAt: number | null
  attestedBy: string
  attestedAt: number
  secondReviewerId: string | null
  secondReviewedBy: string | null
  secondReviewedAt: number | null
  partnerConcurrence: boolean
  evidenceNote: string
  notes: string[]
  updatedAt: number
}

export type FilingEscalationClosureSlaExceptionStatus =
  | "open_exception"
  | "waived"
  | "expired"
  | "cleared"

export type FilingEscalationClosureSlaExceptionReason =
  | "ack_deadline_breached"
  | "clear_deadline_breached"
  | "auto_escalation_due"
  | "attestation_pending"
  | "attestation_rejected"
  | "policy_override_active"

export type FilingEscalationClosureSlaExceptionDigestRow = {
  id: string
  firmId: string
  ownerId: string
  digestId: string
  queueId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureSlaExceptionStatus
  pressureLevel: FilingEscalationClosureSlaPressureLevel
  reasons: FilingEscalationClosureSlaExceptionReason[]
  waiverReason: string | null
  waivedBy: string | null
  waivedAt: number | null
  waiverExpiresAt: number | null
  expiredAt: number | null
  linkedSlaWindowId: string | null
  linkedAttestationId: string | null
  linkedConfigId: string | null
  linkedAutoAssignmentRuleId: string | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureAttestationDisputeStatus =
  | "open_dispute"
  | "under_review"
  | "resolved_upheld"
  | "resolved_overturned"

export type FilingEscalationClosureAttestationDisputeRow = {
  id: string
  sequenceNo: number
  firmId: string
  ownerId: string
  digestId: string
  queueId: string
  attestationId: string
  exceptionDigestId: string | null
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureAttestationDisputeStatus
  conflictReason: string
  openedBy: string
  openedAt: number
  reviewerChainIds: string[]
  reviewerChainSnapshot: string
  underReviewBy: string | null
  underReviewAt: number | null
  resolvedBy: string | null
  resolvedAt: number | null
  resolutionNote: string | null
  notes: string[]
  updatedAt: number
}

export type FilingEscalationClosureSlaExceptionEnforcementStatus =
  | "countdown_active"
  | "reminder_sent"
  | "escalated"
  | "closed"

export type FilingEscalationClosureSlaExceptionEnforcementRow = {
  id: string
  firmId: string
  ownerId: string
  digestId: string
  queueId: string
  exceptionDigestId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureSlaExceptionEnforcementStatus
  waiverExpiresAt: number | null
  msUntilExpiry: number | null
  reminderCount: number
  escalationCount: number
  lastReminderAt: number | null
  lastEscalatedAt: number | null
  linkedAttestationDisputeId: string | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type CommitteeBrainOutput = {
  id: string
  firmId: string
  actorId: string
  classification: Classification
  purpose: string
  blocked: boolean
  reason?: string
  text?: string
  outbound: {
    body: string
    metadata: {
      classification: Classification
      provider: string
      purpose: string
      redactionCounts: Record<string, number>
    }
  }
  createdAt: number
}

export type MatterClientSearchIndexRow = {
  id: string
  firmId: string
  rowType: "matter" | "client"
  referenceId: string
  classification: Classification
  label: string
  detail: string
  linkedMatterId: string | null
  linkedClientId: string | null
  status: string
  tags: string[]
  updatedAt: number
}

export type DraftTemplateAnalyticsRow = {
  id: string
  firmId: string
  templateId: string
  templateName: string
  templatePosture: string
  templateCategory: string
  composeCount: number
  templateSearchCount: number
  lastComposedAt: number | null
  lastTemplateSearchAt: number | null
  lastTemplateSearchQuery: string | null
  updatedAt: number
}

export type WorkflowOpsActivityRow = {
  id: string
  firmId: string
  source: "workflow_event" | "court_ops"
  action: string
  actorId: string
  classification: Classification
  matterId: string | null
  documentId: string | null
  followUpId: string | null
  queueType: "follow_up" | "workflow" | null
  status: string | null
  detail: string
  tags: string[]
  createdAt: number
}

export class SpineStore {
  users = new Map<string, User>()
  members = new Map<string, MatterMember>()
  matters = new Map<string, Matter>()
  documents = new Map<string, DocumentRecord>()
  docsByHash = new Map<string, string>()
  jobs: Job[] = []
  entities = new Map<string, Entity>()
  links: EntityLink[] = []
  followUps: FollowUp[] = []
  intimations: Intimation[] = []
  audit: AuditEntry[] = []
  sectionVersions: StatuteSectionVersion[] = []
  judgments = new Map<string, Judgment>()
  treatments: TreatmentRow[] = []
  embeddings: EmbeddingRow[] = []
  drafts = new Map<string, DraftRecord>()
  documentWorkflow = new Map<string, DocumentWorkflow>()
  workflowEvents: WorkflowEvent[] = []
  filingPackages = new Map<string, FilingPackage>()
  filingPacketArtifacts = new Map<string, FilingPacketArtifactRow>()
  filingDispatchQueue = new Map<string, FilingDispatchQueueRow>()
  filingAnnexures = new Map<string, FilingAnnexureRow>()
  filingSubmissionReceipts = new Map<string, FilingSubmissionReceiptRow>()
  filingSubmissionReconciliation = new Map<string, FilingSubmissionReconciliationRow>()
  filingSubmissionExceptions = new Map<string, FilingSubmissionExceptionRow>()
  filingTransportExecutionEvidence = new Map<string, FilingTransportExecutionEvidenceRow>()
  filingSubmissionSlaDigests = new Map<string, FilingSubmissionSlaDigestRow>()
  filingEscalationOwnerRota = new Map<string, FilingEscalationOwnerRotaRow>()
  filingEscalationWorkloadDigests = new Map<string, FilingEscalationWorkloadDigestRow>()
  filingEscalationPolicyBaselines = new Map<string, FilingEscalationPolicyBaselineRow>()
  filingEscalationBreachWaivers = new Map<string, FilingEscalationBreachWaiverLedgerRow>()
  filingEscalationPolicyVarianceDigests = new Map<string, FilingEscalationPolicyVarianceDigestRow>()
  filingEscalationWaiverExpiryDigests = new Map<string, FilingEscalationWaiverExpiryDigestRow>()
  filingEscalationVarianceRemediations = new Map<string, FilingEscalationVarianceRemediationRow>()
  filingEscalationWaiverRolloverAttestations =
    new Map<string, FilingEscalationWaiverRolloverAttestationRow>()
  filingEscalationRemediationExpiryDigests =
    new Map<string, FilingEscalationRemediationExpiryDigestRow>()
  filingEscalationRolloverBreachWatches = new Map<string, FilingEscalationRolloverBreachWatchRow>()
  filingEscalationRemediationLifecycles =
    new Map<string, FilingEscalationRemediationLifecycleRow>()
  filingEscalationRolloverReaffirmationSlas =
    new Map<string, FilingEscalationRolloverReaffirmationSlaRow>()
  filingEscalationClosureComplianceDigests =
    new Map<string, FilingEscalationClosureComplianceDigestRow>()
  filingEscalationClosureFollowupQueues =
    new Map<string, FilingEscalationClosureFollowupQueueRow>()
  filingEscalationClosureSlaWindowConfigs =
    new Map<string, FilingEscalationClosureSlaWindowConfigRow>()
  filingEscalationClosureAutoAssignmentRules =
    new Map<string, FilingEscalationClosureAutoAssignmentRuleRow>()
  filingEscalationClosureSlaWindows =
    new Map<string, FilingEscalationClosureSlaWindowRow>()
  filingEscalationClosureAttestations =
    new Map<string, FilingEscalationClosureAttestationRow>()
  filingEscalationClosureSlaExceptionDigests =
    new Map<string, FilingEscalationClosureSlaExceptionDigestRow>()
  filingEscalationClosureAttestationDisputes =
    new Map<string, FilingEscalationClosureAttestationDisputeRow>()
  filingEscalationClosureSlaExceptionEnforcement =
    new Map<string, FilingEscalationClosureSlaExceptionEnforcementRow>()
  committeeOutputs = new Map<string, CommitteeBrainOutput>()
  matterClientSearchIndex = new Map<string, MatterClientSearchIndexRow>()
  draftTemplateAnalytics = new Map<string, DraftTemplateAnalyticsRow>()
  workflowOpsActivity = new Map<string, WorkflowOpsActivityRow>()
  corpusMetadata = {
    embedding_model: "text-embedding-3-small",
    embedding_dim: "1536",
  }
  reembedConfirmed = false

  hashKey(firmId: string, bytes: Buffer): string {
    return createHash("sha256").update(firmId).update(bytes).digest("hex")
  }

  id(prefix: string): string {
    return `${prefix}_${randomUUID()}`
  }

  memberKey(matterId: string, userId: string): string {
    return `${matterId}_${userId}`
  }
}

export function newStore(): SpineStore {
  return new SpineStore()
}

export function rankOf(c: Classification): number {
  return classificationRank(c)
}
