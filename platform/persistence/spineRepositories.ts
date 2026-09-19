import type {
  DocumentRecord,
  DraftRecord,
  FilingPackage,
  Matter,
  DocumentWorkflow,
  SpineStore,
} from "@/platform/spine/store"

export type MatterRepository = {
  create(row: Matter): Promise<void>
  get(id: string): Promise<Matter | null>
  update(id: string, patch: Partial<Matter>): Promise<Matter | null>
  listByFirm(firmId: string): Promise<Matter[]>
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

export type SpineRepositories = {
  matters: MatterRepository
  documents: DocumentRepository
  drafts: DraftRepository
  workflow: WorkflowRepository
  filings: FilingRepository
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
  }
}
