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
import { DRAFT_READINGS, digitRunTainted, foldDraftText, type FoldedText } from "@/services/d4-2/citationFold"

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
  // closing punctuation mark ("1<b>234", "1#234", "1\u066c234"); and a closing mark glued
  // between the page and more letters/digits ("12>34", "12)34", "12;34"), and a thousands-style
  // mark after blanks ("7\t\u201989", "12 ,34"); a thousands-style mark then junk or odd blanks
  // on the same line before digits ("4,\u20144", "123\u2019<b>-4", "7,  89" — only ", 1240" with
  // one space is a pinpoint, and "." may be followed by plain spaces or an ellipsis); "<" / ">" before digits
  // ("7 <89", "1> 234") — fuzz, R3 item 10. An apostrophe, Arabic separator or angle run may
  // span a newline ("7'\f89", "1>\v234": page and line breaks) like the blank-then-digit rule;
  // a period may not.
  // R4-3: any run of punctuation/symbols glued between the page and more digits ("12\u202634",
  // "12!!34", "12\u2a7434") is ambiguous.
  // Fuzz R5: on the same line, a period, blanks and digits that are not an enumeration ("5.",
  // "5)") — "PCrLJ 4. 4 for …", "4.<FF>4" — are ambiguous, across one line break too; an ellipsis,
  // a blank line or "5." stay prose.
  return /^(?:[^\S\n]*\.(?:[^\S\n]+|[^\S\n]*\n[^\S\n]*)\d+(?![\d.)])|[\p{P}\p{S}]+\d|[\p{L}\p{N}]|\s*[-/][\s\-/]*[\p{L}\p{N}]|\s+\d|\s*[,.'\u2019\u066b\u066c]\d|[^\S\n]*['\u2019\u066b\u066c][^\p{L}\p{N}]{0,6}\d|[^\S\n]*,(?! \d)[^\p{L}\p{N}\n]{1,6}\d|[^\S\n]*\.(?=[ .]*[^\s.\p{L}\p{N}])[^\p{L}\p{N}\n]{1,6}\d|\s*[<>][^\p{L}\p{N}]{0,6}\d|[,.'\u2019\u066b\u066c][<&]|[;:)\]"\u201d!?>][\p{L}\p{N}]|[^\s.,;:)\]'"\u201d\u2019!?>])/u.test(rest)
}

function trailingParen(rest: string): { length: number; key: string } | null {
  const m = /^\s*\(\s*([^()]{1,30}?)\s*\)/u.exec(rest)
  if (!m || m[1] === undefined) return null
  return { length: m[0].length, key: canonicalParen(m[1]) }
}

const PINPOINT_SPAN = 150

