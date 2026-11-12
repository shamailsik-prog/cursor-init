// Q04 R-P01-TESTONLY-001. One case list through decide, the Next.js checkPermission
// and the functions checkPermission. Expected values are the post-Q04 table.
// On 3b437123 the retired strings, the matter-less intimation row, intern, clerk,
// client and own_matters intimation, and every non-accounts record_accounts_entry
// row fail. Accounts register cells stay accounts-register / cross-firm.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const docs: {
  matter?: Record<string, unknown>
  member: boolean
  tombstone?: Record<string, unknown>
} = { member: false }
vi.mock("../functions/src/admin", () => ({
  adminDb: () => ({
    collection: (name: string) => ({
      doc: () => ({
        get: async () => {
          if (name === "matters") {
            return { exists: docs.matter !== undefined, data: () => docs.matter }
          }
          if (name === "matter_tombstones") {
            return { exists: docs.tombstone !== undefined, data: () => docs.tombstone }
          }
          return { exists: docs.member, data: () => (docs.member ? {} : undefined) }
        },
      }),
    }),
  }),
}))
const auditRows: unknown[] = []
vi.mock("../functions/src/p5/audit", () => ({ appendAudit: async (row: unknown) => void auditRows.push(row) }))

import { checkPermission as functionsCheckPermission } from "../functions/src/p5/permission"
import { checkPermission as nextCheckPermission } from "@/platform/p5/checkPermission"
import { decide, type DecisionCaller, type PermissionDecision } from "@/platform/p5/permissionDecision"
import { newStore } from "@/platform/spine/store"
import type { Classification } from "@/platform/p1/types"

type MatterShape = { firmId: string; classification: unknown; deleted?: boolean }

type Case = {
  name: string
  role: string | null
  clearance?: Classification
  action: string
  matter?: MatterShape | "missing"
  member?: boolean
  scope?: "own_matters"
  expected: PermissionDecision
}

const OWN: MatterShape = { firmId: "firmA", classification: "confidential" }
const OTHER: MatterShape = { firmId: "firmB", classification: "public" }
const DELETED: MatterShape = { firmId: "firmA", classification: "confidential", deleted: true }
const BELOW: MatterShape = { firmId: "firmA", classification: "privileged" }
const ROLES = ["partner", "associate", "intern", "clerk", "client", "accounts"] as const
const RETIRED = ["read", "read_matter", "read_firm"] as const

const retiredCases: Case[] = RETIRED.flatMap((action) => [
  ...ROLES.flatMap((role): Case[] => [
    {
      name: `${role} ${action} with a matter`,
      role,
      action,
      matter: OWN,
      member: true,
      expected: { allow: false, reason: "unknown-action" },
    },
    {
      name: `${role} ${action} with no matter`,
      role,
      action,
      expected: { allow: false, reason: "unknown-action" },
    },
  ]),
  {
    name: `null caller ${action}`,
    role: null,
    action,
    expected: { allow: false, reason: "no-user" },
  },
])

const intimationCases: Case[] = [
  { name: "partner member intimation_register", role: "partner", action: "intimation_register", matter: OWN, member: true, expected: { allow: true, reason: "ok" } },
  { name: "associate member intimation_register", role: "associate", action: "intimation_register", matter: OWN, member: true, expected: { allow: true, reason: "ok" } },
  { name: "partner non-member intimation_register", role: "partner", action: "intimation_register", matter: OWN, member: false, expected: { allow: false, reason: "not-member" } },
  { name: "associate non-member intimation_register", role: "associate", action: "intimation_register", matter: OWN, member: false, expected: { allow: false, reason: "not-member" } },
  { name: "partner intimation_register names no matter", role: "partner", action: "intimation_register", expected: { allow: false, reason: "cross-firm" } },
  { name: "associate intimation_register names no matter", role: "associate", action: "intimation_register", expected: { allow: false, reason: "cross-firm" } },
  { name: "partner intimation_register other firm", role: "partner", action: "intimation_register", matter: OTHER, member: true, expected: { allow: false, reason: "cross-firm" } },
  { name: "partner intimation_register deleted matter", role: "partner", action: "intimation_register", matter: DELETED, member: true, expected: { allow: false, reason: "matter-deleted" } },
  { name: "partner intimation_register below clearance", role: "partner", clearance: "internal", action: "intimation_register", matter: BELOW, member: true, expected: { allow: false, reason: "clearance" } },
  { name: "intern intimation_register", role: "intern", action: "intimation_register", matter: OWN, member: true, expected: { allow: false, reason: "role-not-permitted" } },
  { name: "clerk intimation_register", role: "clerk", action: "intimation_register", matter: OWN, member: true, expected: { allow: false, reason: "role-not-permitted" } },
  { name: "unknown role intimation_register", role: "unknown", action: "intimation_register", matter: OWN, member: true, expected: { allow: false, reason: "role-not-permitted" } },
  { name: "client intimation_register", role: "client", action: "intimation_register", matter: OWN, member: true, expected: { allow: false, reason: "client-denied" } },
  { name: "own_matters intimation_register", role: "associate", action: "intimation_register", matter: OWN, member: true, scope: "own_matters", expected: { allow: false, reason: "client-denied" } },
  { name: "accounts intimation_register", role: "accounts", action: "intimation_register", expected: { allow: true, reason: "accounts-register" } },
  { name: "accounts intimation_register on its firm's matter", role: "accounts", action: "intimation_register", matter: OWN, member: false, expected: { allow: true, reason: "accounts-register" } },
]

