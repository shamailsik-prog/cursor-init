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
  WorkflowOpsActivityRow,
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
