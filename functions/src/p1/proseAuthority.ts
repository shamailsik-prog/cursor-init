/**
 * Authority-like mentions in the prose of a committee answer (audit F17, re-audit round, spec ruling R7a).
 *
 * The D4 extractor (`extractCitations`) reads the reported Pakistani citation shapes and flags its own suspects; it does
 * not see a foreign or other law report ("(2099) 3 SCC 777", "[2099] 2 WLR 777"), a short case or petition number
 * ("C.A. 777/2099"), a case name ("Haris Qalbani v. Omer Daryani", the Urdu "... بنام ...") or a page-only reference
 * ("the 2099 judgment ... at page 7777"). Grounding runs this after the extractor over every prose field: each mention
 * that does not resolve to, or is not bound to, a VERIFIED citation becomes an UNRECOGNISED suspect. It fails safe: a
 * false positive only makes an answer advisory, a false negative is the bug. It does not change the D4 gate.
 *
 * Linear time: one tokenising pass, and regexes whose every repetition is bounded and unambiguous (each start position
 * does bounded work); functions/test/f17-prose-authority.time-budget.test.ts holds it to a budget on 64 KB of each
 * adversarial shape.
 */

export type MentionFamily = "report" | "case_number" | "case_name" | "page" | "reported_phrase"

/** One mention: its span in the field (UTF-16 offsets), its text, and for a page reference where its page phrase starts. */
export type AuthorityMention = { family: MentionFamily; start: number; end: number; focus: number; raw: string }

/** A VERIFIED citation's span in the same field (a `report` mention whose canonical citation resolved VERIFIED). */
export type VerifiedSpan = { start: number; end: number }

const YEAR = "(?:1[6-9]|20)\\d{2}"
/** A reporter or court abbreviation token: a capital, then up to 14 letters, dots or ampersands ("SCC", "All", "Civ", "S.C.M.R."). */
const ABBR = "\\p{Lu}[\\p{L}.&]{0,14}"
/** A token starting with at least two capitals ("SCMR", "AIR", "P.Cr.L.J."): a reporter, never an ordinary word ("In", "The"). */
const CAPS = "\\p{Lu}[\\p{Lu}.&]{0,12}\\p{Lu}[\\p{L}.&]{0,12}"
/** A bracketed sub-series or court ("(AD)", "(CS)", "(AJ&K)", "(Admin)"). */
const PAREN = "\\(\\s{0,2}[\\p{L}.&]{1,15}(?:\\s{1,2}[\\p{L}.&]{1,15}){0,2}\\s{0,2}\\)"
const PAGE_NUMBER = "\\d{1,6}(?!\\p{N})"

const REPORT_SHAPES: readonly RegExp[] = [
  // "(2099) 3 SCC 777", "[2099] 2 WLR 777", "[2099] 1 All ER 777", "[2099] EWCA Civ 77", "(2099) 77 DLR (AD) 77", "[2099] UKSC 77"
  new RegExp(`(?<![\\p{L}\\p{N}])[(\\[]\\s{0,2}${YEAR}\\s{0,2}[)\\]]\\s{0,3}(?:\\d{1,4}\\s{1,3})?${ABBR}(?:\\s{1,3}${ABBR}){0,3}(?:\\s{0,3}${PAREN})?\\s{0,3}${PAGE_NUMBER}`, "gu"),
  // "2099 SCC 777", "2099 SCMR 7777", "2099 PLC (CS) 77", "2099 EWCA Civ 77"
  new RegExp(`(?<![\\p{L}\\p{N}])${YEAR}\\s{1,3}(?:\\d{1,4}\\s{1,3})?${CAPS}(?:\\s{1,3}${ABBR}){0,3}(?:\\s{0,3}${PAREN})?\\s{1,3}${PAGE_NUMBER}`, "gu"),
  // "AIR 2099 SC 777", "PLD 2099 SC 101", "PLD 2099 Lahore 77", "PLD 2099 SC (AJ&K) 1", "PLD 2099 S. C. 101"
  new RegExp(`(?<![\\p{L}\\p{N}])${CAPS}\\s{0,3}[(\\[]?${YEAR}[)\\]]?\\s{1,3}(?:${ABBR}\\s{1,3}){0,3}(?:${PAREN}\\s{0,3})?${PAGE_NUMBER}`, "gu"),
  // "77 DLR (2099) 77"
  new RegExp(`(?<![\\p{L}\\p{N}])\\d{1,4}\\s{1,3}${CAPS}(?:\\s{1,3}${ABBR}){0,2}\\s{0,3}[(\\[]${YEAR}[)\\]]\\s{0,3}${PAGE_NUMBER}`, "gu"),
]

