/**
 * P6 canonical master writer (v19 L16.3 L5561–L5594; L17.5 L7051–L7086; G-3 L8488).
 * applyChange and rollbackMaster delegate here. The Postgres statements that insert
 * master_versions and master_knowledge live in this file. The proposal log stays
 * on the store: a proposal is not a master version.
 *
 * The write is transactional because the caller holds the store session. It is
 * actor-bound with the same key fold as approval (#252). A substantive apply
 * requires a partner who is not the proposer. Each committed write is audited
 * in process. There is no new table and no new collection.
 */
import { randomUUID } from "node:crypto"
import { closeSync, constants, openSync, readdirSync, readFileSync } from "node:fs"
import { extname, join, relative, sep } from "node:path"
import type { PoolClient } from "pg"
import { classificationRank, isClassification, type Classification } from "@/platform/p1/types"
import {
  canonicalPayload,
  normalizeActorKey,
  payloadHasPollutingKey,
  type CommitVersionInput,
  type CommitVersionResult,
  type MasterSnapshot,
  type PersistedProposal,
  type VersionRow,
} from "@/platform/p6/masterStore"

export const CANONICAL_MASTER_WRITER = "platform/p6/masterWrite.ts"
/** Union of the repository guard's suffixes and the script forms that guard used to skip. */
const SOURCE_SUFFIXES = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".py", ".sql"])
const STORE_DELEGATE = "platform/p6/masterStore.ts"
const APPLY_ENTRY = "platform/p6/proposeChange.ts"

const QUALIFIED = '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\\s*\\.\\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))*'
const TABLE_WRITE = new RegExp(
  `\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:ONLY\\s+)?(${QUALIFIED})`,
  "gi",
)

export type MasterWriteAuditEntry = {
  action: "apply" | "rollback"
  firmId: string
  proposalId: string | null
  actorId: string
  versionId: string
  outcome: "committed"
}

export type StagedMasterWrite = {
  proposalId: string | null
  entry: MasterWriteAuditEntry
}

/**
 * Reads the caller may use. Persistence is not on this object. `sealMasterSession`
 * keeps the raw write in a private map, and only a session sealed by the store is accepted.
 */
export type MasterWriteSession = {
  getProposal(id: string): Promise<PersistedProposal | null>
  currentSnapshot(firmId: string): Promise<MasterSnapshot>
  currentClassification(firmId: string): Promise<Classification>
  lockFirm(firmId: string): Promise<string | null>
  getVersion(id: string): Promise<VersionRow | null>
  assertCommitShape(input: CommitVersionInput): Promise<void>
}

type SealedRaw = {
  allowDeclassify(on: boolean): Promise<void>
  persistVersion?(input: CommitVersionInput): Promise<CommitVersionResult>
  stageAfterCommit?(staged: StagedMasterWrite): void
  pgClient?: PoolClient
}

const sealBrand = Symbol("p6.masterSession")
const sealedRaws = new WeakMap<object, SealedRaw>()

export function sealMasterSession(session: object, raw: SealedRaw): void {
  Object.defineProperty(session, sealBrand, { value: true })
  sealedRaws.set(session, raw)
}

export function closeMasterSession(session: object): void {
  sealedRaws.delete(session)
}

function sealedRaw(session: object): SealedRaw {
  const raw = sealedRaws.get(session)
  if (!raw) throw new Error("master session is closed")
  return raw
}

export function publishStagedMasterWrites(staged: readonly StagedMasterWrite[]): void {
  for (const item of staged) {
    if (item.proposalId) appliedProposalIds.add(item.proposalId)
    audit.push(item.entry)
  }
}

const audit: MasterWriteAuditEntry[] = []
const appliedProposalIds = new Set<string>()
const applyTails = new Map<string, Promise<void>>()

export function masterWriteAuditLog(): readonly MasterWriteAuditEntry[] {
  return audit.slice()
}

