/**
 * One citation reader. The draft is normalised and tokenised, then one label
 * grammar both finds citations and classifies assigned labels. see, refer, and
 * relies open a citation only for a single uppercase letter, a P, D, or R mark,
 * or an Annexure, Exhibit, Enclosure, or Mark head. A lowercase p. or pp. plus a
 * number is a page reference. A carriage return, line separator, or paragraph
 * separator is a newline. A hyphen split by a newline, including a blank line,
 * is rejoined. A single newline is a space. A blank line ends a sentence,
 * except after and, a comma, to, a hyphen, or a slash, and except after a
 * citation keyword. A vertical tab, form feed, or next-line character is a
 * newline. A heading counts only when the line, with decoration removed, is
 * exactly list or index of exhibits, annexures, or documents, in any case,
 * with markdown, a colon, a tab, or a period ignored. Its own label list is
 * outside the order check. A colon heading whose remainder contains see,
 * refer, relies, or placed is narrative, so the order check applies. A label
 * slot is the token after Annexure, Exhibit, Mark, Annex, Encl, or Doc, in
 * any case, and each later item joined by a comma, and, or, &, |, /, or a
 * hyphen. A slot token that is not in the filing set is refused. After a
 * head, a word with a trailing period followed by a label-shaped token is
 * refused. A token outside a label slot is not a citation. upon and also
 * delay a bare label the same way on does.
 * No. before a letter-dash-digits code is
 * a case number when of YYYY or /YYYY follows. AIR plus a year is a law report.
 */

export type CitationFamily = "letter" | "number" | "mark"

export type CitationHit = { form: string; canonical: string; forOrder: boolean }

export type CitationScan = {
  hits: CitationHit[]
  unparsed: string[]
}

const KEYWORD_FAMILY: Readonly<Record<string, CitationFamily>> = {
  annex: "letter",
  ann: "letter",
  annx: "letter",
  anx: "letter",
  annexe: "letter",
  annexure: "letter",
  annexures: "letter",
  enc: "number",
  encl: "number",
  encls: "number",
  enclosure: "number",
  enclosures: "number",
  ex: "mark",
  exh: "mark",
  exhibit: "mark",
  exhibits: "mark",
  mark: "mark",
  marked: "mark",
  marks: "mark",
  doc: "letter",
  docs: "letter",
}

const CITATION_OPENERS = new Set(["relies", "see", "refer", "placed"])

const GLUE_KEYWORDS = ["annexures", "annexure", "enclosures", "enclosure", "exhibits", "exhibit"]

const ADDRESS_WORDS = new Set(["block", "sector", "phase", "gali", "mohalla", "lane", "road", "street", "house"])

const NON_LABEL_WORDS = new Set([
  "to", "herewith", "the", "of", "is", "was", "per", "this", "on", "as", "viz",
  "in", "by", "from", "for", "at", "upon", "under",
])

const OPENER_HEADS = new Set(["annexure", "annexures", "exhibit", "exhibits", "enclosure", "enclosures", "mark", "marks", "doc", "docs"])

const HEAD_STOPWORDS = new Set(["on", "upon", "to", "also", "filed", "herewith", "thereto", "above", "below", "attached", "annexed", "hereto"])

const ABBREVIATIONS = new Set(["cf", "esp", "etc", "viz", "ie", "eg"])

const NO_PREFIXES = new Set(["house", "plot", "flat", "shop", "street", "gali", "suit", "appeal", "petition", "case", "c.p", "cr.misc"])

const SPELLED_NUMBERS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth",
  "hundred",
])

