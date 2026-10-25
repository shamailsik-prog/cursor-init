/**
 * FA-F34-R4-001 / FA-F34-R5-001 (Design A, sealed contracts): per granted file, only allowlisted exports may exist.
 * Fail closed on transport-capable flows through exports (casts/any do not sanitize), sealed-export mutation, and side channels.
 */
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const GRANTED_FILES = new Set([
  "functions/src/p1/gateway.ts",
  "functions/src/p1/evalSet.ts",
  "functions/src/p1/embedding.ts",
  "functions/src/cli/committeeEval.ts",
])

const TRANSPORT_MODULES = new Set(["functions/src/p1/transport", "functions/src/p1/embeddingTransport"])

const RESTRICTED_VALUE_IMPORTS = new Set([
  "activeTransport",
  "gatewayTransport",
  "setP1TransportForTests",
  "activeEmbeddingTransport",
  "gatewayEmbeddingTransport",
  "setP1EmbeddingTransportForTests",
])

const TRANSPORT_TYPE_NAMES = new Set(["P1Transport", "P1EmbeddingTransport"])

const VIOLATION = "granted export violation"

type Allowlist = Record<string, readonly string[]>

function loadAllowlist(root: string): Allowlist {
  const p = path.join(root, "ci_gates", "granted_p1_transport_export_allowlist.json")
  return JSON.parse(fs.readFileSync(p, "utf8")) as Allowlist
}

function toRepoRel(abs: string, root: string): string {
  return path.relative(root, abs).split(path.sep).join("/")
}

function createFunctionsProgram(programRoot: string, scanRoot: string): ts.Program {
  const configPath = path.join(programRoot, "functions", "tsconfig.json")
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) throw new Error(`tsconfig read failed: ${configPath}`)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath))
  const host = ts.createCompilerHost(parsed.options)
  const read = host.readFile.bind(host)
  host.readFile = (fileName) => {
    const rel = toRepoRel(fileName, programRoot)
    if (GRANTED_FILES.has(rel)) {
      const overlay = path.join(scanRoot, rel)
      if (fs.existsSync(overlay)) return fs.readFileSync(overlay, "utf8")
    }
    return read(fileName)
  }
  return ts.createProgram(parsed.fileNames, parsed.options, host)
}

function normalizeModule(spec: string, importerRel: string): string | null {
  const raw = spec.trim().split("?")[0].split("#")[0].trim()
  if (!raw || raw.includes(":")) return null
  let modulePath: string
  if (raw.startsWith("@/")) modulePath = raw.slice(2)
  else if (raw.startsWith("./") || raw.startsWith("../")) {
    modulePath = path.posix.normalize(path.posix.join(path.posix.dirname(importerRel), raw))
  } else if (raw.startsWith("/")) return null
  else modulePath = raw
  modulePath = modulePath.replace(/\.(?:[cm]?[jt]sx?)$/i, "").replace(/\/index$/, "")
  return path.posix.normalize(modulePath)
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let e = expr
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) {
      e = e.expression
      continue
    }
    if (ts.isNonNullExpression(e)) {
      e = e.expression
      continue
    }
    if (ts.isSatisfiesExpression(e)) {
      e = e.expression
      continue
    }
    break
  }
  return e
}

function seedTaintFromImports(sf: ts.SourceFile, rel: string, tainted: Set<string>): void {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
    const spec = stmt.moduleSpecifier
    if (!ts.isStringLiteral(spec)) continue
    const mod = normalizeModule(spec.text, rel)
    if (!mod || !TRANSPORT_MODULES.has(mod)) continue
    const clause = stmt.importClause
    if (clause.name) tainted.add(clause.name.text)
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text
        if (RESTRICTED_VALUE_IMPORTS.has(imported)) tainted.add(el.name.text)
      }
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      tainted.add(clause.namedBindings.name.text)
    }
  }
}

function isOpaqueType(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
}