const recordCases: Case[] = [
  ...(["partner", "associate", "intern", "clerk", "unknown"] as const).map((role): Case => ({
    name: `${role} record_accounts_entry`,
    role,
    action: "record_accounts_entry",
    matter: OWN,
    member: true,
    expected: { allow: false, reason: "role-not-permitted" },
  })),
  { name: "client record_accounts_entry", role: "client", action: "record_accounts_entry", matter: OWN, member: true, expected: { allow: false, reason: "client-denied" } },
  { name: "own_matters record_accounts_entry", role: "associate", action: "record_accounts_entry", matter: OWN, member: true, scope: "own_matters", expected: { allow: false, reason: "client-denied" } },
  { name: "accounts record_accounts_entry on its firm's matter", role: "accounts", action: "record_accounts_entry", matter: OWN, member: false, expected: { allow: true, reason: "accounts-register" } },
  { name: "accounts record_accounts_entry on another firm's matter", role: "accounts", action: "record_accounts_entry", matter: OTHER, expected: { allow: false, reason: "cross-firm" } },
]

const CASES: Case[] = [...retiredCases, ...intimationCases, ...recordCases]

const UID = "q04_user"
const MATTER_ID = "m_q04"
const callerOf = (c: Case): DecisionCaller & { uid: string } => ({
  uid: UID,
  firmId: "firmA",
  role: c.role ?? "",
  clearanceLevel: c.clearance ?? "privileged",
})
const matterIdOf = (c: Case) => (c.matter === undefined ? undefined : MATTER_ID)

function viaDecide(c: Case): PermissionDecision {
  const matter = c.matter === undefined ? undefined : c.matter === "missing" ? null : c.matter
  const caller = c.role === null ? null : callerOf(c)
  return decide(caller, c.action, matter, c.member === true, c.scope ? { scope: c.scope } : undefined)
}

function viaNext(c: Case): PermissionDecision {
  const store = newStore()
  if (c.role !== null) {
    const caller = callerOf(c)
    store.users.set(UID, {
      id: UID,
      firmId: caller.firmId,
      role: caller.role as never,
      clearanceLevel: caller.clearanceLevel,
      active: true,
    })
  }
  if (c.matter && c.matter !== "missing") {
    store.matters.set(MATTER_ID, {
      id: MATTER_ID,
      clientId: "c",
      title: "t",
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      ...c.matter,
    } as never)
  }
  if (c.member) store.members.set(store.memberKey(MATTER_ID, UID), { matterId: MATTER_ID, userId: UID, firmId: "firmA" })
  return nextCheckPermission(store, c.role === null ? "ghost" : UID, c.action, matterIdOf(c), c.scope ? { scope: c.scope } : undefined)
}

async function viaFunctions(c: Case): Promise<PermissionDecision> {
  docs.matter = c.matter && c.matter !== "missing" ? { firmId: c.matter.firmId, classification: c.matter.classification } : undefined
  docs.member = c.member === true
  docs.tombstone =
    c.matter && c.matter !== "missing" && c.matter.deleted
      ? { firmId: "firmA", matterId: MATTER_ID, classification: c.matter.classification }
      : undefined
  const { uid, firmId, role, clearanceLevel } = callerOf(c)
  return functionsCheckPermission(
    { uid, firmId, role: role as never, clearanceLevel },
    c.action,
    matterIdOf(c),
    c.scope ? { scope: c.scope } : undefined,
  )
}

beforeEach(() => {
  auditRows.length = 0
  docs.matter = undefined
  docs.member = false
  docs.tombstone = undefined
})
afterEach(() => {
  docs.matter = undefined
  docs.member = false
  docs.tombstone = undefined
})

describe("Q04 register rows: decide == Next.js checkPermission == functions checkPermission", () => {
  it.each(CASES)("$name", async (c) => {
    expect(viaDecide(c)).toEqual(c.expected)
    expect(viaNext(c)).toEqual(c.expected)
    if (c.role === null) return
    expect(await viaFunctions(c)).toEqual(c.expected)
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({
      action: c.action,
      decision: c.expected.allow ? "allow" : "deny",
      reason: c.expected.reason,
    })
  })
})
