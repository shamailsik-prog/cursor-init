/**
 * Builds platform/p5/actionRegistry.json. The committed file is this function's output;
 * tests/p5.permission-unknown-action.test.ts fails if the two diverge.
 *
 * A caller is a production call that passes an action into decide(), directly or through
 * checkPermission / requirePermission / requirePartner / the D1, D4 and committee wrappers.
 */
import ts from "typescript"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PROD_ROOTS = ["app", "services", "platform", "functions/src", "ops", "scripts"]
const TEST_ROOTS = ["tests", "functions/test"]

export const REGISTRY_BASE = "bb8fcc3f02b0fc0a6bcc1c705bcbc270ad3c7961"

const CALLEES = new Set([
  "checkPermission",
  "requirePermission",
  "requirePartner",
  "decide",
  "decideFromTable",
  "canAccessMatter",
  "resolveCommitteeScope",
  "gate",
  "gateMatter",
  "requireMatterAction",
  "requireStillPermitted",
  "loadDraftForCaller",
  "rereadDraft",
  "runDecision",
])

/** Parameter and default call sites: the action string is not a literal on that line. */
const RESOLVED: Record<string, { actions: string[]; note: string }> = {
  "platform/p5/checkPermission.ts:38": {
    actions: [],
    note: "Platform entry. Forwards `action` to the local decide(), which calls decideFromTable.",
  },
  "platform/p5/checkPermission.ts:86": {
    actions: [],
    note: "Platform entry. decideFromTable is platform/p5/permissionDecision.ts decide().",
  },
  "platform/p5/committeeScope.ts:88": {
    actions: ["committee_brain", "committee_brain_read"],
    note: "Parameter `action`, default \"committee_brain\" (committeeScope.ts:79). resolveCommitteeScope (line 103) and app/api/p1/committee-brain/route.ts:279 leave the default. route.ts:135 passes \"committee_brain_read\".",
  },
  "platform/p5/committeeScope.ts:103": {
    actions: ["committee_brain"],
    note: "resolveCommitteeScope calls canAccessMatter with no action argument, so the default \"committee_brain\" is what reaches checkPermission.",
  },
  "app/api/p1/committee-brain/route.ts:279": {
    actions: ["committee_brain"],
    note: "resolveCommitteeScope, which uses canAccessMatter's default \"committee_brain\".",
  },
  "functions/src/p5/permission.ts:81": {
    actions: [],
    note: "Functions requirePermission forwards `action` to checkPermission. Callers are the requirePermission rows.",
  },
  "functions/src/p5/permission.ts:122": {
    actions: [],
    note: "Functions entry. evaluate() calls the shared decide(). No second table and no fall-through of its own.",
  },
  "functions/src/p5/common.ts:184": {
    actions: [
      "identity.manage_users",
      "identity.set_claims",
      "identity.deactivate",
      "identity.attest_independent_partner",
      "mfa.enforce",
      "mfa.approve_disable",
    ],
    note: "requirePartner(caller, action: FirmAdminAction). Sources: functions/src/p5/identity.ts:322, :391, :570, :643 and functions/src/p5/mfa.ts:108, :179.",
  },
  "functions/src/d1/matter/ops.ts:443": {
    actions: ["matter.read", "matter.advance_stage", "matter.close"],
    note: "gateMatter's action parameter. Sources: matter/ops.ts:466 matter.read, :565 matter.advance_stage, :612 matter.close.",
  },
  "functions/src/d1/entity/read.ts:73": {
    actions: ["entity.review", "entity.confirm", "entity.dispute", "entity.reject", "entity.unmerge"],
    note: "gate() requirePermission. Default \"entity.review\" (read.ts:72), used at :161, :338, :379. entity/ops.ts:65 passes the runDecision action (entity.confirm :121, entity.dispute :184, entity.reject :204). entity/unmerge.ts:40 passes \"entity.unmerge\".",
  },
  "functions/src/d1/entity/read.ts:161": {
    actions: ["entity.review"],
    note: "gate(caller) with the default \"entity.review\".",
  },
  "functions/src/d1/entity/read.ts:338": {
    actions: ["entity.review"],
    note: "gate(caller) with the default \"entity.review\".",
  },
  "functions/src/d1/entity/read.ts:379": {
    actions: ["entity.review"],
    note: "gate(caller) with the default \"entity.review\".",
  },
  "functions/src/d1/entity/ops.ts:65": {
    actions: ["entity.confirm", "entity.dispute", "entity.reject"],
    note: "runDecision's action parameter. Sources: ops.ts:121 entity.confirm, :184 entity.dispute, :204 entity.reject.",
  },
  "functions/src/d4/drafts.ts:144": {
    actions: ["draft.create", "draft.edit", "draft.gate", "draft.read", "draft.override", "draft.approve"],
    note: "requireMatterAction(caller, action: DraftAction). Sources: drafts.ts:183 (loadDraftForCaller's action), :348 draft.create, :634 draft.read.",
  },
  "functions/src/d4/drafts.ts:163": {
    actions: ["draft.create", "draft.edit", "draft.gate", "draft.read", "draft.override", "draft.approve"],
    note: "requireStillPermitted calls decide() with action: DraftAction. Sources: drafts.ts:363 draft.create, :464 draft.edit; gateOps.ts:477 (rereadDraft's action), :750 draft.override.",
  },
  "functions/src/d4/drafts.ts:183": {
    actions: ["draft.create", "draft.edit", "draft.gate", "draft.read", "draft.override", "draft.approve"],
    note: "loadDraftForCaller forwards `action`. Sources: drafts.ts:524 and :548 draft.edit, :583 and :696 draft.read; gateOps.ts:622 draft.gate, :677 draft.read, :738 draft.override, :855 draft.approve.",
  },
  "functions/src/d4/gateOps.ts:477": {
    actions: ["draft.gate", "draft.approve"],
    note: "rereadDraft forwards `action` to requireStillPermitted. Sources: gateOps.ts:639 draft.gate, :877 draft.approve.",
  },
}