const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g
const WRAPPERS = /["'“”‘’«»()[\]{}]/g
const BREAK = "\u0001"

type Token = { kind: "word" | "num" | "punct" | "break"; value: string; from: number; to: number; caps?: "upper" | "lower" | "mixed" }

type Label = { family: CitationFamily; key: string }

type Item = { labels: Label[]; next: number } | { error: true }

function isIgnorable(code: number): boolean {
  if (code === 0x00ad || code === 0x061c || code === 0x180e || code === 0xfeff || code === 0x06dd || code === 0x070f) return true
  if (code >= 0x0600 && code <= 0x0605) return true
  if (code >= 0x200b && code <= 0x200f) return true
  if (code >= 0x202a && code <= 0x202e) return true
  if (code >= 0x2060 && code <= 0x2064) return true
  if (code >= 0x2066 && code <= 0x206f) return true
  if (code >= 0xfff9 && code <= 0xfffb) return true
  if (code >= 0xe0000 && code <= 0xe007f) return true
  return false
}

function letterCase(word: string): "upper" | "lower" | "mixed" {
  const letters = [...word].filter((character) => /[A-Za-z]/.test(character))
  if (letters.length === 0 || letters.every((character) => character === character.toLowerCase())) return "lower"
  if (letters.every((character) => character === character.toUpperCase())) return "upper"
  return "mixed"
}

const HEADING_LIST = /^(list|index)\s+of\s+(exhibits|annexures|documents)\b/i
const KEYWORD_COLON = /^(?:annex(?:ure)?s?|annexe|exhibits?|enclosures?|marks?)\s*:\s*$/i
const LABEL_CONTINUATION = /^\s*(?:annex(?:ure)?s?|annexe|exhibits?|enclosures?|marks?|[PDR]\s*[/-]\s*\d|[A-Za-z](?:\s*[-/]|\b))/i

function headingLine(line: string): string {
  const bare = line
    .trim()
    .replace(/[*_]+/g, " ")
    .replace(/[()[\]{}"“”‘’'«»]/g, " ")
    .replace(/^\s*\d+[.)]?\s+/, "")
    .replace(/^\s*[-–—]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
  return bare
    .replace(/^list-of-(exhibits|annexures|documents)$/i, "list of $1")
    .replace(/^index-of-(exhibits|annexures|documents)$/i, "index of $1")
}

function closeHeadingLines(input: string): string {
  const lines = input.split("\n")
  const nextContent = (start: number): string | undefined => {
    for (let index = start; index < lines.length; index += 1) {
      if (lines[index]?.trim()) return lines[index]
    }
    return undefined
  }
  return lines
    .map((line, index) => {
      const trimmed = headingLine(line)
      const following = nextContent(index + 1)
      if (!following || /[.!?]\s*$/.test(trimmed)) return line
      const list = HEADING_LIST.test(trimmed)
      const colon = KEYWORD_COLON.test(trimmed)
      if (!list && !colon) return line
      if (colon && LABEL_CONTINUATION.test(following.trim())) return line
      return `${line}.`
    })
    .join("\n")
}

function foldNewlines(input: string): string {
  const unified = input.replace(/\r\n/g, "\n").replace(/[\r\u2028\u2029]/g, "\n").replace(/[\u000b\u000c\u0085]/g, "\n")
  const rejoined = unified
    .replace(/([A-Za-z])-[ \t]*\n+[ \t]*([A-Za-z])/g, "$1$2")
    .replace(/([A-Za-z])-[ \t]*\n+[ \t]*(\d)/g, "$1-$2")
  const headed = closeHeadingLines(rejoined)
  const kept = headed.replace(
    /\b(annex(?:ure)?s?|annexe|exhibits?|enclosures?|marks?)\b[ \t]*:?[ \t]*(?:\n[ \t]*){2,}(?=[A-Za-z0-9])/gi,
    "$1 ",
  )
  const joined = kept.replace(/(\band\b|,|\bto\b|-|\/)[ \t]*(?:\n[ \t]*){2,}/gi, "$1 ")
  return joined.replace(/[ \t]*(?:\n[ \t]*){2,}/g, ". ").replace(/[ \t]*\n[ \t]*/g, " ")
}

export function normaliseCitationText(input: string): string {
  let text = ""
  for (const character of foldNewlines(input).normalize("NFKC")) {
    const code = character.codePointAt(0) ?? 0
    text += isIgnorable(code) ? BREAK : character
  }
  return text.replace(DASHES, "-").replace(WRAPPERS, " ").replace(/[ \t\f\v\u00a0]+/g, " ").trim()
}

function splitGlued(word: string): { keyword: string; rest: string } | null {
  if (word in KEYWORD_FAMILY) return null
  for (const keyword of GLUE_KEYWORDS) {
    if (!word.startsWith(keyword) || word.length === keyword.length) continue
    const rest = word.slice(keyword.length)
    if (/^[a-z]$/.test(rest) || /^\d+$/.test(rest) || /^[a-z]\d+$/.test(rest)) return { keyword, rest }
  }
  return null
}

function tokenise(text: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    const character = text[index] ?? ""
    if (character === " ") {
      index += 1
      continue
    }
    if (character === BREAK) {
      const from = index
      while (text[index] === BREAK) index += 1
      tokens.push({ kind: "break", value: BREAK, from, to: index })
      continue
    }
    if (character >= "0" && character <= "9") {
      const from = index
      while (index < text.length && (text[index] ?? "") >= "0" && (text[index] ?? "") <= "9") index += 1
      tokens.push({ kind: "num", value: text.slice(from, index), from, to: index })
      continue
    }
    if (character === "_") {
      index += 1
      continue
    }
    if ((character >= "a" && character <= "z") || (character >= "A" && character <= "Z")) {
      const from = index
      while (index < text.length) {
        const next = text[index] ?? ""
        if ((next >= "a" && next <= "z") || (next >= "A" && next <= "Z")) index += 1
        else break
      }
      const raw = text.slice(from, index)
      const caps = letterCase(raw)
      const word = raw.toLowerCase()
      const glued = splitGlued(word)
      if (!glued) {
        tokens.push({ kind: "word", value: word, from, to: index, caps })
        continue
      }
      const split = from + glued.keyword.length
      tokens.push({ kind: "word", value: glued.keyword, from, to: split, caps: letterCase(raw.slice(0, glued.keyword.length)) })
      const rest = glued.rest
      tokens.push({
        kind: /^\d+$/.test(rest) ? "num" : "word",
        value: rest,
        from: split,
        to: index,
        caps: letterCase(raw.slice(glued.keyword.length)),
      })
      continue
    }
    if (character === "\u0085") {
      tokens.push({ kind: "punct", value: character, from: index, to: index + 1 })
      index += 1
      continue
    }
    if (".,/-#:&+;|".includes(character)) {
      tokens.push({ kind: "punct", value: character, from: index, to: index + 1 })
      index += 1
      continue
    }
    if ((character.codePointAt(0) ?? 0) > 127 && /\p{L}/u.test(character)) {
      const from = index
      let raw = ""
      while (index < text.length && /\p{L}/u.test(text[index] ?? "") && (text.codePointAt(index) ?? 0) > 127) {
        raw += text[index]
        index += 1
      }
      tokens.push({ kind: "word", value: raw.toLowerCase(), from, to: index, caps: "mixed" })
      continue
    }
    index += 1
  }
  return tokens
}

function mergeKeywords(tokens: readonly Token[]): Token[] {
  const out: Token[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (!token || token.kind === "break") {
      index += 1
      continue
    }
    if (token.kind !== "word") {
      out.push(token)
      index += 1
      continue
    }
    let value = token.value
    let to = token.to
    let cursor = index + 1
    while (tokens[cursor]?.kind === "break") {
      let nextAt = cursor + 1
      while (tokens[nextAt]?.kind === "break") nextAt += 1
      const next = tokens[nextAt]
      if (next?.kind !== "word" || !(value + next.value in KEYWORD_FAMILY)) break
      value += next.value
      to = next.to
      cursor = nextAt + 1
    }
    out.push({ kind: "word", value, from: token.from, to, caps: token.caps })
    index = cursor
  }
  return out
}

function canonicalRoman(value: number): string {
  const pairs: Array<[number, string]> = [
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ]
  let rest = value
  let out = ""
  for (const [amount, glyph] of pairs) {
    while (rest >= amount) {
      out += glyph
      rest -= amount
    }
  }
  return out
}

function romanValue(word: string): number | null {
  if (word.length < 2 || !/^[ivxlcdm]+$/.test(word)) return null
  const values: Readonly<Record<string, number>> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }
  let total = 0
  for (let index = 0; index < word.length; index++) {
    const current = values[word[index] ?? ""] ?? 0
    const next = values[word[index + 1] ?? ""] ?? 0
    total += current < next ? -current : current
  }
  if (total < 1 || total > 39 || canonicalRoman(total) !== word) return null
  return total
}

function isReservedWord(word: string): boolean {
  return word in KEYWORD_FAMILY || word === "and" || word === "to" || word === "no" || word === "or" || word === "also"
}

function parseMark(tokens: readonly Token[], index: number): { key: string; prefix: string; next: number } | null {
  const head = tokens[index]
  if (!head || head.kind !== "word" || !/^[pdr]$/.test(head.value)) return null
  let cursor = index + 1
  const punct = tokens[cursor]
  if (punct?.kind === "punct" && "/.-".includes(punct.value)) {
    const after = tokens[cursor + 1]
    if (after?.kind === "num") {
      return { key: `${head.value.toUpperCase()}/${after.value}`, prefix: head.value.toUpperCase(), next: cursor + 2 }
    }
    if (after?.kind === "word" && after.value === "no") cursor += 1
    else return null
  }
  if (tokens[cursor]?.kind === "word" && tokens[cursor]?.value === "no") {
    cursor += 1
    if (tokens[cursor]?.kind === "punct" && tokens[cursor]?.value === ".") cursor += 1
  }
  const digits = tokens[cursor]
  if (!digits || digits.kind !== "num") return null
  return { key: `${head.value.toUpperCase()}/${digits.value}`, prefix: head.value.toUpperCase(), next: cursor + 1 }
}

function parseCore(tokens: readonly Token[], index: number): { label: Label; next: number } | null {
  const mark = parseMark(tokens, index)
  if (mark) {
    if (isPageReference(tokens, index, mark.next)) return null
    return { label: { family: "mark", key: mark.key }, next: mark.next }
  }
  const token = tokens[index]
  if (!token) return null
  if (token.kind === "num") return { label: { family: "number", key: token.value }, next: index + 1 }
  if (token.kind !== "word" || isReservedWord(token.value)) return null
  if (/^[a-z]$/.test(token.value)) {
    const dash = tokens[index + 1]
    const number = tokens[index + 2]
    if (
      dash?.kind === "punct" &&
      dash.value === "-" &&
      dash.from === token.to &&
      number?.kind === "num" &&
      number.from === dash.to
    ) {
      return { label: { family: "letter", key: `${token.value.toUpperCase()}-${number.value}` }, next: index + 3 }
    }
    const following = tokens[index + 1]
    if (following?.kind === "num" && following.from === token.to) {
      return { label: { family: "letter", key: `${token.value}${following.value}`.toUpperCase() }, next: index + 2 }
    }
    return { label: { family: "letter", key: token.value.toUpperCase() }, next: index + 1 }
  }
  const roman = romanValue(token.value)
  if (roman !== null) return { label: { family: "number", key: String(roman) }, next: index + 1 }
  if (/^([a-z])\1$/.test(token.value)) {
    if (token.value === "pp" && isPageReference(tokens, index, index + 3)) return null
    return { label: { family: "letter", key: token.value.toUpperCase() }, next: index + 1 }
  }
  return null
}

function parseAtom(tokens: readonly Token[], index: number): { label: Label; next: number } | null {
  let cursor = index
  if (tokens[cursor]?.kind === "punct" && tokens[cursor]?.value === "#") return parseCore(tokens, cursor + 1)
  if (tokens[cursor]?.kind === "word" && tokens[cursor]?.value === "no") {
    cursor += 1
    if (tokens[cursor]?.kind === "punct" && tokens[cursor]?.value === ".") cursor += 1
    return parseCore(tokens, cursor)
  }
  return parseCore(tokens, cursor)
}

function expandNumbers(start: string, end: string): string[] | null {
  if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) return null
  const from = Number(start)
  const to = Number(end)
  if (to < from || to - from > 25) return null
  const width = start.length === end.length ? start.length : 0
  const labels: string[] = []
  for (let value = from; value <= to; value++) {
    labels.push(width > 0 ? String(value).padStart(width, "0") : String(value))
  }
  return labels
}

