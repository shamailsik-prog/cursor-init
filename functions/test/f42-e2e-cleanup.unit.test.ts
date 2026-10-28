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

function isNestedFunctionBoundary(node: ts.Node): boolean {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node)
}

/**
 * FA-F42-R1-015-001-001-002-002-002-003 / 003-001: any `return`/`throw` in helper-body statements
 * before the live `toMatch` (including block, label, try/finally, switch, if/else, do-while shapes)
 * must fail the pin; nested function/arrow bodies are ignored.
 */
function subtreeContainsReturnOrThrow(node: ts.Node): boolean {
  let found = false
  const walk = (n: ts.Node) => {
    if (found) return
    if (isNestedFunctionBoundary(n)) return
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
      found = true
      return
    }
    ts.forEachChild(n, walk)
  }
  walk(node)
  return found
}

function helperBodyHasReturnOrThrowBeforeStatement(body: ts.Block, target: ts.Statement): boolean {
  const idx = body.statements.indexOf(target)
  if (idx <= 0) return false
  for (let i = 0; i < idx; i++) {
    if (subtreeContainsReturnOrThrow(body.statements[i]!)) return true
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
  if (helperBodyHasReturnOrThrowBeforeStatement(helperBody, stmt)) return false

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

function callArg0IsSrcIdentifier(call: ts.CallExpression): boolean {
  const arg0 = call.arguments[0]
  return arg0 !== undefined && ts.isIdentifier(arg0) && arg0.text === "src"
}

function elementAccessStaticKeyText(key: ts.Expression | undefined): string | undefined {
  if (!key) return undefined
  if (ts.isStringLiteral(key)) return key.text
  if (ts.isNoSubstitutionTemplateLiteral(key)) return key.text
  return undefined
}

function expressionIsRegexTestOrExecCallee(expr: ts.Expression | undefined): boolean {
  if (!expr) return false
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text === "test" || expr.name.text === "exec"
  }
  if (ts.isElementAccessExpression(expr)) {
    const key = elementAccessStaticKeyText(expr.argumentExpression)
    return key === "test" || key === "exec"
  }
  return false
}

function isRegExpPrototypeMethodAccess(node: ts.PropertyAccessExpression): boolean {
  if (node.name.text !== "test" && node.name.text !== "exec") return false
  const proto = node.expression
  if (!ts.isPropertyAccessExpression(proto) || proto.name.text !== "prototype") return false
  return ts.isIdentifier(proto.expression) && proto.expression.text === "RegExp"
}

function arrayLiteralFirstArgIsSrc(node: ts.Expression | undefined): boolean {
  if (!node) return false
  if (ts.isIdentifier(node) && node.text === "src") return true
  if (ts.isArrayLiteralExpression(node)) {
    const first = node.elements[0]
    return first !== undefined && ts.isIdentifier(first) && first.text === "src"
  }
  return false
}

/** FA-F42-R1-015-001-001-002-002-003: any `<expr>.test(src)` guard bypass, not only fixed receivers. */
function callExpressionIsRegexTestOnSrc(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false
  if (call.expression.name.text !== "test") return false
  return callArg0IsSrcIdentifier(call)
}

/** FA-F42-R1-015-001-001-002-002-003-001: `LOOSE["test"](src)` / `` LOOSE[`test`](src) `` computed-property test bypass. */
function callExpressionIsComputedRegexTestOnSrc(call: ts.CallExpression): boolean {
  if (!ts.isElementAccessExpression(call.expression)) return false
  if (elementAccessStaticKeyText(call.expression.argumentExpression) !== "test") return false
  return callArg0IsSrcIdentifier(call)
}

/** FA-F42-R1-015-001-001-002-002-003-001-001: `LOOSE["exec"](src)` computed-property exec bypass. */
function callExpressionIsComputedRegexExecOnSrc(call: ts.CallExpression): boolean {
  if (!ts.isElementAccessExpression(call.expression)) return false
  if (elementAccessStaticKeyText(call.expression.argumentExpression) !== "exec") return false
  return callArg0IsSrcIdentifier(call)
}

/** FA-F42-R1-015-001-001-002-002-003-001: `RegExp.prototype.(test|exec).call(LOOSE, src)` / `.apply(LOOSE, [src])` and instance `LOOSE.test.call` / `LOOSE.exec.apply`. */
function callExpressionIsRegexMethodCallOrApplyOnSrc(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false
  const method = call.expression.name.text
  if (method !== "call" && method !== "apply") return false
  const inner = call.expression.expression
  if (!ts.isPropertyAccessExpression(inner)) return false
  if (inner.name.text !== "test" && inner.name.text !== "exec") return false

  if (method === "call") {
    const arg1 = call.arguments[1]
    return arg1 !== undefined && ts.isIdentifier(arg1) && arg1.text === "src"
  }

  return arrayLiteralFirstArgIsSrc(call.arguments[1])
}

/** Element-access `RegExp.prototype["test"].call(LOOSE, src)` (static key). */
function callExpressionIsRegexPrototypeBracketCallOrApplyOnSrc(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false
  const method = call.expression.name.text
  if (method !== "call" && method !== "apply") return false
  const bracket = call.expression.expression
  if (!ts.isElementAccessExpression(bracket)) return false
  const proto = bracket.expression
  if (!ts.isPropertyAccessExpression(proto) || proto.name.text !== "prototype") return false
  if (!ts.isIdentifier(proto.expression) || proto.expression.text !== "RegExp") return false
  const key = elementAccessStaticKeyText(bracket.argumentExpression)
  if (key !== "test" && key !== "exec") return false

  if (method === "call") {
    const arg1 = call.arguments[1]
    return arg1 !== undefined && ts.isIdentifier(arg1) && arg1.text === "src"
  }
  return arrayLiteralFirstArgIsSrc(call.arguments[1])
}

/** FA-F42-R1-015-001-001-002-002-003-001-001: `Reflect.apply(LOOSE.test, LOOSE, [src])` (test or exec callee). */
function callExpressionIsReflectApplyRegexOnSrc(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false
  if (!ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== "Reflect") return false
  if (call.expression.name.text !== "apply") return false
  if (!expressionIsRegexTestOrExecCallee(call.arguments[0])) return false
  return arrayLiteralFirstArgIsSrc(call.arguments[2])
}

/** FA-F42-R1-015-001-001-002-002-003-001: `<expr>.exec(src)` instead of `.test(src)`. */
function callExpressionIsRegexExecOnSrc(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false
  if (call.expression.name.text !== "exec") return false
  return callArg0IsSrcIdentifier(call)
}

function expressionIsRegexTestBindCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "bind") {
    return false
  }
  const receiver = node.expression.expression
  if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "test") return true
  if (ts.isElementAccessExpression(receiver)) {
    if (elementAccessStaticKeyText(receiver.argumentExpression) === "test") return true
  }
  return false
}

