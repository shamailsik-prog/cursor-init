/**
 * P1 outbound (and inbound) mask (Job F / Erratum O-13; audit F15).
 * The masked body is the only text that may leave the firm toward a provider.
 * Classification never appears in the provider prompt.
 *
 * Masking reduces risk; it is not anonymisation.
 *
 * What it masks:
 *   - everything main masked: main's algorithm runs on the raw text as written (stage 0, ruling R4-1) and its patterns
 *     run first on the detection view (stage 1, R3-1); the mask writes the union of all spans;
 *   - CNICs (5-7-1 with any run of spaces, line breaks, dots, dashes, commas, slashes or underscores between the
 *     groups, and thirteen digits in form boxes or 4-4-4-1 groups); Pakistani mobiles (+92, 0092, 92 or 0 prefix,
 *     any grouping, any run of whitespace, dots, commas, dashes, brackets, colons or underscores between groups, and a
 *     slash only where it touches whitespace); landlines with their area code and UANs; emails (Unicode local parts
 *     and domains); PK IBANs; NTNs (NTN, N.T.N, with No.) and labelled passports with any label gap; passports as two
 *     capitals and seven digits;
 *   - in any digit script (full-width, Arabic-Indic, Urdu, Devanagari, mathematical, enclosed and dingbat digits);
 *   - with any dash, space, Arabic or ideographic separator;
 *   - through every invisible character: format characters, default-ignorable code points (variation selectors,
 *     the combining grapheme joiner, Hangul fillers, ...), private-use characters and combining marks are dropped
 *     before detection, and the braille blank and the ideographic half fill space read as spaces;
 *   - the party names the caller supplies, through case, spacing, punctuation, diacritics, Arabic letter variants,
 *     Cyrillic and Greek look-alikes, and a leading honorific in the record.
 *
 * What it does not catch:
 *   - names nobody supplied, written in free prose (there is no auto-NER: masking "Ali"/"Khan" everywhere would
 *     destroy legal prose, so callers must pass partyNames), and a recorded name written only in part (a surname);
 *   - semantic identifying facts ("the only female sessions judge in the district", age, caste, date of birth);
 *   - addresses and parentage (`residualPII` detects the common forms; at rank 3 and above `assertMinimised` then
 *     blocks the call, below it they are counted, not masked), mobiles without a prefix and "0300/1234567" (a slash
 *     without whitespace: counted, not masked), vehicle and other registration numbers;
 *   - identifiers written in words, obfuscated ("[at]", "[dot]") or with look-alike letters ("O3OO" for "0300");
 *   - an email that runs into a recorded name ("...@0.TTariq Zarvani"): the email takes the name's first letters.
 *
 * How (spec docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md, rulings 1 to 3, R2-1 to R2-5,
 * R3-1, R3-2, R3-7 and R4-1): main's algorithm runs on the raw text; every pattern runs on the detection view
 * (`detectionView`), the names on its folded name view (`nameView`), in one pass; each match is mapped back to its span
 * in the original text, the spans are merged (`outboundPIISpans`), and only those spans are replaced, so every unmatched
 * code unit of the original is sent exactly as written. Separator runs are unbounded, but each is a
 * class disjoint from what follows it, and no two runs meet around an optional part, so the mask is linear in the text
 * (rulings R2-2 and R3-1; tests/f15-r2-bounds.test.ts and tests/f15-r3-bounds.test.ts).
 */

import { detectionView, foldName, nameView, type TextView } from "@/platform/p1/piiText"

export type MaskOptions = {
  partyNames?: string[]
}

export type RedactionKind =
  | "cnic"
  | "phone"
  | "party"
  | "email"
  | "iban"
  | "ntn"
  | "passport"

export type MaskResult = {
  masked: string
  redactions: { kind: RedactionKind; count: number }[]
}

