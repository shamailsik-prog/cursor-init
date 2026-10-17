/**
 * Authority-like mentions in the prose of a committee answer (audit F17, re-audit rulings R7a and R7b).
 *
 * The D4 extractor (`extractCitations`) reads the reported Pakistani citation shapes and flags its own suspects; it does
 * not see a foreign or other law report ("(2099) 3 SCC 777", "550 U.S. 544 (2099)"), a short case or petition number
 * ("C.A. 777/2099", "Crl.P.L.A. 77/2099"), a case name ("Haris Qalbani v. Omer Daryani", "Qalvo's case", "In re Qalvo",
 * "Qalvo, supra", the Urdu "... بنام ...", "مقدمہ قلوو") or a page or paragraph reference ("the 2099 judgment ... at
 * page 7777", "the 2099 decision ... at para 77"). Grounding runs this after the extractor over every prose field: each
 * mention that does not resolve to, or is not bound to, a VERIFIED citation becomes an UNRECOGNISED suspect. It fails
 * safe: a false positive only makes an answer advisory, a false negative is the bug. It does not change the D4 gate.
 *
 * R7b: the text is normalised first (`normaliseProse`: NFKC, format characters removed, Arabic-Indic and full-width
 * digits folded, dashes folded), and each family reads a general shape rather than a list of spellings: reporters in
 * any case, a capital-letter reporter near a year and a page, a case number after any run of capital groups, a name with
 * any of the usual case markers. Statutes and the matter's own record numbers (an Act or Ordinance with a year, an FIR
 * number) are not authorities and are not read. A bare name with no case marker ("as observed in Qalvo") cannot be told
 * from ordinary prose and is not read (a documented limit).
 *
 * Linear time: one tokenising pass, and regexes whose every repetition is bounded and unambiguous (each start position
 * does bounded work); functions/test/f17-prose-authority.time-budget.test.ts holds it to a budget on 64 KB of each
 * adversarial shape and on the re-auditor's 256 KB worst cases.
 */

export type MentionFamily = "report" | "case_number" | "case_name" | "page" | "reported_phrase"

/**
 * One mention: its span in the field (UTF-16 offsets), its text, and for a page reference where its page phrase starts.
 * `loose` marks a report read only by the catch-all: never a citation to resolve, always a suspect.
 */
export type AuthorityMention = { family: MentionFamily; start: number; end: number; focus: number; raw: string; loose?: true }

/** A VERIFIED citation's span in the same field (a `report` mention whose canonical citation resolved VERIFIED). */
export type VerifiedSpan = { start: number; end: number }

/**
 * The view every family reads (R7b): NFKC (full-width letters and digits, compatibility forms), format characters
 * removed (zero-width and bidi controls, soft hyphen), Arabic-Indic and Extended Arabic-Indic digits folded to ASCII,
 * and every dash folded to "-".
 */
export function normaliseProse(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[٠-٩]/gu, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x30))
    .replace(/[۰-۹]/gu, (d) => String.fromCharCode(d.charCodeAt(0) - 0x06f0 + 0x30))
    .replace(/[‐-―−﹘﹣－]/gu, "-")
}

const YEAR = "(?:1[6-9]|20)\\d{2}"
/** A reporter or court abbreviation token: a capital, then up to 14 letters, dots or ampersands ("SCC", "All", "Civ", "S.C.M.R."). */
const ABBR = "\\p{Lu}[\\p{L}.&]{0,14}"
/** A token starting with at least two capitals ("SCMR", "AIR", "P.Cr.L.J."): a reporter, never an ordinary word ("In", "The"). */
const CAPS = "\\p{Lu}[\\p{Lu}.&]{0,12}\\p{Lu}[\\p{L}.&]{0,12}"
/** A bracketed sub-series or court ("(AD)", "(CS)", "(AJ&K)", "(Admin)"). */
const PAREN = "\\(\\s{0,2}[\\p{L}.&]{1,15}(?:\\s{1,2}[\\p{L}.&]{1,15}){0,2}\\s{0,2}\\)"
const PAGE_NUMBER = "\\d{1,6}(?!\\p{N})"
/** A bracketed volume after a year ("2099 (3) SCALE 777", "JT 2099 (3) SC 777"). */
const VOLUME = "(?:\\(\\s?\\d{1,3}\\s?\\)\\s{0,3})?"