function finishHit(
  folded: FoldedText,
  start: number,
  end: number,
  build: (trailing: string | null) => string | null
): StrictHit | null {
  const text = folded.text
  let stop = end
  let trailingKey: string | null = null
  const paren = trailingParen(text.slice(end))
  if (paren) {
    stop = end + paren.length
    trailingKey = paren.key
  }
  if (ambiguousTail(text.slice(stop))) return null
  // ", 1240" is a pinpoint only with a real U+0020 space: a removed tag/entity or an exotic
  // blank there is ambiguous (fuzz, R3 item 10: "7,<span>89", "4,\u202f4").
  // Likewise ". 34": the blanks after a period must be real spaces ("12.\u200a34").
  const sep = /^[,.]( +)\d/u.exec(text.slice(stop))
  if (sep?.[1] && folded.taint.slice(stop + 1, stop + 1 + sep[1].length).some(Boolean)) return null
  // R5-3: ", n" is a pinpoint only when page <= n <= page + PINPOINT_SPAN ("2015 SCMR 100, 105");
  // "2019 SCMR 1, 234" reads naturally as page 1,234 with a stray space, so it is ambiguous. A
  // 4-digit year followed by a capitalised word is the next citation in a list, not a pinpoint.
  const pin = /^, (\d+)(?![\d])/u.exec(text.slice(stop))
  if (pin?.[1]) {
    const nextCitation = /^(?:19|20)\d{2}\s+\p{Lu}/u.test(text.slice(stop + 2))
    const page = Number(/(\d+)\D*$/u.exec(text.slice(start, end))?.[1] ?? Number.NaN)
    const n = Number(pin[1])
    if (!nextCitation && !(page <= n && n <= page + PINPOINT_SPAN)) return null
  }
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
    const hit = finishHit(folded, start, start + whole.length, (trailing) =>
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
    const hit = finishHit(folded, start, start + whole.length, (trailing) => {
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
  // R4 FP6: per letter run — split at blanks, brackets, slashes and double quotes (not apostrophes)
  for (const m of text.matchAll(/[^\s()[\]{}/\\"\u201c\u201d\u00ab\u00bb\u2018]+/gu)) {
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

/** Up to 6 tokens either side of a case reference (R5-4: court mentions near it). */
export type OwnCaseContext = { before: string; after: string }

export type AnalyseOptions = {
  /** Case references that are the matter's own number (not an authority) are not suspects. */
  isOwnCaseReference?: (raw: string, context?: OwnCaseContext) => boolean
}

// ---- reporter-token fallback (N1) ---------------------------------------------------------
// Any known reporter token, in any folded form — dotted, spaced, hyphenated, glued to digits —
// with a digit within FALLBACK_WINDOW skeleton characters, that no strict hit covers, is a
// suspect. Stricter than "near a 4-digit year": any nearby number triggers it.
const REPORTER_TOKENS = ["SCMR", "PLD", "PLJ", "CLC", "YLR", "MLD", "PCrLJ", "PTD", "PTCL", "CLD", "PLC", "NLR", "KLR", "SCR", "GBLR"]
const FALLBACK_WINDOW = 20
// Reporter tokens that double as common acronyms (R3 item 6).
// R4 FP3: PTCL (the telecom company) too.
const ACRONYM_REPORTERS = new Set(["PLC", "CLC", "CLD", "PTD", "SCR", "KLR", "NLR", "YLR", "PTCL"])
const ACRONYM_AFTER_YEAR_TOKENS = 3
const ACRONYM_YEAR_WINDOW = 3
const RE_YEAR_IN_TOKEN = /^[(\[]?(?:19|20)[0-9]{2}[)\],.;:]*$/u
// Citation filler between an acronym reporter and its page (R5-1): blanks, punctuation,
// bracketed text, court names and the connectors at / page / p. / pp. / Vol.
const CITATION_FILLER = new RegExp(
  `^(?:\\s+|[,.:;\\-–—]|\\([^()\\n]{0,30}\\)|\\[[^\\[\\]\\n]{0,30}\\]|(?:at|page|pp?\\.|vol\\.?)(?![\\p{L}])|(?:${COURT_ALTERNATION})(?![\\p{L}]))*`,
  "iu"
)
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
      // Tokens that double as company names or acronyms ("Engro … PLC entered … 500", "The 2022
      // PTCL bill of Rs. 4,500", "the CLC committee met on 5 May") need tight citation adjacency
      // (R4 FP3, replacing R3 item 6's "a year within 4 tokens"): digits in the token right
      // before and a number right after (optionally past one bracket group) — which still
      // catches a split year "201 8 CLC 789" — or a number right after and a year within
      // ACRONYM_AFTER_YEAR_TOKENS tokens after it ("CLC 789 Lahore 2018"). Glued digits count.
      if (ACRONYM_REPORTERS.has(m[0].replace(/\s/g, "").toUpperCase())) {
        const beforeToken = skeleton.slice(0, ms).split(" ").filter(Boolean).pop() ?? ""
        const afterRawFull = text.slice((map[me - 1] ?? 0) + 1)
        const afterRaw = afterRawFull.replace(/^\s*\([^()\n]{0,30}\)/u, "")
        const afterTokens = afterRaw.split(/\s+/).filter(Boolean)
        const digitsBefore = /[0-9]/.test(skeleton[ms - 1] ?? "") || /[0-9]/.test(beforeToken)
        // the next token has digits ("789", "<789", "77,"), or is a connector ("page", "at", "p.")
        // or bare punctuation followed by a token with digits
        const first = afterTokens[0] ?? ""
        const numberAfter =
          /[0-9]/.test(first) ||
          /[0-9]/.test(skeleton[me] ?? "") ||
          ((/^(?:page|pp?\.?|at|vol\.?|no\.?)$/iu.test(first) || !/\p{L}/u.test(first)) && /[0-9]/.test(afterTokens[1] ?? ""))
        const yearAfter = afterTokens
          .slice(1, 1 + ACRONYM_AFTER_YEAR_TOKENS)
          .some((token) => /(?<![0-9])(?:19|20)[0-9]{2}(?![0-9])/.test(token))
        // …or junk between the token and a nearby number (markup residue such as
        // "CLC<s>pan class=\"c\"> 789" is never prose; "bill of Rs. 4,500" is)
        const junkThenNumber = (() => {
          const at = afterTokens.slice(0, 4).findIndex((token) => /[0-9]/.test(token))
          return at > 0 && afterTokens.slice(0, at).some((token) => /[^\p{L}\p{N}.,;:'()\u2019-]/u.test(token))
        })()
        // R5-1 (reviewer's rule): a year within 3 tokens before or after, and a number within 4
        // tokens after reached only through citation filler — court names, at / page / p. / pp. /
        // Vol., bracketed text, punctuation ("2018 CLC Lahore 789", "2019 PLC at page 77",
        // "CLC (2018) 789"). Ordinary words in between ("PLC entered into …", "PTCL bill of Rs.")
        // keep prose clean.
        const textBefore = text.slice(0, map[ms] ?? 0)
        const yearNear = [...textBefore.split(/\s+/).filter(Boolean).slice(-ACRONYM_YEAR_WINDOW), ...afterRawFull.split(/\s+/).filter(Boolean).slice(0, ACRONYM_YEAR_WINDOW)]
          .some((token) => RE_YEAR_IN_TOKEN.test(token))
        const fillerThenNumber = (() => {
          const filler = CITATION_FILLER.exec(afterRawFull)?.[0] ?? ""
          const words = filler.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length
          return words <= 3 && /^[0-9]/.test(afterRawFull.slice(filler.length))
        })()
        const citationShape = yearNear && fillerThenNumber
        if (!citationShape && !((numberAfter || junkThenNumber) && (digitsBefore || yearAfter))) continue
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
// R4 FP1: numbers that are never authorities — police, revenue, banking, correspondence and
// identity numbers — by the same "word immediately before No." rule.
const NON_AUTHORITY_WORD =
  /^(?:FIR|F\.I\.R\.?|Challan|Diary|Rapt|Mutation|Intiqal|Khasra|Khewat|Khatooni|Cheque|Check|Letter|Memo|Notice|CNIC|Plot|House|Account|A\/C|Receipt|Invoice|Registration|Vehicle)$/iu
const RE_NO_ANCHOR = /No[s]?\.?\s*\p{L}?-?\s*\d/u

/** A "… No. n of yyyy" whose word right before "No." is a statute or non-authority word (N12, R4 FP1). */
function isExcludedReference(text: string, matchStart: number, match: string): boolean {
  const at = match.search(RE_NO_ANCHOR)
  if (at < 0) return false
  const before = text.slice(0, matchStart + at).trimEnd()
  const word = (before.split(/\s+/).pop() ?? "").replace(/^[("'\u201c]+|[,;:]+$/gu, "")
  return STATUTE_WORD.test(word) || NON_AUTHORITY_WORD.test(word)
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
    // any short run of non-letters between letter names and inside them ("ایم >آر", "*سی*",
    // "ای\u2011س", "ج\u2008ے") — fuzz, R3 item 10
    .map((spelling) =>
      [...foldDraftText(spelling).text.replace(/ /g, "")].map(escapeRe).join("[^\\p{L}\\p{N}]{0,4}")
    )
    .join("|")})(?![\\p{L}])`,
  "gu"
)
const URDU_NUMBER_WORD = foldDraftText("نمبر").text
// R4 FP1: Urdu non-authority prefixes before نمبر (FIR, case/FIR, challan, mutation, khasra).
const URDU_NON_AUTHORITY = ["ایف آئی آر", "چالان", "انتقال", "خسرہ"].map((w) => foldDraftText(w).text)
// R5-4: مقدمہ means "case" in general (a Supreme Court case too), so it is excluded only in the
// FIR sense: followed by زیر دفعہ, or with ایف آئی آر / تھانہ in the same clause.
const URDU_CASE_WORD = foldDraftText("مقدمہ").text
const URDU_FIR_CONTEXT = ["ایف آئی آر", "تھانہ"].map((w) => foldDraftText(w).text)
const URDU_UNDER_SECTION = foldDraftText("زیر دفعہ").text
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
    // R4 FP1: FIR / case-diary / challan / mutation / khasra numbers are not authorities
    const before = text.slice(0, start + m[0].indexOf(URDU_NUMBER_WORD)).replace(/\s+/gu, " ").trimEnd()
    if (URDU_NON_AUTHORITY.some((prefix) => before.endsWith(prefix))) continue
    if (before.endsWith(URDU_CASE_WORD)) {
      const clauseStart = Math.max(text.lastIndexOf("\u06d4", start), text.lastIndexOf(".", start), text.lastIndexOf("\n", start), 0)
      const clauseEndAt = text.slice(start).search(/[\u06d4.\n]/u)
      const clause = text.slice(clauseStart, clauseEndAt < 0 ? text.length : start + clauseEndAt)
      const after = text.slice(start + m[0].length, start + m[0].length + 20).trimStart()
      if (after.startsWith(URDU_UNDER_SECTION) || URDU_FIR_CONTEXT.some((w) => clause.includes(w))) continue
    }
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
  // R4 FP4: for scripts without case (Urdu), only the Urdu names of Latin letters — a
  // transliterated abbreviation ("ایس سی ایم آر") — not any short word ("میں", "زیر", "سے").
  if (letters.every((ch) => /\p{Script=Arabic}/u.test(ch))) return URDU_LETTER_NAME_SET.has(token)
  // other uncased scripts (refused by the charset layer anyway): any short token
  return letters.length <= 6
}
const URDU_LETTER_NAME_SET = new Set(Object.values(URDU_LETTER_NAMES).map((name) => foldDraftText(name).text))

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

// ---- edit-distance-1 reporter fallback (R4-1) ---------------------------------------------
// A token within one substitution, insertion or deletion of a reporter token ("SCNR", "S\u2201MR",
// "SXCMR"), in citation position — a year right before it and a number right after (or after
// one capitalised court word), or a year right after it — is a suspect. Only abbreviation-like
// tokens count (two capitals, or a non-letter / non-ASCII character inside), so ordinary words
// ("old" ~ MLD) and organisations in prose ("In 2018 PTI won 116 seats") are not.
const EDIT_REPORTERS = REPORTER_TOKENS.map((t) => t.toUpperCase())
function editDistanceAtMostOne(a: string, b: string): boolean {
  const x = [...a]
  const y = [...b]
  if (Math.abs(x.length - y.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i += 1
      j += 1
      continue
    }
    edits += 1
    if (edits > 1) return false
    if (x.length > y.length) i += 1
    else if (x.length < y.length) j += 1
    else {
      i += 1
      j += 1
    }
  }
  return edits + (x.length - i) + (y.length - j) <= 1
}
function isAbbreviationLike(token: string): boolean {
  if ((token.match(/[A-Z]/g) ?? []).length >= 2) return true
  return [...token].some((ch) => (ch.codePointAt(0) ?? 0) >= 0x80 || !/\p{L}/u.test(ch))
}
function editDistanceSuspects(folded: FoldedText): Array<Span & { raw: string }> {
  const text = folded.text
  const tokens = [...text.matchAll(/\S+/gu)].map((m) => ({ raw: m[0], start: m.index ?? 0 }))
  const out: Array<Span & { raw: string }> = []
  const clean = (raw: string) => raw.replace(/^[(\["'\u201c\u2018]+|[)\]"'\u201d\u2019,;:.]+$/gu, "")
  const isNumber = (i: number) => RE_NUMBER_TOKEN.test(tokens[i]?.raw ?? "")
  const isYear = (i: number) => RE_YEAR_TOKEN.test(tokens[i]?.raw ?? "")
  const isCourtWord = (i: number) => /^[(\[]?\p{Lu}[\p{L}.&]*[)\]]?$/u.test(tokens[i]?.raw ?? "")
  for (let i = 0; i < tokens.length; i += 1) {
    const token = clean(tokens[i]?.raw ?? "")
    if ([...token].length < 3 || /\d/.test(token) || !isAbbreviationLike(token)) continue
    const upper = token.toUpperCase()
    if (EDIT_REPORTERS.includes(upper) || !EDIT_REPORTERS.some((r) => editDistanceAtMostOne(upper, r))) continue
    const yearFirst = isYear(i - 1) && (isNumber(i + 1) || (isCourtWord(i + 1) && isNumber(i + 2)))
    const reporterFirst = isYear(i + 1) && (isNumber(i + 2) || (isCourtWord(i + 2) && isNumber(i + 3)))
    if (!yearFirst && !reporterFirst) continue
    const from = yearFirst ? i - 1 : i
    const last = tokens[Math.min(tokens.length - 1, isNumber(i + 1) || (reporterFirst && isNumber(i + 2)) ? (yearFirst ? i + 1 : i + 2) : yearFirst ? i + 2 : i + 3)]
    const start = tokens[from]?.start ?? 0
    const end = (last?.start ?? start) + (last?.raw.length ?? 0)
    out.push({ start, end, raw: text.slice(start, end) })
  }
  return out
}

// ---- markup residue (fuzz, R4) ----------------------------------------------------------
// Markup syntax glued to a letter ("PCrL<span", "<s>pan", "s=\"c\">R", "\"><CLC") with digits
// on both sides within RESIDUE_WINDOW characters is a suspect: bodies are plain text, so tag or
// attribute fragments inside a would-be citation are junk that can split a reporter for every
// reading. Spaced prose angles ("loss < 5%") and quoted terms do not match.
const RESIDUE = /\p{L}[<>]|[<>]\p{L}|[\p{L}\p{N}]="|"[<>]/gu
const RESIDUE_WINDOW = 40
function markupResidueSuspects(folded: FoldedText): Array<Span & { raw: string }> {
  const text = folded.text
  const out: Array<Span & { raw: string }> = []
  for (const m of text.matchAll(RESIDUE)) {
    const at = m.index ?? 0
    const lo = Math.max(0, at - RESIDUE_WINDOW)
    const hi = Math.min(text.length, at + m[0].length + RESIDUE_WINDOW)
    const before = text.slice(lo, at)
    const after = text.slice(at, hi)
    // same line only, so a tag on one paragraph never taints numbers on another
    const lineBefore = before.slice(before.lastIndexOf("\n\n") + 1)
    const lineAfter = after.split("\n\n")[0] ?? ""
    if (!/[0-9]/.test(lineBefore) || !/[0-9]/.test(lineAfter)) continue
    const start = at - lineBefore.length
    out.push({ start, end: at + lineAfter.length, raw: text.slice(start, at + lineAfter.length) })
  }
  return out
}

/** The generic pattern may include leading capitalised prose ("In C.P. No. …"): try each word suffix. */
const OWN_CASE_CONTEXT_TOKENS = 6

function isOwnCase(raw: string, options: AnalyseOptions, preceding = "", following = ""): boolean {
  if (!options.isOwnCaseReference) return false
  const context: OwnCaseContext = {
    before: preceding.split(/\s+/).filter(Boolean).slice(-OWN_CASE_CONTEXT_TOKENS).join(" "),
    after: following.split(/\s+/).filter(Boolean).slice(0, OWN_CASE_CONTEXT_TOKENS).join(" "),
  }
  // R4 FP2: also try the match extended by up to 3 preceding words on the same line ("Family"
  // before "Suit No. …", "Bail" before "Application No. …").
  const before = (preceding.split("\n").pop() ?? "").split(/\s+/).filter(Boolean).slice(-3)
  const words = [...before, ...raw.split(/\s+/)]
  for (let i = 0; i < words.length; i += 1) {
    if (options.isOwnCaseReference(words.slice(i).join(" "), context)) return true
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
      if (isExcludedReference(text, m.index ?? 0, m[0])) continue
      const mEnd = (m.index ?? 0) + m[0].length
      if (isOwnCase(m[0], options, text.slice(Math.max(0, (m.index ?? 0) - 80), m.index ?? 0), text.slice(mEnd, mEnd + 80))) continue
      const start = m.index ?? 0
      addSuspect(start, start + m[0].length, m[0])
    }
  }
  for (const hit of reporterFallback(folded)) addSuspect(hit.start, hit.end, hit.raw)
  for (const hit of shapeSuspects(folded)) addSuspect(hit.start, hit.end, hit.raw)
  for (const hit of editDistanceSuspects(folded)) addSuspect(hit.start, hit.end, hit.raw)
  for (const hit of markupResidueSuspects(folded)) addSuspect(hit.start, hit.end, hit.raw)
  for (const hit of urduSuspects(folded)) addSuspect(hit.start, hit.end, hit.raw)
  // Mixed-script tokens are suspects even beside a strict hit: never map confusables.
  for (const token of mixedScriptTokens(text)) {
    if (!suspects.some((s) => overlaps(s, token))) suspects.push(token)
  }
  return { accepted, suspects }
}

// R5-4: reporters written out in full, resolved to their abbreviations before analysis.
const SPELLED_REPORTERS: ReadonlyArray<readonly [string, string]> = [
  ["Supreme Court Monthly Review", "SCMR"],
  ["Pakistan Law Decisions", "PLD"],
  ["Pakistan Legal Decisions", "PLD"],
  ["Pakistan Criminal Law Journal", "PCrLJ"],
  ["Civil Law Cases", "CLC"],
  ["Civil Law Decisions", "CLD"],
  ["Yearly Law Reporter", "YLR"],
  ["Monthly Law Digest", "MLD"],
  ["Pakistan Tax Decisions", "PTD"],
  ["Pakistan Labour Cases", "PLC"],
  ["Pakistan Law Journal", "PLJ"],
  ["National Law Reporter", "NLR"],
]
const SPELLED_REPORTER_PATTERNS = SPELLED_REPORTERS.map(
  ([name, abbreviation]) => [new RegExp(`(?<![\\p{L}])${name.split(" ").map(escapeRe).join("\\s+")}(?![\\p{L}])`, "giu"), abbreviation] as const
)
function resolveSpelledReporters(input: string): string {
  let out = input
  for (const [pattern, abbreviation] of SPELLED_REPORTER_PATTERNS) out = out.replace(pattern, abbreviation)
  return out
}

export function analyseCitations(input: string, options: AnalyseOptions = {}): CitationAnalysis {
  // R3 N8: analyse the plain-text reading and the markup-stripped reading; union the findings.
  // (plus a lenient strip that also removes "<…>" junk a browser would show — fuzz, R3 item 10)
  // R5-4: spelled-out reporter names are resolved to their abbreviations before every reading
  // ("2018 Civil Law Cases 789" -> "2018 CLC 789"); the replacement keeps the meaning.
  const resolved = resolveSpelledReporters(input ?? "")
  const readings = DRAFT_READINGS.map((options) => foldDraftText(resolved, options))
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
  for (const folded of DRAFT_READINGS.map((options) => foldDraftText(raw ?? "", options))) {
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