const TOKEN: Readonly<Record<RedactionKind, string>> = {
  cnic: "[CNIC]",
  phone: "[PHONE]",
  party: "[PARTY]",
  email: "[EMAIL]",
  iban: "[IBAN]",
  ntn: "[NTN]",
  passport: "[PASSPORT]",
}

/** The tokens the mask writes. `residualPII` does not count content that is one of them. */
export const MASK_TOKENS: readonly string[] = Object.values(TOKEN)

/**
 * The words and prefixes the patterns key on. The bound test (tests/f15-r2-bounds.test.ts) runs each, followed by
 * 100,000 characters of every filler, through the mask and the residual check, so a cue added here is covered.
 */
export const MASK_CUES: readonly string[] = [
  "passport", "ppt", "ppt.", "NTN", "N.T.N", "N.T.N.", "PK", "+92", "+ 92", "0092", "92", "0", "(0", "(+92)", "(042)",
  "111", "@", "a@", "a@b.", "35202", "03", "0300", "AB", "NTN No", "Passport No.", "PK36", "PK36 SCBL", "35202 1234567",
  "+92 (300)", "0300 /", "3 5 2 0 2 -", "3520 2123", "a@b.cc",
]

// ---------------------------------------------------------------------------------------------------------------------
// Stage 1: main's patterns (origin/main 0844ed8), in main's order, so whatever main masked is masked again (ruling
// R3-1). They are main's verbatim, except that the mobiles also take the country prefix main left to their left, and
// main's email is replaced: it backtracked quadratically, and EMAIL below matches every email it did (the differential
// test in tests/f15-r3-mask.test.ts checks these claims on generated inputs).
// ---------------------------------------------------------------------------------------------------------------------

const MAIN_CNIC_SEPARATED = /\b\d{5}[.\-\s]+\d{7}[.\-\s]+\d\b/g
const MAIN_CNIC_PLAIN = /\b\d{13}\b/g
/**
 * Main's two mobile patterns, each also taking a country prefix main left in front of its match ("+92 (300) 1234567",
 * "0092-300-1234567"): the prefix only widens a match to the left, so main's span is still covered.
 */
const MAIN_MOBILE_PAREN = /(?:(?:\+\s?92|0092)[\s.-]?)?\(0?3\d{2}\)[.\s-]?\d{7}\b/g
const MAIN_MOBILE = /(?:(?:\+|00)(?=92))?(?:\+92|92|0)[.\s-]?3\d{2}[.\s-]?\d{7}\b/g
const MAIN_IBAN = /\bPK\s*\d{2}\s*[A-Z]{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\b/gi
const MAIN_NTN = /\bNTN[:\s-]*\d{7}-\d\b/gi
const MAIN_PASSPORT = /\b(?:passport|ppt\.?)[:\s-]*[A-Z]{2}\d{7}\b/gi
/**
 * An email, anchored at the start of a run of local-part characters (audit F15): main's `\b`-anchored form restarted
 * inside every run and backtracked quadratically. Letters and digits of any script (R2-5: "nūra@...", IDN domains).
 * Like main's, its local part holds a letter, digit or underscore (main's `\b` needed one to start), and it ends where
 * main's did, before anything but an ASCII letter, digit or underscore, so it never reads further than main's into
 * digits main gave to a later pattern ("%@90-Z0.Xa.NTN 9159198-8", "...@9XZ.Xb_PK36..."); stage 2 widens both.
 */
const EMAIL = /(?<![\p{L}\p{N}._%+-])[.%+-]*[\p{L}\p{N}_][\p{L}\p{N}._%+-]*@[\p{L}\p{N}.-]+\.\p{L}{2,}(?![A-Za-z0-9_])/gu
/**
 * An email that starts exactly where the previous one ended ("a@b.pk.c@d.pk"): main's `\b` form restarted there, the
 * anchored form cannot (found by the differential test). Tried once at each match end, sticky, so the scan stays
 * linear.
 */
const EMAIL_AT = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}(?![A-Za-z0-9_])/uy