function isTransportLikeType(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false
  seen.add(type)

  const symbol = type.aliasSymbol ?? type.getSymbol()
  const name = symbol?.getName()
  if (name && TRANSPORT_TYPE_NAMES.has(name)) return true

  if (type.flags & ts.TypeFlags.TypeParameter) return false

  if (type.isUnionOrIntersection()) {
    return type.types.some((t) => isTransportLikeType(checker, t, seen))
  }

  const ref0 = type as ts.TypeReference
  if (ref0.target?.getSymbol()?.getName() === "Promise" && ref0.typeArguments?.[0]) {
    if (isTransportLikeType(checker, ref0.typeArguments[0], seen)) return true
  }

  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const ref = type as ts.TypeReference
    const elem = ref.typeArguments?.[0]
    if (elem && isTransportLikeType(checker, elem, seen)) return true
  }

  const ref = type as ts.TypeReference
  const typeArgs = ref.typeArguments ?? []
  if (typeArgs.length > 0 && ref.target) {
    const refName = ref.target.getSymbol()?.getName()
    if (refName === "Map" || refName === "ReadonlyMap" || refName === "WeakMap") {
      const valueArg = typeArgs[1]
      if (valueArg && isTransportLikeType(checker, valueArg, seen)) return true
    }
    if (refName === "Set" || refName === "ReadonlySet") {
      const v = typeArgs[0]
      if (v && isTransportLikeType(checker, v, seen)) return true
    }
    if (refName === "Record" && typeArgs[1] && isTransportLikeType(checker, typeArgs[1], seen)) return true
  }

  if (type.flags & ts.TypeFlags.Object) {
    const callSigs = checker.getSignaturesOfType(type, ts.SignatureKind.Call)
    for (const sig of callSigs) {
      const ret = sig.getReturnType()
      if (ret && isTransportLikeType(checker, ret, seen)) return true
    }
  }

  return false
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  )
}

function functionCapturesTainted(node: ts.FunctionLikeDeclaration, tainted: Set<string>): boolean {
  let found = false
  const visit = (n: ts.Node) => {
    if (found) return
    if (ts.isIdentifier(n) && (tainted.has(n.text) || RESTRICTED_VALUE_IMPORTS.has(n.text))) {
      found = true
      return
    }
    if (isFunctionLike(n)) return
    ts.forEachChild(n, visit)
  }
  if (node.body) ts.forEachChild(node.body, visit)
  return found
}

