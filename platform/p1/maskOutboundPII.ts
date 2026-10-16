/**
 * P1 outbound (and inbound) mask (Job F / Erratum O-13; audit F15).
 * The masked body is the only text that may leave the firm toward a provider.
 * Classification never appears in the provider prompt.
 *
 * Masking reduces risk; it is not anonymisation.
 *
 * What it masks:
 *   - CNICs; Pakistani mobiles (+92, 0092, 92 or 0 prefix, any grouping, up to three separator characters between
 *     groups, brackets allowed); landlines with their area code and UANs; emails (Unicode local parts and domains);
 *     PK IBANs; NTNs (NTN, N.T.N, with No.); passports (labelled, or two capitals and seven digits);
 *   - in any digit script (full-width, Arabic-Indic, Urdu, Devanagari, mathematical, enclosed and dingbat digits);
 *   - with any dash, space, Arabic or ideographic separator;
 *   - through every invisible character: format characters, default-ignorable code points (variation selectors,
 *     the combining grapheme joiner, Hangul fillers, ...) and combining marks are dropped before detection;
 *   - the party names the caller supplies, through case, spacing, punctuation, diacritics, Arabic letter variants,
 *     Cyrillic and Greek look-alikes, and a leading honorific in the record.
 *
 * What it does not catch:
 *   - names nobody supplied, written in free prose (there is no auto-NER: masking "Ali"/"Khan" everywhere would
 *     destroy legal prose, so callers must pass partyNames), and a recorded name written only in part (a surname);
 *   - semantic identifying facts ("the only female sessions judge in the district", age, caste, date of birth);
 *   - addresses and parentage (`residualPII` detects the common forms; at rank 3 and above `assertMinimised` then
 *     blocks the call, below it they are counted, not masked), mobiles without a prefix, vehicle and other
 *     registration numbers;
 *   - identifiers written in words, obfuscated ("[at]", "[dot]") or with look-alike letters ("O3OO" for "0300");
 *   - a zero-width character between a word and an identifier removes the word boundary a pattern needs
 *     ("CNIC\u200B3520212345671"); `residualPII` still counts the digits.
 *
 * How (spec docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md, rulings 1 to 3 and R2-1 to R2-5):
 * every pattern runs on the detection view (`detectionView`), the names on its folded name view (`nameView`), in one
 * pass; each match is mapped back to its span in the original text and only that span is replaced, so every unmatched
 * code unit of the original is sent exactly as written. Every quantifier that can repeat whitespace is either bounded or
 * separated from the next one by a required token, so the mask is linear in the text (ruling R2-2).
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
  "111", "@", "a@", "a@b.", "35202", "03", "0300", "AB",
]

// Separators between mobile groups: at most three characters, so no quantifier can repeat a long whitespace run (R2-2).
// No slash: "03/01/2021 123" is a date and a number, not a mobile.
const SEP = "[\\s.,\\-()_]{0,3}"
const CNIC_SEPARATED = /\b\d{5}[.,/\-\s_]{1,3}\d{7}[.,/\-\s_]{1,3}\d\b/g
const CNIC_PLAIN = /\b\d{13}\b/g
const PK_IBAN = /\bPK[\s-]{0,3}\d{2}[\s-]{0,3}[A-Z]{4}(?:[\s-]{0,3}\d{4}){4}\b/gi
/** A Pakistani mobile: a +92, 0092, 92 or 0 prefix (brackets allowed), a 3, then nine digits, any grouping (R2-4). */
const PK_MOBILE = new RegExp(
  `(?<![\\d+])(?:\\(\\s?(?:\\+\\s?92|0092|92)\\s?\\)|\\+\\s?92|0092|92|\\(?0)${SEP}3(?:${SEP}\\d){9}(?!\\d)`,
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
// Anchored at the start of a run of local-part characters (audit F15): main's `\b`-anchored form restarted inside
// every run and backtracked quadratically. Letters and digits of any script (R2-5: "nūra@...", IDN domains).
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}(?![\p{L}\p{N}])/gu
const LABEL_NUMBER = "(?:[\\s:#-]{0,3}(?:No\\.?|Number))?[\\s:#-]{0,3}"
const NTN = new RegExp(`(?<![\\p{L}\\p{N}])(?:NTN|N\\.T\\.N\\.?)${LABEL_NUMBER}\\d{7}(?:-\\d)?(?!\\d)`, "giu")
const PASSPORT = new RegExp(`\\b(?:passport|ppt\\.?)${LABEL_NUMBER}[A-Z]{2}\\d{7}\\b`, "gi")
/** Two capitals and seven digits, the Pakistani passport number, without a label (R2-5). Case-sensitive. */
const PASSPORT_UNLABELLED = /\b[A-Z]{2}\d{7}\b/g

