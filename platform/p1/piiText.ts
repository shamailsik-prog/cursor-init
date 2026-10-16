/**
 * Detection views for the P1 PII mask and the residual check (audit F15; spec
 * docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md, rulings 1 and 3).
 *
 * A view is the text detection runs on, plus, for each of its UTF-16 code units, the span [start, end) of the original
 * code point it came from. Detection never changes the text that is sent: a match in a view is mapped back to its span
 * in the original, and only that span is replaced.
 */

/** A text as detection sees it: `text`, and for each of its UTF-16 code units the original span [start, end). */
export type TextView = { text: string; start: number[]; end: number[] }

const ND = /\p{Nd}/u
const CF = /\p{Cf}/u
const PD = /[\p{Pd}−]/u
const ZS = /\p{Zs}/u
const MARK = /\p{M}/u
const TATWEEL = "ـ"

/**
 * Arabic letters folded to the Urdu letter a name is usually recorded with (ruling 3). Not folded: U+06BE (do-chashmi
 * he, which marks aspiration) and U+06D2 (yeh barree): both are different letters in Urdu.
 */
const ARABIC_FOLD: Readonly<Record<string, string>> = {
  "ي": "ی", // ARABIC LETTER YEH -> FARSI YEH (Urdu yeh)
  "ى": "ی", // ALEF MAKSURA -> FARSI YEH
  "ك": "ک", // ARABIC LETTER KAF -> KEHEH (Urdu kaf)
  "ة": "ہ", // TEH MARBUTA -> HEH GOAL
  "ۃ": "ہ", // TEH MARBUTA GOAL -> HEH GOAL
  "ه": "ہ", // ARABIC LETTER HEH -> HEH GOAL
  "ە": "ہ", // AE -> HEH GOAL
}

/** Bounded memo tables: their keys are code points, so a bound keeps a long-lived instance's memory flat. */
const MEMO_LIMIT = 8192
const digitMemo = new Map<number, string>()
const detectionMemo = new Map<string, string>()
const nameMemo = new Map<string, string>()

function remember(memo: Map<string, string>, key: string, value: string): string {
  if (memo.size >= MEMO_LIMIT) memo.clear()
  memo.set(key, value)
  return value
}

/**
 * The ASCII digit of a `\p{Nd}` code point. Unicode assigns decimal digits only in contiguous ascending runs 0 to 9
 * (stability policy for Numeric_Type=Decimal), so the value is the offset from the start of the maximal `\p{Nd}` run,
 * modulo 10. Runs longer than ten (the mathematical digits) are whole sets of ten.
 */
function asciiDigit(cp: number): string {
  const known = digitMemo.get(cp)
  if (known !== undefined) return known
  let zero = cp
  while (zero > 0 && ND.test(String.fromCodePoint(zero - 1))) zero -= 1
  const digit = String((cp - zero) % 10)
  if (digitMemo.size >= MEMO_LIMIT) digitMemo.clear()
  digitMemo.set(cp, digit)
  return digit
}

/** The detection form of one original code point (ruling 1). */
function detectionForm(ch: string): string {
  if (ch.length === 1 && ch.charCodeAt(0) < 0x80) return ch
  const known = detectionMemo.get(ch)
  if (known !== undefined) return known
  if (CF.test(ch)) return remember(detectionMemo, ch, "")
  let out = ""
  for (const c of ch.normalize("NFKC")) {
    if (c.length === 1 && c.charCodeAt(0) < 0x80) out += c
    else if (ND.test(c)) out += asciiDigit(c.codePointAt(0)!)
    else if (PD.test(c)) out += "-"
    else if (ZS.test(c)) out += " "
    else if (!CF.test(c)) out += c
  }
  return remember(detectionMemo, ch, out)
}

/**
 * The detection view of `original` (ruling 1). Per code point: a format character (`\p{Cf}`: zero-width space and
 * joiners, directional marks and controls, soft hyphen, BOM, Arabic letter mark) is dropped; anything else is
 * NFKC-normalised, then each character of that form maps: a decimal digit of any script to its ASCII digit, a dash
 * (`\p{Pd}`, U+2212) to "-", a space separator (`\p{Zs}`) to " ". Every unit keeps the span of the code point it came
 * from; an NFKC expansion gives several units the same span. Tabs and line breaks are kept.
 */
export function detectionView(original: string): TextView {
  const parts: string[] = []
  const start: number[] = []
  const end: number[] = []
  let at = 0
  for (const ch of original) {
    const form = detectionForm(ch)
    const next = at + ch.length
    for (let k = 0; k < form.length; k++) {
      start.push(at)
      end.push(next)
    }
    parts.push(form)
    at = next
  }
  return { text: parts.join(""), start, end }
}

/** The folded form of one detection-view code point (ruling 3). */
function nameForm(c: string): string {
  if (c.length === 1 && c.charCodeAt(0) < 0x80) return c.toLowerCase()
  const known = nameMemo.get(c)
  if (known !== undefined) return known
  let out = ""
  for (const d of c.toLowerCase().normalize("NFD")) {
    if (MARK.test(d) || d === TATWEEL) continue
    out += ARABIC_FOLD[d] ?? d
  }
  return remember(nameMemo, c, out)
}

/**
 * The name view of a detection view (ruling 3): lower-cased; NFD with every combining mark removed (Latin diacritics,
 * Arabic harakat, superscript alef, and the hamza and madda that NFD splits off); tatweel removed; Arabic letter
 * variants folded to the Urdu letter. Each unit keeps the original span of the detection unit it came from.
 */
export function nameView(view: TextView): TextView {
  const parts: string[] = []
  const start: number[] = []
  const end: number[] = []
  let j = 0
  for (const c of view.text) {
    const form = nameForm(c)
    for (let k = 0; k < form.length; k++) {
      start.push(view.start[j]!)
      end.push(view.end[j]!)
    }
    parts.push(form)
    j += c.length
  }
  return { text: parts.join(""), start, end }
}

/** A name as the mask matches it: the name view of its detection view, whitespace runs collapsed, trimmed. */
export function foldName(name: string): string {
  return nameView(detectionView(name)).text.replace(/\s+/g, " ").trim()
}
