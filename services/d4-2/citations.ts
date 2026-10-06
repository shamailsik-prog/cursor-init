/**
 * Module 33 — extractCitations: pull every reported Pakistani authority out of a draft, and
 * fail closed on anything that looks like an authority but cannot be read exactly.
 *
 * v6 Module 33: "Every citation/statute extracted from a draft and cross-checked against
 * master tables." E-22: "approval blocked on any non-VERIFIED result."
 *
 * Pipeline (review fix round 1, finding 1):
 *   1. Normalise: NFKC (full-width digits/letters), strip \p{Cf} (zero-width and format
 *      characters). Mixed-script tokens (Latin + another script, e.g. a Cyrillic "С" inside
 *      "SCMR") are never mapped — they become UNRECOGNISED suspects (fail closed).
 *   2. Strict extractor: reporter-first (PLD, PLJ, NLR, KLR) and year-first (SCMR, SCR, CLC,
 *      YLR, MLD, PCrLJ, PTD, PTCL, CLD, PLC, GBLR, PLJ, NLR, KLR) forms, dotted or spaced
 *      abbreviations ("S.C.M.R.", "P.Cr.L.J.", "S C M R"), "(yyyy)" / "[yyyy]" years and
 *      "-page" pages. A match immediately followed by more digits or an alphanumeric suffix
 *      ("PLD 2019 SC 12 3", "1234-A") is ambiguous and is not accepted.
 *   3. Sub-series are part of the canonical key and never dropped: "2019 PLC(CS) 77",
 *      "PLD 2019 SC(AJ&K) 1". Only a recognised *court* in brackets on a continuously
 *      paginated reporter (SCMR, CLC, YLR, …) is informational and dropped.
 *   4. Broad detector: a year next to an abbreviation-like token and a number (either order,
 *      any script), glued forms ("2020SCMR456"), and case references ("C.P. No. 12 of 2019").
 *      Any hit not covered by a strict match becomes an UNRECOGNISED ref, which the gate
 *      reports as UNVERIFIED (blocking; only a partner override clears it).
 *
 * Reporter list: ported from corpus_service/scraper/parsers/citation_extractor.py and
 * corpus_service/scraper/models.py, plus PLJ, NLR, KLR and SCR. PLD court canonicals follow
 * data/courts.json: Karachi and Sindh are one court (SHC); Balochistan / Bal. / Quetta are one
 * court (BHC).
 */

/** Prefix for a suspected authority the strict extractor could not read. Never resolvable. */
import { digitRunTainted, foldDraftText, type FoldedText } from "@/services/d4-2/citationFold"

export const UNRECOGNISED_PREFIX = "UNRECOGNISED: "

export function isUnrecognisedRef(ref: string): boolean {
  return ref.startsWith(UNRECOGNISED_PREFIX)
}

/**
 * Category-driven folding (services/d4-2/citationFold.ts, review round 2 N1): NFKD, marks and
 * ignorables dropped, every Nd digit to ASCII, every dash to "-", every blank to " ", markup
 * stripped. Kept for callers that only need the folded text.
 */
export function normaliseDraftText(text: string): string {
  return foldDraftText(text).text
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** An abbreviation whose letters may be dotted and/or single-spaced: S.C.M.R. / S C M R / SCMR. */
function flex(abbrev: string): string {
  return (
    [...abbrev].map((ch) => (ch === "&" ? "\\s?&\\s?" : escapeRe(ch))).join("[.\\s]{0,2}") + "\\.?"
  )
}

const COURTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["SC", ["Supreme\\s+Court(?:\\s+of\\s+Pakistan)?", flex("SC")]],
  ["FSC", ["Federal\\s+Shariat\\s+Court", flex("FSC")]],
  ["Lahore", ["Lahore(?:\\s+High\\s+Court)?", "Lah\\.?", flex("LHC")]],
  ["Sindh", ["Sindh(?:\\s+High\\s+Court)?", "Karachi", "Kar\\.?", flex("SHC")]],
  ["Peshawar", ["Peshawar(?:\\s+High\\s+Court)?", "Pesh\\.?", flex("PHC")]],
  ["Quetta", ["Balochistan(?:\\s+High\\s+Court)?", "Quetta", "Bal\\.?", flex("BHC")]],
  ["Islamabad", ["Islamabad(?:\\s+High\\s+Court)?", "Isl\\.?", flex("IHC")]],
  ["AJ&K", ["Azad\\s+Jammu\\s+(?:and|&)\\s+Kashmir", "Azad\\s+J\\s?&\\s?K", flex("AJ&K"), flex("AJK")]],
  ["GB", ["Gilgit[-\\s]Baltistan", flex("GB")]],
  // NLR sections
  ["Civil", ["Civil"]],
  ["Criminal", ["Criminal", "Crl\\.?"]],
  ["Tax", ["Tax"]],
  ["Revenue", ["Revenue"]],
]

