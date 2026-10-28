import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const DELETION_E2E = path.join(__dirname, "f42-retention-deletion.e2e.emu.test.ts")

/** Closes `afterAll(async () => { … }, <timeout>)` — any numeric timeout, not only 120_000. */
const AFTER_ALL_ASYNC_HOOK_CLOSE = /\}\s*,\s*[\d_]+\s*\)/

/**
 * FA-F42-R1-015-001-001 / FA-F42-R1-015-001-001-001-001: regex tempering so the required
 * `deleteFirmScopedData(firms, uids)` cannot sit after the hook body close (Mmove / MmoveT /
 * MmoveNoTO / MmoveOtherTO). Complements AST check for hooks with no timeout argument.
 */
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = new RegExp(
  [
    String.raw`afterAll\s*\(\s*async\s*\(\s*\)\s*=>\s*\{`,
    String.raw`(?:(?!\}\s*,\s*[\d_]+\s*\))[\s\S])*`,
    String.raw`deleteFirmScopedData\s*\(\s*firms\s*,\s*uids\s*\)`,
    String.raw`(?:(?!\}\s*,\s*[\d_]+\s*\))[\s\S])*?`,
    String.raw`\}\s*(?:,\s*[\d_]+\s*)?\)`,
  ].join(""),
)

/** Pre-#188 vacuous span; **MmoveT** still matches this while failing `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD`. */
export const VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD =
  /afterAll[\s\S]*?deleteFirmScopedData\s*\(\s*firms\s*,\s*uids\s*\)/

const UNIT_SELF = path.join(__dirname, "f42-e2e-cleanup.unit.test.ts")

const WIRING_GUARD_CONST = "AFTER_ALL_DELETE_FIRMS_UIDS_GUARD"

function isExpectSrcCall(call: ts.CallExpression): boolean {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "expect") return false
  const arg0 = call.arguments[0]
  return arg0 !== undefined && ts.isIdentifier(arg0) && arg0.text === "src"
}

function isExpectSrcToMatchOnIdentifier(node: ts.CallExpression, guardName: string): ts.Identifier | undefined {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "toMatch" ||
    !ts.isCallExpression(node.expression.expression) ||
    !isExpectSrcCall(node.expression.expression)
  ) {
    return undefined
  }
  const arg = node.arguments[0]
  if (arg && ts.isIdentifier(arg) && arg.text === guardName) return arg
  return undefined
}

function collectExpectSrcToMatchGuardCalls(node: ts.Node, guardName: string, out: ts.CallExpression[]): void {
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n) && isExpectSrcToMatchOnIdentifier(n, guardName)) {
      out.push(n)
    }
    ts.forEachChild(n, walk)
  }
  walk(node)
}

function statementDirectChildOfBlock(stmt: ts.Statement, block: ts.Block): boolean {
  return block.statements.some((s) => s === stmt)
}

function containingStatement(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isStatement(current)) return current
    current = current.parent
  }
  return undefined
}

function nodeIsDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

/** `false`, `0`, `null`, `undefined`, or `!true`-style unary on a static-false operand. */
function expressionIsStaticallyFalse(expr: ts.Expression): boolean {
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return true
  if (ts.isNumericLiteral(expr) && expr.text === "0") return true
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true
  if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return true
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return expressionIsStaticallyTrue(expr.operand)
  }
  return false
}

function expressionIsStaticallyTrue(expr: ts.Expression): boolean {
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true
  if (ts.isNumericLiteral(expr) && expr.text !== "0") return true
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return expressionIsStaticallyFalse(expr.operand)
  }
  return false
}

/**
 * FA-F42-R1-015-001-001-002-002-002 / FA-F42-R1-015-001-001-002-002-002-002: the helper must contain
 * exactly one live statement of the form `expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)` — not a
 * weaker shape that still embeds that call (runtime `&&`/`||`/`?:`, arrow/IIFE wrappers, deferred callbacks,
 * try/catch swallow, or static-false dead branches).
 */
