/**
 * Rule (f) AST check (FA-F18-016+): eve's defineAgent model must be the
 * `committeeBrainLanguageModel` named import from exactly platform/p1/committeeBrainModel.
 * Invoked from ci_gates/check_next_ai_egress.py. Prints one finding per line; exit 1 if any.
 */
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const CANONICAL_MODULE = "platform/p1/committeeBrainModel"
const MODEL_BINDING = "committeeBrainLanguageModel"
const DEFINE_AGENT = "defineAgent"
const EVE_MODULE = "eve"

const JS_SUFFIXES = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"])

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])

function posixRel(abs: string, root: string): string {
  return path.relative(root, abs).split(path.sep).join("/")
}

function modulePathFromRel(rel: string): string {
  return rel.replace(/\.(?:[cm]?[jt]sx?)$/i, "")
}

function resolveRepoModule(spec: string, importerRel: string): string | null {
  const raw = spec.trim().split("?")[0].split("#")[0].trim()
  if (!raw) return null
  if (raw.includes(":") && raw.split("/")[0].includes(":")) return null
  let modulePath: string
  if (raw.startsWith("@/")) {
    modulePath = raw.slice(2)
  } else if (raw.startsWith("./") || raw.startsWith("../") || raw === "." || raw === "..") {
    modulePath = path.posix.normalize(path.posix.join(path.posix.dirname(importerRel), raw))
  } else if (raw.startsWith("/")) {
    return null
  } else {
    modulePath = raw
  }
  modulePath = modulePath.replace(/\.(?:[cm]?[jt]sx?)$/i, "")
  if (modulePath.endsWith("/index")) modulePath = modulePath.slice(0, -"/index".length)
  modulePath = path.posix.normalize(modulePath)
  if (modulePath === ".." || modulePath.startsWith("../")) return null
  return modulePath
}

function listAgentSourceFiles(agentDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name)
      const st = fs.statSync(abs)
      if (st.isDirectory()) walk(abs)
      else if (JS_SUFFIXES.has(path.extname(name).toLowerCase())) out.push(abs)
    }
  }
  if (fs.existsSync(agentDir)) walk(agentDir)
  return out.sort()
}

type ImportInfo = { local: string; imported: string; module: string; isTypeOnly: boolean }

function collectImports(sf: ts.SourceFile, importerRel: string): ImportInfo[] {
  const imports: ImportInfo[] = []
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const resolvedModule = resolveRepoModule(stmt.moduleSpecifier.text, importerRel) ?? stmt.moduleSpecifier.text
    const typeOnly = stmt.importClause?.isTypeOnly === true
    const clause = stmt.importClause
    if (!clause) continue
    if (clause.name) imports.push({ local: clause.name.text, imported: "default", module: resolvedModule, isTypeOnly: typeOnly })
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      imports.push({
        local: clause.namedBindings.name.text,
        imported: "*",
        module: resolvedModule,
        isTypeOnly: typeOnly,
      })
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const imported = el.propertyName?.text ?? el.name.text
        imports.push({ local: el.name.text, imported, module: resolvedModule, isTypeOnly: typeOnly || el.isTypeOnly })
      }
    }
  }
  return imports
}

function hasCanonicalModelImport(imports: ImportInfo[]): boolean {
  return imports.some(
    (i) => !i.isTypeOnly && i.local === MODEL_BINDING && i.imported === MODEL_BINDING && i.module === CANONICAL_MODULE
  )
}

function isDefineAgentIdentifier(node: ts.Node): boolean {
  return ts.isIdentifier(node) && node.text === DEFINE_AGENT
}

function isDefineAgentIdentifierCall(node: ts.CallExpression): boolean {
  return isDefineAgentIdentifier(node.expression)
}

