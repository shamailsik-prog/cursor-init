import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  type Firestore,
} from "firebase/firestore"
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
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow,
  WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentRow,
  WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow,
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
} from "@/platform/spine/store"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import { createDenyByDefaultWorkflowOpsRepositoryBinder } from "@/platform/persistence/denyByDefaultWorkflowOpsRepository"

async function setById<T extends { id: string }>(db: Firestore, collectionName: string, row: T) {
  await setDoc(doc(db, collectionName, row.id), row)
}

async function getById<T>(db: Firestore, collectionName: string, id: string): Promise<T | null> {
  const snap = await getDoc(doc(db, collectionName, id))
  if (!snap.exists()) return null
  return snap.data() as T
}

async function updateById<T>(
  db: Firestore,
  collectionName: string,
  id: string,
  patch: Partial<T>
): Promise<T | null> {
  const ref = doc(db, collectionName, id)
  const current = await getDoc(ref)
  if (!current.exists()) return null
  await updateDoc(ref, patch as Record<string, unknown>)
  const next = await getDoc(ref)
  return next.exists() ? (next.data() as T) : null
}

async function listByFirm<T extends { firmId: string }>(
  db: Firestore,
  collectionName: string,
  firmId: string
): Promise<T[]> {
  const snap = await getDocs(collection(db, collectionName))
  return snap.docs
    .map((row) => row.data() as T)
    .filter((row) => row.firmId === firmId)
}

