/**
 * L4.6 continuous learning (v19 L3456–L3487, governance L3711–L3720).
 * Erratum E-9 (L6825–L6833) and L17.5 item 30 (L7058–L7059): learners propose.
 * A partner decision is recorded with proposeChange and approveProposal.
 * Turning that decision into a master version stays on the sealed P6 path.
 * W2-WIRE mounts this module. This folder does not.
 */
import { randomUUID } from "node:crypto"
import { isClassification } from "@/platform/p1/types"
import { assertLearnersStopped, type LearnerPosture } from "@/platform/p6/learners"
import { canonicalPayload, normalizeActorKey, payloadDigest, type MasterStore } from "@/platform/p6/masterStore"
import { effectiveClass } from "@/platform/p6/masterWrite"
import { approveProposal, applyChange, proposeChange } from "@/platform/p6/proposeChange"
import { baselineMatchesLive, learningBaselinePayload } from "@/platform/p6/learning/baseline"
import { isP6LearningEnabled } from "@/platform/p6/learning/flag"
import type { LearningLedger } from "@/platform/p6/learning/ledger"
import { parseLearningSource } from "@/platform/p6/learning/sources"
import { LearningStaleError } from "@/platform/p6/learning/stale"
import type { LearningActor, LearningProposalRecord, ProposeLearningInput } from "@/platform/p6/learning/types"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"

export const LEARNING_LIMITS = {
  maxProposalsPerWindow: 30,
  windowMs: 60 * 60 * 1000,
  maxPayloadBytes: 32 * 1024,
  maxEvidenceChars: 4_096,
  maxFieldChars: 256,
} as const

export type LearningLimits = {
  maxProposalsPerWindow: number
  windowMs: number
  maxPayloadBytes: number
  maxEvidenceChars: number
  maxFieldChars: number
}

export type LearningDeps = {
  ledger: LearningLedger
  posture: LearnerPosture
  store?: MasterStore
  now?: () => Date
  limits?: Partial<LearningLimits>
  env?: NodeJS.ProcessEnv
}

const IMMUTABLE_KEYS = new Set(["citation_protocol", "verification_protocol"])
const tails = new WeakMap<object, Promise<void>>()

export function refuseDirectMasterWrite(): never {
  throw new Error("learning cannot write the master")
}

function limitsOf(override: Partial<LearningLimits> | undefined): LearningLimits {
  return {
    maxProposalsPerWindow: override?.maxProposalsPerWindow ?? LEARNING_LIMITS.maxProposalsPerWindow,
    windowMs: override?.windowMs ?? LEARNING_LIMITS.windowMs,
    maxPayloadBytes: override?.maxPayloadBytes ?? LEARNING_LIMITS.maxPayloadBytes,
    maxEvidenceChars: override?.maxEvidenceChars ?? LEARNING_LIMITS.maxEvidenceChars,
    maxFieldChars: override?.maxFieldChars ?? LEARNING_LIMITS.maxFieldChars,
  }
}

function clock(deps: LearningDeps): Date {
  return deps.now ? deps.now() : new Date()
}

function assertOpen(deps: LearningDeps): void {
  if (!isP6LearningEnabled(deps.env ?? process.env)) throw new Error("learning governance is off")
  assertLearnersStopped(deps.posture)
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

function assertWritable(partition: string | undefined, entryKey: string): void {
  if ((partition ?? "mutable") !== "mutable" || IMMUTABLE_KEYS.has(entryKey)) {
    throw new Error("immutable master partition is not writable")
  }
}

function claimedClass(before: unknown, after: unknown): "cosmetic" | "substantive" {
  try {
    return effectiveClass(undefined, before, after) === "cosmetic" ? "cosmetic" : "substantive"
  } catch {
    return "substantive"
  }
}

async function observeBaseline(
  input: ProposeLearningInput,
  entryKey: string,
  store: MasterStore | undefined,
): Promise<{ changeClass: "cosmetic" | "substantive"; baseline: LearningProposalRecord["baseline"] }> {
  const claimed = claimedClass(input.before, input.after)
  if (!store) return { changeClass: claimed, baseline: "unobserved" }
  try {
    const snapshot = await store.currentSnapshot(input.firmId)
    const live = snapshot.entries[entryKey]?.body
    if (!baselineMatchesLive(live, input.before)) return { changeClass: "substantive", baseline: "unmatched" }
    const liveClass = claimedClass(live, input.after)
    const changeClass = claimed === "cosmetic" && liveClass === "cosmetic" ? "cosmetic" : "substantive"
    return { changeClass, baseline: "matched" }
  } catch {
    return { changeClass: "substantive", baseline: "unmatched" }
  }
}

async function assertCurrentBaseline(row: LearningProposalRecord, store: MasterStore): Promise<void> {
  if (row.baseline === "unmatched") throw new LearningStaleError()
  let live: unknown
  try {
    const snapshot = await store.currentSnapshot(row.firmId)
    live = snapshot.entries[row.entryKey]?.body
  } catch {
    throw new LearningStaleError()
  }
  if (!baselineMatchesLive(live, row.diff.before)) throw new LearningStaleError()
}

function redactEvidence(evidence: string): { evidence: string; evidencePii: boolean } {
  let masked: string
  try {
    masked = maskOutboundPII(evidence).masked
  } catch {
    throw new Error("learning proposal is not durable")
  }
  return { evidence: masked, evidencePii: masked !== evidence }
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) return false
    seen.add(value)
    return value.every((item) => isJsonValue(item, seen))
  }
  if (typeof value !== "object") return false
  if (seen.has(value)) return false
  seen.add(value)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  for (const key of Object.getOwnPropertyNames(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key)
    if (!desc || !("value" in desc) || desc.enumerable === false) return false
    if (!isJsonValue(desc.value, seen)) return false
  }
  return true
}

