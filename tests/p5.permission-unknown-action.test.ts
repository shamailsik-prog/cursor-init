/**
 * Q01 SEC-P01: an action that is not in a table is deny unknown-action.
 * Known actions stay on the base bb8fcc3f matrix. The registry is the caller inventory.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildRegistry } from "./p5.action-registry-scan"
import {
  KNOWN_MATRIX_ACTIONS,
  MATRIX_BASE,
  MATRIX_CLEARANCES,
  MATRIX_MATTERS,
  MATRIX_ROLES,
  UNKNOWN_MATRIX_ACTIONS,
  evaluateMatrixRow,
  matrixKey,
} from "./p5.permission-matrix"
import { checkPermission as functionsCheckPermission } from "../functions/src/p5/permission"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  GENERIC_ACTIONS,
  decide,
  type DecisionCaller,
} from "@/platform/p5/permissionDecision"
import { newStore, type Matter, type Role } from "@/platform/spine/store"

const docs = vi.hoisted(() => ({
  matter: undefined as { firmId: string; classification: string } | undefined,
  member: false,
}))
const functionAudit = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock("../functions/src/admin", () => ({
  adminDb: () => ({
    collection: (name: string) => ({
      doc: () => ({
        get: async () =>
          name === "matters"
            ? { exists: docs.matter !== undefined, data: () => docs.matter }
            : name === "matter_members"
              ? { exists: docs.member, data: () => (docs.member ? {} : undefined) }
              : { exists: false, data: () => undefined },
      }),
    }),
  }),
}))
vi.mock("../functions/src/p5/audit", () => ({
  appendAudit: async (row: Record<string, unknown>) => {
    functionAudit.push(row)
  },
}))

const ROOT = path.resolve(import.meta.dirname, "..")
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

const caller = (role: string, clearance: DecisionCaller["clearanceLevel"] = "privileged"): DecisionCaller => ({
  role,
  firmId: "firmA",
  clearanceLevel: clearance,
})

function platformStore(role: string) {
  const store = newStore()
  store.users.set("u1", {
    id: "u1",
    firmId: "firmA",
    role: role as Role,
    clearanceLevel: "privileged",
    active: true,
  })
  store.matters.set("m_own", {
    id: "m_own",
    firmId: "firmA",
    classification: "privileged",
    clientId: "c",
    title: "t",
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
  } as Matter)
  store.members.set(store.memberKey("m_own", "u1"), { matterId: "m_own", userId: "u1", firmId: "firmA" })
  return store
}

beforeEach(() => {
  docs.matter = undefined
  docs.member = false
  functionAudit.length = 0
})
afterEach(() => {
  docs.matter = undefined
  docs.member = false
})

describe("action registry", () => {
  it("matches the scan of the tree, including every parameter caller named in the spec", () => {
    const committed = JSON.parse(readFileSync(path.join(ROOT, "platform/p5/actionRegistry.json"), "utf8"))
    expect(committed).toEqual(buildRegistry())
    expect(committed.inventoryCount).toBe(committed.callers.length)
    expect(committed.base).toBe(MATRIX_BASE)
    const keys = new Set(committed.callers.map((c: { file: string; line: number }) => `${c.file}:${c.line}`))
    for (const required of [
      "functions/src/d1/matter/ops.ts:443",
      "functions/src/d4/drafts.ts:163",
      "platform/p5/committeeScope.ts:88",
      "services/d2-1/whatsapp.ts:71",
      "services/d2-1/whatsapp.ts:81",
    ]) {
      expect(keys.has(required), required).toBe(true)
    }
  })

  it("the generic table is exactly the inventory's implicit actions", () => {
    expect([...GENERIC_ACTIONS]).toEqual(buildRegistry().genericActions)
  })
})

describe("unknown actions are denied before the matter gate", () => {
  it.each(UNKNOWN)("decide denies %j for every role, with and without a matter", (action) => {
    for (const role of ROLES) {
      const noMatter = decide(caller(role), action, undefined, false)
      const missing = decide(caller(role), action, null, false)
      const existing = decide(caller(role), action, { firmId: "firmA", classification: "privileged" }, true)
      const otherFirm = decide(caller(role), action, { firmId: "firmB", classification: "public" }, true)
      const deleted = decide(caller(role), action, { firmId: "firmA", classification: "privileged", deleted: true }, true)
      for (const decision of [noMatter, missing, existing, otherFirm, deleted]) {
        expect(decision, role).toEqual({ allow: false, reason: "unknown-action" })
      }
      expect(noMatter.reason).toBe(existing.reason)
      expect(missing.reason).toBe(existing.reason)
    }
    expect(decide(null, action, undefined, false)).toEqual({ allow: false, reason: "no-user" })
    expect(decide(null, action, null, false)).toEqual({ allow: false, reason: "no-user" })
  })

  it("does not trim, case-fold, or match a prefix or suffix", () => {
    const partner = caller("partner")
    expect(decide(partner, "research", undefined, false)).toEqual({ allow: true, reason: "ok" })
    expect(decide(partner, "draft", undefined, false)).toEqual({ allow: true, reason: "ok" })
    expect(decide(partner, "Research", undefined, false).reason).toBe("unknown-action")
    expect(decide(partner, "DRAFT", undefined, false).reason).toBe("unknown-action")
    expect(decide(partner, " draft", undefined, false).reason).toBe("unknown-action")
    expect(decide(partner, "draft ", undefined, false).reason).toBe("unknown-action")
    expect(decide(partner, "draft.x", undefined, false).reason).toBe("unknown-action")
    expect(decide(partner, "x.draft", undefined, false).reason).toBe("unknown-action")
    expect(decide(partner, "research\u0000", undefined, false).reason).toBe("unknown-action")
  })

  it("an own_matters scope does not turn an unknown action into a client-channel denial", () => {
    expect(decide(caller("associate"), "zzz", undefined, false, { scope: "own_matters" })).toEqual({
      allow: false,
      reason: "unknown-action",
    })
    expect(decide(caller("associate"), "research", undefined, false, { scope: "own_matters" })).toEqual({
      allow: false,
      reason: "client-channel-denied",
    })
  })

  it("checkPermission audits the denial, and the reason does not say whether the matter exists", () => {
    for (const action of ["zzz", "matter.delete_all", ""]) {
      for (const role of ROLES) {
        const absent = platformStore(role)
        const present = platformStore(role)
        const missing = checkPermission(absent, "u1", action, "m_missing")
        const existing = checkPermission(present, "u1", action, "m_own")
        const none = checkPermission(platformStore(role), "u1", action)
        expect(missing).toEqual({ allow: false, reason: "unknown-action" })
        expect(existing).toEqual(missing)
        expect(none).toEqual(missing)
        expect(absent.audit.at(-1)?.reason).toBe(`deny:${action}:unknown-action`)
        expect(present.audit.at(-1)?.reason).toBe(`deny:${action}:unknown-action`)
        expect(absent.audit.at(-1)?.reason).toBe(present.audit.at(-1)?.reason)
      }
    }
  })

  it("the functions path denies and audits the same reason for an existing and a missing matter", async () => {
    const who = { uid: "u1", firmId: "firmA", role: "partner" as const, clearanceLevel: "privileged" as const }
    docs.matter = undefined
    docs.member = false
    const missing = await functionsCheckPermission(who, "zzz", "m_missing")
    const missingAudit = functionAudit.at(-1)
    docs.matter = { firmId: "firmA", classification: "privileged" }
    docs.member = true
    const existing = await functionsCheckPermission(who, "zzz", "m_own")
    const existingAudit = functionAudit.at(-1)
    const none = await functionsCheckPermission(who, "zzz")
    expect(missing).toEqual({ allow: false, reason: "unknown-action" })
    expect(existing).toEqual(missing)
    expect(none).toEqual(missing)
    expect(missingAudit).toMatchObject({ action: "zzz", decision: "deny", reason: "unknown-action" })
    expect(existingAudit).toMatchObject({ action: "zzz", decision: "deny", reason: "unknown-action" })
    expect(missingAudit?.reason).toBe(existingAudit?.reason)
  })
})

describe("base parity matrix", () => {
  const fixture = JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/p5.permission-base-matrix.json"), "utf8")) as {
    base: string
    knownCount: number
    unknownCount: number
    rows: string[]
  }

  it("matches bb8fcc3f on every known action and differs only on unknown actions", () => {
    expect(fixture.base).toBe(MATRIX_BASE)
    expect(fixture.rows).toHaveLength(fixture.knownCount + fixture.unknownCount)
    const base = new Map(fixture.rows.map((row) => [row.split("\t").slice(0, 4).join("\t"), row.split("\t").slice(4).join("\t")]))
    const knownDiff: string[] = []
    const unknownDiff: string[] = []
    let unknownSame = 0
    const check = (actions: readonly string[], unknown: boolean) => {
      for (const action of actions) {
        for (const role of MATRIX_ROLES) {
          for (const matter of MATRIX_MATTERS) {
            for (const clearance of MATRIX_CLEARANCES) {
              const key = matrixKey({ action, role, matter, clearance })
              const decision = evaluateMatrixRow(action, role, matter, clearance)
              const head = `${decision.allow ? "allow" : "deny"}\t${decision.reason}`
              const previous = base.get(key)
              expect(previous, key).toBeDefined()
              if (previous !== head) {
                ;(unknown ? unknownDiff : knownDiff).push(`${key} base=${previous} head=${head}`)
              } else if (unknown) unknownSame++
              if (unknown && role !== null) expect(decision).toEqual({ allow: false, reason: "unknown-action" })
              if (unknown && role === null) expect(decision).toEqual({ allow: false, reason: "no-user" })
            }
          }
        }
      }
    }
    check(KNOWN_MATRIX_ACTIONS, false)
    check(UNKNOWN_MATRIX_ACTIONS, true)
    expect(knownDiff).toEqual([])
    expect(unknownDiff).toHaveLength(660)
    expect(unknownSame).toBe(110)
    expect(fixture.knownCount).toBe(3850)
    expect(fixture.unknownCount).toBe(770)
    expect(fixture.rows).toHaveLength(4620)
  })
})

describe("decide() has no allow-by-default", () => {
  it("the last statement is deny unknown-action, and every allow sits in a table branch", () => {
    const file = path.join(ROOT, "platform/p5/permissionDecision.ts")
    const text = readFileSync(file, "utf8")
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const fn = sf.statements.find(
      (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "decide",
    )
    expect(fn?.body).toBeDefined()
    const body = fn!.body!
    const last = body.statements[body.statements.length - 1]
    expect(ts.isReturnStatement(last)).toBe(true)
    expect(last.getText(sf).replace(/\s+/g, " ")).toBe('return deny("unknown-action")')
    const source = body.getText(sf)
    expect(source).not.toMatch(/\.trim\s*\(/)
    expect(source).not.toMatch(/toLowerCase|toUpperCase|startsWith|endsWith/)
    expect(source.match(/return deny\("unknown-action"\)/g)).toEqual(['return deny("unknown-action")'])

    const table = /isFirmAdminAction|isRetentionAction|isRegisteredAction|isD1Action|isJobAction|isAlertAction|isAiAction|isDraftAction|isDocTypeAction|isGenericAction|ACCOUNTS_REGISTER_ACTIONS/
    const offenders: string[] = []
    const walk = (node: ts.Node, stack: ts.Node[]) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "allow"
      ) {
        const guarded = stack.some(
          (parent) => ts.isIfStatement(parent) && table.test(parent.expression.getText(sf)),
        )
        if (!guarded) offenders.push(node.parent.getText(sf).replace(/\s+/g, " "))
      }
      const next = [...stack, node]
      ts.forEachChild(node, (child) => walk(child, next))
    }
    walk(body, [])
    expect(offenders).toEqual([])
  })
})
