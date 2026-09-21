import { createHash, randomUUID } from "node:crypto"
import type { Classification } from "@/platform/p1/types"
import { classificationRank } from "@/platform/p1/types"

export type { Classification } from "@/platform/p1/types"

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
  authBoundary?: TenancyAuthBoundary
  sessionReferenceId?: string | null
  externalSessionId?: string | null
  privilegedBoundaryDriftCount?: number
  privilegedBoundaryDriftSessionReferenceIds?: string[]
  delegatedBoundaryLineageRootSessionReferenceId?: string | null
  delegatedBoundaryComparedSessionReferenceId?: string | null
  delegatedBoundaryReconciliationStatus?: "aligned" | "diverged"
  delegatedBoundaryDivergenceReasons?: string[]
  at?: number
}

export type TenancyAuthBoundary = "runtime_local" | "external_session_hint"

export type TenancySessionReferenceRow = {
  id: string
  firmId: string
  userId: string
  roleSnapshot: Role
  clearanceSnapshot: Classification
  parentSessionReferenceId: string | null
  lineageRootSessionReferenceId: string
  lineageDepth: number
  authBoundary: TenancyAuthBoundary
  externalSessionId: string | null
  delegatedBoundaryComparedSessionReferenceId: string | null
  delegatedBoundaryReconciliationStatus: "aligned" | "diverged"
  delegatedBoundaryDivergenceReasons: string[]
  delegatedBoundaryReconciledAt: number | null
  delegatedBoundaryReconciledBy: string | null
  issuedAt: number
  lastSeenAt: number
  expiresAt: number | null
  revokedAt: number | null
  revokedBy: string | null
  revokedReason: string | null
  privilegedBoundaryDriftedAt: number | null
  privilegedBoundaryDriftedBy: string | null
  privilegedBoundaryDriftReason: string | null
}

export type TenancyLineageDisputeDisposition =
  | "confirm_divergence"
  | "dismiss_dispute"
  | "mark_reconciled"

export type TenancyLineageDisputeAttestationRow = {
  id: string
  firmId: string
  lineageRootSessionReferenceId: string
  sessionReferenceId: string
  parentSessionReferenceId: string | null
  raisedBy: string
  raisedAt: number
  reason: string
  notes: string[]
  status: "open" | "resolved"
  reviewedBy: string | null
  reviewedAt: number | null
  disposition: TenancyLineageDisputeDisposition | null
  resolutionNote: string | null
}

export type TenancyLineageReconciliationDigestRow = {
  id: string
  firmId: string
  lineageRootSessionReferenceId: string
  lineageNodeCount: number
  lineageDepthMax: number
  divergedHopCount: number
  openDisputeCount: number
  resolvedDisputeCount: number
  unresolvedRevocationCount: number
  status: "aligned" | "needs_review"
  reasons: string[]
  updatedAt: number
}

export type TenancyLineageReconciliationQueueArbitrationDisposition =
  | "confirm_needs_review"
  | "dismiss_needs_review"
  | "mark_reconciled"

export type TenancyLineageReconciliationQueueArbitrationRow = {
  id: string
  firmId: string
  lineageRootSessionReferenceId: string
  digestId: string
  digestStatus: "aligned" | "needs_review"
  status: "queued" | "assigned" | "arbitrated"
  assignedPartnerId: string | null
  assignedBy: string | null
  assignedAt: number | null
  slaWindowStartedAt: number | null
  slaWindowDueAt: number | null
  disposition: TenancyLineageReconciliationQueueArbitrationDisposition | null
  dispositionBy: string | null
  dispositionAt: number | null
  notes: string[]
  updatedAt: number
}

export type TenancyLineageDigestClosureCheckpointRow = {
  id: string
  firmId: string
  lineageRootSessionReferenceId: string
  digestId: string
  status: "pending_attestation" | "closed_attested" | "reopened"
  attestedBy: string | null
  attestedAt: number | null
  closureReason: string | null
  reopenTrigger: string | null
  reopenedBy: string | null
  reopenedAt: number | null
  notes: string[]
  updatedAt: number
}

export type TenancyLineageClosureAdjudicationStatus =
  | "standby"
  | "quorum_pending"
  | "verdict_window_open"
  | "verdict_recorded"

export type TenancyLineageClosureAdjudicationRow = {
  id: string
  firmId: string
  lineageRootSessionReferenceId: string
  digestId: string
  arbitrationQueueId: string
  closureCheckpointId: string
  status: TenancyLineageClosureAdjudicationStatus
  requiredPanelQuorum: number
  confirmedPanelPartnerIds: string[]
  verdictWindowStartedAt: number | null
  verdictWindowDueAt: number | null
  verdictDisposition: TenancyLineageReconciliationQueueArbitrationDisposition | null
  verdictRecordedBy: string | null
  verdictRecordedAt: number | null
  dispositionDriftReasons: string[]
  reopenedClosureTrigger: string | null
  notes: string[]
  updatedAt: number
}

export type TenancyLineageArbitrationDebtRetirementStatus =
  | "pressure_open"
  | "retirement_attested"
  | "carryover_reopened"

export type TenancyLineageArbitrationDebtRetirementLedgerRow = {
  id: string
  firmId: string
  lineageRootSessionReferenceId: string
  digestId: string
  arbitrationQueueId: string
  closureCheckpointId: string
  status: TenancyLineageArbitrationDebtRetirementStatus
  unresolvedQueuePressureCount: number
  ownerAssignmentDebtCount: number
  assignedPartnerId: string | null
  retirementAttestedBy: string | null
  retirementAttestedAt: number | null
  retirementNote: string | null
  carryoverSignals: string[]
  carryoverReopenedBy: string | null
  carryoverReopenedAt: number | null
  notes: string[]
  updatedAt: number
}

export type TenancyLineageClosureAdjudicationSettlementStatus =
  | "draft"
  | "publication_checkpointed"
  | "correction_logged"
  | "sla_confirmed"

export type TenancyLineageClosureAdjudicationSettlementRow = {
  id: string
  firmId: string
  lineageRootSessionReferenceId: string
  digestId: string
  adjudicationId: string
  status: TenancyLineageClosureAdjudicationSettlementStatus
  verdictPublicationCheckpointedBy: string | null
  verdictPublicationCheckpointedAt: number | null
  verdictPublicationChannel: string | null
  publicationCorrectionNote: string | null
  publicationCorrectionBy: string | null
  publicationCorrectionAt: number | null
  settlementConfirmationSlaStartedAt: number | null
  settlementConfirmationSlaDueAt: number | null
  settlementConfirmedBy: string | null
  settlementConfirmedAt: number | null
  settlementSlaBreached: boolean
  notes: string[]
  updatedAt: number
}

export type TenancyLineageArbitrationDebtRetirementDisputeStatus =
  | "open"
  | "reviewer_assigned"
  | "resolved"
  | "rollback_controlled"

export type TenancyLineageArbitrationDebtRetirementDisputeResolutionOutcome =
  | "uphold_retirement"
  | "reopen_debt"
  | "require_rollback_review"

export type TenancyLineageArbitrationDebtRetirementDisputeLedgerRow = {
  id: string
  firmId: string
  lineageRootSessionReferenceId: string
  digestId: string
  debtLedgerId: string
  status: TenancyLineageArbitrationDebtRetirementDisputeStatus
  challengeReason: string
  challengeOpenedBy: string
  challengeOpenedAt: number
  reviewerId: string | null
  reviewerAssignedBy: string | null
  reviewerAssignedAt: number | null
  resolutionOutcome: TenancyLineageArbitrationDebtRetirementDisputeResolutionOutcome | null
  resolvedBy: string | null
  resolvedAt: number | null
  resolutionNote: string | null
  rollbackControlBy: string | null
  rollbackControlAt: number | null
  rollbackControlNote: string | null
  notes: string[]
  updatedAt: number
}