function subtreeHasRestrictedFlow(node: ts.Node, tainted: Set<string>): boolean {
  let found = false
  const visit = (n: ts.Node) => {
    if (found) return
    if (ts.isIdentifier(n) && (tainted.has(n.text) || RESTRICTED_VALUE_IMPORTS.has(n.text))) {
      found = true
      return
    }
    if (ts.isCallExpression(n)) {
      const inner = unwrapExpression(n.expression)
      if (ts.isIdentifier(inner) && RESTRICTED_VALUE_IMPORTS.has(inner.text)) {
        found = true
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

function expressionUsesRestrictedCallee(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr) && RESTRICTED_VALUE_IMPORTS.has(expr.text)) return true
  if (ts.isCallExpression(expr)) {
    const inner = unwrapExpression(expr.expression)
    if (ts.isIdentifier(inner) && RESTRICTED_VALUE_IMPORTS.has(inner.text)) return true
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.some(
      (p) => ts.isPropertyAssignment(p) && expressionUsesRestrictedCallee(p.initializer),
    )
  }
  return false
}

/** Export boundary: typed transport, restricted callee, closure capture, or opaque/cast hiding restricted flow. */
function exportLeaksTransport(checker: ts.TypeChecker, expr: ts.Expression, tainted: Set<string>): boolean {
  const u = unwrapExpression(expr)
  if (isFunctionLike(u) && functionCapturesTainted(u, tainted)) return true
  const t = checker.getTypeAtLocation(u)
  if (isTransportLikeType(checker, t)) return true
  if (expressionUsesRestrictedCallee(u)) return true
  if (
    (isOpaqueType(t) || ts.isAsExpression(u) || ts.isTypeAssertionExpression(u) || ts.isSatisfiesExpression(u)) &&
    subtreeHasRestrictedFlow(u, tainted)
  ) {
    return true
  }
  return false
}

function expressionCapableOfTransport(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  tainted: Set<string>,
): boolean {
  const u = unwrapExpression(expr)
  if (isFunctionLike(u) && functionCapturesTainted(u, tainted)) return true
  if (subtreeHasRestrictedFlow(expr, tainted)) return true
  const t = checker.getTypeAtLocation(expr)
  if (isTransportLikeType(checker, t)) return true
  if (isOpaqueType(t) && subtreeHasRestrictedFlow(expr, tainted)) return true
  return false
}

/** Environment writes: do not treat nested function bodies as leaking transport (e.g. transportFor callbacks). */
function expressionLeaksTransportForEnvWrite(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  tainted: Set<string>,
): boolean {
  const e = unwrapExpression(expr)
  if (ts.isIdentifier(e) && (tainted.has(e.text) || RESTRICTED_VALUE_IMPORTS.has(e.text))) return true
  if (ts.isCallExpression(e)) {
    const inner = unwrapExpression(e.expression)
    if (ts.isIdentifier(inner) && RESTRICTED_VALUE_IMPORTS.has(inner.text)) return true
    const t = checker.getTypeAtLocation(e)
    if (isTransportLikeType(checker, t)) return true
    return false
  }
  const t = checker.getTypeAtLocation(e)
  if (isTransportLikeType(checker, t)) return true
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    return functionCapturesTainted(e, tainted)
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.some((p) => {
      if (ts.isPropertyAssignment(p)) {
        const init = p.initializer
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          return functionCapturesTainted(init, tainted)
        }
        return expressionLeaksTransportForEnvWrite(checker, init, tainted)
      }
      if (ts.isShorthandPropertyAssignment(p)) {
        return tainted.has(p.name.text) || RESTRICTED_VALUE_IMPORTS.has(p.name.text)
      }
      return false
    })
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.some(
      (el) => el && !ts.isOmittedExpression(el) && expressionLeaksTransportForEnvWrite(checker, el, tainted),
    )
  }
  if (isOpaqueType(t) && subtreeHasRestrictedFlow(e, tainted)) {
    return !ts.isObjectLiteralExpression(e) && !ts.isArrayLiteralExpression(e)
  }
  return false
}

function isTypeOnlyExportSymbol(symbol: ts.Symbol): boolean {
  const decls = symbol.getDeclarations() ?? []
  return decls.length > 0 && decls.every((d) => ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d))
}

function isTypeAliasToTransport(checker: ts.TypeChecker, node: ts.TypeAliasDeclaration): boolean {
  const type = checker.getTypeAtLocation(node.type)
  return isTransportLikeType(checker, type)
}

function isSealedTarget(expr: ts.Expression, sealed: Set<string>): boolean {
  const e = unwrapExpression(expr)
  if (ts.isIdentifier(e) && sealed.has(e.text)) return true
  if (ts.isPropertyAccessExpression(e)) {
    const base = unwrapExpression(e.expression)
    if (ts.isIdentifier(base) && sealed.has(base.text)) return true
  }
  if (ts.isElementAccessExpression(e)) {
    const base = unwrapExpression(e.expression)
    if (ts.isIdentifier(base) && sealed.has(base.text)) return true
  }
  return false
}

function objectLiteralEscapesTransport(
  checker: ts.TypeChecker,
  obj: ts.ObjectLiteralExpression,
  tainted: Set<string>,
): boolean {
  return obj.properties.some((p) => {
    if (ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) {
      return functionCapturesTainted(p, tainted)
    }
    if (ts.isPropertyAssignment(p)) {
      const init = unwrapExpression(p.initializer)
      if (isFunctionLike(init) && functionCapturesTainted(init, tainted)) return true
      return expressionCapableOfTransport(checker, p.initializer, tainted)
    }
    return false
  })
}

function rhsEscapesViaSealedHolder(
  checker: ts.TypeChecker,
  right: ts.Expression,
  tainted: Set<string>,
): boolean {
  const u = unwrapExpression(right)
  if (ts.isObjectLiteralExpression(u) && objectLiteralEscapesTransport(checker, u, tainted)) return true
  if (isFunctionLike(u) && functionCapturesTainted(u, tainted)) return true
  return exportLeaksTransport(checker, right, tainted) || expressionCapableOfTransport(checker, right, tainted)
}

