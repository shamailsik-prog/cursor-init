import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { OPS_POST_ACTIONS } from "@/app/api/d2/ops-reporting/dispatch"

// Static lineage check for the ops-reporting POST handlers (the behavioural coverage test
// cannot reach most lattice writes with a minimal body). For every allowlisted handler:
// - the collections it upserts through `repos.X.upsert` equal the ones it sets through
//   `store.X.set` (the in-memory and persisted copies cannot diverge), and
// - when it builds its row from a preamble lookup (`existing: current…` or `...current…`),
//   it writes back into exactly that lookup's own store collection, never another chain's.
const ROUTE = "app/api/d2/ops-reporting/route.ts"

type HandlerInfo = { actions: string[]; line: number; repos: Set<string>; stores: Set<string>; sources: Map<string, string> }

function analyse(): HandlerInfo[] {
  const text = readFileSync(ROUTE, "utf8")
  const sf = ts.createSourceFile(ROUTE, text, ts.ScriptTarget.Latest, true)
  // The exported POST is the session wrapper (`return withSession(request, handlePost)`);
  // the dispatch lives in handlePost.
  let post: ts.FunctionDeclaration | undefined
  ts.forEachChild(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "handlePost") post = n
  })
  if (!post?.body) throw new Error("handlePost not found")

  const lookupCollection = new Map<string, string>()
  for (const st of post.body.statements) {
    if (!ts.isVariableStatement(st)) continue
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.name.text.startsWith("current") || !d.initializer) continue
      const m = /\bstore\.(\w+)\.get\(/.exec(d.initializer.getText(sf))
      if (m) lookupCollection.set(d.name.text, m[1]!)
    }
  }

  const tryStmt = post.body.statements.filter(ts.isTryStatement).pop()
  if (!tryStmt) throw new Error("POST dispatch try block not found")
  const actionsOf = (e: ts.Expression): string[] => {
    if (ts.isParenthesizedExpression(e)) return actionsOf(e.expression)
    if (ts.isBinaryExpression(e)) {
      if (e.operatorToken.kind === ts.SyntaxKind.BarBarToken) return [...actionsOf(e.left), ...actionsOf(e.right)]
      if (
        e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        e.left.getText(sf) === "parsed.action" &&
        ts.isStringLiteral(e.right)
      )
        return [e.right.text]
    }
    return []
  }

  const out: HandlerInfo[] = []
  for (const st of tryStmt.tryBlock.statements) {
    if (!ts.isIfStatement(st)) continue
    const actions = actionsOf(st.expression)
    if (actions.length === 0) continue
    const info: HandlerInfo = {
      actions,
      line: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1,
      repos: new Set(),
      stores: new Set(),
      sources: new Map(),
    }
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const target = n.expression.expression
        if (ts.isPropertyAccessExpression(target)) {
          const owner = target.expression.getText(sf)
          if (owner === "repos" && n.expression.name.text === "upsert") info.repos.add(target.name.text)
          if (owner === "store" && n.expression.name.text === "set") info.stores.add(target.name.text)
        }
      }
      const source =
        ts.isPropertyAssignment(n) && n.name.getText(sf) === "existing"
          ? n.initializer
          : ts.isSpreadAssignment(n)
            ? n.expression
            : undefined
      if (source) {
        const name = source.getText(sf).replace(/!$/, "")
        const collection = lookupCollection.get(name)
        if (collection) info.sources.set(name, collection)
      }
      ts.forEachChild(n, visit)
    }
    visit(st.thenStatement)
    out.push(info)
  }
  return out
}

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…(${s.length})` : s)

describe("ops-reporting POST handlers write only their own chain's collection", () => {
  const handlers = analyse()
  const allowed = new Set<string>(OPS_POST_ACTIONS)

  it("finds a handler for every allowlisted action", () => {
    const handled = new Set(handlers.flatMap((h) => h.actions))
    expect(OPS_POST_ACTIONS.filter((a) => !handled.has(a)).map(short)).toEqual([])
  })

  it("keeps store writes, repository writes and source lookups on one collection", () => {
    const violations: string[] = []
    for (const h of handlers) {
      if (!h.actions.some((a) => allowed.has(a))) continue
      const where = `line ${h.line} ${short(h.actions[0]!)}`
      const repos = [...h.repos].sort()
      const stores = [...h.stores].sort()
      if (repos.join("|") !== stores.join("|"))
        violations.push(`${where}: repos.upsert [${repos.map(short)}] != store.set [${stores.map(short)}]`)
      const sources = [...new Set(h.sources.values())].sort()
      if (sources.length > 0 && sources.join("|") !== stores.join("|"))
        violations.push(`${where}: built from [${sources.map(short)}] but writes [${stores.map(short)}]`)
    }
    expect(violations).toEqual([])
  })
})
