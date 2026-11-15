/**
 * P6 Master Knowledge — the only writer of master tables and master_versions.
 * Every other service calls proposeChange. CI master-write-guard fails any other writer.
 *
 * proposeChange stores a proposal. It does not write the master.
 * applyChange writes one version row and the diff, and returns masterWritten only after that
 * version can be read back. A failed commit throws. Substantive changes need a partner.
 * Model and autonomous actors are refused (L17.5; Layer 18 §10 G-3).
 */

import { randomUUID } from "node:crypto"
import { isClassification, type Classification } from "@/platform/p1/types"
import {
  type CommitVersionResult,
  type MasterDiff,
  type MasterSnapshot,
  type MasterStore,
  type PersistedProposal,
} from "@/platform/p6/masterStore"

export type ChangeProposal = {
  firmId: string
  sourceModule: string
  classification: Classification
  payload: unknown
  proposedBy: string
  changeClass?: "cosmetic" | "substantive"
  partition?: "mutable" | "immutable"
  entryKey?: string
}

export type ProposalRecord = ChangeProposal & {
  id: string
  status: "pending" | "approved" | "applied" | "rejected"
}

export type ApprovalActor = {
  actorId: string
  kind: "partner" | "autonomous" | "model" | "system"
  role: "partner" | "associate" | "clerk" | "intern" | "system"
}

export type AppliedChange = {
  masterWritten: true
  proposalId: string
  versionId: string
  diff: MasterDiff
}

export type RolledBackMaster = {
  masterWritten: true
  versionId: string
  diff: MasterDiff
}

const IMMUTABLE_KEYS = new Set(["citation_protocol", "verification_protocol"])
const SUBSTANTIVE_PAYLOAD_KEYS = new Set(["wording", "taxonomyRule", "citationProtocol", "clauseText"])

function payloadHasSubstantiveContent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false
  return Object.keys(payload).some((key) => SUBSTANTIVE_PAYLOAD_KEYS.has(key))
}

function assertWritableTarget(partition: string, entryKey: string): void {
  if (partition !== "mutable" || IMMUTABLE_KEYS.has(entryKey)) {
    throw new Error("immutable master partition is not writable")
  }
}

function refuseNonPartner(actor: ApprovalActor): void {
  if (actor.kind === "model" || actor.kind === "autonomous") {
    throw new Error("autonomous approval of master changes is refused")
  }
  if (actor.kind !== "partner" || actor.role !== "partner" || actor.actorId.trim() === "") {
    throw new Error("substantive proposal requires partner approval")
  }
}

async function persistProposal(proposal: ChangeProposal, store: MasterStore): Promise<PersistedProposal> {
  if (store.role !== "p6_service") throw new Error("non-P6 writer refused")
  const changeClass = proposal.changeClass ?? "substantive"
  const partition = proposal.partition ?? "mutable"
  const entryKey = proposal.entryKey?.trim() ?? ""
  if (entryKey === "") throw new Error("master proposal omitted entry key")
  assertWritableTarget(partition, entryKey)
  if (changeClass === "cosmetic" && payloadHasSubstantiveContent(proposal.payload)) {
    throw new Error("cosmetic proposal carries substantive content")
  }
  if (proposal.firmId.trim() === "" || proposal.proposedBy.trim() === "" || proposal.sourceModule.trim() === "") {
    throw new Error("master proposal omitted firm, source or author")
  }
  const row: PersistedProposal = {
    id: randomUUID(),
    firmId: proposal.firmId,
    sourceModule: proposal.sourceModule,
    classification: proposal.classification,
    changeClass,
    partition,
    entryKey,
    payload: proposal.payload,
    proposedBy: proposal.proposedBy,
    status: "pending",
    decidedBy: null,
    decidedKind: null,
    decidedRole: null,
  }
  return store.insertProposal(row)
}

/**
 * Learners call this. Without a store it validates and returns a pending record (it still
 * does not write the master). With a store it persists the proposal row only.
 */
export function proposeChange(proposal: ChangeProposal): ProposalRecord
export function proposeChange(proposal: ChangeProposal, store: MasterStore): Promise<PersistedProposal>
export function proposeChange(
  proposal: ChangeProposal,
  store?: MasterStore,
): ProposalRecord | Promise<PersistedProposal> {
  if (!isClassification(proposal.classification)) {
    throw new Error("artefact write omitted classification")
  }
  if (!store) {
    return {
      ...proposal,
      id: `prop_${proposal.firmId}_${proposal.sourceModule}`,
      status: "pending",
    }
  }
  return persistProposal(proposal, store)
}