function expressionIsUnboundRegExpPrototypeMethodCall(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false
  if (node.name.text !== "call") return false
  const inner = node.expression
  return ts.isPropertyAccessExpression(inner) && isRegExpPrototypeMethodAccess(inner)
}

function expressionIsRegExpPrototypeTestOrExecRef(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && isRegExpPrototypeMethodAccess(node)) return true
  if (ts.isElementAccessExpression(node)) {
    const proto = node.expression
    if (!ts.isPropertyAccessExpression(proto) || proto.name.text !== "prototype") return false
    if (!ts.isIdentifier(proto.expression) || proto.expression.text !== "RegExp") return false
    const key = elementAccessStaticKeyText(node.argumentExpression)
    return key === "test" || key === "exec"
  }
  return false
}

function expressionIsReflectApplyRef(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Reflect" &&
    node.name.text === "apply"
  )
}

function expressionIsFunctionPrototypeCall(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false
  if (node.name.text !== "call") return false
  const inner = node.expression
  return (
    ts.isPropertyAccessExpression(inner) &&
    inner.name.text === "prototype" &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "Function"
  )
}

function expressionIsFunctionPrototypeApply(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false
  if (node.name.text !== "apply") return false
  const inner = node.expression
  return (
    ts.isPropertyAccessExpression(inner) &&
    inner.name.text === "prototype" &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "Function"
  )
}

