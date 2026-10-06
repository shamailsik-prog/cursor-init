import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Static guard for routes with a declared request surface (platform/http/surface.ts).
 * (Early warning: at runtime withSession already strips undeclared headers and
 * cookies and refuses undeclared query params and body fields.)
 *
 * In those files a selector may be read only through the surface helpers
 * (getQuery, selectView, actionOf, isAction, refuseUndeclaredBody), so the
 * declared surface is the whole of what a caller can select. Anything else is
 * a violation: direct `searchParams` / `URLSearchParams` / `nextUrl` /
 * `.search` / `split("?")` query reads, header reads, `.action` member access,
 * string-keyed bracket access, destructured `action` / `view` / `command`, any
 * `switch`, a WhatsApp command literal outside the WHATSAPP_COMMANDS table, or
 * a withSession call without the route's surface.
 */

/** Removes comments (block, and line comments not inside a URL) so prose cannot trip the guard. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\w])\/\/[^\n]*/g, "$1")
}

/** The WHATSAPP_COMMANDS table itself is where command literals belong. */
function stripCommandTable(src: string): string {
  return src.replace(/export const WHATSAPP_COMMANDS = \[[\s\S]*?\] as const/, "")
}

/** Header, cookie and query reads: banned in G-2 routes and in the local modules they import. */
const READ_RULES: Array<[string, RegExp]> = [
  ["direct searchParams access (use getQuery / selectView)", /\bsearchParams\b/],
  ["URLSearchParams outside the surface helpers", /\bURLSearchParams\b/],
  ["nextUrl query access", /\bnextUrl\b/],
  ["header read (declare it in the surface; the platform reads auth headers)", /\bheaders\.get\s*\(|\.headers\b|Object\.fromEntries\([^)]*headers/],
  ["cookie read", /\bcookies\b/],
  ["next/headers (headers() / cookies())", /from\s+["']next\/headers["']/],
]

const RULES: Array<[string, RegExp]> = [
  ...READ_RULES,
  ["raw query string access", /\.search\b|split\(\s*["'`]\?/],
  [".action member access (use actionOf / isAction)", /(?<!\bevent)\.action\b/],
  ["string-keyed bracket access", /[\w\])]\s*\[\s*["'`]/],
  ["destructured selector", /\{[^{}]*\b(?:action|view|command)\b[^{}]*\}\s*=(?!=)|\(\s*\{[^{}]*\b(?:action|view|command)\b[^{}]*\}\s*[:)]/],
  ["switch statement (dispatch with isAction / selectView comparisons)", /\bswitch\s*\(/],
  ["WhatsApp command literal outside WHATSAPP_COMMANDS", /["'`]\/(?!api\/)[A-Za-z]|\/\^\\\//],
]

export function guardViolations(src: string, opts: { route: boolean }): string[] {
  const code = stripCommandTable(stripComments(src))
  const out: string[] = []
  const lines = code.split("\n")
  for (const [label, re] of RULES) {
    lines.forEach((line, i) => {
      if (re.test(line)) out.push(`${label}: line ${i + 1}: ${line.trim().slice(0, 100)}`)
    })
  }
  // Multi-line destructuring: `const {\n  action,\n} = parsed`.
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=(?!=)/g)) {
    if (m[1].includes("\n") && /\b(?:action|view|command)\b/.test(m[1])) out.push(`destructured selector: ${m[0].replace(/\s+/g, " ").slice(0, 100)}`)
  }
  if (opts.route) {
    for (const m of code.matchAll(/withSession\(([^()]*)\)/g)) {
      if (!/\bsurface\b/.test(m[1])) out.push(`withSession without the route's surface: ${m[0]}`)
    }
    if (!/from "\.\/surface"/.test(code)) out.push("route does not import its ./surface")
  }
  return out
}

/** Header, cookie and query reads in a module a G-2 route imports. */
export function helperViolations(src: string): string[] {
  const lines = stripComments(src).split("\n")
  const out: string[] = []
  for (const [label, re] of READ_RULES) {
    lines.forEach((line, i) => {
      if (re.test(line)) out.push(`${label}: line ${i + 1}: ${line.trim().slice(0, 100)}`)
    })
  }
  return out
}

/**
 * The local modules (`@/…`, `./…`) the given route files import, one level
 * deep, as repo-relative paths. platform/http/* is the surface-aware boundary
 * itself (withSession, validation, idempotency, surface, errors): it reads the
 * auth, firm, idempotency and content headers before or for the handler, so
 * it is excluded. The routes' own ./surface.ts declarations are excluded too.
 */
export function helperModulesOf(routeFiles: string[], root: string): string[] {
  const out = new Set<string>()
  for (const file of routeFiles) {
    const src = readFileSync(file, "utf8")
    for (const m of src.matchAll(/from\s+["']((?:@\/|\.\.?\/)[^"']+)["']/g)) {
      const spec = m[1]
      const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(file), spec)
      const resolved = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((p) => existsSync(p))
      if (!resolved) continue
      const rel = path.relative(root, resolved).split(path.sep).join("/")
      if (rel.startsWith("platform/http/") || rel.endsWith("/surface.ts")) continue
      out.add(rel)
    }
  }
  return [...out].sort()
}
