// I-3 / U-2 (final audits): the functions checkPermission was a stale copy of the Next.js table
// (no accounts-register-only row) and nothing called it. Both now evaluate one pure table,
// platform/p5/permissionDecision.ts `decide`; this test runs one set of cases through `decide`,
// the Next.js checkPermission (in-memory store) and the functions checkPermission (Firestore
// reads served from the case) and requires the same decision from all three, including the
// partner-only firm-administration actions the functions identity operations authorise with.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const docs: { matter?: Record<string, unknown>; member: boolean } = { member: false }
vi.mock("../functions/src/admin", () => ({
  adminDb: () => ({
    collection: (name: string) => ({
      doc: () => ({
        get: async () =>
          name === "matters"
            ? { exists: docs.matter !== undefined, data: () => docs.matter }
            : { exists: docs.member, data: () => (docs.member ? {} : undefined) },
      }),
    }),
  }),
}))
const auditRows: unknown[] = []
vi.mock("../functions/src/p5/audit", () => ({ appendAudit: async (row: unknown) => void auditRows.push(row) }))

import { checkPermission as functionsCheckPermission } from "../functions/src/p5/permission"
import { checkPermission as nextCheckPermission } from "@/platform/p5/checkPermission"
import { decide, FIRM_ADMIN_ACTIONS, type DecisionCaller, type PermissionDecision } from "@/platform/p5/permissionDecision"
import { newStore } from "@/platform/spine/store"
import type { Classification } from "@/platform/p1/types"

type Case = {
  name: string
  role: string
  clearance?: Classification
  action: string
  matter?: { firmId: string; classification: unknown } | "missing"
  member?: boolean
  scope?: "own_matters"
  expected: PermissionDecision
}

