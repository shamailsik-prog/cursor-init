/**
 * Generic, category-driven folding of draft text before any citation matching (review round 2,
 * N1). Nothing here lists individual evasion characters; every rule is a Unicode property:
 *
 *   markup   HTML tags and Markdown emphasis characters (* _ ` ~) are removed; HTML character
 *            references are decoded (then folded like any other character).
 *   NFKD     compatibility decomposition (full-width, math alphanumerics, ligatures, …).
 *   drop     \p{M} (all marks), \p{Cf}, \p{Cc} except newline/tab, and
 *            \p{Default_Ignorable_Code_Point} — invisible code points vanish.
 *   digits   every \p{Nd} maps to its ASCII digit by numeric value (Nd always comes in runs
 *            of ten starting at zero, so value = offset in its run mod 10).
 *   dashes   every \p{Pd} and U+2212 MINUS SIGN map to "-".
 *   spaces   \p{Zs}, \p{Zl}, \p{Zp}, tab, U+2800 BRAILLE BLANK and the Hangul fillers map to " ".
 *   hyphen   a line-break hyphenation between letters ("SC-\nMR") is joined.
 *
 * `taint[i]` is true when something was removed immediately before folded character i. A
 * removal *between two digits* makes that number ambiguous: the gate must treat the citation
 * as UNVERIFIED rather than read a shorter or longer page (N1: "never a shorter page").
 */

export type FoldedText = { text: string; taint: boolean[] }

// Generic markup, matched on already-folded text: an HTML comment of any length (unterminated
// = to the end, as a browser hides it), any short "<…>" tag (whatever junk sits inside), any
// "&…;" character-reference-like run, numeric references without the ";" and the legacy named
// references a browser also decodes without it ("&#83CMR", "&nbspSCMR"), and Markdown emphasis.
const MARKUP =
  /<!--[\s\S]*?(?:-->|$)|<[^<>]{1,80}>|&[#A-Za-z0-9 -]{1,14};|&#[0-9]{1,7}(?![0-9])|&#[xX][0-9A-Fa-f]{1,6}(?![0-9A-Fa-f])|&(?:nbsp|amp|lt|gt|quot|shy)|[*_`~]/g

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  shy: "­",
  zwsp: "​",
  zwj: "‍",
  zwnj: "‌",
}

function decodeEntity(entity: string): string {
  const body = entity.endsWith(";") ? entity.slice(1, -1) : entity.slice(1)
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const cp = Number.parseInt(body.slice(2), 16)
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : " "
  }
  if (body.startsWith("#")) {
    const cp = Number.parseInt(body.slice(1), 10)
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : " "
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? " "
}

const RE_MARK = /\p{M}/u
const RE_DROP = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u
const RE_CC = /\p{Cc}/u
const RE_ND = /\p{Nd}/u
const RE_PD = /\p{Pd}/u
const RE_SPACE = /[\p{Zs}\p{Zl}\p{Zp}]/u
// Blank-rendering code points that separate words visually (some are default-ignorable).
const BLANKS = new Set([0x2800, 0x3164, 0x115f, 0x1160, 0xffa0, 0x0009])

const digitCache = new Map<number, string>()

/** ASCII digit for a \p{Nd} code point: its offset in its contiguous Nd run, mod 10. */
export function asciiDigit(cp: number): string {
  const cached = digitCache.get(cp)
  if (cached) return cached
  let start = cp
  while (start > 0 && RE_ND.test(String.fromCodePoint(start - 1))) start -= 1
  const digit = String((cp - start) % 10)
  digitCache.set(cp, digit)
  return digit
}

type Folding = { out: string[]; taint: boolean[]; pending: boolean }

/** Character-level folding of `segment` onto `f` (see the module comment). */
function foldChars(f: Folding, segment: string): void {
  const push = (ch: string) => {
    f.out.push(ch)
    f.taint.push(f.pending)
    f.pending = false
  }
  for (const original of segment) {
    for (const ch of original.normalize("NFKD")) {
      const cp = ch.codePointAt(0) ?? 0
      if (ch === "\n" || ch === "\r") {
        if (ch === "\n") push("\n")
        continue
      }
      if (BLANKS.has(cp) || RE_SPACE.test(ch)) {
        push(" ")
        continue
      }
      if (RE_MARK.test(ch) || RE_DROP.test(ch) || RE_CC.test(ch)) {
        f.pending = true
        continue
      }
      if (RE_ND.test(ch)) {
        push(cp < 0x80 ? ch : asciiDigit(cp))
        continue
      }
      if (cp === 0x2212 || RE_PD.test(ch)) {
        push("-")
        continue
      }
      push(ch)
    }
  }
}