/** A reporter matched in any case, each letter optionally followed by a dot and a blank ("SCC", "scc", "S.C.C."). */
const anyCase = (abbr: string): string =>
  [...abbr]
    .map((ch) => (/[A-Za-z]/u.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]\\.?\\s?` : ch === " " ? "\\s{0,2}" : ch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
    .join("")
/** Reporters long enough to read in any case (R7b: "(2099) 3 scc 777"); the longest first. */
const KNOWN_REPORTERS = [
  "SCC OnLine", "LiveLaw", "Cr App R", "INSC", "EWCA Crim", "EWCA Civ", "All ER", "Cri LJ", "Cr LJ", "SCALE", "PCrLJ", "PTCL", "SCMR", "GBLR", "UKSC", "UKHL", "UKPC",
  "EWHC", "CrLJ", "SCC", "SCR", "WLR", "DLR", "BLD", "BLC", "MLD", "MLR", "PLD", "PLJ", "PLC", "PTD", "CLD", "CLC", "YLR", "NLR", "KLR", "SCJ", "PSC", "CLR", "ILR",
]
  .map(anyCase)
  .join("|")
/** Short reporters read only as written (in any case they are ordinary words: "ac", "ch", "air"). */
const SHORT_REPORTERS = "A\\.?\\s?C\\.?|Q\\.?\\s?B\\.?|K\\.?\\s?B\\.?|Ch\\.?|J\\.?\\s?T\\.?|A\\.?\\s?I\\.?\\s?R\\.?|Fam\\.?"
const REPORTER = `(?:${KNOWN_REPORTERS}|${SHORT_REPORTERS})`

/** The precise report shapes: each kept unless it overlaps one that starts earlier (or is longer at the same start). */
const REPORT_SHAPES: readonly RegExp[] = [
  // "(2099) 3 SCC 777", "[2099] 2 WLR 777", "[2099] 1 All ER 777", "[2099] EWCA Civ 77", "(2099) 77 DLR (AD) 77", "[2099] UKSC 77"
  new RegExp(`(?<![\\p{L}\\p{N}])[(\\[]\\s{0,2}${YEAR}\\s{0,2}[)\\]]\\s{0,3}(?:\\d{1,4}\\s{1,3})?${ABBR}(?:\\s{1,3}${ABBR}){0,3}(?:\\s{0,3}${PAREN})?\\s{0,3}${PAGE_NUMBER}`, "gu"),
  // "2099 SCC 777", "2099 SCMR 7777", "2099 PLC (CS) 77", "2099 EWCA Civ 77"
  new RegExp(`(?<![\\p{L}\\p{N}])${YEAR}\\s{1,3}(?:\\d{1,4}\\s{1,3})?${CAPS}(?:\\s{1,3}${ABBR}){0,3}(?:\\s{0,3}${PAREN})?\\s{1,3}${PAGE_NUMBER}`, "gu"),
  // "AIR 2099 SC 777", "PLD 2099 SC 101", "PLD 2099 Lahore 77", "PLD 2099 SC (AJ&K) 1", "PLD 2099 S. C. 101"
  new RegExp(`(?<![\\p{L}\\p{N}])${CAPS}\\s{0,3}[(\\[]?${YEAR}[)\\]]?\\s{1,3}(?:${ABBR}\\s{1,3}){0,3}(?:${PAREN}\\s{0,3})?${PAGE_NUMBER}`, "gu"),
  // "77 DLR (2099) 77"
  new RegExp(`(?<![\\p{L}\\p{N}])\\d{1,4}\\s{1,3}${CAPS}(?:\\s{1,3}${ABBR}){0,2}\\s{0,3}[(\\[]${YEAR}[)\\]]\\s{0,3}${PAGE_NUMBER}`, "gu"),
  // A known reporter after the year, in any case: "(2099) 3 scc 777", "2099 (3) SCALE 777", "(2099) 7 SCC (Cri) 7", "2099 SCC OnLine SC 7", "2099 Cri LJ 777"
  new RegExp(`(?<![\\p{L}\\p{N}])[(\\[]?${YEAR}[)\\]]?\\s{0,3}${VOLUME}(?:\\d{1,4}\\s{1,3})?${REPORTER}\\s{0,3}(?:\\([^()\\n]{1,12}\\)\\s{0,3})?(?:[A-Za-z]{2,8}\\s{1,3})?${PAGE_NUMBER}`, "gu"),
  // A known reporter before the year: "JT 2099 (3) SC 777", "ILR 2099 Del 77", "AIR 2099 Bom 77"
  new RegExp(`(?<![\\p{L}\\p{N}])${REPORTER}\\s{0,3}[(\\[]?${YEAR}[)\\]]?\\s{0,3}${VOLUME}(?:[A-Za-z.]{1,10}\\s{1,3}){0,2}(?:\\([^()\\n]{1,12}\\)\\s{0,3})?${PAGE_NUMBER}`, "gu"),
  // United States reports: "550 U.S. 544 (2099)", "77 S. Ct. 777", "123 F.3d 456 (9th Cir. 2099)", "777 F. Supp. 2d 77",
  // and the short form "550 U.S. at 550"
  new RegExp(
    `(?<![\\p{L}\\p{N}])\\d{1,4}\\s{1,3}(?:U\\.?\\s?S\\.?|S\\.?\\s?Ct\\.?|L\\.?\\s?Ed\\.?(?:\\s?2d)?|F\\.?\\s?(?:2d|3d|4th)|F\\.?\\s?Supp\\.?(?:\\s?[23]d)?|F\\.?\\s?App['’]?x)\\s{1,3}(?:at\\s{1,3})?\\d{1,6}(?:\\s{0,3}\\([^()\\n]{0,40}\\))?`,
    "gu"
  ),
  // A known reporter after its volume, with no year: "77 DLR (AD) 77", "7 SCC 7"
  new RegExp(`(?<![\\p{L}\\p{N}])\\d{1,4}\\s{1,3}${REPORTER}\\s{0,3}(?:\\([^()\\n]{1,12}\\)\\s{0,3})?${PAGE_NUMBER}`, "gu"),
  // Neutral and database citations: "MANU/SC/0001/2099"
  /(?<![\p{L}\p{N}])\p{Lu}{2,8}\/\p{Lu}{1,8}\/\d{1,6}\/\d{4}(?!\p{N})/gu,
]

/**
 * The fail-safe catch-all for reporters no shape names (R7b): a 4-digit year and a capital-letter reporter token within
 * three tokens of each other, and a page within three tokens after, either way round ("(2099) 77 P & CR 7"). Kept only
 * where no precise shape matched, and never for a statute (`STATUTE_WORDS`).
 */
const GAP_TOKENS = "(?:[\\s,]{1,3}[^\\s,]{1,12}){0,3}?[\\s,]{1,3}"
const REPORT_CATCH_ALL: readonly RegExp[] = [
  new RegExp(`(?<![\\p{L}\\p{N}])[(\\[]?${YEAR}[)\\]]?${GAP_TOKENS}${CAPS}${GAP_TOKENS}${PAGE_NUMBER}`, "gu"),
  new RegExp(`(?<![\\p{L}\\p{N}])${CAPS}${GAP_TOKENS}[(\\[]?${YEAR}[)\\]]?${GAP_TOKENS}${PAGE_NUMBER}`, "gu"),
]
/** Words that make a year-and-number mention a statute or a record, not an authority (lower case, dots removed). */
const STATUTE_WORDS = new Set([
  "act", "acts", "ordinance", "ordinances", "order", "orders", "rule", "rules", "regulation", "regulations", "code", "constitution", "section", "sections",
  "article", "articles", "schedule", "chapter", "part", "clause", "s", "ss", "r", "o", "ppc", "crpc", "cpc", "qso", "ata", "cnsa", "peca", "nao", "fir",
  "sro", "notification", "gazette", "circular", "law", "laws", "statute", "bill", "amendment",
])

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
/** A year after a case number: four digits, or the two-digit "'99". */
const CASE_YEAR = "(?:\\d{4}|['’]\\d{2})(?!\\p{N})"
const CASE_SERIAL = "(?:\\p{L}{1,2}\\s?-\\s?)?\\d{1,6}(?:\\s?-\\s?\\p{L}{1,2})?"
/** "C.A. 777/2099", "Crl. P. No. 77 of 2099", "Civil Petition No.7777-L of 2099", "No. 7 of 2099", "مقدمہ نمبر 7 سال 2099". */
const CASE_NUMBER = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:(?:${CASE_TYPES})\\s{0,3}(?:Nos?\\.?\\s{0,3})?|Nos?\\.?\\s{0,3}|نمبر\\s{0,3})(?:${CASE_SERIAL}\\s{0,3}(?:of|/|-|سال|بابت)\\s{0,3}${CASE_YEAR}|\\d{4}\\s?/\\s?\\d{1,6}(?!\\p{N}))`,
  "giu"
)
/**
 * Any run of one to six capital groups, dotted or not, as a case type (R7b: "Crl.P.L.A.", "C.M.", "R.A.", "S.A.",
 * "W.P.(C)", "Crl. Org."), then "No." or nothing, then "n/yyyy", "n of yyyy", "n-yyyy" or the year first "yyyy/n".
 */
const CASE_GROUP = "\\p{Lu}\\p{L}{0,9}"
const CASE_NUMBER_GENERIC = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${CASE_GROUP}(?:\\.\\s?|\\s)){0,5}${CASE_GROUP}\\.?\\s?(?:\\(\\s?\\p{Lu}{1,3}\\s?\\)\\s?)?(?:Nos?\\.?\\s{0,3})?(?:${CASE_SERIAL}\\s{0,3}(?:of|/|-)\\s{0,3}${CASE_YEAR}|\\d{4}\\s?/\\s?\\d{1,6}(?!\\p{N}))`,
  "gu"
)
/** Words before or in a number that make it a statute's, a notification's or the matter's own record, not a case. */
const NOT_A_CASE = new Set([
  ...STATUTE_WORDS,
  "paragraph", "para", "page", "pages", "volume", "vol", "item", "entry", "serial", "crime", "challan", "roll", "letter", "memo", "budget", "year", "years",
  "month", "week", "day", "rs", "pkr", "usd", "annex", "annexure", "exh", "exhibit", "mark", "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "dated",
])

