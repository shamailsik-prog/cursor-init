/**
 * P6 applies a partner-approved learning proposal. The learning folder proposes and
 * records the decision. It does not call applyChange.
 */
import {
  assertLearningBaseline,
  assertLearningOpen,
  refuseDirectMasterWrite,
  runLearningExclusive,
  type LearningDeps,
} from "@/platform/p6/learning/governance"
import { applyChange } from "@/platform/p6/proposeChange"

export async function applyLearning(id: string, deps: LearningDeps): Promise<{ masterWritten: true; proposalId: string }> {
  return runLearningExclusive(deps.ledger, async () => {
    assertLearningOpen(deps)
    if (!deps.store) throw new Error("learning approval requires the master store")
    const row = await deps.ledger.get(id)
    if (!row) throw new Error("proposal not found")
    await assertLearningBaseline(row, deps.store)
    if (row.status !== "approved" || !row.sealedProposalId) throw new Error("proposal is not approved")
    const applied = await applyChange(row.sealedProposalId, deps.store)
    if (applied.masterWritten !== true) refuseDirectMasterWrite()
    return { masterWritten: true, proposalId: applied.proposalId }
  })
}