// ---------------------------------------------------------------------------------------------------------------------
// Stage 2: what main did not catch, on what stage 1 left. Separator runs are unbounded, as on main (ruling R3-1: round
// 2's bound of three characters let a CNIC with five spaces through). Each run is a class disjoint from the digits and
// letters around it, so it has one parse: a start (a word boundary, a label or the first digit of a run) consumes it
// once and gives it back once, and the scan stays linear in the text (tests/f15-r3-bounds.test.ts).
// ---------------------------------------------------------------------------------------------------------------------

/** An email ending before an underscore or a letter of any script too ("nura@qalvo.pk_"). */
const EMAIL_WIDE = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}(?![\p{L}\p{N}])/gu
const EMAIL_WIDE_AT = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}(?![\p{L}\p{N}])/uy
/** A CNIC split 5-7-1 by runs that may also hold commas, slashes and underscores (R2-4, R3-1). */
const CNIC_SEPARATED = /\b\d{5}[.,/\-\s_]+\d{7}[.,/\-\s_]+\d\b/g
/**
 * Digit groups split by one to three spaces or dashes, kept as a CNIC when they hold thirteen digits: a CNIC written
 * in form boxes ("3 5 2 0 2 - 1 2 3 4 5 6 7 - 1") or in 4-4-4-1 groups (ruling R3-7). The lookarounds make a match a
 * maximal run, so a sixteen-digit card number is never cut to thirteen.
 */
const CNIC_GROUPED = /(?<!\d[ -]{0,3})\d+(?:[ -]{1,3}\d+)+(?![ -]{0,3}\d)/g
const thirteenDigits = (match: string) => match.replace(/\D/g, "").length === 13
const PK_IBAN = /\bPK[\s-]*\d{2}[\s-]*[A-Z]{4}(?:[\s-]*\d{4}){4}\b/gi
/**
 * Between mobile digit groups (ruling R3-2): any run of whitespace, dots, commas, dashes, brackets, colons and
 * underscores, and a slash only where it touches whitespace ("0300 / 1234567", "0300/ 1234567"), so "03/01/2021 123"
 * is a date and a number, not a mobile. The two slash alternatives exclude each other: every character of a run has
 * one parse.
 */
const MOBILE_SEP = "(?:[\\s.,\\-()_:]|(?<=\\s)\\/|(?<!\\s)\\/(?=\\s))*"
/** A date at the start ("03.01.2021 123"): a date and a number, not a mobile (the residual check's rule, R3-2). */
const NOT_A_DATE = "(?!\\d{1,2}[./-]\\d{1,2}[./-](?:19|20)\\d\\d(?!\\d))"
/** A Pakistani mobile: a +92, 0092, 92 or 0 prefix (brackets allowed), a 3, then nine digits, any grouping (R2-4). */
const PK_MOBILE = new RegExp(
  `(?<![\\d+])${NOT_A_DATE}(?:\\(\\s*(?:\\+\\s*92|0092|92)\\s*\\)|\\+\\s*92|0092|92|\\(?0)${MOBILE_SEP}3(?:${MOBILE_SEP}\\d){9}(?!\\d)`,
  "g"
)
/** A UAN: 111 and six digits, with an optional area code (R2-4). */
const PK_UAN = /(?<![\d+])(?:\(?0?[1-9]\d{1,2}\)?[\s.-]{0,3})?111[\s.-]{0,3}\d{3}[\s.-]{0,3}\d{3}(?!\d)/g
/** A landline: an area code (0 and two to four digits, or +92 and one to three) and six to eight digits (R2-4). */
const PK_LANDLINE = new RegExp(
  "(?<![\\d+])(?:(?:\\(\\s?(?:\\+\\s?92|0092)\\s?\\)|\\+\\s?92|0092)[\\s.-]{0,3}\\(?[1-9]\\d{1,3}\\)?|\\(?0[1-9]\\d{1,3}\\)?)" +
    "[\\s.-]{0,3}\\d{6,8}(?!\\d)",
  "g"
)
/**
 * Between a label and its value (ruling R3-1): an unbounded run of colons, whitespace, dashes, hashes and dots, then
 * optionally "No", "Nos" or "Number" and another such run. The optional word is required before the second run, so
 * the two runs never compete for the same characters.
 */
