/**
 * Durable master store (Layer 17 L17.5; Layer 18 §5.4: Postgres is the system of record).
 * The in-memory adapter is the test and local proof. createPgMasterStore talks to Postgres
 * as the p6_service role (009_p6_master.sql). Neither adapter reports a commit it did not finish.
 */
import { createHash, randomUUID } from "node:crypto"
import pg from "pg"
import { classificationRank, isClassification, type Classification } from "@/platform/p1/types"
import type { MasterWriteAuditEntry, MasterWriteSession, StagedMasterWrite } from "@/platform/p6/masterWrite"

export type MasterSnapshot = {
  entries: Record<
    string,
    {
      partition: "mutable"
      key: string
      body: unknown
      classification: string
    }
  >
}

export type MasterDiff = {
  key: string
  partition: "mutable" | "immutable"
  before: MasterSnapshot
  after: MasterSnapshot
}

export type VersionRow = {
  id: string
  firmId: string
  versionNo: number
  proposalId: string | null
  parentVersionId: string | null
  action: "apply" | "rollback"
  diff: MasterDiff
  snapshot: MasterSnapshot
  authorId: string
  authorKind: "partner" | "system"
  restoredFromVersionId: string | null
}

export type PersistedProposal = {
  id: string
  firmId: string
  sourceModule: string
  classification: Classification
  changeClass: "cosmetic" | "substantive"
  /** What the caller asked for. The server class is `changeClass` and is never lower than the diff. */
  requestedClass: "cosmetic" | "substantive" | null
  partition: "mutable" | "immutable"
  entryKey: string
  payload: unknown
  proposedBy: string
  status: "pending" | "approved" | "applied" | "rejected"
  decidedBy: string | null
  decidedKind: "partner" | "system" | null
  decidedRole: string | null
  declassify: boolean
  /** sha256 of the canonical payload. Set when the proposal is stored. Approval is bound to it. */
  payloadHash: string
}

export type CommitVersionInput = {
  firmId: string
  proposalId: string | null
  action: "apply" | "rollback"
  diff: MasterDiff
  snapshot: MasterSnapshot
  authorId: string
  authorKind: "partner" | "system"
  restoredFromVersionId: string | null
  proposal: PersistedProposal | null
  classification: string
  /** Version id read under the firm lock. Null when the firm has no version yet. */
  expectedBaseVersionId: string | null
}

export type CommitVersionResult = { committed: true; versionId: string } | { committed: false }

export interface MasterStore {
  readonly role: string
  insertProposal(row: PersistedProposal): Promise<PersistedProposal>
  getProposal(id: string): Promise<PersistedProposal | null>
  saveProposal(row: PersistedProposal): Promise<void>
  listVersions(firmId: string): Promise<VersionRow[]>
  getVersion(id: string): Promise<VersionRow | null>
  currentSnapshot(firmId: string): Promise<MasterSnapshot>
  currentClassification(firmId: string): Promise<Classification>
  /**
   * Writes the version, the current master snapshot and the proposal status in one transaction.
   * `committed: false` means the transaction was rolled back. A thrown error is the same fact.
   */
  commitVersion(input: CommitVersionInput): Promise<CommitVersionResult>
  /**
   * One write transaction. Memory: a mutex, restored if `fn` throws. Postgres: BEGIN, SET ROLE
   * p6_service, COMMIT, or ROLLBACK. The session's reads and writes share that transaction.
   */
  runExclusive<T>(fn: (tx: MasterSession) => Promise<T>): Promise<T>
}

export interface MasterSession {
  getProposal(id: string): Promise<PersistedProposal | null>
  currentSnapshot(firmId: string): Promise<MasterSnapshot>
  currentClassification(firmId: string): Promise<Classification>
  /** Locks the firm and returns the current version id, or null when the firm has none. */
  lockFirm(firmId: string): Promise<string | null>
  /**
   * Status transition from the CAS table only: pending → applied (cosmetic, system) and
   * approved → applied (decision fields unchanged). A transition into approved is refused.
   * False when the row is not in `fromStatus` (lost the race).
   */
  casProposal(row: PersistedProposal, fromStatus: PersistedProposal["status"]): Promise<boolean>
  /** The only pending → approved transition. Requires a different actor and partner attestation. */
  recordApproval(row: PersistedProposal): Promise<boolean>
  getVersion(id: string): Promise<VersionRow | null>
  commitVersion(input: CommitVersionInput): Promise<CommitVersionResult>
  allowDeclassify(on: boolean): Promise<void>
  /** Compares a caller-supplied proposal with the stored row. It does not write. */
  assertCommitShape(input: CommitVersionInput): Promise<void>
}

export const P6_ROLE = "p6_service"
export const EMPTY_SNAPSHOT: MasterSnapshot = { entries: {} }

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
  } else {
    for (const key of Object.getOwnPropertyNames(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key)
      if (desc && "value" in desc) deepFreeze(desc.value)
    }
  }
  return Object.freeze(value)
}

/** A new frozen empty snapshot. Callers must not share the module constant. */
function freshEmptySnapshot(): MasterSnapshot {
  return deepFreeze({ entries: {} })
}

const POLLUTING_KEYS = new Set(["__proto__", "constructor", "prototype"])

function ownDataValue(value: object, key: string): unknown {
  const desc = Object.getOwnPropertyDescriptor(value, key)
  if (!desc || !("value" in desc)) return undefined
  return desc.value
}

