/**
 * One learning path (v19 L16.3 steps 1 and 4, L5574–L5583).
 * Style (15), firm data (L3.2), continuous (L4.6), user memory (L14.1) and
 * master auto-update (L14.2) are modes. They propose. They do not write the master.
 * User memory stays outside the master (L17.5 item 34, L7066).
 * The L4.6 folder platform/p6/learning is not this module.
 */
import type { Classification } from "@/platform/p1/types"
import { assertP6ConsolidationEnabled } from "@/platform/p6/consolidationFlag"
import type { MasterStore } from "@/platform/p6/masterStore"
import { proposeChange, type ChangeProposal } from "@/platform/p6/proposeChange"

export const LEARNING_MODES = ["style", "firm-data", "continuous", "user-memory", "master-auto-update"] as const
export type LearningMode = (typeof LEARNING_MODES)[number]

const SOURCE_MODULE: Record<LearningMode, string> = {
  style: "15",
  "firm-data": "L3.2",
  continuous: "L4.6",
  "user-memory": "L14.1",
  "master-auto-update": "L14.2",
}

export type LearningProposalInput = {
  firmId: string
  proposedBy: string
  classification: Classification
  entryKey: string
  payload: unknown
  partition?: "mutable" | "immutable"
}

export type LearningPathResult = {
  owner: "learning"
  mode: LearningMode
  sourceModule: string
  proposalId: string | null
  masterWrite: false
  status?: "pending" | "approved" | "applied" | "rejected"
}

let calls = 0

export function learningPathCalls(): number {
  return calls
}

export async function runLearningPath(input: LearningProposalInput & { mode: LearningMode }, store?: MasterStore): Promise<LearningPathResult> {
  assertP6ConsolidationEnabled()
  calls += 1
  const sourceModule = SOURCE_MODULE[input.mode]
  if (input.mode === "user-memory") {
    return { owner: "learning", mode: input.mode, sourceModule, proposalId: null, masterWrite: false }
  }
  const proposal: ChangeProposal = {
    firmId: input.firmId,
    sourceModule,
    classification: input.classification,
    payload: input.payload,
    proposedBy: input.proposedBy,
    partition: input.partition ?? "mutable",
    entryKey: input.entryKey,
    changeClass: "substantive",
  }
  const row = store ? await proposeChange(proposal, store) : proposeChange(proposal)
  return {
    owner: "learning",
    mode: input.mode,
    sourceModule,
    proposalId: row.id,
    status: row.status,
    masterWrite: false,
  }
}

export function learnStyle(input: LearningProposalInput, store?: MasterStore): Promise<LearningPathResult> {
  return runLearningPath({ ...input, mode: "style" }, store)
}

export function learnFirmData(input: LearningProposalInput, store?: MasterStore): Promise<LearningPathResult> {
  return runLearningPath({ ...input, mode: "firm-data" }, store)
}

export function learnContinuous(input: LearningProposalInput, store?: MasterStore): Promise<LearningPathResult> {
  return runLearningPath({ ...input, mode: "continuous" }, store)
}

export function learnUserMemory(input: LearningProposalInput, store?: MasterStore): Promise<LearningPathResult> {
  return runLearningPath({ ...input, mode: "user-memory" }, store)
}

export function learnMasterAutoUpdate(input: LearningProposalInput, store?: MasterStore): Promise<LearningPathResult> {
  return runLearningPath({ ...input, mode: "master-auto-update" }, store)
}