/**
 * A page or paragraph phrase ("at page 7777", "p. 77", "pp. 7", "para 77", "paragraph 7", "¶ 7"; the Urdu "صفحہ 7777",
 * "پیرا 77"). Case-sensitive for "p.": the capital "P." is a case type ("Crl. P.", "W.P."), never a page.
 */
const PAGE =
  /(?<![\p{L}\p{N}])(?:(?:[Aa]t\s{1,3})?(?:[Pp]ages?|[Pp]g\.?|pp?\.|[Pp]aras?\.?|[Pp]aragraphs?|¶{1,2})\s{0,3}\d{1,6}|(?:صفحہ|پیرا(?:گراف)?)\s{0,3}(?:نمبر\s{0,3})?\d{1,6})(?!\p{N})/gu
/** "Id. at 77": a back-reference to the last authority, read as a page reference with its own cue. */
const ID_AT = /(?<![\p{L}])Id\.\s{0,2}at\s{1,3}\d{1,6}(?!\p{N})/gu
/** A word naming a judgment or a law report, which makes a page phrase within PAGE_CUE_WINDOW characters a reference. */
const PAGE_CUE = /(?<![\p{L}])(?:judg(?:e)?ments?|reported|law\s{1,3}reports?|rulings?|precedents?|decisions?|dictum|verdicts?|فیصل[ہے]|نظیر)(?![\p{L}])/giu
const PAGE_CUE_WINDOW = 100
/** "reported at/in/as", a mention only when a year or a page follows within REPORTED_WINDOW characters. */
const REPORTED = /(?<![\p{L}])reported\s{1,3}(?:at|in|as)(?![\p{L}])/giu
const REPORTED_WINDOW = 60
const REPORTED_TARGET = new RegExp(`(?<![\\p{N}])${YEAR}(?![\\p{N}])|(?<![\\p{L}])(?:pages?|pg\\.?|pp?\\.|volume|vol\\.)(?![\\p{L}])|صفحہ`, "iu")
const ANY_YEAR = new RegExp(`(?<![\\p{N}])${YEAR}(?![\\p{N}])`, "u")