function collectBoundRegexTestLocalNames(body: ts.Block, out: Set<string>): void {
  const walk = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (expressionIsRegexTestBindCall(n.initializer)) {
        out.add(n.name.text)
      }
    }
    ts.forEachChild(n, walk)
  }
  for (const stmt of body.statements) walk(stmt)
}

function collectUnboundRegexCallLocalNames(body: ts.Block, callOut: Set<string>, applyOut: Set<string>): void {
  const walk = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer
      if (
        expressionIsUnboundRegExpPrototypeMethodCall(init) ||
        expressionIsFunctionPrototypeCall(init) ||
        expressionIsRegExpPrototypeTestOrExecRef(init)
      ) {
        callOut.add(n.name.text)
      }
      if (expressionIsFunctionPrototypeApply(init) || expressionIsReflectApplyRef(init)) {
        applyOut.add(n.name.text)
      }
    }
    ts.forEachChild(n, walk)
  }
  for (const stmt of body.statements) walk(stmt)
}

function callExpressionIsBoundRegexTestOnSrc(call: ts.CallExpression, boundNames: Set<string>): boolean {
  if (!ts.isIdentifier(call.expression)) return false
  if (!boundNames.has(call.expression.text)) return false
  return callArg0IsSrcIdentifier(call)
}

/**
 * FA-F42-R1-015-001-001-002-002-003-001-001: unbound `.call` / `.apply` aliases that still match `src`.
 * e.g. `const callTest = RegExp.prototype.test.call; callTest(LOOSE, src)` or
 * `Function.prototype.call(LOOSE.test, LOOSE, src)`.
 */
function callExpressionIsUnboundAliasRegexOnSrc(
  call: ts.CallExpression,
  unboundCallNames: Set<string>,
): boolean {
  if (ts.isIdentifier(call.expression) && unboundCallNames.has(call.expression.text)) {
    if (call.arguments.length >= 2) {
      const arg1 = call.arguments[1]
      if (arg1 !== undefined && ts.isIdentifier(arg1) && arg1.text === "src") return true
    }
    if (call.arguments.length >= 3) {
      if (!expressionIsRegexTestOrExecCallee(call.arguments[0])) return false
      const arg2 = call.arguments[2]
      return arg2 !== undefined && ts.isIdentifier(arg2) && arg2.text === "src"
    }
  }

  if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "call") {
    const recv = call.expression.expression
    if (ts.isIdentifier(recv) && unboundCallNames.has(recv.text)) {
      const arg1 = call.arguments[1]
      if (arg1 !== undefined && ts.isIdentifier(arg1) && arg1.text === "src") return true
    }
  }

  return false
}

function callExpressionIsUnboundApplyAliasRegexOnSrc(
  call: ts.CallExpression,
  unboundApplyNames: Set<string>,
): boolean {
  if (ts.isIdentifier(call.expression) && unboundApplyNames.has(call.expression.text)) {
    if (call.arguments.length < 3) return false
    if (!expressionIsRegexTestOrExecCallee(call.arguments[0])) return false
    return arrayLiteralFirstArgIsSrc(call.arguments[2])
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "apply" &&
    ts.isIdentifier(call.expression.expression) &&
    unboundApplyNames.has(call.expression.expression.text)
  ) {
    if (call.arguments.length < 3) return false
    if (!expressionIsRegexTestOrExecCallee(call.arguments[0])) return false
    return arrayLiteralFirstArgIsSrc(call.arguments[2])
  }
  return false
}

/**
 * FA-F42-R1-015-001-001-002-002-003-001: structural regex-on-`src` bypasses beyond receiver-agnostic `.test(src)`.
 */