function canonicalValue(value: unknown, foldSpace: boolean): unknown {
  if (typeof value === "string") return foldSpace ? value.replace(/\s+/g, " ").trim() : value
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value ?? null
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, foldSpace))
  if (typeof value === "object") {
    const out = Object.create(null) as Record<string, unknown>
    const keys = Object.getOwnPropertyNames(value)
      .filter((key) => {
        const desc = Object.getOwnPropertyDescriptor(value, key)
        return !!desc && "value" in desc && desc.enumerable !== false
      })
      .sort()
    for (const key of keys) {
      Object.defineProperty(out, key, {
        value: canonicalValue(ownDataValue(value, key), foldSpace),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  }
  return null
}

/** True when a prototype-polluting key is an own property at any depth. */
export function payloadHasPollutingKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return value.some(payloadHasPollutingKey)
  for (const key of Object.getOwnPropertyNames(value)) {
    if (POLLUTING_KEYS.has(key)) return true
    if (payloadHasPollutingKey(ownDataValue(value, key))) return true
  }
  return false
}

/** Key-sorted JSON. Polluting keys stay in the text. Whitespace is collapsed when foldSpace is set. */
export function canonicalPayload(value: unknown, foldSpace = false): string {
  return JSON.stringify(canonicalValue(value, foldSpace))
}

export function payloadDigest(value: unknown): string {
  return createHash("sha256").update(canonicalPayload(value)).digest("hex")
}

function assertPayloadFrozen(current: PersistedProposal, next: PersistedProposal): void {
  if (canonicalPayload(current.payload) !== canonicalPayload(next.payload) || current.payloadHash !== next.payloadHash) {
    throw new Error("approved proposal payload is frozen")
  }
}

/**
 * CAS edges. pending → approved is not one of them.
 * That edge is recordApproval: partner kind, partner role, and an actor key that differs from the proposer.
 */
const PROPOSAL_CAS_TRANSITIONS: Record<PersistedProposal["status"], readonly PersistedProposal["status"][]> = {
  pending: ["applied"],
  approved: ["applied"],
  applied: [],
  rejected: [],
}

/**
 * Non-ASCII is rejected before NFKC, except the folds both engines already share:
 * default-ignorables, the trim set, ß/ẞ, U+A7F1, and fullwidth forms. U+0130 and
 * U+1CCD6–U+1CCF9 are outside that set, so neither engine can casefold them into a
 * different ASCII letter. No one-off folds. After the shared folds, a remaining
 * non-ASCII is still empty, and the result must be ^[a-z0-9._@-]+$.
 */
const ACTOR_KEY = /^[a-z0-9._@-]+$/

function rejectsActorKeyBeforeNfkc(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp <= 0x7f) continue
    if (cp === 0xdf || cp === 0x1e9e || cp === 0xa7f1) continue
    if (cp >= 0xff00 && cp <= 0xffef) continue
    if (cp === 0xa0 || cp === 0x1680 || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000) continue
    if (cp >= 0x2000 && cp <= 0x200a) continue
    if (/\p{Default_Ignorable_Code_Point}/u.test(ch)) continue
    return true
  }
  return false
}

export function normalizeActorKey(value: string): string {
  if (rejectsActorKeyBeforeNfkc(value)) return ""
  const prepared = value
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .trim()
    .replace(/\u1E9E/g, "ss")
    .replace(/\u00df/g, "ss")
  if ([...prepared].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)) return ""
  const folded = prepared.toLowerCase()
  return ACTOR_KEY.test(folded) ? folded : ""
}

function isDirectApproval(current: PersistedProposal | undefined, next: PersistedProposal): boolean {
  if (next.status === "approved") return true
  if (next.decidedKind === "partner" && current?.decidedKind !== "partner") return true
  if (next.decidedRole === "partner" && current?.decidedRole !== "partner") return true
  if (next.declassify && current?.declassify !== true) return true
  return false
}

function assertNewProposal(row: PersistedProposal): void {
  if (row.status !== "pending" || row.decidedBy !== null || row.decidedKind !== null || row.decidedRole !== null || row.declassify) {
    throw new Error("new proposals are pending")
  }
}

function assertNoApprovalStamp(row: PersistedProposal): void {
  if (row.decidedBy !== null || row.decidedKind !== null || row.decidedRole !== null || row.declassify) {
    throw new Error("approval is not a direct status change")
  }
}

function assertProposedByUnchanged(current: PersistedProposal, row: PersistedProposal): void {
  if (row.proposedBy !== current.proposedBy) throw new Error("proposedBy is immutable")
}

/** Columns the proposal-transition trigger freezes on every update, including a pending row. */
function assertFrozenColumns(current: PersistedProposal, next: PersistedProposal): void {
  if (
    next.changeClass !== current.changeClass ||
    next.requestedClass !== current.requestedClass ||
    next.firmId !== current.firmId ||
    next.entryKey !== current.entryKey ||
    next.classification !== current.classification ||
    next.sourceModule !== current.sourceModule ||
    next.partition !== current.partition ||
    next.id !== current.id
  ) {
    throw new Error("approved proposal payload is frozen")
  }
}

function assertCommitBound(input: CommitVersionInput): void {
  if (!input.proposal) return
  if (input.proposalId !== input.proposal.id || input.firmId !== input.proposal.firmId) {
    throw new Error("commit is bound to the proposal")
  }
}

function assertDecisionUnchanged(current: PersistedProposal, next: PersistedProposal): void {
  if (
    next.decidedBy !== current.decidedBy ||
    next.decidedKind !== current.decidedKind ||
    next.decidedRole !== current.decidedRole ||
    next.declassify !== current.declassify
  ) {
    throw new Error("approval is not a direct status change")
  }
}

function assertCommitProposal(current: PersistedProposal | undefined, next: PersistedProposal): void {
  if (!current) throw new Error("proposal not found")
  assertCommitLeavesApprovalAlone(current, next)
  assertProposedByUnchanged(current, next)
  assertPayloadFrozen(current, next)
  assertFrozenColumns(current, next)
  assertDecisionUnchanged(current, next)
}

function assertCasShape(current: PersistedProposal, next: PersistedProposal): void {
  if (current.status === "pending" && next.status === "applied") {
    if (
      current.changeClass !== "cosmetic" ||
      next.changeClass !== "cosmetic" ||
      next.decidedKind !== "system" ||
      next.decidedRole !== "system" ||
      next.decidedBy !== "p6" ||
      next.declassify
    ) {
      throw new Error("proposal status transition is refused")
    }
    return
  }
  if (current.status === "approved" && next.status === "applied") {
    const approver = normalizeActorKey(current.decidedBy ?? "")
    if (
      next.decidedBy !== current.decidedBy ||
      next.decidedKind !== current.decidedKind ||
      next.decidedRole !== current.decidedRole ||
      next.declassify !== current.declassify ||
      next.changeClass !== current.changeClass ||
      (current.changeClass === "substantive" &&
        (current.decidedKind !== "partner" ||
          current.decidedRole !== "partner" ||
          approver === "" ||
          approver === normalizeActorKey(current.proposedBy)))
    ) {
      throw new Error("proposal status transition is refused")
    }
    return
  }
  throw new Error("proposal status transition is refused")
}