function expand(left: Label, right: Label): Label[] | null {
  const leftSub = /^([A-Z])-(\d+)$/.exec(left.key)
  const rightSub = /^([A-Z])-(\d+)$/.exec(right.key)
  if (left.family === "letter" && right.family === "letter" && leftSub && rightSub && leftSub[1] === rightSub[1]) {
    const numbers = expandNumbers(leftSub[2] ?? "", rightSub[2] ?? "")
    return numbers?.map((key) => ({ family: "letter" as const, key: `${leftSub[1]}-${key}` })) ?? null
  }
  if (left.family === "letter" && right.family === "letter" && left.key.length === 1 && right.key.length === 1) {
    const from = left.key.charCodeAt(0)
    const to = right.key.charCodeAt(0)
    if (to < from || to - from > 25) return null
    const labels: Label[] = []
    for (let code = from; code <= to; code++) labels.push({ family: "letter", key: String.fromCharCode(code) })
    return labels
  }
  if (left.family === "number" && right.family === "number") {
    const numbers = expandNumbers(left.key, right.key)
    return numbers?.map((key) => ({ family: "number", key })) ?? null
  }
  if (left.family === "mark" && right.family === "number") {
    const [prefix, digits] = left.key.split("/")
    if (!prefix || digits === undefined) return null
    const numbers = expandNumbers(digits, right.key)
    return numbers?.map((key) => ({ family: "mark", key: `${prefix}/${key}` })) ?? null
  }
  if (left.family === "mark" && right.family === "mark") {
    const [leftPrefix, leftDigits] = left.key.split("/")
    const [rightPrefix, rightDigits] = right.key.split("/")
    if (!leftPrefix || leftDigits === undefined || leftPrefix !== rightPrefix || rightDigits === undefined) return null
    const numbers = expandNumbers(leftDigits, rightDigits)
    return numbers?.map((key) => ({ family: "mark", key: `${leftPrefix}/${key}` })) ?? null
  }
  return null
}

function parseItem(tokens: readonly Token[], index: number): Item | null {
  const atom = parseAtom(tokens, index)
  if (!atom) return null
  const separator = tokens[atom.next]
  const ranged =
    (separator?.kind === "word" && separator.value === "to") || (separator?.kind === "punct" && separator.value === "-")
  if (!ranged) return { labels: [atom.label], next: atom.next }
  const right = parseAtom(tokens, atom.next + 1)
  if (!right) return { labels: [atom.label], next: atom.next }
  const labels = expand(atom.label, right.label)
  if (!labels) return { error: true }
  return { labels, next: right.next }
}

function finish(item: Item | null, required: boolean): Item | null {
  if (!item) return required ? { error: true } : null
  return item
}

function readContinuation(tokens: readonly Token[], index: number): Item | null {
  const token = tokens[index]
  if (!token) return null
  if (token.kind === "punct" && token.value === ",") {
    let cursor = index + 1
    let required = false
    if (tokens[cursor]?.value === "and") {
      cursor += 1
      if (tokens[cursor]?.value === "also") {
        cursor += 1
        required = true
      }
    }
    return finish(parseItem(tokens, cursor), required)
  }
  if (token.kind === "punct" && token.value === "&") return finish(parseItem(tokens, index + 1), false)
  if (token.value === "and") {
    if (tokens[index + 1]?.value === "/" && tokens[index + 2]?.value === "or") return finish(parseItem(tokens, index + 3), true)
    if (tokens[index + 1]?.value === "also") return finish(parseItem(tokens, index + 2), true)
    return finish(parseItem(tokens, index + 1), false)
  }
  if (token.value === "or") {
    const next = tokens[index + 1]
    if (next?.kind === "word" && (next.value in KEYWORD_FAMILY || CITATION_OPENERS.has(next.value))) return null
    return finish(parseItem(tokens, index + 1), false)
  }
  if (token.value === "et" && tokens[index + 1]?.value === "seq") return { error: true }
  if (token.value === "." && tokens[index + 1]?.value === "." && tokens[index + 2]?.value === ".") return { error: true }
  if (token.value === "as" && tokens[index + 1]?.value === "well" && tokens[index + 2]?.value === "as") {
    return finish(parseItem(tokens, index + 3), true)
  }
  if (token.kind === "punct" && token.value === "+") return finish(parseItem(tokens, index + 1), true)
  if (token.kind === "punct" && token.value === ";") return finish(parseItem(tokens, index + 1), false)
  if (token.kind === "punct" && token.value === "/") return finish(parseItem(tokens, index + 1), true)
  return null
}

function leadsToLabel(tokens: readonly Token[], index: number): boolean {
  const next = tokens[index + 1]
  if (!next) return false
  if (next.kind === "num") return true
  return next.kind === "word" && (/^[a-z]$/.test(next.value) || /^[pdr]$/.test(next.value) || next.value === "no")
}

function skipLead(tokens: readonly Token[], index: number): number {
  let cursor = index
  while (tokens[cursor]?.kind === "punct" && ".:".includes(tokens[cursor]?.value ?? "") && leadsToLabel(tokens, cursor)) {
    cursor += 1
  }
  return cursor
}

function isNonLabelWord(token: Token | undefined): boolean {
  return token?.kind === "word" && NON_LABEL_WORDS.has(token.value)
}

function failedLabel(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index]
  if (!token || token.kind !== "word" || token.value.includes("_")) return false
  return SPELLED_NUMBERS.has(token.value)
}

function isCitationWord(token: Token | undefined): boolean {
  return token?.kind === "word" && (token.value in KEYWORD_FAMILY || CITATION_OPENERS.has(token.value))
}

