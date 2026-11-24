export { approveProposal, applyChange, proposeChange, rollbackMaster } from "@/platform/p6/proposeChange"
export type { AppliedChange, ApprovalActor, ChangeProposal, ProposalRecord, RolledBackMaster } from "@/platform/p6/proposeChange"
export { assertLearnersStopped, learnersMayRun } from "@/platform/p6/learners"
export type { LearnerPosture } from "@/platform/p6/learners"
export { createPgMasterStore, InMemoryMasterStore, P6_ROLE } from "@/platform/p6/masterStore"
export type { MasterDiff, MasterSnapshot, MasterStore, PersistedProposal, VersionRow } from "@/platform/p6/masterStore"
export { isP6ConsolidationEnabled, P6_CONSOLIDATION_FLAG } from "@/platform/p6/consolidationFlag"
export type { MasterWriteAuditEntry } from "@/platform/p6/masterWrite"
export {
  learnContinuous,
  learnFirmData,
  learnMasterAutoUpdate,
  learnStyle,
  learnUserMemory,
  runLearningPath,
} from "@/platform/p6/learningPath"
export type { LearningMode, LearningPathResult } from "@/platform/p6/learningPath"
export { reviewDraft, runReviewPath, strategiseArgument, suggestForDraft } from "@/platform/p6/reviewPath"
export type { ReviewMode, ReviewPathResult } from "@/platform/p6/reviewPath"
export { pushClientUpdate, reportToClient, runClientPath, whatsAppSelfService } from "@/platform/p6/clientPath"
export type { ClientMode, ClientPathResult } from "@/platform/p6/clientPath"