function assertPartnerApproval(current: PersistedProposal, next: PersistedProposal): void {
  assertPayloadFrozen(current, next)
  if (current.status !== "pending" || next.status !== "approved") throw new Error("proposal is not pending")
  if (current.changeClass !== "substantive" || next.changeClass !== "substantive") {
    throw new Error("cosmetic proposals are not partner-approved")
  }
  if (next.decidedKind !== "partner" || next.decidedRole !== "partner") {
    throw new Error("substantive proposal requires partner approval")
  }
  const approver = normalizeActorKey(next.decidedBy ?? "")
  const proposer = normalizeActorKey(current.proposedBy)
  if (proposer === "") throw new Error("proposer key missing")
  if (approver === "") throw new Error("substantive proposal requires partner approval")
  if (approver === proposer) throw new Error("approver must differ from proposer")
  if (
    next.proposedBy !== current.proposedBy ||
    next.firmId !== current.firmId ||
    next.entryKey !== current.entryKey ||
    next.partition !== current.partition ||
    next.classification !== current.classification ||
    next.sourceModule !== current.sourceModule
  ) {
    throw new Error("approved proposal payload is frozen")
  }
}

function assertCommitLeavesApprovalAlone(current: PersistedProposal | undefined, next: PersistedProposal): void {
  if (isDirectApproval(current, next)) throw new Error("approval is not a direct status change")
  if (!current) {
    if (next.status !== "pending") throw new Error("new proposals are pending")
    return
  }
  if (current.status !== next.status) throw new Error("proposal status transition is refused")
}

function refuseDirectCas(current: PersistedProposal | undefined, row: PersistedProposal, fromStatus: PersistedProposal["status"]): void {
  if (isDirectApproval(current, row)) throw new Error("approval is not a direct status change")
  if (!PROPOSAL_CAS_TRANSITIONS[fromStatus].includes(row.status)) {
    throw new Error("proposal status transition is refused")
  }
}

type MemoryState = {
  proposals: Map<string, PersistedProposal>
  versions: VersionRow[]
  heads: Map<string, MasterSnapshot>
  classes: Map<string, Classification>
}

type RawWrite = {
  allowDeclassify(on: boolean): Promise<void>
  save?(input: CommitVersionInput): Promise<CommitVersionResult>
  stageAfterCommit?(staged: StagedMasterWrite): void
  pgClient?: pg.PoolClient
  getProposal(id: string): Promise<PersistedProposal | null>
  getVersion(id: string): Promise<VersionRow | null>
  currentSnapshot(firmId: string): Promise<MasterSnapshot>
  currentClassification(firmId: string): Promise<Classification>
  lockFirm(firmId: string): Promise<string | null>
  assertCommitShape(input: CommitVersionInput): Promise<void>
}

const sealedHandles = new WeakMap<object, RawWrite>()

function seal(session: object, raw: RawWrite): void {
  sealedHandles.set(session, raw)
}

function retire(session: object): void {
  sealedHandles.delete(session)
}