function labelShaped(tokens: readonly Token[], index: number, skippedWord: boolean): boolean {
  const token = tokens[index]
  if (!token || token.kind !== "word" || token.value.includes("_")) return false
  if (skippedWord && (token.value === "a" || token.value === "i")) return false
  if (isPageReference(tokens, index, parseMark(tokens, index)?.next ?? index + 3)) return false
  if (SPELLED_NUMBERS.has(token.value) || failedLabel(tokens, index)) return true
  return parseAtom(tokens, index) !== null
}

function abbreviationHolds(tokens: readonly Token[], dot: number): boolean {
  const previous = tokens[dot - 1]
  const next = tokens[dot + 1]
  if (previous?.kind === "word" && ABBREVIATIONS.has(previous.value) && (next?.kind === "word" || parseMark(tokens, dot + 1) !== null)) return true
  if (previous?.kind !== "word" || previous.caps !== "lower" || previous.value === "no" || previous.value === "viz") return false
  if (next?.kind === "word" && next.caps === "lower" && next.value.length === 1) return true
  if (next?.kind === "word" && next.caps === "upper" && next.value.length >= 1 && next.value.length <= 4 && !(next.value in KEYWORD_FAMILY)) return true
  return parseMark(tokens, dot + 1) !== null
}

function sentenceEnd(tokens: readonly Token[], index: number): number {
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]
    if (token?.value !== ".") continue
    if (tokens[cursor + 1]?.value === "." || tokens[cursor - 1]?.value === "no" || tokens[cursor - 1]?.value === "viz") continue
    if (abbreviationHolds(tokens, cursor)) continue
    return cursor
  }
  return tokens.length
}

function skippedArticle(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index]
  if (token?.value !== "a" && token?.value !== "i") return false
  const next = tokens[index + 1]
  if (!next || next.value === "." || next.value === "," || next.value === "-" || next.kind === "num") return false
  if (next.kind === "word" && (next.value === "and" || next.value === "or" || next.value === "to" || next.value === "also")) return false
  return true
}

function orphanLabel(tokens: readonly Token[], from: number): boolean {
  const end = sentenceEnd(tokens, from)
  for (let cursor = from; cursor < end; cursor += 1) {
    const token = tokens[cursor]
    if (isCitationWord(token)) return false
    if (!token || token.kind !== "word" || isNonLabelWord(token) || isReservedWord(token.value)) continue
    let skipped = false
    for (let later = cursor + 1; later < end; later += 1) {
      if (isCitationWord(tokens[later]) || parseMark(tokens, later)) return false
      if (isNonLabelWord(tokens[later])) {
        skipped = true
        continue
      }
      if (labelShaped(tokens, later, skipped)) return true
    }
    return false
  }
  return false
}

function describedLabel(tokens: readonly Token[], index: number): { labels: Label[]; next: number } | null {
  if (tokens[index]?.value !== "-") return null
  const word = tokens[index + 1]
  if (!word || word.kind !== "word" || parseAtom(tokens, index + 1)) return null
  const cursor = index + 2
  const item = parseItem(tokens, cursor)
  if (item && !("error" in item)) return { labels: item.labels, next: item.next }
  return { labels: [], next: cursor }
}

function parseExpression(tokens: readonly Token[], index: number): { labels: Label[]; next: number } | null {
  let cursor = skipLead(tokens, index)
  let skippedWord = false
  while (isNonLabelWord(tokens[cursor]) || (skippedWord && skippedArticle(tokens, cursor))) {
    skippedWord = isNonLabelWord(tokens[cursor]) || skippedWord
    cursor += 1
    cursor = skipLead(tokens, cursor)
  }
  let first: Item | null
  if (tokens[cursor]?.kind === "punct" && tokens[cursor]?.value === "-") {
    const afterHyphen = parseItem(tokens, cursor + 1)
    const after = tokens[cursor + 1]
    if (afterHyphen && !("error" in afterHyphen)) first = afterHyphen
    else if (!after || after.value === "." || failedLabel(tokens, cursor + 1)) return null
    else return { labels: [], next: index }
  } else if (failedLabel(tokens, cursor)) {
    return null
  } else {
    first = parseItem(tokens, cursor)
    if (!first) {
      const continuation = readContinuation(tokens, cursor)
      if (!continuation) return orphanLabel(tokens, cursor) ? null : { labels: [], next: index }
      if ("error" in continuation) return null
      first = continuation
    } else if ("error" in first) {
      return null
    }
  }
  const labels = [...first.labels]
  cursor = first.next
  while (cursor < tokens.length) {
    const continuation = readContinuation(tokens, cursor)
    if (continuation) {
      if ("error" in continuation) return null
      labels.push(...continuation.labels)
      cursor = continuation.next
      continue
    }
    const described = describedLabel(tokens, cursor)
    if (!described) break
    labels.push(...described.labels)
    cursor = described.next
  }
  if (orphanLabel(tokens, cursor)) return null
  return { labels, next: cursor }
}

function wordsBefore(tokens: readonly Token[], index: number): string {
  let cursor = index
  if (tokens[cursor]?.value === ".") cursor -= 1
  const words: string[] = []
  while (tokens[cursor]?.kind === "word") {
    words.unshift(tokens[cursor]?.value ?? "")
    if (NO_PREFIXES.has(words.join("."))) break
    if (tokens[cursor - 1]?.value !== "." || tokens[cursor - 2]?.kind !== "word" || (tokens[cursor]?.value.length ?? 0) > 4) break
    cursor -= 2
  }
  return words.join(".")
}

function numberedPrefix(tokens: readonly Token[], index: number): boolean {
  let cursor = index - 1
  if (tokens[cursor]?.value === "." && tokens[cursor - 1]?.value === "no") cursor -= 2
  else if (tokens[cursor]?.value === "no") cursor -= 1
  else return false
  return NO_PREFIXES.has(wordsBefore(tokens, cursor))
}

function wordBeforeDash(tokens: readonly Token[], index: number): boolean {
  if (numberedPrefix(tokens, index)) return true
  const previous = tokens[index - 1]
  return previous?.kind === "word" && (ADDRESS_WORDS.has(previous.value) || previous.value === "plot" || previous.value === "form")
}

function subdivisionEnd(tokens: readonly Token[], index: number): number | null {
  const slash = tokens[index]
  const digits = tokens[index + 1]
  if (slash?.value === "/" && digits?.kind === "num" && digits.value.length !== 4) return index + 2
  return null
}

function addressTail(tokens: readonly Token[], afterMark: number): boolean {
  let cursor = afterMark
  const subdivided = subdivisionEnd(tokens, cursor)
  if (subdivided !== null) cursor = subdivided
  if (tokens[cursor]?.value === ",") cursor += 1
  if (tokens[cursor]?.value === "khayaban") return true
  const word = tokens[cursor]
  if (word?.kind !== "word" || !ADDRESS_WORDS.has(word.value)) return false
  let nextAt = cursor + 1
  if (tokens[nextAt]?.value === "no") {
    nextAt += 1
    if (tokens[nextAt]?.value === ".") nextAt += 1
  }
  const next = tokens[nextAt]
  if (next?.kind === "num") return true
  if (next?.kind === "word" && romanValue(next.value) !== null) return true
  return next?.kind === "word" && /^[a-z]$/.test(next.value) && tokens[nextAt + 1]?.value === "-" && tokens[nextAt + 2]?.kind === "num"
}

