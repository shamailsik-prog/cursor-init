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
}

export type Intimation = {
  id: string
  firmId: string
  matterId: string
  notifiedAt: number
  confirmedAt: number | null
}

export type AuditEntry = {
  action: string
  actorId: string
  target: string
  classification: Classification
  reason?: string
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

export class SpineStore {
  users = new Map<string, User>()
  members = new Map<string, { matterId: string; userId: string; firmId: string }>()
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