function expectSrcToMatchGuardIsLiveTopLevelStatement(helperBody: ts.Block, toMatchCall: ts.CallExpression): boolean {
  const stmt = containingStatement(toMatchCall)
  if (!stmt || !statementDirectChildOfBlock(stmt, helperBody)) return false
  if (!ts.isExpressionStatement(stmt) || stmt.expression !== toMatchCall) return false

  let current: ts.Node | undefined = toMatchCall.parent
  while (current && current !== helperBody) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return false
    if (ts.isCallExpression(current)) return false
    if (ts.isBinaryExpression(current)) {
      const op = current.operatorToken.kind
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) return false
    }
    if (ts.isConditionalExpression(current)) return false

    current = current.parent
  }

  current = toMatchCall
  while (current && current !== helperBody) {
    if (ts.isTryStatement(current)) {
      if (
        nodeIsDescendantOf(toMatchCall, current.tryBlock) ||
        (current.catchClause !== undefined && nodeIsDescendantOf(toMatchCall, current.catchClause))
      ) {
        return false
      }
    }

    if (ts.isIfStatement(current)) {
      if (expressionIsStaticallyFalse(current.expression) && nodeIsDescendantOf(toMatchCall, current.thenStatement)) {
        return false
      }
      if (
        current.elseStatement !== undefined &&
        expressionIsStaticallyTrue(current.expression) &&
        nodeIsDescendantOf(toMatchCall, current.elseStatement)
      ) {
        return false
      }
    }

    if (ts.isConditionalExpression(current)) {
      if (expressionIsStaticallyFalse(current.condition) && nodeIsDescendantOf(toMatchCall, current.whenTrue)) {
        return false
      }
      if (expressionIsStaticallyTrue(current.condition) && nodeIsDescendantOf(toMatchCall, current.whenFalse)) {
        return false
      }
    }

    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (expressionIsStaticallyFalse(current.left) && nodeIsDescendantOf(toMatchCall, current.right)) {
        return false
      }
    }

    if (ts.isCaseClause(current) || ts.isDefaultClause(current)) {
      let walk: ts.Node | undefined = current.parent
      while (walk) {
        if (ts.isSwitchStatement(walk)) {
          if (expressionIsStaticallyFalse(walk.expression)) return false
          break
        }
        walk = walk.parent
      }
    }

    current = current.parent
  }

  return true
}

function helperHasCommentOrToSatisfyGuardBypass(body: ts.Block): boolean {
  let forbidden = false
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      if (
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "toSatisfy" &&
        ts.isCallExpression(n.expression.expression) &&
        isExpectSrcCall(n.expression.expression)
      ) {
        forbidden = true
      }
      if (
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "toBe" &&
        ts.isCallExpression(n.expression.expression) &&
        ts.isIdentifier(n.expression.expression.expression) &&
        n.expression.expression.expression.text === "expect"
      ) {
        const arg0 = n.expression.expression.arguments[0]
        if (
          arg0 &&
          ts.isCallExpression(arg0) &&
          ts.isPropertyAccessExpression(arg0.expression) &&
          arg0.expression.name.text === "test"
        ) {
          const testReceiver = arg0.expression.expression
          if (testReceiver && ts.isIdentifier(testReceiver) && testReceiver.text === "src") {
            forbidden = true
          }
          if (
            testReceiver &&
            ts.isRegularExpressionLiteral(testReceiver) &&
            /afterAll/.test(testReceiver.text)
          ) {
            forbidden = true
          }
          if (
            testReceiver &&
            ts.isIdentifier(testReceiver) &&
            testReceiver.text === "VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD"
          ) {
            forbidden = true
          }
        }
      }
    }
    ts.forEachChild(n, walk)
  }
  for (const stmt of body.statements) walk(stmt)
  return forbidden
}

function helperTextForbiddenPatterns(body: ts.Block): boolean {
  let bad = false
  const walk = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === "VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD") bad = true
    if (ts.isRegularExpressionLiteral(n)) {
      const t = n.text
      if (/\[\^]/.test(t)) bad = true
      if (/afterAll/.test(t) && /deleteFirmScopedData/.test(t) && /\[[\s\\]*S\\?\]\*\?/.test(t)) bad = true
    }
    ts.forEachChild(n, walk)
  }
  for (const stmt of body.statements) walk(stmt)
  return bad
}

function stripCommentsFromSlice(fullText: string, start: number, end: number): string {
  const text = fullText.slice(start, end)
  const parts: string[] = []
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text)
  while (true) {
    const kind = scanner.scan()
    if (kind === ts.SyntaxKind.EndOfFileToken) break
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      continue
    }
    parts.push(scanner.getTokenText())
  }
  return parts.join("")
}

