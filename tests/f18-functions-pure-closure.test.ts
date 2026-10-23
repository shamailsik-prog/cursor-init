import fs from "node:fs"
import path from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/**
 * FA-F18-014: every FUNCTIONS_PURE_MODULES entry must not transitively import paid P1 ops
 * (functions/src/p1/{ops,transport,gateway,reconciler,evalSet} or functions/src/cli/*).
 */

const repoRoot = process.cwd()

const FUNCTIONS_PURE_MODULES = [
  "functions/src/p1/costTable",
  "functions/src/p1/types",
  "functions/src/http/f02RouterBoundary",
] as const

const FORBIDDEN_PREFIXES = [
  "functions/src/p1/ops",
  "functions/src/p1/transport",
  "functions/src/p1/gateway",
  "functions/src/p1/reconciler",
  "functions/src/p1/evalSet",
  "functions/src/cli/",
] as const

function posixRelative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/")
}

function resolveModule(fromFile: string, specifier: string): string | null {
  const spec = specifier.replace(/[?#].*$/, "")
  let candidate: string
  if (spec.startsWith("@/")) {
    candidate = path.join(repoRoot, spec.slice(2))
  } else if (spec.startsWith(".")) {
    candidate = path.resolve(path.dirname(fromFile), spec)
  } else {
    return null
  }
  const tries = [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    path.join(candidate, "index.ts"),
  ]
  for (const t of tries) {
    if (fs.existsSync(t) && fs.statSync(t).isFile()) return t
  }
  return null
}

function staticImports(file: string): string[] {
  const text = fs.readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const specs: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments
      if (arg && ts.isStringLiteral(arg)) specs.push(arg.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return specs
}

function forbiddenHit(rel: string): string | null {
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (rel === prefix || rel.startsWith(prefix)) return prefix
  }
  return null
}

function closureFrom(entryRel: string): { forbidden: string[]; visited: string[] } {
  const entry = path.join(repoRoot, `${entryRel}.ts`)
  const queue = [entry]
  const seen = new Set<string>()
  const forbidden: string[] = []
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const rel = posixRelative(file)
    const hit = forbiddenHit(rel)
    if (hit) forbidden.push(`${rel} (via ${hit})`)
    for (const spec of staticImports(file)) {
      const resolved = resolveModule(file, spec)
      if (resolved) queue.push(resolved)
    }
  }
  return { forbidden, visited: [...seen].map(posixRelative).sort() }
}

describe("audit F18: FUNCTIONS_PURE_MODULES import closure (FA-F18-014)", () => {
  it.each(FUNCTIONS_PURE_MODULES.map((m) => [m] as const))("%s has no transitive paid-P1 import", (moduleId) => {
    const { forbidden } = closureFrom(moduleId)
    expect(forbidden, forbidden.join("\n")).toEqual([])
  })
})
