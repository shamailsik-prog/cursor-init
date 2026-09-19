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