function callExpressionIsForbiddenRegexMatchOnSrc(
  call: ts.CallExpression,
  boundTestNames: Set<string>,
  unboundCallNames: Set<string>,
  unboundApplyNames: Set<string>,
): boolean {
  if (callExpressionIsRegexTestOnSrc(call)) return true
  if (callExpressionIsComputedRegexTestOnSrc(call)) return true
  if (callExpressionIsComputedRegexExecOnSrc(call)) return true
  if (callExpressionIsRegexMethodCallOrApplyOnSrc(call)) return true
  if (callExpressionIsRegexPrototypeBracketCallOrApplyOnSrc(call)) return true
  if (callExpressionIsReflectApplyRegexOnSrc(call)) return true
  if (callExpressionIsRegexExecOnSrc(call)) return true
  if (callExpressionIsBoundRegexTestOnSrc(call, boundTestNames)) return true
  if (callExpressionIsUnboundAliasRegexOnSrc(call, unboundCallNames)) return true
  if (callExpressionIsUnboundApplyAliasRegexOnSrc(call, unboundApplyNames)) return true
  return false
}

function helperHasCommentOrToSatisfyGuardBypass(body: ts.Block): boolean {
  const boundTestNames = new Set<string>()
  const unboundCallNames = new Set<string>()
  const unboundApplyNames = new Set<string>()
  collectBoundRegexTestLocalNames(body, boundTestNames)
  collectUnboundRegexCallLocalNames(body, unboundCallNames, unboundApplyNames)

  let forbidden = false
  const walk = (n: ts.Node) => {
    if (expressionIsRegexTestBindCall(n)) {
      forbidden = true
    }
    if (ts.isCallExpression(n)) {
      if (
        callExpressionIsForbiddenRegexMatchOnSrc(
          n,
          boundTestNames,
          unboundCallNames,
          unboundApplyNames,
        )
      ) {
        forbidden = true
      }
      if (
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "toSatisfy" &&
        ts.isCallExpression(n.expression.expression) &&
        isExpectSrcCall(n.expression.expression)
      ) {
        forbidden = true
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
 * FA-F42-R1-015-001-001-002-002-003-001-001: production helper may reference `src` only in the shared
 * hook check, the live module-guard `toMatch`, and the M4 empty-array `not.toMatch` (same as real helper body).
 */
function isExpectSrcNotToMatchCall(expectCall: ts.CallExpression): boolean {
  if (!isExpectSrcCall(expectCall)) return false
  const notAccess = expectCall.parent
  if (!ts.isPropertyAccessExpression(notAccess) || notAccess.name.text !== "not") return false
  const toMatchAccess = notAccess.parent
  if (!ts.isPropertyAccessExpression(toMatchAccess) || toMatchAccess.name.text !== "toMatch") return false
  const outer = toMatchAccess.parent
  return ts.isCallExpression(outer) && outer.expression === toMatchAccess
}

function srcIsExpectSrcToMatchGuardUse(id: ts.Identifier, liveToMatchCall: ts.CallExpression): boolean {
  const parent = id.parent
  if (!parent || !ts.isCallExpression(parent) || !isExpectSrcCall(parent)) return false
  const toMatchAccess = parent.parent
  if (!ts.isPropertyAccessExpression(toMatchAccess) || toMatchAccess.name.text !== "toMatch") return false
  const outer = toMatchAccess.parent
  return ts.isCallExpression(outer) && outer === liveToMatchCall
}

function srcIdentifierUseIsAllowed(id: ts.Identifier, liveToMatchCall: ts.CallExpression): boolean {
  const parent = id.parent
  if (!parent) return false
  if (ts.isCallExpression(parent)) {
    if (ts.isIdentifier(parent.expression) && parent.expression.text === "deleteFirmScopedDataInAfterAllAsyncHook") {
      return parent.arguments[0] === id
    }
    if (srcIsExpectSrcToMatchGuardUse(id, liveToMatchCall)) return true
    if (isExpectSrcNotToMatchCall(parent)) return true
  }
  return false
}

function helperBodyUsesSrcOnlyOnAllowedSites(body: ts.Block, liveToMatchCall: ts.CallExpression): boolean {
  let ok = true
  const walk = (n: ts.Node) => {
    if (!ok) return
    if (isNestedFunctionBoundary(n)) return
    if (ts.isIdentifier(n) && n.text === "src" && !srcIdentifierUseIsAllowed(n, liveToMatchCall)) {
      ok = false
      return
    }
    ts.forEachChild(n, walk)
  }
  for (const stmt of body.statements) walk(stmt)
  return ok
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

  if (!helperBodyUsesSrcOnlyOnAllowedSites(helper.body, toMatchCall)) return false

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

  it("FA-F42-R1-015-001-001-002-002-002-003: MreturnBefore / MthrowBefore (early exit before toMatch evades statement-order pin)", () => {
    const returnBeforeMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  return
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}
`
    expect(metaPinHelperUsesModuleGuard(returnBeforeMutant, "return-before-mutant.ts")).toBe(false)

    const throwBeforeMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  throw new Error("skip guard")
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}
`
    expect(metaPinHelperUsesModuleGuard(throwBeforeMutant, "throw-before-mutant.ts")).toBe(false)

    const staticIfReturnBeforeMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  if (true) return
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}
`
    expect(metaPinHelperUsesModuleGuard(staticIfReturnBeforeMutant, "static-if-return-mutant.ts")).toBe(false)
    expect(metaPinHelperUsesModuleGuard(readFileSync(UNIT_SELF, "utf8"))).toBe(true)
  })

  it("FA-F42-R1-015-001-001-002-002-003: MlooseConst (local regex + LOOSE.test(src) evades receiver-specific .test meta pin)", () => {
    const looseConstMutant = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  const LOOSE = /afterAll[\\s\\S]*?deleteFirmScopedData\\s*\\(\\s*firms\\s*,\\s*uids\\s*\\)/
  expect(LOOSE.test(src)).toBe(true)
}
`
    expect(metaPinHelperUsesModuleGuard(looseConstMutant, "loose-const-mutant.ts")).toBe(false)
    expect(metaPinHelperUsesModuleGuard(readFileSync(UNIT_SELF, "utf8"))).toBe(true)
  })

  it("FA-F42-R1-015-001-001-002-002-003-001: alternate regex-on-src call shapes (computed test, call/apply, bind alias, exec)", () => {
    const header = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  const LOOSE = /afterAll[\\s\\S]*?deleteFirmScopedData\\s*\\(\\s*firms\\s*,\\s*uids\\s*\\)/
`
    const footer = `
}
`
    const mutants: { name: string; body: string }[] = [
      {
        name: "computed-test",
        body: `${header}  expect(LOOSE["test"](src)).toBe(true)\n${footer}`,
      },
      {
        name: "prototype-call",
        body: `${header}  expect(RegExp.prototype.test.call(LOOSE, src)).toBe(true)\n${footer}`,
      },
      {
        name: "prototype-apply",
        body: `${header}  expect(RegExp.prototype.test.apply(LOOSE, [src])).toBe(true)\n${footer}`,
      },
      {
        name: "bind-alias",
        body: `${header}  const boundTest = LOOSE.test.bind(LOOSE)\n  expect(boundTest(src)).toBe(true)\n${footer}`,
      },
      {
        name: "exec-instead-of-test",
        body: `${header}  expect(LOOSE.exec(src)).toBeTruthy()\n${footer}`,
      },
    ]
    for (const { name, body } of mutants) {
      expect(metaPinHelperUsesModuleGuard(body, `${name}-mutant.ts`)).toBe(false)
    }
    expect(metaPinHelperUsesModuleGuard(readFileSync(UNIT_SELF, "utf8"))).toBe(true)
  })

  it("FA-F42-R1-015-001-001-002-002-003-001-001: residual alternate regex-on-src shapes after #201 (template key, computed exec, prototype exec, Reflect.apply, unbound call aliases)", () => {
    const header = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  const LOOSE = /afterAll[\\s\\S]*?deleteFirmScopedData\\s*\\(\\s*firms\\s*,\\s*uids\\s*\\)/
`
    const footer = `
}
`
    const mutants: { name: string; body: string }[] = [
      {
        name: "template-literal-test",
        body: `${header}  expect(LOOSE[\`test\`](src)).toBe(true)\n${footer}`,
      },
      {
        name: "computed-exec",
        body: `${header}  expect(LOOSE["exec"](src)).toBeTruthy()\n${footer}`,
      },
      {
        name: "prototype-exec-call",
        body: `${header}  expect(RegExp.prototype.exec.call(LOOSE, src)).toBeTruthy()\n${footer}`,
      },
      {
        name: "prototype-exec-apply",
        body: `${header}  expect(RegExp.prototype.exec.apply(LOOSE, [src])).toBeTruthy()\n${footer}`,
      },
      {
        name: "reflect-apply-test",
        body: `${header}  expect(Reflect.apply(LOOSE.test, LOOSE, [src])).toBe(true)\n${footer}`,
      },
      {
        name: "reflect-apply-computed-test",
        body: `${header}  expect(Reflect.apply(LOOSE["test"], LOOSE, [src])).toBe(true)\n${footer}`,
      },
      {
        name: "unbound-regexp-test-call",
        body: `${header}  const callTest = RegExp.prototype.test.call\n  expect(callTest(LOOSE, src)).toBe(true)\n${footer}`,
      },
      {
        name: "unbound-fn-prototype-call",
        body: `${header}  const unboundCall = Function.prototype.call\n  expect(unboundCall(LOOSE.test, LOOSE, src)).toBe(true)\n${footer}`,
      },
      {
        name: "unbound-fn-prototype-apply",
        body: `${header}  const unboundApply = Function.prototype.apply\n  expect(unboundApply(LOOSE.test, LOOSE, [src])).toBe(true)\n${footer}`,
      },
      {
        name: "unbound-method-then-call",
        body: `${header}  const tf = RegExp.prototype.test\n  expect(tf.call(LOOSE, src)).toBe(true)\n${footer}`,
      },
      {
        name: "instance-test-call",
        body: `${header}  expect(LOOSE.test.call(LOOSE, src)).toBe(true)\n${footer}`,
      },
      {
        name: "instance-exec-apply",
        body: `${header}  expect(LOOSE.exec.apply(LOOSE, [src])).toBeTruthy()\n${footer}`,
      },
      {
        name: "prototype-bracket-test-call",
        body: `${header}  expect(RegExp.prototype["test"].call(LOOSE, src)).toBe(true)\n${footer}`,
      },
      {
        name: "reflect-apply-local-alias",
        body: `${header}  const reflectApply = Reflect.apply\n  expect(reflectApply(LOOSE.test, LOOSE, [src])).toBe(true)\n${footer}`,
      },
      {
        name: "destructure-test-then-call",
        body: `${header}  const { test } = RegExp.prototype\n  expect(test.call(LOOSE, src)).toBe(true)\n${footer}`,
      },
    ]
    for (const { name, body } of mutants) {
      expect(metaPinHelperUsesModuleGuard(body, `${name}-mutant.ts`)).toBe(false)
    }
    expect(metaPinHelperUsesModuleGuard(readFileSync(UNIT_SELF, "utf8"))).toBe(true)
  })

  it("FA-F42-R1-015-001-001-002-002-002-003-001: structural early exits before toMatch (block, label, try/finally, switch, if/else, do-while)", () => {
    const header = `
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = /tempered/
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
`
    const footer = `
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}
`
    const structuralMutants: { name: string; middle: string }[] = [
      { name: "block-return", middle: "  { return }\n" },
      { name: "labeled-return", middle: "  exit: return\n" },
      { name: "try-finally-return", middle: "  try { return } finally {}\n" },
      { name: "switch-default-return", middle: "  switch (0) { default: return }\n" },
      { name: "if-else-both-return", middle: "  if (Math.random()) return; else return\n" },
      { name: "do-while-false-return", middle: "  do { return } while (false)\n" },
    ]
    for (const { name, middle } of structuralMutants) {
      const src = header + middle + footer
      expect(metaPinHelperUsesModuleGuard(src, `${name}-mutant.ts`)).toBe(false)
    }
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