const TEST_ACTION = /"(read_matter|read_firm|read|intimation_register|record_accounts_entry|committee_brain_read|committee_brain)"/g

export type RegistryCaller = {
  file: string
  line: number
  via: string
  binding: "literal" | "parameter"
  action: string | null
  actions: string[]
  note: string | null
}

export type ActionRegistry = {
  base: string
  inventoryCount: number
  uniqueLiveActionCount: number
  literalCount: number
  parameterCount: number
  genericActions: string[]
  accountsRegisterActionsAlsoOnGenericPath: string[]
  tableActionsWithNoLiveCaller: string[]
  genericActionsWithNoLiveCaller: string[]
  searchedWithNoCaller: string[]
  whatsApp: string[]
  uniqueLiveActions: string[]
  callers: RegistryCaller[]
  testCallers: RegistryCaller[]
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".next" || ent.name === "lib" || ent.name === "coverage") continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p)
  }
  return out
}

function keepCall(rel: string, name: string, importedDecide: boolean, importedCan: boolean, importedScope: boolean): boolean {
  if (name === "checkPermission" || name === "requirePermission" || name === "requirePartner") return true
  if (name === "decide" || name === "decideFromTable") return importedDecide || rel === "platform/p5/checkPermission.ts"
  if (name === "canAccessMatter") return importedCan || rel === "platform/p5/committeeScope.ts"
  if (name === "resolveCommitteeScope") return importedScope
  if (name === "gate") {
    return (
      rel === "functions/src/d1/entity/read.ts" ||
      rel === "functions/src/d1/entity/ops.ts" ||
      rel === "functions/src/d1/entity/unmerge.ts"
    )
  }
  return ["gateMatter", "requireMatterAction", "requireStillPermitted", "loadDraftForCaller", "rereadDraft", "runDecision"].includes(name)
}

