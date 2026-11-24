/**
 * Durable master store (Layer 17 L17.5; Layer 18 §5.4: Postgres is the system of record).
 * The in-memory adapter is the test and local proof. createPgMasterStore talks to Postgres
 * as the p6_service role (009_p6_master.sql). Neither adapter reports a commit it did not finish.
 */
import { createHash, randomUUID } from "node:crypto"
import pg from "pg"
import { isClassification, type Classification } from "@/platform/p1/types"
import type { MasterWriteSession, StagedMasterWrite } from "@/platform/p6/masterWrite"

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
  commitVersion(input: CommitVersionInput): Promise<CommitVersionResult>
  allowDeclassify(on: boolean): Promise<void>
}

export const P6_ROLE = "p6_service"
export const EMPTY_SNAPSHOT: MasterSnapshot = { entries: {} }

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

const rawByPublic = new WeakMap<object, MasterWriteSession>()

export function sessionForWrite(session: object): MasterWriteSession {
  const raw = rawByPublic.get(session)
  if (!raw) throw new Error("master session is closed")
  return raw
}

function bindMasterSession(session: object, raw: MasterWriteSession): void {
  rawByPublic.set(session, raw)
}

async function guardedWrite(raw: MasterWriteSession, input: CommitVersionInput): Promise<CommitVersionResult> {
  const { writeMaster } = await import("@/platform/p6/masterWrite")
  return writeMaster(input, raw, { declassify: input.proposal?.declassify === true })
}