/**
 * Tokens: a mask placeholder ("[PARTY]"), "v/s" and "M/s", a word (letters, marks, digits, apostrophes, dots, hyphens,
 * ampersands) or one other character.
 */
const TOKEN = /\[[A-Z][A-Z_]{1,15}\]|(?<![\p{L}\p{N}])(?:[vV]\/[sS]|M\/[sS])\.?(?![\p{L}\p{N}])|[\p{L}\p{M}\p{N}'’.&-]+|[^\s\p{L}\p{M}\p{N}'’.&-]/gu
type Token = { start: number; end: number; text: string }

const RE_PLACEHOLDER = /^\[[A-Z][A-Z_]{1,15}\]$/u
const RE_LATIN_CAPITAL = /^(?=\p{Lu})\p{Script=Latin}/u
const RE_OTHER_LETTER = /^(?=\p{L})\P{Script=Latin}/u
const RE_WORD = /^[\p{L}\p{M}]/u
const RE_YEAR_TOKEN = new RegExp(`^${YEAR}$`, "u")
const EN_CONNECTORS = new Set(["v", "v.", "vs", "vs.", "v/s", "v/s.", "v.s.", "versus", "-v-", "vrs", "vrs.", "banam", "banaam", "bnam"])
const UR_CONNECTORS = new Set(["بنام", "بمقابلہ"])
const JOINERS = new Set(["of", "and", "the", "&", "through"])
/** "and others", "& Anr.": a party word after a joiner. */
const OTHERS = new Set(["others", "another", "ors", "ors.", "anr", "anr."])
/** What follows a name to make it a case reference ("Qalvo case", "Qalvo's case", "the Qalvo judgment"). */
const CASE_HEADS = new Set(["case", "judgment", "judgement", "decision", "ruling", "matter", "dictum"])
const BACK_REFERENCES = new Set(["supra", "supra.", "ibid", "ibid."])
/**
 * Capitalised words that are not a party's name: sentence words, the parties' roles, courts and their seats. A case
 * head or a back-reference after only these ("This case", "the Prosecution case", "the Supreme Court's judgment",
 * "the Lahore High Court decision") names no case; an unnamed reference is a documented limit.
 */