export type TenancyExternalSessionIdentityBridgeStatus =
  | "attested"
  | "quarantined"
  | "cleared"

export type TenancyExternalSessionIdentityBridgeMismatchStatus =
  | "aligned"
  | "mismatch_detected"
  | "assertion_missing"

export type TenancyExternalSessionIdentityBridgeRow = {
  id: string
  firmId: string
  lineageRootSessionReferenceId: string
  sessionReferenceId: string
  authBoundary: TenancyAuthBoundary
  sessionExternalSessionId: string | null
  status: TenancyExternalSessionIdentityBridgeStatus
  mismatchStatus: TenancyExternalSessionIdentityBridgeMismatchStatus
  mismatchReasons: string[]
  assertedIssuer: string | null
  assertedSubject: string | null
  assertedExternalSessionId: string | null
  attestedBy: string | null
  attestedAt: number | null
  quarantinedBy: string | null
  quarantinedAt: number | null
  quarantineReason: string | null
  clearedBy: string | null
  clearedAt: number | null
  clearReason: string | null
  notes: string[]
  updatedAt: number
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

export type FilingEscalationClosureAdjudicationStatus =
  | "pending_panel_assignment"
  | "panel_in_review"
  | "resolved_upheld"
  | "resolved_overturned"

export type FilingEscalationClosureAdjudicationVerdict =
  | "uphold_dispute"
  | "override_dispute"

export type FilingEscalationClosureAdjudicationQueueRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  disputeId: string
  attestationId: string
  exceptionDigestId: string | null
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureAdjudicationStatus
  panelMemberIds: string[]
  escalatedBy: string
  escalatedAt: number
  verdict: FilingEscalationClosureAdjudicationVerdict | null
  verdictBy: string | null
  verdictAt: number | null
  dissentNotes: string[]
  linkedEnforcementRebalanceId: string | null
  notes: string[]
  updatedAt: number
}

export type FilingEscalationClosureEnforcementRebalanceStatus =
  | "none"
  | "cooldown_scheduled"
  | "owner_reassignment_recommended"
  | "throttle_active"