function isEnvAssignmentTarget(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) {
    return expr.text === "exports" || expr.text === "globalThis" || expr.text === "global" || expr.text === "process"
  }
  if (ts.isPropertyAccessExpression(expr)) {
    if (ts.isIdentifier(expr.expression) && expr.expression.text === "module" && expr.name.text === "exports") {
      return true
    }
    if (ts.isIdentifier(expr.expression)) {
      const base = expr.expression.text
      if (base === "exports" || base === "globalThis" || base === "global" || base === "process") return true
      if (base === "Object" && expr.name.text === "prototype") return true
    }
    if (expr.expression.kind === ts.SyntaxKind.ObjectKeyword && expr.name.text === "prototype") return true
    if (ts.isPropertyAccessExpression(expr.expression)) {
      const left = expr.expression
      if (ts.isIdentifier(left.expression) && left.expression.text === "Object" && left.name.text === "prototype") {
        return true
      }
    }
    return isEnvAssignmentTarget(expr.expression)
  }
  if (ts.isElementAccessExpression(expr)) return isEnvAssignmentTarget(expr.expression)
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    return isEnvAssignmentTarget(expr.expression)
  }
  return false
}

function callIsForbiddenEnvWrite(node: ts.CallExpression): boolean {
  const ex = node.expression
  if (ts.isPropertyAccessExpression(ex) && ts.isIdentifier(ex.expression) && ex.expression.text === "Object") {
    if (ex.name.text === "assign" && node.arguments[0] && isEnvAssignmentTarget(node.arguments[0])) return true
    if (
      (ex.name.text === "defineProperty" || ex.name.text === "defineProperties") &&
      node.arguments[0] &&
      isEnvAssignmentTarget(node.arguments[0])
    ) {
      return true
    }
  }
  if (ts.isPropertyAccessExpression(ex) && ts.isIdentifier(ex.expression) && ex.expression.text === "Reflect") {
    if (
      (ex.name.text === "set" || ex.name.text === "defineProperty") &&
      node.arguments[0] &&
      isEnvAssignmentTarget(node.arguments[0])
    ) {
      return true
    }
  }
  if (ts.isPropertyAccessExpression(ex) && ts.isIdentifier(ex.expression) && ex.expression.text === "process") {
    if (ex.name.text === "emit") return true
  }
  return false
}

function isFunctionReturnThisCall(node: ts.CallExpression): boolean {
  const ex = unwrapExpression(node.expression)
  if (!ts.isIdentifier(ex) || ex.text !== "Function") return false
  const arg = node.arguments[0]
  return Boolean(arg && ts.isStringLiteral(arg) && /return\s+this/.test(arg.text))
}

function calleeIsParameter(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false
  const sym = checker.getSymbolAtLocation(expr)
  return Boolean(sym?.declarations?.some((d) => ts.isParameter(d)))
}

