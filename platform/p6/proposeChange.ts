/**
 * P6 Master Knowledge — the only writer of master tables and master_versions.
 * Every other service calls proposeChange. CI master-write-guard fails any other writer.
 */

import { isClassification } from "@/platform/p1/types"

export type ChangeProposal = {
  firmId: string
  sourceModule: string
  classification: "public" | "internal" | "confidential" | "privileged" | "privileged-restricted"
  payload: unknown
  proposedBy: string
}

export type ProposalRecord = ChangeProposal & {
  id: string
  status: "pending"
}

/**
 * Learners call this. It does not write master tables.
 * applyChange (below) is the only master writer and lives in this module.
 */
export function proposeChange(proposal: ChangeProposal): ProposalRecord {
  if (!isClassification(proposal.classification)) {
    throw new Error("artefact write omitted classification")
  }
  return {
    ...proposal,
    id: `prop_${proposal.firmId}_${proposal.sourceModule}`,
    status: "pending",
  }
}

/**
 * P6 only. Partner-approved application of a proposal.
 * Phase 0: no live Postgres; this is the single allowed write site for when G-3 lands.
 */
export function applyChange(proposal: ProposalRecord): {
  masterWritten: true
  proposalId: string
} {
  void proposal
  return { masterWritten: true, proposalId: proposal.id }
}