function scanProduction(): RegistryCaller[] {
  const callers: RegistryCaller[] = []
  for (const file of PROD_ROOTS.flatMap((r) => walk(path.join(root, r)))) {
    const text = fs.readFileSync(file, "utf8")
    if (![...CALLEES].some((n) => text.includes(`${n}(`))) continue
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const rel = path.relative(root, file)
    let importedDecide = false
    let importedCan = false
    let importedScope = false
    const visitImport = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const mod = node.moduleSpecifier.text
        const named = node.importClause?.namedBindings
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            const imported = (el.propertyName ?? el.name).text
            if (mod.includes("permissionDecision") && (imported === "decide" || el.name.text === "decideFromTable")) importedDecide = true
            if (mod.includes("committeeScope") && imported === "canAccessMatter") importedCan = true
            if (mod.includes("committeeScope") && imported === "resolveCommitteeScope") importedScope = true
          }
        }
      }
      ts.forEachChild(node, visitImport)
    }
    visitImport(sf)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expr = node.expression
        const name = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : null
        if (name && CALLEES.has(name) && keepCall(rel, name, importedDecide, importedCan, importedScope)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
          const direct = node.arguments.flatMap((a) => (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) ? [a.text] : []))
          const key = `${rel}:${line}`
          if (direct.length > 0) {
            callers.push({
              file: rel,
              line,
              via: name,
              binding: "literal",
              action: direct[0],
              actions: [direct[0]],
              note: null,
            })
          } else {
            const resolved = RESOLVED[key]
            if (!resolved) throw new Error(`parameter call site has no resolution: ${key} via ${name}`)
            callers.push({
              file: rel,
              line,
              via: name,
              binding: "parameter",
              action: resolved.actions.length === 1 ? resolved.actions[0] : null,
              actions: resolved.actions,
              note: resolved.note,
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  callers.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.via.localeCompare(b.via))
  return callers
}

function scanTestCallers(): RegistryCaller[] {
  const callers: RegistryCaller[] = []
  for (const file of TEST_ROOTS.flatMap((r) => walk(path.join(root, r)))) {
    const text = fs.readFileSync(file, "utf8")
    if (!text.includes("checkPermission") && !text.includes("permissionDecision") && !text.includes("canAccessMatter")) continue
    const rel = path.relative(root, file)
    if (
      rel === "tests/p5.action-registry-scan.ts" ||
      rel === "tests/p5.permission-matrix.ts" ||
      rel === "tests/p5.permission-unknown-action.test.ts" ||
      rel === "functions/test/p5.unknown-action.unit.test.ts"
    ) {
      continue
    }
    const lines = text.split("\n")
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return
      for (const match of line.matchAll(TEST_ACTION)) {
        callers.push({
          file: rel,
          line: i + 1,
          via: "test",
          binding: "literal",
          action: match[1],
          actions: [match[1]],
          note: "Existing suite. Not a production caller. The result must stay what it was at the base.",
        })
      }
    })
  }
  callers.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || (a.action ?? "").localeCompare(b.action ?? ""))
  return callers
}

export function buildRegistry(): ActionRegistry {
  const callers = scanProduction()
  const live = new Set<string>()
  for (const caller of callers) for (const action of caller.actions) live.add(action)
  const uniqueLiveActions = [...live].sort()
  const genericActions = [
    "research",
    "draft",
    "list_matters",
    "normalise_case_number",
    "committee_brain",
    "committee_brain_read",
  ]
  const accounts = ["intimation_register", "record_accounts_entry"]
  return {
    base: REGISTRY_BASE,
    inventoryCount: callers.length,
    uniqueLiveActionCount: uniqueLiveActions.length,
    literalCount: callers.filter((c) => c.binding === "literal").length,
    parameterCount: callers.filter((c) => c.binding === "parameter").length,
    genericActions,
    // Q04 gave intimation_register and record_accounts_entry their own row.
    accountsRegisterActionsAlsoOnGenericPath: [],
    tableActionsWithNoLiveCaller: accounts.filter((a) => !live.has(a)),
    genericActionsWithNoLiveCaller: genericActions.filter((a) => !live.has(a)),
    searchedWithNoCaller: ["ops", "scripts", "functions/src/cli"],
    whatsApp: ["services/d2-1/whatsapp.ts:71 list_matters", "services/d2-1/whatsapp.ts:81 research"],
    uniqueLiveActions,
    callers,
    testCallers: scanTestCallers(),
  }
}
