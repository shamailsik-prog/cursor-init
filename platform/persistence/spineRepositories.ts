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
  FilingEscalationClosureSettlementArbitrationRow,
  FilingEscalationClosureQueueReentryComplianceRow,
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
  MatterReportExportAnalyticsRow,
  MatterReportRelevanceSnapshotRow,
  WorkflowOpsActivityRow,
  WorkflowOpsAlertDigestRow,
  WorkflowOpsAlertAttestationRow,
  WorkflowOpsAlertEscalationLedgerRow,
  WorkflowOpsAlertAttestationDisputeRow,
  WorkflowOpsAlertEscalationClosureRow,
  WorkflowOpsAlertDisputeEnforcementLedgerRow,
  WorkflowOpsAlertClosureDebtReconciliationDigestRow,
  WorkflowOpsAlertEnforcementAttestationRow,
  WorkflowOpsAlertClosureDebtVarianceDigestRow,
  WorkflowOpsAlertEnforcementWaiverLedgerRow,
  WorkflowOpsAlertVarianceRemediationQueueRow,
  WorkflowOpsAlertWaiverExpiryDigestRow,
  WorkflowOpsAlertVarianceRemediationSlaLedgerRow,
  WorkflowOpsAlertWaiverExpiryDisputeRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow,
  AuditEntry,
  CommitteeBrainOutput,
  TenancySessionReferenceRow,
  TenancyLineageDisputeAttestationRow,
  TenancyLineageArbitrationDebtRetirementLedgerRow,
  TenancyLineageClosureAdjudicationRow,
  TenancyLineageClosureAdjudicationSettlementRow,
  TenancyLineageArbitrationDebtRetirementDisputeLedgerRow,
  TenancyExternalSessionIdentityBridgeRow,
  TenancyLineageReconciliationDigestRow,
  TenancyLineageReconciliationQueueArbitrationRow,
  TenancyLineageDigestClosureCheckpointRow,
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