function sameDocument(left: unknown, right: unknown): boolean {
  return canonicalPayload(left) === canonicalPayload(right)
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

async function markApplied(client: pg.PoolClient, stored: PersistedProposal): Promise<void> {
  if (stored.status === "applied") return
  if (stored.status === "pending") {
    const updated = await client.query(
      `UPDATE change_proposals
          SET status = 'applied', decided_by = 'p6', decided_kind = 'system', decided_role = 'system'
        WHERE id = $1 AND status = 'pending'`,
      [stored.id],
    )
    if ((updated.rowCount ?? 0) !== 1) throw new Error("proposal status changed")
    return
  }
  if (stored.status === "approved") {
    const updated = await client.query(
      `UPDATE change_proposals SET status = 'applied' WHERE id = $1 AND status = 'approved'`,
      [stored.id],
    )
    if ((updated.rowCount ?? 0) !== 1) throw new Error("proposal status changed")
  }
}

async function insertMasterVersion(client: pg.PoolClient, input: CommitVersionInput, versionId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`p6:${input.firmId}`])
  const prior = await client.query<{ version_no: number; id: string }>(
    `SELECT version_no, id FROM master_versions
      WHERE firm_id = $1 ORDER BY version_no DESC LIMIT 1`,
    [input.firmId],
  )
  const parent = prior.rows[0]
  if ((parent?.id ?? null) !== input.expectedBaseVersionId) throw new Error("master version conflict")
  const versionNo = (parent?.version_no ?? 0) + 1
  await client.query(
    `INSERT INTO master_versions
       (id, firm_id, version_no, proposal_id, parent_version_id, action, diff, snapshot,
        author_id, author_kind, restored_from_version_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
    [
      versionId,
      input.firmId,
      versionNo,
      input.proposalId,
      parent?.id ?? null,
      input.action,
      JSON.stringify(input.diff),
      JSON.stringify(input.snapshot),
      input.authorId,
      input.authorKind,
      input.restoredFromVersionId,
    ],
  )
  const written = await client.query(
    `INSERT INTO master_knowledge (firm_id, snapshot, classification, version_id)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (firm_id) DO UPDATE
       SET snapshot = EXCLUDED.snapshot,
           classification = EXCLUDED.classification,
           version_id = EXCLUDED.version_id
       WHERE master_knowledge.version_id IS NOT DISTINCT FROM $5
     RETURNING firm_id`,
    [input.firmId, JSON.stringify(input.snapshot), input.classification, versionId, input.expectedBaseVersionId],
  )
  if ((written.rowCount ?? 0) !== 1) throw new Error("master version conflict")
}

async function assertStoredWrite(
  input: CommitVersionInput,
  raw: RawWrite,
  gate: { declassify: boolean },
  rules: {
    effectiveClass: typeof import("@/platform/p6/masterWrite").effectiveClass
    nextSnapshot: typeof import("@/platform/p6/masterWrite").nextSnapshot
  },
): Promise<{ declassify: boolean; stored: PersistedProposal | null }> {
  const locked = await raw.lockFirm(input.firmId)
  if ((locked ?? null) !== input.expectedBaseVersionId) throw new Error("master version conflict")
  const current = await raw.currentSnapshot(input.firmId)
  if (!sameDocument(input.diff.before, current)) throw new Error("commit is bound to the proposal")
  if (input.action === "rollback") {
    if (input.proposalId !== null || input.proposal) throw new Error("proposal not found")
    if (!input.restoredFromVersionId) throw new Error("version not found")
    const target = await raw.getVersion(input.restoredFromVersionId)
    if (!target || target.firmId !== input.firmId) throw new Error("version not found")
    if (!sameDocument(input.snapshot, target.snapshot)) throw new Error("commit is bound to the proposal")
    if (input.authorKind !== "partner" || normalizeActorKey(input.authorId) === "") {
      throw new Error("substantive proposal requires partner approval")
    }
    const targetClass = snapshotClass(target.snapshot, "internal")
    const currentClass = await raw.currentClassification(input.firmId)
    const classification = gate.declassify ? targetClass : higherClass(currentClass, targetClass)
    if (input.classification !== classification) throw new Error("commit is bound to the proposal")
    return { declassify: gate.declassify, stored: null }
  }
  if (!input.proposalId) throw new Error("proposal not found")
  const stored = await raw.getProposal(input.proposalId)
  if (!stored || stored.firmId !== input.firmId) throw new Error("commit is bound to the proposal")
  const { masterBody, sealedBaselineMatches } = await import("@/platform/p6/learning/baseline")
  const { isSealedVoid } = await import("@/platform/p6/learning/sealedVoid")
  const { LearningStaleError } = await import("@/platform/p6/learning/stale")
  if (isSealedVoid(stored.id)) throw new Error("sealed proposal is void")
  const liveBody = current.entries[stored.entryKey]?.body
  if (!sealedBaselineMatches(liveBody, stored.payload, stored.sourceModule)) {
    throw new LearningStaleError()
  }
  const writtenBody = masterBody(stored.payload, stored.sourceModule)
  const liveClass = rules.effectiveClass(stored.requestedClass, liveBody, writtenBody)
  const substantive = liveClass === "substantive" || stored.changeClass === "substantive"
  const expected = rules.nextSnapshot(current, stored)
  if (!sameDocument(input.snapshot, expected) || !sameDocument(input.diff.after, input.snapshot)) {
    throw new Error("commit is bound to the proposal")
  }
  if (input.diff.key !== stored.entryKey) throw new Error("commit is bound to the proposal")
  if (substantive) {
    if (
      (stored.status !== "approved" && stored.status !== "applied") ||
      stored.decidedKind !== "partner" ||
      stored.decidedRole !== "partner" ||
      !stored.decidedBy ||
      input.authorKind !== "partner" ||
      input.authorId !== stored.decidedBy
    ) {
      throw new Error("substantive proposal requires partner approval")
    }
    const approver = normalizeActorKey(input.authorId)
    const proposer = normalizeActorKey(stored.proposedBy)
    if (proposer === "") throw new Error("proposer key missing")
    if (approver === "" || approver === proposer) throw new Error("approver must differ from proposer")
  } else if (stored.changeClass === "cosmetic" && liveClass === "cosmetic") {
    if (stored.status !== "pending" && stored.status !== "applied") throw new Error("cosmetic proposal is not pending")
    if (input.authorKind !== "system" || input.authorId !== "p6") throw new Error("cosmetic proposal is not pending")
  } else {
    throw new Error("substantive proposal requires partner approval")
  }
  const classification = snapshotClass(input.snapshot, stored.classification)
  if (input.classification !== classification) throw new Error("commit is bound to the proposal")
  return { declassify: stored.declassify === true, stored }
}

const masterAudit: MasterWriteAuditEntry[] = []
const appliedProposalIds = new Set<string>()
const applyTails = new Map<string, Promise<void>>()

/** Read API. The publisher that appends a committed entry is not exported. */
export function masterWriteAuditLog(): readonly MasterWriteAuditEntry[] {
  return masterAudit.slice()
}

function publishStagedMasterWrites(staged: readonly StagedMasterWrite[]): void {
  for (const item of staged) {
    if (item.proposalId) appliedProposalIds.add(item.proposalId)
    masterAudit.push(item.entry)
  }
}

async function runOneApply<T>(proposalId: string | null, fn: () => Promise<T>): Promise<T> {
  if (!proposalId) return fn()
  const previous = applyTails.get(proposalId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  applyTails.set(proposalId, tail)
  await previous
  try {
    if (appliedProposalIds.has(proposalId)) throw new Error("proposal is already applied")
    return await fn()
  } finally {
    release()
    if (applyTails.get(proposalId) === tail) applyTails.delete(proposalId)
  }
}

export async function writeMaster(
  input: CommitVersionInput,
  session: object,
  gate: { declassify: boolean },
): Promise<CommitVersionResult> {
  const { effectiveClass, nextSnapshot } = await import("@/platform/p6/masterWrite")
  return runOneApply(input.action === "apply" ? input.proposalId : null, async () => {
    const raw = sealedHandles.get(session)
    if (!raw) throw new Error("master session is closed")
    await raw.assertCommitShape(input)
    const bound = await assertStoredWrite(input, raw, gate, { effectiveClass, nextSnapshot })
    await raw.allowDeclassify(bound.declassify)
    let outcome: CommitVersionResult
    if (raw.pgClient) {
      if (bound.stored && bound.stored.status !== "applied") await markApplied(raw.pgClient, bound.stored)
      const versionId = randomUUID()
      await insertMasterVersion(raw.pgClient, input, versionId)
      outcome = { committed: true, versionId }
    } else if (raw.save) {
      outcome = await raw.save(input)
    } else {
      throw new Error("master session is closed")
    }
    if (!outcome.committed) return outcome
    const staged: StagedMasterWrite = {
      proposalId: input.action === "apply" ? input.proposalId : null,
      entry: {
        action: input.action,
        firmId: input.firmId,
        proposalId: input.proposalId,
        actorId: input.authorId,
        versionId: outcome.versionId,
        outcome: "committed",
      },
    }
    if (raw.stageAfterCommit) raw.stageAfterCommit(staged)
    else publishStagedMasterWrites([staged])
    return outcome
  })
}

async function guardedWrite(session: MasterWriteSession, input: CommitVersionInput): Promise<CommitVersionResult> {
  return writeMaster(input, session, { declassify: input.proposal?.declassify === true })
}

function publishStaged(staged: readonly StagedMasterWrite[]): void {
  if (staged.length === 0) return
  publishStagedMasterWrites(staged)
}

function cloneState(state: MemoryState): MemoryState {
  return {
    proposals: new Map(structuredClone([...state.proposals.entries()])),
    versions: structuredClone(state.versions),
    heads: new Map(structuredClone([...state.heads.entries()])),
    classes: new Map(state.classes),
  }
}

export class InMemoryMasterStore implements MasterStore {
  readonly role: string
  #state: MemoryState = { proposals: new Map(), versions: [], heads: new Map(), classes: new Map() }
  #failCommit: "throw" | "uncommitted" | "commit" | undefined
  #gate: Promise<void> = Promise.resolve()
  readonly #dead = new WeakSet<object>()

  constructor(options: { role: string; failCommit?: "throw" | "uncommitted" | "commit" }) {
    this.role = options.role
    this.#failCommit = options.failCommit
  }

  async runExclusive<T>(fn: (tx: MasterSession) => Promise<T>): Promise<T> {
    const previous = this.#gate
    let release!: () => void
    this.#gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    const snap = cloneState(this.#state)
    const staged: StagedMasterWrite[] = []
    const raw = this.#rawSession(staged)
    const tx = this.#publicSession()
    try {
      await seal(tx, raw)
      const result = await fn(tx)
      if (this.#failCommit === "commit" && staged.length > 0) {
        this.#failCommit = undefined
        throw new Error("master write did not commit")
      }
      await publishStaged(staged)
      return result
    } catch (error) {
      this.#state = snap
      throw error
    } finally {
      await this.#endSession(tx)
      release()
    }
  }

  #assertLive(session: object): void {
    if (this.#dead.has(session)) throw new Error("master session is closed")
  }

  #endSession(session: object): void {
    this.#dead.add(session)
    retire(session)
  }

  #rawSession(staged: StagedMasterWrite[]): RawWrite {
    return {
      allowDeclassify: async () => {},
      stageAfterCommit: (item) => {
        staged.push(item)
      },
      save: (input) => this.#saveVersion(input),
      getProposal: async (id) => this.#proposal(id),
      getVersion: async (id) => this.#version(id),
      currentSnapshot: async (firmId) => this.#snapshot(firmId),
      currentClassification: async (firmId) => this.#classification(firmId),
      lockFirm: async (firmId) => this.#firmHead(firmId),
      assertCommitShape: async (input) => {
        if (!input.proposal) return
        assertCommitProposal(this.#state.proposals.get(input.proposal.id), input.proposal)
        assertCommitBound(input)
      },
    }
  }

  #publicSession(): MasterSession {
    const tx: MasterSession = {
      getProposal: async (id) => {
        this.#assertLive(tx)
        return this.getProposal(id)
      },
      currentSnapshot: async (firmId) => {
        this.#assertLive(tx)
        return this.currentSnapshot(firmId)
      },
      currentClassification: async (firmId) => {
        this.#assertLive(tx)
        return this.currentClassification(firmId)
      },
      lockFirm: async (firmId) => {
        this.#assertLive(tx)
        return this.lockFirm(firmId)
      },
      casProposal: async (row, fromStatus) => {
        this.#assertLive(tx)
        return this.casProposal(row, fromStatus)
      },
      recordApproval: async (row) => {
        this.#assertLive(tx)
        return this.recordApproval(row)
      },
      getVersion: async (id) => {
        this.#assertLive(tx)
        return this.getVersion(id)
      },
      allowDeclassify: async (on) => {
        this.#assertLive(tx)
        return this.allowDeclassify(on)
      },
      assertCommitShape: async (input) => {
        this.#assertLive(tx)
        if (!input.proposal) return
        assertCommitProposal(this.#state.proposals.get(input.proposal.id), input.proposal)
        assertCommitBound(input)
      },
      commitVersion: async (input) => {
        this.#assertLive(tx)
        this.#assertRole()
        return guardedWrite(tx, input)
      },
    }
    return tx
  }

  #proposal(id: string): PersistedProposal | null {
    const row = this.#state.proposals.get(id)
    return row ? structuredClone(row) : null
  }

  #snapshot(firmId: string): MasterSnapshot {
    return structuredClone(this.#state.heads.get(firmId) ?? EMPTY_SNAPSHOT)
  }

  #version(id: string): VersionRow | null {
    const row = this.#state.versions.find((item) => item.id === id)
    return row ? structuredClone(row) : null
  }

  #classification(firmId: string): Classification {
    return this.#state.classes.get(firmId) ?? "internal"
  }

  #firmHead(firmId: string): string | null {
    const versions = this.#state.versions.filter((row) => row.firmId === firmId)
    return versions[versions.length - 1]?.id ?? null
  }

  async lockFirm(firmId: string): Promise<string | null> {
    return this.#firmHead(firmId)
  }

  async casProposal(row: PersistedProposal, fromStatus: PersistedProposal["status"]): Promise<boolean> {
    this.#assertRole()
    const current = this.#state.proposals.get(row.id)
    refuseDirectCas(current, row, fromStatus)
    if (!current || current.status !== fromStatus) return false
    assertCasShape(current, row)
    assertProposedByUnchanged(current, row)
    assertPayloadFrozen(current, row)
    assertFrozenColumns(current, row)
    const next = structuredClone(row)
    next.payload = structuredClone(current.payload)
    next.payloadHash = current.payloadHash
    this.#state.proposals.set(row.id, next)
    return true
  }

  async recordApproval(row: PersistedProposal): Promise<boolean> {
    this.#assertRole()
    const current = this.#state.proposals.get(row.id)
    if (!current || current.status !== "pending") return false
    assertPartnerApproval(current, row)
    const next = structuredClone(row)
    next.status = "approved"
    next.payload = structuredClone(current.payload)
    next.payloadHash = current.payloadHash
    this.#state.proposals.set(row.id, next)
    return true
  }

  async allowDeclassify(_on: boolean): Promise<void> {}

  async currentClassification(firmId: string): Promise<Classification> {
    return this.#classification(firmId)
  }

  #assertRole(): void {
    if (this.role !== P6_ROLE) throw new Error("non-P6 writer refused")
  }

  async insertProposal(row: PersistedProposal): Promise<PersistedProposal> {
    this.#assertRole()
    assertNewProposal(row)
    if (this.#state.proposals.has(row.id)) throw new Error(`proposal id already exists: ${row.id}`)
    const saved = structuredClone(row)
    saved.payloadHash = payloadDigest(saved.payload)
    this.#state.proposals.set(saved.id, saved)
    return structuredClone(saved)
  }

  async getProposal(id: string): Promise<PersistedProposal | null> {
    return this.#proposal(id)
  }

  async saveProposal(row: PersistedProposal): Promise<void> {
    this.#assertRole()
    if (row.status !== "pending") throw new Error("save refuses a status other than pending")
    assertNoApprovalStamp(row)
    const current = this.#state.proposals.get(row.id)
    if (!current) throw new Error("proposal not found")
    if (current.status !== "pending") throw new Error("save refuses a status other than pending")
    assertProposedByUnchanged(current, row)
    assertPayloadFrozen(current, row)
    assertFrozenColumns(current, row)
    const next = structuredClone(row)
    next.payload = structuredClone(current.payload)
    next.payloadHash = current.payloadHash
    this.#state.proposals.set(row.id, next)
  }

  async listVersions(firmId: string): Promise<VersionRow[]> {
    return this.#state.versions.filter((row) => row.firmId === firmId).map((row) => structuredClone(row))
  }

  async getVersion(id: string): Promise<VersionRow | null> {
    return this.#version(id)
  }

  async currentSnapshot(firmId: string): Promise<MasterSnapshot> {
    return this.#snapshot(firmId)
  }

  async commitVersion(input: CommitVersionInput): Promise<CommitVersionResult> {
    this.#assertRole()
    const staged: StagedMasterWrite[] = []
    const tx = this.#publicSession()
    try {
      seal(tx, this.#rawSession(staged))
      const outcome = await guardedWrite(tx, input)
      if (outcome.committed) await publishStaged(staged)
      return outcome
    } finally {
      await this.#endSession(tx)
    }
  }

  async #saveVersion(input: CommitVersionInput): Promise<CommitVersionResult> {
    const snap = cloneState(this.#state)
    try {
      const firmVersions = this.#state.versions.filter((row) => row.firmId === input.firmId)
      const parent = firmVersions[firmVersions.length - 1] ?? null
      if ((parent?.id ?? null) !== input.expectedBaseVersionId) {
        throw new Error("master version conflict")
      }
      if (input.proposalId && firmVersions.some((row) => row.proposalId === input.proposalId)) {
        throw new Error("proposal already has a version")
      }
      const version: VersionRow = {
        id: randomUUID(),
        firmId: input.firmId,
        versionNo: (parent?.versionNo ?? 0) + 1,
        proposalId: input.proposalId,
        parentVersionId: parent?.id ?? null,
        action: input.action,
        diff: structuredClone(input.diff),
        snapshot: structuredClone(input.snapshot),
        authorId: input.authorId,
        authorKind: input.authorKind,
        restoredFromVersionId: input.restoredFromVersionId,
      }
      this.#state.versions.push(version)
      this.#state.heads.set(input.firmId, structuredClone(input.snapshot))
      if (isClassification(input.classification)) this.#state.classes.set(input.firmId, input.classification)
      if (input.action === "apply" && input.proposalId) {
        const row = this.#state.proposals.get(input.proposalId)
        if (row && row.status !== "applied") {
          if (row.status === "pending") {
            row.decidedBy = "p6"
            row.decidedKind = "system"
            row.decidedRole = "system"
          }
          row.status = "applied"
        }
      }
      if (this.#failCommit === "throw") {
        this.#state = snap
        throw new Error("master write did not commit")
      }
      if (this.#failCommit === "uncommitted") {
        this.#state = snap
        return { committed: false }
      }
      return { committed: true, versionId: version.id }
    } catch (error) {
      this.#state = snap
      throw error
    }
  }
}

type VersionQueryRow = {
  id: string
  firm_id: string
  version_no: number
  proposal_id: string | null
  parent_version_id: string | null
  action: "apply" | "rollback"
  diff: MasterDiff
  snapshot: MasterSnapshot
  author_id: string
  author_kind: "partner" | "system"
  restored_from_version_id: string | null
}

type ProposalQueryRow = {
  id: string
  firm_id: string
  source_module: string
  classification: Classification
  change_class: "cosmetic" | "substantive"
  partition: "mutable" | "immutable"
  entry_key: string
  payload: unknown
  proposed_by: string
  status: PersistedProposal["status"]
  decided_by: string | null
  decided_kind: PersistedProposal["decidedKind"]
  decided_role: string | null
  requested_class: PersistedProposal["requestedClass"]
  declassify: boolean
  payload_hash: string
}

function versionFromRow(row: VersionQueryRow): VersionRow {
  return {
    id: row.id,
    firmId: row.firm_id,
    versionNo: row.version_no,
    proposalId: row.proposal_id,
    parentVersionId: row.parent_version_id,
    action: row.action,
    diff: row.diff,
    snapshot: row.snapshot,
    authorId: row.author_id,
    authorKind: row.author_kind,
    restoredFromVersionId: row.restored_from_version_id,
  }
}

function proposalFromRow(row: ProposalQueryRow): PersistedProposal {
  return {
    id: row.id,
    firmId: row.firm_id,
    sourceModule: row.source_module,
    classification: row.classification,
    changeClass: row.change_class,
    partition: row.partition,
    entryKey: row.entry_key,
    payload: row.payload,
    proposedBy: row.proposed_by,
    status: row.status,
    decidedBy: row.decided_by,
    decidedKind: row.decided_kind,
    decidedRole: row.decided_role,
    requestedClass: row.requested_class,
    declassify: row.declassify,
    payloadHash: row.payload_hash,
  }
}

const PROPOSAL_COLUMNS = `id, firm_id, source_module, classification, change_class, partition, entry_key,
  payload, proposed_by, status, decided_by, decided_kind, decided_role, requested_class, declassify, payload_hash`

/**
 * Postgres adapter. Every call sets the session role to p6_service for that transaction.
 * The migration's grants and writer trigger refuse any other role. A failed commit throws;
 * the caller must not treat that as masterWritten.
 */
export function createPgMasterStore(pool: pg.Pool): MasterStore {
  const dead = new WeakSet<object>()

  function assertLive(session: object): void {
    if (dead.has(session)) throw new Error("master session is closed")
  }

  async function endPgSession(session: object): Promise<void> {
    dead.add(session)
    await retire(session)
  }

  async function withRole<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SET LOCAL ROLE p6_service")
      const result = await fn(client)
      await client.query("COMMIT")
      return result
    } catch (error) {
      try {
        await client.query("ROLLBACK")
      } catch {
        // The original error is the one the caller must see.
      }
      throw error
    } finally {
      client.release()
    }
  }

  return {
    role: P6_ROLE,

    async insertProposal(row) {
      assertNewProposal(row)
      await withRole(async (client) => {
        const existing = await client.query(`SELECT 1 FROM change_proposals WHERE id = $1`, [row.id])
        if ((existing.rowCount ?? 0) > 0) throw new Error(`proposal id already exists: ${row.id}`)
        await client.query(
          `INSERT INTO change_proposals
             (id, firm_id, source_module, classification, change_class, partition, entry_key,
              payload, proposed_by, status, decided_by, decided_kind, decided_role, requested_class, declassify,
              payload_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            row.id,
            row.firmId,
            row.sourceModule,
            row.classification,
            row.changeClass,
            row.partition,
            row.entryKey,
            JSON.stringify(canonicalValue(row.payload, false)),
            row.proposedBy,
            row.status,
            row.decidedBy,
            row.decidedKind,
            row.decidedRole,
            row.requestedClass,
            row.declassify,
            payloadDigest(row.payload),
          ],
        )
      })
      return { ...row, payloadHash: payloadDigest(row.payload) }
    },

    async getProposal(id) {
      return withRole(async (client) => {
        const found = await client.query<ProposalQueryRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM change_proposals WHERE id = $1`,
          [id],
        )
        const row = found.rows[0]
        return row ? proposalFromRow(row) : null
      })
    },

    async saveProposal(row) {
      if (row.status !== "pending") throw new Error("save refuses a status other than pending")
      assertNoApprovalStamp(row)
      const updated = await withRole(async (client) => {
        const found = await client.query<ProposalQueryRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM change_proposals WHERE id = $1 FOR UPDATE`,
          [row.id],
        )
        const current = found.rows[0]
        if (!current) return 0
        if (current.status !== "pending") throw new Error("save refuses a status other than pending")
        const stored = proposalFromRow(current)
        assertProposedByUnchanged(stored, row)
        assertPayloadFrozen(stored, row)
        assertFrozenColumns(stored, row)
        const result = await client.query(
          `UPDATE change_proposals
              SET status = $2, decided_by = $3, decided_kind = $4, decided_role = $5
            WHERE id = $1`,
          [row.id, row.status, row.decidedBy, row.decidedKind, row.decidedRole],
        )
        return result.rowCount ?? 0
      })
      if (updated !== 1) throw new Error("proposal not found")
    },

    async listVersions(firmId) {
      return withRole(async (client) => {
        const found = await client.query<VersionQueryRow>(
          `SELECT id, firm_id, version_no, proposal_id, parent_version_id, action, diff, snapshot,
                  author_id, author_kind, restored_from_version_id
             FROM master_versions WHERE firm_id = $1 ORDER BY version_no`,
          [firmId],
        )
        return found.rows.map(versionFromRow)
      })
    },

    async getVersion(id) {
      return withRole(async (client) => {
        const found = await client.query<VersionQueryRow>(
          `SELECT id, firm_id, version_no, proposal_id, parent_version_id, action, diff, snapshot,
                  author_id, author_kind, restored_from_version_id
             FROM master_versions WHERE id = $1`,
          [id],
        )
        const row = found.rows[0]
        return row ? versionFromRow(row) : null
      })
    },

    async currentSnapshot(firmId) {
      return withRole(async (client) => {
        const found = await client.query<{ snapshot: MasterSnapshot }>(
          `SELECT snapshot FROM master_knowledge WHERE firm_id = $1`,
          [firmId],
        )
        return found.rows[0]?.snapshot ?? freshEmptySnapshot()
      })
    },

    async currentClassification(firmId) {
      return withRole(async (client) => readClassification(client, firmId))
    },

    async commitVersion(input) {
      const staged: StagedMasterWrite[] = []
      try {
        const outcome = await withRole(async (client) => {
          const tx = await openSession(client, staged)
          try {
            return await guardedWrite(tx, input)
          } finally {
            await endPgSession(tx)
          }
        })
        await publishStaged(staged)
        return outcome
      } catch (error) {
        throw commitError(error)
      }
    },

    async runExclusive(fn) {
      const client = await pool.connect()
      const staged: StagedMasterWrite[] = []
      let tx: MasterSession | undefined
      try {
        await client.query("BEGIN")
        await client.query("SET LOCAL ROLE p6_service")
        tx = await openSession(client, staged)
        const result = await fn(tx)
        await client.query("COMMIT")
        await publishStaged(staged)
        return result
      } catch (error) {
        try {
          await client.query("ROLLBACK")
        } catch {
          // The original error is the one the caller must see.
        }
        throw error
      } finally {
        if (tx) await endPgSession(tx)
        client.release()
      }
    },
  }

  async function openSession(client: pg.PoolClient, staged: StagedMasterWrite[]): Promise<MasterSession> {
    const raw = pgRaw(client, staged)
    const tx: MasterSession = {
      async getProposal(id) {
        assertLive(tx)
        const found = await client.query<ProposalQueryRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM change_proposals WHERE id = $1 FOR UPDATE`,
          [id],
        )
        const row = found.rows[0]
        return row ? proposalFromRow(row) : null
      },
      async currentSnapshot(firmId) {
        assertLive(tx)
        const found = await client.query<{ snapshot: MasterSnapshot }>(
          `SELECT snapshot FROM master_knowledge WHERE firm_id = $1`,
          [firmId],
        )
        return found.rows[0]?.snapshot ?? freshEmptySnapshot()
      },
      async currentClassification(firmId) {
        assertLive(tx)
        return readClassification(client, firmId)
      },
      async getVersion(id) {
        assertLive(tx)
        const found = await client.query<VersionQueryRow>(
          `SELECT id, firm_id, version_no, proposal_id, parent_version_id, action, diff, snapshot,
                  author_id, author_kind, restored_from_version_id
             FROM master_versions WHERE id = $1`,
          [id],
        )
        const row = found.rows[0]
        return row ? versionFromRow(row) : null
      },
      async lockFirm(firmId) {
        assertLive(tx)
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`p6:${firmId}`])
        const found = await client.query<{ version_id: string }>(
          `SELECT version_id FROM master_knowledge WHERE firm_id = $1 FOR UPDATE`,
          [firmId],
        )
        return found.rows[0]?.version_id ?? null
      },
      async casProposal(row, fromStatus) {
        assertLive(tx)
        const found = await client.query<ProposalQueryRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM change_proposals WHERE id = $1 FOR UPDATE`,
          [row.id],
        )
        const current = found.rows[0] ? proposalFromRow(found.rows[0]) : undefined
        refuseDirectCas(current, row, fromStatus)
        if (!current || current.status !== fromStatus) return false
        assertCasShape(current, row)
        assertProposedByUnchanged(current, row)
        assertPayloadFrozen(current, row)
        assertFrozenColumns(current, row)
        const updated = await client.query(
          `UPDATE change_proposals
              SET status = $2, decided_by = $3, decided_kind = $4, decided_role = $5,
                  change_class = $6, declassify = $7
            WHERE id = $1 AND status = $8`,
          [row.id, row.status, row.decidedBy, row.decidedKind, row.decidedRole, row.changeClass, row.declassify, fromStatus],
        )
        return (updated.rowCount ?? 0) === 1
      },
      async recordApproval(row) {
        assertLive(tx)
        const found = await client.query<ProposalQueryRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM change_proposals WHERE id = $1 FOR UPDATE`,
          [row.id],
        )
        const current = found.rows[0] ? proposalFromRow(found.rows[0]) : undefined
        if (!current || current.status !== "pending") return false
        assertPartnerApproval(current, row)
        const updated = await client.query(
          `UPDATE change_proposals
              SET status = 'approved', decided_by = $2, decided_kind = 'partner', decided_role = 'partner',
                  declassify = $3
            WHERE id = $1 AND status = 'pending'`,
          [row.id, row.decidedBy, row.declassify],
        )
        return (updated.rowCount ?? 0) === 1
      },
      async allowDeclassify(on) {
        assertLive(tx)
        await raw.allowDeclassify(on)
      },
      async assertCommitShape(input) {
        assertLive(tx)
        if (!input.proposal) return
        const found = await client.query<ProposalQueryRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM change_proposals WHERE id = $1 FOR UPDATE`,
          [input.proposal.id],
        )
        const current = found.rows[0] ? proposalFromRow(found.rows[0]) : undefined
        assertCommitProposal(current, input.proposal)
        assertCommitBound(input)
      },
      async commitVersion(input) {
        assertLive(tx)
        try {
          return await guardedWrite(tx, input)
        } catch (error) {
          throw commitError(error)
        }
      },
    }
    await seal(tx, raw)
    return tx
  }
}

