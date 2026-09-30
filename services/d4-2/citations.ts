/**
 * Module 33 — extractCitations: pull every reported Pakistani authority out of a draft.
 *
 * v6 Module 33: "Every citation/statute extracted from a draft and cross-checked against
 * master tables." The reporter patterns and PLD court aliases are ported from the corpus
 * service's extractor (corpus_service/scraper/parsers/citation_extractor.py — PLD, SCMR, CLC,
 * YLR, MLD, PCrLJ, PTD, PTCL) and extended with the reporters the corpus model records
 * (CLD, PLC, GBLR — corpus_service/scraper/models.py) plus KLR.
 *
 * Canonical forms:
 *   PLD <year> <court> <page>         e.g. "PLD 2023 SC 123" (court is part of the identity)
 *   <year> <reporter> <page>          e.g. "2019 SCMR 1234"  (a parenthetical court is dropped:
 *                                     these reporters paginate continuously per year)
 */

const PLD_COURT_CANONICAL: Record<string, string> = {
  SC: "SC",
  "SUPREME COURT": "SC",
  "SUPREME COURT OF PAKISTAN": "SC",
  FSC: "FSC",
  "FEDERAL SHARIAT COURT": "FSC",
  LAHORE: "Lahore",
  LAH: "Lahore",
  "LAHORE HIGH COURT": "Lahore",
  KARACHI: "Karachi",
  KAR: "Karachi",
  SINDH: "Sindh",
  "SINDH HIGH COURT": "Sindh",
  PESHAWAR: "Peshawar",
  PESH: "Peshawar",
  "PESHAWAR HIGH COURT": "Peshawar",
  BALOCHISTAN: "Balochistan",
  "BALOCHISTAN HIGH COURT": "Balochistan",
  QUETTA: "Balochistan",
  ISLAMABAD: "Islamabad",
  "ISLAMABAD HIGH COURT": "Islamabad",
  IHC: "Islamabad",
  AJK: "AJ&K",
  "AJ&K": "AJ&K",
  "AZAD JAMMU AND KASHMIR": "AJ&K",
  "GILGIT BALTISTAN": "GB",
  GB: "GB",
}

const PLD_COURT_ALTERNATIVES =
  "Supreme Court(?: of Pakistan)?|SC|Federal Shariat Court|FSC|" +
  "Lahore(?: High Court)?|Lah\\.?|Sindh(?: High Court)?|Karachi|Kar\\.?|" +
  "Peshawar(?: High Court)?|Pesh\\.?|Balochistan(?: High Court)?|Quetta|" +
  "Islamabad(?: High Court)?|IHC|AJ&?K|Azad Jammu and Kashmir|Gilgit Baltistan|GB"

const YEAR = "(19\\d{2}|20\\d{2})"
const PAGE = "(\\d+[A-Z]?)"

const PLD_PATTERN = new RegExp(
  `\\bPLD\\s+${YEAR}\\s+(${PLD_COURT_ALTERNATIVES})(?![A-Za-z])\\s*${PAGE}\\b`,
  "gi"
)

const REPORTERS =
  "SCMR|CLC|YLR|MLD|P\\s*Cr\\.?\\s*L\\.?\\s*J\\.?|PTCLR|PTCL|PCLD|PTD|CLD|PLC|KLR|GBLR"

const REPORTER_PATTERN = new RegExp(
  `\\b${YEAR}\\s+(${REPORTERS})(?![A-Za-z])\\s*(?:\\(\\s*[A-Za-z\\s.\\-&]+?\\s*\\))?\\s*${PAGE}\\b`,
  "gi"
)

function canonicalCourt(raw: string): string {
  const key = raw.replace(/\./g, "").replace(/\s+/g, " ").trim().toUpperCase()
  return PLD_COURT_CANONICAL[key] ?? raw.trim()
}

function canonicalReporter(raw: string): string {
  const compact = raw.replace(/[\s.]/g, "").toUpperCase()
  if (compact === "PCRLJ") return "PCrLJ"
  if (compact === "PTCLR" || compact === "PCLD") return "PTCL"
  return compact
}

/** Every reported authority cited in `text`, canonicalised, de-duplicated, in order of first appearance. */
export function extractCitations(text: string): string[] {
  if (!text) return []
  const hits: Array<{ index: number; citation: string }> = []
  for (const m of text.matchAll(PLD_PATTERN)) {
    const [, year, court, page] = m
    if (!year || !court || !page) continue
    hits.push({ index: m.index ?? 0, citation: `PLD ${year} ${canonicalCourt(court)} ${page.toUpperCase()}` })
  }
  for (const m of text.matchAll(REPORTER_PATTERN)) {
    const [, year, reporter, page] = m
    if (!year || !reporter || !page) continue
    hits.push({ index: m.index ?? 0, citation: `${year} ${canonicalReporter(reporter)} ${page.toUpperCase()}` })
  }
  hits.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  const out: string[] = []
  for (const hit of hits) {
    if (seen.has(hit.citation)) continue
    seen.add(hit.citation)
    out.push(hit.citation)
  }
  return out
}

/** The canonical form of a single citation string, or null when it is not a reported citation. */
export function normaliseCitation(raw: string): string | null {
  return extractCitations(raw)[0] ?? null
}