const OWN = { firmId: "firmA", classification: "confidential" }
// FA-F43-R1-P01: the matter-gate cases used "read_matter", an action no row knows, which fell through to `allow ok`; they
// now use the real matter-level row `matter.read`, and "read_matter" itself is refused unknown-action (cases at the end).
const CASES: Case[] = [
  { name: "member associate reads a matter", role: "associate", action: "matter.read", matter: OWN, member: true, expected: { allow: true, reason: "ok" } },
  { name: "non-member partner", role: "partner", action: "matter.read", matter: OWN, member: false, expected: { allow: false, reason: "not-member" } },
  { name: "another firm's matter", role: "partner", action: "matter.read", matter: { firmId: "firmB", classification: "public" }, member: true, expected: { allow: false, reason: "cross-firm" } },
  { name: "a missing matter", role: "partner", action: "matter.read", matter: "missing", expected: { allow: false, reason: "cross-firm" } },
  { name: "clearance below the matter", role: "associate", clearance: "internal", action: "matter.read", matter: { firmId: "firmA", classification: "privileged" }, member: true, expected: { allow: false, reason: "clearance" } },
  { name: "an unreadable classification is refused even at the top clearance", role: "partner", clearance: "privileged-restricted", action: "matter.read", matter: { firmId: "firmA", classification: "bogus" }, member: true, expected: { allow: false, reason: "clearance" } },
  { name: "an Object.prototype key as classification", role: "partner", clearance: "privileged-restricted", action: "matter.read", matter: { firmId: "firmA", classification: "constructor" }, member: true, expected: { allow: false, reason: "clearance" } },
  { name: "intern drafting", role: "intern", action: "draft", expected: { allow: false, reason: "intern-channel-denied" } },
  { name: "intern reading a matter", role: "intern", action: "matter.read", matter: OWN, member: true, expected: { allow: true, reason: "ok" } },
  { name: "client research", role: "client", action: "research", matter: OWN, member: true, expected: { allow: false, reason: "client-channel-denied" } },
  { name: "client lists matters", role: "client", action: "list_matters", expected: { allow: true, reason: "client-own-matters" } },
  { name: "own_matters scope lists", role: "associate", action: "list_matters", scope: "own_matters", expected: { allow: true, reason: "client-own-matters" } },
  { name: "own_matters scope drafts", role: "associate", action: "draft", scope: "own_matters", expected: { allow: false, reason: "client-channel-denied" } },
  { name: "partner lists matters", role: "partner", action: "list_matters", expected: { allow: true, reason: "ok" } },
  { name: "accounts reads a matter it is a member of", role: "accounts", action: "matter.read", matter: OWN, member: true, expected: { allow: false, reason: "accounts-register-only" } },
  { name: "accounts drafts", role: "accounts", action: "draft", expected: { allow: false, reason: "accounts-register-only" } },
  { name: "accounts reads the intimation register", role: "accounts", action: "intimation_register", expected: { allow: true, reason: "accounts-register" } },
  { name: "accounts records an entry on its firm's matter", role: "accounts", action: "record_accounts_entry", matter: OWN, member: false, expected: { allow: true, reason: "accounts-register" } },
  { name: "accounts records an entry on another firm's matter", role: "accounts", action: "record_accounts_entry", matter: { firmId: "firmB", classification: "public" }, expected: { allow: false, reason: "cross-firm" } },
  // P4-10: the D4 drafting actions (Phase 4a), matter-level, and doctype.read, firm-level.
  { name: "draft.create by a member associate", role: "associate", action: "draft.create", matter: OWN, member: true, expected: { allow: true, reason: "ok" } },
  { name: "draft.create by a partner who is not a member", role: "partner", action: "draft.create", matter: OWN, member: false, expected: { allow: false, reason: "not-member" } },
  { name: "draft.edit by a member intern", role: "intern", action: "draft.edit", matter: OWN, member: true, expected: { allow: false, reason: "intern-channel-denied" } },
  { name: "draft.read of another firm's matter", role: "partner", action: "draft.read", matter: { firmId: "firmB", classification: "public" }, member: true, expected: { allow: false, reason: "cross-firm" } },
  { name: "draft.read naming no matter fails closed", role: "partner", action: "draft.read", expected: { allow: false, reason: "cross-firm" } },
  { name: "draft.read below the matter's clearance", role: "clerk", clearance: "internal", action: "draft.read", matter: { firmId: "firmA", classification: "privileged" }, member: true, expected: { allow: false, reason: "clearance" } },
  { name: "draft.override by a member associate", role: "associate", action: "draft.override", matter: OWN, member: true, expected: { allow: false, reason: "role-not-permitted" } },
  { name: "draft.approve by a member partner", role: "partner", action: "draft.approve", matter: OWN, member: true, expected: { allow: true, reason: "ok" } },
  { name: "draft.create by a client", role: "client", action: "draft.create", matter: OWN, member: true, expected: { allow: false, reason: "client-denied" } },
  { name: "draft.create by accounts", role: "accounts", action: "draft.create", matter: OWN, member: true, expected: { allow: false, reason: "accounts-register-only" } },
  { name: "doctype.read by a clerk", role: "clerk", action: "doctype.read", expected: { allow: true, reason: "ok" } },
  { name: "doctype.read by an intern", role: "intern", action: "doctype.read", expected: { allow: false, reason: "intern-channel-denied" } },
  { name: "doctype.read by a client", role: "client", action: "doctype.read", expected: { allow: false, reason: "client-denied" } },
  { name: "doctype.read by accounts", role: "accounts", action: "doctype.read", expected: { allow: false, reason: "accounts-register-only" } },
  // FA-F43-R1-P01: an action no row knows is refused in all three, for every role but accounts; the Next routes' actions
  // are decided by their own rows (spec R2/R3).
  ...["partner", "associate", "clerk", "intern", "client"].flatMap((role): Case[] => [
    { name: `an unknown action by the ${role} role, member matter`, role, action: "read_matter", matter: OWN, member: true, expected: { allow: false, reason: "unknown-action" } },
    { name: `an unknown action by the ${role} role, no matter`, role, action: "fa_f43_unknown.action", expected: { allow: false, reason: "unknown-action" } },
  ]),
  { name: "an unknown action by accounts", role: "accounts", action: "read_matter", matter: OWN, member: true, expected: { allow: false, reason: "accounts-register-only" } },
  { name: "committee_brain by a member clerk", role: "clerk", action: "committee_brain", matter: OWN, member: true, expected: { allow: true, reason: "ok" } },
  { name: "committee_brain by a member intern", role: "intern", action: "committee_brain", matter: OWN, member: true, expected: { allow: false, reason: "role-not-permitted" } },
  { name: "committee_brain by a member client", role: "client", action: "committee_brain", matter: OWN, member: true, expected: { allow: false, reason: "client-denied" } },
  { name: "committee_brain naming no matter", role: "partner", action: "committee_brain", expected: { allow: false, reason: "cross-firm" } },
  { name: "committee_brain_read by a non-member associate", role: "associate", action: "committee_brain_read", matter: OWN, member: false, expected: { allow: false, reason: "not-member" } },
  { name: "normalise_case_number by an intern", role: "intern", action: "normalise_case_number", expected: { allow: true, reason: "ok" } },
  { name: "research by a member clerk", role: "clerk", action: "research", matter: OWN, member: true, expected: { allow: true, reason: "ok" } },
  { name: "intimation_register by a partner", role: "partner", action: "intimation_register", expected: { allow: false, reason: "role-not-permitted" } },
  ...FIRM_ADMIN_ACTIONS.flatMap((action): Case[] => [
    { name: `${action} by a partner`, role: "partner", action, expected: { allow: true, reason: "ok" } },
    ...["associate", "clerk", "intern", "accounts", "client"].map((role): Case => ({
      name: `${action} by the ${role} role`,
      role,
      action,
      expected: { allow: false, reason: "partner-only" },
    })),
  ]),
]

