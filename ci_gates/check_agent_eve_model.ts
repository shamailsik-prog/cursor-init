/**
 * Rule (f) AST check (FA-F18-016): eve's defineAgent model must be the
 * `committeeBrainLanguageModel` named import from exactly platform/p1/committeeBrainModel.
 * Invoked from ci_gates/check_next_ai_egress.py. Prints one finding per line; exit 1 if any.
 */
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const CANONICAL_MODULE = "platform/p1/committeeBrainModel"
const MODEL_BINDING = "committeeBrainLanguageModel"
const DEFINE_AGENT = "defineAgent"

const JS_SUFFIXES = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])

function posixRel(abs: string, root: string): string {
  return path.relative(root, abs).split(path.sep).join("/")
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

type ImportInfo = { local: string; module: string; isTypeOnly: boolean }

function collectImports(sf: ts.SourceFile, importerRel: string): ImportInfo[] {
  const imports: ImportInfo[] = []
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const resolvedModule = resolveRepoModule(stmt.moduleSpecifier.text, importerRel) ?? stmt.moduleSpecifier.text
    const typeOnly = stmt.importClause?.isTypeOnly === true
    const clause = stmt.importClause
    if (!clause) continue
    if (clause.name) imports.push({ local: clause.name.text, module: resolvedModule, isTypeOnly: typeOnly })
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const local = el.name.text
        const imported = el.propertyName?.text ?? el.name.text
        imports.push({ local, module: resolvedModule, isTypeOnly: typeOnly || el.isTypeOnly })
      }
    }
  }
  return imports
}

function hasCanonicalModelImport(imports: ImportInfo[]): boolean {
  return imports.some(
    (i) => !i.isTypeOnly && i.local === MODEL_BINDING && i.module === CANONICAL_MODULE
  )
}

function localRedeclarations(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === MODEL_BINDING) {
      names.add(MODEL_BINDING)
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === MODEL_BINDING) names.add(MODEL_BINDING)
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === MODEL_BINDING) {
      names.add(MODEL_BINDING)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return names
}

function isDefineAgentCall(node: ts.CallExpression): boolean {
  const ex = node.expression
  return ts.isIdentifier(ex) && ex.text === DEFINE_AGENT
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

type ModelBinding = { init: ts.Expression; isLet: boolean; topLevel: boolean }

function modelBindings(sf: ts.SourceFile): Map<string, ModelBinding> {
  const map = new Map<string, ModelBinding>()
  const visit = (node: ts.Node, topLevel: boolean) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = node.parent && ts.isVariableDeclarationList(node.parent) ? node.parent : undefined
      const isLet = Boolean(list && list.flags & ts.NodeFlags.Let)
      map.set(node.name.text, { init: node.initializer, isLet, topLevel })
    }
    const nextTop = topLevel && !ts.isFunctionLike(node)
    ts.forEachChild(node, (child) => visit(child, nextTop))
  }
  visit(sf, true)
  return map
}

function exprIsCanonicalModel(
  expr: ts.Expression,
  sf: ts.SourceFile,
  imports: ImportInfo[],
  bindings: Map<string, ModelBinding>
): boolean {
  if (ts.isIdentifier(expr) && expr.text === MODEL_BINDING) {
    return hasCanonicalModelImport(imports) && !localRedeclarations(sf).has(MODEL_BINDING)
  }
  if (ts.isIdentifier(expr) && expr.text === "model") {
    const b = bindings.get("model")
    if (!b || b.isLet || !b.topLevel) return false
    return exprIsCanonicalModel(b.init, sf, imports, bindings)
  }
  return false
}

function validateModelInDefineAgent(
  obj: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  rel: string,
  imports: ImportInfo[],
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
  const bindings = modelBindings(sf)
  if (ts.isPropertyAssignment(prop)) {
    if (!exprIsCanonicalModel(prop.initializer, sf, imports, bindings)) {
      findings.push(
        `${rel}: eve model must be ${MODEL_BINDING} imported from ${CANONICAL_MODULE} (FA-F18-016)`
      )
    }
    return
  }
  if (ts.isShorthandPropertyAssignment(prop)) {
    if (!exprIsCanonicalModel(prop.name, sf, imports, bindings)) {
      findings.push(`${rel}: shorthand { model } must bind to imported ${MODEL_BINDING} (FA-F18-016)`)
    }
  }
}

function forbiddenModelUsage(
  sf: ts.SourceFile,
  rel: string,
  defineAgentArg: ts.ObjectLiteralExpression | undefined,
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
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left
      if (ts.isPropertyAccessExpression(left) && left.name.text === "model") {
        findings.push(`${rel}: assigning to .model under agent/ is not allowed (FA-F18-016)`)
      }
      if (
        ts.isElementAccessExpression(left) &&
        ts.isStringLiteral(left.argumentExpression) &&
        left.argumentExpression.text === "model"
      ) {
        findings.push(`${rel}: assigning to ["model"] under agent/ is not allowed (FA-F18-016)`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

function checkFile(abs: string, root: string, defineAgentNodes: ts.CallExpression[], findings: string[]): void {
  const rel = posixRel(abs, root)
  const text = fs.readFileSync(abs, "utf8")
  const kind = abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind)
  const imports = collectImports(sf, rel)

  for (const imp of imports) {
    if (imp.local === MODEL_BINDING && imp.module !== CANONICAL_MODULE) {
      findings.push(
        `${rel}: ${MODEL_BINDING} import resolves to ${imp.module}, not ${CANONICAL_MODULE} (FA-F18-016)`
      )
    }
  }

  let defineAgentArg: ts.ObjectLiteralExpression | undefined
  const visitDefine = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isDefineAgentCall(node)) {
      defineAgentNodes.push(node)
      if (node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        defineAgentArg = node.arguments[0]
        validateModelInDefineAgent(node.arguments[0], sf, rel, imports, findings)
      } else {
        findings.push(`${rel}: defineAgent must be called with an object literal (FA-F18-016)`)
      }
    }
    ts.forEachChild(node, visitDefine)
  }
  visitDefine(sf)
  forbiddenModelUsage(sf, rel, defineAgentArg, findings)
}

function main(): number {
  const root = path.resolve(process.argv[2] ?? process.cwd())
  const agentDir = path.join(root, "agent")
  const files = listAgentSourceFiles(agentDir)
  const findings: string[] = []
  const defineAgentCalls: ts.CallExpression[] = []

  for (const abs of files) checkFile(abs, root, defineAgentCalls, findings)

  const hasAgentEntry = fs.existsSync(path.join(agentDir, "agent.ts"))
  if (defineAgentCalls.length > 1) {
    findings.push(`agent/: more than one defineAgent call under agent/ (FA-F18-016)`)
  } else if (hasAgentEntry && defineAgentCalls.length !== 1) {
    findings.push(
      `agent/: expected exactly one defineAgent call in agent/agent.ts, found ${defineAgentCalls.length} (FA-F18-016)`
    )
  }

  if (findings.length) {
    for (const f of [...new Set(findings)].sort()) console.log(f)
    return 1
  }
  return 0
}

process.exit(main())