const COURT_ALTERNATION = COURTS.flatMap(([, alts]) => alts).join("|")

function canonicalCourt(raw: string): string | null {
  const trimmed = raw.trim()
  for (const [canonical, alts] of COURTS) {
    for (const alt of alts) {
      if (new RegExp(`^(?:${alt})$`, "iu").test(trimmed)) return canonical
    }
  }
  return null
}

/** Canonical key for a bracketed sub-series or court: court canonical, else letters only. */
function canonicalParen(raw: string): string {
  return canonicalCourt(raw) ?? raw.replace(/[.\s]/g, "").toUpperCase()
}

// Reporters whose pagination is continuous per year: a bracketed court is informational.
const CONTINUOUS = new Set(["SCMR", "SCR", "CLC", "YLR", "MLD", "PCrLJ", "PTD", "PTCL", "CLD", "GBLR"])
// Reporters also written court/section-first ("PLJ 2015 SC 100").
const SECTIONED = new Set(["PLJ", "NLR", "KLR"])
// Trailing notes that never identify an authority.
const NOTES = new Set(["SUPRA", "IBID", "SIC", "EMPHASISSUPPLIED", "EMPHASISADDED"])

const REPORTERS: ReadonlyArray<readonly [string, string]> = [
  ["SCMR", flex("SCMR")],
  ["SCR", flex("SCR")],
  ["PCrLJ", flex("PCrLJ")],
  ["PTCL", flex("PTCL")],
  ["PTD", flex("PTD")],
  ["GBLR", flex("GBLR")],
  ["CLC", flex("CLC")],
  ["CLD", flex("CLD")],
  ["YLR", flex("YLR")],
  ["MLD", flex("MLD")],
  ["PLC", flex("PLC")],
  ["PLJ", flex("PLJ")],
  ["NLR", flex("NLR")],
  ["KLR", flex("KLR")],
]

function canonicalReporter(raw: string): string | null {
  for (const [canonical, pattern] of REPORTERS) {
    if (new RegExp(`^(?:${pattern})$`, "iu").test(raw.trim())) return canonical
  }
  return null
}

const NB = "(?<![\\p{L}\\p{N}])"
const NA = "(?![\\p{L}])"
const YEAR = "[(\\[]?((?:19|20)\\d{2})[)\\]]?"
const PAREN = "\\(\\s*([^()]{1,30}?)\\s*\\)"
const PAGE_SEP = "(?:\\s*-\\s*|\\s+)"
const PAGE = "(\\d+)"

const REPORTER_FIRST = new RegExp(
  `${NB}(${flex("PLD")}|${flex("PLJ")}|${flex("NLR")}|${flex("KLR")})\\s*,?\\s*${YEAR}\\s+(${COURT_ALTERNATION})${NA}(?:\\s*${PAREN})?${PAGE_SEP}${PAGE}`,
  "giu"
)

const YEAR_FIRST = new RegExp(
  `${NB}${YEAR}\\s*,?\\s*(${REPORTERS.map(([, p]) => p).join("|")})${NA}(?:\\s+(${COURT_ALTERNATION})${NA})?(?:\\s*${PAREN})?${PAGE_SEP}${PAGE}`,
  "giu"
)

