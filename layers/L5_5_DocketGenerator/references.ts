/**
 * One citation reader. The draft is normalised, then tokenised, then a small
 * expression grammar reads the labels after each reference keyword. A keyword
 * whose following expression cannot be read is unresolved. Bare P/D/R marks
 * are read only for the filing's own mark prefix, and not after an address
 * or form word.
 */

export type CitationFamily = "letter" | "number" | "mark"

export type CitationHit = { form: string; canonical: string }

export type CitationScan = {
  hits: CitationHit[]
  unparsed: string[]
}

const KEYWORD_FAMILY: Readonly<Record<string, CitationFamily>> = {
  annex: "letter",
  annexure: "letter",
  annexures: "letter",
  enclosure: "number",
  enclosures: "number",
  encl: "number",
  encls: "number",
  exhibit: "mark",
  exhibits: "mark",
  ex: "mark",
  mark: "mark",
  marks: "mark",
}

const ADDRESS_WORDS = new Set(["house", "plot", "sector", "street", "block", "form", "flat", "shop"])

const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g
const WRAPPERS = /["'“”‘’«»()[\]{}]/g

type Token = { kind: "word" | "num" | "punct"; value: string; from: number; to: number }

type Label = { family: CitationFamily; key: string }

type Item = { labels: Label[]; next: number } | { error: true }

function isFormat(code: number): boolean {
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
  let stripped = ""
  for (const character of input.normalize("NFKC")) {
    const code = character.codePointAt(0) ?? 0
    if (isFormat(code)) continue
    stripped += character
  }
  return stripped.replace(DASHES, "-").replace(WRAPPERS, " ").replace(/\s+/g, " ").trim().toLowerCase()
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
    if (character >= "0" && character <= "9") {
      const from = index
      while (index < text.length && (text[index] ?? "") >= "0" && (text[index] ?? "") <= "9") index += 1
      tokens.push({ kind: "num", value: text.slice(from, index), from, to: index })
      continue
    }
    if (character >= "a" && character <= "z") {
      const from = index
      while (index < text.length && (text[index] ?? "") >= "a" && (text[index] ?? "") <= "z") index += 1
      tokens.push({ kind: "word", value: text.slice(from, index), from, to: index })
      continue
    }
    if (".,/-#:&".includes(character)) {
      tokens.push({ kind: "punct", value: character, from: index, to: index + 1 })
      index += 1
      continue
    }
    index += 1
  }
  return tokens
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
  return word in KEYWORD_FAMILY || word === "and" || word === "to" || word === "no"
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
    if (after?.kind === "word" && after.value === "no") cursor = cursor + 1
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
  const following = tokens[index + 1]
  if (/^[a-z]$/.test(token.value) && following?.kind === "num" && following.from === token.to) {
    return { label: { family: "letter", key: `${token.value}${following.value}`.toUpperCase() }, next: index + 2 }
  }
  const roman = romanValue(token.value)
  if (roman !== null) return { label: { family: "number", key: String(roman) }, next: index + 1 }
  if (/^[a-z]$/.test(token.value) || /^[a-z]{2}$/.test(token.value)) {
    return { label: { family: "letter", key: token.value.toUpperCase() }, next: index + 1 }
  }
  return null
}

function parseAtom(tokens: readonly Token[], index: number): { label: Label; next: number } | null {
  let cursor = index
  if (tokens[cursor]?.kind === "punct" && tokens[cursor]?.value === "#") {
    cursor += 1
    return parseCore(tokens, cursor)
  }
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

function separatorEnd(tokens: readonly Token[], index: number): number | null {
  const token = tokens[index]
  if (token?.kind === "punct" && (token.value === "," || token.value === "&")) {
    const next = tokens[index + 1]
    return next?.kind === "word" && next.value === "and" ? index + 2 : index + 1
  }
  if (token?.kind === "word" && token.value === "and") return index + 1
  return null
}

function skipLead(tokens: readonly Token[], index: number): number {
  let cursor = index
  while (tokens[cursor]?.kind === "punct" && ".:-".includes(tokens[cursor]?.value ?? "")) cursor += 1
  return cursor
}

function parseExpression(tokens: readonly Token[], index: number): { labels: Label[]; next: number } | null {
  const first = parseItem(tokens, skipLead(tokens, index))
  if (!first || "error" in first) return null
  const labels = [...first.labels]
  let cursor = first.next
  while (cursor < tokens.length) {
    const next = separatorEnd(tokens, cursor)
    if (next === null) break
    const item = parseItem(tokens, next)
    if (!item) break
    if ("error" in item) return null
    labels.push(...item.labels)
    cursor = item.next
  }
  return { labels, next: cursor }
}

function addressContext(tokens: readonly Token[], index: number): boolean {
  let cursor = index - 1
  while (cursor >= 0) {
    const token = tokens[cursor]
    if (!token) return false
    if (token.kind === "punct" || (token.kind === "word" && token.value === "no")) {
      cursor -= 1
      continue
    }
    return token.kind === "word" && ADDRESS_WORDS.has(token.value)
  }
  return false
}

function markRange(
  tokens: readonly Token[],
  mark: { key: string; next: number },
): { labels: Label[]; next: number } | { error: true } | null {
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
  const tokens = tokenise(normaliseCitationText(draft))
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
      for (const label of parsed.labels) consider(label, keyword)
      index = parsed.next
      continue
    }
    if (filing.family === "mark" && filing.markPrefix) {
      const mark = parseMark(tokens, index)
      if (mark && mark.prefix === filing.markPrefix) {
        const ranged = markRange(tokens, mark)
        if (!addressContext(tokens, index)) {
          if (ranged && "error" in ranged) {
            unparsed.push(`body cites ${mark.key} without a label expression that can be read`)
          } else if (ranged) {
            for (const label of ranged.labels) consider(label, null)
          } else {
            consider({ family: "mark", key: mark.key }, null)
          }
        }
        index = ranged && !("error" in ranged) ? ranged.next : mark.next
        continue
      }
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