export type FilingEscalationClosureEnforcementRebalanceRow = {
  id: string
  firmId: string
  ownerId: string
  digestId: string
  queueId: string
  enforcementId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureEnforcementRebalanceStatus
  triggeredByEscalationCount: number
  cooldownUntil: number | null
  recommendedOwnerId: string | null
  reopenThrottleUntil: number | null
  lastRebalancedBy: string | null
  lastRebalancedAt: number | null
  linkedAdjudicationQueueId: string | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureAdjudicationQuorumStatus =
  | "quorum_pending"
  | "quorum_met"
  | "verdict_overdue"
  | "closed"

export type FilingEscalationClosureAdjudicationQuorumBreachFlag =
  | "quorum_unmet"
  | "verdict_overdue"

export type FilingEscalationClosureAdjudicationQuorumRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  adjudicationId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureAdjudicationQuorumStatus
  requiredPanelCount: number
  confirmedPanelCount: number
  quorumMetAt: number | null
  quorumDeadlineAt: number
  verdictDueAt: number
  verdictRecordedAt: number | null
  breachFlags: FilingEscalationClosureAdjudicationQuorumBreachFlag[]
  lastGovernedBy: string | null
  lastGovernedAt: number | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureRebalanceExecutionStatus =
  | "queued"
  | "owner_transfer_in_progress"
  | "throttle_release_in_progress"
  | "completed"

export type FilingEscalationClosureRebalanceExecutionMode =
  | "owner_transfer"
  | "throttle_release"

export type FilingEscalationClosureRebalanceExecutionRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  rebalanceId: string
  classification: Classification
  packageIds: string[]
  mode: FilingEscalationClosureRebalanceExecutionMode
  status: FilingEscalationClosureRebalanceExecutionStatus
  targetOwnerId: string | null
  appliedOwnerId: string | null
  throttleReleased: boolean
  queueReopened: boolean
  executedBy: string | null
  executedAt: number | null
  churnCount: number
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureAdjudicationSloStatus =
  | "within_slo"
  | "deadline_extended"
  | "breach_open"
  | "breach_acknowledged"

export type FilingEscalationClosureAdjudicationSloEscalationTier =
  | "none"
  | "tier_1_partner_watch"
  | "tier_2_management_escalation"
  | "tier_3_executive_escalation"

export type FilingEscalationClosureAdjudicationSloRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  adjudicationId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureAdjudicationSloStatus
  escalationTier: FilingEscalationClosureAdjudicationSloEscalationTier
  baseVerdictDueAt: number
  effectiveVerdictDueAt: number
  extensionCount: number
  lastExtendedBy: string | null
  lastExtendedAt: number | null
  breachOpenedAt: number | null
  breachAcknowledgedBy: string | null
  breachAcknowledgedAt: number | null
  breachDebtHours: number
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureRebalanceSafeguardStatus =
  | "auto_exec_ready"
  | "cooldown_locked"
  | "duplicate_suppressed"
  | "override_attested"

export type FilingEscalationClosureRebalanceSuppressionReason =
  | "cooldown_lockout_active"
  | "duplicate_execution_window"
  | "manual_override_required"

export type FilingEscalationClosureRebalanceSafeguardRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  rebalanceId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureRebalanceSafeguardStatus
  cooldownLockUntil: number | null
  duplicateSuppressionUntil: number | null
  overrideAttestedBy: string | null
  overrideAttestedAt: number | null
  overrideReason: string | null
  lastAutoExecutedAt: number | null
  autoExecutionEligible: boolean
  suppressionReasons: FilingEscalationClosureRebalanceSuppressionReason[]
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureAdjudicationSloDebtRemediationStatus =
  | "debt_open"
  | "debt_retirement_pending"
  | "debt_retired"
  | "breach_closure_attested"

export type FilingEscalationClosureAdjudicationSloDebtRemediationRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  adjudicationId: string
  adjudicationSloId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureAdjudicationSloDebtRemediationStatus
  debtAgeHours: number
  debtRetiredHours: number
  retirementNotedBy: string | null
  retirementNotedAt: number | null
  tierDownshiftedTo: FilingEscalationClosureAdjudicationSloEscalationTier | null
  tierDownshiftedBy: string | null
  tierDownshiftedAt: number | null
  breachClosureAttestedBy: string | null
  breachClosureAttestedAt: number | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureRebalanceSafeguardExpiryStatus =
  | "expiry_pending"
  | "auto_cleared"
  | "override_expired"
  | "stale_lock_cleaned"

export type FilingEscalationClosureRebalanceSafeguardExpiryRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  rebalanceId: string
  safeguardId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureRebalanceSafeguardExpiryStatus
  suppressionExpiresAt: number | null
  overrideExpiresAt: number | null
  autoClearedAt: number | null
  staleLockCleanedBy: string | null
  staleLockCleanedAt: number | null
  expiryDebtHours: number
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureAdjudicationDebtBurndownStatus =
  | "burndown_tracking"
  | "burndown_checkpoint_due"
  | "burndown_attested"
  | "burndown_forecast_breached"

export type FilingEscalationClosureAdjudicationDebtBurndownRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  adjudicationId: string
  remediationId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureAdjudicationDebtBurndownStatus
  retirementTargetAt: number | null
  checkpointAt: number | null
  backlogAttestedBy: string | null
  backlogAttestedAt: number | null
  tierNormalizedBy: string | null
  tierNormalizedAt: number | null
  tierNormalizedTo: FilingEscalationClosureAdjudicationSloEscalationTier | null
  debtVelocityPerDay: number
  projectedBurndownHours: number
  forecastBreachHours: number
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureSafeguardExpiryAttestationStatus =
  | "attestation_open"
  | "attestation_acknowledged"
  | "attestation_overdue"
  | "attestation_reconciled"

export type FilingEscalationClosureSafeguardExpiryAttestationRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  rebalanceId: string
  expiryId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureSafeguardExpiryAttestationStatus
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  overdueExceptionQueuedBy: string | null
  overdueExceptionQueuedAt: number | null
  overrideReconciledBy: string | null
  overrideReconciledAt: number | null
  latestReconciliationNote: string | null
  openBacklogHours: number
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureBurndownRecalibrationStatus =
  | "recalibration_pending"
  | "confidence_band_overridden"
  | "checkpoint_rollback_noted"
  | "recalibration_settled"

export type FilingEscalationClosureBurndownRecalibrationRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  adjudicationId: string
  burndownId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureBurndownRecalibrationStatus
  rebaselineTargetAt: number | null
  confidenceBandLowerHours: number | null
  confidenceBandUpperHours: number | null
  confidenceOverriddenBy: string | null
  confidenceOverriddenAt: number | null
  rollbackNotedBy: string | null
  rollbackNotedAt: number | null
  rollbackReason: string | null
  settledBy: string | null
  settledAt: number | null
  confidenceDriftHours: number
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureExpiryAttestationQueueStatus =
  | "queue_open"
  | "queue_triaged"
  | "handoff_attested"
  | "queue_auto_drained"

export type FilingEscalationClosureExpiryAttestationQueueRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  rebalanceId: string
  attestationId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureExpiryAttestationQueueStatus
  triagedBy: string | null
  triagedAt: number | null
  handoffAttestedBy: string | null
  handoffAttestedAt: number | null
  handoffToOwnerId: string | null
  autoDrainCheckpointAt: number | null
  queueAgingHours: number
  openExceptionCount: number
  reconciliationCarryoverNote: string | null
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureBurndownSettlementStatus =
  | "settlement_pending"
  | "drift_acknowledged"
  | "target_lock_attested"
  | "rollback_resolution_closed"

export type FilingEscalationClosureBurndownSettlementRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  adjudicationId: string
  recalibrationId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureBurndownSettlementStatus
  driftAcknowledgedBy: string | null
  driftAcknowledgedAt: number | null
  targetLockAttestedBy: string | null
  targetLockAttestedAt: number | null
  rollbackResolutionClosedBy: string | null
  rollbackResolutionClosedAt: number | null
  rollbackResolutionNote: string | null
  settlementLatencyHours: number
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureExpiryAttestationQueueDrainStatus =
  | "drain_pending"
  | "handoff_timeout_escalated"
  | "stale_reassignment_attested"
  | "forced_drain_checkpointed"

export type FilingEscalationClosureExpiryAttestationQueueDrainRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  rebalanceId: string
  queueItemId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureExpiryAttestationQueueDrainStatus
  handoffTimeoutEscalatedBy: string | null
  handoffTimeoutEscalatedAt: number | null
  staleReassignmentAttestedBy: string | null
  staleReassignmentAttestedAt: number | null
  reassignedOwnerId: string | null
  forcedDrainCheckpointedBy: string | null
  forcedDrainCheckpointedAt: number | null
  forcedDrainOverrideNote: string | null
  drainThroughputPerDay: number
  openQueueAgingHours: number
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureSettlementAttestationStatus =
  | "verification_pending"
  | "lock_release_attested"
  | "dispute_reopen_guarded"
  | "settlement_verified"

export type FilingEscalationClosureSettlementAttestationRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  adjudicationId: string
  settlementId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureSettlementAttestationStatus
  postResolutionCheckpointedBy: string | null
  postResolutionCheckpointedAt: number | null
  lockReleaseAttestedBy: string | null
  lockReleaseAttestedAt: number | null
  disputeReopenGuardedBy: string | null
  disputeReopenGuardedAt: number | null
  disputeReopenGuardNote: string | null
  settlementVerificationLagHours: number
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureQueueDrainReconciliationStatus =
  | "reconciliation_pending"
  | "forced_drain_attested"
  | "reassignment_rollback_checkpointed"
  | "timeout_reentry_controlled"

export type FilingEscalationClosureQueueDrainReconciliationRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  rebalanceId: string
  queueDrainId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureQueueDrainReconciliationStatus
  forcedDrainAttestedBy: string | null
  forcedDrainAttestedAt: number | null
  reassignmentRollbackCheckpointedBy: string | null
  reassignmentRollbackCheckpointedAt: number | null
  rollbackToOwnerId: string | null
  timeoutReentryControlledBy: string | null
  timeoutReentryControlledAt: number | null
  timeoutReentryWindowHours: number | null
  drainReopenPressureCount: number
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureSettlementArbitrationStatus =
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

export type FilingEscalationClosureSettlementArbitrationRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  adjudicationId: string
  settlementAttestationId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureSettlementArbitrationStatus
  verificationOverridePetitionedBy: string | null
  verificationOverridePetitionedAt: number | null
  panelConfirmationAttestedBy: string | null
  panelConfirmationAttestedAt: number | null
  reopenVetoCheckpointedBy: string | null
  reopenVetoCheckpointedAt: number | null
  reopenVetoNote: string | null
  finalRulingIssuedBy?: string | null
  finalRulingIssuedAt?: number | null
  finalRulingSummary?: string | null
  dissentMemorializedBy?: string | null
  dissentMemorializedAt?: number | null
  dissentMemorializedNote?: string | null
  rulingPublicationCheckpointedBy?: string | null
  rulingPublicationCheckpointedAt?: number | null
  rulingPublicationChannel?: string | null
  publicationCorrectionLoggedBy?: string | null
  publicationCorrectionLoggedAt?: number | null
  publicationCorrectionNote?: string | null
  publicationRollbackCheckpointedBy?: string | null
  publicationRollbackCheckpointedAt?: number | null
  publicationRollbackReason?: string | null
  distributionAttestationReviewedBy?: string | null
  distributionAttestationReviewedAt?: number | null
  distributionAttestationDecision?: "approved" | "revision_required" | null
  settlementArbitrationLeadTimeHours: number
  arbitrationRulingAgingHours?: number
  arbitrationPublicationExceptionBacklogCount?: number
  notes: string[]
  lastEvaluatedAt: number
  updatedAt: number
}

export type FilingEscalationClosureQueueReentryComplianceStatus =
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