// ---- broad (suspected-citation) detector -------------------------------------------------
const ABBR = "(?:\\p{Lu}{2,}[\\p{L}&]*|(?:\\p{L}{1,3}\\.\\s?){2,}|\\p{Lu}(?:\\s\\p{Lu}){1,4}(?!\\p{L}))"
const COURTISH = "(?:\\p{Lu}[\\p{L}.&]*)"
const BROAD_YEAR_FIRST = new RegExp(
  `(?<![\\p{N}])[(\\[]?(?:19|20)\\d{2}[)\\]]?\\s*[-,]?\\s*${ABBR}(?:\\s*${ABBR})?\\s*(?:\\([^()]{0,30}\\)\\s*)?(?:[-(\\[]\\s*|p\\.\\s*|at\\s+)?\\d+`,
  "gu"
)
const BROAD_GLUED = /(?<![\p{N}])(?:19|20)\d{2}\p{Lu}{2,}[\p{L}]*\d+/gu
const BROAD_REPORTER_FIRST = new RegExp(
  `(?<![\\p{L}])${ABBR}\\s*[(\\[]?(?:19|20)\\d{2}[)\\]]?\\s+(?:${COURTISH}\\s*){1,3}(?:\\([^()]{0,30}\\)\\s*)?(?:[-(\\[]\\s*)?\\d+`,
  "gu"
)
const CASE_REFERENCE = new RegExp(
  "(?<![\\p{L}])(?:" +
    [
      "C\\.?\\s?P\\.?(?:\\s?L\\.?\\s?A\\.?)?",
      "Civil\\s+(?:Petition|Appeal|Revision)",
      "C\\.?\\s?A\\.?",
      "C\\.?\\s?R\\.?",
      "Cr(?:l|iminal)?\\.?\\s*(?:A|Appeal|Misc|M|Rev|R|P|Petition|B\\.?\\s?A|Bail(?:\\s+Appln?)?)\\.?",
      "W\\.?\\s?P\\.?",
      "Writ\\s+Petition",
      "Const(?:itution(?:al)?)?\\.?\\s*P(?:etition|\\.)?",
      "Suit",
      "H\\.?\\s?C\\.?\\s?A\\.?",
      "I\\.?\\s?C\\.?\\s?A\\.?",
      "R\\.?\\s?F\\.?\\s?A\\.?",
      "R\\.?\\s?S\\.?\\s?A\\.?",
      "F\\.?\\s?A\\.?\\s?O\\.?",
      "J\\.?\\s?M\\.?",
      "S\\.?\\s?M\\.?\\s?C\\.?",
      "H\\.?\\s?R\\.?\\s?C\\.?",
      "Reference",
    ].join("|") +
    ")\\s*No[s]?\\.?\\s*[\\p{L}]?-?\\s*\\d+\\s*(?:of|/)\\s*(?:19|20)\\d{2}",
  "giu"
)

type Span = { start: number; end: number }
type StrictHit = Span & { citation: string }

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end
}

