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
  FilingEscalationPolicyVarianceDigestRow,
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