const LABEL_GAP = "[:\\s\\-#.]*(?:(?:No|Nos|Number)(?![A-Za-z])[:\\s\\-#.]*)?"
const NTN = new RegExp(`(?<![\\p{L}\\p{N}])(?:NTN|N\\.T\\.N\\.?)${LABEL_GAP}\\d{7}(?: ?- ?\\d)?(?!\\d)`, "giu")
const PASSPORT = new RegExp(`\\b(?:passport|ppt\\.?)${LABEL_GAP}[A-Z]{2}\\d{7}\\b`, "gi")
/** Two capitals and seven digits, the Pakistani passport number, without a label (R2-5). Case-sensitive. */
const PASSPORT_UNLABELLED = /\b[A-Z]{2}\d{7}\b/g

// ---------------------------------------------------------------------------------------------------------------------
// Stage 0 (ruling R4-1): main's algorithm on the RAW text as well. Main ran its regexes on the text as written, where
// a format character, a combining mark, a private-use character or a ligature is a word boundary; the detection view
// drops or expands them, which can join an identifier to a word and lose the boundary a pattern needs ("(371)
// 6656495ﬁle"). Running main's patterns on the raw text and taking the union of the spans makes "never masks less
// than main" hold by construction. Main's patterns run in main's order, each over the text with the earlier matches
// blanked (main replaced them with a token; a blank is, like the token's brackets, no word character and no
// separator), then main's party-name pass. Main's email regex backtracked quadratically; EMAIL_RAW is its linear
// equivalent on the raw text (ASCII classes and ASCII word boundaries, as main's non-Unicode regex had).
// ---------------------------------------------------------------------------------------------------------------------