function checkExportBody(
  checker: ts.TypeChecker,
  node: ts.Node,
  rel: string,
  exportName: string,
  sealed: Set<string>,
  tainted: Set<string>,
  findings: string[],
): void {
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (exportLeaksTransport(checker, n.initializer, tainted) || expressionUsesRestrictedCallee(n.initializer)) {
        tainted.add(n.name.text)
      } else if (ts.isIdentifier(n.initializer) && tainted.has(n.initializer.text)) {
        tainted.add(n.name.text)
      }
    }
    if (ts.isReturnStatement(n) && n.expression) {
      if (exportLeaksTransport(checker, n.expression, tainted)) {
        findings.push(`${rel}: ${VIOLATION} (${exportName} returns transport-capable value)`)
      }
    }
    if (ts.isYieldExpression(n) && n.expression) {
      if (exportLeaksTransport(checker, n.expression, tainted)) {
        findings.push(`${rel}: ${VIOLATION} (${exportName} yields transport-capable value)`)
      }
    }
    if (ts.isCallExpression(n)) {
      const cal = unwrapExpression(n.expression)
      const leaksArg = (arg: ts.Expression) =>
        expressionCapableOfTransport(checker, arg, tainted) ||
        exportLeaksTransport(checker, arg, tainted) ||
        (isFunctionLike(unwrapExpression(arg)) && functionCapturesTainted(unwrapExpression(arg) as ts.FunctionLikeDeclaration, tainted))
      if (calleeIsParameter(checker, cal)) {
        for (const arg of n.arguments) {
          if (leaksArg(arg)) {
            findings.push(`${rel}: ${VIOLATION} (${exportName} passes transport to callback)`)
          }
        }
      }
      if (ts.isPropertyAccessExpression(cal) && cal.name.text === "cb") {
        for (const arg of n.arguments) {
          if (leaksArg(arg)) {
            findings.push(`${rel}: ${VIOLATION} (${exportName} passes transport to callback)`)
          }
        }
      }
      for (const arg of n.arguments) {
        const u = unwrapExpression(arg)
        if (isFunctionLike(u) && functionCapturesTainted(u, tainted)) {
          findings.push(`${rel}: ${VIOLATION} (${exportName} passes transport-capturing closure)`)
        }
      }
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (isSealedTarget(n.left, sealed)) {
        if (rhsEscapesViaSealedHolder(checker, n.right, tainted)) {
          findings.push(`${rel}: ${VIOLATION} (${exportName} attaches transport-capturing closure to sealed export)`)
        } else {
          findings.push(`${rel}: ${VIOLATION} (sealed export mutation)`)
        }
      }
      if (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left)) {
        const rt = checker.getTypeAtLocation(n.right)
        if (isTransportLikeType(checker, rt) || expressionUsesRestrictedCallee(n.right)) {
          const leftSym = checker.getSymbolAtLocation(n.left.expression)
          if (leftSym && !leftSym.declarations?.some(ts.isParameter)) {
            findings.push(`${rel}: ${VIOLATION} (${exportName} mutates holder with transport)`)
          }
        }
      }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "push") {
      const arg = n.arguments[0]
      if (arg) {
        const at = checker.getTypeAtLocation(arg)
        if (isTransportLikeType(checker, at) || expressionUsesRestrictedCallee(arg)) {
          findings.push(`${rel}: ${VIOLATION} (${exportName} pushes transport into holder)`)
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
}

function checkValueExport(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  rel: string,
  tainted: Set<string>,
  sealed: Set<string>,
  findings: string[],
): void {
  const name = symbol.getName()
  if (isTypeOnlyExportSymbol(symbol)) {
    for (const decl of symbol.getDeclarations() ?? []) {
      if (ts.isTypeAliasDeclaration(decl) && isTypeAliasToTransport(checker, decl)) {
        findings.push(`${rel}: ${VIOLATION} (type export ${name} aliases transport)`)
      }
    }
    return
  }

  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (!decl) return

  const exportType = checker.getTypeOfSymbolAtLocation(symbol, decl)
  if (isTransportLikeType(checker, exportType)) {
    findings.push(`${rel}: ${VIOLATION} (export ${name} has transport-like type)`)
  }

  if (
    ts.isFunctionDeclaration(decl) ||
    ts.isMethodDeclaration(decl) ||
    ts.isArrowFunction(decl) ||
    ts.isFunctionExpression(decl)
  ) {
    checkExportBody(checker, decl, rel, name, sealed, tainted, findings)
  }
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    if (exportLeaksTransport(checker, decl.initializer, tainted)) {
      findings.push(`${rel}: ${VIOLATION} (export ${name} initializer is transport-capable)`)
    }
    checkExportBody(checker, decl.initializer, rel, name, sealed, tainted, findings)
  }
  if (ts.isClassDeclaration(decl)) {
    for (const member of decl.members) {
      checkExportBody(checker, member, rel, name, sealed, tainted, findings)
    }
  }
}

function checkExportSpecifier(
  checker: ts.TypeChecker,
  local: ts.Identifier,
  rel: string,
  sealed: Set<string>,
  tainted: Set<string>,
  findings: string[],
): void {
  if (exportLeaksTransport(checker, local, tainted)) {
    findings.push(`${rel}: ${VIOLATION} (re-export ${local.text} is transport-capable)`)
  }
  const sym = checker.getSymbolAtLocation(local)
  if (sym) checkValueExport(checker, sym, rel, tainted, sealed, findings)
}

function checkSealedAndSideChannels(
  checker: ts.TypeChecker,
  node: ts.Node,
  rel: string,
  sealed: Set<string>,
  tainted: Set<string>,
  findings: string[],
  inFunction = false,
): void {
  if (!inFunction && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    if (exportLeaksTransport(checker, node.initializer, tainted)) {
      tainted.add(node.name.text)
      if (!sealed.has(node.name.text)) {
        findings.push(`${rel}: ${VIOLATION} (module-level transport holder)`)
      }
    } else if (expressionCapableOfTransport(checker, node.initializer, tainted)) {
      tainted.add(node.name.text)
    }
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (isSealedTarget(node.left, sealed)) {
      if (rhsEscapesViaSealedHolder(checker, node.right, tainted)) {
        findings.push(`${rel}: ${VIOLATION} (transport-capturing closure on sealed export)`)
      } else {
        findings.push(`${rel}: ${VIOLATION} (sealed export mutation)`)
      }
    }
    if (isEnvAssignmentTarget(node.left) && expressionLeaksTransportForEnvWrite(checker, node.right, tainted)) {
      findings.push(`${rel}: ${VIOLATION} (forbidden environment write)`)
    }
    if (!inFunction && ts.isIdentifier(node.left) && expressionCapableOfTransport(checker, node.right, tainted)) {
      tainted.add(node.left.text)
    }
  }
  if (ts.isCallExpression(node)) {
    if (isFunctionReturnThisCall(node)) {
      findings.push(`${rel}: ${VIOLATION} (Function return this escape)`)
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      (node.expression.name.text === "defineProperty" || node.expression.name.text === "defineProperties") &&
      node.arguments[0] &&
      isSealedTarget(node.arguments[0], sealed)
    ) {
      findings.push(`${rel}: ${VIOLATION} (sealed export mutation)`)
      const desc = node.arguments[1] ?? node.arguments[2]
      if (desc && ts.isObjectLiteralExpression(desc)) {
        for (const p of desc.properties) {
          if (ts.isGetAccessor(p) || ts.isSetAccessor(p)) {
            findings.push(`${rel}: ${VIOLATION} (sealed export mutation)`)
          }
        }
      }
    }
    if (!inFunction && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const transportArg =
        method === "push" ? node.arguments[0] : method === "set" ? node.arguments[1] : undefined
      if (transportArg && expressionCapableOfTransport(checker, transportArg, tainted)) {
        findings.push(`${rel}: ${VIOLATION} (module-level transport holder)`)
      }
      if (method === "cb" && node.arguments.some((a) => expressionCapableOfTransport(checker, a, tainted))) {
        findings.push(`${rel}: ${VIOLATION} (transport passed as call argument)`)
      }
    }
    if (callIsForbiddenEnvWrite(node)) {
      const target = node.arguments[0]
      if (target && isEnvAssignmentTarget(target)) {
        const rest = node.arguments.slice(1)
        if (rest.some((a) => expressionLeaksTransportForEnvWrite(checker, a, tainted))) {
          findings.push(`${rel}: ${VIOLATION} (forbidden environment write)`)
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Object" &&
          (node.expression.name.text === "defineProperty" || node.expression.name.text === "defineProperties")
        ) {
          for (const a of rest) {
            if (ts.isObjectLiteralExpression(a)) {
              for (const p of a.properties) {
                if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "value") {
                  if (expressionLeaksTransportForEnvWrite(checker, p.initializer, tainted)) {
                    findings.push(`${rel}: ${VIOLATION} (forbidden environment write)`)
                  }
                }
                if (ts.isGetAccessor(p) || ts.isSetAccessor(p)) {
                  findings.push(`${rel}: ${VIOLATION} (sealed export mutation)`)
                }
              }
            }
          }
        }
      }
      if (target && isSealedTarget(target, sealed)) {
        findings.push(`${rel}: ${VIOLATION} (sealed export mutation)`)
      }
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "emit"
    ) {
      if (node.arguments.some((a) => expressionCapableOfTransport(checker, a, tainted))) {
        findings.push(`${rel}: ${VIOLATION} (forbidden environment write)`)
      }
    }
    const ex = node.expression
    if (ts.isIdentifier(ex) && ex.text === "Proxy" && node.arguments[0] && isSealedTarget(node.arguments[0], sealed)) {
      findings.push(`${rel}: ${VIOLATION} (Proxy wrap of sealed export)`)
    }
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Proxy") {
    const target = node.arguments?.[0]
    if (target && isSealedTarget(target, sealed)) {
      findings.push(`${rel}: ${VIOLATION} (Proxy wrap of sealed export)`)
    }
  }
  if (ts.isModuleDeclaration(node) && node.name && ts.isIdentifier(node.name) && sealed.has(node.name.text)) {
    findings.push(`${rel}: ${VIOLATION} (namespace merge on sealed export)`)
  }
  const nextInFunction =
    inFunction ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  ts.forEachChild(node, (child) =>
    checkSealedAndSideChannels(checker, child, rel, sealed, tainted, findings, nextInFunction),
  )
}