const UID = "perm_user"
const MATTER_ID = "m_parity"
const callerOf = (c: Case): DecisionCaller & { uid: string } => ({
  uid: UID,
  firmId: "firmA",
  role: c.role,
  clearanceLevel: c.clearance ?? "privileged",
})
const matterIdOf = (c: Case) => (c.matter === undefined ? undefined : MATTER_ID)

function viaDecide(c: Case): PermissionDecision {
  const matter = c.matter === undefined ? undefined : c.matter === "missing" ? null : c.matter
  return decide(callerOf(c), c.action, matter, c.member === true, c.scope ? { scope: c.scope } : undefined)
}

function viaNext(c: Case): PermissionDecision {
  const store = newStore()
  const caller = callerOf(c)
  store.users.set(UID, { id: UID, firmId: caller.firmId, role: caller.role as never, clearanceLevel: caller.clearanceLevel, active: true })
  if (c.matter && c.matter !== "missing") {
    store.matters.set(MATTER_ID, { id: MATTER_ID, clientId: "c", title: "t", courtId: "SHC", caseNumber: null, caseNumberStatus: "pending", ...c.matter } as never)
  }
  if (c.member) store.members.set(store.memberKey(MATTER_ID, UID), { matterId: MATTER_ID, userId: UID, firmId: "firmA" })
  return nextCheckPermission(store, UID, c.action, matterIdOf(c), c.scope ? { scope: c.scope } : undefined)
}

async function viaFunctions(c: Case): Promise<PermissionDecision> {
  docs.matter = c.matter && c.matter !== "missing" ? c.matter : undefined
  docs.member = c.member === true
  const { uid, firmId, role, clearanceLevel } = callerOf(c)
  return functionsCheckPermission({ uid, firmId, role: role as never, clearanceLevel }, c.action, matterIdOf(c), c.scope ? { scope: c.scope } : undefined)
}

beforeEach(() => {
  auditRows.length = 0
})
afterEach(() => {
  docs.matter = undefined
  docs.member = false
})

describe("permission parity: decide == Next.js checkPermission == functions checkPermission", () => {
  it.each(CASES)("$name", async (c) => {
    expect(viaDecide(c)).toEqual(c.expected)
    expect(viaNext(c)).toEqual(c.expected)
    expect(await viaFunctions(c)).toEqual(c.expected)
    // every functions decision is audited exactly once
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({ action: c.action, decision: c.expected.allow ? "allow" : "deny", reason: c.expected.reason })
  })

  it("no caller is no-user", () => {
    expect(decide(null, "read_matter", undefined, false)).toEqual({ allow: false, reason: "no-user" })
    expect(nextCheckPermission(newStore(), "ghost", "read_matter")).toEqual({ allow: false, reason: "no-user" })
  })
})