function fingerprintOf(row: Pick<LearningProposalRecord, "firmId" | "entryKey" | "source" | "classification" | "diff">): string {
  return payloadDigest({
    firmId: row.firmId,
    entryKey: row.entryKey,
    source: row.source,
    classification: row.classification,
    beforeMissing: row.diff.before === undefined,
    before: row.diff.before === undefined ? null : row.diff.before,
    after: row.diff.after,
  })
}

async function stillOpen(existing: LearningProposalRecord, store: MasterStore | undefined): Promise<boolean> {
  if (existing.status === "pending") return true
  if (existing.status !== "approved") return false
  if (!existing.sealedProposalId) return true
  if (!store) return false
  const sealed = await store.getProposal(existing.sealedProposalId)
  return sealed?.status === "pending" || sealed?.status === "approved"
}

async function exclusive<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  tails.set(
    key,
    previous.then(
      () => current,
      () => current,
    ),
  )
  await previous.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
  }
}

function assertPartner(actor: LearningActor, row: LearningProposalRecord): void {
  const decision = actor.decision as string
  if (decision !== "approved" && decision !== "rejected") refuseDirectMasterWrite()
  const actorKey = normalizeActorKey(actor.actorId)
  if (actor.kind !== "partner" || actor.role !== "partner" || actorKey === "") {
    throw new Error("learning decision requires a partner")
  }
  if (actor.firmId.trim() !== row.firmId) throw new Error("learning decision is for another firm")
  if (actorKey === normalizeActorKey(row.proposedBy)) throw new Error("approver must differ from proposer")
}

export async function proposeLearning(input: ProposeLearningInput, deps: LearningDeps): Promise<LearningProposalRecord> {
  return exclusive(deps.ledger, async () => {
    assertOpen(deps)
    if (!isClassification(input.classification)) throw new Error("artefact write omitted classification")
    const firmId = text(input.firmId)
    // TODO(W2-WIRE): take proposedBy and the deciding actor from the verified session. A caller-supplied id is not identity.
    const proposedBy = text(input.proposedBy)
    const entryKey = text(input.entryKey)
    if (!firmId || !proposedBy || !entryKey || normalizeActorKey(proposedBy) === "") {
      throw new Error("learning proposal omitted firm, author or entry")
    }
    const source = parseLearningSource(input.source)
    const rawEvidence = text(input.evidence)
    if (!rawEvidence) throw new Error("learning proposal omitted evidence")
    assertWritable(input.partition, entryKey)
    const limits = limitsOf(deps.limits)
    if (
      rawEvidence.length > limits.maxEvidenceChars ||
      firmId.length > limits.maxFieldChars ||
      proposedBy.length > limits.maxFieldChars ||
      entryKey.length > limits.maxFieldChars
    ) {
      throw new Error("learning proposal exceeds size cap")
    }
    const { evidence, evidencePii } = redactEvidence(rawEvidence)
    if (input.after === undefined || !isJsonValue(input.after) || (input.before !== undefined && !isJsonValue(input.before))) {
      throw new Error("learning proposal is not durable")
    }
    let encoded: string
    try {
      encoded = canonicalPayload({ before: input.before, after: input.after })
      structuredClone({ before: input.before, after: input.after, evidence })
    } catch {
      throw new Error("learning proposal is not durable")
    }
    if (Buffer.byteLength(encoded, "utf8") > limits.maxPayloadBytes) {
      throw new Error("learning proposal exceeds size cap")
    }
    const observed = await observeBaseline(input, entryKey, deps.store)
    const draft: LearningProposalRecord = {
      id: randomUUID(),
      firmId,
      proposedBy,
      source,
      evidence,
      evidencePii,
      entryKey,
      classification: input.classification,
      changeClass: observed.changeClass,
      baseline: observed.baseline,
      diff: { before: input.before, after: input.after },
      createdAt: clock(deps).toISOString(),
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      masterWrite: false,
      sealedProposalId: null,
    }
    const fingerprint = fingerprintOf(draft)
    const existing = await deps.ledger.findByFingerprint(fingerprint)
    if (existing && (await stillOpen(existing, deps.store))) return existing
    const allowed = await deps.ledger.consumeRate(
      `${firmId}\u0000${normalizeActorKey(proposedBy)}`,
      clock(deps).getTime(),
      limits.maxProposalsPerWindow,
      limits.windowMs,
    )
    if (!allowed) throw new Error("learning proposal rate limited")
    const saved = await deps.ledger.insert(draft, fingerprint)
    if (saved.masterWrite !== false || saved.status !== "pending") refuseDirectMasterWrite()
    return saved
  })
}

