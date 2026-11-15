/**
 * One citation reader. The draft is normalised and tokenised, then one label
 * grammar both finds citations and checks them. A keyword is a citation only
 * when a label follows it. A list that continues through a connector is read
 * in full, or the citation is unresolved. Bare P, D, and R marks are read on
 * every filing.
 */

export type CitationFamily = "letter" | "number" | "mark"

export type CitationHit = { form: string; canonical: string }

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
  marks: "mark",
}

const GLUE_KEYWORDS = ["annexures", "annexure", "enclosures", "enclosure", "exhibits", "exhibit"]

const ADDRESS_WORDS = new Set(["house", "plot", "sector", "street", "block", "form", "flat", "shop"])

const CONNECTOR_WORDS = new Set(["and", "or", "to", "also", "as", "well"])

const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g
const WRAPPERS = /["'“”‘’«»()[\]{}]/g
const BREAK = "\u0001"

type Token = { kind: "word" | "num" | "punct" | "break"; value: string; from: number; to: number }

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

export function normaliseCitationText(input: string): string {
  let text = ""
  for (const character of input.normalize("NFKC")) {
    const code = character.codePointAt(0) ?? 0
    text += isIgnorable(code) ? BREAK : character
  }
  return text.replace(DASHES, "-").replace(WRAPPERS, " ").replace(/[ \t\r\n\f\v\u00a0]+/g, " ").trim().toLowerCase()
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
    if (character >= "a" && character <= "z") {
      const from = index
      while (index < text.length && (text[index] ?? "") >= "a" && (text[index] ?? "") <= "z") index += 1
      const word = text.slice(from, index)
      const glued = splitGlued(word)
      if (!glued) {
        tokens.push({ kind: "word", value: word, from, to: index })
        continue
      }
      const split = from + glued.keyword.length
      tokens.push({ kind: "word", value: glued.keyword, from, to: split })
      tokens.push({
        kind: /^\d+$/.test(glued.rest) ? "num" : "word",
        value: glued.rest,
        from: split,
        to: index,
      })
      continue
    }
    if (".,/-#:&+;".includes(character)) {
      tokens.push({ kind: "punct", value: character, from: index, to: index + 1 })
      index += 1
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
    out.push({ kind: "word", value, from: token.from, to })
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
    if (punct.value === "." && after?.kind === "num" && after.from !== punct.to) return null
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
  if (mark) return { label: { family: "mark", key: mark.key }, next: mark.next }
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
  if (/^([a-z])\1$/.test(token.value)) return { label: { family: "letter", key: token.value.toUpperCase() }, next: index + 1 }
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
  if (token.value === "or") return finish(parseItem(tokens, index + 1), true)
  if (token.value === "as" && tokens[index + 1]?.value === "well" && tokens[index + 2]?.value === "as") {
    return finish(parseItem(tokens, index + 3), true)
  }
  if (token.kind === "punct" && token.value === "+") return finish(parseItem(tokens, index + 1), true)
  if (token.kind === "punct" && token.value === ";") return finish(parseItem(tokens, index + 1), false)
  if (token.kind === "punct" && token.value === "/") return finish(parseItem(tokens, index + 1), true)
  return null
}

function skipLead(tokens: readonly Token[], index: number): number {
  let cursor = index
  while (tokens[cursor]?.kind === "punct" && ".:-".includes(tokens[cursor]?.value ?? "")) cursor += 1
  return cursor
}

function parseExpression(tokens: readonly Token[], index: number): { labels: Label[]; next: number } | null {
  const first = parseItem(tokens, skipLead(tokens, index))
  if (!first) return { labels: [], next: index }
  if ("error" in first) return null
  const labels = [...first.labels]
  let cursor = first.next
  while (cursor < tokens.length) {
    const continuation = readContinuation(tokens, cursor)
    if (!continuation) break
    if ("error" in continuation) return null
    labels.push(...continuation.labels)
    cursor = continuation.next
  }
  return { labels, next: cursor }
}

function addressDirectlyPrecedes(tokens: readonly Token[], index: number): boolean {
  let cursor = index - 1
  if (tokens[cursor]?.value === "." && tokens[cursor - 1]?.value === "no") cursor -= 2
  else if (tokens[cursor]?.value === "no") cursor -= 1
  const previous = tokens[cursor]
  return previous?.kind === "word" && ADDRESS_WORDS.has(previous.value)
}

function proseFollows(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index]
  if (token?.kind === "word" && !CONNECTOR_WORDS.has(token.value)) return true
  const afterComma = tokens[index + 1]
  return token?.value === "," && afterComma?.kind === "word" && ADDRESS_WORDS.has(afterComma.value)
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

function hitOf(label: Label): CitationHit {
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
  const consider = (label: Label, keyword: CitationFamily | null) => {
    if (keyword && keyword !== filing.family) {
      unparsed.push(`body cites ${label.key}, which is not an annexure in this filing set`)
      return
    }
    hits.push(hitOf(label))
  }
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    const keyword = token?.kind === "word" ? KEYWORD_FAMILY[token.value] : undefined
    if (token?.kind === "word" && keyword) {
      const parsed = parseExpression(tokens, index + 1)
      if (!parsed) {
        unparsed.push(`body cites ${token.value} without a label expression that can be read`)
        index += 1
        continue
      }
      if (parsed.labels.length === 0) {
        index += 1
        continue
      }
      for (const label of parsed.labels) consider(label, keyword)
      index = parsed.next
      continue
    }
    const mark = parseMark(tokens, index)
    if (mark) {
      const yearEnd = caseNumberEnd(tokens, mark.next)
      if (yearEnd !== null) {
        index = yearEnd
        continue
      }
      const ranged = markRange(tokens, mark)
      const end = ranged && !("error" in ranged) ? ranged.next : mark.next
      if (!addressDirectlyPrecedes(tokens, index) && !proseFollows(tokens, mark.next)) {
        if (ranged && "error" in ranged) unparsed.push(`body cites ${mark.key} without a label expression that can be read`)
        else if (ranged) for (const label of ranged.labels) consider(label, null)
        else consider({ family: "mark", key: mark.key }, null)
      }
      index = end
      continue
    }
    if (filing.family === "letter") {
      const range = bareLetterRange(tokens, index)
      if (range && range.labels.every((label) => filing.assigned.has(`annex:${label.key}`))) {
        for (const label of range.labels) consider(label, null)
        index = range.next
        continue
      }
    }
    index += 1
  }
  return { hits, unparsed }
}
