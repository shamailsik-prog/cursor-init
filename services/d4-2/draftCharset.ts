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
const RE_SYMBOL_OR_PUNCT = /^[\p{S}\p{P}]$/u
const RUN_SPLIT = /^[()[\]{}/\\"\u201c\u201d\u00ab\u00bb\u2018]$/u
// Intra-word marks that are ordinary in Latin text: dashes (\p{Pd}) and the curly apostrophes.
const INTRA_WORD_MARKS = new Set(["\u2018", "\u2019", "\u02bc"])
/**
 * Latin letters, plus letters of other scripts that render as Latin letters and decompose to
 * them (math alphanumerics such as U+1D4D2, Common script): a token of those is a Latin token
 * for the confusable rules (fuzz, R3 item 10: "\u{1d4d2}\u{1d473}\u{1f74c}" for "CLC").
 */
function isLatinLike(ch: string): boolean {
  if (RE_LATIN_LETTER.test(ch) || COMPAT_ALLOWED.has(ch)) return true
  return RE_LETTER.test(ch) && /^[A-Za-z]+$/.test(ch.normalize("NFKD").replace(RE_MARK, ""))
}
const RE_MARK = /\p{M}/gu
// Orthographic Latin letters that do not decompose to ASCII but are ordinary in names/text.
const ORTHOGRAPHIC = new Set([..."ßẞæÆœŒøØđĐðÐþÞłŁŋŊħĦŧŦ"])
// Common-script compatibility letters that are ordinary in drafts (MICRO SIGN in "5 µg").
const COMPAT_ALLOWED = new Set(["\u00b5"])

export function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`
}

/** A Latin letter is suspicious when it is in the confusable subset or is not orthographic. */
function latinLetterProblem(ch: string): string | null {
  const cp = ch.codePointAt(0) ?? 0
  if (cp < 0x80) return null
  // ordinary orthographic letters (Æ, ß, ø, …) are allowed even where UTS #39 lists a
  // multi-letter prototype ("AE"); none of them can stand in for a reporter-token letter
  const mapped = CONFUSABLE[cp.toString(16).toUpperCase().padStart(4, "0")]
  // ...but not one UTS #39 maps onto a single ASCII letter (þ -> "p"): that can stand in for a
  // reporter letter (fuzz, R3 item 10)
  if (ORTHOGRAPHIC.has(ch) && (mapped === undefined || mapped.length > 1)) return null
  if (mapped !== undefined) return `confusable with "${mapped}"`
  const base = ch.normalize("NFKD").replace(RE_MARK, "")
  // decomposes to ASCII letters (é -> e, ﬁ -> fi): folds to the same text
  if (/^[A-Za-z]+$/.test(base)) return null
  return "non-orthographic Latin letter (small capital / IPA / click)"
}

/** The script family a letter belongs to, for the same-script artefact rule. */
function letterScript(ch: string): string | null {
  if (!RE_LETTER.test(ch)) return null
  if (/\p{Script=Latin}/u.test(ch)) return "Latin"
  if (/\p{Script=Arabic}/u.test(ch)) return "Arabic"
  return "other"
}

/**
 * R4 FP5: harmless artefacts of pasting from Word, PDF or the web, cleaned before the charset
 * check (the stored body is the cleaned, normalised one): a leading BOM; VT (Word manual line
 * break) and FF (page break) as newlines; Latin ligatures U+FB00-FB06 expanded; a soft hyphen
 * or ZWSP between two letters of the same script dropped, and a ZWSP next to a blank. Anything
 * else (between digits, across scripts, a BOM mid-text, bidi, other controls) stays refused.
 */
/** Why a single character is refused (null when allowed); neighbours matter for ZWNJ/ZWJ only. */
function characterProblem(ch: string, before: string, after: string): string | null {
  const cp = ch.codePointAt(0) ?? 0
  const cat = category(ch)
  if (cat === "Cc") return "control character"
  if (BIDI_CONTROLS.has(cp)) return "bidi embedding/override/isolate control"
  if (isTag(cp)) return "tag character"
  if (isVariationSelector(cp)) return "variation selector"
  if (cp === 0x200c || cp === 0x200d) {
    return RE_ARABIC_LETTER.test(before) && RE_ARABIC_LETTER.test(after) ? null : "ZWNJ/ZWJ outside Arabic-script letters"
  }
  if (cat === "Cf" || RE_DI.test(ch)) return "format / default-ignorable character"
  if (cat === "Zl" || cat === "Zp") return "line/paragraph separator"
  if (cat === "Co") return "private-use character"
  if (cat === "Cs") return "surrogate"
  if (cat === "Cn") return "unassigned code point"
  if (!RE_ALLOWED_SCRIPT.test(ch)) return "script not allowed (Latin, Arabic, Common, Inherited only)"
  if (
    RE_LETTER.test(ch) && !RE_LATIN_LETTER.test(ch) && !RE_ARABIC_LETTER.test(ch) && !COMPAT_ALLOWED.has(ch) &&
    [...ch.normalize("NFKD")].some((d) => RE_LETTER.test(d) && !RE_ALLOWED_SCRIPT.test(d))
  ) {
    // a Common-script compatibility letter of a disallowed script (math Greek U+1D6B8 "P")
    return "compatibility form of a letter in a disallowed script"
  }
  return null
}

export function cleanPasteArtefacts(body: string): string {
  const input = [...body.replace(/^\ufeff/u, "").replace(/[\u000b\u000c]/gu, "\n").replace(/[\ufb00-\ufb06]/gu, (c) => c.normalize("NFKC"))]
  const out: string[] = []
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? ""
    if (ch === "\u00ad" || ch === "\u200b") {
      const prev = out[out.length - 1] ?? ""
      let k = i + 1
      while (input[k] === "\u00ad" || input[k] === "\u200b") k += 1
      const next = input[k] ?? ""
      const sameScript = letterScript(prev) !== null && letterScript(prev) === letterScript(next)
      const besideBlank = ch === "\u200b" && (prev === "" || next === "" || /^\s$/u.test(prev) || /^\s$/u.test(next))
      if (sameScript || besideBlank) continue
    }
    out.push(ch)
  }
  return out.join("")
}

export function checkDraftCharset(rawBody: string): CharsetCheck {
  const body = cleanPasteArtefacts(rawBody)
  const cps = [...body]
  const violations: CharsetViolation[] = []
  const flag = (i: number, reason: string) => {
    const ch = cps[i] ?? ""
    const cp = ch.codePointAt(0) ?? 0
    violations.push({ codePoint: codePointLabel(cp), position: i, category: category(ch), reason })
  }
  for (let i = 0; i < cps.length; i += 1) {
    const ch = cps[i] ?? ""
    if (ch === "\n" || ch === "\t") continue
    if (ch === "\r") {
      if (cps[i + 1] !== "\n") flag(i, "control character")
      continue
    }
    const problem = characterProblem(ch, cps[i - 1] ?? "", cps[i + 1] ?? "")
    if (problem) flag(i, problem)
  }

  // R5-5: a numeric HTML character reference (decimal or hex, ";" optional) that decodes to a
  // character refused above is refused too, so the stored text can never render, say, a bidi
  // control in an HTML export.
  for (const m of body.matchAll(/&#(?:[xX]([0-9A-Fa-f]{1,8})|([0-9]{1,10}));?/gu)) {
    const value = m[1] !== undefined ? Number.parseInt(m[1], 16) : Number.parseInt(m[2] ?? "", 10)
    const decoded = value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : "\ufffd"
    if (decoded === "\n" || decoded === "\t") continue
    // no letter context for an encoded character: ZWNJ/ZWJ count as refused here
    const problem = value > 0x10ffff ? "out-of-range code point" : characterProblem(decoded, "", "")
    if (problem) {
      const position = [...body.slice(0, m.index ?? 0)].length
      violations.push({ codePoint: codePointLabel(Math.min(value, 0x10ffff)), position, category: category(decoded), reason: `HTML entity decodes to a refused character: ${problem}` })
    }
  }


  // Token rules (whitespace-separated): mixed Latin/non-Latin letters; Latin confusables.
  let start = 0
  for (let i = 0; i <= cps.length; i += 1) {
    const ch = cps[i]
    if (ch !== undefined && !/^\s$/u.test(ch)) continue
    if (i > start) {
      const token = cps.slice(start, i)
      // R4 FP6: the mixed-script and confusable rules apply per letter run — the token split at
      // brackets, slashes and double quotes ("ضمانت(bail)", "دفعہ/Section", "\"بیعانہ\"(earnest").
      // Apostrophes do not split (they sit inside English words).
      const runOf: number[] = []
      let run = 0
      token.forEach((t) => {
        if (RUN_SPLIT.test(t)) run += 1
        runOf.push(run)
      })
      const latinRuns = new Set<number>()
      const otherRuns = new Set<number>()
      token.forEach((t, k) => {
        if (isLatinLike(t)) latinRuns.add(runOf[k] ?? 0)
        else if (RE_LETTER.test(t)) otherRuns.add(runOf[k] ?? 0)
      })
      token.forEach((t, k) => {
        const r = runOf[k] ?? 0
        if (latinRuns.has(r) && otherRuns.has(r) && RE_LETTER.test(t) && !isLatinLike(t)) {
          flag(start + k, "token mixes Latin and non-Latin letters")
        }
      })
      const latin = latinRuns.size > 0
      // R4-1: a non-ASCII symbol or punctuation mark directly between two letters of a token
      // that has ASCII letters ("S\u2201MR", "S\u00a9MR") splits a reporter for the gate while
      // reading as one word. Ordinary intra-word marks (dashes, ’ ‘) stay allowed.
      if (token.some((t) => /^[A-Za-z]$/.test(t))) {
        token.forEach((t, k) => {
          if ((t.codePointAt(0) ?? 0) < 0x80 || !RE_SYMBOL_OR_PUNCT.test(t) || INTRA_WORD_MARKS.has(t) || /^\p{Pd}$/u.test(t)) return
          // both neighbours Latin(-like): a mark between an Arabic and a Latin letter (“مقدمہ”case)
          // splits no Latin word
          if (isLatinLike(token[k - 1] ?? "") && isLatinLike(token[k + 1] ?? "")) {
            flag(start + k, "symbol or punctuation between two letters of a word")
          }
        })
      }
      if (latin) {
        token.forEach((t, k) => {
          const cp = t.codePointAt(0) ?? 0
          if (cp < 0x80 || COMPAT_ALLOWED.has(t)) return
          // only inside a Latin run (an Arabic run beside "(bail)" is not a Latin look-alike)
          if (!latinRuns.has(runOf[k] ?? 0)) return
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
  for (const ch of cleanPasteArtefacts(body).replace(/\r\n/g, "\n").normalize("NFC")) {
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