function collectBindingName(binding: ts.BindingName, name: string, out: ts.Identifier[]): void {
  if (ts.isIdentifier(binding)) {
    if (binding.text === name) out.push(binding)
    return
  }
  if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
    for (const element of binding.elements) {
      if (!ts.isBindingElement(element)) continue
      const localName = element.name
      if (ts.isIdentifier(localName) && localName.text === name) {
        out.push(localName)
      } else if (localName) {
        collectBindingName(localName, name, out)
      }
    }
  }
}

function localBindingsNamed(node: ts.Node, name: string, out: ts.Identifier[]): void {
  if (ts.isVariableDeclaration(node) && node.name) {
    collectBindingName(node.name, name, out)
  }
  ts.forEachChild(node, (child) => localBindingsNamed(child, name, out))
}

function helperBindingsNamed(helper: ts.FunctionDeclaration, name: string, out: ts.Identifier[]): void {
  for (const param of helper.parameters) {
    if (param.name) collectBindingName(param.name, name, out)
  }
  if (helper.body) localBindingsNamed(helper.body, name, out)
}

function findModuleGuardExport(sf: ts.SourceFile): ts.VariableDeclaration | undefined {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === WIRING_GUARD_CONST) return decl
    }
  }
  return undefined
}

function createSingleFileProgram(unitSrc: string, fileName: string): { program: ts.Program; sf: ts.SourceFile } {
  const sf = ts.createSourceFile(fileName, unitSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const host = ts.createCompilerHost({})
  const defaultRead = host.readFile.bind(host)
  const defaultExists = host.fileExists.bind(host)
  const defaultGet = host.getSourceFile.bind(host)
  host.readFile = (f) => (f === fileName ? unitSrc : defaultRead(f))
  host.fileExists = (f) => f === fileName || defaultExists(f)
  host.getSourceFile = (f, languageVersion, ...rest) =>
    f === fileName ? sf : defaultGet(f, languageVersion, ...rest)
  const program = ts.createProgram(
    [fileName],
    { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    host,
  )
  return { program, sf }
}

function toMatchIdentifierResolvesToModuleExport(
  program: ts.Program,
  moduleExport: ts.VariableDeclaration,
  toMatchId: ts.Identifier,
): boolean {
  const checker = program.getTypeChecker()
  const sym = checker.getSymbolAtLocation(toMatchId)
  if (!sym) return false
  const exportSym = checker.getSymbolAtLocation(moduleExport.name)
  if (!exportSym) return false

  const resolve = (s: ts.Symbol): ts.Symbol =>
    s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s

  const usage = resolve(sym)
  const exported = resolve(exportSym)
  if (usage === exported) return true

  const exportDecls = new Set(exported.getDeclarations() ?? [])
  for (const decl of usage.getDeclarations() ?? []) {
    if (decl === moduleExport || exportDecls.has(decl)) return true
  }
  return false
}

function findExportedHelper(sf: ts.SourceFile): ts.FunctionDeclaration | undefined {
  for (const stmt of sf.statements) {
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name?.text === "assertF42DeletionE2EAfterAllWiring" &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      return stmt
    }
  }
  return undefined
}

/**
 * FA-F42-R1-015-001-001-002-001-001 meta pin: `expect(src).toMatch` must reference the module export
 * `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD`, not a shadowed binding (MshadowAltSyntax, MshadowParam,
 * MshadowDestructure) or inline vacuous regex. The call must be a live top-level helper-body statement
 * (FA-F42-R1-015-001-001-002-002-002; kills MtrySwallow / MdeadIf).
 */
export function metaPinHelperUsesModuleGuard(unitSrc: string, fileName = UNIT_SELF): boolean {
  const { program, sf } = createSingleFileProgram(unitSrc, fileName)
  const helper = findExportedHelper(sf)
  if (!helper?.body) return false

  const moduleExport = findModuleGuardExport(sf)
  if (!moduleExport) return false

  const bindings: ts.Identifier[] = []
  helperBindingsNamed(helper, WIRING_GUARD_CONST, bindings)
  if (bindings.length > 0) return false

  const toMatchCalls: ts.CallExpression[] = []
  collectExpectSrcToMatchGuardCalls(helper.body, WIRING_GUARD_CONST, toMatchCalls)
  if (toMatchCalls.length !== 1) return false

  const toMatchCall = toMatchCalls[0]!
  const toMatchId = isExpectSrcToMatchOnIdentifier(toMatchCall, WIRING_GUARD_CONST)
  if (!toMatchId) return false
  if (!toMatchIdentifierResolvesToModuleExport(program, moduleExport, toMatchId)) return false
  if (!expectSrcToMatchGuardIsLiveTopLevelStatement(helper.body, toMatchCall)) return false

  if (helperHasCommentOrToSatisfyGuardBypass(helper.body)) return false
  if (helperTextForbiddenPatterns(helper.body)) return false

  const helperSliceStart = helper.getStart(sf)
  const helperSliceEnd = helper.getEnd()
  const helperCodeOnly = stripCommentsFromSlice(unitSrc, helperSliceStart, helperSliceEnd)
  if (!/\bAFTER_ALL_DELETE_FIRMS_UIDS_GUARD\b/.test(helperCodeOnly)) return false

  return true
}

/**
 * FA-F42-R1-015-001-001-002-002: M4 `it` body must be a single call to the shared wiring helper (no inline
 * `expect(src).toMatch`, no comment-only delegation).
 */
export function metaPinM4TestUsesSharedHelper(unitSrc: string, fileName = UNIT_SELF): boolean {
  const sf = ts.createSourceFile(fileName, unitSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let m4It: ts.ArrowFunction | undefined

  const walkStatements = (statements: ts.NodeArray<ts.Statement>) => {
    for (const stmt of statements) {
      if (!ts.isExpressionStatement(stmt)) continue
      const expr = stmt.expression
      if (!ts.isCallExpression(expr)) continue
      if (!ts.isIdentifier(expr.expression)) continue
      const name = expr.expression.text
      if (name === "describe") {
        const descBody = expr.arguments[1]
        if (descBody && (ts.isArrowFunction(descBody) || ts.isFunctionExpression(descBody))) {
          const inner = descBody.body
          if (ts.isBlock(inner)) walkStatements(inner.statements)
        }
        continue
      }
      if (name !== "it") continue
      const title = expr.arguments[0]
      if (!title || !ts.isStringLiteral(title)) continue
      if (!title.text.startsWith("afterAll wires deleteFirmScopedData")) continue
      const fn = expr.arguments[1]
      if (fn && ts.isArrowFunction(fn)) m4It = fn
    }
  }

  walkStatements(sf.statements)
  if (!m4It?.body || !ts.isBlock(m4It.body)) return false

  let wiringCalls = 0
  let inlineSrcToMatch = false
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression) && n.expression.text === "assertF42DeletionE2EAfterAllWiring") {
        wiringCalls++
      }
      if (isExpectSrcToMatchOnIdentifier(n, WIRING_GUARD_CONST)) inlineSrcToMatch = true
    }
    ts.forEachChild(n, walk)
  }
  for (const stmt of m4It.body.statements) walk(stmt)

  if (wiringCalls !== 1 || inlineSrcToMatch) return false

  for (const stmt of m4It.body.statements) {
    if (ts.isExpressionStatement(stmt)) continue
    if (ts.isVariableStatement(stmt)) {
      const decl = stmt.declarationList.declarations[0]
      if (!decl?.initializer || !ts.isCallExpression(decl.initializer)) return false
      const init = decl.initializer
      if (!ts.isIdentifier(init.expression) || init.expression.text !== "readFileSync") return false
      continue
    }
    return false
  }

  return true
}

