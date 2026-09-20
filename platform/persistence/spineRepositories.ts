import type {
  DocumentRecord,
  DraftRecord,
  FilingAnnexureRow,
  FilingDispatchQueueRow,
  FilingPackage,
  FilingPacketArtifactRow,
  FilingSubmissionExceptionRow,
  FilingEscalationOwnerRotaRow,
  FilingEscalationPolicyBaselineRow,
  FilingEscalationBreachWaiverLedgerRow,
  FilingEscalationClosureComplianceDigestRow,
  FilingEscalationClosureFollowupQueueRow,
  FilingEscalationClosureSlaWindowConfigRow,
  FilingEscalationClosureAutoAssignmentRuleRow,
  FilingEscalationClosureSlaWindowRow,
  FilingEscalationClosureAttestationRow,
  FilingEscalationClosureSlaExceptionDigestRow,
  FilingEscalationClosureAttestationDisputeRow,
  FilingEscalationClosureSlaExceptionEnforcementRow,
  FilingEscalationClosureAdjudicationQueueRow,
  FilingEscalationClosureEnforcementRebalanceRow,
  FilingEscalationClosureAdjudicationQuorumRow,
  FilingEscalationClosureRebalanceExecutionRow,
  FilingEscalationClosureAdjudicationSloRow,
  FilingEscalationClosureRebalanceSafeguardRow,
  FilingEscalationClosureAdjudicationSloDebtRemediationRow,
  FilingEscalationClosureRebalanceSafeguardExpiryRow,
  FilingEscalationClosureAdjudicationDebtBurndownRow,
  FilingEscalationClosureSafeguardExpiryAttestationRow,
  FilingEscalationClosureBurndownRecalibrationRow,
  FilingEscalationClosureExpiryAttestationQueueRow,
  FilingEscalationClosureBurndownSettlementRow,
  FilingEscalationClosureExpiryAttestationQueueDrainRow,
  FilingEscalationClosureSettlementAttestationRow,
  FilingEscalationClosureQueueDrainReconciliationRow,
  FilingEscalationPolicyVarianceDigestRow,
  FilingEscalationRemediationExpiryDigestRow,
  FilingEscalationRemediationLifecycleRow,
  FilingEscalationRolloverBreachWatchRow,
  FilingEscalationRolloverReaffirmationSlaRow,
  FilingEscalationVarianceRemediationRow,
  FilingEscalationWaiverRolloverAttestationRow,
  FilingEscalationWaiverExpiryDigestRow,
  FilingEscalationWorkloadDigestRow,
  FilingSubmissionReceiptRow,
  FilingSubmissionReconciliationRow,
  FilingSubmissionSlaDigestRow,
  FilingTransportExecutionEvidenceRow,
  FollowUp,
  Intimation,
  Job,
  MatterClientSearchIndexRow,
  DraftTemplateAnalyticsRow,
  WorkflowOpsActivityRow,
  AuditEntry,
  CommitteeBrainOutput,
  Entity,
  EntityLink,
  Matter,
  MatterMember,
  DocumentWorkflow,
  WorkflowEvent,
  User,
  SpineStore,
} from "@/platform/spine/store"

export type MatterRepository = {
  create(row: Matter): Promise<void>
  get(id: string): Promise<Matter | null>
  update(id: string, patch: Partial<Matter>): Promise<Matter | null>
  listByFirm(firmId: string): Promise<Matter[]>
}

export type UserRepository = {
  upsert(row: User): Promise<void>
  get(id: string): Promise<User | null>
  listByFirm(firmId: string): Promise<User[]>
}

export type EntityRepository = {
  create(row: Entity): Promise<void>
  get(id: string): Promise<Entity | null>
  listByFirm(firmId: string): Promise<Entity[]>
}

export type EntityLinkRepository = {
  upsert(row: EntityLink): Promise<void>
  listByFirm(firmId: string): Promise<EntityLink[]>
}

export type MatterMemberRepository = {
  upsert(row: MatterMember): Promise<void>
  get(matterId: string, userId: string): Promise<MatterMember | null>
  listByFirm(firmId: string): Promise<MatterMember[]>
  listByMatter(matterId: string): Promise<MatterMember[]>
}

export type DocumentRepository = {
  create(row: DocumentRecord): Promise<void>
  get(id: string): Promise<DocumentRecord | null>
  update(id: string, patch: Partial<DocumentRecord>): Promise<DocumentRecord | null>
  listByFirm(firmId: string): Promise<DocumentRecord[]>
}

export type DraftRepository = {
  create(row: DraftRecord): Promise<void>
  get(id: string): Promise<DraftRecord | null>
  listByFirm(firmId: string): Promise<DraftRecord[]>
}

export type WorkflowRepository = {
  createOrUpdate(row: DocumentWorkflow): Promise<void>
  get(documentId: string): Promise<DocumentWorkflow | null>
  listByFirm(firmId: string): Promise<DocumentWorkflow[]>
}

export type FilingRepository = {
  create(row: FilingPackage): Promise<void>
  get(id: string): Promise<FilingPackage | null>
  update(id: string, patch: Partial<FilingPackage>): Promise<FilingPackage | null>
  listByFirm(firmId: string): Promise<FilingPackage[]>
}

export type FilingPacketArtifactRepository = {
  upsert(row: FilingPacketArtifactRow): Promise<void>
  get(id: string): Promise<FilingPacketArtifactRow | null>
  listByFirm(firmId: string): Promise<FilingPacketArtifactRow[]>
  listByPackageId(packageId: string): Promise<FilingPacketArtifactRow[]>
}

export type FilingDispatchQueueRepository = {
  upsert(row: FilingDispatchQueueRow): Promise<void>
  get(id: string): Promise<FilingDispatchQueueRow | null>
  listByFirm(firmId: string): Promise<FilingDispatchQueueRow[]>
  listByPackageId(packageId: string): Promise<FilingDispatchQueueRow[]>
}

export type FilingAnnexureRepository = {
  upsert(row: FilingAnnexureRow): Promise<void>
  get(id: string): Promise<FilingAnnexureRow | null>
  listByFirm(firmId: string): Promise<FilingAnnexureRow[]>
  listByPackageId(packageId: string): Promise<FilingAnnexureRow[]>
}

export type FilingSubmissionReceiptRepository = {
  upsert(row: FilingSubmissionReceiptRow): Promise<void>
  get(id: string): Promise<FilingSubmissionReceiptRow | null>
  listByFirm(firmId: string): Promise<FilingSubmissionReceiptRow[]>
  listByPackageId(packageId: string): Promise<FilingSubmissionReceiptRow[]>
}