/** One markup-removal pass over code-point arrays; removals taint the next character. */
function stripMarkupOnce(
  chars: string[],
  marks: boolean[]
): { out: string[]; taint: boolean[]; changed: boolean } {
  const text = chars.join("")
  // UTF-16 offset -> code point index
  const index: number[] = []
  chars.forEach((ch, i) => {
    for (let k = 0; k < ch.length; k += 1) index.push(i)
  })
  const f: Folding = { out: [], taint: [], pending: false }
  let changed = false
  let last = 0
  const copy = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) {
      if (marks[i]) f.pending = true
      f.out.push(chars[i] ?? "")
      f.taint.push(f.pending)
      f.pending = false
    }
  }
  for (const m of text.matchAll(MARKUP)) {
    const at = index[m.index ?? 0] ?? 0
    const token = m[0]
    const end = index[(m.index ?? 0) + token.length - 1] ?? at
    copy(last, at)
    changed = true
    if (marks[at]) f.pending = true
    if (token.startsWith("&")) {
      const decoded = decodeEntity(token.replace(/[\s-]/g, ""))
      if (decoded === " ") {
        f.out.push(" ")
        f.taint.push(true)
        f.pending = false
      } else {
        f.pending = true
        foldChars(f, decoded)
      }
    } else if (token.startsWith("<")) {
      // a tag becomes a space (R3 N8): never glue the text on either side together
      f.out.push(" ")
      f.taint.push(true)
      f.pending = false
    } else {
      f.pending = true
    }
    last = end + 1
  }
  copy(last, chars.length)
  return { out: f.out, taint: f.taint, changed }
}

export type FoldOptions = {
  /**
   * "strip" (default): markup is removed for matching — a tag becomes a space, an entity is
   * decoded, emphasis characters are dropped. "keep": the plain-text reading, nothing removed.
   * Review R3 N8: bodies are plain text, so the gate scans *both* and unions the findings —
   * text between a "<" and a ">" is never deleted from analysis.
   */
  markup?: "strip" | "keep"
}

export function foldDraftText(raw: string, options: FoldOptions = {}): FoldedText {
  // Phase 1: fold every character first, so invisibles, marks, odd dashes or blanks inside
  // markup cannot hide the markup itself ("<\u2E3Ab>", "&nbs\u{E0034}p;").
  const first: Folding = { out: [], taint: [], pending: false }
  foldChars(first, raw)

  // Phase 2: remove markup on the folded text, repeatedly until nothing changes (nested or
  // interleaved markup such as "<b<span…>>" or "&*nbsp;" peels off layer by layer); decoded
  // entities are folded again.
  // first.out is already one entry per code point, aligned with first.taint
  let current = { out: first.out, taint: first.taint }
  // every pass removes at least one token, so this terminates; the cap only bounds work
  for (let pass = 0; options.markup !== "keep" && pass < 64; pass += 1) {
    const next = stripMarkupOnce(current.out, current.taint)
    if (!next.changed) break
    current = next
  }
  const out = current.out
  const taint = current.taint

  // Phase 3: join a hyphenated line break between letters ("SC-\nMR" -> "SCMR").
  const text: string[] = []
  const marks: boolean[] = []
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === "-" && i > 0 && /\p{L}/u.test(out[i - 1] ?? "")) {
      let j = i + 1
      while (out[j] === " ") j += 1
      if (out[j] === "\n") {
        j += 1
        while (out[j] === " ") j += 1
        if (/\p{L}/u.test(out[j] ?? "")) {
          i = j - 1
          continue
        }
      }
    }
    const ch = out[i] ?? ""
    text.push(ch)
    marks.push(taint[i] ?? false)
    // keep taint indexed by UTF-16 offset (regex indices) for astral characters
    for (let k = 1; k < ch.length; k += 1) marks.push(false)
  }
  return { text: text.join(""), taint: marks }
}

/** True when a removed code point sat between two digits inside [start, end). */
export function digitRunTainted(folded: FoldedText, start: number, end: number): boolean {
  for (let i = Math.max(start + 1, 1); i < Math.min(end + 1, folded.text.length); i += 1) {
    if (folded.taint[i] && /[0-9]/.test(folded.text[i - 1] ?? "") && /[0-9]/.test(folded.text[i] ?? "")) {
      return true
    }
  }
  return false
}