function isMemberDefineAgentCall(node: ts.CallExpression): boolean {
  const ex = node.expression
  if (ts.isPropertyAccessExpression(ex) && ex.name.text === DEFINE_AGENT) return true
  if (ts.isElementAccessExpression(ex)) {
    const arg = ex.argumentExpression
    if (arg && ts.isStringLiteral(arg) && arg.text === DEFINE_AGENT) return true
    if (arg && ts.isNoSubstitutionTemplateLiteral(arg) && arg.text === DEFINE_AGENT) return true
  }
  return false
}

function symbolDeclaresLocalDefineAgent(sym: ts.Symbol | undefined): boolean {
  if (!sym) return false
  for (const decl of sym.declarations ?? []) {
    if (ts.isVariableDeclaration(decl) || ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) {
      return true
    }
    if (ts.isParameter(decl)) return true
  }
  return false
}

function calleeIsEveDefineAgent(node: ts.CallExpression, checker: ts.TypeChecker, imports: ImportInfo[]): boolean {
  if (!isDefineAgentIdentifierCall(node)) return false
  const ex = node.expression
  if (!ts.isIdentifier(ex)) return false
  const binding = imports.find((i) => !i.isTypeOnly && i.local === DEFINE_AGENT)
  if (!binding || binding.module !== EVE_MODULE || binding.imported !== DEFINE_AGENT) return false
  const sym = checker.getSymbolAtLocation(ex)
  if (symbolDeclaresLocalDefineAgent(sym)) return false
  const target = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
  if (target?.declarations?.some((d) => ts.isImportSpecifier(d))) return true
  // External "eve" may not resolve in isolated probe trees; the import table is authoritative.
  return true
}

function objectHasSpread(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some((p) => ts.isSpreadAssignment(p))
}

function modelProperty(
  obj: ts.ObjectLiteralExpression
): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find((p) => {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
      if (ts.isIdentifier(p.name) && p.name.text === "model") return true
      if (ts.isStringLiteral(p.name) && p.name.text === "model") return true
    }
    return false
  })
}

function canonicalModelDeclFile(root: string): string | null {
  for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
    const abs = path.join(root, CANONICAL_MODULE + ext)
    if (fs.existsSync(abs)) return abs
  }
  return null
}

function createProgram(root: string, agentFiles: string[]): ts.Program | null {
  const canonical = canonicalModelDeclFile(root)
  const rootNames = [...agentFiles]
  if (canonical && !rootNames.includes(canonical)) rootNames.push(canonical)
  if (!rootNames.length) return null
  return ts.createProgram(rootNames, {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    jsx: ts.JsxEmit.React,
    skipLibCheck: true,
  })
}

function resolvesToCanonicalModel(expr: ts.Expression, checker: ts.TypeChecker, root: string): boolean {
  const sym = checker.getSymbolAtLocation(expr)
  if (!sym) return false
  const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
  if (target.getName() !== MODEL_BINDING) return false
  const decl = target.valueDeclaration ?? target.declarations?.[0]
  if (!decl) return false
  const rel = modulePathFromRel(posixRel(decl.getSourceFile().fileName, root))
  return rel === CANONICAL_MODULE
}

function exprIsCanonicalModel(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  root: string,
  imports: ImportInfo[]
): boolean {
  if (!hasCanonicalModelImport(imports)) return false
  return resolvesToCanonicalModel(expr, checker, root)
}

function bindingDeclaresName(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) return name.text === target
  if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue
      if (bindingDeclaresName(el.name, target)) return true
    }
    return false
  }
  return false
}