/** Single production wiring check for `f42-retention-deletion.e2e.emu.test.ts` afterAll cleanup (M4 + tempered regex). */
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  expect(src).not.toMatch(/deleteFirmScopedData\s*\(\s*\[\s*\]\s*,\s*\[\s*\]\s*\)/)
}

function isDeleteFirmScopedDataFirmsUids(node: ts.CallExpression): boolean {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "deleteFirmScopedData") {
    return false
  }
  if (node.arguments.length !== 2) return false
  const [a0, a1] = node.arguments
  return ts.isIdentifier(a0) && a0.text === "firms" && ts.isIdentifier(a1) && a1.text === "uids"
}

function asyncHookBodyContainsDeleteFirmScopedData(body: ts.ConciseBody): boolean {
  if (!ts.isBlock(body)) return false
  let found = false
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isDeleteFirmScopedDataFirmsUids(node)) {
      found = true
    }
    ts.forEachChild(node, walk)
  }
  for (const stmt of body.statements) {
    walk(stmt)
  }
  return found
}

function isTopLevelAfterAllAsyncCall(stmt: ts.Statement): ts.ArrowFunction | undefined {
  if (!ts.isExpressionStatement(stmt)) return undefined
  const expr = stmt.expression
  if (!ts.isCallExpression(expr)) return undefined
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "afterAll") return undefined
  const fn = expr.arguments[0]
  if (!fn || !ts.isArrowFunction(fn)) return undefined
  if (!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return undefined
  return fn
}