/** Case and petition types, with or without dots and spaces ("C.A.", "Crl. P.", "ICA", "Suo Motu Case", "Writ Petition"). */
const CASE_TYPES = [
  "C\\.?\\s?P\\.?\\s?L\\.?\\s?A\\.?",
  "C\\.?\\s?M\\.?\\s?A\\.?",
  "C\\.?\\s?A\\.?",
  "C\\.?\\s?P\\.?",
  "C\\.?\\s?R\\.?",
  "Civil\\s{1,3}(?:Appeal|Petition|Revision|Misc(?:ellaneous)?\\.?(?:\\s{1,3}Application)?)",
  "Cr(?:l|iminal)?\\.?\\s?(?:A(?:ppeal)?|P(?:etition)?|R(?:ev(?:ision)?)?|M(?:isc)?|J\\.?\\s?A|B\\.?\\s?A|Bail(?:\\s{1,3}Appln?)?)\\.?",
  "W\\.?\\s?P\\.?",
  "Writ\\s{1,3}Petition",
  "I\\.?\\s?C\\.?\\s?A\\.?",
  "Intra\\s{1,3}Court\\s{1,3}Appeal",
  "S\\.?\\s?M\\.?\\s?C\\.?",
  "Suo\\s{1,3}Motu(?:\\s{1,3}Case)?",
  "R\\.?\\s?F\\.?\\s?A\\.?",
  "R\\.?\\s?S\\.?\\s?A\\.?",
  "F\\.?\\s?A\\.?\\s?O\\.?",
  "Const(?:itution(?:al)?)?\\.?\\s?P(?:etition|\\.)?",
  "H\\.?\\s?C\\.?\\s?A\\.?",
  "H\\.?\\s?R\\.?\\s?C\\.?",
  "Human\\s{1,3}Rights\\s{1,3}Case",
  "J\\.?\\s?M\\.?",
  "Suit",
  "Reference",
  "Appeal",
  "Petition",
  "Application",
  "Case",
].join("|")