function noBefore(tokens: readonly Token[], index: number): boolean {
  const previous = tokens[index - 1]
  if (previous?.value === "no") return true
  return previous?.value === "." && tokens[index - 2]?.value === "no"
}

function ofYear(tokens: readonly Token[], index: number): boolean {
  let cursor = index
  if (tokens[cursor]?.value === ",") cursor += 1
  const year = tokens[cursor + 1]
  return tokens[cursor]?.value === "of" && year?.kind === "num" && year.value.length === 4
}

function dashCodeExempt(tokens: readonly Token[], markIndex: number, afterMark: number): boolean {
  if (tokens[markIndex + 1]?.value !== "-") return false
  if (wordBeforeDash(tokens, markIndex) || addressTail(tokens, afterMark)) return true
  return noBefore(tokens, markIndex) && (ofYear(tokens, afterMark) || caseNumberEnd(tokens, afterMark) !== null)
}

function isPageReference(tokens: readonly Token[], index: number, next: number): boolean {
  const head = tokens[index]
  const punct = tokens[index + 1]
  if (!head || head.caps === "upper" || punct?.value !== ".") return false
  if (head.value !== "p" && head.value !== "pp") return false
  if (tokens[index + 2]?.kind !== "num") return false
  return next >= index
}

function isInitial(tokens: readonly Token[], index: number): boolean {
  const dot = tokens[index + 1]
  const name = tokens[index + 2]
  return dot?.value === "." && name?.kind === "word" && name.value.length > 1
}

function lawReportShape(tokens: readonly Token[], index: number): boolean {
  const head = tokens[index]
  const following = tokens[index + 1]
  if (head?.kind === "word" && head.value === "air" && following?.kind === "num" && following.value.length === 4) return true
  const year = tokens[index]
  const report = tokens[index + 1]
  const volume = tokens[index + 1]
  const reporter = tokens[index + 2]
  if (year?.kind !== "num" || year.value.length !== 4) return false
  if (report?.kind === "word" && report.caps === "upper") return true
  return volume?.kind === "num" && reporter?.kind === "word" && reporter.caps === "upper"
}

function citationStart(tokens: readonly Token[], index: number): number {
  const next = tokens[index + 1]
  return next?.kind === "word" && OPENER_HEADS.has(next.value) ? index + 2 : index + 1
}

function headStopword(token: Token | undefined): boolean {
  return token?.kind === "word" && token.caps === "lower" && HEAD_STOPWORDS.has(token.value)
}

function labelAfterStopwords(tokens: readonly Token[], index: number): number | null {
  let cursor = index + 1
  let skipped = false
  while (headStopword(tokens[cursor])) {
    skipped = true
    cursor += 1
  }
  if (!skipped) return null
  const token = tokens[cursor]
  if (token?.kind === "word" && OPENER_HEADS.has(token.value)) return cursor
  if (token?.kind === "word" && token.caps === "upper" && token.value.length === 1 && !isInitial(tokens, cursor)) return cursor
  const mark = parseMark(tokens, cursor)
  if (mark && !isPageReference(tokens, cursor, mark.next)) return cursor
  return null
}

const COPULA = new Set(["is", "are", "was", "were"])
const PREPOSITION = new Set(["to", "of", "in", "under", "by", "from", "for", "before", "with", "into", "upon", "at", "as", "per"])
const DETERMINER = new Set(["the", "a", "an", "this", "that"])

function oneLetter(token: Token | undefined): boolean {
  return token?.kind === "word" && [...token.value].length === 1
}

function tightHyphenKey(tokens: readonly Token[], index: number): { key: string; next: number } | null {
  const word = tokens[index]
  const dash = tokens[index + 1]
  const num = tokens[index + 2]
  if (word?.kind !== "word" || word.value.length < 2) return null
  if (word.value in KEYWORD_FAMILY || HEAD_STOPWORDS.has(word.value) || COPULA.has(word.value)) return null
  if (dash?.kind !== "punct" || dash.value !== "-" || dash.from !== word.to) return null
  if (num?.kind !== "num" || num.from !== dash.to) return null
  return { key: `${word.value.toUpperCase()}-${num.value}`, next: index + 3 }
}

function shapedLabel(tokens: readonly Token[], index: number, family: CitationFamily): { label: Label; next: number } | null {
  const hyphen = tightHyphenKey(tokens, index)
  if (hyphen) return { label: { family, key: hyphen.key }, next: hyphen.next }
  const mark = parseMark(tokens, index)
  if (mark && !isPageReference(tokens, index, mark.next)) return { label: { family: "mark", key: mark.key }, next: mark.next }
  if (!oneLetter(tokens[index])) return null
  const atom = parseAtom(tokens, index)
  if (atom) return { label: atom.label, next: atom.next }
  const token = tokens[index]
  return token?.kind === "word" ? { label: { family, key: token.value.toUpperCase() }, next: index + 1 } : null
}

function wordSlot(tokens: readonly Token[], index: number, family: CitationFamily): Label | null {
  const token = tokens[index]
  if (token?.kind !== "word" || token.value.length < 2) return null
  if (HEAD_STOPWORDS.has(token.value) || COPULA.has(token.value) || PREPOSITION.has(token.value) || DETERMINER.has(token.value)) return null
  if (token.value in KEYWORD_FAMILY || CITATION_OPENERS.has(token.value) || token.value === "and" || token.value === "or" || token.value === "viz" || token.value === "then") return null
  const next = tokens[index + 1]
  if (next?.kind === "word" && (PREPOSITION.has(next.value) || HEAD_STOPWORDS.has(next.value) || DETERMINER.has(next.value))) return null
  if (token.caps !== "upper" && token.value.length > 4) return null
  const dash = tokens[index + 1]
  const num = tokens[index + 2]
  if (dash?.value === "-" && dash.from === token.to && num?.kind === "num" && num.from === dash.to) return null
  return { family, key: token.value.toUpperCase() }
}

function skipJoiner(tokens: readonly Token[], index: number, family: CitationFamily): number | null {
  const token = tokens[index]
  if (!token) return null
  let cursor = index + 1
  if (token.kind === "punct" && ",&|/".includes(token.value)) {
    if (tokens[cursor]?.value === "and" || tokens[cursor]?.value === "or") cursor += 1
  } else if (token.value === "and" || token.value === "or") {
    cursor = index + 1
  } else if (token.value === "-" && shapedLabel(tokens, index + 1, family)) {
    cursor = index + 1
  } else return null
  if (!shapedLabel(tokens, cursor, family) && !wordSlot(tokens, cursor, family)) return null
  return cursor
}

function readSlotList(tokens: readonly Token[], start: number, end: number, family: CitationFamily): Label[] {
  const labels: Label[] = []
  let cursor = start
  let words = true
  while (cursor < end) {
    const shaped = shapedLabel(tokens, cursor, family)
    if (shaped) {
      labels.push(shaped.label)
      cursor = shaped.next
    } else if (words) {
      const word = wordSlot(tokens, cursor, family)
      if (!word) break
      labels.push(word)
      cursor += 1
    } else break
    words = true
    const joined = skipJoiner(tokens, cursor, family)
    if (joined === null || joined >= end) break
    cursor = joined
  }
  return labels
}

