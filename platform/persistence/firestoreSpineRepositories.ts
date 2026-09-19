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
  }
}
