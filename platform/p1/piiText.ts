/**
 * Detection views for the P1 PII mask and the residual check (audit F15; spec
 * docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md, rulings 1, 3, R2-1 and R2-5).
 *
 * A view is the text detection runs on, plus, for each of its UTF-16 code units, the span [start, end) of the original
 * code point it came from. Detection never changes the text that is sent: a match in a view is mapped back to its span
 * in the original, and only that span is replaced.
 */

/** A text as detection sees it: `text`, and for each of its UTF-16 code units the original span [start, end). */
export type TextView = { text: string; start: number[]; end: number[] }

const ND = /\p{Nd}/u
/** ASCII characters, control characters included, are their own detection form: a whole text, or a run of them. */
const ASCII_ONLY = /^[\x00-\x7F]*$/
const ASCII_RUN = /[\x00-\x7F]+/y
/**
 * Dropped from the detection view (ruling R2-1): format characters (`\p{Cf}`), every default-ignorable code point
 * (combining grapheme joiner, variation selectors, Mongolian free variation selectors, Hangul fillers, Khmer inherent
 * vowels, U+2065, U+FFF0-FFF8, tags) and every combining mark (`\p{M}`: accents, the low line that underlines, the
 * keycap, harakat). None of them can carry a digit or a letter of an identifier, and each can sit between two digits.
 */
const DROPPED = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}]/u
const PD = /[\p{Pd}\u2212]/u
const ZS = /\p{Zs}/u
const MARK = /\p{M}/u
const TATWEEL = "\u0640"

/** Separators NFKC leaves alone, mapped to their ASCII role (ruling R2-5). */
const SEPARATOR: Readonly<Record<string, string>> = {
  "\u066B": ".", // ARABIC DECIMAL SEPARATOR
  "\u066C": ",", // ARABIC THOUSANDS SEPARATOR
  "\u060C": ",", // ARABIC COMMA
  "\u3002": ".", // IDEOGRAPHIC FULL STOP
}

/**
 * Arabic letters folded to the Urdu letter a name is usually recorded with (ruling 3). Ruling R2-5 adds U+06BE
 * (do-chashmi he) to heh goal: the two are distinct letters, but a name written with one for the other is the same
 * name, and folding them only adds matches. U+06D2 (yeh barree) is still not folded.
 */
const ARABIC_FOLD: Readonly<Record<string, string>> = {
  "\u064A": "\u06CC", // ARABIC LETTER YEH -> FARSI YEH (Urdu yeh)
  "\u0649": "\u06CC", // ALEF MAKSURA -> FARSI YEH
  "\u0643": "\u06A9", // ARABIC LETTER KAF -> KEHEH (Urdu kaf)
  "\u0629": "\u06C1", // TEH MARBUTA -> HEH GOAL
  "\u06C3": "\u06C1", // TEH MARBUTA GOAL -> HEH GOAL
  "\u0647": "\u06C1", // ARABIC LETTER HEH -> HEH GOAL
  "\u06D5": "\u06C1", // AE -> HEH GOAL
  "\u06BE": "\u06C1", // HEH DOACHASHMEE -> HEH GOAL
}

/**
 * Cyrillic and Greek letters that look like Latin ones, after lower-casing (ruling R2-5), so a name typed with a
 * look-alike still matches. Capitals are covered through their lower-case forms (Cyrillic capital H is lower-case
 * en, so en folds to h). Folding only adds matches.
 */
