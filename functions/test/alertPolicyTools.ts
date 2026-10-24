import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import ts from "typescript"

/**
 * Test tools for the log-based alert policies (audit F43 R1, spec R15 to R17). There is no `terraform` binary and no
 * HCL library in this repo, so the rendered `alerts.tf` is read with a parser for the HCL subset the renderer emits,
 * each filter is evaluated with an evaluator for the subset of the Cloud Logging query language the filters use, and
 * both refuse anything outside their subset (a parse error, not a guess). `terraform validate` is NOT DEMONSTRATED.
 */

// ---------------------------------------------------------------------------------------------------------------------
// HCL subset

export type HclValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "ref"; path: string[] }
  | { kind: "list"; items: HclValue[] }
  | { kind: "object"; entries: Array<[string, HclValue]> }
export type HclBody = { attributes: Map<string, HclValue>; blocks: HclBlock[] }
export type HclBlock = { type: string; labels: string[]; body: HclBody }

type Tok = { t: "ident" | "string" | "number" | "punct" | "nl" | "eof"; v: string; line: number }

export class HclSubsetError extends Error {}

/** Tokens of the HCL subset. A single quote, a comment, a heredoc or an interpolation is an error. */
function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  let line = 1
  const fail = (msg: string): never => {
    throw new HclSubsetError(`line ${line}: ${msg}`)
  }
  while (i < src.length) {
    const c = src[i]
    if (c === "\n") {
      toks.push({ t: "nl", v: "\n", line })
      line += 1
      i += 1
    } else if (c === " " || c === "\t" || c === "\r") {
      i += 1
    } else if (c === "'") {
      fail("single-quoted string (HCL strings are double-quoted)")
    } else if (c === "#" || (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*"))) {
      fail("comment (not in the emitted subset)")
    } else if (c === "<" && src[i + 1] === "<") {
      fail("heredoc (not in the emitted subset)")
    } else if (c === '"') {
      let out = ""
      i += 1
      for (;;) {
        if (i >= src.length) fail("unterminated string")
        const d = src[i]
        if (d === '"') {
          i += 1
          break
        }
        if (d === "\n") fail("newline in a quoted string")
        if (d === "\\") {
          const e = src[i + 1]
          const simple: Record<string, string> = { "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" }
          if (e in simple) {
            out += simple[e]
            i += 2
          } else if (e === "u" || e === "U") {
            const n = e === "u" ? 4 : 8
            const hex = src.slice(i + 2, i + 2 + n)
            if (!new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(hex)) fail(`invalid \\${e} escape`)
            out += String.fromCodePoint(parseInt(hex, 16))
            i += 2 + n
          } else {
            fail(`invalid escape \\${e ?? ""}`)
          }
          continue
        }
        if ((d === "$" || d === "%") && src[i + 1] === d && src[i + 2] === "{") {
          out += `${d}{`
          i += 3
          continue
        }
        if ((d === "$" || d === "%") && src[i + 1] === "{") fail(`template sequence ${d}{ (not in the emitted subset)`)
        out += d
        i += 1
      }
      toks.push({ t: "string", v: out, line })
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_-]/.test(src[j])) j += 1
      toks.push({ t: "ident", v: src.slice(i, j), line })
      i = j
    } else if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[0-9]/.test(src[j])) j += 1
      toks.push({ t: "number", v: src.slice(i, j), line })
      i = j
    } else if ("{}[]=,.".includes(c)) {
      toks.push({ t: "punct", v: c, line })
      i += 1
    } else {
      fail(`unexpected character ${JSON.stringify(c)}`)
    }
  }
  toks.push({ t: "eof", v: "", line })
  return toks
}

