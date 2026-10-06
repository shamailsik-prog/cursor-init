/**
 * Static guard for routes with a declared request surface (platform/http/surface.ts).
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

const RULES: Array<[string, RegExp]> = [
  ["direct searchParams access (use getQuery / selectView)", /\bsearchParams\b/],
  ["URLSearchParams outside the surface helpers", /\bURLSearchParams\b/],
  ["nextUrl query access", /\bnextUrl\b/],
  ["raw query string access", /\.search\b|split\(\s*["'`]\?/],
  ["header read (declare it in the surface; the platform reads auth headers)", /\bheaders\.get\s*\(|\b(?:request|req)\.headers\b/],
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