async function publishStaged(staged: readonly StagedMasterWrite[]): Promise<void> {
  if (staged.length === 0) return
  const { publishStagedMasterWrites } = await import("@/platform/p6/masterWrite")
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
  private state: MemoryState = { proposals: new Map(), versions: [], heads: new Map(), classes: new Map() }
  private failCommit: "throw" | "uncommitted" | "commit" | undefined
  private gate: Promise<void> = Promise.resolve()

  constructor(options: { role: string; failCommit?: "throw" | "uncommitted" | "commit" }) {
    this.role = options.role
    this.failCommit = options.failCommit
  }

  async runExclusive<T>(fn: (tx: MasterSession) => Promise<T>): Promise<T> {
    const previous = this.gate
    let release!: () => void
    this.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    const snap = cloneState(this.state)
    const staged: StagedMasterWrite[] = []
    const raw = this.rawSession(staged)
    const tx = this.publicSession(raw)
    try {
      const result = await fn(tx)
      if (this.failCommit === "commit" && staged.length > 0) {
        this.failCommit = undefined
        throw new Error("master write did not commit")
      }
      await publishStaged(staged)
      return result
    } catch (error) {
      this.state = snap
      throw error
    } finally {
      release()
    }
  }

  private rawSession(staged: StagedMasterWrite[]): MasterWriteSession {
    return {
      allowDeclassify: async () => {},
      stageAfterCommit: (item) => {
        staged.push(item)
      },
      assertCommitShape: async (input) => {
        if (!input.proposal) return
        assertCommitProposal(this.state.proposals.get(input.proposal.id), input.proposal)
        assertCommitBound(input)
      },
      persistVersion: (input) => this.persistVersion(input),
    }
  }

  private publicSession(raw: MasterWriteSession): MasterSession {
    const tx: MasterSession = {
      getProposal: (id) => this.getProposal(id),
      currentSnapshot: (firmId) => this.currentSnapshot(firmId),
      currentClassification: (firmId) => this.currentClassification(firmId),
      lockFirm: (firmId) => this.lockFirm(firmId),
      casProposal: (row, fromStatus) => this.casProposal(row, fromStatus),
      recordApproval: (row) => this.recordApproval(row),
      allowDeclassify: (on) => this.allowDeclassify(on),
      commitVersion: (input) => {
        this.assertRole()
        return guardedWrite(raw, input)
      },
    }
    bindMasterSession(tx, raw)
    return tx
  }

  async lockFirm(firmId: string): Promise<string | null> {
    const versions = this.state.versions.filter((row) => row.firmId === firmId)
    return versions[versions.length - 1]?.id ?? null
  }

  async casProposal(row: PersistedProposal, fromStatus: PersistedProposal["status"]): Promise<boolean> {
    this.assertRole()
    const current = this.state.proposals.get(row.id)
    refuseDirectCas(current, row, fromStatus)
    if (!current || current.status !== fromStatus) return false
    assertCasShape(current, row)
    assertProposedByUnchanged(current, row)
    assertPayloadFrozen(current, row)
    assertFrozenColumns(current, row)
    const next = structuredClone(row)
    next.payload = structuredClone(current.payload)
    next.payloadHash = current.payloadHash
    this.state.proposals.set(row.id, next)
    return true
  }

  async recordApproval(row: PersistedProposal): Promise<boolean> {
    this.assertRole()
    const current = this.state.proposals.get(row.id)
    if (!current || current.status !== "pending") return false
    assertPartnerApproval(current, row)
    const next = structuredClone(row)
    next.status = "approved"
    next.payload = structuredClone(current.payload)
    next.payloadHash = current.payloadHash
    this.state.proposals.set(row.id, next)
    return true
  }

  async allowDeclassify(_on: boolean): Promise<void> {}

  async currentClassification(firmId: string): Promise<Classification> {
    return this.state.classes.get(firmId) ?? "internal"
  }

  private assertRole(): void {
    if (this.role !== P6_ROLE) throw new Error("non-P6 writer refused")
  }

  async insertProposal(row: PersistedProposal): Promise<PersistedProposal> {
    this.assertRole()
    assertNewProposal(row)
    if (this.state.proposals.has(row.id)) throw new Error(`proposal id already exists: ${row.id}`)
    const saved = structuredClone(row)
    saved.payloadHash = payloadDigest(saved.payload)
    this.state.proposals.set(saved.id, saved)
    return structuredClone(saved)
  }

  async getProposal(id: string): Promise<PersistedProposal | null> {
    const row = this.state.proposals.get(id)
    return row ? structuredClone(row) : null
  }

  async saveProposal(row: PersistedProposal): Promise<void> {
    this.assertRole()
    if (row.status !== "pending") throw new Error("save refuses a status other than pending")
    assertNoApprovalStamp(row)
    const current = this.state.proposals.get(row.id)
    if (!current) throw new Error("proposal not found")
    if (current.status !== "pending") throw new Error("save refuses a status other than pending")
    assertProposedByUnchanged(current, row)
    assertPayloadFrozen(current, row)
    assertFrozenColumns(current, row)
    const next = structuredClone(row)
    next.payload = structuredClone(current.payload)
    next.payloadHash = current.payloadHash
    this.state.proposals.set(row.id, next)
  }

  async listVersions(firmId: string): Promise<VersionRow[]> {
    return this.state.versions.filter((row) => row.firmId === firmId).map((row) => structuredClone(row))
  }

  async getVersion(id: string): Promise<VersionRow | null> {
    const row = this.state.versions.find((item) => item.id === id)
    return row ? structuredClone(row) : null
  }

  async currentSnapshot(firmId: string): Promise<MasterSnapshot> {
    return structuredClone(this.state.heads.get(firmId) ?? EMPTY_SNAPSHOT)
  }

  async commitVersion(input: CommitVersionInput): Promise<CommitVersionResult> {
    this.assertRole()
    const staged: StagedMasterWrite[] = []
    const outcome = await guardedWrite(this.rawSession(staged), input)
    if (outcome.committed) await publishStaged(staged)
    return outcome
  }

  private async persistVersion(input: CommitVersionInput): Promise<CommitVersionResult> {
    const snap = cloneState(this.state)
    try {
      const firmVersions = this.state.versions.filter((row) => row.firmId === input.firmId)
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
      this.state.versions.push(version)
      this.state.heads.set(input.firmId, structuredClone(input.snapshot))
      if (isClassification(input.classification)) this.state.classes.set(input.firmId, input.classification)
      if (input.proposal) this.state.proposals.set(input.proposal.id, structuredClone(input.proposal))
      if (this.failCommit === "throw") {
        this.state = snap
        throw new Error("master write did not commit")
      }
      if (this.failCommit === "uncommitted") {
        this.state = snap
        return { committed: false }
      }
      return { committed: true, versionId: version.id }
    } catch (error) {
      this.state = snap
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
        return found.rows[0]?.snapshot ?? EMPTY_SNAPSHOT
      })
    },

    async currentClassification(firmId) {
      return withRole(async (client) => readClassification(client, firmId))
    },

    async commitVersion(input) {
      const staged: StagedMasterWrite[] = []
      try {
        const outcome = await withRole(async (client) => guardedWrite(pgRaw(client, staged), input))
        await publishStaged(staged)
        return outcome
      } catch (error) {
        throw commitError(error)
      }
    },

    async runExclusive(fn) {
      const client = await pool.connect()
      const staged: StagedMasterWrite[] = []
      try {
        await client.query("BEGIN")
        await client.query("SET LOCAL ROLE p6_service")
        const result = await fn(session(client, staged))
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
        client.release()
      }
    },
  }

  function session(client: pg.PoolClient, staged: StagedMasterWrite[]): MasterSession {
    const raw = pgRaw(client, staged)
    const tx: MasterSession = {
      async getProposal(id) {
        const found = await client.query<ProposalQueryRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM change_proposals WHERE id = $1 FOR UPDATE`,
          [id],
        )
        const row = found.rows[0]
        return row ? proposalFromRow(row) : null
      },
      async currentSnapshot(firmId) {
        const found = await client.query<{ snapshot: MasterSnapshot }>(
          `SELECT snapshot FROM master_knowledge WHERE firm_id = $1`,
          [firmId],
        )
        return found.rows[0]?.snapshot ?? EMPTY_SNAPSHOT
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
      async casProposal(row, fromStatus) {
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
        await raw.allowDeclassify(on)
      },
      async commitVersion(input) {
        try {
          return await guardedWrite(raw, input)
        } catch (error) {
          throw commitError(error)
        }
      },
    }
    bindMasterSession(tx, raw)
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
    /did not commit|non-P6 writer refused|master version conflict|proposal already has a version|declassify|frozen|proposedBy is immutable|proposal not found|approval is not a direct status change|proposal status transition is refused|commit is bound to the proposal|proposer key missing|partner approval|approver must differ|cosmetic proposal is not pending|proposal is already applied|master session is closed/.test(
      error.message,
    )
  ) {
    return error
  }
  return new Error("master write did not commit", { cause: error })
}

function pgRaw(client: pg.PoolClient, staged: StagedMasterWrite[]): MasterWriteSession {
  return {
    pgClient: client,
    allowDeclassify: async (on) => {
      await client.query("SELECT set_config('p6.declassify', $1, true)", [on ? "partner" : "off"])
    },
    stageAfterCommit: (item) => {
      staged.push(item)
    },
    assertCommitShape: async (input) => {
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
