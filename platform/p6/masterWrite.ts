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
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import type { PoolClient } from "pg"
import {
  canonicalPayload,
  normalizeActorKey,
  payloadHasPollutingKey,
  type CommitVersionInput,
  type CommitVersionResult,
} from "@/platform/p6/masterStore"

export const CANONICAL_MASTER_WRITER = "platform/p6/masterWrite.ts"
const STORE_DELEGATE = "platform/p6/masterStore.ts"
const MASTER_TABLES = new Set(["master_knowledge", "master_versions"])

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

export type MasterWriteSession = {
  allowDeclassify(on: boolean): Promise<void>
  commitVersion(input: CommitVersionInput): Promise<CommitVersionResult>
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

function assertMayWrite(input: CommitVersionInput): void {
  if (input.action === "rollback") {
    if (input.authorKind !== "partner" || normalizeActorKey(input.authorId) === "") {
      throw new Error("substantive proposal requires partner approval")
    }
    return
  }
  if (!input.proposal) throw new Error("proposal not found")
  const beforeBody = input.diff.before.entries[input.diff.key]?.body
  const changeClass = effectiveClass(input.proposal.requestedClass, beforeBody, input.proposal.payload)
  if (changeClass === "substantive") {
    const decidedBy = input.proposal.decidedBy
    const approver = normalizeActorKey(input.authorId)
    const proposer = normalizeActorKey(input.proposal.proposedBy)
    if (
      input.proposal.decidedKind !== "partner" ||
      input.proposal.decidedRole !== "partner" ||
      !decidedBy ||
      input.authorKind !== "partner" ||
      input.authorId !== decidedBy ||
      approver === ""
    ) {
      throw new Error("substantive proposal requires partner approval")
    }
    if (proposer === "") throw new Error("proposer key missing")
    if (approver === proposer) throw new Error("approver must differ from proposer")
    return
  }
  if (input.authorKind !== "system" || input.authorId !== "p6") {
    throw new Error("cosmetic proposal is not pending")
  }
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
    assertMayWrite(input)
    await session.allowDeclassify(gate.declassify)
    const outcome = await session.commitVersion(input)
    if (!outcome.committed) return outcome
    if (input.action === "apply" && input.proposalId) appliedProposalIds.add(input.proposalId)
    audit.push({
      action: input.action,
      firmId: input.firmId,
      proposalId: input.proposalId,
      actorId: input.authorId,
      versionId: outcome.versionId,
      outcome: "committed",
    })
    return outcome
  })
}

/** Postgres statements for master_versions and master_knowledge. The store delegates here. */
export async function executeMasterTableWrite(client: PoolClient, input: CommitVersionInput, versionId: string): Promise<void> {
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
    if (MASTER_TABLES.has(relationName(hit[2] ?? ""))) return true
  }
  return false
}

function isSecondWriter(path: string, source: string): boolean {
  if (path === CANONICAL_MASTER_WRITER) return false
  if (writesMasterTable(source)) return true
  if (/\.commitVersion\s*\(/.test(source)) return true
  if (path !== STORE_DELEGATE && /\bexecuteMasterTableWrite\s*\(/.test(source)) return true
  if (/collection\(\s*['"]master(?:_knowledge|_versions)?['"]/i.test(source)) return true
  if (/match\s+\/master_versions\//i.test(source)) return true
  return false
}

export function masterWriteViolations(files: readonly { path: string; source: string }[]): string[] {
  return files.filter((file) => isSecondWriter(file.path, file.source)).map((file) => file.path)
}

function walkTs(dir: string, root: string, out: { path: string; source: string }[]): void {
  for (const name of readdirSync(dir)) {
    const absolute = join(dir, name)
    if (statSync(absolute).isDirectory()) {
      walkTs(absolute, root, out)
      continue
    }
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue
    out.push({ path: relative(root, absolute).split(sep).join("/"), source: readFileSync(absolute, "utf8") })
  }
}

/** Source scan of platform/p6. Empty means the canonical file is the only master writer. */
export function scanP6MasterWriters(root = process.cwd()): string[] {
  const dir = join(root, "platform/p6")
  const files: { path: string; source: string }[] = []
  walkTs(dir, root, files)
  return masterWriteViolations(files)
}
