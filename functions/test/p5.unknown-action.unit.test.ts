/**
 * Q01 SEC-P01 on the Cloud Functions path. checkPermission audits every denial.
 * The reason is unknown-action whether or not the matter exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Caller } from "../src/p5/auth"
import { checkPermission } from "../src/p5/permission"

const state = vi.hoisted(() => ({
  matter: undefined as { firmId: string; classification: string } | undefined,
  member: false,
}))
const auditRows = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock("../src/admin", () => ({
  adminDb: () => ({
    collection: (name: string) => ({
      doc: () => ({
        get: async () =>
          name === "matters"
            ? { exists: state.matter !== undefined, data: () => state.matter }
            : name === "matter_members"
              ? { exists: state.member, data: () => (state.member ? {} : undefined) }
              : { exists: false, data: () => undefined },
      }),
    }),
  }),
}))
vi.mock("../src/p5/audit", () => ({
  appendAudit: async (row: Record<string, unknown>) => {
    auditRows.push(row)
  },
}))

const UNKNOWN = [
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
const ROLES = ["partner", "associate", "clerk", "intern", "client", "accounts", "unknown"] as const

function caller(role: string): Caller {
  return { uid: "u1", firmId: "firmA", role: role as Caller["role"], clearanceLevel: "privileged" }
}

beforeEach(() => {
  state.matter = undefined
  state.member = false
  auditRows.length = 0
})

describe("functions checkPermission denies an unknown action", () => {
  it.each(UNKNOWN)("%j is unknown-action for every role, audited, with and without a matter", async (action) => {
    for (const role of ROLES) {
      state.matter = undefined
      state.member = false
      const missing = await checkPermission(caller(role), action, "m_missing")
      const missingRow = auditRows.at(-1)
      state.matter = { firmId: "firmA", classification: "privileged" }
      state.member = true
      const existing = await checkPermission(caller(role), action, "m_own")
      const existingRow = auditRows.at(-1)
      state.matter = undefined
      const none = await checkPermission(caller(role), action)
      const noneRow = auditRows.at(-1)

      expect(missing, role).toEqual({ allow: false, reason: "unknown-action" })
      expect(existing, role).toEqual(missing)
      expect(none, role).toEqual(missing)
      expect(missingRow).toMatchObject({
        action,
        decision: "deny",
        reason: "unknown-action",
        target: "matters/m_missing",
      })
      expect(existingRow).toMatchObject({
        action,
        decision: "deny",
        reason: "unknown-action",
        target: "matters/m_own",
      })
      expect(noneRow).toMatchObject({
        action,
        decision: "deny",
        reason: "unknown-action",
        target: "firms/firmA",
      })
      expect(missingRow?.reason).toBe(existingRow?.reason)
      expect(`deny:${action}:${missingRow?.reason}`).toBe(`deny:${action}:unknown-action`)
    }
  })

  it("a known denial is still audited, and a cross-firm known action stays cross-firm", async () => {
    const intern = await checkPermission(caller("intern"), "research")
    expect(intern).toEqual({ allow: false, reason: "intern-channel-denied" })
    expect(auditRows.at(-1)).toMatchObject({ action: "research", decision: "deny", reason: "intern-channel-denied" })

    state.matter = { firmId: "firmB", classification: "public" }
    state.member = true
    const cross = await checkPermission(caller("partner"), "committee_brain_read", "m_other")
    expect(cross).toEqual({ allow: false, reason: "cross-firm" })
    state.matter = { firmId: "firmA", classification: "privileged" }
    state.member = false
    const outsider = await checkPermission(caller("partner"), "committee_brain_read", "m_own")
    expect(outsider).toEqual({ allow: false, reason: "not-member" })
  })
})