/**
 * The patterns in priority order: an earlier pattern's match is never seen by a later one. The IBAN comes before the
 * phone numbers, so its digit groups are never read as one; the general mobile pattern comes before main's narrower
 * ones, which stay as a backstop.
 */
const PATTERNS: ReadonlyArray<[RedactionKind, RegExp]> = [
  ["cnic", CNIC_SEPARATED],
  ["cnic", CNIC_PLAIN],
  ["iban", PK_IBAN],
  ["phone", PK_MOBILE],
  ["phone", /\(0?3\d{2}\)[.\s-]?\d{7}\b/g],
  ["phone", /(?:\+92|92|0)[.\s-]?3\d{2}[.\s-]?\d{7}\b/g],
  ["phone", PK_UAN],
  ["phone", PK_LANDLINE],
  ["email", EMAIL],
  ["ntn", NTN],
  ["passport", PASSPORT],
  ["passport", PASSPORT_UNLABELLED],
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
 * Accepts every match of `re` in `units`: records its original span (moved past any trailing combining marks) and
 * blanks every unit whose original span overlaps it (so the units an NFKC expansion shares with it go too). Returns
 * the number of matches.
 */
function take(original: string, units: Units, re: RegExp, kind: RedactionKind, spans: Span[]): number {
  const view = units.view
  const text = units.text()
  let count = 0
  for (const m of text.matchAll(re)) {
    const first = m.index
    const last = first + m[0].length - 1
    const start = view.start[first]!
    const end = pastMarks(original, view.end[last]!)
    let from = first
    while (from > 0 && view.end[from - 1]! > start) from -= 1
    let to = last
    while (to + 1 < units.length && view.start[to + 1]! < end) to += 1
    units.blank(from, to)
    spans.push({ start, end, kind })
    count += 1
  }
  return count
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

export function maskOutboundPII(text: string, options: MaskOptions = {}): MaskResult {
  const counts: Record<RedactionKind, number> = { cnic: 0, phone: 0, party: 0, email: 0, iban: 0, ntn: 0, passport: 0 }
  const spans: Span[] = []

  // 1. The identifier patterns, on the detection view.
  const detection = new Units(detectionView(text))
  for (const [kind, re] of PATTERNS) counts[kind] += take(text, detection, re, kind, spans)

  // 2. The party names, on the name view of what the patterns left.
  const names = namePatterns(options.partyNames ?? [])
  if (names.length > 0) {
    const blanked: TextView = { text: detection.text(), start: detection.view.start, end: detection.view.end }
    const units = new Units(nameView(blanked))
    for (const re of names) counts.party += take(text, units, re, "party", spans)
  }

  // 3. The original text with each accepted span replaced by its token; spans that share an original code point (only
  // possible inside one NFKC expansion) are merged into the earlier token.
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  let masked = ""
  let at = 0
  for (const span of spans) {
    if (span.start < at) {
      at = Math.max(at, span.end)
      continue
    }
    masked += text.slice(at, span.start) + TOKEN[span.kind]
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