const CONFUSABLE_FOLD: Readonly<Record<string, string>> = {
  "\u0430": "a", "\u0432": "b", "\u0435": "e", "\u0451": "e", "\u0456": "i", "\u0457": "i", "\u0458": "j",
  "\u043A": "k", "\u043C": "m", "\u043D": "h", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0442": "t",
  "\u0443": "y", "\u0445": "x", "\u0455": "s", "\u0501": "d", "\u04BB": "h", "\u04CF": "l", "\u051B": "q",
  "\u051D": "w", "\u0475": "v",
  "\u03B1": "a", "\u03B2": "b", "\u03B5": "e", "\u03B7": "h", "\u03B9": "i", "\u03BA": "k", "\u03BC": "m",
  "\u03BD": "n", "\u03BF": "o", "\u03C1": "p", "\u03C4": "t", "\u03C5": "y", "\u03C7": "x", "\u03B6": "z",
  "\u03F2": "c",
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

/**
 * The number an enclosed or dingbat digit stands for (ruling R2-5): circled, parenthesised, full-stop, double-circled
 * and negative circled digits (U+2460-24FF) and the dingbat circled digits (U+2776-2793). NFKC maps some of them to
 * "(1)" or "1." and leaves the rest alone; detection wants the bare number.
 */
function enclosedNumber(cp: number): string | null {
  if (cp >= 0x2460 && cp <= 0x2473) return String(cp - 0x2460 + 1)
  if (cp >= 0x2474 && cp <= 0x2487) return String(cp - 0x2474 + 1)
  if (cp >= 0x2488 && cp <= 0x249b) return String(cp - 0x2488 + 1)
  if (cp === 0x24ea || cp === 0x24ff) return "0"
  if (cp >= 0x24eb && cp <= 0x24f4) return String(cp - 0x24eb + 11)
  if (cp >= 0x24f5 && cp <= 0x24fe) return String(cp - 0x24f5 + 1)
  if (cp >= 0x2776 && cp <= 0x277f) return String(cp - 0x2776 + 1)
  if (cp >= 0x2780 && cp <= 0x2789) return String(cp - 0x2780 + 1)
  if (cp >= 0x278a && cp <= 0x2793) return String(cp - 0x278a + 1)
  return null
}

/** The detection form of one original code point (rulings 1, R2-1, R2-5). */
function detectionForm(ch: string): string {
  if (ch.length === 1 && ch.charCodeAt(0) < 0x80) return ch
  const known = detectionMemo.get(ch)
  if (known !== undefined) return known
  if (DROPPED.test(ch)) return remember(detectionMemo, ch, "")
  const enclosed = enclosedNumber(ch.codePointAt(0)!)
  if (enclosed !== null) return remember(detectionMemo, ch, enclosed)
  let out = ""
  for (const c of ch.normalize("NFKC")) {
    if (c.length === 1 && c.charCodeAt(0) < 0x80) out += c
    else if (DROPPED.test(c)) continue
    else if (ND.test(c)) out += asciiDigit(c.codePointAt(0)!)
    else if (PD.test(c)) out += "-"
    else if (ZS.test(c)) out += " "
    else out += SEPARATOR[c] ?? c
  }
  return remember(detectionMemo, ch, out)
}

/**
 * The detection view of `original`. Per code point: a format character, a default-ignorable code point or a combining
 * mark is dropped (ruling R2-1); an enclosed or dingbat digit becomes its number (R2-5); anything else is
 * NFKC-normalised, then each character of that form maps: a decimal digit of any script to its ASCII digit, a dash
 * (`\p{Pd}`, U+2212) to "-", a space separator (`\p{Zs}`) to " ", an Arabic decimal separator or ideographic full stop
 * to ".", an Arabic thousands separator or comma to ",". Every unit keeps the span of the code point it came from; an
 * NFKC expansion gives several units the same span. Tabs and line breaks are kept.
 */
export function detectionView(original: string): TextView {
  if (ASCII_ONLY.test(original)) {
    const start = new Array<number>(original.length)
    const end = new Array<number>(original.length)
    for (let i = 0; i < original.length; i++) {
      start[i] = i
      end[i] = i + 1
    }
    return { text: original, start, end }
  }
  const parts: string[] = []
  const start: number[] = []
  const end: number[] = []
  let at = 0
  while (at < original.length) {
    // A run of ASCII characters is its own detection form, unit for unit.
    ASCII_RUN.lastIndex = at
    const run = ASCII_RUN.exec(original)
    if (run !== null) {
      for (let i = at; i < at + run[0].length; i++) {
        start.push(i)
        end.push(i + 1)
      }
      parts.push(run[0])
      at += run[0].length
      continue
    }
    const ch = String.fromCodePoint(original.codePointAt(at)!)
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

/** The folded form of one detection-view code point (rulings 3 and R2-5). */
function nameForm(c: string): string {
  if (c === ".") return ""
  if (c === "_" || c === "-") return " "
  if (c.length === 1 && c.charCodeAt(0) < 0x80) return c.toLowerCase()
  const known = nameMemo.get(c)
  if (known !== undefined) return known
  let out = ""
  for (const d of c.toLowerCase().normalize("NFD")) {
    if (MARK.test(d) || d === TATWEEL) continue
    out += ARABIC_FOLD[d] ?? CONFUSABLE_FOLD[d] ?? d
  }
  return remember(nameMemo, c, out)
}

/**
 * The name view of a detection view (rulings 3 and R2-5): lower-cased; NFD with every combining mark removed; tatweel
 * and full stops removed; underscores and hyphens read as spaces; Arabic letter variants folded to the Urdu letter;
 * Cyrillic and Greek look-alikes folded to the Latin letter. Each unit keeps the original span of the detection unit it
 * came from.
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