function forbiddenLocalBindings(sf: ts.SourceFile, rel: string, findings: string[]): void {
  const tag = "FA-F18-025"
  const visit = (node: ts.Node, inImport: boolean) => {
    if (ts.isImportDeclaration(node)) {
      ts.forEachChild(node, (child) => visit(child, true))
      return
    }
    if (inImport) {
      ts.forEachChild(node, (child) => visit(child, true))
      return
    }
    if (ts.isVariableDeclaration(node) && bindingDeclaresName(node.name, DEFINE_AGENT)) {
      findings.push(`${rel}: local binding of ${DEFINE_AGENT} is not allowed (${tag})`)
    }
    if (ts.isVariableDeclaration(node) && bindingDeclaresName(node.name, MODEL_BINDING)) {
      findings.push(
        `${rel}: local binding of ${MODEL_BINDING} is not allowed; use the import from ${CANONICAL_MODULE} (FA-F18-020)`
      )
    }
    if (ts.isVariableDeclaration(node) && bindingDeclaresName(node.name, "model")) {
      const list = node.parent && ts.isVariableDeclarationList(node.parent) ? node.parent : undefined
      const isLet = Boolean(list && list.flags & ts.NodeFlags.Let)
      const isVar = Boolean(list && !(list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)))
      if (isLet || isVar) {
        findings.push(`${rel}: let/var model binding is not allowed under agent/ (FA-F18-016)`)
      }
    }
    if (ts.isParameter(node) && bindingDeclaresName(node.name, DEFINE_AGENT)) {
      findings.push(`${rel}: parameter ${DEFINE_AGENT} is not allowed under agent/ (${tag})`)
    }
    if (ts.isParameter(node) && bindingDeclaresName(node.name, MODEL_BINDING)) {
      findings.push(`${rel}: parameter ${MODEL_BINDING} is not allowed under agent/ (FA-F18-020)`)
    }
    if (ts.isParameter(node) && bindingDeclaresName(node.name, "model")) {
      findings.push(`${rel}: parameter model is not allowed under agent/ (FA-F18-020)`)
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === DEFINE_AGENT) {
      findings.push(`${rel}: local binding of ${DEFINE_AGENT} is not allowed (${tag})`)
    }
    if (ts.isClassDeclaration(node) && node.name?.text === DEFINE_AGENT) {
      findings.push(`${rel}: local binding of ${DEFINE_AGENT} is not allowed (${tag})`)
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === MODEL_BINDING) {
      findings.push(`${rel}: local binding of ${MODEL_BINDING} is not allowed (FA-F18-020)`)
    }
    if (
      ts.isCatchClause(node) &&
      node.variableDeclaration &&
      bindingDeclaresName(node.variableDeclaration.name, DEFINE_AGENT)
    ) {
      findings.push(`${rel}: local binding of ${DEFINE_AGENT} is not allowed (${tag})`)
    }
    if (ts.isCatchClause(node) && node.variableDeclaration && bindingDeclaresName(node.variableDeclaration.name, MODEL_BINDING)) {
      findings.push(`${rel}: local binding of ${MODEL_BINDING} is not allowed (FA-F18-020)`)
    }
    ts.forEachChild(node, (child) => visit(child, false))
  }
  for (const stmt of sf.statements) visit(stmt, false)
}

function validateEveDefineAgentImports(rel: string, imports: ImportInfo[], findings: string[]): void {
  const tag = "FA-F18-025"
  for (const imp of imports) {
    if (imp.isTypeOnly) continue
    if (imp.local === DEFINE_AGENT || imp.imported === DEFINE_AGENT) {
      if (imp.module !== EVE_MODULE || imp.imported !== DEFINE_AGENT || imp.local !== DEFINE_AGENT) {
        findings.push(`${rel}: defineAgent must be imported by name from "${EVE_MODULE}" (FA-F18-021, ${tag})`)
      }
    }
    if (imp.module === EVE_MODULE) {
      if (imp.imported === "default" || imp.imported === "*") {
        findings.push(`${rel}: only a named import of ${DEFINE_AGENT} from "${EVE_MODULE}" is allowed (${tag})`)
      }
    }
  }
  if (rel === "agent/agent.ts") {
    const eveNamed = imports.filter(
      (i) =>
        !i.isTypeOnly && i.module === EVE_MODULE && i.local === DEFINE_AGENT && i.imported === DEFINE_AGENT
    )
    if (eveNamed.length !== 1) {
      findings.push(
        `${rel}: agent/agent.ts must have exactly one import { ${DEFINE_AGENT} } from "${EVE_MODULE}" (${tag})`
      )
    }
  }
}