const EMAIL_RAW = /(?<![A-Za-z0-9._%+-])[.%+-]*[A-Za-z0-9_][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9_])/g
const EMAIL_RAW_AT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9_])/y
/** Main's patterns in main's order, for the raw text (the mobiles without stage 1's prefix widening). */
const RAW_PATTERNS: readonly Pattern[] = [
  { kind: "cnic", re: /\b\d{5}[.\-\s]+\d{7}[.\-\s]+\d\b/g },
  { kind: "cnic", re: /\b\d{13}\b/g },
  { kind: "phone", re: /\(0?3\d{2}\)[.\s-]?\d{7}\b/g },
  { kind: "phone", re: /(?:\+92|92|0)[.\s-]?3\d{2}[.\s-]?\d{7}\b/g },
  { kind: "email", re: EMAIL_RAW, chain: EMAIL_RAW_AT },
  { kind: "iban", re: /\bPK\s*\d{2}\s*[A-Z]{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\b/gi },
  { kind: "ntn", re: /\bNTN[:\s-]*\d{7}-\d\b/gi },
  { kind: "passport", re: /\b(?:passport|ppt\.?)[:\s-]*[A-Z]{2}\d{7}\b/gi },
]

/** The spans main's algorithm replaces in the raw text, in original offsets. */
function mainSpans(text: string, partyNames: readonly string[]): Span[] {
  const spans: Span[] = []
  let work = text
  const run = (pattern: Pattern) => {
    const found: Array<[number, number]> = []
    for (const m of work.matchAll(pattern.re)) {
      found.push([m.index, m.index + m[0].length])
      let next = m.index + m[0].length
      while (pattern.chain !== undefined) {
        pattern.chain.lastIndex = next
        const c = pattern.chain.exec(work)
        if (c === null) break
        found.push([c.index, c.index + c[0].length])
        next = c.index + c[0].length
      }
    }
    if (found.length === 0) return
    let blanked = ""
    let at = 0
    for (const [start, end] of found) {
      spans.push({ start, end, kind: pattern.kind })
      blanked += work.slice(at, start) + BLANK.repeat(end - start)
      at = end
    }
    work = blanked + work.slice(at)
  }
  for (const pattern of RAW_PATTERNS) run(pattern)
  for (const name of partyNames) {
    const trimmed = name.trim()
    if (trimmed !== "") run({ kind: "party", re: new RegExp(escapeRegExp(trimmed), "gi") })
  }
  return spans
}

/**
 * A pattern: its kind, its regex, an optional test a match must pass (`accept`) and an optional sticky regex tried at
 * the end of each accepted match (`chain`).
 */
type Pattern = {
  kind: RedactionKind
  re: RegExp
  accept?: (match: string) => boolean
  chain?: RegExp
}

/**
 * The patterns in priority order: an earlier pattern's match is never seen by a later one. Stage 1 is main's, so
 * nothing main masked is read differently; in stage 2 the labelled values and the IBAN come before the mobiles (the
 * unbounded mobile separators must not read their digits as a mobile), the general mobile pattern before the
 * landline and UAN, and the grouped CNIC last, so it only reads digits no other pattern took.
 */
const PATTERNS: readonly Pattern[] = [
  { kind: "cnic", re: MAIN_CNIC_SEPARATED },
  { kind: "cnic", re: MAIN_CNIC_PLAIN },
  { kind: "phone", re: MAIN_MOBILE_PAREN },
  { kind: "phone", re: MAIN_MOBILE },
  { kind: "email", re: EMAIL, chain: EMAIL_AT },
  { kind: "iban", re: MAIN_IBAN },
  { kind: "ntn", re: MAIN_NTN },
  { kind: "passport", re: MAIN_PASSPORT },
  { kind: "cnic", re: CNIC_SEPARATED },
  { kind: "iban", re: PK_IBAN },
  { kind: "ntn", re: NTN },
  { kind: "passport", re: PASSPORT },
  { kind: "phone", re: PK_MOBILE },
  { kind: "phone", re: PK_UAN },
  { kind: "phone", re: PK_LANDLINE },
  { kind: "email", re: EMAIL_WIDE, chain: EMAIL_WIDE_AT },
  { kind: "passport", re: PASSPORT_UNLABELLED },
  { kind: "cnic", re: CNIC_GROUPED, accept: thirteenDigits },
]

/** Written over an accepted match in a view: no pattern or name can match it. */
const BLANK = "\uE000"
const MARK = /\p{M}/u
/** Honorifics a recorded name may start with; the name is also matched without them (R2-5). */
const HONORIFIC = /^(?:mr|mrs|ms|mst|miss|dr) /

type Span = { start: number; end: number; kind: RedactionKind }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** A view whose units can be blanked in place, with its text re-joined only after a change. */
class Units {
  private readonly units: string[]
  private cached: string | null = null

  constructor(readonly view: TextView) {
    this.units = view.text.split("")
  }

  text(): string {
    this.cached ??= this.units.join("")
    return this.cached
  }

  blank(from: number, to: number): void {
    for (let k = from; k <= to; k++) this.units[k] = BLANK
    this.cached = null
  }

  get length(): number {
    return this.units.length
  }
}

/** The end of a span moved past the combining marks that follow it in the original (a keycap, an accent). */
function pastMarks(original: string, end: number): number {
  let at = end
  for (;;) {
    const cp = original.codePointAt(at)
    if (cp === undefined) return at
    const ch = String.fromCodePoint(cp)
    if (!MARK.test(ch)) return at
    at += ch.length
  }
}

/**
 * Accepts every match of the pattern in `units` that its `accept` keeps (all of them by default), and every match of its
 * `chain` that starts exactly where an accepted match ends: records its original span (moved past any trailing
 * combining marks) and blanks every unit whose original span overlaps it (so the units an NFKC expansion shares with it
 * go too).
 */
function take(original: string, units: Units, pattern: Pattern, spans: Span[]): void {
  const { kind, re, accept, chain } = pattern
  const view = units.view
  const text = units.text()
  const accepted = (first: number, length: number): number => {
    const last = first + length - 1
    const start = view.start[first]!
    const end = pastMarks(original, view.end[last]!)
    let from = first
    while (from > 0 && view.end[from - 1]! > start) from -= 1
    let to = last
    while (to + 1 < units.length && view.start[to + 1]! < end) to += 1
    units.blank(from, to)
    spans.push({ start, end, kind })
    return last + 1
  }
  for (const m of text.matchAll(re)) {
    if (accept !== undefined && !accept(m[0])) continue
    let next = accepted(m.index, m[0].length)
    while (chain !== undefined) {
      chain.lastIndex = next
      const c = chain.exec(text)
      if (c === null) break
      next = accepted(c.index, c[0].length)
    }
  }
}

/**
 * The supplied names as patterns on the name view (ruling 3): folded, also without a leading honorific, de-duplicated,
 * longest first (ties in code-unit order); each whitespace run of a name matches any whitespace run in the text, or
 * none.
 */
function namePatterns(partyNames: string[]): RegExp[] {
  const folded = new Set<string>()
  for (const name of partyNames) {
    const f = foldName(name).split(BLANK).join("")
    if (f === "") continue
    folded.add(f)
    const bare = f.replace(HONORIFIC, "")
    if (bare !== f && bare !== "") folded.add(bare)
  }
  return [...folded]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .map((f) => new RegExp(f.split(" ").map(escapeRegExp).join("\\s*"), "gu"))
}

/** A replaced span of the original text: code units [start, end), and the kind of its token. */
export type MaskSpan = { readonly start: number; readonly end: number; readonly kind: RedactionKind }

/**
 * The spans the mask replaces in `text`, in order, disjoint: the union of main's algorithm on the raw text (stage 0)
 * and the patterns and names on the detection and name views (stages 1 and 2). Overlapping spans (the raw pass and the
 * detection view finding the same identifier, or two matches inside one NFKC expansion) are merged into the earlier
 * one. `maskOutboundPII` writes exactly these spans; the differential test reads them to compare with main exactly.
 */
export function outboundPIISpans(text: string, options: MaskOptions = {}): MaskSpan[] {
  // 0. Main's algorithm on the raw text (ruling R4-1).
  const spans: Span[] = mainSpans(text, options.partyNames ?? [])

  // 1. The identifier patterns, on the detection view.
  const detection = new Units(detectionView(text))
  for (const pattern of PATTERNS) take(text, detection, pattern, spans)

  // 2. The party names, on the name view of what the patterns left.
  const names = namePatterns(options.partyNames ?? [])
  if (names.length > 0) {
    const blanked: TextView = { text: detection.text(), start: detection.view.start, end: detection.view.end }
    const units = new Units(nameView(blanked))
    for (const re of names) take(text, units, { kind: "party", re }, spans)
  }

  // 3. The union: sorted, overlaps merged into the earlier span.
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Span[] = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last !== undefined && span.start < last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

export function maskOutboundPII(text: string, options: MaskOptions = {}): MaskResult {
  const counts: Record<RedactionKind, number> = { cnic: 0, phone: 0, party: 0, email: 0, iban: 0, ntn: 0, passport: 0 }
  let masked = ""
  let at = 0
  for (const span of outboundPIISpans(text, options)) {
    masked += text.slice(at, span.start) + TOKEN[span.kind]
    counts[span.kind] += 1
    at = span.end
  }
  masked += text.slice(at)

  return {
    masked,
    redactions: [
      { kind: "cnic", count: counts.cnic },
      { kind: "phone", count: counts.phone },
      { kind: "party", count: counts.party },
      { kind: "email", count: counts.email },
      { kind: "iban", count: counts.iban },
      { kind: "ntn", count: counts.ntn },
      { kind: "passport", count: counts.passport },
    ],
  }
}