/** Records a partner decision. Model and autonomous actors are refused and nothing is written. */
export async function approveProposal(
  proposalId: string,
  actor: ApprovalActor,
  store: MasterStore,
): Promise<PersistedProposal> {
  if (store.role !== "p6_service") throw new Error("non-P6 writer refused")
  refuseNonPartner(actor)
  const row = await store.getProposal(proposalId)
  if (!row) throw new Error("proposal not found")
  if (row.changeClass !== "substantive") throw new Error("cosmetic proposals are not partner-approved")
  if (row.status !== "pending") throw new Error("proposal is not pending")
  const next: PersistedProposal = {
    ...row,
    status: "approved",
    decidedBy: actor.actorId,
    decidedKind: "partner",
    decidedRole: "partner",
  }
  await store.saveProposal(next)
  return next
}

function nextSnapshot(before: MasterSnapshot, row: PersistedProposal): MasterSnapshot {
  return {
    entries: {
      ...before.entries,
      [row.entryKey]: {
        partition: "mutable",
        key: row.entryKey,
        body: row.payload,
        classification: row.classification,
      },
    },
  }
}

async function finishCommit(
  outcome: CommitVersionResult,
  store: MasterStore,
  proposalId: string | null,
): Promise<{ versionId: string; diff: MasterDiff }> {
  if (!outcome.committed) throw new Error("master write did not commit")
  const version = await store.getVersion(outcome.versionId)
  if (!version) throw new Error("master write did not commit")
  if (proposalId && version.proposalId !== proposalId) throw new Error("master write did not commit")
  return { versionId: version.id, diff: version.diff }
}

/**
 * P6 only. Applies a stored proposal. Cosmetic changes are logged as a system apply.
 * Substantive changes require a partner decision already stored on the proposal.
 * masterWritten is true only when the new version row was committed and can be read.
 */
export async function applyChange(proposalId: string, store: MasterStore): Promise<AppliedChange> {
  if (store.role !== "p6_service") throw new Error("non-P6 writer refused")
  const row = await store.getProposal(proposalId)
  if (!row) throw new Error("proposal not found")
  assertWritableTarget(row.partition, row.entryKey)
  if (row.status === "applied") throw new Error("proposal is already applied")
  let authorId: string
  let authorKind: "partner" | "system"
  let decidedBy: string | null
  let decidedKind: "partner" | "system"
  let decidedRole: string
  if (row.changeClass === "substantive") {
    if (row.status !== "approved" || row.decidedKind !== "partner" || row.decidedRole !== "partner" || !row.decidedBy) {
      throw new Error("substantive proposal requires partner approval")
    }
    authorId = row.decidedBy
    authorKind = "partner"
    decidedBy = row.decidedBy
    decidedKind = "partner"
    decidedRole = "partner"
  } else {
    if (row.status !== "pending") throw new Error("cosmetic proposal is not pending")
    authorId = "p6"
    authorKind = "system"
    decidedBy = "p6"
    decidedKind = "system"
    decidedRole = "system"
  }
  const before = await store.currentSnapshot(row.firmId)
  const after = nextSnapshot(before, row)
  const diff: MasterDiff = { key: row.entryKey, partition: "mutable", before, after }
  const outcome = await store.commitVersion({
    firmId: row.firmId,
    proposalId: row.id,
    action: "apply",
    diff,
    snapshot: after,
    authorId,
    authorKind,
    restoredFromVersionId: null,
    classification: row.classification,
    proposal: { ...row, status: "applied", decidedBy, decidedKind, decidedRole },
  })
  const written = await finishCommit(outcome, store, row.id)
  return { masterWritten: true, proposalId: row.id, versionId: written.versionId, diff: written.diff }
}

/** Partner-only. Writes a new version whose snapshot is the chosen prior version. */
export async function rollbackMaster(
  input: { firmId: string; toVersionId: string; actor: ApprovalActor },
  store: MasterStore,
): Promise<RolledBackMaster> {
  if (store.role !== "p6_service") throw new Error("non-P6 writer refused")
  refuseNonPartner(input.actor)
  const target = await store.getVersion(input.toVersionId)
  if (!target || target.firmId !== input.firmId) throw new Error("version not found")
  const before = await store.currentSnapshot(input.firmId)
  const after = target.snapshot
  const diff: MasterDiff = { key: "*", partition: "mutable", before, after }
  const classification = Object.values(after.entries)[0]?.classification ?? "internal"
  const outcome = await store.commitVersion({
    firmId: input.firmId,
    proposalId: null,
    action: "rollback",
    diff,
    snapshot: after,
    authorId: input.actor.actorId,
    authorKind: "partner",
    restoredFromVersionId: target.id,
    classification,
    proposal: null,
  })
  const written = await finishCommit(outcome, store, null)
  return { masterWritten: true, versionId: written.versionId, diff: written.diff }
}