function analyzeGrantedFile(
  program: ts.Program,
  root: string,
  rel: string,
  allowlist: Allowlist,
): string[] {
  const abs = path.join(root, rel)
  const sf = program.getSourceFile(abs)
  if (!sf) return [`${rel}: ${VIOLATION} (missing from TypeScript program)`]

  const checker = program.getTypeChecker()
  const mod = checker.getSymbolAtLocation(sf)
  if (!mod) return [`${rel}: ${VIOLATION} (no module symbol)`]

  const exports = checker.getExportsOfModule(mod)
  const actual = new Set(exports.map((s) => s.getName()).filter((n) => n !== "__export"))
  const allowed = new Set(allowlist[rel] ?? [])

  const findings: string[] = []

  for (const name of actual) {
    if (!allowed.has(name)) findings.push(`${rel}: ${VIOLATION} (export not allowlisted: ${name})`)
  }
  for (const name of allowed) {
    if (!actual.has(name)) findings.push(`${rel}: ${VIOLATION} (allowlisted export missing: ${name})`)
  }

  const tainted = new Set<string>()
  seedTaintFromImports(sf, rel, tainted)

  for (const sym of exports) {
    const name = sym.getName()
    if (name === "__export" || !allowed.has(name)) continue
    checkValueExport(checker, sym, rel, tainted, allowed, findings)
  }

  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const local = el.propertyName ?? el.name
        if (ts.isIdentifier(local)) checkExportSpecifier(checker, local, rel, allowed, tainted, findings)
      }
    }
  }

  checkSealedAndSideChannels(checker, sf, rel, allowed, tainted, findings)

  return [...new Set(findings)]
}

function main(): number {
  const scanRoot = path.resolve(process.argv[2] ?? ".")
  const programRoot = process.env.SIKANDER_GATE_TOOL_ROOT
    ? path.resolve(process.env.SIKANDER_GATE_TOOL_ROOT)
    : scanRoot
  const allowlist = loadAllowlist(programRoot)
  let program: ts.Program
  try {
    program = createFunctionsProgram(programRoot, scanRoot)
  } catch (err) {
    console.log(`granted export check: TypeScript program failed (${String(err)})`)
    return 1
  }

  const findings: string[] = []
  for (const rel of GRANTED_FILES) {
    if (!allowlist[rel]) {
      findings.push(`${rel}: ${VIOLATION} (no allowlist entry)`)
      continue
    }
    findings.push(...analyzeGrantedFile(program, programRoot, rel, allowlist))
  }

  for (const f of findings) console.log(f)
  return findings.length > 0 ? 1 : 0
}

process.exit(main())
