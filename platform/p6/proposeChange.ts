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
import { classificationRank, isClassification, type Classification } from "@/platform/p1/types"
import {
  canonicalPayload,
  payloadDigest,
  payloadHasPollutingKey,
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
  /** Partner-only. Without it a lower classification is refused. */
  declassify?: boolean
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

/** Cosmetic only when the diff is whitespace or object-key order. Anything else is substantive. A caller cannot lower that. A payload that carries __proto__, constructor, or prototype at any depth is substantive. */
function effectiveClass(
  requested: "cosmetic" | "substantive" | null | undefined,
  before: unknown,
  after: unknown,
): "cosmetic" | "substantive" {
  if (payloadHasPollutingKey(after) || (before !== undefined && payloadHasPollutingKey(before))) {
    return "substantive"
  }
  const formatOnly = before !== undefined && canonicalPayload(before, true) === canonicalPayload(after, true)
  const derived = formatOnly ? "cosmetic" : "substantive"
  if (requested === "substantive") return "substantive"
  return derived
}

function assertApprovalBound(row: PersistedProposal): void {
  if (payloadDigest(row.payload) !== row.payloadHash) {
    throw new Error("approval is bound to a different payload hash")
  }
}

function higherClass(left: Classification, right: Classification): Classification {
  return classificationRank(left) >= classificationRank(right) ? left : right
}

function snapshotClass(snapshot: MasterSnapshot, fallback: Classification): Classification {
  let best = fallback
  for (const entry of Object.values(snapshot.entries)) {
    if (!isClassification(entry.classification)) continue
    best = higherClass(best, entry.classification)
  }
  return best
}

function assertNoDowngrade(existing: string | undefined, proposed: Classification, declassify: boolean): void {
  if (!isClassification(existing)) return
  if (classificationRank(proposed) < classificationRank(existing) && !declassify) {
    throw new Error("classification downgrade requires partner declassify")
  }
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
  const partition = proposal.partition ?? "mutable"
  const entryKey = proposal.entryKey?.trim() ?? ""
  if (entryKey === "") throw new Error("master proposal omitted entry key")
  assertWritableTarget(partition, entryKey)
  if (proposal.firmId.trim() === "" || proposal.proposedBy.trim() === "" || proposal.sourceModule.trim() === "") {
    throw new Error("master proposal omitted firm, source or author")
  }
  const before = await store.currentSnapshot(proposal.firmId)
  const requested = proposal.changeClass ?? null
  const changeClass = effectiveClass(requested, before.entries[entryKey]?.body, proposal.payload)
  const row: PersistedProposal = {
    id: randomUUID(),
    firmId: proposal.firmId,
    sourceModule: proposal.sourceModule,
    classification: proposal.classification,
    changeClass,
    requestedClass: requested,
    partition,
    entryKey,
    payload: proposal.payload,
    proposedBy: proposal.proposedBy,
    status: "pending",
    decidedBy: null,
    decidedKind: null,
    decidedRole: null,
    declassify: false,
    payloadHash: payloadDigest(proposal.payload),
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
  return store.runExclusive(async (tx) => {
    refuseNonPartner(actor)
    const row = await tx.getProposal(proposalId)
    if (!row) throw new Error("proposal not found")
    assertApprovalBound(row)
    if (actor.actorId === row.proposedBy) throw new Error("approver must differ from proposer")
    if (row.changeClass !== "substantive") throw new Error("cosmetic proposals are not partner-approved")
    if (row.status !== "pending") throw new Error("proposal is not pending")
    const next: PersistedProposal = {
      ...row,
      status: "approved",
      decidedBy: actor.actorId,
      decidedKind: "partner",
      decidedRole: "partner",
      declassify: actor.declassify === true,
    }
    const saved = await tx.casProposal(next, "pending")
    if (!saved) throw new Error("proposal is not pending")
    return next
  })
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
  const outcome = await store.runExclusive(async (tx) => {
    const row = await tx.getProposal(proposalId)
    if (!row) throw new Error("proposal not found")
    assertApprovalBound(row)
    assertWritableTarget(row.partition, row.entryKey)
    if (row.status === "applied") throw new Error("proposal is already applied")
    const base = await tx.lockFirm(row.firmId)
    const before = await tx.currentSnapshot(row.firmId)
    const existing = before.entries[row.entryKey]
    const changeClass = effectiveClass(row.requestedClass, existing?.body, row.payload)
    assertNoDowngrade(existing?.classification, row.classification, row.declassify)
    let authorId: string
    let authorKind: "partner" | "system"
    let decidedBy: string | null
    let decidedKind: "partner" | "system"
    let decidedRole: string
    let fromStatus: PersistedProposal["status"]
    if (changeClass === "substantive") {
      if (row.status !== "approved" || row.decidedKind !== "partner" || row.decidedRole !== "partner" || !row.decidedBy) {
        throw new Error("substantive proposal requires partner approval")
      }
      authorId = row.decidedBy
      authorKind = "partner"
      decidedBy = row.decidedBy
      decidedKind = "partner"
      decidedRole = "partner"
      fromStatus = "approved"
    } else {
      if (row.status !== "pending") throw new Error("cosmetic proposal is not pending")
      authorId = "p6"
      authorKind = "system"
      decidedBy = "p6"
      decidedKind = "system"
      decidedRole = "system"
      fromStatus = "pending"
    }
    const after = nextSnapshot(before, row)
    const diff: MasterDiff = { key: row.entryKey, partition: "mutable", before, after }
    const next: PersistedProposal = {
      ...row,
      status: "applied",
      changeClass,
      decidedBy,
      decidedKind,
      decidedRole,
    }
    const saved = await tx.casProposal(next, fromStatus)
    if (!saved) throw new Error("proposal status changed")
    await tx.allowDeclassify(row.declassify)
    const committed = await tx.commitVersion({
      firmId: row.firmId,
      proposalId: row.id,
      action: "apply",
      diff,
      snapshot: after,
      authorId,
      authorKind,
      restoredFromVersionId: null,
      classification: snapshotClass(after, row.classification),
      proposal: next,
      expectedBaseVersionId: base,
    })
    if (!committed.committed) throw new Error("master write did not commit")
    return committed
  })
  const written = await finishCommit(outcome, store, proposalId)
  return { masterWritten: true, proposalId, versionId: written.versionId, diff: written.diff }
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
  const outcome = await store.runExclusive(async (tx) => {
    const base = await tx.lockFirm(input.firmId)
    const before = await tx.currentSnapshot(input.firmId)
    const current = await tx.currentClassification(input.firmId)
    const after = target.snapshot
    const targetClass = snapshotClass(after, "internal")
    const classification = input.actor.declassify === true ? targetClass : higherClass(current, targetClass)
    const diff: MasterDiff = { key: "*", partition: "mutable", before, after }
    await tx.allowDeclassify(input.actor.declassify === true)
    const committed = await tx.commitVersion({
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
      expectedBaseVersionId: base,
    })
    if (!committed.committed) throw new Error("master write did not commit")
    return committed
  })
  const written = await finishCommit(outcome, store, null)
  return { masterWritten: true, versionId: written.versionId, diff: written.diff }
}