export type FilingEscalationClosureSettlementArbitrationRepository = {
  upsert(row: FilingEscalationClosureSettlementArbitrationRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureSettlementArbitrationRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureSettlementArbitrationRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureSettlementArbitrationRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureSettlementArbitrationRow[]>
  listByAdjudicationId(
    adjudicationId: string
  ): Promise<FilingEscalationClosureSettlementArbitrationRow[]>
}

export type FilingEscalationClosureQueueReentryComplianceRepository = {
  upsert(row: FilingEscalationClosureQueueReentryComplianceRow): Promise<void>
  get(id: string): Promise<FilingEscalationClosureQueueReentryComplianceRow | null>
  listByFirm(firmId: string): Promise<FilingEscalationClosureQueueReentryComplianceRow[]>
  listByOwnerId(ownerId: string): Promise<FilingEscalationClosureQueueReentryComplianceRow[]>
  listByQueueId(queueId: string): Promise<FilingEscalationClosureQueueReentryComplianceRow[]>
  listByRebalanceId(
    rebalanceId: string
  ): Promise<FilingEscalationClosureQueueReentryComplianceRow[]>
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

export type MatterReportExportAnalyticsRepository = {
  upsert(row: MatterReportExportAnalyticsRow): Promise<void>
  get(id: string): Promise<MatterReportExportAnalyticsRow | null>
  listByFirm(firmId: string): Promise<MatterReportExportAnalyticsRow[]>
  listByMatter(matterId: string): Promise<MatterReportExportAnalyticsRow[]>
}

export type MatterReportRelevanceSnapshotRepository = {
  upsert(row: MatterReportRelevanceSnapshotRow): Promise<void>
  get(id: string): Promise<MatterReportRelevanceSnapshotRow | null>
  listByFirm(firmId: string): Promise<MatterReportRelevanceSnapshotRow[]>
  listByMatter(matterId: string): Promise<MatterReportRelevanceSnapshotRow[]>
}

export type WorkflowOpsActivityRepository = {
  upsert(row: WorkflowOpsActivityRow): Promise<void>
  get(id: string): Promise<WorkflowOpsActivityRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsActivityRow[]>
}

export type WorkflowOpsAlertDigestRepository = {
  upsert(row: WorkflowOpsAlertDigestRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertDigestRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertDigestRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertDigestRow[]>
}

export type WorkflowOpsAlertAttestationRepository = {
  upsert(row: WorkflowOpsAlertAttestationRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertAttestationRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertAttestationRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertAttestationRow[]>
}

export type WorkflowOpsAlertEscalationLedgerRepository = {
  upsert(row: WorkflowOpsAlertEscalationLedgerRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertEscalationLedgerRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertEscalationLedgerRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertEscalationLedgerRow[]>
}

export type WorkflowOpsAlertAttestationDisputeRepository = {
  upsert(row: WorkflowOpsAlertAttestationDisputeRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertAttestationDisputeRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertAttestationDisputeRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertAttestationDisputeRow[]>
}

export type WorkflowOpsAlertEscalationClosureRepository = {
  upsert(row: WorkflowOpsAlertEscalationClosureRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertEscalationClosureRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertEscalationClosureRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertEscalationClosureRow[]>
}

export type WorkflowOpsAlertDisputeEnforcementLedgerRepository = {
  upsert(row: WorkflowOpsAlertDisputeEnforcementLedgerRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertDisputeEnforcementLedgerRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertDisputeEnforcementLedgerRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertDisputeEnforcementLedgerRow[]>
}

export type WorkflowOpsAlertClosureDebtReconciliationDigestRepository = {
  upsert(row: WorkflowOpsAlertClosureDebtReconciliationDigestRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertClosureDebtReconciliationDigestRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertClosureDebtReconciliationDigestRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertClosureDebtReconciliationDigestRow[]>
}

export type WorkflowOpsAlertEnforcementAttestationRepository = {
  upsert(row: WorkflowOpsAlertEnforcementAttestationRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertEnforcementAttestationRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertEnforcementAttestationRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertEnforcementAttestationRow[]>
}

export type WorkflowOpsAlertClosureDebtVarianceDigestRepository = {
  upsert(row: WorkflowOpsAlertClosureDebtVarianceDigestRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertClosureDebtVarianceDigestRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertClosureDebtVarianceDigestRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertClosureDebtVarianceDigestRow[]>
}

export type WorkflowOpsAlertEnforcementWaiverLedgerRepository = {
  upsert(row: WorkflowOpsAlertEnforcementWaiverLedgerRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertEnforcementWaiverLedgerRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertEnforcementWaiverLedgerRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertEnforcementWaiverLedgerRow[]>
}

export type WorkflowOpsAlertVarianceRemediationQueueRepository = {
  upsert(row: WorkflowOpsAlertVarianceRemediationQueueRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertVarianceRemediationQueueRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertVarianceRemediationQueueRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertVarianceRemediationQueueRow[]>
}

export type WorkflowOpsAlertWaiverExpiryDigestRepository = {
  upsert(row: WorkflowOpsAlertWaiverExpiryDigestRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertWaiverExpiryDigestRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertWaiverExpiryDigestRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertWaiverExpiryDigestRow[]>
}

export type WorkflowOpsAlertVarianceRemediationSlaLedgerRepository = {
  upsert(row: WorkflowOpsAlertVarianceRemediationSlaLedgerRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertVarianceRemediationSlaLedgerRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertVarianceRemediationSlaLedgerRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertVarianceRemediationSlaLedgerRow[]>
}

export type WorkflowOpsAlertWaiverExpiryDisputeRepository = {
  upsert(row: WorkflowOpsAlertWaiverExpiryDisputeRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertWaiverExpiryDisputeRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertWaiverExpiryDisputeRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertWaiverExpiryDisputeRow[]>
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRepository = {
  upsert(row: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow[]>
}

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRepository = {
  upsert(row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow[]>
  listByMatter(matterId: string): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow[]>
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRepository = {
  upsert(row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow | null>
  listByFirm(
    firmId: string
  ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow[]>
  listByMatter(
    matterId: string
  ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow[]>
}

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRepository = {
  upsert(row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow | null>
  listByFirm(firmId: string): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow[]>
  listByMatter(
    matterId: string
  ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow[]>
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow | null>
    listByFirm(
      firmId: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow[]>
    listByMatter(
      matterId: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow[]>
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRepository = {
  upsert(row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow | null>
  listByFirm(
    firmId: string
  ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow[]>
  listByMatter(
    matterId: string
  ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow[]>
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRepository = {
  upsert(row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow | null>
  listByFirm(
    firmId: string
  ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow[]>
  listByMatter(
    matterId: string
  ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow[]>
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRepository = {
  upsert(row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow): Promise<void>
  get(id: string): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow | null>
  listByFirm(
    firmId: string
  ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow[]>
  listByMatter(
    matterId: string
  ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow[]>
}

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow | null>
    listByFirm(
      firmId: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow[]>
    listByMatter(
      matterId: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow[]>
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow | null>
    listByFirm(
      firmId: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow[]>
    listByMatter(
      matterId: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow[]>
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow[]
    >
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow[]
    >
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow[]
    >
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow[]
    >
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow[]
    >
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow[]
    >
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow[]
    >
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow[]
    >
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow[]
    >
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow[]
    >
  }

export type WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRepository =
  {
    upsert(
      row: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow[]
    >
  }

export type WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRepository =
  {
    upsert(
      row: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow
    ): Promise<void>
    get(
      id: string
    ): Promise<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow | null>
    listByFirm(
      firmId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow[]
    >
    listByMatter(
      matterId: string
    ): Promise<
      WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow[]
    >
  }

export type TenancySessionReferenceRepository = {
  upsert(row: TenancySessionReferenceRow): Promise<void>
  get(id: string): Promise<TenancySessionReferenceRow | null>
  listByFirm(firmId: string): Promise<TenancySessionReferenceRow[]>
  listByUserId(userId: string): Promise<TenancySessionReferenceRow[]>
}

export type TenancyLineageDisputeAttestationRepository = {
  upsert(row: TenancyLineageDisputeAttestationRow): Promise<void>
  get(id: string): Promise<TenancyLineageDisputeAttestationRow | null>
  listByFirm(firmId: string): Promise<TenancyLineageDisputeAttestationRow[]>
  listByLineageRoot(
    lineageRootSessionReferenceId: string
  ): Promise<TenancyLineageDisputeAttestationRow[]>
}

export type TenancyLineageReconciliationDigestRepository = {
  upsert(row: TenancyLineageReconciliationDigestRow): Promise<void>
  get(id: string): Promise<TenancyLineageReconciliationDigestRow | null>
  listByFirm(firmId: string): Promise<TenancyLineageReconciliationDigestRow[]>
}

export type TenancyLineageReconciliationQueueArbitrationRepository = {
  upsert(row: TenancyLineageReconciliationQueueArbitrationRow): Promise<void>
  get(id: string): Promise<TenancyLineageReconciliationQueueArbitrationRow | null>
  listByFirm(firmId: string): Promise<TenancyLineageReconciliationQueueArbitrationRow[]>
  listByLineageRoot(
    lineageRootSessionReferenceId: string
  ): Promise<TenancyLineageReconciliationQueueArbitrationRow[]>
}

export type TenancyLineageDigestClosureCheckpointRepository = {
  upsert(row: TenancyLineageDigestClosureCheckpointRow): Promise<void>
  get(id: string): Promise<TenancyLineageDigestClosureCheckpointRow | null>
  listByFirm(firmId: string): Promise<TenancyLineageDigestClosureCheckpointRow[]>
  listByLineageRoot(
    lineageRootSessionReferenceId: string
  ): Promise<TenancyLineageDigestClosureCheckpointRow[]>
}

export type TenancyLineageClosureAdjudicationRepository = {
  upsert(row: TenancyLineageClosureAdjudicationRow): Promise<void>
  get(id: string): Promise<TenancyLineageClosureAdjudicationRow | null>
  listByFirm(firmId: string): Promise<TenancyLineageClosureAdjudicationRow[]>
  listByLineageRoot(
    lineageRootSessionReferenceId: string
  ): Promise<TenancyLineageClosureAdjudicationRow[]>
}

export type TenancyLineageArbitrationDebtRetirementLedgerRepository = {
  upsert(row: TenancyLineageArbitrationDebtRetirementLedgerRow): Promise<void>
  get(id: string): Promise<TenancyLineageArbitrationDebtRetirementLedgerRow | null>
  listByFirm(firmId: string): Promise<TenancyLineageArbitrationDebtRetirementLedgerRow[]>
  listByLineageRoot(
    lineageRootSessionReferenceId: string
  ): Promise<TenancyLineageArbitrationDebtRetirementLedgerRow[]>
}

export type TenancyLineageClosureAdjudicationSettlementRepository = {
  upsert(row: TenancyLineageClosureAdjudicationSettlementRow): Promise<void>
  get(id: string): Promise<TenancyLineageClosureAdjudicationSettlementRow | null>
  listByFirm(firmId: string): Promise<TenancyLineageClosureAdjudicationSettlementRow[]>
  listByLineageRoot(
    lineageRootSessionReferenceId: string
  ): Promise<TenancyLineageClosureAdjudicationSettlementRow[]>
}

export type TenancyLineageArbitrationDebtRetirementDisputeLedgerRepository = {
  upsert(row: TenancyLineageArbitrationDebtRetirementDisputeLedgerRow): Promise<void>
  get(id: string): Promise<TenancyLineageArbitrationDebtRetirementDisputeLedgerRow | null>
  listByFirm(firmId: string): Promise<TenancyLineageArbitrationDebtRetirementDisputeLedgerRow[]>
  listByLineageRoot(
    lineageRootSessionReferenceId: string
  ): Promise<TenancyLineageArbitrationDebtRetirementDisputeLedgerRow[]>
}

export type TenancyExternalSessionIdentityBridgeRepository = {
  upsert(row: TenancyExternalSessionIdentityBridgeRow): Promise<void>
  get(id: string): Promise<TenancyExternalSessionIdentityBridgeRow | null>
  listByFirm(firmId: string): Promise<TenancyExternalSessionIdentityBridgeRow[]>
  listByLineageRoot(lineageRootSessionReferenceId: string): Promise<TenancyExternalSessionIdentityBridgeRow[]>
  listBySessionReference(sessionReferenceId: string): Promise<TenancyExternalSessionIdentityBridgeRow[]>
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
  filingEscalationClosureSettlementArbitration: FilingEscalationClosureSettlementArbitrationRepository
  filingEscalationClosureQueueReentryCompliance: FilingEscalationClosureQueueReentryComplianceRepository
  jobs: JobRepository
  workflowEvents: WorkflowEventRepository
  followUps: FollowUpRepository
  intimations: IntimationRepository
  audit: AuditRepository
  committeeOutputs: CommitteeBrainOutputRepository
  reportingIndex: MatterClientSearchIndexRepository
  draftTemplateAnalytics: DraftTemplateAnalyticsRepository
  matterReportExportAnalytics: MatterReportExportAnalyticsRepository
  matterReportRelevanceSnapshots: MatterReportRelevanceSnapshotRepository
  workflowOpsActivity: WorkflowOpsActivityRepository
  workflowOpsAlertDigests: WorkflowOpsAlertDigestRepository
  workflowOpsAlertAttestations: WorkflowOpsAlertAttestationRepository
  workflowOpsAlertEscalationLedgers: WorkflowOpsAlertEscalationLedgerRepository
  workflowOpsAlertAttestationDisputes: WorkflowOpsAlertAttestationDisputeRepository
  workflowOpsAlertEscalationClosures: WorkflowOpsAlertEscalationClosureRepository
  workflowOpsAlertDisputeEnforcementLedgers: WorkflowOpsAlertDisputeEnforcementLedgerRepository
  workflowOpsAlertClosureDebtReconciliationDigests: WorkflowOpsAlertClosureDebtReconciliationDigestRepository
  workflowOpsAlertEnforcementAttestations: WorkflowOpsAlertEnforcementAttestationRepository
  workflowOpsAlertClosureDebtVarianceDigests: WorkflowOpsAlertClosureDebtVarianceDigestRepository
  workflowOpsAlertEnforcementWaiverLedgers: WorkflowOpsAlertEnforcementWaiverLedgerRepository
  workflowOpsAlertVarianceRemediationQueues: WorkflowOpsAlertVarianceRemediationQueueRepository
  workflowOpsAlertWaiverExpiryDigests: WorkflowOpsAlertWaiverExpiryDigestRepository
  workflowOpsAlertVarianceRemediationSlaLedgers: WorkflowOpsAlertVarianceRemediationSlaLedgerRepository
  workflowOpsAlertWaiverExpiryDisputes: WorkflowOpsAlertWaiverExpiryDisputeRepository
  workflowOpsAlertVarianceRemediationSlaBreachEscalations: WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudications: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlements: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrains: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestations: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrations: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliances: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizations: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirements: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernances: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgers: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerifications: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestations: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExports: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgers: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceipts: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffs: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgments: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgments: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliations: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRepository
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers: WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRepository
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations: WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRepository
  tenancySessionReferences: TenancySessionReferenceRepository
  tenancyLineageDisputeAttestations: TenancyLineageDisputeAttestationRepository
  tenancyLineageReconciliationDigests: TenancyLineageReconciliationDigestRepository
  tenancyLineageReconciliationQueueArbitrations: TenancyLineageReconciliationQueueArbitrationRepository
  tenancyLineageDigestClosureCheckpoints: TenancyLineageDigestClosureCheckpointRepository
  tenancyLineageClosureAdjudications: TenancyLineageClosureAdjudicationRepository
  tenancyLineageArbitrationDebtRetirementLedgers: TenancyLineageArbitrationDebtRetirementLedgerRepository
  tenancyLineageClosureAdjudicationSettlements: TenancyLineageClosureAdjudicationSettlementRepository
  tenancyLineageArbitrationDebtRetirementDisputeLedgers: TenancyLineageArbitrationDebtRetirementDisputeLedgerRepository
  tenancyExternalSessionIdentityBridges: TenancyExternalSessionIdentityBridgeRepository
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
    filingEscalationClosureSettlementArbitration: {
      async upsert(row) {
        store.filingEscalationClosureSettlementArbitration.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureSettlementArbitration.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureSettlementArbitration.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureSettlementArbitration.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureSettlementArbitration.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByAdjudicationId(adjudicationId) {
        return [...store.filingEscalationClosureSettlementArbitration.values()].filter(
          (row) => row.adjudicationId === adjudicationId
        )
      },
    },
    filingEscalationClosureQueueReentryCompliance: {
      async upsert(row) {
        store.filingEscalationClosureQueueReentryCompliance.set(row.id, row)
      },
      async get(id) {
        return store.filingEscalationClosureQueueReentryCompliance.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.filingEscalationClosureQueueReentryCompliance.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByOwnerId(ownerId) {
        return [...store.filingEscalationClosureQueueReentryCompliance.values()].filter(
          (row) => row.ownerId === ownerId
        )
      },
      async listByQueueId(queueId) {
        return [...store.filingEscalationClosureQueueReentryCompliance.values()].filter(
          (row) => row.queueId === queueId
        )
      },
      async listByRebalanceId(rebalanceId) {
        return [...store.filingEscalationClosureQueueReentryCompliance.values()].filter(
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
    matterReportExportAnalytics: {
      async upsert(row) {
        store.matterReportExportAnalytics.set(row.id, row)
      },
      async get(id) {
        return store.matterReportExportAnalytics.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.matterReportExportAnalytics.values()].filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return [...store.matterReportExportAnalytics.values()].filter((row) => row.matterId === matterId)
      },
    },
    matterReportRelevanceSnapshots: {
      async upsert(row) {
        store.matterReportRelevanceSnapshots.set(row.id, row)
      },
      async get(id) {
        return store.matterReportRelevanceSnapshots.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.matterReportRelevanceSnapshots.values()].filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return [...store.matterReportRelevanceSnapshots.values()].filter((row) => row.matterId === matterId)
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
    workflowOpsAlertDigests: {
      async upsert(row) {
        store.workflowOpsAlertDigests.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertDigests.values()].filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertDigests.values()].filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertAttestations: {
      async upsert(row) {
        store.workflowOpsAlertAttestations.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertAttestations.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertAttestations.values()].filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertAttestations.values()].filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertEscalationLedgers: {
      async upsert(row) {
        store.workflowOpsAlertEscalationLedgers.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertEscalationLedgers.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertEscalationLedgers.values()].filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertEscalationLedgers.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertAttestationDisputes: {
      async upsert(row) {
        store.workflowOpsAlertAttestationDisputes.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertAttestationDisputes.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertAttestationDisputes.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertAttestationDisputes.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertEscalationClosures: {
      async upsert(row) {
        store.workflowOpsAlertEscalationClosures.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertEscalationClosures.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertEscalationClosures.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertEscalationClosures.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertDisputeEnforcementLedgers: {
      async upsert(row) {
        store.workflowOpsAlertDisputeEnforcementLedgers.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertDisputeEnforcementLedgers.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertDisputeEnforcementLedgers.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertDisputeEnforcementLedgers.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertClosureDebtReconciliationDigests: {
      async upsert(row) {
        store.workflowOpsAlertClosureDebtReconciliationDigests.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertClosureDebtReconciliationDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertClosureDebtReconciliationDigests.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertClosureDebtReconciliationDigests.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertEnforcementAttestations: {
      async upsert(row) {
        store.workflowOpsAlertEnforcementAttestations.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertEnforcementAttestations.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertEnforcementAttestations.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertEnforcementAttestations.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertClosureDebtVarianceDigests: {
      async upsert(row) {
        store.workflowOpsAlertClosureDebtVarianceDigests.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertClosureDebtVarianceDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertClosureDebtVarianceDigests.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertClosureDebtVarianceDigests.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertEnforcementWaiverLedgers: {
      async upsert(row) {
        store.workflowOpsAlertEnforcementWaiverLedgers.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertEnforcementWaiverLedgers.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertEnforcementWaiverLedgers.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertEnforcementWaiverLedgers.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertVarianceRemediationQueues: {
      async upsert(row) {
        store.workflowOpsAlertVarianceRemediationQueues.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertVarianceRemediationQueues.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertVarianceRemediationQueues.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertVarianceRemediationQueues.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertWaiverExpiryDigests: {
      async upsert(row) {
        store.workflowOpsAlertWaiverExpiryDigests.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertWaiverExpiryDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertWaiverExpiryDigests.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertWaiverExpiryDigests.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertVarianceRemediationSlaLedgers: {
      async upsert(row) {
        store.workflowOpsAlertVarianceRemediationSlaLedgers.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertVarianceRemediationSlaLedgers.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertVarianceRemediationSlaLedgers.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertVarianceRemediationSlaLedgers.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertWaiverExpiryDisputes: {
      async upsert(row) {
        store.workflowOpsAlertWaiverExpiryDisputes.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertWaiverExpiryDisputes.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertWaiverExpiryDisputes.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertWaiverExpiryDisputes.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachEscalations: {
      async upsert(row) {
        store.workflowOpsAlertVarianceRemediationSlaBreachEscalations.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertVarianceRemediationSlaBreachEscalations.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertVarianceRemediationSlaBreachEscalations.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertVarianceRemediationSlaBreachEscalations.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudications: {
      async upsert(row) {
        store.workflowOpsAlertWaiverExpiryDisputeAdjudications.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertWaiverExpiryDisputeAdjudications.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertWaiverExpiryDisputeAdjudications.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertWaiverExpiryDisputeAdjudications.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints: {
      async upsert(row) {
        store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships: {
      async upsert(row) {
        store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations: {
      async upsert(row) {
        store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.set(
          row.id,
          row
        )
      },
      async get(id) {
        return (
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.get(
            id
          ) ?? null
        )
      },
      async listByFirm(firmId) {
        return [
          ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.values(),
        ].filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return [
          ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations.values(),
        ].filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations: {
      async upsert(row) {
        store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns: {
      async upsert(row) {
        store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByMatter(matterId) {
        return [...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns.values()].filter(
          (row) => row.matterId === matterId
        )
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlements: {
      async upsert(row) {
        store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlements.set(row.id, row)
      },
      async get(id) {
        return store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlements.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [
          ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlements.values(),
        ].filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return [
          ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlements.values(),
        ].filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrains: {
      async upsert(row) {
        store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrains.set(
          row.id,
          row
        )
      },
      async get(id) {
        return (
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrains.get(
            id
          ) ?? null
        )
      },
      async listByFirm(firmId) {
        return [
          ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrains.values(),
        ].filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return [
          ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrains.values(),
        ].filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestations: {
      async upsert(row) {
        store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestations.set(
          row.id,
          row
        )
      },
      async get(id) {
        return (
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestations.get(
            id
          ) ?? null
        )
      },
      async listByFirm(firmId) {
        return [
          ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestations.values(),
        ].filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return [
          ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestations.values(),
        ].filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliations:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliations.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliations.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliations.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliations.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrations: {
      async upsert(row) {
        store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrations.set(
          row.id,
          row
        )
      },
      async get(id) {
        return (
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrations.get(
            id
          ) ?? null
        )
      },
      async listByFirm(firmId) {
        return [
          ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrations.values(),
        ].filter((row) => row.firmId === firmId)
      },
      async listByMatter(matterId) {
        return [
          ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrations.values(),
        ].filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliances:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliances.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliances.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliances.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliances.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizations:
      {
        async upsert(row) {
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizations.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizations.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizations.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizations.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirements:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirements.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirements.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirements.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirements.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernances:
      {
        async upsert(row) {
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernances.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernances.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernances.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernances.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliations:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliations.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliations.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliations.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliations.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgers:
      {
        async upsert(row) {
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgers.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgers.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgers.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgers.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerifications:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerifications.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerifications.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerifications.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerifications.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestations:
      {
        async upsert(row) {
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestations.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestations.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestations.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestations.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExports:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExports.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExports.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExports.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExports.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgers:
      {
        async upsert(row) {
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgers.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgers.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgers.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgers.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceipts:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceipts.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceipts.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceipts.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceipts.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        async upsert(row) {
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliations:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliations.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliations.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliations.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliations.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffs:
      {
        async upsert(row) {
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffs.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffs.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffs.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffs.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestations:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestations.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestations.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestations.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestations.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgments:
      {
        async upsert(row) {
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgments.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgments.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgments.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgments.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgments:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgments.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgments.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgments.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgments.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliations:
      {
        async upsert(row) {
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliations.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliations.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliations.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliations.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliations:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliations.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliations.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliations.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliations.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers:
      {
        async upsert(row) {
          store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations:
      {
        async upsert(row) {
          store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations.set(
            row.id,
            row
          )
        },
        async get(id) {
          return (
            store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations.get(
              id
            ) ?? null
          )
        },
        async listByFirm(firmId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations.values(),
          ].filter((row) => row.firmId === firmId)
        },
        async listByMatter(matterId) {
          return [
            ...store.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations.values(),
          ].filter((row) => row.matterId === matterId)
        },
      },
    tenancySessionReferences: {
      async upsert(row) {
        store.tenancySessionReferences.set(row.id, row)
      },
      async get(id) {
        return store.tenancySessionReferences.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.tenancySessionReferences.values()].filter((row) => row.firmId === firmId)
      },
      async listByUserId(userId) {
        return [...store.tenancySessionReferences.values()].filter((row) => row.userId === userId)
      },
    },
    tenancyLineageDisputeAttestations: {
      async upsert(row) {
        store.tenancyLineageDisputeAttestations.set(row.id, row)
      },
      async get(id) {
        return store.tenancyLineageDisputeAttestations.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.tenancyLineageDisputeAttestations.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        return [...store.tenancyLineageDisputeAttestations.values()].filter(
          (row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        )
      },
    },
    tenancyLineageReconciliationDigests: {
      async upsert(row) {
        store.tenancyLineageReconciliationDigests.set(row.id, row)
      },
      async get(id) {
        return store.tenancyLineageReconciliationDigests.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.tenancyLineageReconciliationDigests.values()].filter(
          (row) => row.firmId === firmId
        )
      },
    },
    tenancyLineageReconciliationQueueArbitrations: {
      async upsert(row) {
        store.tenancyLineageReconciliationQueueArbitrations.set(row.id, row)
      },
      async get(id) {
        return store.tenancyLineageReconciliationQueueArbitrations.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.tenancyLineageReconciliationQueueArbitrations.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        return [...store.tenancyLineageReconciliationQueueArbitrations.values()].filter(
          (row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        )
      },
    },
    tenancyLineageDigestClosureCheckpoints: {
      async upsert(row) {
        store.tenancyLineageDigestClosureCheckpoints.set(row.id, row)
      },
      async get(id) {
        return store.tenancyLineageDigestClosureCheckpoints.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.tenancyLineageDigestClosureCheckpoints.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        return [...store.tenancyLineageDigestClosureCheckpoints.values()].filter(
          (row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        )
      },
    },
    tenancyLineageClosureAdjudications: {
      async upsert(row) {
        store.tenancyLineageClosureAdjudications.set(row.id, row)
      },
      async get(id) {
        return store.tenancyLineageClosureAdjudications.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.tenancyLineageClosureAdjudications.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        return [...store.tenancyLineageClosureAdjudications.values()].filter(
          (row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        )
      },
    },
    tenancyLineageArbitrationDebtRetirementLedgers: {
      async upsert(row) {
        store.tenancyLineageArbitrationDebtRetirementLedgers.set(row.id, row)
      },
      async get(id) {
        return store.tenancyLineageArbitrationDebtRetirementLedgers.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.tenancyLineageArbitrationDebtRetirementLedgers.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        return [...store.tenancyLineageArbitrationDebtRetirementLedgers.values()].filter(
          (row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        )
      },
    },
    tenancyLineageClosureAdjudicationSettlements: {
      async upsert(row) {
        store.tenancyLineageClosureAdjudicationSettlements.set(row.id, row)
      },
      async get(id) {
        return store.tenancyLineageClosureAdjudicationSettlements.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.tenancyLineageClosureAdjudicationSettlements.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        return [...store.tenancyLineageClosureAdjudicationSettlements.values()].filter(
          (row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        )
      },
    },
    tenancyLineageArbitrationDebtRetirementDisputeLedgers: {
      async upsert(row) {
        store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.set(row.id, row)
      },
      async get(id) {
        return store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        return [...store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.values()].filter(
          (row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        )
      },
    },
    tenancyExternalSessionIdentityBridges: {
      async upsert(row) {
        store.tenancyExternalSessionIdentityBridges.set(row.id, row)
      },
      async get(id) {
        return store.tenancyExternalSessionIdentityBridges.get(id) ?? null
      },
      async listByFirm(firmId) {
        return [...store.tenancyExternalSessionIdentityBridges.values()].filter(
          (row) => row.firmId === firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        return [...store.tenancyExternalSessionIdentityBridges.values()].filter(
          (row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId
        )
      },
      async listBySessionReference(sessionReferenceId) {
        return [...store.tenancyExternalSessionIdentityBridges.values()].filter(
          (row) => row.sessionReferenceId === sessionReferenceId
        )
      },
    },
  }
}