export type FilingEscalationClosureQueueReentryComplianceRow = {
  id: string
  firmId: string
  ownerId: string
  queueId: string
  rebalanceId: string
  queueReconciliationId: string
  classification: Classification
  packageIds: string[]
  status: FilingEscalationClosureQueueReentryComplianceStatus
  reentryExceptionAttestedBy: string | null
  reentryExceptionAttestedAt: number | null
  timeoutWaiverCheckpointedBy: string | null
  timeoutWaiverCheckpointedAt: number | null
  timeoutWaiverHours: number | null
  reconciliationResumedBy: string | null
  reconciliationResumedAt: number | null
  exceptionDebtAssignedBy?: string | null
  exceptionDebtAssignedAt?: number | null
  debtAssigneeId?: string | null
  debtRetirementAttestedBy?: string | null
  debtRetirementAttestedAt?: number | null
  debtRetiredCount?: number
  debtAgingAutoEscalatedBy?: string | null
  debtAgingAutoEscalatedAt?: number | null
  debtAgingEscalationHours?: number | null
  retirementDisputeOpenedBy?: string | null
  retirementDisputeOpenedAt?: number | null
  retirementDisputeReason?: string | null
  retirementDisputeResolvedBy?: string | null
  retirementDisputeResolvedAt?: number | null
  retirementDisputeResolution?: "uphold_retirement" | "reopen_debt" | null
  retirementRollbackControlledBy?: string | null
  retirementRollbackControlledAt?: number | null
  retirementRollbackCount?: number
  queueReentryExceptionDebtCount: number
  queueReentryRetirementBurnCount?: number
  queueReentryRetirementReconciliationDriftCount?: number
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

export type MatterReportExportAnalyticsRow = {
  id: string
  firmId: string
  matterId: string
  classification: Classification
  exportCount: number
  lastExportedAt: number | null
  lastExportedBy: string | null
  lastExportFormat: "csv" | "json" | "pdf" | null
  lastExportScope: "summary" | "detailed" | "relevance_review" | null
  lastExportReason: string | null
  updatedAt: number
}

export type MatterReportRelevanceScoreBand = "high" | "medium" | "low"

export type MatterReportRelevanceFreshnessStatus = "fresh" | "stale"

export type MatterReportRelevanceSnapshotRow = {
  id: string
  firmId: string
  matterId: string
  classification: Classification
  relevanceScore: number
  scoreBand: MatterReportRelevanceScoreBand
  freshnessStatus: MatterReportRelevanceFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
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

export type WorkflowOpsAlertDigestSeverity = "low" | "medium" | "high" | "critical"

export type WorkflowOpsAlertDigestFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertDigestRow = {
  id: string
  firmId: string
  matterId: string | null
  classification: Classification
  severity: WorkflowOpsAlertDigestSeverity
  backlogPressureCount: number
  unresolvedFollowUpDebtCount: number
  staleQueueWindowCount: number
  freshnessStatus: WorkflowOpsAlertDigestFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  acknowledgedAt: number | null
  acknowledgedBy: string | null
  acknowledgedReason: string | null
  snoozedUntil: number | null
  snoozedBy: string | null
  snoozedReason: string | null
  updatedAt: number
}

export type WorkflowOpsAlertAttestationStatus =
  | "pending_attestation"
  | "attested"
  | "reopened"

export type WorkflowOpsAlertAttestationFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertAttestationRow = {
  id: string
  firmId: string
  matterId: string
  alertDigestId: string
  classification: Classification
  attestationStatus: WorkflowOpsAlertAttestationStatus
  lastAttestedAt: number | null
  lastAttestedBy: string | null
  attestationReason: string | null
  freshnessStatus: WorkflowOpsAlertAttestationFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertEscalationStatus =
  | "not_required"
  | "open"
  | "assigned"
  | "resolved"

export type WorkflowOpsAlertEscalationFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertEscalationLedgerRow = {
  id: string
  firmId: string
  matterId: string
  alertDigestId: string
  classification: Classification
  escalationStatus: WorkflowOpsAlertEscalationStatus
  severity: WorkflowOpsAlertDigestSeverity
  ownerId: string | null
  openedAt: number | null
  lastStatusChangedAt: number | null
  resolvedAt: number | null
  resolutionReason: string | null
  freshnessStatus: WorkflowOpsAlertEscalationFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertAttestationDisputeStatus =
  | "not_contested"
  | "open"
  | "review_assigned"
  | "resolved"

export type WorkflowOpsAlertAttestationDisputeResolutionOutcome =
  | "upheld"
  | "overturned"
  | "deferred"

export type WorkflowOpsAlertAttestationDisputeFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertAttestationDisputeRow = {
  id: string
  firmId: string
  matterId: string
  alertAttestationId: string
  classification: Classification
  disputeStatus: WorkflowOpsAlertAttestationDisputeStatus
  reviewerId: string | null
  openedAt: number | null
  lastStatusChangedAt: number | null
  resolvedAt: number | null
  resolutionOutcome: WorkflowOpsAlertAttestationDisputeResolutionOutcome | null
  resolutionReason: string | null
  freshnessStatus: WorkflowOpsAlertAttestationDisputeFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertEscalationClosureStatus =
  | "pending_closure"
  | "checkpoint_recorded"
  | "closed"
  | "reopened"

export type WorkflowOpsAlertEscalationClosureFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertEscalationClosureRow = {
  id: string
  firmId: string
  matterId: string
  alertEscalationLedgerId: string
  classification: Classification
  closureStatus: WorkflowOpsAlertEscalationClosureStatus
  checkpointAt: number | null
  closedAt: number | null
  reopenedAt: number | null
  closureReason: string | null
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertEscalationClosureFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertDisputeEnforcementStatus =
  | "not_required"
  | "pending_enforcement"
  | "in_progress"
  | "enforced"
  | "waived"

export type WorkflowOpsAlertDisputeEnforcementFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertDisputeEnforcementLedgerRow = {
  id: string
  firmId: string
  matterId: string
  alertAttestationDisputeId: string
  classification: Classification
  enforcementStatus: WorkflowOpsAlertDisputeEnforcementStatus
  requiredOutcome: WorkflowOpsAlertAttestationDisputeResolutionOutcome | null
  ownerId: string | null
  checkpointAt: number | null
  enforcedAt: number | null
  waivedAt: number | null
  waiverReason: string | null
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertDisputeEnforcementFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertClosureDebtReconciliationStatus =
  | "in_balance"
  | "debt_open"
  | "reconciling"
  | "reconciled"

export type WorkflowOpsAlertClosureDebtReconciliationFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertClosureDebtReconciliationDigestRow = {
  id: string
  firmId: string
  matterId: string
  alertEscalationClosureId: string
  classification: Classification
  reconciliationStatus: WorkflowOpsAlertClosureDebtReconciliationStatus
  reopenDebtCount: number
  outstandingDebtCount: number
  lastReopenedAt: number | null
  reconcilingOwnerId: string | null
  reconciliationCheckpointAt: number | null
  reconciledAt: number | null
  reconciliationReason: string | null
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertClosureDebtReconciliationFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertEnforcementAttestationStatus =
  | "pending_attestation"
  | "attested"
  | "reopened"

export type WorkflowOpsAlertEnforcementAttestationFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertEnforcementAttestationRow = {
  id: string
  firmId: string
  matterId: string
  disputeEnforcementLedgerId: string
  classification: Classification
  attestationStatus: WorkflowOpsAlertEnforcementAttestationStatus
  requiredOutcome: WorkflowOpsAlertAttestationDisputeResolutionOutcome | null
  enforcementStatusSnapshot: WorkflowOpsAlertDisputeEnforcementStatus
  lastAttestedAt: number | null
  lastAttestedBy: string | null
  attestationReason: string | null
  freshnessStatus: WorkflowOpsAlertEnforcementAttestationFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertClosureDebtVarianceStatus =
  | "within_tolerance"
  | "variance_open"
  | "variance_reviewing"
  | "variance_resolved"

export type WorkflowOpsAlertClosureDebtVarianceFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertClosureDebtVarianceDigestRow = {
  id: string
  firmId: string
  matterId: string
  closureDebtReconciliationDigestId: string
  classification: Classification
  varianceStatus: WorkflowOpsAlertClosureDebtVarianceStatus
  outstandingVarianceCount: number
  varianceDelta: number
  reviewOwnerId: string | null
  varianceOpenedAt: number | null
  varianceResolvedAt: number | null
  varianceReason: string | null
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertClosureDebtVarianceFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertEnforcementWaiverStatus =
  | "not_requested"
  | "pending_attestation"
  | "attested"
  | "waived"

export type WorkflowOpsAlertEnforcementWaiverFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertEnforcementWaiverLedgerRow = {
  id: string
  firmId: string
  matterId: string
  enforcementAttestationId: string
  classification: Classification
  waiverStatus: WorkflowOpsAlertEnforcementWaiverStatus
  requestedBy: string | null
  requestedAt: number | null
  attestedBy: string | null
  attestedAt: number | null
  waivedBy: string | null
  waivedAt: number | null
  waiverReason: string | null
  waiverExpiresAt: number | null
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertEnforcementWaiverFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertVarianceRemediationQueueStatus =
  | "not_queued"
  | "queued"
  | "assigned"
  | "resolved"

export type WorkflowOpsAlertVarianceRemediationQueueFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertVarianceRemediationQueueRow = {
  id: string
  firmId: string
  matterId: string
  closureDebtVarianceDigestId: string
  classification: Classification
  queueStatus: WorkflowOpsAlertVarianceRemediationQueueStatus
  queueReason: string | null
  queuedAt: number | null
  ownerId: string | null
  assignedAt: number | null
  resolvedAt: number | null
  resolutionReason: string | null
  outstandingVarianceCountSnapshot: number
  varianceDeltaSnapshot: number
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertVarianceRemediationQueueFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertWaiverExpiryDigestStatus =
  | "no_risk"
  | "expires_lte_24h"
  | "expires_lte_4h"
  | "expired"
  | "acknowledged"
  | "extended"

export type WorkflowOpsAlertWaiverExpiryDigestFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertWaiverExpiryDigestRow = {
  id: string
  firmId: string
  matterId: string
  enforcementWaiverLedgerId: string
  classification: Classification
  expiryStatus: WorkflowOpsAlertWaiverExpiryDigestStatus
  waiverStatusSnapshot: WorkflowOpsAlertEnforcementWaiverStatus
  waiverExpiresAt: number | null
  msUntilExpiry: number | null
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  extendedBy: string | null
  extendedAt: number | null
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertWaiverExpiryDigestFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertVarianceRemediationSlaLedgerStatus =
  | "not_applicable"
  | "within_sla"
  | "warning"
  | "breached"
  | "acknowledged"
  | "resolved"

export type WorkflowOpsAlertVarianceRemediationSlaLedgerFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaLedgerRow = {
  id: string
  firmId: string
  matterId: string
  remediationQueueId: string
  classification: Classification
  slaStatus: WorkflowOpsAlertVarianceRemediationSlaLedgerStatus
  queueStatusSnapshot: WorkflowOpsAlertVarianceRemediationQueueStatus
  ownerIdSnapshot: string | null
  slaStartedAt: number | null
  warningThresholdMs: number
  breachThresholdMs: number
  warningDueAt: number | null
  breachDueAt: number | null
  elapsedMs: number | null
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  resolvedBy: string | null
  resolvedAt: number | null
  resolutionReason: string | null
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaLedgerFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertWaiverExpiryDisputeStatus =
  | "not_contested"
  | "open"
  | "review_assigned"
  | "resolved"

export type WorkflowOpsAlertWaiverExpiryDisputeResolutionOutcome =
  | "expiry_upheld"
  | "extension_granted"
  | "deferred"

export type WorkflowOpsAlertWaiverExpiryDisputeFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeRow = {
  id: string
  firmId: string
  matterId: string
  waiverExpiryDigestId: string
  classification: Classification
  disputeStatus: WorkflowOpsAlertWaiverExpiryDisputeStatus
  contestedExpiryStatusSnapshot: WorkflowOpsAlertWaiverExpiryDigestStatus
  waiverExpiresAtSnapshot: number | null
  openedBy: string | null
  openedAt: number | null
  reviewerId: string | null
  reviewAssignedAt: number | null
  resolvedBy: string | null
  resolvedAt: number | null
  resolutionOutcome: WorkflowOpsAlertWaiverExpiryDisputeResolutionOutcome | null
  resolutionReason: string | null
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachEscalationStatus =
  | "not_required"
  | "open"
  | "assigned"
  | "resolved"

export type WorkflowOpsAlertVarianceRemediationSlaBreachEscalationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow = {
  id: string
  firmId: string
  matterId: string
  remediationSlaLedgerId: string
  classification: Classification
  escalationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationStatus
  slaStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaLedgerStatus
  queueStatusSnapshot: WorkflowOpsAlertVarianceRemediationQueueStatus
  ownerId: string | null
  openedAt: number | null
  resolvedAt: number | null
  resolutionReason: string | null
  breachDueAtSnapshot: number | null
  elapsedMsSnapshot: number | null
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationStatus =
  | "not_required"
  | "open"
  | "panel_assigned"
  | "resolved"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationFreshnessStatus = "fresh" | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow = {
  id: string
  firmId: string
  matterId: string
  waiverExpiryDisputeId: string
  classification: Classification
  adjudicationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationStatus
  disputeStatusSnapshot: WorkflowOpsAlertWaiverExpiryDisputeStatus
  requestedOutcome: WorkflowOpsAlertWaiverExpiryDisputeResolutionOutcome | null
  panelOwnerId: string | null
  openedAt: number | null
  dueAt: number | null
  resolvedAt: number | null
  resolutionOutcome: WorkflowOpsAlertWaiverExpiryDisputeResolutionOutcome | null
  resolutionReason: string | null
  reopenPressureCount: number
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointStatus =
  | "not_required"
  | "open"
  | "checkpoint_recorded"
  | "reopened"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow = {
  id: string
  firmId: string
  matterId: string
  remediationSlaBreachEscalationId: string
  classification: Classification
  checkpointStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointStatus
  escalationStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationStatus
  ownerIdSnapshot: string | null
  checkpointOwnerId: string | null
  openedAt: number | null
  dueAt: number | null
  checkpointRecordedAt: number | null
  reopenedAt: number | null
  resolutionNote: string | null
  reopenPressureCount: number
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipStatus =
  | "not_required"
  | "watch"
  | "deadline_extended"
  | "breach_acknowledged"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow = {
  id: string
  firmId: string
  matterId: string
  waiverExpiryDisputeAdjudicationId: string
  classification: Classification
  sloStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipStatus
  adjudicationStatusSnapshot: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationStatus
  panelOwnerIdSnapshot: string | null
  dueAtSnapshot: number | null
  dueWindowDebtMs: number
  stewardId: string | null
  openedAt: number | null
  deadlineExtendedAt: number | null
  extendedDueAt: number | null
  breachAcknowledgedAt: number | null
  sloNote: string | null
  reopenPressureCount: number
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationStatus =
  | "not_required"
  | "open"
  | "attested"
  | "expiry_acknowledged"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryRiskStatus =
  | "no_risk"
  | "expires_soon"
  | "expired"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow = {
  id: string
  firmId: string
  matterId: string
  remediationSlaBreachResolutionCheckpointId: string
  classification: Classification
  attestationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationStatus
  checkpointStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointStatus
  dueAtSnapshot: number | null
  expiryRiskStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryRiskStatus
  attestedBy: string | null
  attestedAt: number | null
  expiryAcknowledgedBy: string | null
  expiryAcknowledgedAt: number | null
  attestationNote: string | null
  reopenPressureCount: number
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationStatus =
  | "not_required"
  | "debt_watch"
  | "remediation_recorded"
  | "tier_downshifted"
  | "breach_closure_attested"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow = {
  id: string
  firmId: string
  matterId: string
  waiverExpiryDisputeAdjudicationSloStewardshipId: string
  classification: Classification
  debtStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationStatus
  sloStatusSnapshot: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipStatus
  dueWindowDebtMsSnapshot: number
  debtRetiredMs: number
  remediationRecordedBy: string | null
  remediationRecordedAt: number | null
  tierDownshiftedBy: string | null
  tierDownshiftedAt: number | null
  breachClosureAttestedBy: string | null
  breachClosureAttestedAt: number | null
  remediationNote: string | null
  reopenPressureCount: number
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationStatus =
  | "not_required"
  | "exception_open"
  | "exception_assigned"
  | "exception_reconciled"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow =
  {
    id: string
    firmId: string
    matterId: string
    expiryAttestationId: string
    classification: Classification
    exceptionStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationStatus
    attestationStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationStatus
    expiryRiskStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryRiskStatus
    exceptionOpenedBy: string | null
    exceptionOpenedAt: number | null
    assigneeId: string | null
    assigneeAssignedAt: number | null
    reconciledBy: string | null
    reconciledAt: number | null
    overdueExceptionCount: number
    reconciliationNote: string | null
    reopenPressureCount: number
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownStatus =
  | "not_required"
  | "burndown_tracking"
  | "target_set"
  | "backlog_attested"
  | "burndown_checkpointed"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow = {
  id: string
  firmId: string
  matterId: string
  waiverExpiryDisputeAdjudicationSloDebtRemediationId: string
  classification: Classification
  burndownStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownStatus
  debtStatusSnapshot: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationStatus
  remainingDebtMs: number
  debtVelocityPerDay: number
  projectedBurndownHours: number
  forecastBreachHours: number
  retirementTargetAt: number | null
  targetSetBy: string | null
  targetSetAt: number | null
  backlogAttestedBy: string | null
  backlogAttestedAt: number | null
  checkpointedBy: string | null
  checkpointedAt: number | null
  burndownNote: string | null
  reopenPressureCount: number
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationStatus =
  | "not_required"
  | "queue_open"
  | "queue_triaged"
  | "handoff_attested"
  | "queue_auto_drained"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow =
  {
    id: string
    firmId: string
    matterId: string
    expiryAttestationExceptionReconciliationId: string
    classification: Classification
    queueStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationStatus
    exceptionStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationStatus
    overdueExceptionCountSnapshot: number
    queueAgingHours: number
    openExceptionCount: number
    drainVelocityPerDay: number
    triagedBy: string | null
    triagedAt: number | null
    handoffAttestedBy: string | null
    handoffAttestedAt: number | null
    handoffToOwnerId: string | null
    autoDrainCheckpointedBy: string | null
    autoDrainCheckpointedAt: number | null
    orchestrationNote: string | null
    reopenPressureCount: number
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementStatus =
  | "settlement_pending"
  | "drift_acknowledged"
  | "target_lock_attested"
  | "rollback_resolution_closed"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow = {
  id: string
  firmId: string
  matterId: string
  waiverExpiryDisputeAdjudicationSloDebtBurndownId: string
  classification: Classification
  settlementStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementStatus
  burndownStatusSnapshot: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownStatus
  settlementLatencyHours: number
  driftAcknowledgedBy: string | null
  driftAcknowledgedAt: number | null
  targetLockAttestedBy: string | null
  targetLockAttestedAt: number | null
  rollbackResolutionClosedBy: string | null
  rollbackResolutionClosedAt: number | null
  rollbackResolutionNote: string | null
  settlementNote: string | null
  reopenPressureCount: number
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainStatus =
  | "drain_pending"
  | "handoff_timeout_escalated"
  | "stale_reassignment_attested"
  | "forced_drain_checkpointed"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow =
  {
    id: string
    firmId: string
    matterId: string
    expiryAttestationQueueOrchestrationId: string
    classification: Classification
    drainStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainStatus
    queueStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationStatus
    openQueueAgingHours: number
    drainThroughputPerDay: number
    handoffTimeoutEscalatedBy: string | null
    handoffTimeoutEscalatedAt: number | null
    staleReassignmentAttestedBy: string | null
    staleReassignmentAttestedAt: number | null
    reassignedOwnerId: string | null
    forcedDrainCheckpointedBy: string | null
    forcedDrainCheckpointedAt: number | null
    forcedDrainOverrideNote: string | null
    drainNote: string | null
    reopenPressureCount: number
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationStatus =
  | "verification_pending"
  | "lock_release_attested"
  | "dispute_reopen_guarded"
  | "settlement_verified"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow = {
  id: string
  firmId: string
  matterId: string
  waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementId: string
  classification: Classification
  settlementAttestationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationStatus
  settlementStatusSnapshot: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementStatus
  postResolutionCheckpointedBy: string | null
  postResolutionCheckpointedAt: number | null
  lockReleaseAttestedBy: string | null
  lockReleaseAttestedAt: number | null
  disputeReopenGuardedBy: string | null
  disputeReopenGuardedAt: number | null
  disputeReopenGuardNote: string | null
  settlementVerificationLagHours: number
  reopenPressureCount: number
  attestationNote: string | null
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationStatus =
  | "reconciliation_pending"
  | "forced_drain_attested"
  | "reassignment_rollback_checkpointed"
  | "timeout_reentry_controlled"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow =
  {
    id: string
    firmId: string
    matterId: string
    expiryAttestationQueueDrainId: string
    classification: Classification
    reconciliationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationStatus
    drainStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainStatus
    forcedDrainAttestedBy: string | null
    forcedDrainAttestedAt: number | null
    reassignmentRollbackCheckpointedBy: string | null
    reassignmentRollbackCheckpointedAt: number | null
    rollbackToOwnerId: string | null
    timeoutReentryControlledBy: string | null
    timeoutReentryControlledAt: number | null
    timeoutReentryWindowHours: number | null
    drainReopenPressureCount: number
    reopenPressureCount: number
    reconciliationNote: string | null
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationStatus =
  | "arbitration_pending"
  | "verification_override_petitioned"
  | "panel_confirmation_attested"
  | "reopen_veto_checkpointed"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow = {
  id: string
  firmId: string
  matterId: string
  settlementAttestationId: string
  classification: Classification
  settlementArbitrationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationStatus
  settlementAttestationStatusSnapshot: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationStatus
  verificationOverridePetitionedBy: string | null
  verificationOverridePetitionedAt: number | null
  panelConfirmationAttestedBy: string | null
  panelConfirmationAttestedAt: number | null
  reopenVetoCheckpointedBy: string | null
  reopenVetoCheckpointedAt: number | null
  reopenVetoNote: string | null
  settlementArbitrationLeadTimeHours: number
  arbitrationNote: string | null
  lastStatusChangedAt: number | null
  freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationFreshnessStatus
  provenanceTags: string[]
  recomputedAt: number
  recomputedBy: string
  recomputeReason: string
  updatedAt: number
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceStatus =
  | "compliance_pending"
  | "reentry_exception_attested"
  | "timeout_waiver_checkpointed"
  | "reconciliation_resumed"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow =
  {
    id: string
    firmId: string
    matterId: string
    queueDrainReconciliationId: string
    classification: Classification
    complianceStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceStatus
    reconciliationStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationStatus
    reentryExceptionAttestedBy: string | null
    reentryExceptionAttestedAt: number | null
    timeoutWaiverCheckpointedBy: string | null
    timeoutWaiverCheckpointedAt: number | null
    timeoutWaiverHours: number | null
    reconciliationResumedBy: string | null
    reconciliationResumedAt: number | null
    queueReentryExceptionDebtCount: number
    complianceNote: string | null
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationStatus =
  | "disposition_pending"
  | "final_ruling_issued"
  | "dissent_memorialized"
  | "ruling_publication_checkpointed"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow =
  {
    id: string
    firmId: string
    matterId: string
    settlementArbitrationId: string
    classification: Classification
    dispositionFinalizationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationStatus
    settlementArbitrationStatusSnapshot: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationStatus
    finalRulingIssuedBy: string | null
    finalRulingIssuedAt: number | null
    finalRulingSummary: string | null
    dissentMemorializedBy: string | null
    dissentMemorializedAt: number | null
    dissentMemorializedNote: string | null
    rulingPublicationCheckpointedBy: string | null
    rulingPublicationCheckpointedAt: number | null
    rulingPublicationChannel: string | null
    arbitrationRulingAgingHours: number
    dispositionNote: string | null
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementStatus =
  | "retirement_pending"
  | "exception_debt_assigned"
  | "debt_retirement_attested"
  | "debt_aging_auto_escalated"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow =
  {
    id: string
    firmId: string
    matterId: string
    queueReentryComplianceId: string
    classification: Classification
    debtRetirementStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementStatus
    complianceStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceStatus
    exceptionDebtAssignedBy: string | null
    exceptionDebtAssignedAt: number | null
    debtAssigneeId: string | null
    debtRetirementAttestedBy: string | null
    debtRetirementAttestedAt: number | null
    debtRetiredCount: number
    debtAgingAutoEscalatedBy: string | null
    debtAgingAutoEscalatedAt: number | null
    debtAgingEscalationHours: number | null
    queueReentryExceptionDebtCountSnapshot: number
    queueReentryRetirementBurnCount: number
    retirementNote: string | null
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceStatus =
  | "publication_governance_pending"
  | "publication_correction_logged"
  | "publication_rollback_checkpointed"
  | "distribution_attestation_reviewed"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow =
  {
    id: string
    firmId: string
    matterId: string
    dispositionFinalizationId: string
    classification: Classification
    publicationGovernanceStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceStatus
    dispositionFinalizationStatusSnapshot: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationStatus
    publicationCorrectionLoggedBy: string | null
    publicationCorrectionLoggedAt: number | null
    publicationCorrectionNote: string | null
    publicationRollbackCheckpointedBy: string | null
    publicationRollbackCheckpointedAt: number | null
    publicationRollbackReason: string | null
    distributionAttestationReviewedBy: string | null
    distributionAttestationReviewedAt: number | null
    distributionAttestationDecision: "approved" | "revision_required" | null
    arbitrationPublicationExceptionBacklogCount: number
    arbitrationRulingAgingHoursSnapshot: number
    publicationGovernanceNote: string | null
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationStatus =
  | "reconciliation_pending"
  | "retirement_dispute_opened"
  | "retirement_dispute_resolved"
  | "retirement_rollback_controlled"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeResolutionOutcome =
  | "uphold_retirement"
  | "reopen_debt"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow =
  {
    id: string
    firmId: string
    matterId: string
    debtRetirementId: string
    classification: Classification
    disputeReconciliationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationStatus
    debtRetirementStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementStatus
    retirementDisputeOpenedBy: string | null
    retirementDisputeOpenedAt: number | null
    retirementDisputeReason: string | null
    retirementDisputeResolvedBy: string | null
    retirementDisputeResolvedAt: number | null
    retirementDisputeResolution: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeResolutionOutcome | null
    retirementRollbackControlledBy: string | null
    retirementRollbackControlledAt: number | null
    retirementRollbackCount: number
    queueReentryRetirementReconciliationDriftCount: number
    reconciliationNote: string | null
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerStatus =
  | "external_distribution_audit_pending"
  | "distribution_channel_registered"
  | "attestation_signer_roster_recorded"
  | "publication_freeze_checkpointed"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow =
  {
    id: string
    firmId: string
    matterId: string
    publicationGovernanceId: string
    classification: Classification
    externalDistributionAuditLedgerStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerStatus
    publicationGovernanceStatusSnapshot: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceStatus
    distributionChannelRegistry: string | null
    distributionChannelRegisteredBy: string | null
    distributionChannelRegisteredAt: number | null
    attestationSignerRoster: string | null
    attestationSignerRosterRecordedBy: string | null
    attestationSignerRosterRecordedAt: number | null
    publicationFreezeCheckpointedBy: string | null
    publicationFreezeCheckpointedAt: number | null
    publicationFreezeReason: string | null
    distributionAttestationBacklogCount: number
    arbitrationPublicationExceptionBacklogCountSnapshot: number
    auditLedgerNote: string | null
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationStatus =
  | "closure_verification_pending"
  | "reconciliation_closure_attested"
  | "rollback_verification_checkpointed"
  | "dispute_archive_checkpointed"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow =
  {
    id: string
    firmId: string
    matterId: string
    disputeReconciliationId: string
    classification: Classification
    closureVerificationStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationStatus
    disputeReconciliationStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationStatus
    reconciliationClosureAttestedBy: string | null
    reconciliationClosureAttestedAt: number | null
    rollbackVerificationCheckpointedBy: string | null
    rollbackVerificationCheckpointedAt: number | null
    rollbackVerificationNote: string | null
    disputeArchiveCheckpointedBy: string | null
    disputeArchiveCheckpointedAt: number | null
    disputeArchiveReference: string | null
    reconciliationClosureLagHours: number
    reconciliationClosureLagCount: number
    queueReentryRetirementReconciliationDriftCountSnapshot: number
    closureVerificationNote: string | null
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationStatus =
  | "partner_handoff_attestation_pending"
  | "outbound_registry_registered"
  | "partner_handoff_attested"
  | "outbound_registry_freeze_override_checkpointed"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow =
  {
    id: string
    firmId: string
    matterId: string
    externalDistributionAuditLedgerId: string
    classification: Classification
    partnerHandoffAttestationStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationStatus
    externalDistributionAuditLedgerStatusSnapshot: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerStatus
    outboundPartnerHandoffRegistry: string | null
    outboundRegistryRegisteredBy: string | null
    outboundRegistryRegisteredAt: number | null
    partnerHandoffAttestedBy: string | null
    partnerHandoffAttestedAt: number | null
    partnerHandoffReference: string | null
    outboundRegistryFreezeOverrideCheckpointedBy: string | null
    outboundRegistryFreezeOverrideCheckpointedAt: number | null
    outboundRegistryFreezeOverrideReason: string | null
    partnerHandoffBacklogCount: number
    distributionAttestationBacklogCountSnapshot: number
    partnerHandoffAttestationNote: string | null
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportStatus =
  | "archival_export_pending"
  | "archival_export_checkpointed"
  | "closure_verification_sla_breach_digested"
  | "archival_export_finalized"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportFreshnessStatus =
  | "fresh"
  | "stale"

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow =
  {
    id: string
    firmId: string
    matterId: string
    closureVerificationId: string
    classification: Classification
    archivalExportStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportStatus
    closureVerificationStatusSnapshot: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationStatus
    archivalExportCheckpointedBy: string | null
    archivalExportCheckpointedAt: number | null
    archivalExportReference: string | null
    closureVerificationSlaBreachDigestedBy: string | null
    closureVerificationSlaBreachDigestedAt: number | null
    closureVerificationSlaBreachDigest: string | null
    archivalExportFinalizedBy: string | null
    archivalExportFinalizedAt: number | null
    closureArchivalLagHours: number
    closureArchivalLagCount: number
    reconciliationClosureLagCountSnapshot: number
    archivalExportNote: string | null
    lastStatusChangedAt: number | null
    freshnessStatus: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportFreshnessStatus
    provenanceTags: string[]
    recomputedAt: number
    recomputedBy: string
    recomputeReason: string
    updatedAt: number
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
  filingEscalationClosureAdjudicationQueue =
    new Map<string, FilingEscalationClosureAdjudicationQueueRow>()
  filingEscalationClosureEnforcementRebalance =
    new Map<string, FilingEscalationClosureEnforcementRebalanceRow>()
  filingEscalationClosureAdjudicationQuorum =
    new Map<string, FilingEscalationClosureAdjudicationQuorumRow>()
  filingEscalationClosureRebalanceExecution =
    new Map<string, FilingEscalationClosureRebalanceExecutionRow>()
  filingEscalationClosureAdjudicationSlo =
    new Map<string, FilingEscalationClosureAdjudicationSloRow>()
  filingEscalationClosureRebalanceSafeguards =
    new Map<string, FilingEscalationClosureRebalanceSafeguardRow>()
  filingEscalationClosureAdjudicationSloDebtRemediation =
    new Map<string, FilingEscalationClosureAdjudicationSloDebtRemediationRow>()
  filingEscalationClosureRebalanceSafeguardExpiry =
    new Map<string, FilingEscalationClosureRebalanceSafeguardExpiryRow>()
  filingEscalationClosureAdjudicationDebtBurndown =
    new Map<string, FilingEscalationClosureAdjudicationDebtBurndownRow>()
  filingEscalationClosureSafeguardExpiryAttestations =
    new Map<string, FilingEscalationClosureSafeguardExpiryAttestationRow>()
  filingEscalationClosureBurndownRecalibration =
    new Map<string, FilingEscalationClosureBurndownRecalibrationRow>()
  filingEscalationClosureExpiryAttestationQueue =
    new Map<string, FilingEscalationClosureExpiryAttestationQueueRow>()
  filingEscalationClosureBurndownSettlement =
    new Map<string, FilingEscalationClosureBurndownSettlementRow>()
  filingEscalationClosureExpiryAttestationQueueDrain =
    new Map<string, FilingEscalationClosureExpiryAttestationQueueDrainRow>()
  filingEscalationClosureSettlementAttestation =
    new Map<string, FilingEscalationClosureSettlementAttestationRow>()
  filingEscalationClosureQueueDrainReconciliation =
    new Map<string, FilingEscalationClosureQueueDrainReconciliationRow>()
  filingEscalationClosureSettlementArbitration =
    new Map<string, FilingEscalationClosureSettlementArbitrationRow>()
  filingEscalationClosureQueueReentryCompliance =
    new Map<string, FilingEscalationClosureQueueReentryComplianceRow>()
  committeeOutputs = new Map<string, CommitteeBrainOutput>()
  matterClientSearchIndex = new Map<string, MatterClientSearchIndexRow>()
  draftTemplateAnalytics = new Map<string, DraftTemplateAnalyticsRow>()
  matterReportExportAnalytics = new Map<string, MatterReportExportAnalyticsRow>()
  matterReportRelevanceSnapshots = new Map<string, MatterReportRelevanceSnapshotRow>()
  workflowOpsActivity = new Map<string, WorkflowOpsActivityRow>()
  workflowOpsAlertDigests = new Map<string, WorkflowOpsAlertDigestRow>()
  workflowOpsAlertAttestations = new Map<string, WorkflowOpsAlertAttestationRow>()
  workflowOpsAlertEscalationLedgers = new Map<string, WorkflowOpsAlertEscalationLedgerRow>()
  workflowOpsAlertAttestationDisputes = new Map<string, WorkflowOpsAlertAttestationDisputeRow>()
  workflowOpsAlertEscalationClosures = new Map<string, WorkflowOpsAlertEscalationClosureRow>()
  workflowOpsAlertDisputeEnforcementLedgers =
    new Map<string, WorkflowOpsAlertDisputeEnforcementLedgerRow>()
  workflowOpsAlertClosureDebtReconciliationDigests =
    new Map<string, WorkflowOpsAlertClosureDebtReconciliationDigestRow>()
  workflowOpsAlertEnforcementAttestations =
    new Map<string, WorkflowOpsAlertEnforcementAttestationRow>()
  workflowOpsAlertClosureDebtVarianceDigests =
    new Map<string, WorkflowOpsAlertClosureDebtVarianceDigestRow>()
  workflowOpsAlertEnforcementWaiverLedgers =
    new Map<string, WorkflowOpsAlertEnforcementWaiverLedgerRow>()
  workflowOpsAlertVarianceRemediationQueues =
    new Map<string, WorkflowOpsAlertVarianceRemediationQueueRow>()
  workflowOpsAlertWaiverExpiryDigests =
    new Map<string, WorkflowOpsAlertWaiverExpiryDigestRow>()
  workflowOpsAlertVarianceRemediationSlaLedgers =
    new Map<string, WorkflowOpsAlertVarianceRemediationSlaLedgerRow>()
  workflowOpsAlertWaiverExpiryDisputes =
    new Map<string, WorkflowOpsAlertWaiverExpiryDisputeRow>()
  workflowOpsAlertVarianceRemediationSlaBreachEscalations =
    new Map<string, WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow>()
  workflowOpsAlertWaiverExpiryDisputeAdjudications =
    new Map<string, WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow>()
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints =
    new Map<string, WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow>()
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships =
    new Map<string, WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow>()
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations =
    new Map<string, WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow>()
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations =
    new Map<string, WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow>()
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations =
    new Map<
      string,
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow
    >()
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns =
    new Map<string, WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow>()
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations =
    new Map<
      string,
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow
    >()
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlements =
    new Map<string, WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow>()
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrains =
    new Map<
      string,
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow
    >()
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestations =
    new Map<
      string,
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow
    >()
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliations =
    new Map<
      string,
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow
    >()
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrations =
    new Map<
      string,
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow
    >()
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliances =
    new Map<
      string,
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow
    >()
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizations =
    new Map<
      string,
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow
    >()
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirements =
    new Map<
      string,
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow
    >()
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernances =
    new Map<
      string,
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow
    >()
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliations =
    new Map<
      string,
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow
    >()
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgers =
    new Map<
      string,
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow
    >()
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerifications =
    new Map<
      string,
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow
    >()
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestations =
    new Map<
      string,
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow
    >()
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExports =
    new Map<
      string,
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow
    >()
  tenancySessionReferences = new Map<string, TenancySessionReferenceRow>()
  tenancyLineageDisputeAttestations = new Map<string, TenancyLineageDisputeAttestationRow>()
  tenancyLineageReconciliationDigests = new Map<string, TenancyLineageReconciliationDigestRow>()
  tenancyLineageReconciliationQueueArbitrations =
    new Map<string, TenancyLineageReconciliationQueueArbitrationRow>()
  tenancyLineageDigestClosureCheckpoints =
    new Map<string, TenancyLineageDigestClosureCheckpointRow>()
  tenancyLineageClosureAdjudications = new Map<string, TenancyLineageClosureAdjudicationRow>()
  tenancyLineageArbitrationDebtRetirementLedgers =
    new Map<string, TenancyLineageArbitrationDebtRetirementLedgerRow>()
  tenancyLineageClosureAdjudicationSettlements =
    new Map<string, TenancyLineageClosureAdjudicationSettlementRow>()
  tenancyLineageArbitrationDebtRetirementDisputeLedgers =
    new Map<string, TenancyLineageArbitrationDebtRetirementDisputeLedgerRow>()
  tenancyExternalSessionIdentityBridges = new Map<string, TenancyExternalSessionIdentityBridgeRow>()
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
