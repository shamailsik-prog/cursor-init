/**
 * P6 master-write rules (v19 L16.3 L5561–L5594; L17.5 L7051–L7086; G-3 L8488).
 * The store module owns the seal and the master_versions statements. This module
 * does not export a sealer and it does not read a caller-supplied proposal row.
 * The audit and the once-only apply gate live here. There is no new table.
 */
import { closeSync, constants, openSync, readdirSync, readFileSync } from "node:fs"
import { extname, join, relative, sep } from "node:path"
import type { Classification } from "@/platform/p1/types"
import { masterBody } from "@/platform/p6/learning/baseline"
import {
  canonicalPayload,
  payloadHasPollutingKey,
  type CommitVersionInput,
  type MasterSnapshot,
  type PersistedProposal,
  type VersionRow,
} from "@/platform/p6/masterStore"

export const CANONICAL_MASTER_WRITER = "platform/p6/masterWrite.ts"
/** Union of the repository guard's suffixes and the script forms that guard used to skip. */
const SOURCE_SUFFIXES = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".sql"])
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
 * Reads a public session may expose. They are not the writer's source for a stored
 * row or a version. The store keeps that handle private, and this module does not
 * export a sealer.
 */
export type MasterWriteSession = {
  getProposal(id: string): Promise<PersistedProposal | null>
  currentSnapshot(firmId: string): Promise<MasterSnapshot>
  currentClassification(firmId: string): Promise<Classification>
  lockFirm(firmId: string): Promise<string | null>
  getVersion(id: string): Promise<VersionRow | null>
  assertCommitShape(input: CommitVersionInput): Promise<void>
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

export function nextSnapshot(before: MasterSnapshot, row: PersistedProposal): MasterSnapshot {
  return {
    entries: {
      ...before.entries,
      [row.entryKey]: {
        partition: "mutable",
        key: row.entryKey,
        body: masterBody(row.payload),
        classification: row.classification,
      },
    },
  }
}

export async function runOneApply<T>(proposalId: string | null, fn: () => Promise<T>): Promise<T> {
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
  if (writesMasterTable(source) && path !== STORE_DELEGATE) return true
  if (/\.commitVersion\s*\(/.test(source)) return true
  if (/\bexecuteMasterTableWrite\s*\(/.test(source)) return true
  if (/\.persistVersion\s*\(/.test(source)) return true
  if (/\bsessionForWrite\s*\(/.test(source)) return true
  if (/\bsealMasterSession\s*\(/.test(source)) return true
  if (/\brollbackMaster\s*\(/.test(source) && path !== APPLY_ENTRY) return true
  if (/\bwriteMaster\s*\(/.test(source) && path !== STORE_DELEGATE && path !== APPLY_ENTRY) return true
  if (/\bwriteMaster\s+as\b/.test(source)) return true
  if (/\[['"]writeMaster['"]\]\s*\(/.test(source)) return true
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