function dottedChain(tokens: readonly Token[], index: number): { next: number; letters: number } | null {
  if (!oneLetter(tokens[index]) || tokens[index + 1]?.value !== ".") return null
  let cursor = index
  let letters = 0
  while (oneLetter(tokens[cursor]) && tokens[cursor + 1]?.value === ".") {
    letters += 1
    cursor += 2
    if (tokens[cursor]?.value === ",") cursor += 1
  }
  return { next: cursor, letters }
}

function periodSlotLabels(tokens: readonly Token[], start: number, end: number, family: CitationFamily): Label[] {
  const labels: Label[] = []
  for (let cursor = start; cursor < end; cursor += 1) {
    const chain = dottedChain(tokens, cursor)
    if (chain && chain.letters >= 2) {
      const shaped = shapedLabel(tokens, chain.next, family)
      if (shaped) labels.push(shaped.label)
      cursor = Math.max(chain.next, cursor + 1) - 1
      continue
    }
    const token = tokens[cursor]
    if (token?.kind !== "word" || oneLetter(token) || tokens[cursor + 1]?.value !== ".") continue
    let after = cursor + 2
    if (tokens[after]?.value === ",") after += 1
    const shaped = shapedLabel(tokens, after, family)
    if (!shaped) continue
    labels.push(shaped.label)
    cursor = shaped.next - 1
  }
  return labels
}

function slotEnd(tokens: readonly Token[], index: number): number {
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor]?.value !== ".") continue
    if (tokens[cursor + 1]?.value === "." || tokens[cursor - 1]?.value === "no" || tokens[cursor - 1]?.value === "viz") continue
    if (abbreviationHolds(tokens, cursor)) continue
    if (shapedLabel(tokens, cursor - 1, "letter")) return cursor
    let after = cursor + 1
    if (tokens[after]?.value === ",") after += 1
    if (shapedLabel(tokens, after, "letter") || (tokens[after]?.kind === "word" && tokens[after + 1]?.value === ".")) continue
    return cursor
  }
  return tokens.length
}

function labelsAfterHead(tokens: readonly Token[], head: number, end: number, family: CitationFamily): Label[] {
  let cursor = head + 1
  while (cursor < end && tokens[cursor]?.kind === "punct" && ",:;".includes(tokens[cursor]?.value ?? "")) cursor += 1
  const period = periodSlotLabels(tokens, head, end, family)
  if (cursor >= end || COPULA.has(tokens[cursor]?.value ?? "")) return period
  const first = tokens[cursor]
  if (first?.kind === "word" && PREPOSITION.has(first.value) && !HEAD_STOPWORDS.has(first.value)) {
    const peek = tokens[cursor + 1]
    if (!peek || peek.value === "." || COPULA.has(peek.value)) return [{ family, key: first.value.toUpperCase() }, ...period]
  }
  if (first?.kind === "word" && HEAD_STOPWORDS.has(first.value)) {
    let peek = cursor + 1
    while (peek < end && (HEAD_STOPWORDS.has(tokens[peek]?.value ?? "") || (tokens[peek]?.kind === "punct" && ",:;".includes(tokens[peek]?.value ?? "")))) peek += 1
    if (shapedLabel(tokens, peek, family)) return [...readSlotList(tokens, peek, end, family), ...period]
    if (peek === cursor + 1 && (peek >= end || tokens[peek]?.value === "." || COPULA.has(tokens[peek]?.value ?? ""))) {
      return [{ family, key: first.value.toUpperCase() }, ...period]
    }
    return [...period]
  }
  const next = tokens[cursor + 1]
  if (first?.kind === "word" && first.value.length >= 2 && !shapedLabel(tokens, cursor, family) && next?.kind === "word" && PREPOSITION.has(next.value)) {
    return period
  }
  return [...readSlotList(tokens, cursor, end, family), ...period]
}

function considerIndexWords(
  tokens: readonly Token[],
  start: number,
  end: number,
  assigned: ReadonlySet<string>,
  consider: (label: Label) => void,
): void {
  for (let cursor = start; cursor < end; cursor += 1) {
    const token = tokens[cursor]
    if (token?.kind !== "word" || token.value.length < 2) continue
    const key = token.value.toUpperCase()
    if (!assigned.has(`annex:${key}`)) continue
    consider({ family: "letter", key })
  }
}

function bareHeadProse(tokens: readonly Token[], start: number): boolean {
  const end = slotEnd(tokens, start)
  if (start >= end) return false
  let stop = false
  for (let cursor = start; cursor < end; cursor += 1) {
    const token = tokens[cursor]
    if (!token) return false
    if (token.kind === "punct" && ",;:".includes(token.value)) continue
    if (token.kind === "word" && HEAD_STOPWORDS.has(token.value)) {
      stop = true
      continue
    }
    if (token.kind === "word" && token.value.length > 1 && token.value !== "viz" && stop) continue
    return false
  }
  return stop
}

function openerStarts(tokens: readonly Token[], index: number): boolean {
  const next = tokens[index + 1]
  if (!next || lawReportShape(tokens, index + 1)) return false
  if (next.kind === "word" && OPENER_HEADS.has(next.value)) return true
  const mark = parseMark(tokens, index + 1)
  if (mark && !isPageReference(tokens, index + 1, mark.next)) return true
  if (next.kind === "word" && next.caps === "upper" && next.value.length === 1 && !isInitial(tokens, index + 1)) return true
  return labelAfterStopwords(tokens, index) !== null
}

function spelledBeforeKeyword(tokens: readonly Token[], index: number): boolean {
  let cursor = index - 1
  while (isNonLabelWord(tokens[cursor])) cursor -= 1
  return SPELLED_NUMBERS.has(tokens[cursor]?.value ?? "")
}

function tight(left: Token | undefined, right: Token | undefined): boolean {
  return !!left && !!right && left.to === right.from
}

function dottedPath(tokens: readonly Token[], index: number): boolean {
  const slash = tokens[index - 1]
  const host = tokens[index - 2]
  const dot = tokens[index - 3]
  const middle = tokens[index - 4]
  const earlierDot = tokens[index - 5]
  const prefix = tokens[index - 6]
  if (slash?.value !== "/" || host?.kind !== "word" || dot?.value !== "." || middle?.kind !== "word") return false
  if (earlierDot?.value !== "." || prefix?.kind !== "word") return false
  return tight(prefix, earlierDot) && tight(earlierDot, middle) && tight(middle, dot) && tight(dot, host) && tight(host, slash)
}

function sentenceStart(tokens: readonly Token[], index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor]?.value === "." && !leadsToLabel(tokens, cursor)) return cursor + 1
  }
  return 0
}