const NAME_STOP = new Set([
  "the", "this", "that", "these", "those", "a", "an", "its", "his", "her", "their", "our", "your", "my", "such", "each", "every", "any", "some", "no", "in",
  "on", "at", "of", "for", "by", "as", "see", "per", "under", "following", "applying", "also", "and", "but", "so", "while", "where", "when", "if", "it",
  "present", "instant", "same", "said", "above", "impugned", "trial", "lower", "prosecution", "defence", "defense", "petitioner", "petitioners",
  "respondent", "respondents", "appellant", "appellants", "plaintiff", "plaintiffs", "defendant", "defendants", "accused", "complainant", "state", "bail",
  "criminal", "civil", "family", "main", "whole", "entire", "client", "clients", "opposite", "other", "another", "first", "second", "third", "both",
  "either", "neither", "own", "court", "courts", "supreme", "high", "district", "sessions", "appellate", "tribunal", "federal", "shariat", "honourable",
  "hon'ble", "learned", "august", "apex", "full", "bench", "division", "larger", "single", "special", "banking", "customs", "accountability", "magistrate",
  "judge", "judges", "justice", "lahore", "karachi", "sindh", "peshawar", "islamabad", "balochistan", "quetta", "multan", "rawalpindi", "bahawalpur",
  "sukkur", "hyderabad", "abbottabad", "punjab", "pakistan", "india", "england", "privy", "council", "lords", "house", "government", "bar", "rent",
  "anti-terrorism", "narcotics", "consumer", "labour", "service", "election", "revenue", "tax", "income",
  // Adjectives a heading or sentence capitalises ("Earlier decision", "Final judgment", "Leading case").
  "earlier", "later", "recent", "previous", "prior", "subsequent", "landmark", "leading", "relevant", "cited", "original", "final", "interim", "majority",
  "minority", "dissenting", "concurring", "unanimous", "reported", "unreported", "binding", "persuasive", "foreign", "local", "domestic", "old", "new",
  "latest", "important", "key", "similar", "different", "contrary", "conflicting", "seminal", "famous", "known", "well-known", "celebrated", "test",
  // Months ("the decision in July 2099") and days.
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "monday", "tuesday",
  "wednesday", "thursday", "friday", "saturday", "sunday",
])
/** A name whose last word is one of these is a statute's ("the Contract Act (1872)"), not a case's. */
const STATUTE_HEADS = new Set(["act", "ordinance", "order", "rule", "rules", "code", "constitution", "regulation", "regulations", "law", "laws", "amendment", "article", "section", "schedule"])
/** Tokens a case name takes on each side of its connector. */
const NAME_TOKENS = 6
/** Urdu has no capitals: a name takes at most two tokens before a connector and three after, and stops at a function word. */
const UR_NAME_TOKENS_BEFORE = 2
const UR_NAME_TOKENS_AFTER = 3
const UR_STOP_WORDS = new Set([
  "میں", "نے", "کے", "کا", "کی", "کو", "سے", "پر", "یہ", "وہ", "اور", "ہے", "ہیں", "ہوا", "ہوئی", "تھا", "تھی", "کہ", "جو", "جس", "اس", "ان", "اسی", "کسی", "ہر",
  "ایک", "مقدمہ", "مقدمے", "فیصلہ", "فیصلے", "کیس", "درج", "دائر", "خارج", "سماعت", "قائم", "ختم", "واپس", "چلایا", "چلانے", "بنایا", "کیا", "گیا", "گئی", "دی",
  "دیا", "لیا", "موجودہ", "زیر", "ضمانت", "قتل", "چوری", "منشیات", "فوجداری", "دیوانی", "عائلی", "کرایہ", "ٹیکس", "مذکورہ", "متعلقہ", "اپنے", "اپنی", "نمبر",
  "بعنوان", "عدالت", "عظمیٰ", "عالیہ", "سپریم", "ہائی", "کورٹ", "ماتحت", "سیشن", "ٹرائل", "جج", "ملزم", "ملزمان", "مدعی", "مدعا", "علیہ", "درخواست", "گزار",
  "استغاثہ", "سرکار", "ریاست", "حکومت", "پولیس", "تھانہ", "اصول", "قانون", "حکم", "دفعہ", "آرٹیکل", "معاملہ", "معاملے",
  // Numbers and spans of time ("مقدمہ ساٹھ دن کے بعد دائر کیا گیا": the case was filed after sixty days).
  "دو", "تین", "چار", "پانچ", "چھ", "سات", "آٹھ", "نو", "دس", "بیس", "تیس", "چالیس", "پچاس", "ساٹھ", "ستر", "اسی", "نوے", "سو", "ہزار", "دن", "روز", "ہفتے",
  "ہفتہ", "ماہ", "مہینے", "مہینہ", "سال", "برس", "عرصہ", "عرصے", "بعد", "پہلے", "قبل", "دوران", "تک",
])
const UR_CASE_WORDS = new Set(["مقدمہ", "مقدمے"])
const UR_HEADS = new Set(["مقدمہ", "مقدمے", "کیس", "فیصلہ", "فیصلے"])
const UR_POSSESSIVES = new Set(["کے", "کا", "کی", "والے", "والا", "والی"])
/** "مقدمہ بعنوان قلوو": a case titled with a name. */
const UR_TITLED = "بعنوان"
/** The most tokens a bracketed group inside a name spans ("R (on the application of Qalvo) v ...", "(Pvt.) Ltd."). */
const NAME_BRACKET_TOKENS = 12