function validateAgentEntryExport(sf: ts.SourceFile, rel: string, checker: ts.TypeChecker, findings: string[]): void {
  if (rel !== "agent/agent.ts") return
  let directDefault = false
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (ts.isCallExpression(stmt.expression) && calleeIsEveDefineAgent(stmt.expression, checker, collectImports(sf, rel))) {
        directDefault = true
      } else if (ts.isCallExpression(stmt.expression) && isDefineAgentIdentifierCall(stmt.expression)) {
        findings.push(`${rel}: export default defineAgent must call eve's import (${"FA-F18-025"})`)
      } else {
        findings.push(`${rel}: export default must be defineAgent({...}) directly (FA-F18-021)`)
      }
    }
    if (ts.isExportDeclaration(stmt)) {
      const clause = stmt.exportClause
      if (!clause) {
        findings.push(`${rel}: re-exporting default from outside agent/ is not allowed (FA-F18-021)`)
        continue
      }
      if (ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          const exported = el.name.text
          const orig = el.propertyName?.text ?? exported
          if (exported === "default" || orig === "default") {
            findings.push(`${rel}: re-exporting default from outside agent/ is not allowed (FA-F18-021)`)
          }
        }
      }
    }
  }
  if (!directDefault) {
    findings.push(`${rel}: agent/agent.ts must export default defineAgent({...}) (FA-F18-021)`)
  }
}

function stringConstValue(expr: ts.Expression, checker: ts.TypeChecker): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  const sym = checker.getSymbolAtLocation(expr)
  if (!sym) return null
  const decl = sym.valueDeclaration
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return null
  if (ts.isStringLiteral(decl.initializer) || ts.isNoSubstitutionTemplateLiteral(decl.initializer)) {
    return decl.initializer.text
  }
  return null
}

function isModelPropertyAccess(left: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(left) && left.name.text === "model"
}

function isModelElementAccess(left: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isElementAccessExpression(left)) return false
  const arg = left.argumentExpression
  if (!arg) return false
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text === "model"
  return stringConstValue(arg, checker) === "model"
}

function callIsGlobalMethod(node: ts.CallExpression, objectName: string, method: string): boolean {
  const ex = node.expression
  return ts.isPropertyAccessExpression(ex) && ts.isIdentifier(ex.expression) && ex.expression.text === objectName && ex.name.text === method
}

function callIsReflectMethod(node: ts.CallExpression, method: string): boolean {
  const ex = node.expression
  return ts.isPropertyAccessExpression(ex) && ts.isIdentifier(ex.expression) && ex.expression.text === "Reflect" && ex.name.text === method
}

function exprIsCanonicalModelTarget(expr: ts.Expression, checker: ts.TypeChecker, root: string): boolean {
  if (ts.isIdentifier(expr) && expr.text === MODEL_BINDING) return true
  return resolvesToCanonicalModel(expr, checker, root)
}

function allowedSpreadOrAssignSource(expr: ts.Expression, sf: ts.SourceFile, checker: ts.TypeChecker): boolean {
  if (ts.isObjectLiteralExpression(expr)) return true
  if (!ts.isIdentifier(expr)) return false
  const sym = checker.getSymbolAtLocation(expr)
  if (!sym) return false
  const decl = sym.valueDeclaration
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false
  if (!ts.isObjectLiteralExpression(decl.initializer)) return false
  return decl.getSourceFile() === sf
}