export type FilingSubmissionReconciliationRepository = {
  upsert(row: FilingSubmissionReconciliationRow): Promise<void>
  get(id: string): Promise<FilingSubmissionReconciliationRow | null>
  listByFirm(firmId: string): Promise<FilingSubmissionReconciliationRow[]>
  listByPackageId(packageId: string): Promise<FilingSubmissionReconciliationRow[]>
}

export type FilingSubmissionExceptionRepository = {
  upsert(row: FilingSubmissionExceptionRow): Promise<void>
  get(id: string): Promise<FilingSubmissionExceptionRow | null>
  listByFirm(firmId: string): Promise<FilingSubmissionExceptionRow[]>
  listByPackageId(packageId: string): Promise<FilingSubmissionExceptionRow[]>
}

export type FilingTransportExecutionEvidenceRepository = {
  upsert(row: FilingTransportExecutionEvidenceRow): Promise<void>
  get(id: string): Promise<FilingTransportExecutionEvidenceRow | null>
  listByFirm(firmId: string): Promise<FilingTransportExecutionEvidenceRow[]>
  listByPackageId(packageId: string): Promise<FilingTransportExecutionEvidenceRow[]>
}

export type FilingSubmissionSlaDigestRepository = {
  upsert(row: FilingSubmissionSlaDigestRow): Promise<void>
  get(id: string): Promise<FilingSubmissionSlaDigestRow | null>
  listByFirm(firmId: string): Promise<FilingSubmissionSlaDigestRow[]>
  listByPackageId(packageId: string): Promise<FilingSubmissionSlaDigestRow[]>
}

export type FilingEscalationOwnerRotaRepository = {
  upsert(row: FilingEscalationOwnerRotaRow): Promise<void>
  get(id: string): Promise<FilingEscalationOwnerRotaRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationOwnerRotaRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationOwnerRotaRow[]>
}

export type FilingEscalationWorkloadDigestRepository = {
  upsert(row: FilingEscalationWorkloadDigestRow): Promise<void>
  get(id: string): Promise<FilingEscalationWorkloadDigestRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationWorkloadDigestRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationWorkloadDigestRow[]>
}

export type FilingEscalationPolicyBaselineRepository = {
  upsert(row: FilingEscalationPolicyBaselineRow): Promise<void>
  get(id: string): Promise<FilingEscalationPolicyBaselineRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationPolicyBaselineRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationPolicyBaselineRow[]>
}

export type FilingEscalationBreachWaiverLedgerRepository = {
  upsert(row: FilingEscalationBreachWaiverLedgerRow): Promise<void>
  get(id: string): Promise<FilingEscalationBreachWaiverLedgerRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationBreachWaiverLedgerRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationBreachWaiverLedgerRow[]>
}

export type FilingEscalationPolicyVarianceDigestRepository = {
  upsert(row: FilingEscalationPolicyVarianceDigestRow): Promise<void>
  get(id: string): Promise<FilingEscalationPolicyVarianceDigestRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationPolicyVarianceDigestRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationPolicyVarianceDigestRow[]>
}

export type FilingEscalationWaiverExpiryDigestRepository = {
  upsert(row: FilingEscalationWaiverExpiryDigestRow): Promise<void>
  get(id: string): Promise<FilingEscalationWaiverExpiryDigestRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationWaiverExpiryDigestRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationWaiverExpiryDigestRow[]>
}

export type FilingEscalationVarianceRemediationRepository = {
  upsert(row: FilingEscalationVarianceRemediationRow): Promise<void>
  get(id: string): Promise<FilingEscalationVarianceRemediationRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationVarianceRemediationRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationVarianceRemediationRow[]>
}

export type FilingEscalationWaiverRolloverAttestationRepository = {
  upsert(row: FilingEscalationWaiverRolloverAttestationRow): Promise<void>
  get(id: string): Promise<FilingEscalationWaiverRolloverAttestationRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationWaiverRolloverAttestationRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationWaiverRolloverAttestationRow[]>
}

export type FilingEscalationRemediationExpiryDigestRepository = {
  upsert(row: FilingEscalationRemediationExpiryDigestRow): Promise<void>
  get(id: string): Promise<FilingEscalationRemediationExpiryDigestRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationRemediationExpiryDigestRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationRemediationExpiryDigestRow[]>
}

export type FilingEscalationRolloverBreachWatchRepository = {
  upsert(row: FilingEscalationRolloverBreachWatchRow): Promise<void>
  get(id: string): Promise<FilingEscalationRolloverBreachWatchRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationRolloverBreachWatchRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationRolloverBreachWatchRow[]>
}

export type FilingEscalationRemediationLifecycleRepository = {
  upsert(row: FilingEscalationRemediationLifecycleRow): Promise<void>
  get(id: string): Promise<FilingEscalationRemediationLifecycleRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationRemediationLifecycleRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationRemediationLifecycleRow[]>
}

export type FilingEscalationRolloverReaffirmationSlaRepository = {
  upsert(row: FilingEscalationRolloverReaffirmationSlaRow): Promise<void>
  get(id: string): Promise<FilingEscalationRolloverReaffirmationSlaRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationRolloverReaffirmationSlaRow[]>
  listByPackageId(packageId: string): Promise<FilingEscalationRolloverReaffirmationSlaRow[]>
}

