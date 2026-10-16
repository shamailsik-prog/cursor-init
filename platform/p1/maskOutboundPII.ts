/**
 * P1 outbound (and inbound) mask (Job F / Erratum O-13; audit F15).
 * The masked body is the only text that may leave the firm toward a provider.
 * Classification never appears in the provider prompt.
 *
 * Masking reduces risk; it is not anonymisation. What it masks: CNICs, Pakistani mobiles, emails, PK IBANs, NTNs and
 * passports in any digit script (full-width, Arabic-Indic, Urdu, Devanagari, ...), with any dash or space variant, and
 * through invisible characters (zero-width spaces and joiners, directional marks, soft hyphens); and the party names
 * the caller supplies, through case, spacing, diacritics and Arabic letter variants. What it does not catch:
 *   - names nobody supplied, written in free prose (there is no auto-NER: masking "Ali"/"Khan" everywhere would
 *     destroy legal prose, so callers must pass partyNames);
 *   - semantic identifying facts ("the only female sessions judge in the district");
 *   - addresses, parentage and landlines (`residualPII` detects the common forms; at rank 3 and above
 *     `assertMinimised` then blocks the call, below it they are counted, not masked);
 *   - identifiers written in words or with look-alike letters ("O3OO" for "0300"), or split by multi-character
 *     separators ("0300 - 123 - 4567");
 *   - a zero-width character between a word and an identifier removes the word boundary a pattern needs
 *     ("CNIC​3520212345671"); `residualPII` still counts the digits.
 *
 * How (spec docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md, rulings 1 to 3): every pattern runs
 * on the detection view (`detectionView`), the names on its folded name view (`nameView`), in one pass; each match is
 * mapped back to its span in the original text and only that span is replaced, so every unmatched code unit of the
 * original is sent exactly as written.
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

const CNIC_SEPARATED = /\b\d{5}[.\-\s]+\d{7}[.\-\s]+\d\b/g
const CNIC_PLAIN = /\b\d{13}\b/g
// Pakistani mobile: 03XXXXXXXXX / 0300-1234567 / +92 300 1234567 / (0300) 1234567
const PK_MOBILE = /(?:\+92|92|0)[.\s-]?3\d{2}[.\s-]?\d{7}\b/g
const PK_MOBILE_PAREN = /\(0?3\d{2}\)[.\s-]?\d{7}\b/g
// Anchored at the start of a run of local-part characters (audit F15): main's `\b`-anchored form restarted inside
// every run and backtracked quadratically (a 32,000-character run of "1-" took 1.25 s; 100,000 characters, ~12 s).
const EMAIL = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const PK_IBAN = /\bPK\s*\d{2}\s*[A-Z]{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\b/gi
const NTN = /\bNTN[:\s-]*\d{7}-\d\b/gi
const PASSPORT = /\b(?:passport|ppt\.?)[:\s-]*[A-Z]{2}\d{7}\b/gi

/** The patterns in priority order (main's order): an earlier pattern's match is never seen by a later one. */
const PATTERNS: ReadonlyArray<[RedactionKind, RegExp]> = [
  ["cnic", CNIC_SEPARATED],
  ["cnic", CNIC_PLAIN],
  ["phone", PK_MOBILE_PAREN],
  ["phone", PK_MOBILE],
  ["email", EMAIL],
  ["iban", PK_IBAN],
  ["ntn", NTN],
  ["passport", PASSPORT],
]

/** Written over an accepted match in a view: no pattern or name can match it. */
const BLANK = ""

type Span = { start: number; end: number; kind: RedactionKind }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Accepts every match of `re` in `view`: records its original span and blanks, in `units`, every unit whose original
 * span overlaps it (so the units an NFKC expansion shares with it go too). Returns the number of matches.
 */
function take(view: TextView, units: string[], re: RegExp, kind: RedactionKind, spans: Span[]): number {
  const text = units.join("")
  let count = 0
  for (const m of text.matchAll(re)) {
    const first = m.index
    const last = first + m[0].length - 1
    const start = view.start[first]!
    const end = view.end[last]!
    let from = first
    while (from > 0 && view.end[from - 1]! > start) from -= 1
    let to = last
    while (to + 1 < units.length && view.start[to + 1]! < end) to += 1
    for (let k = from; k <= to; k++) units[k] = BLANK
    spans.push({ start, end, kind })
    count += 1
  }
  return count
}

/** A view's units as an array, so accepted matches can be blanked in place (each unit is one UTF-16 code unit). */
const unitsOf = (view: TextView): string[] => view.text.split("")

/**
 * The supplied names as patterns on the name view (ruling 3): folded, de-duplicated, longest first (ties in code-unit
 * order); each whitespace run of a name matches any whitespace run in the text, or none.
 */
function namePatterns(partyNames: string[]): RegExp[] {
  const folded = new Set<string>()
  for (const name of partyNames) {
    const f = foldName(name).split(BLANK).join("")
    if (f !== "") folded.add(f)
  }
  return [...folded]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .map((f) => new RegExp(f.split(" ").map(escapeRegExp).join("\\s*"), "gu"))
}

export function maskOutboundPII(text: string, options: MaskOptions = {}): MaskResult {
  const counts: Record<RedactionKind, number> = { cnic: 0, phone: 0, party: 0, email: 0, iban: 0, ntn: 0, passport: 0 }
  const spans: Span[] = []

  // 1. The identifier patterns, on the detection view.
  const detection = detectionView(text)
  const detectionUnits = unitsOf(detection)
  for (const [kind, re] of PATTERNS) counts[kind] += take(detection, detectionUnits, re, kind, spans)

  // 2. The party names, on the name view of what the patterns left.
  const names = namePatterns(options.partyNames ?? [])
  if (names.length > 0) {
    const blanked: TextView = { text: detectionUnits.join(""), start: detection.start, end: detection.end }
    const view = nameView(blanked)
    const units = unitsOf(view)
    for (const re of names) counts.party += take(view, units, re, "party", spans)
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