/** Parses the HCL subset the renderer emits into blocks and attributes. Throws HclSubsetError on anything else. */
export function parseHcl(src: string): HclBody {
  const toks = tokenize(src)
  let p = 0
  const peek = () => toks[p]
  const next = () => toks[p++]
  const fail = (msg: string): never => {
    throw new HclSubsetError(`line ${peek().line}: ${msg}`)
  }
  const skipNl = () => {
    while (peek().t === "nl") p += 1
  }
  const expectPunct = (v: string) => {
    const t = next()
    if (t.t !== "punct" || t.v !== v) {
      p -= 1
      fail(`expected ${v}, found ${t.t} ${JSON.stringify(t.v)}`)
    }
  }
  const endOfItem = () => {
    const t = peek()
    if (t.t === "nl") return skipNl()
    if (t.t === "eof" || (t.t === "punct" && t.v === "}")) return
    fail(`expected a newline after an item, found ${JSON.stringify(t.v)}`)
  }

  function parseExpr(): HclValue {
    const t = next()
    if (t.t === "string") return { kind: "string", value: t.v }
    if (t.t === "number") return { kind: "number", value: Number(t.v) }
    if (t.t === "ident") {
      if (t.v === "true" || t.v === "false") return { kind: "bool", value: t.v === "true" }
      const pathParts = [t.v]
      while (peek().t === "punct" && peek().v === ".") {
        p += 1
        const part = next()
        if (part.t !== "ident") fail("expected an attribute name after '.'")
        pathParts.push(part.v)
      }
      return { kind: "ref", path: pathParts }
    }
    if (t.t === "punct" && t.v === "[") {
      const items: HclValue[] = []
      skipNl()
      while (!(peek().t === "punct" && peek().v === "]")) {
        items.push(parseExpr())
        skipNl()
        if (peek().t === "punct" && peek().v === ",") {
          p += 1
          skipNl()
        } else if (!(peek().t === "punct" && peek().v === "]")) fail("expected , or ] in a list")
      }
      p += 1
      return { kind: "list", items }
    }
    if (t.t === "punct" && t.v === "{") {
      const entries: Array<[string, HclValue]> = []
      skipNl()
      while (!(peek().t === "punct" && peek().v === "}")) {
        const key = next()
        if (key.t !== "ident" && key.t !== "string") fail("expected an object key")
        expectPunct("=")
        entries.push([key.v, parseExpr()])
        if (peek().t === "punct" && peek().v === ",") p += 1
        skipNl()
      }
      p += 1
      if (new Set(entries.map(([k]) => k)).size !== entries.length) fail("duplicate object key")
      return { kind: "object", entries }
    }
    return fail(`unexpected ${t.t} ${JSON.stringify(t.v)} in an expression`)
  }

  function parseBody(nested: boolean): HclBody {
    const body: HclBody = { attributes: new Map(), blocks: [] }
    skipNl()
    for (;;) {
      const t = peek()
      if (t.t === "eof") {
        if (nested) fail("unexpected end of file inside a block")
        return body
      }
      if (t.t === "punct" && t.v === "}") {
        if (!nested) fail("unbalanced }")
        return body
      }
      const name = next()
      if (name.t !== "ident") fail(`expected an attribute or block name, found ${JSON.stringify(name.v)}`)
      if (peek().t === "punct" && peek().v === "=") {
        p += 1
        if (body.attributes.has(name.v)) fail(`duplicate attribute ${name.v}`)
        body.attributes.set(name.v, parseExpr())
        endOfItem()
        continue
      }
      const labels: string[] = []
      while (peek().t === "string") labels.push(next().v)
      expectPunct("{")
      const inner = parseBody(true)
      expectPunct("}")
      body.blocks.push({ type: name.v, labels, body: inner })
      endOfItem()
    }
  }

  return parseBody(false)
}

export const attr = (body: HclBody, name: string): HclValue | undefined => body.attributes.get(name)
export const str = (v: HclValue | undefined): string | undefined => (v?.kind === "string" ? v.value : undefined)
export const blocksOf = (body: HclBody, type: string): HclBlock[] => body.blocks.filter((b) => b.type === type)

// ---------------------------------------------------------------------------------------------------------------------
// Cloud Logging: the LogEntry a structured line becomes, and the filter subset

export type LogEntry = { resource: { type: string }; severity: string; jsonPayload?: Record<string, unknown>; textPayload?: string }

