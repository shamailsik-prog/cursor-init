// Vitest 5 matches `-t` / testNamePattern against the full name joined by " > "
// (suite > nested > test). The JSON reporter's fullName is still space-joined,
// which is what the gate's expected list compares. This builds the anchored
// regex from those space-joined names and the describe() titles in the files.
import fs from "node:fs"
import ts from "typescript"

const REGEX_META = /[\][\\.*^$()+?{}|]/g

function escapeRegex(value) {
  return value.replace(REGEX_META, "\\$&")
}

function rootName(expr) {
  let current = expr
  while (current) {
    if (ts.isIdentifier(current)) return current.text
    if (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current)) {
      current = current.expression
      continue
    }
    return null
  }
  return null
}

function firstString(arg) {
  if (!arg) return null
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text
  return null
}

function primitive(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  return null
}

/** Rows of a `.each` table when every row is a primitive or a tuple of primitives. */
function eachRows(node) {
  if (!ts.isCallExpression(node.expression)) return null
  const eachCall = node.expression
  if (!ts.isPropertyAccessExpression(eachCall.expression) || eachCall.expression.name.text !== "each") return null
  const table = eachCall.arguments[0]
  if (!table || !ts.isArrayLiteralExpression(table)) return null
  const rows = []
  for (const element of table.elements) {
    if (ts.isArrayLiteralExpression(element)) {
      const row = element.elements.map(primitive)
      if (row.some((value) => value == null)) return null
      rows.push(row)
    } else {
      const value = primitive(element)
      if (value == null) return null
      rows.push([value])
    }
  }
  return rows
}

/** Vitest's printf-style `.each` title (`%s`, `%i`, `%d`, `%f`, `%j`, `%#`, `%%`). */
function expandPrintf(template, values) {
  let index = 0
  let out = ""
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== "%") {
      out += template[i]
      continue
    }
    const spec = template[++i]
    if (spec === "%") {
      out += "%"
      continue
    }
    const value = values[index++]
    if (spec === "i" || spec === "d") out += String(parseInt(String(value), 10))
    else if (spec === "f") out += String(Number(value))
    else if (spec === "j") out += JSON.stringify(value)
    else if (spec === "#") out += String(index)
    else out += String(value)
  }
  return out
}

/** @param {string[][]} suitePaths @param {Map<string, string>} exact */
export function collectFile(fileName, text, suitePaths, exact) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  function walk(node, suites) {
    if (ts.isCallExpression(node)) {
      const kind = rootName(node.expression)
      if (kind === "describe") {
        const title = firstString(node.arguments[0])
        const callback = [...node.arguments].reverse().find((arg) => ts.isFunctionLike(arg))
        if (title != null && callback) {
          const rows = eachRows(node)
          const titles = rows ? rows.map((row) => expandPrintf(title, row)) : [title]
          for (const expanded of titles) {
            const next = [...suites, expanded]
            suitePaths.push(next)
            walk(callback, next)
          }
        }
        return
      }
      if (kind === "it" || kind === "test") {
        const title = firstString(node.arguments[0])
        if (title != null) {
          const rows = eachRows(node)
          const titles = rows ? rows.map((row) => expandPrintf(title, row)) : [title]
          for (const expanded of titles) {
            const parts = [...suites, expanded]
            exact.set(parts.join(" "), parts.join(" > "))
          }
        }
        return
      }
    }
    ts.forEachChild(node, (child) => walk(child, suites))
  }
  walk(sf, [])
}

/**
 * @param {string} spaceName JSON fullName (suites and test joined by spaces)
 * @param {string[][]} suitePaths
 * @param {Map<string, string>} exact
 */
export function toArrow(spaceName, suitePaths, exact) {
  if (exact.has(spaceName)) return exact.get(spaceName)
  let best = null
  const sameLength = []
  for (const path of suitePaths) {
    const prefix = path.join(" ")
    if (!spaceName.startsWith(`${prefix} `)) continue
    const rest = spaceName.slice(prefix.length + 1)
    if (!best || path.length > best.path.length) {
      best = { path, rest }
      sameLength.length = 0
    } else if (path.length === best.path.length) {
      sameLength.push(path)
    }
  }
  if (!best) {
    throw new Error(`no suite matches vitest full name:\n${spaceName}`)
  }
  const arrow = [...best.path, best.rest].join(" > ")
  for (const path of sameLength) {
    const other = [...path, spaceName.slice(path.join(" ").length + 1)].join(" > ")
    if (other !== arrow) throw new Error(`ambiguous vitest full name:\n${spaceName}`)
  }
  return arrow
}

/** @param {string[]} files @param {string[]} spaceNames */
export function filterFor(files, spaceNames) {
  const suitePaths = []
  const exact = new Map()
  for (const file of files) {
    collectFile(file, fs.readFileSync(file, "utf8"), suitePaths, exact)
  }
  return spaceNames
    .map((name) => `^${escapeRegex(toArrow(name, suitePaths, exact))}$`)
    .join("|")
}

function readArgs(argv) {
  const files = []
  let namesFile = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") files.push(argv[++i])
    else if (argv[i] === "--names") namesFile = argv[++i]
    else if (argv[i] !== "filter") throw new Error(`unknown argument ${argv[i]}`)
  }
  if (!namesFile || files.length === 0) {
    throw new Error("usage: vitest5_name.mjs filter --names <file> --file <test> [--file <test>...]")
  }
  const spaceNames = fs.readFileSync(namesFile, "utf8").split("\n").filter((line) => line.length > 0)
  return { files, spaceNames }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { files, spaceNames } = readArgs(process.argv.slice(2))
    process.stdout.write(filterFor(files, spaceNames))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