export async function decideLearning(id: string, actor: LearningActor, deps: LearningDeps): Promise<LearningProposalRecord> {
  return exclusive(deps.ledger, async () => {
    assertOpen(deps)
    const decision = actor.decision === "approved" ? "approved" : actor.decision === "rejected" ? "rejected" : refuseDirectMasterWrite()
    const row = await deps.ledger.get(id)
    if (!row) throw new Error("proposal not found")
    if (row.status !== "pending") throw new Error("proposal is not pending")
    assertPartner(actor, row)
    if (decision === "rejected") {
      const saved = await deps.ledger.compareAndSetStatus(id, "pending", {
        status: "rejected",
        decidedBy: actor.actorId,
        decidedAt: clock(deps).toISOString(),
        sealedProposalId: null,
      })
      if (!saved) throw new Error("proposal is not pending")
      if (saved.masterWrite !== false) refuseDirectMasterWrite()
      return saved
    }
    if (!deps.store) throw new Error("learning approval requires the master store")
    await assertCurrentBaseline(row, deps.store)
    let sealedProposalId = row.sealedProposalId
    if (!sealedProposalId) {
      const sealed = await proposeChange(
        {
          firmId: row.firmId,
          sourceModule: "L4.6",
          classification: row.classification,
          payload: learningBaselinePayload(row.diff.before, row.diff.after),
          proposedBy: row.proposedBy,
          changeClass: "substantive",
          partition: "mutable",
          entryKey: row.entryKey,
        },
        deps.store,
      )
      const noted = await deps.ledger.attachSealed(id, sealed.id)
      // The ledger points at the sealed row before that row is approved, so a retry does not insert another one.
      if (!noted) throw new Error("proposal is not pending")
      sealedProposalId = sealed.id
    }
    const existing = await deps.store.getProposal(sealedProposalId)
    if (!existing) throw new Error("proposal not found")
    if (existing.status === "pending") {
      await approveProposal(sealedProposalId, { actorId: actor.actorId, kind: "partner", role: "partner" }, deps.store)
    } else if (existing.status !== "approved") {
      throw new Error("proposal is not pending")
    }
    const saved = await deps.ledger.compareAndSetStatus(id, "pending", {
      status: "approved",
      decidedBy: actor.actorId,
      decidedAt: clock(deps).toISOString(),
      sealedProposalId,
    })
    if (!saved) throw new Error("proposal is not pending")
    if (saved.masterWrite !== false) refuseDirectMasterWrite()
    return saved
  })
}

export async function applyLearning(id: string, deps: LearningDeps): Promise<{ masterWritten: true; proposalId: string }> {
  return exclusive(deps.ledger, async () => {
    assertOpen(deps)
    if (!deps.store) throw new Error("learning approval requires the master store")
    const row = await deps.ledger.get(id)
    if (!row) throw new Error("proposal not found")
    await assertCurrentBaseline(row, deps.store)
    if (row.status !== "approved" || !row.sealedProposalId) throw new Error("proposal is not approved")
    const applied = await applyChange(row.sealedProposalId, deps.store)
    if (applied.masterWritten !== true) refuseDirectMasterWrite()
    return { masterWritten: true, proposalId: applied.proposalId }
  })
}
