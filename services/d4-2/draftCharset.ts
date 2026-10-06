/**
 * Draft character-set refusal layer (review round 3 design ruling).
 *
 * Recognising every disguise does not converge, and the citation gate is a safety control, so a
 * draft body containing characters that can disguise text is *refused*, not interpreted. Runs
 * before compose, preflight, package creation and approval; a refusal is 422
 * `unsupported_characters` listing each offending code point, its position and category.
 *
 * Refused:
 *   - bidi embedding / override / isolate controls (LRE RLE PDF LRO RLO LRI RLI FSI PDI);
 *   - tag characters; variation selectors (incl. Mongolian free variation selectors);
 *   - \p{Cf} and default-ignorable code points — except ZWNJ/ZWJ between two Arabic-script
 *     letters (Urdu orthography);
 *   - \p{Cc} other than \n, \t (and \r only as part of \r\n);
 *   - line / paragraph separators; private-use, surrogate and unassigned code points;
 *   - any script other than Latin, Arabic (Urdu), Common and Inherited;
 *   - a whitespace token mixing Latin and non-Latin letters;
 *   - a Latin-letter token whose UTS #39 confusable skeleton differs from its folded form
 *     (data/confusables-ascii-subset.json, generated from Unicode confusables.txt by
 *     scripts/generate-confusables-subset.py), or that contains a non-orthographic Latin letter
 *     (small capitals, IPA letters, clicks — Latin letters that neither decompose to ASCII nor
 *     are ordinary orthographic letters such as ß, æ, ø).
 *
 * Accepted bodies are normalised before storage — CRLF -> LF, NFC, every \p{Nd} digit to ASCII,
 * every \p{Pd} dash and U+2212 to "-" — so the stored body is exactly the analysed body (and its
 * sha256 is computed after normalisation).
 */
import confusables from "@/data/confusables-ascii-subset.json"
import { asciiDigit } from "@/services/d4-2/citationFold"

export type CharsetViolation = {
  /** "U+202E" */
  codePoint: string
  /** code-point index in the submitted body */
  position: number
  /** Unicode general category, e.g. "Cf" */
  category: string
  reason: string
}

export type CharsetCheck =
  | { ok: true; normalised: string }
  | { ok: false; violations: CharsetViolation[] }

export class DraftCharsetError extends Error {
  readonly code = "unsupported_characters"
  constructor(readonly violations: CharsetViolation[]) {
    super(
      `draft contains ${violations.length} unsupported character(s): ` +
        violations
          .slice(0, 5)
          .map((v) => `${v.codePoint} at ${v.position} (${v.reason})`)
          .join(", ")
    )
    this.name = "DraftCharsetError"
  }
}

const CONFUSABLE: Record<string, string> = (confusables as { map: Record<string, string> }).map

const CATEGORIES = [
  "Lu", "Ll", "Lt", "Lm", "Lo", "Mn", "Mc", "Me", "Nd", "Nl", "No", "Pc", "Pd", "Ps", "Pe", "Pi",
  "Pf", "Po", "Sm", "Sc", "Sk", "So", "Zs", "Zl", "Zp", "Cc", "Cf", "Cs", "Co", "Cn",
] as const
const CATEGORY_RE = CATEGORIES.map((c) => [c, new RegExp(`^\\p{gc=${c}}$`, "u")] as const)

function category(ch: string): string {
  for (const [name, re] of CATEGORY_RE) if (re.test(ch)) return name
  return "Cn"
}

const BIDI_CONTROLS = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])
const isTag = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f
const isVariationSelector = (cp: number) =>
  (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0x180b && cp <= 0x180d) || cp === 0x180f
const RE_ALLOWED_SCRIPT = /^[\p{Script=Latin}\p{Script=Arabic}\p{Script=Common}\p{Script=Inherited}]$/u
const RE_DI = /^\p{Default_Ignorable_Code_Point}$/u
const RE_ARABIC_LETTER = /^(?=\p{L})\p{Script=Arabic}$/u
const RE_LATIN_LETTER = /^(?=\p{L})\p{Script=Latin}$/u
const RE_LETTER = /^\p{L}$/u
const RE_MARK = /\p{M}/gu
// Orthographic Latin letters that do not decompose to ASCII but are ordinary in names/text.
const ORTHOGRAPHIC = new Set([..."ßẞæÆœŒøØđĐðÐþÞłŁŋŊħĦŧŦ"])