/**
 * The LogEntry that one structured stdout/stderr JSON line becomes on Cloud Run (the logging agent's special fields):
 * `severity` becomes `LogEntry.severity`; `httpRequest`, `time` and `logging.googleapis.com/*` move to their LogEntry
 * fields; every other key stays in `jsonPayload`, `message` included, unless `message` is the only key left (then it is
 * `textPayload`).
 */
export function logEntryOf(line: string, resourceType: string): LogEntry {
  const obj = JSON.parse(line) as Record<string, unknown>
  const payload: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === "severity" || k === "httpRequest" || k === "time" || k.startsWith("logging.googleapis.com/")) continue
    payload[k] = v
  }
  const entry = { resource: { type: resourceType }, severity: typeof obj.severity === "string" ? obj.severity : "DEFAULT" }
  const keys = Object.keys(payload)
  if (keys.length === 1 && keys[0] === "message") return { ...entry, textPayload: String(payload.message) }
  return { ...entry, jsonPayload: payload }
}

export class FilterSubsetError extends Error {}

type Comparison = { field: string[]; value: string }

/** Parses `field = "string" (AND field = "string")*`; anything else (OR, NOT, :, =~, parentheses, numbers) throws. */
export function parseFilter(filter: string): Comparison[] {
  const toks: Array<{ t: "path" | "eq" | "string" | "and"; v: string }> = []
  let i = 0
  while (i < filter.length) {
    const c = filter[i]
    if (c === " " || c === "\t" || c === "\n") {
      i += 1
    } else if (c === "=") {
      if (filter[i + 1] === "~") throw new FilterSubsetError("=~ is not in the evaluated subset")
      toks.push({ t: "eq", v: "=" })
      i += 1
    } else if (c === '"') {
      let out = ""
      i += 1
      for (;;) {
        if (i >= filter.length) throw new FilterSubsetError("unterminated string")
        const d = filter[i]
        if (d === '"') {
          i += 1
          break
        }
        if (d === "\\") {
          const e = filter[i + 1]
          if (e !== '"' && e !== "\\") throw new FilterSubsetError(`escape \\${e} is not in the evaluated subset`)
          out += e
          i += 2
          continue
        }
        out += d
        i += 1
      }
      toks.push({ t: "string", v: out })
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < filter.length && /[A-Za-z0-9_.]/.test(filter[j])) j += 1
      const word = filter.slice(i, j)
      toks.push(word === "AND" ? { t: "and", v: word } : { t: "path", v: word })
      i = j
    } else {
      throw new FilterSubsetError(`${JSON.stringify(c)} is not in the evaluated subset`)
    }
  }
  const out: Comparison[] = []
  for (let k = 0; k < toks.length; k += 4) {
    const [f, eq, v, and] = [toks[k], toks[k + 1], toks[k + 2], toks[k + 3]]
    if (f?.t !== "path" || eq?.t !== "eq" || v?.t !== "string") throw new FilterSubsetError("expected field = \"string\"")
    if (["OR", "NOT"].includes(f.v)) throw new FilterSubsetError(`${f.v} is not in the evaluated subset`)
    if (and !== undefined && and.t !== "and") throw new FilterSubsetError("comparisons must be joined by AND")
    if (and !== undefined && toks[k + 4] === undefined) throw new FilterSubsetError("dangling AND")
    out.push({ field: f.v.split("."), value: v.v })
  }
  if (out.length === 0) throw new FilterSubsetError("empty filter")
  return out
}

/** Cloud Logging `=` on strings: equal after NFKC normalisation, ignoring letter case. */
const fold = (s: string) => s.normalize("NFKC").toLowerCase()