/** Rest-of-text after a match that makes the page ambiguous ("12 3", "1234-A", "123A", "1/2"). */
function ambiguousTail(rest: string): boolean {
  // Ambiguous (review R2 N1, R3 N9): a digit/letter glued on; digits after only blanks; anything
  // after a run of dashes/slashes ("12--34", "1/2"); a thousands-style separator — , . ' or a
  // right single quote — directly followed by a digit ("1,234", "1.234", "1'234"; the ", 1240"
  // pinpoint with a space stays a pinpoint); and any other glued character that is not a
  // closing punctuation mark ("1<b>234", "1#234", "1\u066c234").
  return /^(?:[\p{L}\p{N}]|\s*[-/][\s\-/]*[\p{L}\p{N}]|\s+\d|[,.'\u2019]\d|[^\s.,;:)\]'"\u201d\u2019!?>])/u.test(rest)
}

function trailingParen(rest: string): { length: number; key: string } | null {
  const m = /^\s*\(\s*([^()]{1,30}?)\s*\)/u.exec(rest)
  if (!m || m[1] === undefined) return null
  return { length: m[0].length, key: canonicalParen(m[1]) }
}

function finishHit(
  text: string,
  start: number,
  end: number,
  build: (trailing: string | null) => string | null
): StrictHit | null {
  let stop = end
  let trailingKey: string | null = null
  const paren = trailingParen(text.slice(end))
  if (paren) {
    stop = end + paren.length
    trailingKey = paren.key
  }
  if (ambiguousTail(text.slice(stop))) return null
  const citation = build(trailingKey)
  return citation ? { start, end: stop, citation } : null
}

/**
 * "<head>(<sub-series>) <page>". A sub-series written after the page ("2019 PLC 77 (C.S.)")
 * gets the same key as one written before it ("2019 PLC (C.S.) 77"); notes such as "supra"
 * are ignored; two different bracketed parts are both kept.
 */
function keyed(head: string, page: string, leading: string | null, trailing: string | null): string {
  const tail = trailing && !NOTES.has(trailing) ? trailing : null
  if (leading && tail && leading !== tail) return `${head}(${leading}) ${page} (${tail})`
  const sub = leading ?? tail
  return sub ? `${head}(${sub}) ${page}` : `${head} ${page}`
}

/**
 * Strict hits on folded text. A hit whose year/page digits had a removed mark or ignorable
 * between them is ambiguous (N1: never read a shorter page) and goes to `ambiguous`.
 */
function strictHits(folded: FoldedText, ambiguous: Array<Span & { raw: string }> = []): StrictHit[] {
  const text = folded.text
  const raw: StrictHit[] = []
  const hits = raw
  for (const m of text.matchAll(REPORTER_FIRST)) {
    const [whole, rawReporter, year, rawCourt, sub, page] = m
    if (!whole || !rawReporter || !year || !rawCourt || !page) continue
    const reporter = new RegExp(`^(?:${flex("PLD")})$`, "iu").test(rawReporter.trim())
      ? "PLD"
      : canonicalReporter(rawReporter)
    const court = canonicalCourt(rawCourt)
    if (!reporter || !court) continue
    const start = m.index ?? 0
    const hit = finishHit(text, start, start + whole.length, (trailing) =>
      keyed(`${reporter} ${year} ${court}`, page, sub ? canonicalParen(sub) : null, trailing)
    )
    if (hit) hits.push(hit)
  }
  for (const m of text.matchAll(YEAR_FIRST)) {
    const [whole, year, rawReporter, rawCourt, sub, page] = m
    if (!whole || !year || !rawReporter || !page) continue
    const reporter = canonicalReporter(rawReporter)
    if (!reporter) continue
    const court = rawCourt ? canonicalCourt(rawCourt) : null
    if (rawCourt && (!court || !SECTIONED.has(reporter))) continue
    const start = m.index ?? 0
    const hit = finishHit(text, start, start + whole.length, (trailing) => {
      if (court) {
        // "2015 PLJ SC 100" is the reporter-first "PLJ 2015 SC 100".
        return keyed(`${reporter} ${year} ${court}`, page, sub ? canonicalParen(sub) : null, trailing)
      }
      if (CONTINUOUS.has(reporter)) {
        // A bracketed court is informational on a continuously paginated reporter; anything
        // else in brackets is a sub-series and stays in the key. Trailing notes are dropped.
        const leading = sub && canonicalCourt(sub) === null ? canonicalParen(sub) : null
        return keyed(`${year} ${reporter}`, page, leading, null)
      }
      return keyed(`${year} ${reporter}`, page, sub ? canonicalParen(sub) : null, trailing)
    })
    if (hit) hits.push(hit)
  }
  return raw.filter((hit) => {
    if (!digitRunTainted(folded, hit.start, hit.end)) return true
    ambiguous.push({ start: hit.start, end: hit.end, raw: text.slice(hit.start, hit.end) })
    return false
  })
}

function mixedScriptTokens(text: string): Array<Span & { raw: string }> {
  const out: Array<Span & { raw: string }> = []
  for (const m of text.matchAll(/\S+/gu)) {
    const token = m[0]
    let latin = false
    let other = false
    for (const ch of token) {
      if (!/\p{L}/u.test(ch)) continue
      if (/\p{Script=Latin}/u.test(ch)) latin = true
      else other = true
    }
    if (latin && other) {
      const start = m.index ?? 0
      out.push({ start, end: start + token.length, raw: token })
    }
  }
  return out
}

export type CitationAnalysis = {
  /** Canonical citations the strict extractor read exactly, in order of first appearance. */
  citations: string[]
  /** Suspected authorities it could not read; each blocks as UNVERIFIED. */
  suspects: string[]
}

export type AnalyseOptions = {
  /** Case references that are the matter's own number (not an authority) are not suspects. */
  isOwnCaseReference?: (raw: string) => boolean
}

// ---- reporter-token fallback (N1) ---------------------------------------------------------
// Any known reporter token, in any folded form — dotted, spaced, hyphenated, glued to digits —
// with a digit within FALLBACK_WINDOW skeleton characters, that no strict hit covers, is a
// suspect. Stricter than "near a 4-digit year": any nearby number triggers it.
const REPORTER_TOKENS = ["SCMR", "PLD", "PLJ", "CLC", "YLR", "MLD", "PCrLJ", "PTD", "PTCL", "CLD", "PLC", "NLR", "KLR", "SCR", "GBLR"]
const FALLBACK_WINDOW = 20
// Reporter tokens that double as common acronyms (R3 item 6).
const ACRONYM_REPORTERS = new Set(["PLC", "CLC", "CLD", "PTD", "SCR", "KLR", "NLR", "YLR"])
const ACRONYM_YEAR_TOKENS = 4
const SKELETON_REPORTER = new RegExp(
  `(?<![\\p{L}])(?:${REPORTER_TOKENS.map((t) => [...t].join("\\s?")).join("|")})(?![\\p{L}])`,
  "giu"
)
// AIR (All India Reporter) only in capitals: "air" is an ordinary word.
const SKELETON_AIR = /(?<![\p{L}])A\s?I\s?R(?![\p{L}])/gu
// A reporter written in capitals glued to other letters on one side ("bPLD", "SCMRnbsp") still
// counts; capitals keep ordinary words ("script", "DESCRIPTION" — no boundary at all) out.
const UPPER_REPORTERS = REPORTER_TOKENS.map((t) => t.toUpperCase()).join("|")
const SKELETON_UPPER_GLUED = new RegExp(
  `(?:(?<![\\p{L}])(?:${UPPER_REPORTERS}|PCrLJ)|(?:${UPPER_REPORTERS}|PCrLJ)(?![\\p{L}]))`,
  "gu"
)

function reporterFallback(folded: FoldedText): Array<Span & { raw: string }> {
  const text = folded.text
  const skel: string[] = []
  const map: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? ""
    if (/[\p{L}\p{N}\s]/u.test(ch)) {
      const blank = /\s/.test(ch)
      // collapse runs of blanks: "PL  D" is "PL D"
      if (blank && skel[skel.length - 1] === " ") continue
      skel.push(blank ? " " : ch)
      map.push(i)
    }
  }
  const skeleton = skel.join("")
  const out: Array<Span & { raw: string }> = []
  for (const pattern of [SKELETON_REPORTER, SKELETON_AIR, SKELETON_UPPER_GLUED]) {
    for (const m of skeleton.matchAll(pattern)) {
      const ms = m.index ?? 0
      const me = ms + m[0].length
      const lo = Math.max(0, ms - FALLBACK_WINDOW)
      const hi = Math.min(skeleton.length, me + FALLBACK_WINDOW)
      if (!/[0-9]/.test(skeleton.slice(lo, ms) + skeleton.slice(me, hi))) continue
      // R3 item 6: tokens that double as common acronyms ("Engro … PLC paid Rs. 5", "the CLC
      // committee met on 5 May") need a 4-digit year within ACRONYM_YEAR_TOKENS skeleton tokens,
      // or digits within that distance on both sides (a split year "201 8 CLC 789").
      if (ACRONYM_REPORTERS.has(m[0].replace(/\s/g, "").toUpperCase())) {
        const before = skeleton.slice(0, ms).split(" ").filter(Boolean).slice(-ACRONYM_YEAR_TOKENS)
        const after = skeleton.slice(me).split(" ").filter(Boolean).slice(0, ACRONYM_YEAR_TOKENS)
        const nearYear = [...before, ...after].some((token) => /(?<![0-9])(?:19|20)[0-9]{2}(?![0-9])/.test(token))
        // A citation has numbers on both sides of the reporter (year and page); prose acronyms
        // have a number on one side. Digits glued to the token count as that side.
        const digitsBefore = /[0-9]/.test(skeleton[ms - 1] ?? "") || before.some((t) => /[0-9]/.test(t))
        const digitsAfter = /[0-9]/.test(skeleton[me] ?? "") || after.some((t) => /[0-9]/.test(t))
        if (!nearYear && !(digitsBefore && digitsAfter)) continue
      }
      const start = map[ms] ?? 0
      const end = (map[me - 1] ?? start) + 1
      const ctxStart = map[lo] ?? start
      const ctxEnd = (map[hi - 1] ?? end - 1) + 1
      out.push({ start, end, raw: text.slice(ctxStart, ctxEnd) })
    }
  }
  return out
}

// Generic case reference (N1): capitalised / dotted type words or a case keyword, "No.", a
// number (optionally "-K"), then of|/|- and a year. Statute references ("Act No. V of 2019",
// "S.R.O. No. …") are left to the statute follow-up and are not suspects here.
const CASE_TYPE_WORD =
  "(?:\\p{Lu}[\\p{L}&]*\\.?|(?:\\p{L}{1,4}\\.){1,6}\\p{L}{0,4}\\.?|(?:case|petition|appeal|application|reference|revision|review|suit|motion|bail|writ|original)(?![\\p{L}]))"
const CASE_REFERENCE_GENERIC = new RegExp(
  `(?<![\\p{L}])(?:${CASE_TYPE_WORD}\\s*){1,6}No[s]?\\.?\\s*\\p{L}?-?\\s*\\d+(?:\\s*-\\s*\\p{L}(?![\\p{L}]))?\\s*(?:of|/|-)\\s*(?:19|20)\\d{2}`,
  "gu"
)
// R3 N12: a "No. n of yyyy" is a statute reference only when the word *immediately* before
// "No." is a statute word. Bare "Order" is not one ("First Appeal from Order No. 12 of 2019" is a
// case); "Order-in-Council" is.
const STATUTE_WORD = /^(?:Act|Ordinance|Rules|Regulations?|S\.?R\.?O\.?|Notification|Order-in-Council)$/iu
const RE_NO_ANCHOR = /No[s]?\.?\s*\p{L}?-?\s*\d/u

function isStatuteReference(text: string, matchStart: number, match: string): boolean {
  const at = match.search(RE_NO_ANCHOR)
  if (at < 0) return false
  const before = text.slice(0, matchStart + at).trimEnd()
  const word = before.split(/\s+/).pop() ?? ""
  return STATUTE_WORD.test(word.replace(/^[("'\u201c]+|[,;:]+$/gu, ""))
}

// ---- Urdu script (R3 N11) ------------------------------------------------------------------
// Standard Urdu names of the Latin letters; reporter spellings are generated from the Latin
// reporter list (SCMR -> "ایس سی ایم آر"), so adding a reporter adds its Urdu spelling.
const URDU_LETTER_NAMES: Record<string, string> = {
  A: "اے", B: "بی", C: "سی", D: "ڈی", E: "ای", F: "ایف", G: "جی", H: "ایچ", I: "آئی",
  J: "جے", K: "کے", L: "ایل", M: "ایم", N: "این", O: "او", P: "پی", Q: "کیو", R: "آر",
  S: "ایس", T: "ٹی", U: "یو", V: "وی", W: "ڈبلیو", X: "ایکس", Y: "وائی", Z: "زیڈ",
}
export const URDU_REPORTER_SPELLINGS: Readonly<Record<string, string>> = Object.fromEntries(
  [...REPORTER_TOKENS, "AIR"].map((token) => [
    token,
    [...token.toUpperCase()].map((letter) => URDU_LETTER_NAMES[letter] ?? letter).join(" "),
  ])
)
const URDU_REPORTER = new RegExp(
  `(?<![\\p{L}])(?:${Object.values(URDU_REPORTER_SPELLINGS)
    .sort((a, b) => b.length - a.length)
    // match against folded text, so fold the spelling the same way (آ -> ا + dropped madda)
    .map((spelling) => foldDraftText(spelling).text.split(" ").map(escapeRe).join("[\\s.\\u200c-]*"))
    .join("|")})(?![\\p{L}])`,
  "gu"
)
// "<type words> نمبر n (بابت|آف|سال|سن|/|-) yyyy" — Urdu case references.
const URDU_CASE_REFERENCE = new RegExp(
  `(?:[\\p{Script=Arabic}.]+\\s+){0,4}${foldDraftText("نمبر").text}\\s*\\d+(?:\\s*-\\s*\\p{L})?\\s*(?:${["بابت", "آف", "سال", "سن"]
    .map((word) => foldDraftText(word).text)
    .join("|")}|\\/|-)\\s*(?:19|20)\\d{2}`,
  "gu"
)

function urduSuspects(folded: FoldedText): Array<Span & { raw: string }> {
  const text = folded.text
  const out: Array<Span & { raw: string }> = []
  for (const m of text.matchAll(URDU_REPORTER)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    const lo = Math.max(0, start - FALLBACK_WINDOW)
    const hi = Math.min(text.length, end + FALLBACK_WINDOW)
    if (!/[0-9]/.test(text.slice(lo, start) + text.slice(end, hi))) continue
    out.push({ start, end, raw: text.slice(lo, hi) })
  }
  for (const m of text.matchAll(URDU_CASE_REFERENCE)) {
    const start = m.index ?? 0
    out.push({ start, end: start + m[0].length, raw: m[0] })
  }
  return out
}

// ---- script-agnostic shape detector (R3 N10) ----------------------------------------------
// A year (folded, so any digit script), then 1-6 short letter tokens of any script, then a
// number. "Short letter token": for Latin, abbreviation-like (capitals, dotted letters, single
// letters, "Lah.") or containing any non-ASCII letter (small capitals, clicks…); for scripts
// without case (Urdu), at most 6 letters. Ordinary lowercase Latin words and "No."/"Nos."
// break the shape, so "In 2019 he paid 5 …" and "2019 FIR No. 45" are not suspects.
const SHAPE_MAX_TOKENS = 6
const RE_YEAR_TOKEN = /^[(\[]?(?:19|20)\d{2}[)\],.:;]?$/u
const RE_NUMBER_TOKEN = /^[(\[]?\d+/u
function isShortLetterToken(raw: string): boolean {
  const token = raw.replace(/^[(\[{"'\u201c\u2018]+|[)\]},;:"'\u201d\u2019]+$/gu, "")
  if (!token || /\d/.test(token)) return false
  if (/^nos?\.?$/iu.test(token)) return false
  const letters = [...token].filter((ch) => /\p{L}/u.test(ch))
  if (letters.length === 0) return false
  if (letters.some((ch) => /\p{Script=Latin}/u.test(ch))) {
    if (letters.some((ch) => (ch.codePointAt(0) ?? 0) >= 0x80)) return true
    if (/^[A-Z][A-Z&.]*\.?$/u.test(token) && letters.length <= 6) return true // SCMR, AJ&K, S.C.
    if (/^(?:[A-Za-z]\.){1,6}$/u.test(token)) return true // s.c.m.r.
    if (/^[A-Za-z]$/u.test(token)) return true // spaced letters
    if (/^[A-Z][a-z]{1,3}\.$/u.test(token)) return true // Lah., Pesh.
    if (/^[A-Z][A-Za-z]*[A-Z][A-Za-z]*$/u.test(token) && letters.length <= 6) return true // PCrLJ
    return false
  }
  return letters.length <= 6
}

function shapeSuspects(folded: FoldedText): Array<Span & { raw: string }> {
  const text = folded.text
  const tokens = [...text.matchAll(/\S+/gu)].map((m) => ({ raw: m[0], start: m.index ?? 0 }))
  const out: Array<Span & { raw: string }> = []
  for (let i = 0; i < tokens.length; i += 1) {
    const year = tokens[i]
    if (!year || !RE_YEAR_TOKEN.test(year.raw)) continue
    let j = i + 1
    while (j < tokens.length && j - i - 1 < SHAPE_MAX_TOKENS && isShortLetterToken(tokens[j]?.raw ?? "")) j += 1
    const count = j - i - 1
    const number = tokens[j]
    if (count >= 1 && number && RE_NUMBER_TOKEN.test(number.raw)) {
      const end = number.start + number.raw.length
      out.push({ start: year.start, end, raw: text.slice(year.start, end) })
    }
  }
  return out
}

/** The generic pattern may include leading capitalised prose ("In C.P. No. …"): try each word suffix. */
function isOwnCase(raw: string, options: AnalyseOptions): boolean {
  if (!options.isOwnCaseReference) return false
  const words = raw.split(/\s+/)
  for (let i = 0; i < words.length; i += 1) {
    if (options.isOwnCaseReference(words.slice(i).join(" "))) return true
  }
  return false
}

function analyse(
  folded: FoldedText,
  options: AnalyseOptions
): { accepted: StrictHit[]; suspects: Array<Span & { raw: string }> } {
  const text = folded.text
  const ambiguous: Array<Span & { raw: string }> = []
  const strict = strictHits(folded, ambiguous)
  const accepted: StrictHit[] = []
  for (const hit of strict.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (accepted.some((prev) => overlaps(prev, hit))) continue
    accepted.push(hit)
  }

  const suspects: Array<Span & { raw: string }> = []
  const addSuspect = (start: number, end: number, raw: string) => {
    if (accepted.some((hit) => overlaps(hit, { start, end }))) return
    if (suspects.some((s) => overlaps(s, { start, end }))) return
    suspects.push({ start, end, raw })
  }
  for (const a of ambiguous) addSuspect(a.start, a.end, a.raw)
  for (const pattern of [BROAD_YEAR_FIRST, BROAD_GLUED, BROAD_REPORTER_FIRST]) {
    for (const m of text.matchAll(pattern)) {
      const start = m.index ?? 0
      addSuspect(start, start + m[0].length, m[0])
    }
  }
  for (const pattern of [CASE_REFERENCE, CASE_REFERENCE_GENERIC]) {
    for (const m of text.matchAll(pattern)) {
      if (isStatuteReference(text, m.index ?? 0, m[0])) continue
      if (isOwnCase(m[0], options)) continue
      const start = m.index ?? 0
      addSuspect(start, start + m[0].length, m[0])
    }
  }
  for (const hit of reporterFallback(folded)) addSuspect(hit.start, hit.end, hit.raw)
  for (const hit of shapeSuspects(folded)) addSuspect(hit.start, hit.end, hit.raw)
  for (const hit of urduSuspects(folded)) addSuspect(hit.start, hit.end, hit.raw)
  // Mixed-script tokens are suspects even beside a strict hit: never map confusables.
  for (const token of mixedScriptTokens(text)) {
    if (!suspects.some((s) => overlaps(s, token))) suspects.push(token)
  }
  return { accepted, suspects }
}

export function analyseCitations(input: string, options: AnalyseOptions = {}): CitationAnalysis {
  // R3 N8: analyse the plain-text reading and the markup-stripped reading; union the findings.
  const readings = [foldDraftText(input ?? "", { markup: "keep" }), foldDraftText(input ?? "")]
  if (readings.every((v) => !v.text)) return { citations: [], suspects: [] }
  const results = readings.map((folded) => {
    const { accepted, suspects } = analyse(folded, options)
    return {
      citations: [...new Set(accepted.map((hit) => hit.citation))],
      suspects: suspects.sort((a, b) => a.start - b.start).map((s) => s.raw),
    }
  })
  // A citation read in only one reading is kept only when the other reading is clean of it:
  // no suspect at all and no other page under the same reporter/year ("2019 SCMR\n123 *4*"
  // reads as page 123 in plain text but "123 4" — ambiguous — once the emphasis is removed).
  const head = (citation: string) => citation.replace(/ \d+(?: \([^()]*\))?$/, "")
  const citations: string[] = []
  const demoted: string[] = []
  for (const citation of [...new Set(results.flatMap((r) => r.citations))]) {
    const missingFrom = results.filter((r) => !r.citations.includes(citation))
    const inconsistent = missingFrom.some(
      (r) => r.suspects.length > 0 || r.citations.some((other) => head(other) === head(citation))
    )
    if (inconsistent) demoted.push(citation)
    else citations.push(citation)
  }
  const seen = new Set<string>(citations)
  const suspectRefs: string[] = []
  for (const raw of [...demoted, ...results.flatMap((r) => r.suspects)]) {
    const ref = `${UNRECOGNISED_PREFIX}${raw.replace(/\s+/g, " ").trim().slice(0, 80)}`
    if (seen.has(ref)) continue
    seen.add(ref)
    suspectRefs.push(ref)
  }
  return { citations, suspects: suspectRefs }
}

/**
 * Every authority referenced in `text`, for the gate: canonical citations followed by
 * UNRECOGNISED suspects (which the gate treats as UNVERIFIED).
 */
export function extractCitations(text: string, options: AnalyseOptions = {}): string[] {
  const { citations, suspects } = analyseCitations(text, options)
  return [...citations, ...suspects]
}

/**
 * The canonical form of a string that is exactly one reported citation (surrounding
 * whitespace and punctuation aside), or null. Anything else — two citations, a suspect, a
 * mixed-script token, residue text — is null, so it can never resolve to another authority.
 */
export function normaliseCitation(raw: string): string | null {
  // Both readings (plain text and markup-stripped) must agree on exactly one citation with no
  // residue and no suspect (R3 N8), so a ref can never resolve to another authority.
  let result: string | null = null
  for (const folded of [foldDraftText(raw ?? "", { markup: "keep" }), foldDraftText(raw ?? "")]) {
    const text = folded.text
    if (!text) return null
    const { accepted, suspects } = analyse(folded, {})
    const [hit] = accepted
    if (accepted.length !== 1 || !hit || suspects.length > 0) return null
    const residue = text.slice(0, hit.start) + text.slice(hit.end)
    if (/[\p{L}\p{N}]/u.test(residue)) return null
    if (result !== null && result !== hit.citation) return null
    result = hit.citation
  }
  return result
}
