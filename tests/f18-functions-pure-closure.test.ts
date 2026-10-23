import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/**
 * FA-F18-014 / FA-F18-017 / FA-F18-018: every FUNCTIONS_PURE_MODULES entry must not
 * transitively import paid P1 ops; the list matches the gate; unresolved specifiers fail.
 */

const repoRoot = process.cwd()
const GATE = "ci_gates/check_next_ai_egress.py"

const FORBIDDEN_PREFIXES = [
  "functions/src/p1/ops",
  "functions/src/p1/transport",
  "functions/src/p1/gateway",
  "functions/src/p1/reconciler",
  "functions/src/p1/evalSet",
  "functions/src/cli/",
] as const

function gatePureModules(): readonly string[] {
  const res = spawnSync("python3", [GATE, "--print-pure-modules"], { cwd: repoRoot, encoding: "utf8" })
  expect(res.status, res.stderr || res.stdout).toBe(0)
  return JSON.parse(res.stdout) as string[]
}

function posixRelative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/")
}

function resolveModule(fromFile: string, specifier: string): string {
  const spec = specifier.replace(/[?#].*$/, "")
  let candidate: string
  if (spec.startsWith("@/")) {
    candidate = path.join(repoRoot, spec.slice(2))
  } else if (spec.startsWith(".")) {
    candidate = path.resolve(path.dirname(fromFile), spec)
  } else if (spec.startsWith("functions/")) {
    candidate = path.join(repoRoot, spec)
  } else {
    throw new Error(`unresolved bare or package specifier ${spec} in ${posixRelative(fromFile)}`)
  }
  const tries = [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.js`,
    path.join(candidate, "index.ts"),
  ]
  for (const t of tries) {
    if (fs.existsSync(t) && fs.statSync(t).isFile()) return t
  }
  throw new Error(`cannot resolve ${spec} from ${posixRelative(fromFile)}`)
}

function staticImports(file: string): string[] {
  const text = fs.readFileSync(file, "utf8")
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
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
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const [arg] = node.arguments
      if (arg && ts.isStringLiteral(arg)) specs.push(arg.text)
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression
      if (expr && ts.isStringLiteral(expr)) specs.push(expr.text)
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
      queue.push(resolveModule(file, spec))
    }
  }
  return { forbidden, visited: [...seen].map(posixRelative).sort() }
}

describe("audit F18: FUNCTIONS_PURE_MODULES import closure (FA-F18-014)", () => {
  const FUNCTIONS_PURE_MODULES = gatePureModules()

  it("matches the gate FUNCTIONS_PURE_MODULES list (FA-F18-017)", () => {
    expect([...FUNCTIONS_PURE_MODULES].sort()).toEqual(
      [
        "functions/src/http/f02RouterBoundary",
        "functions/src/p1/costTable",
        "functions/src/p1/types",
      ].sort()
    )
  })

  it("f02RouterBoundary closure visits routerRuntime and f02NextAuthority (FA-F18-018)", () => {
    const { visited } = closureFrom("functions/src/http/f02RouterBoundary")
    expect(visited).toContain("functions/src/http/routerRuntime.ts")
    expect(visited).toContain("functions/src/http/f02NextAuthority.ts")
  })

  it.each(FUNCTIONS_PURE_MODULES.map((m) => [m] as const))("%s has no transitive paid-P1 import", (moduleId) => {
    const { forbidden } = closureFrom(moduleId)
    expect(forbidden, forbidden.join("\n")).toEqual([])
  })
})