/**
 * True when exactly one **file-top-level** `afterAll(async () => { … })` contains
 * `deleteFirmScopedData(firms, uids)`. Nested hooks (e.g. under `describe.skip`) never run and are rejected (**MdescribeSkip**).
 */
export function deleteFirmScopedDataInAfterAllAsyncHook(source: string, fileName = "fixture.ts"): boolean {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  let matchCount = 0
  for (const stmt of sf.statements) {
    const fn = isTopLevelAfterAllAsyncCall(stmt)
    if (fn && asyncHookBodyContainsDeleteFirmScopedData(fn.body)) {
      matchCount++
    }
  }
  return matchCount === 1
}

describe("FA-F42-R1-015: F42 deletion e2e registers every extra firm and auth user for afterAll cleanup", () => {
  it("records otherFirm (uniq(\"f42x\")) and the low-clearance partner uid", () => {
    const src = readFileSync(DELETION_E2E, "utf8")
    expect(src).toMatch(/const otherFirm = uniq\("f42x"\)[\s\S]*?firms\.push\(otherFirm\)/)
    expect(src).toMatch(
      /const low = await mintIdToken\(\{ firmId: f\.firmId, role: "partner", clearanceLevel: "public" \}\)[\s\S]*?uids\.push\(low\.uid\)/,
    )
  })

  it("afterAll wires deleteFirmScopedData to the file-level firms and uids arrays (kills M4 empty-array mutant)", () => {
    const src = readFileSync(DELETION_E2E, "utf8")
    assertF42DeletionE2EAfterAllWiring(src, DELETION_E2E)
  })

  it("FA-F42-R1-015-001-001-002: vacuous afterAll regex is not wired for production e2e checks (MmoveT control + meta pin)", () => {
    const mmoveTSrc = `
import { afterAll, it } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
afterAll(async () => {}, 120_000)
it.skip("moved cleanup", async () => { await deleteFirmScopedData(firms, uids) }, 120_000)
`
    expect(mmoveTSrc).toMatch(VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
    expect(mmoveTSrc).not.toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)

    const unitSrc = readFileSync(UNIT_SELF, "utf8")
    expect(
      metaPinM4TestUsesSharedHelper(unitSrc),
      "M4 test must be a single assertF42DeletionE2EAfterAllWiring call (AST; kills comment-only delegation)",
    ).toBe(true)

    expect(
      metaPinHelperUsesModuleGuard(unitSrc),
      "shared wiring helper must use module export AFTER_ALL_DELETE_FIRMS_UIDS_GUARD (AST + comment-stripped pin; kills MshadowAltSyntax)",
    ).toBe(true)
  })

  it("FA-F42-R1-015-001-001-002-002: MtoSatisfy / MaliasOutside (comment or toBe/.test bypass evades text-presence meta pin)", () => {
    const toSatisfyMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  // Production uses AFTER_ALL_DELETE_FIRMS_UIDS_GUARD via assertF42DeletionE2EAfterAllWiring
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  expect(/afterAll[\\s\\S]*?deleteFirmScopedData\\s*\\(\\s*firms\\s*,\\s*uids\\s*\\)/.test(src)).toBe(true)
}
`
    expect(metaPinHelperUsesModuleGuard(toSatisfyMutant, "to-satisfy-mutant.ts")).toBe(false)

    const aliasOutsideMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export const VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /afterAll[\\s\\S]*?deleteFirmScopedData/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  // expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  expect(src).toMatch(VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}
`
    expect(metaPinHelperUsesModuleGuard(aliasOutsideMutant, "alias-outside-mutant.ts")).toBe(false)

    const m4CommentOnlyMutant = `
describe("FA-F42-R1-015: x", () => {
  it("afterAll wires deleteFirmScopedData to the file-level firms and uids arrays (kills M4 empty-array mutant)", () => {
    // assertF42DeletionE2EAfterAllWiring(src, DELETION_E2E)
    const src = readFileSync(DELETION_E2E, "utf8")
    expect(src).toMatch(VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  })
})
`
    expect(metaPinM4TestUsesSharedHelper(m4CommentOnlyMutant, "m4-comment-mutant.ts")).toBe(false)
    expect(metaPinM4TestUsesSharedHelper(readFileSync(UNIT_SELF, "utf8"))).toBe(true)
    expect(metaPinHelperUsesModuleGuard(readFileSync(UNIT_SELF, "utf8"))).toBe(true)
  })

  it("FA-F42-R1-015-001-001-002-001: MvacuousConstInHelper (vacuous guard const in helper fails tightened meta pin)", () => {
    const mutantHelper = `export function assertF42DeletionE2EAfterAllWiring(src: string): void {
  expect(src).toMatch(VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}`
    expect(mutantHelper).toContain("AFTER_ALL_DELETE_FIRMS_UIDS_GUARD")
    expect(mutantHelper).not.toMatch(/\bAFTER_ALL_DELETE_FIRMS_UIDS_GUARD\b/)
    expect(mutantHelper).toMatch(/\bVACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD\b/)
  })

  it("FA-F42-R1-015-001-001-002-001-001: MshadowAltSyntax (local shadow + [^] regex evades token-only meta pin)", () => {
    const shadowMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /afterAll[^]*?deleteFirmScopedData\\s*\\(\\s*firms\\s*,\\s*uids\\s*\\)/
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}
`
    const helperBlock = shadowMutant.match(
      /export function assertF42DeletionE2EAfterAllWiring[\s\S]*?\n\}/,
    )?.[0]
    expect(helperBlock).toBeTruthy()
    expect(helperBlock!).toMatch(/\bAFTER_ALL_DELETE_FIRMS_UIDS_GUARD\b/)
    expect(helperBlock!).not.toMatch(/\bVACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD\b/)
    expect(helperBlock!).toMatch(/\[\^]/)
    expect(metaPinHelperUsesModuleGuard(shadowMutant, "shadow-mutant.ts")).toBe(false)
    expect(metaPinHelperUsesModuleGuard(readFileSync(UNIT_SELF, "utf8"))).toBe(true)
  })

  it("FA-F42-R1-015-001-001-002-001-001-001: MshadowParam / MshadowDestructure (param or destructure shadow evades VariableDeclaration-only pin)", () => {
    const paramShadowMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(
  src: string,
  fileName: string,
  AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /afterAll[^]*?deleteFirmScopedData\\s*\\(\\s*firms\\s*,\\s*uids\\s*\\)/
): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}
`
    expect(metaPinHelperUsesModuleGuard(paramShadowMutant, "param-shadow-mutant.ts")).toBe(false)

    const destructureShadowMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  const { AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /afterAll[^]*?deleteFirmScopedData\\s*\\(\\s*firms\\s*,\\s*uids\\s*\\)/ } = {}
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}
`
    expect(metaPinHelperUsesModuleGuard(destructureShadowMutant, "destructure-shadow-mutant.ts")).toBe(false)
    expect(metaPinHelperUsesModuleGuard(readFileSync(UNIT_SELF, "utf8"))).toBe(true)
  })

  it("FA-F42-R1-015-001-001-002-002-002: MtrySwallow / MdeadIf (non-executing toMatch evades CallExpression-only meta pin)", () => {
    const trySwallowMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  try {
    expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  } catch {
    /* swallow assertion failure */
  }
}
`
    expect(metaPinHelperUsesModuleGuard(trySwallowMutant, "try-swallow-mutant.ts")).toBe(false)

    const deadIfMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  if (false) {
    expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  }
}
`
    expect(metaPinHelperUsesModuleGuard(deadIfMutant, "dead-if-mutant.ts")).toBe(false)
    expect(metaPinHelperUsesModuleGuard(readFileSync(UNIT_SELF, "utf8"))).toBe(true)
  })

  it("FA-F42-R1-015-001-001-002-002-002-002: MshortCircuitDyn / MarrowWrap / MdeferredCall (non-exact live statement evades static-only reachability pin)", () => {
    const shortCircuitDynMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  process.env.F42_GUARD && expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}
`
    expect(metaPinHelperUsesModuleGuard(shortCircuitDynMutant, "short-circuit-dyn-mutant.ts")).toBe(false)

    const logicalOrDynMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  process.env.F42_GUARD || expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}