function headingRemainderIsList(tokens: readonly Token[], start: number): boolean {
  let words = 0
  let cursor = start
  while (cursor < tokens.length && words < 3) {
    const token = tokens[cursor]
    if (token?.value === "." && tokens[cursor - 1]?.value !== "no") return false
    if (token?.kind === "word") words += 1
    cursor += 1
  }
  if (words < 3) return false
  for (; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]
    if (!token) return false
    if (token.value === "." && tokens[cursor - 1]?.value !== "no") return true
    if (token.kind === "punct" && ",;:&-/|".includes(token.value)) continue
    if (token.kind === "word" && (token.value === "and" || token.value === "or" || token.value === "to" || token.value === "see" || token.value === "refer")) continue
    if (token.kind === "word" && token.value in KEYWORD_FAMILY) continue
    const mark = parseMark(tokens, cursor)
    if (mark && !isPageReference(tokens, cursor, mark.next)) {
      cursor = mark.next - 1
      continue
    }
    const atom = parseAtom(tokens, cursor)
    if (atom) {
      cursor = atom.next - 1
      continue
    }
    return false
  }
  return true
}

function headingRemainderNarrative(tokens: readonly Token[], start: number): boolean {
  let colonAt = -1
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor]?.value === ":") {
      colonAt = cursor
      break
    }
    if (tokens[cursor]?.value === "." && tokens[cursor - 1]?.value !== "no") break
  }
  if (colonAt < 0) return false
  const end = sentenceEnd(tokens, colonAt)
  for (let cursor = colonAt + 1; cursor < end; cursor += 1) {
    const token = tokens[cursor]
    if (token?.kind === "word" && (token.value === "see" || token.value === "refer" || token.value === "relies" || token.value === "placed")) return true
  }
  return false
}

function headingSentence(tokens: readonly Token[], index: number): boolean {
  const words: string[] = []
  const start = sentenceStart(tokens, index)
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]
    // Folding turns U+0085 into a newline before this point. A survivor keeps the sentence out of the order check.
    if (token?.value === "\u0085") return true
    if (token?.value === ":" || (token?.value === "." && tokens[cursor - 1]?.value !== "no")) break
    if (token?.kind === "word") words.push(token.value)
  }
  const listed = words[0] === "list" || words[0] === "index"
  const kind = words[2] === "exhibits" || words[2] === "annexures" || words[2] === "documents"
  if (!(listed && words[1] === "of" && kind)) return false
  if (headingRemainderNarrative(tokens, start)) return false
  return headingRemainderIsList(tokens, start)
}

function extendedMark(tokens: readonly Token[], mark: { key: string; next: number }): { key: string; next: number } | null {
  const decimal = tokens[mark.next]
  const fraction = tokens[mark.next + 1]
  if (decimal?.value === "." && fraction?.kind === "num") return { key: `${mark.key}.${fraction.value}`, next: mark.next + 2 }
  const dash = tokens[mark.next]
  const letter = tokens[mark.next + 1]
  if (dash?.value === "-" && letter?.kind === "word" && /^[a-z]$/.test(letter.value)) {
    return { key: `${mark.key}-${letter.value.toUpperCase()}`, next: mark.next + 2 }
  }
  const slash = tokens[mark.next]
  const digits = tokens[mark.next + 1]
  if (slash?.value === "/" && digits?.kind === "num" && digits.value.length !== 4) return { key: `${mark.key}/${digits.value}`, next: mark.next + 2 }
  return null
}

function caseNumberEnd(tokens: readonly Token[], index: number): number | null {
  const slash = tokens[index]
  const year = tokens[index + 1]
  if (slash?.value === "/" && year?.kind === "num" && year.value.length === 4) return index + 2
  return null
}

function markRange(tokens: readonly Token[], mark: { key: string; next: number }): Item | null {
  const separator = tokens[mark.next]
  const ranged =
    (separator?.kind === "word" && separator.value === "to") || (separator?.kind === "punct" && separator.value === "-")
  if (!ranged) return null
  const right = parseAtom(tokens, mark.next + 1)
  if (!right) return null
  const labels = expand({ family: "mark", key: mark.key }, right.label)
  if (!labels) return { error: true }
  return { labels, next: right.next }
}

function bareLetterRange(tokens: readonly Token[], index: number): { labels: Label[]; next: number } | null {
  const left = tokens[index]
  const dash = tokens[index + 1]
  const right = tokens[index + 2]
  if (!left || !dash || !right) return null
  if (left.kind !== "word" || !/^[a-z]$/.test(left.value)) return null
  if (dash.kind !== "punct" || dash.value !== "-" || dash.from !== left.to) return null
  if (right.kind !== "word" || !/^[a-z]$/.test(right.value) || right.from !== dash.to) return null
  const labels = expand(
    { family: "letter", key: left.value.toUpperCase() },
    { family: "letter", key: right.value.toUpperCase() },
  )
  if (!labels) return null
  return { labels, next: index + 3 }
}

function bareLetterSeries(tokens: readonly Token[], index: number): { labels: Label[]; next: number } | null {
  const token = tokens[index]
  if (token?.kind !== "word" || !/^[a-z]$/.test(token.value) || token.caps !== "upper") return null
  if (tokens[index + 1]?.value === "-" && tokens[index + 1]?.from === token.to) return null
  const parsed = parseExpression(tokens, index)
  if (!parsed || parsed.labels.length < 2 || parsed.labels.some((label) => label.family !== "letter")) return null
  for (let cursor = index; cursor < parsed.next; cursor += 1) {
    const letter = tokens[cursor]
    if (letter?.kind === "word" && /^[a-z]$/.test(letter.value) && letter.caps !== "upper") return null
  }
  return parsed
}

function seriesIsTheStatement(tokens: readonly Token[], index: number, next: number): boolean {
  let start = index
  while (start > 0 && tokens[start - 1]?.value !== ".") start -= 1
  let cursor = start
  if (tokens[cursor]?.value === "viz") {
    cursor += 1
    if (tokens[cursor]?.value === ".") cursor += 1
  }
  if (cursor !== index) return false
  for (let end = next; end < tokens.length; end += 1) {
    if (tokens[end]?.value === ".") return true
    return false
  }
  return true
}

function seriesOf(label: Label): string | null {
  if (label.family === "letter") return "letter"
  if (label.family === "mark") return `mark-${label.key[0] ?? ""}`
  return null
}

export function assignedCitation(token: string): { form: string; series: string | null } | null {
  const tokens = mergeKeywords(tokenise(normaliseCitationText(token)))
  if (tokens.length === 0) return null
  const atom = parseAtom(tokens, 0)
  if (atom && atom.next === tokens.length) return { form: hitOf(atom.label).form, series: seriesOf(atom.label) }
  const expression = parseExpression(tokens, isCitationWord(tokens[0]) ? 1 : 0)
  const label = expression?.labels.length === 1 ? expression.labels[0] : undefined
  if (!expression || !label || expression.next !== tokens.length) return null
  return { form: hitOf(label).form, series: seriesOf(label) }
}

function hitOf(label: Label): { form: string; canonical: string } {
  if (label.family === "mark") return { form: `mark:${label.key}`, canonical: label.key }
  if (label.family === "number") return { form: `encl:${label.key}`, canonical: label.key }
  return { form: `annex:${label.key}`, canonical: label.key }
}