/** The value of a filter path in an entry, or undefined (a missing field). */
function fieldOf(entry: LogEntry, field: string[]): unknown {
  const [head, ...rest] = field
  let cur: unknown
  if (head === "resource" && rest.length === 1 && rest[0] === "type") return entry.resource.type
  if (head === "severity" && rest.length === 0) return entry.severity
  if (head === "jsonPayload") cur = entry.jsonPayload
  else if (head === "textPayload" && rest.length === 0) return entry.textPayload
  else throw new FilterSubsetError(`field ${field.join(".")} is not in the evaluated subset`)
  for (const part of rest) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** True when `entry` satisfies `filter` (every comparison holds; a comparison on a missing field is false). */
export function matches(filter: string, entry: LogEntry): boolean {
  return parseFilter(filter).every(({ field, value }) => {
    const v = fieldOf(entry, field)
    if (v === undefined || v === null) return false
    if (typeof v !== "string") throw new FilterSubsetError(`field ${field.join(".")} is not a string`)
    return fold(v) === fold(value)
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// The real firebase-functions logger's output

type ConsoleMethods = Record<"debug" | "info" | "log" | "warn" | "error", (...a: unknown[]) => void>

/**
 * The console methods firebase-functions' logger writes through (`lib/logger/common.js` `UNPATCHED_CONSOLE`), loaded
 * from the same file the code under test loads, so it is the same module instance.
 */
function unpatchedConsole(): ConsoleMethods {
  const req = createRequire(path.resolve(__dirname, "../package.json"))
  const loggerPath = req.resolve("firebase-functions/logger")
  return (req(path.join(path.dirname(loggerPath), "common.js")) as { UNPATCHED_CONSOLE: ConsoleMethods }).UNPATCHED_CONSOLE
}

export type CapturedLine = { method: string; line: string }

/** Runs `fn` and returns every line the real logger wrote meanwhile, exactly as it would reach stdout or stderr. */
export async function captureLoggerLines(fn: () => unknown): Promise<CapturedLine[]> {
  const out: CapturedLine[] = []
  const target = unpatchedConsole()
  const saved = { ...target }
  for (const m of Object.keys(saved) as Array<keyof ConsoleMethods>) target[m] = (...a: unknown[]) => void out.push({ method: m, line: String(a[0]) })
  try {
    await fn()
  } finally {
    Object.assign(target, saved)
  }
  return out
}

/** The installed firebase-functions version (the one the code under test runs). */
export function firebaseFunctionsVersion(): string {
  const req = createRequire(path.resolve(__dirname, "../package.json"))
  const pkg = path.join(path.dirname(req.resolve("firebase-functions/logger")), "..", "..", "package.json")
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version
}

// ---------------------------------------------------------------------------------------------------------------------
// The registry walk: every ERROR emitter of a registered event, read from the TypeScript AST

export type Emitter = {
  file: string
  line: number
  event: string
  /** The value of the data's `event` property, or null when it has none (or the data is not an object literal). */
  dataEvent: string | null
  /** True when `event` is the data's last property (so no spread after it can override it). */
  eventIsLast: boolean
}

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* tsFiles(p)
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) yield p
  }
}

/** Every `X.error(<string>, <data>)` call under `srcDir` whose first argument resolves to a string. */
export function errorEmitters(srcDir: string, root: string): Emitter[] {
  const out: Emitter[] = []
  for (const file of tsFiles(srcDir)) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true)
    const consts = new Map<string, string>()
    const collect = (n: ts.Node) => {
      if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.Const) !== 0) {
        for (const d of n.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer && (ts.isStringLiteral(d.initializer) || ts.isNoSubstitutionTemplateLiteral(d.initializer))) consts.set(d.name.text, d.initializer.text)
        }
      }
      ts.forEachChild(n, collect)
    }
    collect(sf)
    const resolve = (e: ts.Expression | undefined): string | null => {
      if (!e) return null
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
      if (ts.isIdentifier(e)) return consts.get(e.text) ?? null
      return null
    }
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "error") {
        const event = resolve(n.arguments[0])
        if (event !== null) {
          const data = n.arguments[1]
          let dataEvent: string | null = null
          let eventIsLast = false
          if (data && ts.isObjectLiteralExpression(data)) {
            data.properties.forEach((prop, i) => {
              const name = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null
              if (name !== "event") return
              dataEvent = ts.isPropertyAssignment(prop) ? resolve(prop.initializer) : null
              eventIsLast = i === data.properties.length - 1
            })
          }
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart())
          out.push({ file: path.relative(root, file), line: line + 1, event, dataEvent, eventIsLast })
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return out
}