export function createFirestoreRepositories(db: Firestore): SpineRepositories {
  const createDenyByDefaultWorkflowOpsRepository =
    createDenyByDefaultWorkflowOpsRepositoryBinder(db)
  return {
    matters: {
      async create(row) {
        await setById(db, "matters", row)
      },
      async get(id) {
        return getById<Matter>(db, "matters", id)
      },
      async update(id, patch) {
        return updateById<Matter>(db, "matters", id, patch)
      },
      async listByFirm(firmId) {
        return listByFirm<Matter>(db, "matters", firmId)
      },
    },
    users: {
      async upsert(row) {
        await setById(db, "users", row)
      },
      async get(id) {
        return getById<User>(db, "users", id)
      },
      async listByFirm(firmId) {
        return listByFirm<User>(db, "users", firmId)
      },
    },
    entities: {
      async create(row) {
        await setById(db, "entities", row)
      },
      async get(id) {
        return getById<Entity>(db, "entities", id)
      },
      async listByFirm(firmId) {
        return listByFirm<Entity>(db, "entities", firmId)
      },
    },
    entityLinks: {
      async upsert(row) {
        const key = `${row.firmId}_${row.leftId}_${row.rightId}_${row.identityBasis}`
        await setDoc(doc(db, "merge_events", key), row)
      },
      async listByFirm(firmId) {
        const rows = await listByFirm<Record<string, unknown> & { firmId: string }>(
          db,
          "merge_events",
          firmId
        )
        return rows
          .filter(
            (row) =>
              typeof row.leftId === "string" &&
              typeof row.rightId === "string" &&
              row.identityBasis === "cnic" &&
              row.band === "confirmed-candidate" &&
              typeof row.score === "number"
          )
          .map(
            (row) =>
              ({
                firmId: row.firmId,
                leftId: row.leftId,
                rightId: row.rightId,
                identityBasis: row.identityBasis,
                band: row.band,
                score: row.score,
              }) as EntityLink
          )
      },
    },
    members: {
      async upsert(row) {
        const key = `${row.matterId}_${row.userId}`
        await setDoc(doc(db, "matter_members", key), row)
      },
      async get(matterId, userId) {
        const key = `${matterId}_${userId}`
        return getById<MatterMember>(db, "matter_members", key)
      },
      async listByFirm(firmId) {
        return listByFirm<MatterMember>(db, "matter_members", firmId)
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "matter_members"))
        return rows.docs
          .map((entry) => entry.data() as MatterMember)
          .filter((row) => row.matterId === matterId)
      },
    },
    documents: {
      async create(row) {
        await setById(db, "documents", row)
      },
      async get(id) {
        return getById<DocumentRecord>(db, "documents", id)
      },
      async update(id, patch) {
        return updateById<DocumentRecord>(db, "documents", id, patch)
      },
      async listByFirm(firmId) {
        return listByFirm<DocumentRecord>(db, "documents", firmId)
      },
    },
    drafts: {
      async create(row) {
        await setById(db, "drafts", row)
      },
      async get(id) {
        return getById<DraftRecord>(db, "drafts", id)
      },
      async listByFirm(firmId) {
        return listByFirm<DraftRecord>(db, "drafts", firmId)
      },
    },
    workflow: {
      async createOrUpdate(row) {
        await setDoc(doc(db, "document_workflow", row.documentId), row)
      },
      async get(documentId) {
        return getById<DocumentWorkflow>(db, "document_workflow", documentId)
      },
      async listByFirm(firmId) {
        return listByFirm<DocumentWorkflow>(db, "document_workflow", firmId)
      },
    },
    filings: {
      async create(row) {
        await setById(db, "filing_packages", row)
      },
      async get(id) {
        return getById<FilingPackage>(db, "filing_packages", id)
      },
      async update(id, patch) {
        return updateById<FilingPackage>(db, "filing_packages", id, patch)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingPackage>(db, "filing_packages", firmId)
      },
    },
    filingPacketArtifacts: {
      async upsert(row) {
        await setDoc(doc(db, "filing_packet_artifacts", row.id), row)
      },
      async get(id) {
        return getById<FilingPacketArtifactRow>(db, "filing_packet_artifacts", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingPacketArtifactRow>(db, "filing_packet_artifacts", firmId)
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_packet_artifacts"))
        return rows.docs
          .map((entry) => entry.data() as FilingPacketArtifactRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingDispatchQueue: {
      async upsert(row) {
        await setDoc(doc(db, "filing_submission_dispatch_queue", row.id), row)
      },
      async get(id) {
        return getById<FilingDispatchQueueRow>(db, "filing_submission_dispatch_queue", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingDispatchQueueRow>(db, "filing_submission_dispatch_queue", firmId)
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_submission_dispatch_queue"))
        return rows.docs
          .map((entry) => entry.data() as FilingDispatchQueueRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingAnnexures: {
      async upsert(row) {
        await setDoc(doc(db, "filing_annexures", row.id), row)
      },
      async get(id) {
        return getById<FilingAnnexureRow>(db, "filing_annexures", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingAnnexureRow>(db, "filing_annexures", firmId)
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_annexures"))
        return rows.docs
          .map((entry) => entry.data() as FilingAnnexureRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingSubmissionReceipts: {
      async upsert(row) {
        await setDoc(doc(db, "filing_submission_receipts", row.id), row)
      },
      async get(id) {
        return getById<FilingSubmissionReceiptRow>(db, "filing_submission_receipts", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingSubmissionReceiptRow>(db, "filing_submission_receipts", firmId)
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_submission_receipts"))
        return rows.docs
          .map((entry) => entry.data() as FilingSubmissionReceiptRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingSubmissionReconciliation: {
      async upsert(row) {
        await setDoc(doc(db, "filing_submission_reconciliation", row.id), row)
      },
      async get(id) {
        return getById<FilingSubmissionReconciliationRow>(
          db,
          "filing_submission_reconciliation",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingSubmissionReconciliationRow>(
          db,
          "filing_submission_reconciliation",
          firmId
        )
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_submission_reconciliation"))
        return rows.docs
          .map((entry) => entry.data() as FilingSubmissionReconciliationRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingSubmissionExceptions: {
      async upsert(row) {
        await setDoc(doc(db, "filing_submission_exceptions", row.id), row)
      },
      async get(id) {
        return getById<FilingSubmissionExceptionRow>(db, "filing_submission_exceptions", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingSubmissionExceptionRow>(db, "filing_submission_exceptions", firmId)
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_submission_exceptions"))
        return rows.docs
          .map((entry) => entry.data() as FilingSubmissionExceptionRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingTransportExecutionEvidence: {
      async upsert(row) {
        await setDoc(doc(db, "filing_transport_execution_evidence", row.id), row)
      },
      async get(id) {
        return getById<FilingTransportExecutionEvidenceRow>(db, "filing_transport_execution_evidence", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingTransportExecutionEvidenceRow>(db, "filing_transport_execution_evidence", firmId)
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_transport_execution_evidence"))
        return rows.docs
          .map((entry) => entry.data() as FilingTransportExecutionEvidenceRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingSubmissionSlaDigests: {
      async upsert(row) {
        await setDoc(doc(db, "filing_submission_sla_digests", row.id), row)
      },
      async get(id) {
        return getById<FilingSubmissionSlaDigestRow>(db, "filing_submission_sla_digests", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingSubmissionSlaDigestRow>(db, "filing_submission_sla_digests", firmId)
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_submission_sla_digests"))
        return rows.docs
          .map((entry) => entry.data() as FilingSubmissionSlaDigestRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationOwnerRota: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_owner_rota", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationOwnerRotaRow>(db, "filing_escalation_owner_rota", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationOwnerRotaRow>(db, "filing_escalation_owner_rota", firmId)
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_owner_rota"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationOwnerRotaRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationWorkloadDigests: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_workload_digests", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationWorkloadDigestRow>(db, "filing_escalation_workload_digests", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationWorkloadDigestRow>(db, "filing_escalation_workload_digests", firmId)
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_workload_digests"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationWorkloadDigestRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationPolicyBaselines: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_policy_baselines", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationPolicyBaselineRow>(db, "filing_escalation_policy_baselines", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationPolicyBaselineRow>(db, "filing_escalation_policy_baselines", firmId)
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_policy_baselines"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationPolicyBaselineRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationBreachWaivers: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_breach_waivers", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationBreachWaiverLedgerRow>(db, "filing_escalation_breach_waivers", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationBreachWaiverLedgerRow>(db, "filing_escalation_breach_waivers", firmId)
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_breach_waivers"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationBreachWaiverLedgerRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationPolicyVarianceDigests: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_policy_variance_digests", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationPolicyVarianceDigestRow>(
          db,
          "filing_escalation_policy_variance_digests",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationPolicyVarianceDigestRow>(
          db,
          "filing_escalation_policy_variance_digests",
          firmId
        )
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_policy_variance_digests"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationPolicyVarianceDigestRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationWaiverExpiryDigests: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_waiver_expiry_digests", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationWaiverExpiryDigestRow>(
          db,
          "filing_escalation_waiver_expiry_digests",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationWaiverExpiryDigestRow>(
          db,
          "filing_escalation_waiver_expiry_digests",
          firmId
        )
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_waiver_expiry_digests"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationWaiverExpiryDigestRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationVarianceRemediations: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_variance_remediations", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationVarianceRemediationRow>(
          db,
          "filing_escalation_variance_remediations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationVarianceRemediationRow>(
          db,
          "filing_escalation_variance_remediations",
          firmId
        )
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_variance_remediations"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationVarianceRemediationRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationWaiverRolloverAttestations: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_waiver_rollover_attestations", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationWaiverRolloverAttestationRow>(
          db,
          "filing_escalation_waiver_rollover_attestations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationWaiverRolloverAttestationRow>(
          db,
          "filing_escalation_waiver_rollover_attestations",
          firmId
        )
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_waiver_rollover_attestations"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationWaiverRolloverAttestationRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationRemediationExpiryDigests: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_remediation_expiry_digests", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationRemediationExpiryDigestRow>(
          db,
          "filing_escalation_remediation_expiry_digests",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationRemediationExpiryDigestRow>(
          db,
          "filing_escalation_remediation_expiry_digests",
          firmId
        )
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_remediation_expiry_digests"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationRemediationExpiryDigestRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationRolloverBreachWatches: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_rollover_breach_watches", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationRolloverBreachWatchRow>(
          db,
          "filing_escalation_rollover_breach_watches",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationRolloverBreachWatchRow>(
          db,
          "filing_escalation_rollover_breach_watches",
          firmId
        )
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_rollover_breach_watches"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationRolloverBreachWatchRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationRemediationLifecycles: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_remediation_lifecycles", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationRemediationLifecycleRow>(
          db,
          "filing_escalation_remediation_lifecycles",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationRemediationLifecycleRow>(
          db,
          "filing_escalation_remediation_lifecycles",
          firmId
        )
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_remediation_lifecycles"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationRemediationLifecycleRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationRolloverReaffirmationSlas: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_rollover_reaffirmation_sla", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationRolloverReaffirmationSlaRow>(
          db,
          "filing_escalation_rollover_reaffirmation_sla",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationRolloverReaffirmationSlaRow>(
          db,
          "filing_escalation_rollover_reaffirmation_sla",
          firmId
        )
      },
      async listByPackageId(packageId) {
        const rows = await getDocs(collection(db, "filing_escalation_rollover_reaffirmation_sla"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationRolloverReaffirmationSlaRow)
          .filter((row) => row.packageId === packageId)
      },
    },
    filingEscalationClosureComplianceDigests: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_compliance_digests", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureComplianceDigestRow>(
          db,
          "filing_escalation_closure_compliance_digests",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureComplianceDigestRow>(
          db,
          "filing_escalation_closure_compliance_digests",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_compliance_digests"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureComplianceDigestRow)
          .filter((row) => row.ownerId === ownerId)
      },
    },
    filingEscalationClosureFollowupQueues: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_followup_queue", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureFollowupQueueRow>(
          db,
          "filing_escalation_closure_followup_queue",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureFollowupQueueRow>(
          db,
          "filing_escalation_closure_followup_queue",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_followup_queue"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureFollowupQueueRow)
          .filter((row) => row.ownerId === ownerId)
      },
    },
    filingEscalationClosureSlaWindowConfigs: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_sla_window_configs", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureSlaWindowConfigRow>(
          db,
          "filing_escalation_closure_sla_window_configs",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureSlaWindowConfigRow>(
          db,
          "filing_escalation_closure_sla_window_configs",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_sla_window_configs"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSlaWindowConfigRow)
          .filter((row) => row.ownerId === ownerId)
      },
    },
    filingEscalationClosureAutoAssignmentRules: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_auto_assignment_rules", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureAutoAssignmentRuleRow>(
          db,
          "filing_escalation_closure_auto_assignment_rules",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureAutoAssignmentRuleRow>(
          db,
          "filing_escalation_closure_auto_assignment_rules",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_auto_assignment_rules"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAutoAssignmentRuleRow)
          .filter((row) => row.ownerId === ownerId)
      },
    },
    filingEscalationClosureSlaWindows: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_sla_windows", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureSlaWindowRow>(
          db,
          "filing_escalation_closure_sla_windows",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureSlaWindowRow>(
          db,
          "filing_escalation_closure_sla_windows",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_sla_windows"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSlaWindowRow)
          .filter((row) => row.ownerId === ownerId)
      },
    },
    filingEscalationClosureAttestations: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_attestations", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureAttestationRow>(
          db,
          "filing_escalation_closure_attestations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureAttestationRow>(
          db,
          "filing_escalation_closure_attestations",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_attestations"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAttestationRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_attestations"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAttestationRow)
          .filter((row) => row.queueId === queueId)
      },
    },
    filingEscalationClosureSlaExceptionDigests: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_sla_exception_digests", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureSlaExceptionDigestRow>(
          db,
          "filing_escalation_closure_sla_exception_digests",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureSlaExceptionDigestRow>(
          db,
          "filing_escalation_closure_sla_exception_digests",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_sla_exception_digests"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSlaExceptionDigestRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_sla_exception_digests"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSlaExceptionDigestRow)
          .filter((row) => row.queueId === queueId)
      },
    },
    filingEscalationClosureAttestationDisputes: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_attestation_disputes", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureAttestationDisputeRow>(
          db,
          "filing_escalation_closure_attestation_disputes",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureAttestationDisputeRow>(
          db,
          "filing_escalation_closure_attestation_disputes",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_attestation_disputes"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAttestationDisputeRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_attestation_disputes"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAttestationDisputeRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByAttestationId(attestationId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_attestation_disputes"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAttestationDisputeRow)
          .filter((row) => row.attestationId === attestationId)
      },
    },
    filingEscalationClosureSlaExceptionEnforcement: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_sla_exception_enforcement", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureSlaExceptionEnforcementRow>(
          db,
          "filing_escalation_closure_sla_exception_enforcement",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureSlaExceptionEnforcementRow>(
          db,
          "filing_escalation_closure_sla_exception_enforcement",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_sla_exception_enforcement"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSlaExceptionEnforcementRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_sla_exception_enforcement"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSlaExceptionEnforcementRow)
          .filter((row) => row.queueId === queueId)
      },
    },
    filingEscalationClosureAdjudicationQueue: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_adjudication_queue", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureAdjudicationQueueRow>(
          db,
          "filing_escalation_closure_adjudication_queue",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureAdjudicationQueueRow>(
          db,
          "filing_escalation_closure_adjudication_queue",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_queue"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationQueueRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_queue"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationQueueRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByDisputeId(disputeId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_queue"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationQueueRow)
          .filter((row) => row.disputeId === disputeId)
      },
    },
    filingEscalationClosureEnforcementRebalance: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_enforcement_rebalance", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureEnforcementRebalanceRow>(
          db,
          "filing_escalation_closure_enforcement_rebalance",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureEnforcementRebalanceRow>(
          db,
          "filing_escalation_closure_enforcement_rebalance",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_enforcement_rebalance"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureEnforcementRebalanceRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_enforcement_rebalance"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureEnforcementRebalanceRow)
          .filter((row) => row.queueId === queueId)
      },
    },
    filingEscalationClosureAdjudicationQuorum: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_adjudication_quorum", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureAdjudicationQuorumRow>(
          db,
          "filing_escalation_closure_adjudication_quorum",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureAdjudicationQuorumRow>(
          db,
          "filing_escalation_closure_adjudication_quorum",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_quorum"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationQuorumRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_quorum"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationQuorumRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByAdjudicationId(adjudicationId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_quorum"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationQuorumRow)
          .filter((row) => row.adjudicationId === adjudicationId)
      },
    },
    filingEscalationClosureRebalanceExecution: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_rebalance_execution", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureRebalanceExecutionRow>(
          db,
          "filing_escalation_closure_rebalance_execution",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureRebalanceExecutionRow>(
          db,
          "filing_escalation_closure_rebalance_execution",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_rebalance_execution"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureRebalanceExecutionRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_rebalance_execution"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureRebalanceExecutionRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByRebalanceId(rebalanceId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_rebalance_execution"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureRebalanceExecutionRow)
          .filter((row) => row.rebalanceId === rebalanceId)
      },
    },
    filingEscalationClosureAdjudicationSlo: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_adjudication_slo", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureAdjudicationSloRow>(
          db,
          "filing_escalation_closure_adjudication_slo",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureAdjudicationSloRow>(
          db,
          "filing_escalation_closure_adjudication_slo",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_slo"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationSloRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_slo"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationSloRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByAdjudicationId(adjudicationId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_slo"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationSloRow)
          .filter((row) => row.adjudicationId === adjudicationId)
      },
    },
    filingEscalationClosureRebalanceSafeguards: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_rebalance_safeguards", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureRebalanceSafeguardRow>(
          db,
          "filing_escalation_closure_rebalance_safeguards",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureRebalanceSafeguardRow>(
          db,
          "filing_escalation_closure_rebalance_safeguards",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_rebalance_safeguards"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureRebalanceSafeguardRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_rebalance_safeguards"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureRebalanceSafeguardRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByRebalanceId(rebalanceId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_rebalance_safeguards"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureRebalanceSafeguardRow)
          .filter((row) => row.rebalanceId === rebalanceId)
      },
    },
    filingEscalationClosureAdjudicationSloDebtRemediation: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_adjudication_slo_debt_remediation", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureAdjudicationSloDebtRemediationRow>(
          db,
          "filing_escalation_closure_adjudication_slo_debt_remediation",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureAdjudicationSloDebtRemediationRow>(
          db,
          "filing_escalation_closure_adjudication_slo_debt_remediation",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(
          collection(db, "filing_escalation_closure_adjudication_slo_debt_remediation")
        )
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationSloDebtRemediationRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(
          collection(db, "filing_escalation_closure_adjudication_slo_debt_remediation")
        )
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationSloDebtRemediationRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByAdjudicationId(adjudicationId) {
        const rows = await getDocs(
          collection(db, "filing_escalation_closure_adjudication_slo_debt_remediation")
        )
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationSloDebtRemediationRow)
          .filter((row) => row.adjudicationId === adjudicationId)
      },
    },
    filingEscalationClosureRebalanceSafeguardExpiry: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_rebalance_safeguard_expiry", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureRebalanceSafeguardExpiryRow>(
          db,
          "filing_escalation_closure_rebalance_safeguard_expiry",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureRebalanceSafeguardExpiryRow>(
          db,
          "filing_escalation_closure_rebalance_safeguard_expiry",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_rebalance_safeguard_expiry"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureRebalanceSafeguardExpiryRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_rebalance_safeguard_expiry"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureRebalanceSafeguardExpiryRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByRebalanceId(rebalanceId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_rebalance_safeguard_expiry"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureRebalanceSafeguardExpiryRow)
          .filter((row) => row.rebalanceId === rebalanceId)
      },
    },
    filingEscalationClosureAdjudicationDebtBurndown: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_adjudication_debt_burndown", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureAdjudicationDebtBurndownRow>(
          db,
          "filing_escalation_closure_adjudication_debt_burndown",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureAdjudicationDebtBurndownRow>(
          db,
          "filing_escalation_closure_adjudication_debt_burndown",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_debt_burndown"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationDebtBurndownRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_debt_burndown"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationDebtBurndownRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByAdjudicationId(adjudicationId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_adjudication_debt_burndown"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureAdjudicationDebtBurndownRow)
          .filter((row) => row.adjudicationId === adjudicationId)
      },
    },
    filingEscalationClosureSafeguardExpiryAttestations: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_safeguard_expiry_attestations", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureSafeguardExpiryAttestationRow>(
          db,
          "filing_escalation_closure_safeguard_expiry_attestations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureSafeguardExpiryAttestationRow>(
          db,
          "filing_escalation_closure_safeguard_expiry_attestations",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_safeguard_expiry_attestations"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSafeguardExpiryAttestationRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_safeguard_expiry_attestations"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSafeguardExpiryAttestationRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByRebalanceId(rebalanceId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_safeguard_expiry_attestations"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSafeguardExpiryAttestationRow)
          .filter((row) => row.rebalanceId === rebalanceId)
      },
    },
    filingEscalationClosureBurndownRecalibration: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_burndown_recalibration", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureBurndownRecalibrationRow>(
          db,
          "filing_escalation_closure_burndown_recalibration",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureBurndownRecalibrationRow>(
          db,
          "filing_escalation_closure_burndown_recalibration",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_burndown_recalibration"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureBurndownRecalibrationRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_burndown_recalibration"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureBurndownRecalibrationRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByAdjudicationId(adjudicationId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_burndown_recalibration"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureBurndownRecalibrationRow)
          .filter((row) => row.adjudicationId === adjudicationId)
      },
    },
    filingEscalationClosureExpiryAttestationQueue: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_expiry_attestation_queue", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureExpiryAttestationQueueRow>(
          db,
          "filing_escalation_closure_expiry_attestation_queue",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureExpiryAttestationQueueRow>(
          db,
          "filing_escalation_closure_expiry_attestation_queue",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_expiry_attestation_queue"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureExpiryAttestationQueueRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_expiry_attestation_queue"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureExpiryAttestationQueueRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByRebalanceId(rebalanceId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_expiry_attestation_queue"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureExpiryAttestationQueueRow)
          .filter((row) => row.rebalanceId === rebalanceId)
      },
    },
    filingEscalationClosureBurndownSettlement: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_burndown_settlement", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureBurndownSettlementRow>(
          db,
          "filing_escalation_closure_burndown_settlement",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureBurndownSettlementRow>(
          db,
          "filing_escalation_closure_burndown_settlement",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_burndown_settlement"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureBurndownSettlementRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_burndown_settlement"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureBurndownSettlementRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByAdjudicationId(adjudicationId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_burndown_settlement"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureBurndownSettlementRow)
          .filter((row) => row.adjudicationId === adjudicationId)
      },
    },
    filingEscalationClosureExpiryAttestationQueueDrain: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_expiry_attestation_queue_drain", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureExpiryAttestationQueueDrainRow>(
          db,
          "filing_escalation_closure_expiry_attestation_queue_drain",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureExpiryAttestationQueueDrainRow>(
          db,
          "filing_escalation_closure_expiry_attestation_queue_drain",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_expiry_attestation_queue_drain"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureExpiryAttestationQueueDrainRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_expiry_attestation_queue_drain"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureExpiryAttestationQueueDrainRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByRebalanceId(rebalanceId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_expiry_attestation_queue_drain"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureExpiryAttestationQueueDrainRow)
          .filter((row) => row.rebalanceId === rebalanceId)
      },
    },
    filingEscalationClosureSettlementAttestation: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_settlement_attestation", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureSettlementAttestationRow>(
          db,
          "filing_escalation_closure_settlement_attestation",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureSettlementAttestationRow>(
          db,
          "filing_escalation_closure_settlement_attestation",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_settlement_attestation"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSettlementAttestationRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_settlement_attestation"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSettlementAttestationRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByAdjudicationId(adjudicationId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_settlement_attestation"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSettlementAttestationRow)
          .filter((row) => row.adjudicationId === adjudicationId)
      },
    },
    filingEscalationClosureQueueDrainReconciliation: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_queue_drain_reconciliation", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureQueueDrainReconciliationRow>(
          db,
          "filing_escalation_closure_queue_drain_reconciliation",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureQueueDrainReconciliationRow>(
          db,
          "filing_escalation_closure_queue_drain_reconciliation",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_queue_drain_reconciliation"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureQueueDrainReconciliationRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_queue_drain_reconciliation"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureQueueDrainReconciliationRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByRebalanceId(rebalanceId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_queue_drain_reconciliation"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureQueueDrainReconciliationRow)
          .filter((row) => row.rebalanceId === rebalanceId)
      },
    },
    filingEscalationClosureSettlementArbitration: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_settlement_arbitration", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureSettlementArbitrationRow>(
          db,
          "filing_escalation_closure_settlement_arbitration",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureSettlementArbitrationRow>(
          db,
          "filing_escalation_closure_settlement_arbitration",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_settlement_arbitration"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSettlementArbitrationRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_settlement_arbitration"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSettlementArbitrationRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByAdjudicationId(adjudicationId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_settlement_arbitration"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureSettlementArbitrationRow)
          .filter((row) => row.adjudicationId === adjudicationId)
      },
    },
    filingEscalationClosureQueueReentryCompliance: {
      async upsert(row) {
        await setDoc(doc(db, "filing_escalation_closure_queue_reentry_compliance", row.id), row)
      },
      async get(id) {
        return getById<FilingEscalationClosureQueueReentryComplianceRow>(
          db,
          "filing_escalation_closure_queue_reentry_compliance",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<FilingEscalationClosureQueueReentryComplianceRow>(
          db,
          "filing_escalation_closure_queue_reentry_compliance",
          firmId
        )
      },
      async listByOwnerId(ownerId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_queue_reentry_compliance"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureQueueReentryComplianceRow)
          .filter((row) => row.ownerId === ownerId)
      },
      async listByQueueId(queueId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_queue_reentry_compliance"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureQueueReentryComplianceRow)
          .filter((row) => row.queueId === queueId)
      },
      async listByRebalanceId(rebalanceId) {
        const rows = await getDocs(collection(db, "filing_escalation_closure_queue_reentry_compliance"))
        return rows.docs
          .map((entry) => entry.data() as FilingEscalationClosureQueueReentryComplianceRow)
          .filter((row) => row.rebalanceId === rebalanceId)
      },
    },
    jobs: {
      async create(row) {
        await setById(db, "jobs", row)
      },
      async listByFirm(firmId) {
        return listByFirm<Job>(db, "jobs", firmId)
      },
      async listByDocument(documentId) {
        const rows = await getDocs(collection(db, "jobs"))
        return rows.docs
          .map((entry) => entry.data() as Job)
          .filter((row) => row.documentId === documentId)
      },
    },
    workflowEvents: {
      async append(row) {
        const payload: Record<string, unknown> = { ...row }
        if (payload.reason === undefined) {
          delete payload.reason
        }
        await setDoc(doc(db, "workflow_events", row.id), payload)
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowEvent>(db, "workflow_events", firmId)
      },
    },
    followUps: {
      async upsert(row) {
        const payload: Record<string, unknown> = { ...row }
        if (payload.status === undefined) delete payload.status
        if (payload.resolvedBy === undefined) delete payload.resolvedBy
        if (payload.resolvedAt === undefined) delete payload.resolvedAt
        await setDoc(doc(db, "follow_ups", row.id), payload)
      },
      async get(id) {
        return getById<FollowUp>(db, "follow_ups", id)
      },
      async listByFirm(firmId) {
        return listByFirm<FollowUp>(db, "follow_ups", firmId)
      },
    },
    intimations: {
      async upsert(row) {
        await setDoc(doc(db, "intimation_register", row.id), row)
      },
      async get(id) {
        return getById<Intimation>(db, "intimation_register", id)
      },
      async listByFirm(firmId) {
        return listByFirm<Intimation>(db, "intimation_register", firmId)
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "intimation_register"))
        return rows.docs
          .map((entry) => entry.data() as Intimation)
          .filter((row) => row.matterId === matterId)
      },
    },
    audit: {
      async append(row) {
        if (!row.id) {
          throw new Error("audit entry id is required")
        }
        const payload: Record<string, unknown> = { ...row }
        if (payload.reason === undefined) delete payload.reason
        await setDoc(doc(db, "audit_log", row.id), payload)
      },
      async listByFirm(firmId) {
        return listByFirm<AuditEntry & { firmId: string }>(db, "audit_log", firmId)
      },
    },
    committeeOutputs: {
      async create(row) {
        const payload: Record<string, unknown> = { ...row }
        if (payload.reason === undefined) delete payload.reason
        if (payload.text === undefined) delete payload.text
        await setById(db, "committee_outputs", payload as CommitteeBrainOutput)
      },
      async get(id) {
        return getById<CommitteeBrainOutput>(db, "committee_outputs", id)
      },
      async listByFirm(firmId) {
        return listByFirm<CommitteeBrainOutput>(db, "committee_outputs", firmId)
      },
    },
    reportingIndex: {
      async upsert(row) {
        await setDoc(doc(db, "matter_client_search_index", row.id), row)
      },
      async get(id) {
        return getById<MatterClientSearchIndexRow>(db, "matter_client_search_index", id)
      },
      async listByFirm(firmId) {
        return listByFirm<MatterClientSearchIndexRow>(db, "matter_client_search_index", firmId)
      },
    },
    draftTemplateAnalytics: {
      async upsert(row) {
        await setDoc(doc(db, "draft_template_analytics", row.id), row)
      },
      async get(id) {
        return getById<DraftTemplateAnalyticsRow>(db, "draft_template_analytics", id)
      },
      async listByFirm(firmId) {
        return listByFirm<DraftTemplateAnalyticsRow>(db, "draft_template_analytics", firmId)
      },
    },
    matterReportExportAnalytics: {
      async upsert(row) {
        await setDoc(doc(db, "matter_report_export_analytics", row.id), row)
      },
      async get(id) {
        return getById<MatterReportExportAnalyticsRow>(db, "matter_report_export_analytics", id)
      },
      async listByFirm(firmId) {
        return listByFirm<MatterReportExportAnalyticsRow>(db, "matter_report_export_analytics", firmId)
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "matter_report_export_analytics"))
        return rows.docs
          .map((entry) => entry.data() as MatterReportExportAnalyticsRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    matterReportRelevanceSnapshots: {
      async upsert(row) {
        await setDoc(doc(db, "matter_report_relevance_snapshots", row.id), row)
      },
      async get(id) {
        return getById<MatterReportRelevanceSnapshotRow>(db, "matter_report_relevance_snapshots", id)
      },
      async listByFirm(firmId) {
        return listByFirm<MatterReportRelevanceSnapshotRow>(
          db,
          "matter_report_relevance_snapshots",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "matter_report_relevance_snapshots"))
        return rows.docs
          .map((entry) => entry.data() as MatterReportRelevanceSnapshotRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsActivity: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_activity", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsActivityRow>(db, "workflow_ops_activity", id)
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsActivityRow>(db, "workflow_ops_activity", firmId)
      },
    },
    workflowOpsAlertDigests: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_digests", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertDigestRow>(db, "workflow_ops_alert_digests", id)
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertDigestRow>(db, "workflow_ops_alert_digests", firmId)
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_digests"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertDigestRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertAttestations: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_attestations", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertAttestationRow>(db, "workflow_ops_alert_attestations", id)
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertAttestationRow>(db, "workflow_ops_alert_attestations", firmId)
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_attestations"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertAttestationRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertEscalationLedgers: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_escalation_ledgers", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertEscalationLedgerRow>(
          db,
          "workflow_ops_alert_escalation_ledgers",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertEscalationLedgerRow>(
          db,
          "workflow_ops_alert_escalation_ledgers",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_escalation_ledgers"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertEscalationLedgerRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertAttestationDisputes: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_attestation_disputes", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertAttestationDisputeRow>(
          db,
          "workflow_ops_alert_attestation_disputes",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertAttestationDisputeRow>(
          db,
          "workflow_ops_alert_attestation_disputes",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_attestation_disputes"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertAttestationDisputeRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertEscalationClosures: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_escalation_closures", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertEscalationClosureRow>(
          db,
          "workflow_ops_alert_escalation_closures",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertEscalationClosureRow>(
          db,
          "workflow_ops_alert_escalation_closures",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_escalation_closures"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertEscalationClosureRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertDisputeEnforcementLedgers: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_dispute_enforcement_ledgers", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertDisputeEnforcementLedgerRow>(
          db,
          "workflow_ops_alert_dispute_enforcement_ledgers",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertDisputeEnforcementLedgerRow>(
          db,
          "workflow_ops_alert_dispute_enforcement_ledgers",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_dispute_enforcement_ledgers"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertDisputeEnforcementLedgerRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertClosureDebtReconciliationDigests: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_closure_debt_reconciliation_digests", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertClosureDebtReconciliationDigestRow>(
          db,
          "workflow_ops_alert_closure_debt_reconciliation_digests",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertClosureDebtReconciliationDigestRow>(
          db,
          "workflow_ops_alert_closure_debt_reconciliation_digests",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(
          collection(db, "workflow_ops_alert_closure_debt_reconciliation_digests")
        )
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertClosureDebtReconciliationDigestRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertEnforcementAttestations: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_enforcement_attestations", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertEnforcementAttestationRow>(
          db,
          "workflow_ops_alert_enforcement_attestations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertEnforcementAttestationRow>(
          db,
          "workflow_ops_alert_enforcement_attestations",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_enforcement_attestations"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertEnforcementAttestationRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertClosureDebtVarianceDigests: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_closure_debt_variance_digests", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertClosureDebtVarianceDigestRow>(
          db,
          "workflow_ops_alert_closure_debt_variance_digests",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertClosureDebtVarianceDigestRow>(
          db,
          "workflow_ops_alert_closure_debt_variance_digests",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_closure_debt_variance_digests"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertClosureDebtVarianceDigestRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertEnforcementWaiverLedgers: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_enforcement_waiver_ledgers", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertEnforcementWaiverLedgerRow>(
          db,
          "workflow_ops_alert_enforcement_waiver_ledgers",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertEnforcementWaiverLedgerRow>(
          db,
          "workflow_ops_alert_enforcement_waiver_ledgers",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_enforcement_waiver_ledgers"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertEnforcementWaiverLedgerRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationQueues: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_variance_remediation_queues", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertVarianceRemediationQueueRow>(
          db,
          "workflow_ops_alert_variance_remediation_queues",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertVarianceRemediationQueueRow>(
          db,
          "workflow_ops_alert_variance_remediation_queues",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_variance_remediation_queues"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertVarianceRemediationQueueRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertWaiverExpiryDigests: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_waiver_expiry_digests", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertWaiverExpiryDigestRow>(
          db,
          "workflow_ops_alert_waiver_expiry_digests",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertWaiverExpiryDigestRow>(
          db,
          "workflow_ops_alert_waiver_expiry_digests",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_waiver_expiry_digests"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDigestRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaLedgers: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_variance_remediation_sla_ledgers", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertVarianceRemediationSlaLedgerRow>(
          db,
          "workflow_ops_alert_variance_remediation_sla_ledgers",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertVarianceRemediationSlaLedgerRow>(
          db,
          "workflow_ops_alert_variance_remediation_sla_ledgers",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_variance_remediation_sla_ledgers"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertVarianceRemediationSlaLedgerRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertWaiverExpiryDisputes: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_waiver_expiry_disputes", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertWaiverExpiryDisputeRow>(
          db,
          "workflow_ops_alert_waiver_expiry_disputes",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeRow>(
          db,
          "workflow_ops_alert_waiver_expiry_disputes",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_waiver_expiry_disputes"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDisputeRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachEscalations: {
      async upsert(row) {
        await setDoc(
          doc(db, "workflow_ops_alert_variance_remediation_sla_breach_escalations", row.id),
          row
        )
      },
      async get(id) {
        return getById<WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow>(
          db,
          "workflow_ops_alert_variance_remediation_sla_breach_escalations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow>(
          db,
          "workflow_ops_alert_variance_remediation_sla_breach_escalations",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(
          collection(db, "workflow_ops_alert_variance_remediation_sla_breach_escalations")
        )
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachEscalationRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudications: {
      async upsert(row) {
        await setDoc(doc(db, "workflow_ops_alert_waiver_expiry_dispute_adjudications", row.id), row)
      },
      async get(id) {
        return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudications",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudications",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(collection(db, "workflow_ops_alert_waiver_expiry_dispute_adjudications"))
        return rows.docs
          .map((entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationRow)
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints: {
      async upsert(row) {
        await setDoc(
          doc(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoints",
            row.id
          ),
          row
        )
      },
      async get(id) {
        return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow>(
          db,
          "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoints",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow>(
          db,
          "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoints",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(
          collection(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoints")
        )
        return rows.docs
          .map(
            (entry) =>
              entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointRow
          )
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships: {
      async upsert(row) {
        await setDoc(
          doc(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_stewardships", row.id),
          row
        )
      },
      async get(id) {
        return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_stewardships",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_stewardships",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(
          collection(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_stewardships")
        )
        return rows.docs
          .map(
            (entry) =>
              entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardshipRow
          )
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations: {
      async upsert(row) {
        await setDoc(
          doc(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations",
            row.id
          ),
          row
        )
      },
      async get(id) {
        return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow>(
          db,
          "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow>(
          db,
          "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(
          collection(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations"
          )
        )
        return rows.docs
          .map(
            (entry) =>
              entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationRow
          )
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations: {
      async upsert(row) {
        await setDoc(
          doc(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediations", row.id),
          row
        )
      },
      async get(id) {
        return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediations",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(
          collection(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediations")
        )
        return rows.docs
          .map(
            (entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediationRow
          )
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns: {
      async upsert(row) {
        await setDoc(
          doc(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndowns", row.id),
          row
        )
      },
      async get(id) {
        return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndowns",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndowns",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(
          collection(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndowns")
        )
        return rows.docs
          .map(
            (entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownRow
          )
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_orchestrations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_orchestrations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_orchestrations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_orchestrations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlements: {
      async upsert(row) {
        await setDoc(
          doc(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlements",
            row.id
          ),
          row
        )
      },
      async get(id) {
        return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlements",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlements",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(
          collection(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlements"
          )
        )
        return rows.docs
          .map(
            (entry) =>
              entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementRow
          )
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrains: {
      async upsert(row) {
        await setDoc(
          doc(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drains",
            row.id
          ),
          row
        )
      },
      async get(id) {
        return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow>(
          db,
          "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drains",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow>(
          db,
          "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drains",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(
          collection(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drains"
          )
        )
        return rows.docs
          .map(
            (entry) =>
              entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainRow
          )
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestations: {
      async upsert(row) {
        await setDoc(
          doc(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestations",
            row.id
          ),
          row
        )
      },
      async get(id) {
        return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestations",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(
          collection(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestations"
          )
        )
        return rows.docs
          .map(
            (entry) =>
              entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestationRow
          )
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrations: {
      async upsert(row) {
        await setDoc(
          doc(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitrations",
            row.id
          ),
          row
        )
      },
      async get(id) {
        return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitrations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow>(
          db,
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitrations",
          firmId
        )
      },
      async listByMatter(matterId) {
        const rows = await getDocs(
          collection(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitrations"
          )
        )
        return rows.docs
          .map(
            (entry) =>
              entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationRow
          )
          .filter((row) => row.matterId === matterId)
      },
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliances:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliances",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliances",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliances",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliances"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalizations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalizations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalizations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalizations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirements:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirements",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirements",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirements",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirements"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernances:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governances",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governances",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governances",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governances"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgers:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledgers",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledgers",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledgers",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledgers"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerifications:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verifications",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verifications",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verifications",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verifications"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExports:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_exports",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_exports",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_exports",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_exports"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgers:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledgers",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledgers",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledgers",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledgers"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceipts:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_receipts",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_receipts",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_receipts",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_receipts"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceiptRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffs:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoffs",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoffs",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoffs",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoffs"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgments:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgments",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgments",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgments",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgments"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgments:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgments",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgments",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgments",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgments"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgers:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledgers",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledgers",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledgers",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledgers"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliations:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliations"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView501:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView501"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliations:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliations"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView502:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView502"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow>(
            db,
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      {
        async upsert(row) {
          await setDoc(
            doc(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations",
              row.id
            ),
            row
          )
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations",
            id
          )
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow>(
            db,
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations",
            firmId
          )
        },
        async listByMatter(matterId) {
          const rows = await getDocs(
            collection(
              db,
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations"
            )
          )
          return rows.docs
            .map(
              (entry) =>
                entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow
            )
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgments:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgments:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentRow>(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentRow>(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliations:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgers:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgers"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView505:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView505"
      ),


    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView507:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView507"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView519:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView519"
      ),

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView509:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView509"
      ),

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestations:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliations:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationRow>(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationRow>(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgers:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgers"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView506:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView506"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView508:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView508"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView520:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView520"
      ),

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestations:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow>(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliations:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationRow>(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationRow>(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgers:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgers"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView506:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView506"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView508:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView508"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView520:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView520"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView510:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView510"
      ),

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView521:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView521"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView522:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView522"
      ),

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView523:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView523"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView524:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView524"
      ),

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView511:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView511"
      ),

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView513:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView513"
      ),

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView525:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView525"
      ),

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView515:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptExternalDistributionAuditLedgerRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView515"
      ),

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView517:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView517"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView512:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView512"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView514:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView514"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView526:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView526"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView528:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptPartnerHandoffAttestationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView528"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView530:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptPartnerHandoffAttestationAcknowledgementRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView530"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsTbAckReconPdFreezeSealView532:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptPartnerHandoffAttestationAcknowledgementSealVerificationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsTbAckReconPdFreezeSealView532"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView534:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgerRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView534"
      ),
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView536:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView536"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView516:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptPartnerHandoffAttestationRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView516"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView518:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow>(
        "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView518"
      ),

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView527:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptExternalDistributionAuditLedgerRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView527"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView529:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptExternalDistributionAuditLedgerReconciliationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView529"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsTbAckReconPdFreezeSealView531:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerReconciliationClosureSealVerificationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsTbAckReconPdFreezeSealView531"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView533:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerReconciliationClosureSealVerificationOutboundRegistryAttestationLedgerRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView533"
      ),
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView535:
      createDenyByDefaultWorkflowOpsRepository<WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationRow>(
        "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView535"
      ),

    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestations", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow>(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestations", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow>(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestations", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestations"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgers:
      {
        async upsert(row) {
          await setDoc(doc(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledgers", row.id), row)
        },
        async get(id) {
          return getById<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow>(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledgers", id)
        },
        async listByFirm(firmId) {
          return listByFirm<WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow>(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledgers", firmId)
        },
        async listByMatter(matterId) {
          const rows = await getDocs(collection(db, "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledgers"))
          return rows.docs
            .map((entry) => entry.data() as WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerRow)
            .filter((row) => row.matterId === matterId)
        },
      },
    tenancySessionReferences: {
      async upsert(row) {
        await setById(db, "tenancy_session_references", row)
      },
      async get(id) {
        return getById<TenancySessionReferenceRow>(db, "tenancy_session_references", id)
      },
      async listByFirm(firmId) {
        return listByFirm<TenancySessionReferenceRow>(db, "tenancy_session_references", firmId)
      },
      async listByUserId(userId) {
        const rows = await getDocs(collection(db, "tenancy_session_references"))
        return rows.docs
          .map((entry) => entry.data() as TenancySessionReferenceRow)
          .filter((row) => row.userId === userId)
      },
    },
    tenancyLineageDisputeAttestations: {
      async upsert(row) {
        await setById(db, "tenancy_lineage_dispute_attestations", row)
      },
      async get(id) {
        return getById<TenancyLineageDisputeAttestationRow>(
          db,
          "tenancy_lineage_dispute_attestations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<TenancyLineageDisputeAttestationRow>(
          db,
          "tenancy_lineage_dispute_attestations",
          firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        const rows = await getDocs(collection(db, "tenancy_lineage_dispute_attestations"))
        return rows.docs
          .map((entry) => entry.data() as TenancyLineageDisputeAttestationRow)
          .filter((row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId)
      },
    },
    tenancyLineageReconciliationDigests: {
      async upsert(row) {
        await setById(db, "tenancy_lineage_reconciliation_digests", row)
      },
      async get(id) {
        return getById<TenancyLineageReconciliationDigestRow>(
          db,
          "tenancy_lineage_reconciliation_digests",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<TenancyLineageReconciliationDigestRow>(
          db,
          "tenancy_lineage_reconciliation_digests",
          firmId
        )
      },
    },
    tenancyLineageReconciliationQueueArbitrations: {
      async upsert(row) {
        await setById(db, "tenancy_lineage_reconciliation_queue_arbitrations", row)
      },
      async get(id) {
        return getById<TenancyLineageReconciliationQueueArbitrationRow>(
          db,
          "tenancy_lineage_reconciliation_queue_arbitrations",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<TenancyLineageReconciliationQueueArbitrationRow>(
          db,
          "tenancy_lineage_reconciliation_queue_arbitrations",
          firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        const rows = await getDocs(collection(db, "tenancy_lineage_reconciliation_queue_arbitrations"))
        return rows.docs
          .map((entry) => entry.data() as TenancyLineageReconciliationQueueArbitrationRow)
          .filter((row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId)
      },
    },
    tenancyLineageDigestClosureCheckpoints: {
      async upsert(row) {
        await setById(db, "tenancy_lineage_digest_closure_checkpoints", row)
      },
      async get(id) {
        return getById<TenancyLineageDigestClosureCheckpointRow>(
          db,
          "tenancy_lineage_digest_closure_checkpoints",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<TenancyLineageDigestClosureCheckpointRow>(
          db,
          "tenancy_lineage_digest_closure_checkpoints",
          firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        const rows = await getDocs(collection(db, "tenancy_lineage_digest_closure_checkpoints"))
        return rows.docs
          .map((entry) => entry.data() as TenancyLineageDigestClosureCheckpointRow)
          .filter((row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId)
      },
    },
    tenancyLineageClosureAdjudications: {
      async upsert(row) {
        await setById(db, "tenancy_lineage_closure_adjudications", row)
      },
      async get(id) {
        return getById<TenancyLineageClosureAdjudicationRow>(
          db,
          "tenancy_lineage_closure_adjudications",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<TenancyLineageClosureAdjudicationRow>(
          db,
          "tenancy_lineage_closure_adjudications",
          firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        const rows = await getDocs(collection(db, "tenancy_lineage_closure_adjudications"))
        return rows.docs
          .map((entry) => entry.data() as TenancyLineageClosureAdjudicationRow)
          .filter((row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId)
      },
    },
    tenancyLineageArbitrationDebtRetirementLedgers: {
      async upsert(row) {
        await setById(db, "tenancy_lineage_arbitration_debt_retirement_ledgers", row)
      },
      async get(id) {
        return getById<TenancyLineageArbitrationDebtRetirementLedgerRow>(
          db,
          "tenancy_lineage_arbitration_debt_retirement_ledgers",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<TenancyLineageArbitrationDebtRetirementLedgerRow>(
          db,
          "tenancy_lineage_arbitration_debt_retirement_ledgers",
          firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        const rows = await getDocs(
          collection(db, "tenancy_lineage_arbitration_debt_retirement_ledgers")
        )
        return rows.docs
          .map((entry) => entry.data() as TenancyLineageArbitrationDebtRetirementLedgerRow)
          .filter((row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId)
      },
    },
    tenancyLineageClosureAdjudicationSettlements: {
      async upsert(row) {
        await setById(db, "tenancy_lineage_closure_adjudication_settlements", row)
      },
      async get(id) {
        return getById<TenancyLineageClosureAdjudicationSettlementRow>(
          db,
          "tenancy_lineage_closure_adjudication_settlements",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<TenancyLineageClosureAdjudicationSettlementRow>(
          db,
          "tenancy_lineage_closure_adjudication_settlements",
          firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        const rows = await getDocs(
          collection(db, "tenancy_lineage_closure_adjudication_settlements")
        )
        return rows.docs
          .map((entry) => entry.data() as TenancyLineageClosureAdjudicationSettlementRow)
          .filter((row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId)
      },
    },
    tenancyLineageArbitrationDebtRetirementDisputeLedgers: {
      async upsert(row) {
        await setById(db, "tenancy_lineage_arbitration_debt_retirement_dispute_ledgers", row)
      },
      async get(id) {
        return getById<TenancyLineageArbitrationDebtRetirementDisputeLedgerRow>(
          db,
          "tenancy_lineage_arbitration_debt_retirement_dispute_ledgers",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<TenancyLineageArbitrationDebtRetirementDisputeLedgerRow>(
          db,
          "tenancy_lineage_arbitration_debt_retirement_dispute_ledgers",
          firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        const rows = await getDocs(
          collection(db, "tenancy_lineage_arbitration_debt_retirement_dispute_ledgers")
        )
        return rows.docs
          .map((entry) => entry.data() as TenancyLineageArbitrationDebtRetirementDisputeLedgerRow)
          .filter((row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId)
      },
    },
    tenancyExternalSessionIdentityBridges: {
      async upsert(row) {
        await setById(db, "tenancy_external_session_identity_bridges", row)
      },
      async get(id) {
        return getById<TenancyExternalSessionIdentityBridgeRow>(
          db,
          "tenancy_external_session_identity_bridges",
          id
        )
      },
      async listByFirm(firmId) {
        return listByFirm<TenancyExternalSessionIdentityBridgeRow>(
          db,
          "tenancy_external_session_identity_bridges",
          firmId
        )
      },
      async listByLineageRoot(lineageRootSessionReferenceId) {
        const rows = await getDocs(collection(db, "tenancy_external_session_identity_bridges"))
        return rows.docs
          .map((entry) => entry.data() as TenancyExternalSessionIdentityBridgeRow)
          .filter((row) => row.lineageRootSessionReferenceId === lineageRootSessionReferenceId)
      },
      async listBySessionReference(sessionReferenceId) {
        const rows = await getDocs(collection(db, "tenancy_external_session_identity_bridges"))
        return rows.docs
          .map((entry) => entry.data() as TenancyExternalSessionIdentityBridgeRow)
          .filter((row) => row.sessionReferenceId === sessionReferenceId)
      },
    },
  }
}