async function readClassification(client: pg.PoolClient, firmId: string): Promise<Classification> {
  const found = await client.query<{ classification: string }>(
    `SELECT classification FROM master_knowledge WHERE firm_id = $1`,
    [firmId],
  )
  const label = found.rows[0]?.classification
  return isClassification(label) ? label : "internal"
}

function commitError(error: unknown): Error {
  if (
    error instanceof Error &&
    /did not commit|non-P6 writer refused|master version conflict|proposal already has a version|declassify|frozen|proposedBy is immutable|proposal not found|version not found|approval is not a direct status change|proposal status transition is refused|commit is bound to the proposal|proposer key missing|partner approval|approver must differ|cosmetic proposal is not pending|proposal is already applied|learning proposal is stale|sealed proposal is void|master session is closed/.test(
      error.message,
    )
  ) {
    return error
  }
  return new Error("master write did not commit", { cause: error })
}

function pgRaw(client: pg.PoolClient, staged: StagedMasterWrite[]): RawWrite {
  return {
    pgClient: client,
    allowDeclassify: async (on) => {
      await client.query("SELECT set_config('p6.declassify', $1, true)", [on ? "partner" : "off"])
    },
    stageAfterCommit: (item) => {
      staged.push(item)
    },
    async getProposal(id) {
      const found = await client.query<ProposalQueryRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM change_proposals WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const row = found.rows[0]
      return row ? proposalFromRow(row) : null
    },
    async getVersion(id) {
      const found = await client.query<VersionQueryRow>(
        `SELECT id, firm_id, version_no, proposal_id, parent_version_id, action, diff, snapshot,
                author_id, author_kind, restored_from_version_id
           FROM master_versions WHERE id = $1`,
        [id],
      )
      const row = found.rows[0]
      return row ? versionFromRow(row) : null
    },
    async currentSnapshot(firmId) {
      const found = await client.query<{ snapshot: MasterSnapshot }>(
        `SELECT snapshot FROM master_knowledge WHERE firm_id = $1`,
        [firmId],
      )
      return found.rows[0]?.snapshot ?? freshEmptySnapshot()
    },
    async currentClassification(firmId) {
      return readClassification(client, firmId)
    },
    async lockFirm(firmId) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`p6:${firmId}`])
      const found = await client.query<{ version_id: string }>(
        `SELECT version_id FROM master_knowledge WHERE firm_id = $1 FOR UPDATE`,
        [firmId],
      )
      return found.rows[0]?.version_id ?? null
    },
    async assertCommitShape(input) {
      if (!input.proposal) return
      const found = await client.query<ProposalQueryRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM change_proposals WHERE id = $1 FOR UPDATE`,
        [input.proposal.id],
      )
      const current = found.rows[0] ? proposalFromRow(found.rows[0]) : undefined
      assertCommitProposal(current, input.proposal)
      assertCommitBound(input)
    },
  }
}
