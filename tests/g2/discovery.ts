import { WHATSAPP_COMMANDS } from "@/services/d2-1/whatsapp"

/**
 * Gate G-2 inventory: reads a route module's source and lists what a caller
 * can select in it, so a read cannot ship without the gate seeing it.
 *
 * - methods: `export async function GET`, `export function`, `export const` /
 *   `let GET = ...`, `export { handler as GET }`;
 * - GET selectors: `view` values (`view === "x"`, `view: "x"`, the
 *   `get("view") ?? "x"` default, `type ...View = "x" | ...`,
 *   `case "x"` under `switch (view)`), else `list`;
 * - POST selectors: `action` values (`action: z.literal("x")`,
 *   `action: z.enum([...])`, `.action === / !== "x"`, `action: "x"` type
 *   lines, `case "x"` under `switch (x.action)`); WhatsApp commands come from
 *   WHATSAPP_COMMANDS;
 * - params: every `searchParams.get("k")` / `getAll("k")` key.
 *
 * Anything it cannot read is reported in `unknown` (and fails the gate): an
 * `.action` used other than compared to a literal, passed as a value or
 * presence-checked; `action:` declared with another zod form; `searchParams`
 * read other than by a literal key; a WhatsApp command literal that is not in
 * the table.
 */

export type Discovery = { selectors: string[]; params: string[]; unknown: string[] }

const literals = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1])

/** `case "x":` labels in the block opened by the first `switch (<subject>)`. */
function switchCases(src: string, subject: RegExp): string[] {
  const out: string[] = []
  for (const m of src.matchAll(new RegExp(`switch\\s*\\(\\s*${subject.source}\\s*\\)\\s*\\{`, "g"))) {
    let depth = 0
    let i = (m.index ?? 0) + m[0].length - 1
    const start = i
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++
      else if (src[i] === "}" && --depth === 0) break
    }
    out.push(...literals(src.slice(start, i), /\bcase\s+"([\w-]+)"\s*:/g))
  }
  return out
}

export function discover(route: string, src: string, channelSources: string[] = []): Discovery {
  const selectors = new Set<string>()
  const unknown: string[] = []

  const methods = new Set([
    ...literals(src, /\bexport\s+(?:async\s+)?(?:function|const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g),
    ...[...src.matchAll(/\bexport\s*\{([^}]*)\}/g)].flatMap((m) =>
      literals(m[1], /\bas\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g).concat(literals(m[1], /(?:^|,)\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*(?=,|$)/g))
    ),
  ])

  if (methods.has("GET")) {
    const views = new Set([
      ...literals(src, /\bview\s*===\s*"([\w-]+)"/g),
      ...literals(src, /\bview:\s*"([\w-]+)"/g),
      ...literals(src, /get\("view"\)\s*\?\?\s*"([\w-]+)"/g),
      ...[...src.matchAll(/type \w*View\s*=\s*([^\n]+)/g)].flatMap((m) => literals(m[1], /"([\w-]+)"/g)),
      ...switchCases(src, /view/),
    ])
    if (views.size === 0) selectors.add(`GET ${route} list`)
    for (const v of views) selectors.add(`GET ${route} view=${v}`)
  }

  if (methods.has("POST")) {
    const actions = new Set([
      ...literals(src, /\baction:\s*z\.literal\("([\w-]+)"\)/g),
      ...[...src.matchAll(/\baction:\s*z\.enum\(\[([^\]]*)\]\)/g)].flatMap((m) => literals(m[1], /"([\w-]+)"/g)),
      ...literals(src, /\.action\s*[!=]==\s*"([\w-]+)"/g),
      ...literals(src, /^\s*action:\s*"([\w-]+)"\s*$/gm),
      ...switchCases(src, /\w+\.action/),
    ])
    for (const a of actions) {
      if (a === "whatsapp_command") for (const c of WHATSAPP_COMMANDS) selectors.add(`POST ${route} command=/${c.name}`)
      else selectors.add(`POST ${route} action=${a}`)
    }
    for (const m of src.matchAll(/\baction:\s*z\.(\w+)/g)) {
      if (m[1] !== "literal" && m[1] !== "enum") unknown.push(`action declared as z.${m[1]}`)
    }
    for (const m of src.matchAll(/(!?)\b\w+\.action\b([^\n]{0,24})/g)) {
      const [, bang, tail] = m
      const before = src.slice(Math.max(0, (m.index ?? 0) - 10), m.index)
      const understood =
        /^\s*[!=]==\s*"/.test(tail) || // compared to a literal (a selector above)
        /^\s*,/.test(tail) || // passed as a value (fingerprint, echo)
        (bang === "!" && /^\s*\)/.test(tail)) || // presence check
        /switch\s*\(\s*$/.test(before) // switch (x.action): its cases are selectors above
      if (!understood) unknown.push(`unreadable action dispatch: ${m[0].trim()}`)
    }
  }

  for (const m of methods) if (m !== "GET" && m !== "POST") selectors.add(`${m} ${route} method`)

  const params = new Set(literals(src, /searchParams\.get(?:All)?\(\s*"([\w-]+)"\s*\)/g))
  for (const m of src.matchAll(/searchParams\b(?!\.get(?:All)?\(\s*")[^\n]{0,30}/g)) unknown.push(`unreadable searchParams use: ${m[0].trim()}`)

  // WhatsApp: every command literal in the route or the channel service must be a table row.
  if ([...selectors].some((s) => s.includes(" command=/"))) {
    const names = new Set<string>(WHATSAPP_COMMANDS.map((c) => c.name))
    for (const text of [src, ...channelSources]) {
      const used = [
        ...literals(text, /startsWith\(\s*["'`]\/(\w+)/g),
        ...literals(text, /[!=]==\s*["'`]\/(\w+)/g),
        ...literals(text, /\/\^\\\/(\w+)/g),
        ...literals(text, /new RegExp\(\s*["'`]\^?\\\\?\/(\w+)/g),
      ]
      for (const c of used) if (!names.has(c)) unknown.push(`WhatsApp command /${c} is not in WHATSAPP_COMMANDS`)
    }
  }

  return { selectors: [...selectors].sort(), params: [...params].sort(), unknown }
}

/**
 * Inventory problems of one module: selectors neither tested nor reviewed
 * out of scope, params neither attacked nor reviewed, and unreadable forms.
 */
export function inventoryProblems(
  route: string,
  found: Discovery,
  listedSelectors: ReadonlySet<string>,
  attackedParams: ReadonlySet<string>,
  reviewedParams: ReadonlySet<string>
): string[] {
  return [
    ...found.unknown.map((u) => `${route}: ${u}`),
    ...found.selectors.filter((s) => !listedSelectors.has(s)).map((s) => `unlisted selector: ${s}`),
    ...found.params.filter((p) => !attackedParams.has(p) && !reviewedParams.has(p)).map((p) => `${route}: param "${p}" is neither attacked nor reviewed`),
  ]
}
