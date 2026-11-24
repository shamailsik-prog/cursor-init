import type { Classification } from "@/platform/p1/types"
import type { LearningSource } from "@/platform/p6/learning/sources"

/** Durable shape of a learning proposal. Status leaves pending only through a partner decision. */
export type LearningProposalRecord = {
  id: string
  firmId: string
  proposedBy: string
  source: LearningSource
  evidence: string
  entryKey: string
  classification: Classification
  changeClass: "cosmetic" | "substantive"
  diff: { before: unknown; after: unknown }
  createdAt: string
  status: "pending" | "approved" | "rejected"
  decidedBy: string | null
  decidedAt: string | null
  /** Always false. This record is not a master version. */
  masterWrite: false
  /** Set when a partner approval has been recorded on the sealed proposal log. */
  sealedProposalId: string | null
}

export type ProposeLearningInput = {
  firmId: string
  proposedBy: string
  source: string
  evidence: string
  entryKey: string
  classification: Classification
  before: unknown
  after: unknown
  partition?: "mutable" | "immutable"
}

export type LearningActor = {
  actorId: string
  firmId: string
  kind: "partner" | "autonomous" | "model" | "system"
  role: "partner" | "associate" | "clerk" | "intern" | "system"
  decision: "approved" | "rejected"
}
