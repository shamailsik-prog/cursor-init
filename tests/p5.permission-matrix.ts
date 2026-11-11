/**
 * Cartesian parity matrix for Q01 SEC-P01. The fixture
 * tests/fixtures/p5.permission-base-matrix.json was produced by running this builder
 * against decide() at base bb8fcc3f02b0fc0a6bcc1c705bcbc270ad3c7961, before the
 * unknown-action denial. The head comparison must be empty on every known action.
 */
import {
  ACCOUNTS_REGISTER_ACTIONS,
  AI_ACTIONS,
  ALERT_ACTIONS,
  D1_ACTIONS,
  DOCTYPE_ACTIONS,
  DRAFT_ACTIONS,
  FIRM_ADMIN_ACTIONS,
  JOB_ACTIONS,
  RETENTION_ACTIONS,
  decide,
  type DecisionCaller,
  type DecisionMatter,
  type PermissionDecision,
} from "@/platform/p5/permissionDecision"
import type { Classification } from "@/platform/p1/types"

/** Actions that today fall through the final allow, proved by the caller inventory and the suites that must stay green. */
export const GENERIC_MATRIX_ACTIONS = [
  "research",
  "draft",
  "read",
  "read_matter",
  "read_firm",
  "list_matters",
  "normalise_case_number",
  "committee_brain",
  "committee_brain_read",
] as const

/** Strings the acceptance checklist requires to be denied. None is a known action. */
export const UNKNOWN_MATRIX_ACTIONS = [
  "zzz",
  "matter.delete_all",
  "",
  " ",
  "Research",
  "DRAFT",
  " draft",
  "draft ",
  "draft.x",
  "x.draft",
  "research\u0000",
] as const

export const MATRIX_ROLES = ["partner", "associate", "intern", "client", "accounts", "unknown", null] as const
export const MATRIX_MATTERS = ["member", "non-member", "cross-firm", "deleted", "none"] as const
export const MATRIX_CLEARANCES = ["below", "at"] as const

export const MATRIX_BASE = "bb8fcc3f02b0fc0a6bcc1c705bcbc270ad3c7961"

const TABLE_ACTIONS = [
  ...FIRM_ADMIN_ACTIONS,
  ...RETENTION_ACTIONS,
  ...ACCOUNTS_REGISTER_ACTIONS,
  ...D1_ACTIONS,
  ...JOB_ACTIONS,
  ...ALERT_ACTIONS,
  ...AI_ACTIONS,
  ...DRAFT_ACTIONS,
  ...DOCTYPE_ACTIONS,
]

export const KNOWN_MATRIX_ACTIONS: readonly string[] = [...TABLE_ACTIONS, ...GENERIC_MATRIX_ACTIONS]

const MATTER_CLASSIFICATION: Classification = "privileged"
const CLEARANCE: Record<(typeof MATRIX_CLEARANCES)[number], Classification> = {
  below: "internal",
  at: "privileged",
}

export type MatrixMatter = (typeof MATRIX_MATTERS)[number]
export type MatrixClearance = (typeof MATRIX_CLEARANCES)[number]

export type MatrixRow = {
  action: string
  role: string | null
  matter: MatrixMatter
  clearance: MatrixClearance
  allow: boolean
  reason: string
}

function matterOf(kind: MatrixMatter): { matter: DecisionMatter; member: boolean } {
  if (kind === "none") return { matter: undefined, member: false }
  if (kind === "cross-firm") return { matter: { firmId: "firmB", classification: MATTER_CLASSIFICATION }, member: true }
  if (kind === "deleted") return { matter: { firmId: "firmA", classification: MATTER_CLASSIFICATION, deleted: true }, member: true }
  if (kind === "non-member") return { matter: { firmId: "firmA", classification: MATTER_CLASSIFICATION }, member: false }
  return { matter: { firmId: "firmA", classification: MATTER_CLASSIFICATION }, member: true }
}

export function evaluateMatrixRow(
  action: string,
  role: string | null,
  matter: MatrixMatter,
  clearance: MatrixClearance,
): PermissionDecision {
  const ctx = matterOf(matter)
  if (role === null) return decide(null, action, ctx.matter, ctx.member)
  const caller: DecisionCaller = { role, firmId: "firmA", clearanceLevel: CLEARANCE[clearance] }
  return decide(caller, action, ctx.matter, ctx.member)
}

export function buildMatrix(actions: readonly string[]): MatrixRow[] {
  const rows: MatrixRow[] = []
  for (const action of actions) {
    for (const role of MATRIX_ROLES) {
      for (const matter of MATRIX_MATTERS) {
        for (const clearance of MATRIX_CLEARANCES) {
          const decision = evaluateMatrixRow(action, role, matter, clearance)
          rows.push({ action, role, matter, clearance, allow: decision.allow, reason: decision.reason })
        }
      }
    }
  }
  return rows
}

export function matrixKey(row: Pick<MatrixRow, "action" | "role" | "matter" | "clearance">): string {
  return [row.action, row.role === null ? "null" : row.role, row.matter, row.clearance].join("\t")
}

export function matrixLine(row: MatrixRow): string {
  return `${matrixKey(row)}\t${row.allow ? "allow" : "deny"}\t${row.reason}`
}