export function scanCitations(
  draft: string,
  filing: { family: CitationFamily; markPrefix: string | null; assigned: ReadonlySet<string> },
): CitationScan {
  const tokens = mergeKeywords(tokenise(normaliseCitationText(draft)))
  const hits: CitationHit[] = []
  const unparsed: string[] = []
  const consider = (label: Label, keyword: CitationFamily | null, forOrder: boolean) => {
    if (keyword && keyword !== filing.family) {
      unparsed.push(`body cites ${label.key}, which is not an annexure in this filing set`)
      return
    }
    hits.push({ ...hitOf(label), forOrder })
  }
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    const opener = token?.kind === "word" && CITATION_OPENERS.has(token.value)
    const keyword = token?.kind === "word" ? KEYWORD_FAMILY[token.value] : undefined
    if (token?.kind === "word" && token.value === "pp") {
      if (isPageReference(tokens, index, index + 3)) {
        index += 3
        continue
      }
      if (tokens[index + 1]?.value === "." && tokens[index + 2]?.kind === "num") {
        consider({ family: "mark", key: `P/${tokens[index + 2]?.value ?? ""}` }, null, !headingSentence(tokens, index))
        index += 3
        continue
      }
    }
    if (opener && !keyword) {
      const delayed = labelAfterStopwords(tokens, index)
      if (delayed === null && headStopword(tokens[index + 1])) {
        const end = sentenceEnd(tokens, index)
        index = end < tokens.length ? end + 1 : tokens.length
        continue
      }
      if (!openerStarts(tokens, index)) {
        index += 1
        continue
      }
      const openedAt = delayed ?? index
      const start = delayed !== null
        ? (tokens[delayed]?.kind === "word" && OPENER_HEADS.has(tokens[delayed].value) ? delayed + 1 : delayed)
        : citationStart(tokens, index)
      const parsed = parseExpression(tokens, start)
      const headAt = delayed !== null && tokens[delayed]?.kind === "word" && OPENER_HEADS.has(tokens[delayed].value) ? delayed : openedAt + 1
      const head = tokens[headAt]
      const openedHead = head?.kind === "word" && OPENER_HEADS.has(head.value)
      const startedPastHead = !tokens[start] || !OPENER_HEADS.has(tokens[start].value)
      const prose = openedHead && startedPastHead && bareHeadProse(tokens, start)
      const openedEnd = slotEnd(tokens, index)
      const headFamily = head?.kind === "word" ? KEYWORD_FAMILY[head.value] : undefined
      const slots = headFamily ? labelsAfterHead(tokens, head?.kind === "word" && OPENER_HEADS.has(head.value) ? headAt : index, openedEnd, headFamily) : []
      const forOrder = !headingSentence(tokens, index)
      if (!parsed) {
        unparsed.push(`body cites ${token.value} without a label expression that can be read`)
        for (const label of slots) consider(label, headFamily ?? null, forOrder)
        index = openedEnd < tokens.length ? openedEnd + 1 : tokens.length
        continue
      }
      if (prose && slots.length === 0) {
        index = openedEnd < tokens.length ? openedEnd + 1 : tokens.length
        continue
      }
      if ((!parsed || parsed.labels.length === 0) && slots.length === 0) {
        unparsed.push(`body cites ${token.value} without a label expression that can be read`)
        index = openedEnd < tokens.length ? openedEnd + 1 : tokens.length
        continue
      }
      if (parsed) for (const label of parsed.labels) consider(label, null, forOrder)
      for (const label of slots) consider(label, headFamily ?? null, forOrder)
      considerIndexWords(tokens, index, openedEnd, filing.assigned, (label) => consider(label, null, forOrder))
      index = parsed && parsed.labels.length > 0 ? parsed.next : openedEnd < tokens.length ? openedEnd + 1 : tokens.length
      continue
    }
    if (token?.kind === "word" && keyword) {
      const of = tokens[index - 1]
      const listed = tokens[index - 2]
      if (of?.value === "of" && (listed?.value === "list" || listed?.value === "index")) {
        index += 1
        continue
      }
      const end = slotEnd(tokens, index)
      const slots = labelsAfterHead(tokens, index, end, keyword)
      const parsed = parseExpression(tokens, index + 1)
      const forOrder = !headingSentence(tokens, index)
      if (!parsed || (parsed.labels.length === 0 && slots.length === 0 && spelledBeforeKeyword(tokens, index))) {
        unparsed.push(`body cites ${token.value} without a label expression that can be read`)
        for (const label of slots) consider(label, keyword, forOrder)
        index += 1
        continue
      }
      if (parsed && parsed.labels.length === 0 && slots.some((label) => label.key.length > 1 && !label.key.includes("/"))) {
        unparsed.push(`body cites ${token.value} without a label expression that can be read`)
      }
      if (parsed) for (const label of parsed.labels) consider(label, keyword, forOrder)
      for (const label of slots) consider(label, keyword, forOrder)
      considerIndexWords(tokens, index + 1, end, filing.assigned, (label) => consider(label, keyword, forOrder))
      if (parsed && parsed.labels.length > 0) {
        index = parsed.next
        continue
      }
      index += 1
      continue
    }
    const mark = parseMark(tokens, index)
    if (mark) {
      if (isPageReference(tokens, index, mark.next) || dottedPath(tokens, index)) {
        index = mark.next
        continue
      }
      const yearEnd = caseNumberEnd(tokens, mark.next)
      if (yearEnd !== null) {
        index = yearEnd
        continue
      }
      const extension = extendedMark(tokens, mark)
      if (dashCodeExempt(tokens, index, mark.next)) {
        index = extension?.next ?? mark.next
        continue
      }
      const inOrder = !headingSentence(tokens, index)
      if (extension && tokens[index + 1]?.value === "-") {
        index = extension.next
        consider({ family: "mark", key: extension.key }, null, inOrder)
        continue
      }
      const ranged = markRange(tokens, mark)
      const end = ranged && !("error" in ranged) ? ranged.next : (extension?.next ?? mark.next)
      if (ranged && "error" in ranged) unparsed.push(`body cites ${mark.key} without a label expression that can be read`)
      else if (ranged) for (const label of ranged.labels) consider(label, null, inOrder)
      else consider({ family: "mark", key: extension && tokens[index + 1]?.value !== "-" ? extension.key : mark.key }, null, inOrder)
      index = end
      continue
    }
    if (filing.family === "letter") {
      const range = bareLetterRange(tokens, index)
      if (range && range.labels.every((label) => filing.assigned.has(`annex:${label.key}`))) {
        for (const label of range.labels) consider(label, null, !headingSentence(tokens, index))
        index = range.next
        continue
      }
      const series = bareLetterSeries(tokens, index)
      const assignedSeries = series?.labels.every((label) => filing.assigned.has(`annex:${label.key}`))
      if (series && (assignedSeries || seriesIsTheStatement(tokens, index, series.next))) {
        for (const label of series.labels) consider(label, null, !headingSentence(tokens, index))
        index = series.next
        continue
      }
      const lone = tokens[index]
      const loneNext = tokens[index + 1]
      const loneAfter = loneNext?.value === "." ? tokens[index + 2] : undefined
      if (
        lone?.kind === "word" &&
        lone.caps === "upper" &&
        /^[a-z]$/.test(lone.value) &&
        sentenceStart(tokens, index) === index &&
        (!loneNext || loneNext.value === ".") &&
        !loneAfter
      ) {
        consider({ family: "letter", key: lone.value.toUpperCase() }, null, !headingSentence(tokens, index))
        index += loneNext?.value === "." ? 2 : 1
        continue
      }
    }
    index += 1
  }
  return { hits, unparsed }
}