export function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`
}

/** A Latin letter is suspicious when it is in the confusable subset or is not orthographic. */
function latinLetterProblem(ch: string): string | null {
  const cp = ch.codePointAt(0) ?? 0
  if (cp < 0x80) return null
  // ordinary orthographic letters (Æ, ß, ø, …) are allowed even where UTS #39 lists a
  // multi-letter prototype ("AE"); none of them can stand in for a reporter-token letter
  if (ORTHOGRAPHIC.has(ch)) return null
  const mapped = CONFUSABLE[cp.toString(16).toUpperCase().padStart(4, "0")]
  if (mapped !== undefined) return `confusable with "${mapped}"`
  const base = ch.normalize("NFKD").replace(RE_MARK, "")
  // decomposes to ASCII letters (é -> e, ﬁ -> fi): folds to the same text
  if (/^[A-Za-z]+$/.test(base)) return null
  return "non-orthographic Latin letter (small capital / IPA / click)"
}

export function checkDraftCharset(body: string): CharsetCheck {
  const cps = [...body]
  const violations: CharsetViolation[] = []
  const flag = (i: number, reason: string) => {
    const ch = cps[i] ?? ""
    const cp = ch.codePointAt(0) ?? 0
    violations.push({ codePoint: codePointLabel(cp), position: i, category: category(ch), reason })
  }
  for (let i = 0; i < cps.length; i += 1) {
    const ch = cps[i] ?? ""
    const cp = ch.codePointAt(0) ?? 0
    const cat = category(ch)
    if (ch === "\n" || ch === "\t") continue
    if (ch === "\r") {
      if (cps[i + 1] !== "\n") flag(i, "control character")
      continue
    }
    if (BIDI_CONTROLS.has(cp)) flag(i, "bidi embedding/override/isolate control")
    else if (isTag(cp)) flag(i, "tag character")
    else if (isVariationSelector(cp)) flag(i, "variation selector")
    else if (cp === 0x200c || cp === 0x200d) {
      const before = cps[i - 1] ?? ""
      const after = cps[i + 1] ?? ""
      if (!(RE_ARABIC_LETTER.test(before) && RE_ARABIC_LETTER.test(after))) {
        flag(i, "ZWNJ/ZWJ outside Arabic-script letters")
      }
    } else if (cat === "Cf" || RE_DI.test(ch)) flag(i, "format / default-ignorable character")
    else if (cat === "Cc") flag(i, "control character")
    else if (cat === "Zl" || cat === "Zp") flag(i, "line/paragraph separator")
    else if (cat === "Co") flag(i, "private-use character")
    else if (cat === "Cs") flag(i, "surrogate")
    else if (cat === "Cn") flag(i, "unassigned code point")
    else if (!RE_ALLOWED_SCRIPT.test(ch)) flag(i, "script not allowed (Latin, Arabic, Common, Inherited only)")
  }

  // Token rules (whitespace-separated): mixed Latin/non-Latin letters; Latin confusables.
  let start = 0
  for (let i = 0; i <= cps.length; i += 1) {
    const ch = cps[i]
    if (ch !== undefined && !/^\s$/u.test(ch)) continue
    if (i > start) {
      const token = cps.slice(start, i)
      let latin = false
      let otherLetter = false
      for (const t of token) {
        if (RE_LATIN_LETTER.test(t)) latin = true
        else if (RE_LETTER.test(t)) otherLetter = true
      }
      if (latin && otherLetter) {
        token.forEach((t, k) => {
          if (RE_LETTER.test(t) && !RE_LATIN_LETTER.test(t)) flag(start + k, "token mixes Latin and non-Latin letters")
        })
      }
      if (latin) {
        token.forEach((t, k) => {
          const cp = t.codePointAt(0) ?? 0
          if (cp < 0x80) return
          // Common-script look-alikes inside a Latin token (e.g. "∣SCMR∣") count too.
          const problem = RE_LATIN_LETTER.test(t)
            ? latinLetterProblem(t)
            : CONFUSABLE[cp.toString(16).toUpperCase().padStart(4, "0")] !== undefined
              ? `confusable with "${CONFUSABLE[cp.toString(16).toUpperCase().padStart(4, "0")]}"`
              : null
          if (problem) flag(start + k, `Latin token skeleton differs: ${problem}`)
        })
      }
    }
    start = i + 1
  }

  if (violations.length > 0) {
    const seen = new Set<number>()
    return {
      ok: false,
      violations: violations
        .sort((a, b) => a.position - b.position)
        .filter((v) => (seen.has(v.position) ? false : (seen.add(v.position), true))),
    }
  }
  return { ok: true, normalised: normaliseDraftBody(body) }
}

/** CRLF -> LF, NFC, ASCII digits, ASCII dashes. Only for bodies that passed the check. */
export function normaliseDraftBody(body: string): string {
  let out = ""
  for (const ch of body.replace(/\r\n/g, "\n").normalize("NFC")) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= 0x80 && /^\p{Nd}$/u.test(ch)) out += asciiDigit(cp)
    else if (cp === 0x2212 || /^\p{Pd}$/u.test(ch)) out += "-"
    else out += ch
  }
  return out
}

/** Throws DraftCharsetError, or returns the normalised body. */
export function requireSupportedDraftBody(body: string): string {
  const check = checkDraftCharset(body)
  if (!check.ok) throw new DraftCharsetError(check.violations)
  return check.normalised
}