function forbiddenEveDynamicLoads(sf: ts.SourceFile, rel: string, findings: string[]): void {
  const tag = "FA-F18-025"
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        if (node.arguments[0].text === EVE_MODULE) {
          findings.push(`${rel}: dynamic import of "${EVE_MODULE}" is not allowed under agent/ (${tag})`)
        }
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === EVE_MODULE
      ) {
        findings.push(`${rel}: require("${EVE_MODULE}") is not allowed under agent/ (${tag})`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

function forbiddenCanonicalModelMutation(
  sf: ts.SourceFile,
  rel: string,
  checker: ts.TypeChecker,
  root: string,
  findings: string[]
): void {
  const tag = "FA-F18-027"
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      if (exprIsCanonicalModelTarget(node.left, checker, root)) {
        findings.push(`${rel}: mutating ${MODEL_BINDING} is not allowed under agent/ (${tag})`)
      }
    }
    if (ts.isCallExpression(node)) {
      if (callIsGlobalMethod(node, "Object", "assign") && node.arguments[0]) {
        if (exprIsCanonicalModelTarget(node.arguments[0], checker, root)) {
          findings.push(`${rel}: Object.assign on ${MODEL_BINDING} is not allowed under agent/ (${tag})`)
        }
        for (const arg of node.arguments.slice(1)) {
          if (!allowedSpreadOrAssignSource(arg, sf, checker)) {
            findings.push(`${rel}: Object.assign source must be an object literal in agent/ (${tag})`)
          }
        }
      }
      if (callIsGlobalMethod(node, "Object", "defineProperty") && node.arguments[0]) {
        if (exprIsCanonicalModelTarget(node.arguments[0], checker, root)) {
          findings.push(`${rel}: Object.defineProperty on ${MODEL_BINDING} is not allowed (${tag})`)
        }
      }
      if (callIsGlobalMethod(node, "Object", "defineProperties") && node.arguments[0]) {
        if (exprIsCanonicalModelTarget(node.arguments[0], checker, root)) {
          findings.push(`${rel}: Object.defineProperties on ${MODEL_BINDING} is not allowed (${tag})`)
        }
      }
      if (callIsGlobalMethod(node, "Object", "setPrototypeOf") && node.arguments[0]) {
        if (exprIsCanonicalModelTarget(node.arguments[0], checker, root)) {
          findings.push(`${rel}: Object.setPrototypeOf on ${MODEL_BINDING} is not allowed (${tag})`)
        }
      }
      if (callIsReflectMethod(node, "set") && node.arguments[0]) {
        if (exprIsCanonicalModelTarget(node.arguments[0], checker, root)) {
          findings.push(`${rel}: Reflect.set on ${MODEL_BINDING} is not allowed (${tag})`)
        }
      }
      if (callIsReflectMethod(node, "defineProperty") && node.arguments[0]) {
        if (exprIsCanonicalModelTarget(node.arguments[0], checker, root)) {
          findings.push(`${rel}: Reflect.defineProperty on ${MODEL_BINDING} is not allowed (${tag})`)
        }
      }
      if (callIsReflectMethod(node, "setPrototypeOf") && node.arguments[0]) {
        if (exprIsCanonicalModelTarget(node.arguments[0], checker, root)) {
          findings.push(`${rel}: Reflect.setPrototypeOf on ${MODEL_BINDING} is not allowed (${tag})`)
        }
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const p of node.properties) {
        if (ts.isSpreadAssignment(p) && !allowedSpreadOrAssignSource(p.expression, sf, checker)) {
          findings.push(`${rel}: object spread from outside agent/ is not allowed (${tag})`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

function objectLiteralHasModelKey(expr: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(expr)) return false
  return expr.properties.some((p) => {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return false
    if (ts.isIdentifier(p.name) && p.name.text === "model") return true
    return ts.isStringLiteral(p.name) && p.name.text === "model"
  })
}

function validateModelInDefineAgent(
  obj: ts.ObjectLiteralExpression,
  rel: string,
  imports: ImportInfo[],
  checker: ts.TypeChecker,
  root: string,
  findings: string[]
): void {
  if (objectHasSpread(obj)) {
    findings.push(
      `${rel}: defineAgent argument must be an object literal without spread (FA-F18-016)`
    )
    return
  }
  const prop = modelProperty(obj)
  if (!prop) {
    findings.push(`${rel}: defineAgent argument must set model to ${MODEL_BINDING} (FA-F18-016)`)
    return
  }
  if (ts.isPropertyAssignment(prop)) {
    if (!exprIsCanonicalModel(prop.initializer, checker, root, imports)) {
      findings.push(
        `${rel}: eve model must be ${MODEL_BINDING} imported from ${CANONICAL_MODULE} (FA-F18-016)`
      )
    }
    return
  }
  if (ts.isShorthandPropertyAssignment(prop)) {
    const sym = checker.getShorthandAssignmentValueSymbol(prop)
    const expr = sym?.valueDeclaration && ts.isVariableDeclaration(sym.valueDeclaration) && sym.valueDeclaration.initializer
      ? sym.valueDeclaration.initializer
      : prop.name
    if (!exprIsCanonicalModel(expr as ts.Expression, checker, root, imports)) {
      findings.push(`${rel}: shorthand { model } must bind to imported ${MODEL_BINDING} (FA-F18-016)`)
    }
  }
}

function forbiddenModelUsage(
  sf: ts.SourceFile,
  rel: string,
  defineAgentArg: ts.ObjectLiteralExpression | undefined,
  checker: ts.TypeChecker,
  findings: string[]
): void {
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) && node !== defineAgentArg) {
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
          const name = ts.isIdentifier(p.name) ? p.name.text : ts.isStringLiteral(p.name) ? p.name.text : ""
          if (name === "model") {
            findings.push(`${rel}: model property outside defineAgent is not allowed (FA-F18-016)`)
          }
        }
      }
    }
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      const left = node.left
      if (ts.isIdentifier(left) && left.text === "model") {
        findings.push(`${rel}: assigning to model binding under agent/ is not allowed (FA-F18-016)`)
      }
      if (isModelPropertyAccess(left)) {
        findings.push(`${rel}: assigning to .model under agent/ is not allowed (FA-F18-022)`)
      }
      if (isModelElementAccess(left, checker)) {
        findings.push(`${rel}: computed assignment to model key under agent/ is not allowed (FA-F18-022)`)
      }
    }
    if (ts.isCallExpression(node)) {
      if (callIsGlobalMethod(node, "Object", "defineProperty") && node.arguments.length >= 2) {
        const key = node.arguments[1]
        if (
          (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) &&
          key.text === "model"
        ) {
          findings.push(`${rel}: Object.defineProperty on model is not allowed (FA-F18-022)`)
        }
      }
      if (callIsGlobalMethod(node, "Object", "assign")) {
        for (const arg of node.arguments.slice(1)) {
          if (objectLiteralHasModelKey(arg)) {
            findings.push(`${rel}: Object.assign setting model is not allowed (FA-F18-022)`)
          }
        }
      }
      if (callIsGlobalMethod(node, "Reflect", "set") && node.arguments.length >= 2) {
        const key = node.arguments[1]
        if (
          (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) &&
          key.text === "model"
        ) {
          findings.push(`${rel}: Reflect.set on model is not allowed (FA-F18-022)`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

function checkFile(
  abs: string,
  root: string,
  program: ts.Program,
  defineAgentNodes: ts.CallExpression[],
  findings: string[]
): void {
  const rel = posixRel(abs, root)
  const sf = program.getSourceFile(abs)
  if (!sf) return
  const checker = program.getTypeChecker()
  const imports = collectImports(sf, rel)

  for (const imp of imports) {
    if (imp.local === MODEL_BINDING && imp.module !== CANONICAL_MODULE) {
      findings.push(
        `${rel}: ${MODEL_BINDING} import resolves to ${imp.module}, not ${CANONICAL_MODULE} (FA-F18-016)`
      )
    }
  }

  validateEveDefineAgentImports(rel, imports, findings)
  forbiddenLocalBindings(sf, rel, findings)
  forbiddenEveDynamicLoads(sf, rel, findings)
  validateAgentEntryExport(sf, rel, checker, findings)

  let defineAgentArg: ts.ObjectLiteralExpression | undefined
  const visitDefine = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isMemberDefineAgentCall(node)) {
      findings.push(`${rel}: member access ${DEFINE_AGENT} call is not allowed (FA-F18-025)`)
      defineAgentNodes.push(node)
    } else if (ts.isCallExpression(node) && isDefineAgentIdentifierCall(node)) {
      if (!calleeIsEveDefineAgent(node, checker, imports)) {
        findings.push(`${rel}: defineAgent call must use eve's named import (FA-F18-025)`)
      }
      defineAgentNodes.push(node)
      if (calleeIsEveDefineAgent(node, checker, imports)) {
        if (node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
          defineAgentArg = node.arguments[0]
          validateModelInDefineAgent(node.arguments[0], rel, imports, checker, root, findings)
        } else {
          findings.push(`${rel}: defineAgent must be called with an object literal (FA-F18-016)`)
        }
      }
    }
    ts.forEachChild(node, visitDefine)
  }
  visitDefine(sf)
  forbiddenModelUsage(sf, rel, defineAgentArg, checker, findings)
  forbiddenCanonicalModelMutation(sf, rel, checker, root, findings)
}

const FORBIDDEN_AGENT_ENTRY_SUFFIXES = [".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]

function main(): number {
  const root = path.resolve(process.argv[2] ?? process.cwd())
  const agentDir = path.join(root, "agent")
  const agentDirExists = fs.existsSync(agentDir)
  const files = listAgentSourceFiles(agentDir)
  const findings: string[] = []
  const defineAgentCalls: ts.CallExpression[] = []
  const program = createProgram(root, files)

  if (agentDirExists) {
    const agentTs = path.join(agentDir, "agent.ts")
    if (!fs.existsSync(agentTs)) {
      findings.push(`agent/: agent/agent.ts must exist when agent/ is present (FA-F18-028)`)
    }
    for (const suf of FORBIDDEN_AGENT_ENTRY_SUFFIXES) {
      const alt = path.join(agentDir, `agent${suf}`)
      if (fs.existsSync(alt)) {
        findings.push(`agent/: forbidden entry file agent/agent${suf} (use agent/agent.ts only) (FA-F18-028)`)
      }
    }
  }

  if (!program) {
    findings.push("agent/: could not create TypeScript checker for eve model rule (FA-F18-016)")
  } else {
    for (const abs of files) checkFile(abs, root, program, defineAgentCalls, findings)
  }

  const agentTs = path.join(agentDir, "agent.ts")
  const hasAgentEntry = fs.existsSync(agentTs)
  const eveDefineAgentCalls = defineAgentCalls.filter((c) => {
    const checker = program?.getTypeChecker()
    if (!checker) return false
    const sf = c.getSourceFile()
    const rel = posixRel(sf.fileName, root)
    return calleeIsEveDefineAgent(c, checker, collectImports(sf, rel))
  })
  const callsInAgentTs = eveDefineAgentCalls.filter(
    (c) => posixRel(c.getSourceFile().fileName, root) === "agent/agent.ts"
  )

  if (eveDefineAgentCalls.length > 1) {
    findings.push(`agent/: more than one defineAgent call under agent/ (FA-F18-016)`)
  }
  if (hasAgentEntry && callsInAgentTs.length !== 1) {
    findings.push(
      `agent/: expected exactly one defineAgent call in agent/agent.ts, found ${callsInAgentTs.length} (FA-F18-016)`
    )
  }

  if (findings.length) {
    for (const f of [...new Set(findings)].sort()) console.log(f)
    return 1
  }
  return 0
}

process.exit(main())