export type FilingEscalationClosureComplianceDigestRepository = {
  upsert(row: FilingEscalationClosureComplianceDigestRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureComplianceDigestRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureComplianceDigestRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureComplianceDigestRow[]>
}

export type FilingEscalationClosureFollowupQueueRepository = {
  upsert(row: FilingEscalationClosureFollowupQueueRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureFollowupQueueRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureFollowupQueueRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureFollowupQueueRow[]>
}

export type FilingEscalationClosureSlaWindowConfigRepository = {
  upsert(row: FilingEscalationClosureSlaWindowConfigRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureSlaWindowConfigRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureSlaWindowConfigRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureSlaWindowConfigRow[]>
}

export type FilingEscalationClosureAutoAssignmentRuleRepository = {
  upsert(row: FilingEscalationClosureAutoAssignmentRuleRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureAutoAssignmentRuleRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureAutoAssignmentRuleRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureAutoAssignmentRuleRow[]>
}

export type FilingEscalationClosureSlaWindowRepository = {
  upsert(row: FilingEscalationClosureSlaWindowRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureSlaWindowRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureSlaWindowRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureSlaWindowRow[]>
}

export type FilingEscalationClosureAttestationRepository = {
  upsert(row: FilingEscalationClosureAttestationRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureAttestationRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureAttestationRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureAttestationRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureAttestationRow[]>
}

export type FilingEscalationClosureSlaExceptionDigestRepository = {
  upsert(row: FilingEscalationClosureSlaExceptionDigestRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureSlaExceptionDigestRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureSlaExceptionDigestRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureSlaExceptionDigestRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureSlaExceptionDigestRow[]>
}

export type FilingEscalationClosureAttestationDisputeRepository = {
  upsert(row: FilingEscalationClosureAttestationDisputeRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureAttestationDisputeRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureAttestationDisputeRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureAttestationDisputeRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureAttestationDisputeRow[]>
  listByAttestationId(attestationId: string): Promise<FilingEscalationClosureAttestationDisputeRow[]>
}

export type FilingEscalationClosureSlaExceptionEnforcementRepository = {
  upsert(row: FilingEscalationClosureSlaExceptionEnforcementRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureSlaExceptionEnforcementRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureSlaExceptionEnforcementRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureSlaExceptionEnforcementRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureSlaExceptionEnforcementRow[]>
}

export type FilingEscalationClosureAdjudicationQueueRepository = {
  upsert(row: FilingEscalationClosureAdjudicationQueueRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureAdjudicationQueueRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureAdjudicationQueueRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureAdjudicationQueueRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureAdjudicationQueueRow[]>
  listByDisputeId(disputeId: string): Promise<FilingEscalationClosureAdjudicationQueueRow[]>
}

export type FilingEscalationClosureEnforcementRebalanceRepository = {
  upsert(row: FilingEscalationClosureEnforcementRebalanceRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureEnforcementRebalanceRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureEnforcementRebalanceRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureEnforcementRebalanceRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureEnforcementRebalanceRow[]>
}

export type FilingEscalationClosureAdjudicationQuorumRepository = {
  upsert(row: FilingEscalationClosureAdjudicationQuorumRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureAdjudicationQuorumRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureAdjudicationQuorumRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureAdjudicationQuorumRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureAdjudicationQuorumRow[]>
  listByAdjudicationId(adjudicationId: string): Promise<FilingEscalationClosureAdjudicationQuorumRow[]>
}

export type FilingEscalationClosureRebalanceExecutionRepository = {
  upsert(row: FilingEscalationClosureRebalanceExecutionRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureRebalanceExecutionRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureRebalanceExecutionRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureRebalanceExecutionRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureRebalanceExecutionRow[]>
  listByRebalanceId(rebalanceId: string): Promise<FilingEscalationClosureRebalanceExecutionRow[]>
}

export type FilingEscalationClosureAdjudicationSloRepository = {
  upsert(row: FilingEscalationClosureAdjudicationSloRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureAdjudicationSloRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureAdjudicationSloRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureAdjudicationSloRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureAdjudicationSloRow[]>
  listByAdjudicationId(adjudicationId: string): Promise<FilingEscalationClosureAdjudicationSloRow[]>
}

export type FilingEscalationClosureRebalanceSafeguardRepository = {
  upsert(row: FilingEscalationClosureRebalanceSafeguardRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureRebalanceSafeguardRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureRebalanceSafeguardRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureRebalanceSafeguardRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureRebalanceSafeguardRow[]>
  listByRebalanceId(rebalanceId: string): Promise<FilingEscalationClosureRebalanceSafeguardRow[]>
}

export type FilingEscalationClosureAdjudicationSloDebtRemediationRepository = {
  upsert(row: FilingEscalationClosureAdjudicationSloDebtRemediationRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureAdjudicationSloDebtRemediationRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureAdjudicationSloDebtRemediationRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureAdjudicationSloDebtRemediationRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureAdjudicationSloDebtRemediationRow[]>
  listByAdjudicationId(
    adjudicationId: string
  ): Promise<FilingEscalationClosureAdjudicationSloDebtRemediationRow[]>
}

export type FilingEscalationClosureRebalanceSafeguardExpiryRepository = {
  upsert(row: FilingEscalationClosureRebalanceSafeguardExpiryRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureRebalanceSafeguardExpiryRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureRebalanceSafeguardExpiryRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureRebalanceSafeguardExpiryRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureRebalanceSafeguardExpiryRow[]>
  listByRebalanceId(
    rebalanceId: string
  ): Promise<FilingEscalationClosureRebalanceSafeguardExpiryRow[]>
}

export type FilingEscalationClosureAdjudicationDebtBurndownRepository = {
  upsert(row: FilingEscalationClosureAdjudicationDebtBurndownRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureAdjudicationDebtBurndownRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureAdjudicationDebtBurndownRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureAdjudicationDebtBurndownRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureAdjudicationDebtBurndownRow[]>
  listByAdjudicationId(
    adjudicationId: string
  ): Promise<FilingEscalationClosureAdjudicationDebtBurndownRow[]>
}

export type FilingEscalationClosureSafeguardExpiryAttestationRepository = {
  upsert(row: FilingEscalationClosureSafeguardExpiryAttestationRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureSafeguardExpiryAttestationRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureSafeguardExpiryAttestationRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureSafeguardExpiryAttestationRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureSafeguardExpiryAttestationRow[]>
  listByRebalanceId(
    rebalanceId: string
  ): Promise<FilingEscalationClosureSafeguardExpiryAttestationRow[]>
}

export type FilingEscalationClosureBurndownRecalibrationRepository = {
  upsert(row: FilingEscalationClosureBurndownRecalibrationRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureBurndownRecalibrationRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureBurndownRecalibrationRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureBurndownRecalibrationRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureBurndownRecalibrationRow[]>
  listByAdjudicationId(
    adjudicationId: string
  ): Promise<FilingEscalationClosureBurndownRecalibrationRow[]>
}

export type FilingEscalationClosureExpiryAttestationQueueRepository = {
  upsert(row: FilingEscalationClosureExpiryAttestationQueueRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureExpiryAttestationQueueRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureExpiryAttestationQueueRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureExpiryAttestationQueueRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureExpiryAttestationQueueRow[]>
  listByRebalanceId(
    rebalanceId: string
  ): Promise<FilingEscalationClosureExpiryAttestationQueueRow[]>
}

export type FilingEscalationClosureBurndownSettlementRepository = {
  upsert(row: FilingEscalationClosureBurndownSettlementRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureBurndownSettlementRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureBurndownSettlementRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureBurndownSettlementRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureBurndownSettlementRow[]>
  listByAdjudicationId(
    adjudicationId: string
  ): Promise<FilingEscalationClosureBurndownSettlementRow[]>
}

export type FilingEscalationClosureExpiryAttestationQueueDrainRepository = {
  upsert(row: FilingEscalationClosureExpiryAttestationQueueDrainRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureExpiryAttestationQueueDrainRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureExpiryAttestationQueueDrainRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureExpiryAttestationQueueDrainRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureExpiryAttestationQueueDrainRow[]>
  listByRebalanceId(
    rebalanceId: string
  ): Promise<FilingEscalationClosureExpiryAttestationQueueDrainRow[]>
}

export type FilingEscalationClosureSettlementAttestationRepository = {
  upsert(row: FilingEscalationClosureSettlementAttestationRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureSettlementAttestationRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureSettlementAttestationRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureSettlementAttestationRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureSettlementAttestationRow[]>
  listByAdjudicationId(
    adjudicationId: string
  ): Promise<FilingEscalationClosureSettlementAttestationRow[]>
}

export type FilingEscalationClosureQueueDrainReconciliationRepository = {
  upsert(row: FilingEscalationClosureQueueDrainReconciliationRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureQueueDrainReconciliationRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureQueueDrainReconciliationRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureQueueDrainReconciliationRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureQueueDrainReconciliationRow[]>
  listByRebalanceId(
    rebalanceId: string
  ): Promise<FilingEscalationClosureQueueDrainReconciliationRow[]>
}

export type JobRepository = {
  create(row: Job): Promise<void>
  listByFirm(firmId: string): Promise<Job[]>
  listByDocument(documentId: string): Promise<Job[]>
}

export type WorkflowEventRepository = {
  append(row: WorkflowEvent): Promise<void>
  listByFirm(firmId: string): Promise<WorkflowEvent[]>
}

export type FollowUpRepository = {
  upsert(row: FollowUp): Promise<void>
  get(id: string): Promise<FollowUp | null>
  listByFirm(firmId: string): Promise<FollowUp[]>
}

export type IntimationRepository = {
  upsert(row: Intimation): Promise<void>
  get(id: string): Promise<Intimation | null>
  listByFirm(firmId: string): Promise<Intimation[]>
  listByMatter(matterId: string): Promise<Intimation[]>
}

export type AuditRepository = {
  append(row: AuditEntry): Promise<void>
  listByFirm(firmId: string): Promise<AuditEntry[]>
}

export type CommitteeBrainOutputRepository = {
  create(row: CommitteeBrainOutput): Promise<void>
  get(id: string): Promise<CommitteeBrainOutput | null>
  listByFirm(firmId: string): Promise<CommitteeBrainOutput[]>
}

export type MatterClientSearchIndexRepository = {
  upsert(row: MatterClientSearchIndexRow): Promise<void>
  get(id: string): Promise<MatterClientSearchIndexRow | null>
  listByFirm(firmId: string): Promise<MatterClientSearchIndexRow[]>
}

export type DraftTemplateAnalyticsRepository = {
  upsert(row: DraftTemplateAnalyticsRow): Promise<void>
  get(id: string): Promise<DraftTemplateAnalyticsRow | null>
  listByFirm(firmId: string): Promise<DraftTemplateAnalyticsRow[]>
}

export type WorkflowOpsActivityRepository = {
  upsert(row: WorkflowOpsActivityRow): Promise<void>
  get(id: string): Promise<WorkflowOpsActivityRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsActivityRow[]>
}

export type SpineRepositories = {
  matters: MatterRepository
  users: UserRepository
  entities: EntityRepository
  entityLinks: EntityLinkRepository
  members: MatterMemberRepository
  documents: DocumentRepository
  drafts: DraftRepository
  workflow: WorkflowRepository
  filings: FilingRepository
  filingPacketArtifacts: FilingPacketArtifactRepository
  filingDispatchQueue: FilingDispatchQueueRepository
  filingAnnexures: FilingAnnexureRepository
  filingSubmissionReceipts: FilingSubmissionReceiptRepository
  filingSubmissionReconciliation: FilingSubmissionReconciliationRepository
  filingSubmissionExceptions: FilingSubmissionExceptionRepository
  filingTransportExecutionEvidence: FilingTransportExecutionEvidenceRepository
  filingSubmissionSlaDigests: FilingSubmissionSlaDigestRepository
  filingEscalationOwnerRota: FilingEscalationOwnerRotaRepository
  filingEscalationWorkloadDigests: FilingEscalationWorkloadDigestRepository
  filingEscalationPolicyBaselines: FilingEscalationPolicyBaselineRepository
  filingEscalationBreachWaivers: FilingEscalationBreachWaiverLedgerRepository
  filingEscalationPolicyVarianceDigests: FilingEscalationPolicyVarianceDigestRepository
  filingEscalationWaiverExpiryDigests: FilingEscalationWaiverExpiryDigestRepository
  filingEscalationVarianceRemediations: FilingEscalationVarianceRemediationRepository
  filingEscalationWaiverRolloverAttestations: FilingEscalationWaiverRolloverAttestationRepository
  filingEscalationRemediationExpiryDigests: FilingEscalationRemediationExpiryDigestRepository
  filingEscalationRolloverBreachWatches: FilingEscalationRolloverBreachWatchRepository
  filingEscalationRemediationLifecycles: FilingEscalationRemediationLifecycleRepository
  filingEscalationRolloverReaffirmationSlas: FilingEscalationRolloverReaffirmationSlaRepository
  filingEscalationClosureComplianceDigests: FilingEscalationClosureComplianceDigestRepository
  filingEscalationClosureFollowupQueues: FilingEscalationClosureFollowupQueueRepository
  filingEscalationClosureSlaWindowConfigs: FilingEscalationClosureSlaWindowConfigRepository
  filingEscalationClosureAutoAssignmentRules: FilingEscalationClosureAutoAssignmentRuleRepository
  filingEscalationClosureSlaWindows: FilingEscalationClosureSlaWindowRepository
  filingEscalationClosureAttestations: FilingEscalationClosureAttestationRepository
  filingEscalationClosureSlaExceptionDigests: FilingEscalationClosureSlaExceptionDigestRepository
  filingEscalationClosureAttestationDisputes: FilingEscalationClosureAttestationDisputeRepository
  filingEscalationClosureSlaExceptionEnforcement: FilingEscalationClosureSlaExceptionEnforcementRepository
  filingEscalationClosureAdjudicationQueue: FilingEscalationClosureAdjudicationQueueRepository
  filingEscalationClosureEnforcementRebalance: FilingEscalationClosureEnforcementRebalanceRepository
  filingEscalationClosureAdjudicationQuorum: FilingEscalationClosureAdjudicationQuorumRepository
  filingEscalationClosureRebalanceExecution: FilingEscalationClosureRebalanceExecutionRepository
  filingEscalationClosureAdjudicationSlo: FilingEscalationClosureAdjudicationSloRepository
  filingEscalationClosureRebalanceSafeguards: FilingEscalationClosureRebalanceSafeguardRepository
  filingEscalationClosureAdjudicationSloDebtRemediation: FilingEscalationClosureAdjudicationSloDebtRemediationRepository
  filingEscalationClosureRebalanceSafeguardExpiry: FilingEscalationClosureRebalanceSafeguardExpiryRepository
  filingEscalationClosureAdjudicationDebtBurndown: FilingEscalationClosureAdjudicationDebtBurndownRepository
  filingEscalationClosureSafeguardExpiryAttestations: FilingEscalationClosureSafeguardExpiryAttestationRepository
  filingEscalationClosureBurndownRecalibration: FilingEscalationClosureBurndownRecalibrationRepository
  filingEscalationClosureExpiryAttestationQueue: FilingEscalationClosureExpiryAttestationQueueRepository
  filingEscalationClosureBurndownSettlement: FilingEscalationClosureBurndownSettlementRepository
  filingEscalationClosureExpiryAttestationQueueDrain: FilingEscalationClosureExpiryAttestationQueueDrainRepository
  filingEscalationClosureSettlementAttestation: FilingEscalationClosureSettlementAttestationRepository
  filingEscalationClosureQueueDrainReconciliation: FilingEscalationClosureQueueDrainReconciliationRepository
  jobs: JobRepository
  workflowEvents: WorkflowEventRepository
  followUps: FollowUpRepository
  intimations: IntimationRepository
  audit: AuditRepository
  committeeOutputs: CommitteeBrainOutputRepository
  reportingIndex: MatterClientSearchIndexRepository
  draftTemplateAnalytics: DraftTemplateAnalyticsRepository
  workflowOpsActivity: WorkflowOpsActivityRepository
}

export function createMemoryRepositories(store: SpineStore): SpineRepositories {
  return {
    matters: {
      async create(row) {
        store.matters.set(row.id, row)
      },
      async get(id) {
        return store.matters.get(id) ?? null
      },
      async update(id, patch) {
        const current = store.matters.get(id)
        if (!current) return null
        const next = { ...current, ...patch }
        store.matters.set(id, next)
        return next
      },
      async listByFirm(firmId) {
        return [...store.matters.values()].filter((row) => row.firmId === firmId)
      },
    },
    users: {
      async upsert(row) {
        store.users.set(row.id, row)
      },
      async get(id) {
        return store.users.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.users.values()].filter((row) => row.firmId === firmId)
      },
    },
    entities: {
      async create(row) {
        store.entities.set(row.id, row)
      },
      async get(id) {
        return store.entities.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.entities.values()].filter((row) => row.firmId === firmId)
      },
    },
    entityLinks: {
      async upsert(row) {
        const idx = store.links.findIndex(
          (entry) =>
            entry.firmId === row.firmId &&
            entry.leftId === row.leftId &&
            entry.rightId === row.rightId &&
            entry.identityBasis === row.identityBasis
        )
        if (idx >= 0) {
          store.links[idx] = row
          return
        }
        store.links.push(row)
      },
      async listByFirm(firmId) {
        return store.links.filter((row) => row.firmId === firmId)
      },
    },
    members: {
      async upsert(row) {
        store.members.set(store.memberKey(row.matterId, row.userId), row)
      },
      async get(matterId, userId) {
        return store.members.get(store.memberKey(matterId, userId)) ?? null
      },
      async listByFirm(firmId) {
        return [...store.members.values()].filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return [...store.members.values()].filter((row) => row.matterId === matterId)
      },
    },
    documents: {
      async create(row) {
        store.documents.set(row.id, row)
      },
      async get(id) {
        return store.documents.get(id) ?? null
      },
      async update(id, patch) {
        const current = store.documents.get(id)
        if (!current) return null
        const next = { ...current, ...patch }
        store.documents.set(id, next)
        return next
      },
      async listByFirm(firmId) {
        return [...store.documents.values()].filter((row) => row.firmId === firmId)
      },
    },
    drafts: {
      async create(row) {
        store.drafts.set(row.id, row)
      },
      async get(id) {
        return store.drafts.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.drafts.values()].filter((row) => row.firmId === firmId)
      },
    },
    workflow: {
      async createOrUpdate(row) {
        store.documentWorkflow.set(row.documentId, row)
      },
      async get(documentId) {
        return store.documentWorkflow.get(documentId) ?? null
      },
      async listByFirm(firmId) {
        return [...store.documentWorkflow.values()].filter((row) => row.firmId === firmId)
      },
    },
    filings: {
      async create(row) {
        store.filingPackages.set(row.id, row)
      },
      async get(id) {
        return store.filingPackages.get(id) ?? null
      },
      async update(id, patch) {
        const current = store.filingPackages.get(id)
        if (!current) return null
        const next = { ...current, ...patch }
        store.filingPackages.set(id, next)
        return next
      },
      async listByFirm(firmId) {
        return [...store.filingPackages.values()].filter((row) => row.firmId === firmId)
      },
    },
    filingPacketArtifacts: {
      async upsert(row) {
        store.filingPacketArtifacts.set(row.id, row)
      },
      async get(id) {
        return store.filingPacketArtifacts.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingPacketArtifacts.values()].filter((row) => row.firmId === firmId)
      },
      async listByPackageId(packageId) {
        return [...store.filingPacketArtifacts.values()].filter((row) => row.packageId === packageId)
      },
    },
    filingDispatchQueue: {
      async upsert(row) {
        store.filingDispatchQueue.set(row.id, row)
      },
      async get(id) {
        return store.filingDispatchQueue.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingDispatchQueue.values()].filter((row) => row.firmId === firmId)
      },
      async listByPackageId(packageId) {
        return [...store.filingDispatchQueue.values()].filter((row) => row.packageId === packageId)
      },
    },
    filingAnnexures: {
      async upsert(row) {
        store.filingAnnexures.set(row.id, row)
      },
      async get(id) {
        return store.filingAnnexures.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingAnnexures.values()].filter((row) => row.firmId === firmId)
      },
      async listByPackageId(packageId) {
        return [...store.filingAnnexures.values()].filter((row) => row.packageId === packageId)
      },
    },
    filingSubmissionReceipts: {
      async upsert(row) {
        store.filingSubmissionReceipts.set(row.id, row)
      },
      async get(id) {
        return store.filingSubmissionReceipts.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingSubmissionReceipts.values()].filter((row) => row.firmId === firmId)
      },
      async listByPackageId(packageId) {
        return [...store.filingSubmissionReceipts.values()].filter((row) => row.packageId === packageId)
      },
    },
    filingSubmissionReconciliation: {
      async upsert(row) {
        store.filingSubmissionReconciliation.set(row.id, row)
      },
      async get(id) {
        return store.filingSubmissionReconciliation.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingSubmissionReconciliation.values()].filter((row) => row.firmId === firmId)
      },
      async listByPackageId(packageId) {
        return [...store.filingSubmissionReconciliation.values()].filter((row) => row.packageId === packageId)
      },
    },
    filingSubmissionExceptions: {
      async upsert(row) {
        store.filingSubmissionExceptions.set(row.id, row)
      },
      async get(id) {
        return store.filingSubmissionExceptions.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingSubmissionExceptions.values()].filter((row) => row.firmId === firmId)
      },
      async listByPackageId(packageId) {
        return [...store.filingSubmissionExceptions.values()].filter((row) => row.packageId === packageId)
      },
    },
    filingTransportExecutionEvidence: {
      async upsert(row) {
        store.filingTransportExecutionEvidence.set(row.id, row)
      },
      async get(id) {
        return store.filingTransportExecutionEvidence.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingTransportExecutionEvidence.values()].filter((row) => row.firmId === firmId)
      },
      async listByPackageId(packageId) {
        return [...store.filingTransportExecutionEvidence.values()].filter(
          (row) => row.packageId === packageId
        )
      },
    },
    filingSubmissionSlaDigests: {
      async upsert(row) {
        store.filingSubmissionSlaDigests.set(row.id, row)
      },
      async get(id) {
        return store.filingSubmissionSlaDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingSubmissionSlaDigests.values()].filter((row) => row.firmId === firmId)
      },
      async listByPackageId(packageId) {
        return [...store.filingSubmissionSlaDigests.values()].filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationOwnerRota: {
      async upsert(row) {
        store.filingEscalationOwnerRota.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationOwnerRota.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationOwnerRota.values()].filter((row) => row.firmId === firmId)
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationOwnerRota.values()].filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationWorkloadDigests: {
      async upsert(row) {
        store.filingEscalationWorkloadDigests.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationWorkloadDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationWorkloadDigests.values()].filter((row) => row.firmId === firmId)
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationWorkloadDigests.values()].filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationPolicyBaselines: {
      async upsert(row) {
        store.filingEscalationPolicyBaselines.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationPolicyBaselines.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationPolicyBaselines.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationPolicyBaselines.values()].filter(
          (row) => row.packageId === packageId
        )
      },
    },
    filingEscalationBreachWaivers: {
      async upsert(row) {
        store.filingEscalationBreachWaivers.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationBreachWaivers.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationBreachWaivers.values()].filter((row) => row.firmId === firmId)
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationBreachWaivers.values()].filter(
          (row) => row.packageId === packageId
        )
      },
    },
    filingEscalationPolicyVarianceDigests: {
      async upsert(row) {
        store.filingEscalationPolicyVarianceDigests.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationPolicyVarianceDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationPolicyVarianceDigests.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationPolicyVarianceDigests.values()].filter(
          (row) => row.packageId === packageId
        )
      },
    },
    filingEscalationWaiverExpiryDigests: {
      async upsert(row) {
        store.filingEscalationWaiverExpiryDigests.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationWaiverExpiryDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationWaiverExpiryDigests.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationWaiverExpiryDigests.values()].filter(
          (row) => row.packageId === packageId
        )
      },
    },
    filingEscalationVarianceRemediations: {
      async upsert(row) {
        store.filingEscalationVarianceRemediations.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationVarianceRemediations.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationVarianceRemediations.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationVarianceRemediations.values()].filter(
          (row) => row.packageId === packageId
        )
      },
    },
    filingEscalationWaiverRolloverAttestations: {
      async upsert(row) {
        store.filingEscalationWaiverRolloverAttestations.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationWaiverRolloverAttestations.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationWaiverRolloverAttestations.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationWaiverRolloverAttestations.values()].filter(
          (row) => row.packageId === packageId
        )
      },
    },
    filingEscalationRemediationExpiryDigests: {
      async upsert(row) {
        store.filingEscalationRemediationExpiryDigests.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationRemediationExpiryDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationRemediationExpiryDigests.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationRemediationExpiryDigests.values()].filter(
          (row) => row.packageId === packageId
        )
      },
    },
    filingEscalationRolloverBreachWatches: {
      async upsert(row) {
        store.filingEscalationRolloverBreachWatches.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationRolloverBreachWatches.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationRolloverBreachWatches.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationRolloverBreachWatches.values()].filter(
          (row) => row.packageId === packageId
        )
      },
    },
    filingEscalationRemediationLifecycles: {
      async upsert(row) {
        store.filingEscalationRemediationLifecycles.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationRemediationLifecycles.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationRemediationLifecycles.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationRemediationLifecycles.values()].filter(
          (row) => row.packageId === packageId
        )
      },
    },
    filingEscalationRolloverReaffirmationSlas: {
      async upsert(row) {
        store.filingEscalationRolloverReaffirmationSlas.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationRolloverReaffirmationSlas.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationRolloverReaffirmationSlas.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByPackageId(packageId) {
        return [...store.filingEscalationRolloverReaffirmationSlas.values()].filter(
          (row) => row.packageId === packageId
        )
      },
    },
    filingEscalationClosureComplianceDigests: {
      async upsert(row) {
        store.filingEscalationClosureComplianceDigests.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureComplianceDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureComplianceDigests.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureComplianceDigests.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
    },
    filingEscalationClosureFollowupQueues: {
      async upsert(row) {
        store.filingEscalationClosureFollowupQueues.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureFollowupQueues.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureFollowupQueues.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureFollowupQueues.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
    },
    filingEscalationClosureSlaWindowConfigs: {
      async upsert(row) {
        store.filingEscalationClosureSlaWindowConfigs.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureSlaWindowConfigs.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureSlaWindowConfigs.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureSlaWindowConfigs.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
    },
    filingEscalationClosureAutoAssignmentRules: {
      async upsert(row) {
        store.filingEscalationClosureAutoAssignmentRules.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureAutoAssignmentRules.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureAutoAssignmentRules.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureAutoAssignmentRules.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
    },
    filingEscalationClosureSlaWindows: {
      async upsert(row) {
        store.filingEscalationClosureSlaWindows.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureSlaWindows.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureSlaWindows.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureSlaWindows.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
    },
    filingEscalationClosureAttestations: {
      async upsert(row) {
        store.filingEscalationClosureAttestations.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureAttestations.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureAttestations.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureAttestations.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureAttestations.values()].filter(
          (row) => row.queueId === queueId
        )
      },
    },
    filingEscalationClosureSlaExceptionDigests: {
      async upsert(row) {
        store.filingEscalationClosureSlaExceptionDigests.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureSlaExceptionDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureSlaExceptionDigests.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureSlaExceptionDigests.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureSlaExceptionDigests.values()].filter(
          (row) => row.queueId === queueId
        )
      },
    },
    filingEscalationClosureAttestationDisputes: {
      async upsert(row) {
        store.filingEscalationClosureAttestationDisputes.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureAttestationDisputes.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureAttestationDisputes.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureAttestationDisputes.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureAttestationDisputes.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByAttestationId(attestationId) {
        return [...store.filingEscalationClosureAttestationDisputes.values()].filter(
          (row) => row.attestationId === attestationId
        )
      },
    },
    filingEscalationClosureSlaExceptionEnforcement: {
      async upsert(row) {
        store.filingEscalationClosureSlaExceptionEnforcement.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureSlaExceptionEnforcement.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureSlaExceptionEnforcement.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureSlaExceptionEnforcement.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureSlaExceptionEnforcement.values()].filter(
          (row) => row.queueId === queueId
        )
      },
    },
    filingEscalationClosureAdjudicationQueue: {
      async upsert(row) {
        store.filingEscalationClosureAdjudicationQueue.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureAdjudicationQueue.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureAdjudicationQueue.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureAdjudicationQueue.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureAdjudicationQueue.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByDisputeId(disputeId) {
        return [...store.filingEscalationClosureAdjudicationQueue.values()].filter(
          (row) => row.disputeId === disputeId
        )
      },
    },
    filingEscalationClosureEnforcementRebalance: {
      async upsert(row) {
        store.filingEscalationClosureEnforcementRebalance.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureEnforcementRebalance.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureEnforcementRebalance.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureEnforcementRebalance.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureEnforcementRebalance.values()].filter(
          (row) => row.queueId === queueId
        )
      },
    },
    filingEscalationClosureAdjudicationQuorum: {
      async upsert(row) {
        store.filingEscalationClosureAdjudicationQuorum.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureAdjudicationQuorum.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureAdjudicationQuorum.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureAdjudicationQuorum.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureAdjudicationQuorum.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByAdjudicationId(adjudicationId) {
        return [...store.filingEscalationClosureAdjudicationQuorum.values()].filter(
          (row) => row.adjudicationId === adjudicationId
        )
      },
    },
    filingEscalationClosureRebalanceExecution: {
      async upsert(row) {
        store.filingEscalationClosureRebalanceExecution.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureRebalanceExecution.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureRebalanceExecution.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureRebalanceExecution.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureRebalanceExecution.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByRebalanceId(rebalanceId) {
        return [...store.filingEscalationClosureRebalanceExecution.values()].filter(
          (row) => row.rebalanceId === rebalanceId
        )
      },
    },
    filingEscalationClosureAdjudicationSlo: {
      async upsert(row) {
        store.filingEscalationClosureAdjudicationSlo.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureAdjudicationSlo.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureAdjudicationSlo.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureAdjudicationSlo.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureAdjudicationSlo.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByAdjudicationId(adjudicationId) {
        return [...store.filingEscalationClosureAdjudicationSlo.values()].filter(
          (row) => row.adjudicationId === adjudicationId
        )
      },
    },
    filingEscalationClosureRebalanceSafeguards: {
      async upsert(row) {
        store.filingEscalationClosureRebalanceSafeguards.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureRebalanceSafeguards.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureRebalanceSafeguards.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureRebalanceSafeguards.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureRebalanceSafeguards.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByRebalanceId(rebalanceId) {
        return [...store.filingEscalationClosureRebalanceSafeguards.values()].filter(
          (row) => row.rebalanceId === rebalanceId
        )
      },
    },
    filingEscalationClosureAdjudicationSloDebtRemediation: {
      async upsert(row) {
        store.filingEscalationClosureAdjudicationSloDebtRemediation.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureAdjudicationSloDebtRemediation.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureAdjudicationSloDebtRemediation.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureAdjudicationSloDebtRemediation.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureAdjudicationSloDebtRemediation.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByAdjudicationId(adjudicationId) {
        return [...store.filingEscalationClosureAdjudicationSloDebtRemediation.values()].filter(
          (row) => row.adjudicationId === adjudicationId
        )
      },
    },
    filingEscalationClosureRebalanceSafeguardExpiry: {
      async upsert(row) {
        store.filingEscalationClosureRebalanceSafeguardExpiry.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureRebalanceSafeguardExpiry.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureRebalanceSafeguardExpiry.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureRebalanceSafeguardExpiry.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureRebalanceSafeguardExpiry.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByRebalanceId(rebalanceId) {
        return [...store.filingEscalationClosureRebalanceSafeguardExpiry.values()].filter(
          (row) => row.rebalanceId === rebalanceId
        )
      },
    },
    filingEscalationClosureAdjudicationDebtBurndown: {
      async upsert(row) {
        store.filingEscalationClosureAdjudicationDebtBurndown.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureAdjudicationDebtBurndown.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureAdjudicationDebtBurndown.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureAdjudicationDebtBurndown.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureAdjudicationDebtBurndown.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByAdjudicationId(adjudicationId) {
        return [...store.filingEscalationClosureAdjudicationDebtBurndown.values()].filter(
          (row) => row.adjudicationId === adjudicationId
        )
      },
    },
    filingEscalationClosureSafeguardExpiryAttestations: {
      async upsert(row) {
        store.filingEscalationClosureSafeguardExpiryAttestations.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureSafeguardExpiryAttestations.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureSafeguardExpiryAttestations.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureSafeguardExpiryAttestations.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureSafeguardExpiryAttestations.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByRebalanceId(rebalanceId) {
        return [...store.filingEscalationClosureSafeguardExpiryAttestations.values()].filter(
          (row) => row.rebalanceId === rebalanceId
        )
      },
    },
    filingEscalationClosureBurndownRecalibration: {
      async upsert(row) {
        store.filingEscalationClosureBurndownRecalibration.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureBurndownRecalibration.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureBurndownRecalibration.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureBurndownRecalibration.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureBurndownRecalibration.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByAdjudicationId(adjudicationId) {
        return [...store.filingEscalationClosureBurndownRecalibration.values()].filter(
          (row) => row.adjudicationId === adjudicationId
        )
      },
    },
    filingEscalationClosureExpiryAttestationQueue: {
      async upsert(row) {
        store.filingEscalationClosureExpiryAttestationQueue.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureExpiryAttestationQueue.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureExpiryAttestationQueue.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureExpiryAttestationQueue.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureExpiryAttestationQueue.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByRebalanceId(rebalanceId) {
        return [...store.filingEscalationClosureExpiryAttestationQueue.values()].filter(
          (row) => row.rebalanceId === rebalanceId
        )
      },
    },
    filingEscalationClosureBurndownSettlement: {
      async upsert(row) {
        store.filingEscalationClosureBurndownSettlement.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureBurndownSettlement.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureBurndownSettlement.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureBurndownSettlement.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureBurndownSettlement.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByAdjudicationId(adjudicationId) {
        return [...store.filingEscalationClosureBurndownSettlement.values()].filter(
          (row) => row.adjudicationId === adjudicationId
        )
      },
    },
    filingEscalationClosureExpiryAttestationQueueDrain: {
      async upsert(row) {
        store.filingEscalationClosureExpiryAttestationQueueDrain.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureExpiryAttestationQueueDrain.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureExpiryAttestationQueueDrain.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureExpiryAttestationQueueDrain.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureExpiryAttestationQueueDrain.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByRebalanceId(rebalanceId) {
        return [...store.filingEscalationClosureExpiryAttestationQueueDrain.values()].filter(
          (row) => row.rebalanceId === rebalanceId
        )
      },
    },
    filingEscalationClosureSettlementAttestation: {
      async upsert(row) {
        store.filingEscalationClosureSettlementAttestation.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureSettlementAttestation.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureSettlementAttestation.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureSettlementAttestation.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureSettlementAttestation.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByAdjudicationId(adjudicationId) {
        return [...store.filingEscalationClosureSettlementAttestation.values()].filter(
          (row) => row.adjudicationId === adjudicationId
        )
      },
    },
    filingEscalationClosureQueueDrainReconciliation: {
      async upsert(row) {
        store.filingEscalationClosureQueueDrainReconciliation.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureQueueDrainReconciliation.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureQueueDrainReconciliation.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureQueueDrainReconciliation.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureQueueDrainReconciliation.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByRebalanceId(rebalanceId) {
        return [...store.filingEscalationClosureQueueDrainReconciliation.values()].filter(
          (row) => row.rebalanceId === rebalanceId
        )
      },
    },
    jobs: {
      async create(row) {
        const existingIndex = store.jobs.findIndex((job) => job.id === row.id)
        if (existingIndex >= 0) {
          store.jobs[existingIndex] = row
          return
        }
        store.jobs.push(row)
      },
      async listByFirm(firmId) {
        return store.jobs.filter((job) => job.firmId === firmId)
      },
      async listByDocument(documentId) {
        return store.jobs.filter((job) => job.documentId === documentId)
      },
    },
    workflowEvents: {
      async append(row) {
        if (store.workflowEvents.some((event) => event.id === row.id)) return
        store.workflowEvents.push(row)
      },
      async listByFirm(firmId) {
        return store.workflowEvents.filter((event) => event.firmId === firmId)
      },
    },
    followUps: {
      async upsert(row) {
        const idx = store.followUps.findIndex((entry) => entry.id === row.id)
        if (idx >= 0) {
          store.followUps[idx] = row
          return
        }
        store.followUps.push(row)
      },
      async get(id) {
        return store.followUps.find((row) => row.id === id) ?? null
      },
      async listByFirm(firmId) {
        return store.followUps.filter((row) => row.firmId === firmId)
      },
    },
    intimations: {
      async upsert(row) {
        const idx = store.intimations.findIndex((entry) => entry.id === row.id)
        if (idx >= 0) {
          store.intimations[idx] = row
          return
        }
        store.intimations.push(row)
      },
      async get(id) {
        return store.intimations.find((row) => row.id === id) ?? null
      },
      async listByFirm(firmId) {
        return store.intimations.filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return store.intimations.filter((row) => row.matterId === matterId)
      },
    },
    audit: {
      async append(row) {
        if (row.id) {
          const idx = store.audit.findIndex((entry) => entry.id === row.id)
          if (idx >= 0) {
            store.audit[idx] = row
            return
          }
        }
        store.audit.push(row)
      },
      async listByFirm(firmId) {
        return store.audit.filter((row) => row.firmId === firmId)
      },
    },
    committeeOutputs: {
      async create(row) {
        store.committeeOutputs.set(row.id, row)
      },
      async get(id) {
        return store.committeeOutputs.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.committeeOutputs.values()].filter((row) => row.firmId === firmId)
      },
    },
    reportingIndex: {
      async upsert(row) {
        store.matterClientSearchIndex.set(row.id, row)
      },
      async get(id) {
        return store.matterClientSearchIndex.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.matterClientSearchIndex.values()].filter((row) => row.firmId === firmId)
      },
    },
    draftTemplateAnalytics: {
      async upsert(row) {
        store.draftTemplateAnalytics.set(row.id, row)
      },
      async get(id) {
        return store.draftTemplateAnalytics.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.draftTemplateAnalytics.values()].filter((row) => row.firmId === firmId)
      },
    },
    workflowOpsActivity: {
      async upsert(row) {
        store.workflowOpsActivity.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsActivity.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsActivity.values()].filter((row) => row.firmId === firmId)
      },
    },
  }
}