const lower = (t: Token | undefined): string => (t === undefined ? "" : t.text.toLowerCase())
/** A word without a possessive "'s" and without dots, in lower case. */
const base = (t: Token): string => t.text.replace(/['’]s$/u, "").replace(/\./gu, "").toLowerCase()
const isName = (t: Token | undefined): boolean => t !== undefined && (RE_PLACEHOLDER.test(t.text) || RE_LATIN_CAPITAL.test(t.text))
const isPartyWord = (t: Token | undefined): boolean => isName(t) || OTHERS.has(lower(t))
const isWord = (t: Token | undefined): boolean => t !== undefined && (RE_PLACEHOLDER.test(t.text) || RE_WORD.test(t.text))
const isUrduName = (t: Token | undefined): boolean => t !== undefined && !UR_STOP_WORDS.has(t.text) && (RE_OTHER_LETTER.test(t.text) || isName(t))
/** A capitalised name that is a party's: at least one of its words is not a sentence word, role, court or seat. */
const namesSomeone = (toks: Token[], first: number, last: number): boolean => {
  for (let j = first; j <= last; j += 1) if (!NAME_STOP.has(base(toks[j]!)) && !JOINERS.has(lower(toks[j])) && !EN_CONNECTORS.has(lower(toks[j]))) return true
  return false
}

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
 * "versus" and the rest. A name ends where a report-shaped citation starts ("Qalvo v. Nura PLD 2099 SC 101": the name
 * is "Qalvo v. Nura"), so the citation can bind it.
 */
function englishName(toks: Token[], i: number, reportStarts: ReadonlySet<number>): [number, number] | null {
  let first = i
  for (let j = i - 1, n = 0; j >= 0 && n < NAME_TOKENS; n += 1) {
    const t = toks[j]!
    // A bracketed group inside the name ("R (on the application of Qalvo) v ...", "Qalvo (Pvt.) Ltd. v ..."): skipped whole.
    if (t.text === ")" || t.text === "]") {
      let k = j - 1
      while (k >= 0 && j - k <= NAME_BRACKET_TOKENS && toks[k]!.text !== "(" && toks[k]!.text !== "[") k -= 1
      if (k < 0 || j - k > NAME_BRACKET_TOKENS) break
      first = k
      j = k - 1
      continue
    }
    if (isPartyWord(t) || (JOINERS.has(lower(t)) && isName(toks[j - 1]) && first < i)) first = j
    else break
    j -= 1
  }
  if (first === i) {
    if (!isWord(toks[i - 1])) return null
    first = i - 1
  }
  while (first < i - 1 && JOINERS.has(lower(toks[first]))) first += 1
  let last = i
  for (let j = i + 1, n = 0; j < toks.length && n < NAME_TOKENS && !reportStarts.has(toks[j]!.start); j += 1, n += 1) {
    const t = toks[j]!
    if (isPartyWord(t) || (JOINERS.has(lower(t)) && isPartyWord(toks[j + 1]))) last = j
    else break
  }
  if (last === i) {
    if (!isWord(toks[i + 1]) || reportStarts.has(toks[i + 1]!.start)) return null
    last = i + 1
  }
  return [first, last]
}

/** Urdu case names: letter tokens (any script but Latin lower case, no function word) on each side of the connector. */
function urduName(toks: Token[], i: number, reportStarts: ReadonlySet<number>): [number, number] | null {
  let first = i
  for (let j = i - 1; j >= 0 && i - j <= UR_NAME_TOKENS_BEFORE && isUrduName(toks[j]); j -= 1) first = j
  let last = i
  for (let j = i + 1; j < toks.length && j - i <= UR_NAME_TOKENS_AFTER && isUrduName(toks[j]) && !reportStarts.has(toks[j]!.start); j += 1) last = j
  return first === i || last === i ? null : [first, last]
}

/** The name after a prefix ("In re", "Ex parte", "the case of"): names, joiners and connectors, up to NAME_TOKENS; its last index, or -1. */
function nameAfter(toks: Token[], from: number, reportStarts: ReadonlySet<number>): number {
  let last = -1
  for (let j = from, n = 0; j < toks.length && n < NAME_TOKENS && !reportStarts.has(toks[j]!.start); j += 1, n += 1) {
    const t = toks[j]!
    if (isPartyWord(t) || ((JOINERS.has(lower(t)) || EN_CONNECTORS.has(lower(t))) && isPartyWord(toks[j + 1]))) last = j
    else break
  }
  return last >= from && namesSomeone(toks, from, last) ? last : -1
}

/** The name before `i` (up to `max` capitalised tokens), trimmed of sentence words at its left; its first index, or -1. */
function nameBefore(toks: Token[], i: number, max: number): number {
  let first = i
  for (let j = i - 1; j >= 0 && i - j <= max && isName(toks[j]); j -= 1) first = j
  while (first < i && NAME_STOP.has(base(toks[first]!))) first += 1
  return first < i && namesSomeone(toks, first, i - 1) ? first : -1
}

function nameMentions(prose: string, toks: Token[], reportStarts: ReadonlySet<number>): AuthorityMention[] {
  const out: AuthorityMention[] = []
  const push = (first: number, last: number) => {
    const start = toks[first]!.start
    const end = nameEnd(toks[last]!)
    out.push({ family: "case_name", start, end, focus: start, raw: prose.slice(start, end) })
  }
  const at = (j: number): string => lower(toks[j])
  for (let i = 0; i < toks.length; i += 1) {
    const text = toks[i]!.text
    const word = at(i)
    if (EN_CONNECTORS.has(word)) {
      const span = englishName(toks, i, reportStarts)
      if (span) push(span[0], span[1])
      continue
    }
    if (UR_CONNECTORS.has(text)) {
      const span = urduName(toks, i, reportStarts)
      if (span) push(span[0], span[1])
      continue
    }
    // "Qalvo case", "Qalvo's case", "the Al-Jehad Trust judgment", "Zafar Shah's case" (a sentence's full stop aside),
    // and "the judgment in Qalvo", "the decision in Qalvo".
    if (CASE_HEADS.has(word.endsWith(".") ? word.slice(0, -1) : word)) {
      const first = nameBefore(toks, i, 4)
      if (first >= 0) push(first > 0 && at(first - 1) === "the" ? first - 1 : first, i)
      if (at(i + 1) === "in") {
        const last = nameAfter(toks, i + 2, reportStarts)
        if (last >= 0) push(i, last)
      }
      continue
    }
    // "In re Qalvo", "Re: Qalvo", "Ex parte Qalvo", "In the matter of Qalvo", "the case of Qalvo".
    const prefix =
      word === "in" && at(i + 1) === "re"
        ? i + 2
        : word === "re" && toks[i + 1]?.text === ":"
          ? i + 2
          : word === "ex" && at(i + 1) === "parte"
            ? i + 2
            : word === "in" && at(i + 1) === "the" && at(i + 2) === "matter" && at(i + 3) === "of"
              ? i + 4
              : word === "the" && at(i + 1) === "case" && at(i + 2) === "of"
                ? i + 3
                : -1
    if (prefix >= 0) {
      const last = nameAfter(toks, prefix, reportStarts)
      if (last >= 0) push(i, last)
      continue
    }
    // "Qalvo, supra", "Qalvo supra", "Qalvo (ibid)", "Qalvo, ibid.".
    if (BACK_REFERENCES.has(word)) {
      const bracketed = toks[i - 1]?.text === "(" || toks[i - 1]?.text === "["
      let j = bracketed ? i - 1 : i
      if (toks[j - 1]?.text === ",") j -= 1
      const first = nameBefore(toks, j, 3)
      const closing = bracketed && (toks[i + 1]?.text === ")" || toks[i + 1]?.text === "]") ? i + 1 : i
      if (first >= 0) push(first, closing)
      continue
    }
    // "Qalvo (2099)": a name and a bracketed year, not a statute's ("the Contract Act (1872)").
    if (text === "(" && RE_YEAR_TOKEN.test(toks[i + 1]?.text ?? "") && toks[i + 2]?.text === ")") {
      const first = nameBefore(toks, i, 3)
      if (first >= 0 && !STATUTE_HEADS.has(base(toks[i - 1]!))) push(first, i + 2)
      continue
    }
    // Urdu: "مقدمہ بعنوان قلوو", "مقدمہ قلوو", "قلوو کیس", "قلوو کے مقدمے", "قلوو والے مقدمے".
    if (text === UR_TITLED && isUrduName(toks[i + 1])) {
      push(UR_CASE_WORDS.has(toks[i - 1]?.text ?? "") ? i - 1 : i, isUrduName(toks[i + 2]) ? i + 2 : i + 1)
      continue
    }
    if (UR_CASE_WORDS.has(text) && isUrduName(toks[i + 1])) {
      push(i, isUrduName(toks[i + 2]) ? i + 2 : i + 1)
      continue
    }
    if (UR_HEADS.has(text)) {
      const j = UR_POSSESSIVES.has(toks[i - 1]?.text ?? "") ? i - 1 : i
      if ((text === "کیس" || j < i) && isUrduName(toks[j - 1])) push(isUrduName(toks[j - 2]) ? j - 2 : j - 1, i)
    }
  }
  return out
}

function regexMentions(prose: string, re: RegExp, family: MentionFamily): AuthorityMention[] {
  const out: AuthorityMention[] = []
  for (const m of prose.matchAll(re)) out.push({ family, start: m.index, end: m.index + m[0].length, focus: m.index, raw: m[0] })
  return out
}

/** Overlapping mentions of one family: the earliest kept (the longest at the same start). */
function nonOverlapping(all: AuthorityMention[]): AuthorityMention[] {
  all.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: AuthorityMention[] = []
  for (const m of all) {
    const last = out[out.length - 1]
    if (last === undefined || m.start >= last.end) out.push(m)
  }
  return out
}

/** The lower-case words of a mention, dots removed, with a dotted run joined ("S.R.O." also gives "sro"). */
function wordsOf(text: string): string[] {
  const words = text.split(/[\s,()[\]/]+/u).map((w) => w.replace(/\./gu, "").toLowerCase()).filter((w) => w.length > 0)
  const run = /^((?:\p{L}{1,3}\.\s?){2,8})/u.exec(text)
  return run ? [...words, run[1]!.replace(/[.\s]/gu, "").toLowerCase()] : words
}

/**
 * Precise report shapes first; then the catch-all where none matched, never for a statute. Both lists are in order of
 * start and free of overlaps, so one sweep finds the catch-all matches that overlap a precise one (linear: the
 * re-auditor's 256 KB of distinct reports made a pairwise check quadratic).
 */
function reportMentions(prose: string, caseNumbers: readonly AuthorityMention[]): AuthorityMention[] {
  const precise = nonOverlapping(REPORT_SHAPES.flatMap((re) => regexMentions(prose, re, "report")))
  const loose: AuthorityMention[] = []
  let p = 0
  let c = 0
  for (const m of nonOverlapping(REPORT_CATCH_ALL.flatMap((re) => regexMentions(prose, re, "report")))) {
    while (p < precise.length && precise[p]!.end <= m.start) p += 1
    while (c < caseNumbers.length && caseNumbers[c]!.end <= m.start) c += 1
    // A run of case numbers ("C.P. No. 7 of 2099 C.P. No. 8 ...") is not a report: the case numbers are read already.
    const overlaps = (p < precise.length && precise[p]!.start < m.end) || (c < caseNumbers.length && caseNumbers[c]!.start < m.end)
    if (!overlaps && !wordsOf(m.raw).some((w) => STATUTE_WORDS.has(w))) loose.push({ ...m, loose: true })
  }
  return nonOverlapping([...precise, ...loose])
}

/**
 * Case numbers, typed or after capital groups, unless a word in or just before them makes them a statute's or a
 * record's. Excluded before overlaps are resolved, so a longer excluded match ("Order XXXIX C.A. 7/2099") never hides
 * the case number inside it.
 */
function caseNumberMentions(prose: string): AuthorityMention[] {
  const isCase = (m: AuthorityMention): boolean => {
    const before = /([\p{L}.]{1,24})\s{0,3}$/u.exec(prose.slice(Math.max(0, m.start - 26), m.start))?.[1] ?? ""
    const serial = m.raw.search(/\d/u)
    return ![...wordsOf(before), ...wordsOf(m.raw.slice(0, serial < 0 ? m.raw.length : serial))].some((w) => NOT_A_CASE.has(w))
  }
  return nonOverlapping([...regexMentions(prose, CASE_NUMBER, "case_number"), ...regexMentions(prose, CASE_NUMBER_GENERIC, "case_number")].filter(isCase))
}

/** Page phrases with a cue (a judgment or law report) within PAGE_CUE_WINDOW characters: the nearest one before, else after. */
function pageMentions(prose: string): AuthorityMention[] {
  const cues = regexMentions(prose, PAGE_CUE, "page")
  const out: AuthorityMention[] = regexMentions(prose, ID_AT, "page")
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

/** Every authority-like mention in one prose field (already normalised: `normaliseProse`), in order of start. */
export function authorityMentions(prose: string): AuthorityMention[] {
  const caseNumbers = caseNumberMentions(prose)
  const reports = reportMentions(prose, caseNumbers)
  return [
    ...reports,
    ...caseNumbers,
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
/** What binds a page or paragraph phrase to the VERIFIED citation right before it ("PLD 2099 SC 101 at page 105", "... (para 9)"). */
const PAGE_GAP = /^\s{0,3}(?:,\s{0,3})?(?:[(\[]\s{0,2})?$/u
/** What binds "reported at/in/as" to the VERIFIED citation right after it. */
const REPORTED_GAP = /^\s{0,3}$/u

export type BindingOptions = {
  /** The field is the pinpoint of a claim authority that resolved VERIFIED: a page phrase in it is that judgment's page. */
  pinpointOfVerified?: boolean
}

/**
 * The non-report mentions of a field that are not bound to a VERIFIED citation (rulings R7a, R7b), each kept once (a
 * mention overlapping one already kept is the same reference). A case name or number binds to the VERIFIED citation
 * right after it (NAME_GAP), so two distinct mentions can never share one; a page phrase binds to the VERIFIED citation
 * right before it, or, in the pinpoint of a VERIFIED authority that names no year, to that authority; "reported at/in/as"
 * binds to the VERIFIED citation right after it. `verified` is in order of start.
 */
export function unboundMentions(prose: string, mentions: readonly AuthorityMention[], verified: readonly VerifiedSpan[], options: BindingOptions = {}): AuthorityMention[] {
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
      const span = verified[nextFrom(m.end)]
      bound = span !== undefined && NAME_GAP.test(prose.slice(m.end, span.start))
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