`
    expect(metaPinHelperUsesModuleGuard(logicalOrDynMutant, "logical-or-dyn-mutant.ts")).toBe(false)

    const ternaryDynMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  process.env.F42_GUARD ? expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD) : null
}
`
    expect(metaPinHelperUsesModuleGuard(ternaryDynMutant, "ternary-dyn-mutant.ts")).toBe(false)

    const arrowWrapMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  ;(() => expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD))()
}
`
    expect(metaPinHelperUsesModuleGuard(arrowWrapMutant, "arrow-wrap-mutant.ts")).toBe(false)

    const deferredCallMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  queueMicrotask(() => expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD))
}
`
    expect(metaPinHelperUsesModuleGuard(deferredCallMutant, "deferred-call-mutant.ts")).toBe(false)
    expect(metaPinHelperUsesModuleGuard(readFileSync(UNIT_SELF, "utf8"))).toBe(true)
  })

  it("FA-F42-R1-015-001-001: Mmove (cleanup only in it.skip) fails the afterAll hook guard", () => {
    const mmoveSrc = `
import { afterAll, it } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
afterAll(async () => {}, 120_000)
it.skip("moved cleanup", () => { deleteFirmScopedData(firms, uids) })
`
    expect(deleteFirmScopedDataInAfterAllAsyncHook(mmoveSrc)).toBe(false)
    expect(mmoveSrc).not.toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  })

  it("FA-F42-R1-015-001-001: MmoveT (empty afterAll; cleanup in it.skip with 120_000 timeout) fails the guard", () => {
    const mmoveTSrc = `
import { afterAll, it } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
afterAll(async () => {}, 120_000)
it.skip("moved cleanup", async () => { await deleteFirmScopedData(firms, uids) }, 120_000)
`
    expect(deleteFirmScopedDataInAfterAllAsyncHook(mmoveTSrc)).toBe(false)
    expect(mmoveTSrc).not.toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  })

  it("FA-F42-R1-015-001-001-001-001: MmoveNoTO (empty afterAll without timeout; cleanup in it.skip) fails the guard", () => {
    const mmoveNoTOSrc = `
import { afterAll, it } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
afterAll(async () => {})
it.skip("moved cleanup", async () => { await deleteFirmScopedData(firms, uids) }, 120_000)
`
    expect(deleteFirmScopedDataInAfterAllAsyncHook(mmoveNoTOSrc)).toBe(false)
  })

  it("FA-F42-R1-015-001-001-001-001: MmoveOtherTO (empty afterAll with 60_000; cleanup in it.skip with 120_000) fails the guard", () => {
    const mmoveOtherTOSrc = `
import { afterAll, it } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
afterAll(async () => {}, 60_000)
it.skip("moved cleanup", async () => { await deleteFirmScopedData(firms, uids) }, 120_000)
`
    expect(deleteFirmScopedDataInAfterAllAsyncHook(mmoveOtherTOSrc)).toBe(false)
    expect(mmoveOtherTOSrc).not.toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  })

  it("FA-F42-R1-015-001-001-001-001-001: MdescribeSkip (cleanup only in afterAll under describe.skip) fails the AST guard", () => {
    const mdescribeSkipSrc = `
import { afterAll, describe } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
describe.skip("skipped suite", () => {
  afterAll(async () => { await deleteFirmScopedData(firms, uids) }, 120_000)
})
`
    expect(deleteFirmScopedDataInAfterAllAsyncHook(mdescribeSkipSrc)).toBe(false)
  })

  it("AFTER_ALL_ASYNC_HOOK_CLOSE matches any numeric afterAll timeout suffix (not only 120_000)", () => {
    expect("}, 120_000)").toMatch(AFTER_ALL_ASYNC_HOOK_CLOSE)
    expect("}, 60_000)").toMatch(AFTER_ALL_ASYNC_HOOK_CLOSE)
  })
})
