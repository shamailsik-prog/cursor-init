import type {
  DocumentRecord,
  DraftRecord,
  FilingPackage,
  FollowUp,
  Intimation,
  Job,
  Matter,
  MatterMember,
  DocumentWorkflow,
  WorkflowEvent,
  SpineStore,
} from "@/platform/spine/store"

export type MatterRepository = {
  create(row: Matter): Promise<void>
  get(id: string): Promise<Matter | null>
  update(id: string, patch: Partial<Matter>): Promise<Matter | null>
  listByFirm(firmId: string): Promise<Matter[]>
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

export type SpineRepositories = {
  matters: MatterRepository
  members: MatterMemberRepository
  documents: DocumentRepository
  drafts: DraftRepository
  workflow: WorkflowRepository
  filings: FilingRepository
  jobs: JobRepository
  workflowEvents: WorkflowEventRepository
  followUps: FollowUpRepository
  intimations: IntimationRepository
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
  }
}