/** Cosmetic only when the diff is whitespace or object-key order. Anything else is substantive. A caller cannot lower that. */
export function effectiveClass(
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

function sameDocument(left: unknown, right: unknown): boolean {
  return canonicalPayload(left) === canonicalPayload(right)
}

export function nextSnapshot(before: MasterSnapshot, row: PersistedProposal): MasterSnapshot {
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

async function assertStoredWrite(
  input: CommitVersionInput,
  session: MasterWriteSession,
  gate: { declassify: boolean },
): Promise<{ declassify: boolean }> {
  const locked = await session.lockFirm(input.firmId)
  if ((locked ?? null) !== input.expectedBaseVersionId) throw new Error("master version conflict")
  const current = await session.currentSnapshot(input.firmId)
  if (!sameDocument(input.diff.before, current)) throw new Error("commit is bound to the proposal")
  if (input.action === "rollback") {
    if (input.proposalId !== null || input.proposal) throw new Error("proposal not found")
    if (!input.restoredFromVersionId) throw new Error("version not found")
    const target = await session.getVersion(input.restoredFromVersionId)
    if (!target || target.firmId !== input.firmId) throw new Error("version not found")
    if (!sameDocument(input.snapshot, target.snapshot)) throw new Error("commit is bound to the proposal")
    if (input.authorKind !== "partner" || normalizeActorKey(input.authorId) === "") {
      throw new Error("substantive proposal requires partner approval")
    }
    const targetClass = snapshotClass(target.snapshot, "internal")
    const currentClass = await session.currentClassification(input.firmId)
    const classification = gate.declassify ? targetClass : higherClass(currentClass, targetClass)
    if (input.classification !== classification) throw new Error("commit is bound to the proposal")
    return { declassify: gate.declassify }
  }
  if (!input.proposalId) throw new Error("proposal not found")
  const stored = await session.getProposal(input.proposalId)
  if (!stored || stored.firmId !== input.firmId) throw new Error("commit is bound to the proposal")
  const expected = nextSnapshot(current, stored)
  if (!sameDocument(input.snapshot, expected) || !sameDocument(input.diff.after, input.snapshot)) {
    throw new Error("commit is bound to the proposal")
  }
  if (input.diff.key !== stored.entryKey) throw new Error("commit is bound to the proposal")
  if (stored.changeClass === "substantive") {
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
  } else if (stored.changeClass === "cosmetic") {
    if (stored.status !== "pending" && stored.status !== "applied") throw new Error("cosmetic proposal is not pending")
    if (input.authorKind !== "system" || input.authorId !== "p6") throw new Error("cosmetic proposal is not pending")
  } else {
    throw new Error("substantive proposal requires partner approval")
  }
  const classification = snapshotClass(input.snapshot, stored.classification)
  if (input.classification !== classification) throw new Error("commit is bound to the proposal")
  return { declassify: stored.declassify === true }
}

async function oneApply<T>(proposalId: string | null, fn: () => Promise<T>): Promise<T> {
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

/**
 * The only master write. `session` is the caller's open transaction.
 * A second apply of the same proposal id commits once.
 */
export async function writeMaster(
  input: CommitVersionInput,
  session: MasterWriteSession,
  gate: { declassify: boolean },
): Promise<CommitVersionResult> {
  return oneApply(input.action === "apply" ? input.proposalId : null, async () => {
    const raw = sealedRaw(session)
    if (typeof session.assertCommitShape !== "function") throw new Error("master session is closed")
    await session.assertCommitShape(input)
    const bound = await assertStoredWrite(input, session, gate)
    await raw.allowDeclassify(bound.declassify)
    const outcome = await persistSession(raw, input)
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

async function persistSession(session: SealedRaw, input: CommitVersionInput): Promise<CommitVersionResult> {
  if (session.pgClient) {
    const versionId = randomUUID()
    await executeMasterTableWrite(session.pgClient, input, versionId)
    return { committed: true, versionId }
  }
  if (!session.persistVersion) throw new Error("master session is closed")
  return session.persistVersion(input)
}

/** Postgres statements for master_versions and master_knowledge. Not exported. */
async function executeMasterTableWrite(client: PoolClient, input: CommitVersionInput, versionId: string): Promise<void> {
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

function relationName(token: string): string {
  const parts = [...token.matchAll(/"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)/g)]
  const idents = parts.map((part) => part[1] || part[2] || "").filter((part) => part.length > 0)
  return (idents[idents.length - 1] ?? "").toLowerCase()
}

function writesMasterTable(source: string): boolean {
  TABLE_WRITE.lastIndex = 0
  for (const hit of source.matchAll(TABLE_WRITE)) {
    if (relationName(hit[2] ?? "").startsWith("master_")) return true
  }
  return false
}

function isSecondWriter(path: string, source: string): boolean {
  if (path === CANONICAL_MASTER_WRITER) return false
  if (writesMasterTable(source)) return true
  if (/\.commitVersion\s*\(/.test(source)) return true
  if (/\bexecuteMasterTableWrite\s*\(/.test(source)) return true
  if (/\.persistVersion\s*\(/.test(source)) return true
  if (/\bsessionForWrite\s*\(/.test(source)) return true
  if (/\bwriteMaster\s*\(/.test(source) && path !== STORE_DELEGATE && path !== APPLY_ENTRY) return true
  if (/\bsealMasterSession\s*\(/.test(source) && path !== STORE_DELEGATE) return true
  if (/collection\(\s*['"]master(?:_knowledge|_versions)?['"]/i.test(source)) return true
  if (/match\s+\/master_versions\//i.test(source)) return true
  return false
}

export function masterWriteViolations(files: readonly { path: string; source: string }[]): string[] {
  return files.filter((file) => isSecondWriter(file.path, file.source)).map((file) => file.path)
}

function readSourceNoFollow(absolute: string): string | undefined {
  let fd: number
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ELOOP" || code === "EINVAL" || code === "ENOENT" || code === "ENOTDIR" || code === "EPERM") return undefined
    throw error
  }
  try {
    return readFileSync(fd, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EISDIR") return undefined
    throw error
  } finally {
    closeSync(fd)
  }
}

function walkTs(dir: string, root: string, out: { path: string; source: string }[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkTs(absolute, root, out)
      continue
    }
    if (!SOURCE_SUFFIXES.has(extname(entry.name).toLowerCase())) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    const source = readSourceNoFollow(absolute)
    if (source === undefined) continue
    out.push({ path: relative(root, absolute).split(sep).join("/"), source })
  }
}

/** Source scan of platform/p6. Empty means the canonical file is the only master writer. */
export function scanP6MasterWriters(root = process.cwd()): string[] {
  const dir = join(root, "platform/p6")
  const files: { path: string; source: string }[] = []
  walkTs(dir, root, files)
  return masterWriteViolations(files)
}