/** "C.A. 777/2099", "Crl. P. No. 77 of 2099", "Civil Petition No.7777-L of 2099", "No. 7 of 2099", "مقدمہ نمبر 7 سال 2099". */
const CASE_NUMBER = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:(?:${CASE_TYPES})\\s{0,3}(?:Nos?\\.?\\s{0,3})?|Nos?\\.?\\s{0,3}|نمبر\\s{0,3})(?:\\p{L}{1,2}\\s?-\\s?)?\\d{1,6}(?:\\s?-\\s?\\p{L}{1,2})?\\s{0,3}(?:of|/|سال|بابت)\\s{0,3}\\d{4}(?!\\p{N})`,
  "giu"
)

/**
 * A page phrase ("at page 7777", "p. 77", "pp. 7", "Page 7777"; the Urdu "صفحہ 7777"). Case-sensitive for "p.": the
 * capital "P." is a case type ("Crl. P.", "W.P."), never a page.
 */
const PAGE = /(?<![\p{L}\p{N}])(?:(?:[Aa]t\s{1,3})?(?:[Pp]ages?|[Pp]g\.?|pp?\.)\s{0,3}\d{1,6}|صفحہ\s{0,3}(?:نمبر\s{0,3})?\d{1,6})(?!\p{N})/gu
/** A word naming a judgment or a law report, which makes a page phrase within PAGE_CUE_WINDOW characters a reference. */
const PAGE_CUE = /(?<![\p{L}])(?:judg(?:e)?ments?|reported|law\s{1,3}reports?|rulings?|precedents?|فیصل[ہے]|نظیر)(?![\p{L}])/giu
const PAGE_CUE_WINDOW = 100
/** "reported at/in/as", a mention only when a year or a page follows within REPORTED_WINDOW characters. */
const REPORTED = /(?<![\p{L}])reported\s{1,3}(?:at|in|as)(?![\p{L}])/giu
const REPORTED_WINDOW = 60
const REPORTED_TARGET = new RegExp(`(?<![\\p{N}])${YEAR}(?![\\p{N}])|(?<![\\p{L}])(?:pages?|pg\\.?|pp?\\.|volume|vol\\.)(?![\\p{L}])|صفحہ`, "iu")
const ANY_YEAR = new RegExp(`(?<![\\p{N}])${YEAR}(?![\\p{N}])`, "u")

/** Tokens: a mask placeholder ("[PARTY]"), a word (letters, marks, digits, apostrophes, dots, hyphens, ampersands) or one other character. */
const TOKEN = /\[[A-Z][A-Z_]{1,15}\]|(?<![\p{L}\p{N}])[vV]\/[sS]\.?(?![\p{L}\p{N}])|[\p{L}\p{M}\p{N}'’.&-]+|[^\s\p{L}\p{M}\p{N}'’.&-]/gu
type Token = { start: number; end: number; text: string }

const RE_PLACEHOLDER = /^\[[A-Z][A-Z_]{1,15}\]$/u
const RE_LATIN_CAPITAL = /^(?=\p{Lu})\p{Script=Latin}/u
const RE_OTHER_LETTER = /^(?=\p{L})\P{Script=Latin}/u
const RE_WORD = /^[\p{L}\p{M}]/u
const EN_CONNECTORS = new Set(["v", "v.", "vs", "vs.", "v/s", "v/s.", "versus"])
const UR_CONNECTOR = "بنام"
const JOINERS = new Set(["of", "and", "the", "&", "through"])
/** Tokens a case name takes on each side of its connector. */
const NAME_TOKENS = 6
/** Urdu has no capitals: a name takes at most two tokens before "بنام" and three after, and stops at a function word. */
const UR_NAME_TOKENS_BEFORE = 2
const UR_NAME_TOKENS_AFTER = 3
const UR_STOP_WORDS = new Set(["میں", "نے", "کے", "کا", "کی", "کو", "سے", "پر", "یہ", "وہ", "اور", "ہے", "ہیں", "ہوا", "تھا", "کہ", "جو", "جس", "اس", "ان", "مقدمہ", "مقدمے", "فیصلہ", "فیصلے"])

const isName = (t: Token | undefined): boolean => t !== undefined && (RE_PLACEHOLDER.test(t.text) || RE_LATIN_CAPITAL.test(t.text))
const isWord = (t: Token | undefined): boolean => t !== undefined && (RE_PLACEHOLDER.test(t.text) || RE_WORD.test(t.text))
const isUrduName = (t: Token | undefined): boolean => t !== undefined && !UR_STOP_WORDS.has(t.text) && (RE_OTHER_LETTER.test(t.text) || isName(t))

function tokens(prose: string): Token[] {
  const out: Token[] = []
  for (const m of prose.matchAll(TOKEN)) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
  return out
}

/** The end of a name's last token, without a sentence's full stop ("Daryani." ends before the dot; "Ltd." too). */
function nameEnd(t: Token): number {
  return t.text.length > 3 && t.text.endsWith(".") && /\p{Ll}/u.test(t.text) ? t.end - 1 : t.end
}

/**
 * English case names: up to NAME_TOKENS capitalised tokens (or joiners between them) on each side of "v.", "vs",
 * "versus". A name ends where a report-shaped citation starts ("Qalvo v. Nura PLD 2099 SC 101": the name is "Qalvo v.
 * Nura"), so the citation can bind it.
 */
function englishName(toks: Token[], i: number, reportStarts: ReadonlySet<number>): [number, number] | null {
  let first = i
  for (let j = i - 1, n = 0; j >= 0 && n < NAME_TOKENS; j -= 1, n += 1) {
    const t = toks[j]!
    if (isName(t) || (JOINERS.has(t.text.toLowerCase()) && isName(toks[j - 1]) && first < i)) first = j
    else break
  }
  if (first === i) {
    if (!isWord(toks[i - 1])) return null
    first = i - 1
  }
  while (first < i - 1 && JOINERS.has(toks[first]!.text.toLowerCase())) first += 1
  let last = i
  for (let j = i + 1, n = 0; j < toks.length && n < NAME_TOKENS && !reportStarts.has(toks[j]!.start); j += 1, n += 1) {
    const t = toks[j]!
    if (isName(t) || (JOINERS.has(t.text.toLowerCase()) && isName(toks[j + 1]))) last = j
    else break
  }
  if (last === i) {
    if (!isWord(toks[i + 1]) || reportStarts.has(toks[i + 1]!.start)) return null
    last = i + 1
  }
  return [first, last]
}

/** Urdu case names: letter tokens (any script but Latin lower case, no function word) on each side of "بنام". */
function urduName(toks: Token[], i: number, reportStarts: ReadonlySet<number>): [number, number] | null {
  let first = i
  for (let j = i - 1; j >= 0 && i - j <= UR_NAME_TOKENS_BEFORE && isUrduName(toks[j]); j -= 1) first = j
  let last = i
  for (let j = i + 1; j < toks.length && j - i <= UR_NAME_TOKENS_AFTER && isUrduName(toks[j]) && !reportStarts.has(toks[j]!.start); j += 1) last = j
  return first === i || last === i ? null : [first, last]
}

function nameMentions(prose: string, toks: Token[], reportStarts: ReadonlySet<number>): AuthorityMention[] {
  const out: AuthorityMention[] = []
  const push = (first: number, last: number) => {
    const start = toks[first]!.start
    const end = nameEnd(toks[last]!)
    out.push({ family: "case_name", start, end, focus: start, raw: prose.slice(start, end) })
  }
  for (let i = 0; i < toks.length; i += 1) {
    const text = toks[i]!.text
    const lower = text.toLowerCase()
    if (EN_CONNECTORS.has(lower)) {
      const span = englishName(toks, i, reportStarts)
      if (span) push(span[0], span[1])
    } else if (text === UR_CONNECTOR) {
      const span = urduName(toks, i, reportStarts)
      if (span) push(span[0], span[1])
    } else if (lower === "the") {
      // "the Qalvo case": "the", one to three names, "case".
      let j = i + 1
      while (j < toks.length && j - i <= 3 && isName(toks[j])) j += 1
      if (j > i + 1 && toks[j]?.text.toLowerCase() === "case") push(i, j)
    } else if (text === "(" || text === "[") {
      // "Qalvo (supra)": a name, then "(supra)".
      if ((isName(toks[i - 1]) || isUrduName(toks[i - 1])) && toks[i + 1]?.text.toLowerCase() === "supra" && (toks[i + 2]?.text === ")" || toks[i + 2]?.text === "]")) {
        const start = toks[i - 1]!.start
        const end = toks[i + 2]!.end
        out.push({ family: "case_name", start, end, focus: start, raw: prose.slice(start, end) })
      }
    }
  }
  return out
}

function regexMentions(prose: string, re: RegExp, family: MentionFamily): AuthorityMention[] {
  const out: AuthorityMention[] = []
  for (const m of prose.matchAll(re)) out.push({ family, start: m.index, end: m.index + m[0].length, focus: m.index, raw: m[0] })
  return out
}

/** Report shapes, each match kept unless it overlaps one that starts earlier (or is longer at the same start). */
function reportMentions(prose: string): AuthorityMention[] {
  const all = REPORT_SHAPES.flatMap((re) => regexMentions(prose, re, "report")).sort((a, b) => a.start - b.start || b.end - a.end)
  const out: AuthorityMention[] = []
  for (const m of all) {
    const last = out[out.length - 1]
    if (last === undefined || m.start >= last.end) out.push(m)
  }
  return out
}

/** Page phrases with a cue (a judgment or law report) within PAGE_CUE_WINDOW characters: the nearest one before, else after. */
function pageMentions(prose: string): AuthorityMention[] {
  const cues = regexMentions(prose, PAGE_CUE, "page")
  const out: AuthorityMention[] = []
  let c = 0
  for (const p of regexMentions(prose, PAGE, "page")) {
    while (c < cues.length && cues[c]!.end <= p.start) c += 1
    const before = c > 0 ? cues[c - 1]! : undefined
    const after = cues[c] !== undefined && cues[c]!.start >= p.end ? cues[c] : undefined
    if (before !== undefined && p.start - before.end <= PAGE_CUE_WINDOW) {
      out.push({ family: "page", start: before.start, end: p.end, focus: p.start, raw: prose.slice(before.start, p.end) })
    } else if (after !== undefined && after.start - p.end <= PAGE_CUE_WINDOW) {
      out.push({ family: "page", start: p.start, end: after.end, focus: p.start, raw: prose.slice(p.start, after.end) })
    }
  }
  return out
}

function reportedMentions(prose: string): AuthorityMention[] {
  return regexMentions(prose, REPORTED, "reported_phrase").filter((m) => REPORTED_TARGET.test(prose.slice(m.end, m.end + REPORTED_WINDOW)))
}

/** Every authority-like mention in one prose field, in order of start. */
export function authorityMentions(prose: string): AuthorityMention[] {
  const reports = reportMentions(prose)
  return [
    ...reports,
    ...regexMentions(prose, CASE_NUMBER, "case_number"),
    ...nameMentions(prose, tokens(prose), new Set(reports.map((r) => r.start))),
    ...pageMentions(prose),
    ...reportedMentions(prose),
  ].sort((a, b) => a.start - b.start || b.end - a.end)
}

/**
 * What binds a case name or number to the VERIFIED citation right after it: blanks, at most one comma, an optional
 * "reported as/at/in", and at most one opening bracket ("Qalvo v. Nura (PLD 2099 SC 101)", "Qalvo v. Nura, PLD 2099 SC 101").
 * A name never binds to a citation before it: the D4 extractor reads "(Qalvo v. Nura)" after a page as a sub-series.
 */
const NAME_GAP = /^\s{0,3}(?:,\s{0,3})?(?:reported\s{1,3}(?:as|at|in)\s{1,3})?[(\[]?\s{0,2}$/iu
/** What binds a page phrase to the VERIFIED citation right before it ("PLD 2099 SC 101 at page 105", "..., p. 105"). */
const PAGE_GAP = /^\s{0,3}(?:,\s{0,3})?$/u
/** What binds "reported at/in/as" to the VERIFIED citation right after it. */
const REPORTED_GAP = /^\s{0,3}$/u

export type BindingOptions = {
  /** The field is the pinpoint of a claim authority that resolved VERIFIED: a page phrase in it is that judgment's page. */
  pinpointOfVerified?: boolean
}

/**
 * The non-report mentions of a field that are not bound to a VERIFIED citation (ruling R7a), each kept once (a mention
 * overlapping one already kept is the same reference). A case name or number binds to the VERIFIED citation right after
 * it, and each citation binds at most one; a page phrase binds to the VERIFIED citation right before it, or, in the
 * pinpoint of a VERIFIED authority that names no year, to that authority; "reported at/in/as" binds to the VERIFIED
 * citation right after it. `verified` is in order of start.
 */
export function unboundMentions(prose: string, mentions: readonly AuthorityMention[], verified: readonly VerifiedSpan[], options: BindingOptions = {}): AuthorityMention[] {
  const used = new Set<number>()
  /** The first VERIFIED span starting at or after `at` (binary search). */
  const nextFrom = (at: number): number => {
    let lo = 0
    let hi = verified.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (verified[mid]!.start < at) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const pinpointPages = options.pinpointOfVerified === true && !ANY_YEAR.test(prose)
  const out: AuthorityMention[] = []
  for (const m of mentions) {
    if (m.family === "report") continue
    let bound = false
    if (m.family === "case_name" || m.family === "case_number") {
      const k = nextFrom(m.end)
      const span = verified[k]
      if (span !== undefined && !used.has(k) && NAME_GAP.test(prose.slice(m.end, span.start))) {
        used.add(k)
        bound = true
      }
    } else if (m.family === "reported_phrase") {
      const span = verified[nextFrom(m.end)]
      bound = span !== undefined && REPORTED_GAP.test(prose.slice(m.end, span.start))
    } else {
      const k = nextFrom(m.focus) - 1
      const span = k >= 0 ? verified[k] : undefined
      bound = pinpointPages || (span !== undefined && span.end <= m.focus && PAGE_GAP.test(prose.slice(span.end, m.focus)))
    }
    if (bound) continue
    const last = out[out.length - 1]
    if (last !== undefined && m.start < last.end) continue
    out.push(m)
  }
  return out
}
