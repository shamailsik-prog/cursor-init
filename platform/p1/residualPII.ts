/**
 * Residual PII detector (audit F15; spec docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md,
 * rulings 5 and R2-2 to R2-4). It runs on text the mask has already processed and returns counts by kind, never text.
 *
 * It is independent of the mask by method: the mask recognises specific identifier formats and the names it is given;
 * this detector scans every digit run by its length and grouping, and looks for the contextual cues Pakistani legal
 * prose puts before identifying content (identity and contact labels, residence cues, house and street numbers,
 * parentage and marriage cues). It runs on the same detection view (`detectionView`), so it sees every digit script and
 * no invisible character.
 *
 * At rank 3 and above any finding blocks the call (`assertMinimised`, block reason `not_minimised`); below it, the
 * counts are recorded with the call. A finding is a cue, not proof, and no finding is not proof of anonymity.
 *
 * Every cue regex is built from the word lists below (exported together as RESIDUAL_CUES for the bound test), and no
 * two whitespace quantifiers meet around an optional part, so the scan is linear in the text (ruling R2-2). Everything
 * read after a cue is read from a bounded window.
 */

import { MASK_TOKENS } from "@/platform/p1/maskOutboundPII"
import { detectionView } from "@/platform/p1/piiText"

export const RESIDUAL_KINDS = ["id_digits", "labelled_identifier", "address", "kinship_name"] as const
export type ResidualKind = (typeof RESIDUAL_KINDS)[number]
export type ResidualCounts = Record<ResidualKind, number>

/** How far past a cue, or before a digit run, the detector reads. */
const WINDOW = 80

// ---------------------------------------------------------------------------
// Word lists (lower case). Each list drives a regex or a check; RESIDUAL_CUES exports them for the bound test.
// ---------------------------------------------------------------------------

/** Identity and contact labels, by the digits their value needs (ruling R2-3e). */
const LABELS = {
  phone: ["cell", "mobile", "phone", "telephone", "tel", "موبائل", "فون"],
  id: ["cnic", "c.n.i.c", "c.n.i.c.", "nic", "n.i.c", "n.i.c.", "id card", "identity card", "شناختی کارڈ"],
  ntn: ["ntn", "n.t.n", "n.t.n."],
  licence: ["licence", "license", "لائسنس"],
  passport: ["passport", "پاسپورٹ"],
  email: ["email", "e-mail", "ای میل"],
} as const
const LABEL_MIN_DIGITS: Readonly<Record<keyof typeof LABELS, number>> = { phone: 7, id: 5, ntn: 7, licence: 5, passport: 0, email: 0 }

/** Cues after which any content (not a function word) is a residence (ruling R2-3c). */
const RESIDENCE_CUES = ["r/o", "ساکن", "ساکنہ", "سکنہ", "رہائشی"]
/** Singular only: "residents of" is exempt (ruling R2-3c). */
const RESIDENT_OF = ["resident of"]
/** Address labels count at a field start or after a qualifier (ruling R2-3f). */
const ADDRESS_LABELS = ["address", "پتہ", "پتا"]
const ADDRESS_QUALIFIERS = ["permanent", "present", "postal", "residential", "home", "office", "mailing", "current", "business", "correspondence", "registered"]
/** Places counted with a bare number ("House 12,") or with No. ("House No. 12") (ruling R2-3g). */
const BARE_PLACES = ["house", "street", "gali", "galli", "mohallah", "mohalla", "muhallah", "muhalla", "apartment", "گلی", "محلہ"]
/** Places counted only with No., #, Number or the Urdu word for number (ruling R2-3g). */
const NUMBERED_PLACES = ["h.", "plot", "flat", "shop", "apt.", "مکان", "پلاٹ", "فلیٹ", "دکان"]
/** Kinship cues: after s/o and d/o any word is a name; after the others a capitalised one; Urdu cues take any word. */
const KIN_ANY = ["s/o", "d/o"]
const KIN_CAPITAL = ["w/o", "son of", "daughter of", "wife of", "widow of"]
/** Not "بن" ("son of" in Arabic): in Urdu it is the everyday verb "become" (ruling R2-3a). */
const KIN_URDU = ["ولد", "بنت", "زوجہ", "دختر", "پسر", "بیوہ"]
/** id_digits exemptions (ruling R2-3h). */
const CURRENCY_BEFORE = ["rs", "rs.", "pkr", "usd", "us$", "$", "روپے"]
const CURRENCY_AFTER = ["/-", "/=", "روپے", "rupees", "rupee"]
const AMOUNT_WORDS = ["amount", "sum", "price", "value", "valued at", "consideration", "compensation", "fine", "penalty", "damages", "cost", "costs", "fee", "fees"]
const DOCUMENT_CUES = ["diary", "fir", "f.i.r", "case", "suit", "appeal", "petition", "reference", "challan", "complaint", "w.p", "crl", "c.p"]
const LAND_RECORD_CUES = [
  "khasra", "khewat", "khatooni", "khatauni", "mutation", "intiqal", "murabba", "killa",
  "خسرہ", "کھیوٹ", "کھتونی", "انتقال", "مربع", "کلہ",
]
/** A number followed by one of these is a measure, not a house or street number (ruling R2-3g). */
const UNIT_WORDS = [
  "year", "years", "yr", "yrs", "month", "months", "day", "days", "week", "weeks", "hour", "hours", "minute", "minutes", "marla", "marlas",
  "kanal", "kanals", "acre", "acres", "feet", "foot", "ft", "sq", "square", "metre", "metres", "meter", "meters", "m", "km", "yard", "yards",
  "room", "rooms", "storey", "storeys", "stories", "floor", "floors", "person", "persons", "people", "resident", "residents", "inhabitants",
  "households", "سال", "ماہ", "مہینے", "دن", "مرلہ", "مرلے", "کنال", "ایکڑ", "فٹ",
]
/** Places a "the" before a proper noun may name: "resident of the village Kot Qalvo" (ruling R2-3c refinement). */
const PLACE_NOUNS = ["village", "town", "city", "mohallah", "mohalla", "muhallah", "muhalla", "chak", "colony", "sector", "block", "street", "house", "gali", "basti", "goth", "mauza"]

/** English function words: never a name or a place (rulings R2-3b, R2-3c). */
const EN_FUNCTION = new Set([
  "the", "a", "an", "this", "that", "these", "those", "said", "same", "his", "her", "its", "their", "our", "my", "your", "and", "or", "but", "nor",
  "of", "in", "on", "at", "to", "for", "by", "with", "from", "as", "into", "is", "was", "are", "were", "be", "been", "being", "has", "had", "have",
  "who", "whom", "whose", "which", "what", "not", "no", "also", "then", "than", "there", "here", "it", "he", "she", "they", "him", "them", "we",
  "i", "you", "one", "any", "all", "some", "such", "other", "another", "both", "each", "either", "neither", "very", "only", "just", "even", "so",
  "if", "when", "where", "while", "because", "after", "before", "under", "over", "about", "against", "between", "during", "without", "within",
  "upon", "per", "via", "will", "would", "shall", "should", "can", "could", "may", "might", "must", "do", "does", "did", "done",
])
/** Party-role references: "son of Respondent No. 2" names no one (ruling R2-3b). */
const ROLE_WORDS = new Set([
  "respondent", "respondents", "petitioner", "petitioners", "appellant", "appellants", "accused", "complainant", "complainants", "plaintiff",
  "plaintiffs", "defendant", "defendants", "applicant", "applicants", "deceased", "witness", "witnesses", "pw", "dw", "cw", "opposite",
  "shaheed", "martyr", "convict", "victim", "deponent", "claimant", "objector",
])
/** Titles skipped before a name; after one, any word is the name, lower case too (ruling R2-3b). */
const TITLE_WORDS = new Set(["late", "mr", "mrs", "ms", "mst", "miss", "dr", "ch", "sh", "marhoom", "مرحوم", "مرحومہ", "مسماۃ", "مسمی", "مسمات", "جناب"])
/** Titles that are also names: skipped before a name, counted as the name when none follows. */
const NAME_TITLES = new Set(["malik", "syed", "sayed", "mian", "haji", "chaudhry", "chaudhary", "chaudhri", "rana", "raja", "mirza", "sheikh", "sardar", "khawaja", "hafiz", "qazi", "pir", "makhdoom", "nawab"])
/** Urdu function words, postpositions and auxiliaries (ruling R2-3a). */
const UR_STOP = new Set([
  "نے", "کا", "کی", "کے", "کو", "سے", "میں", "پر", "اور", "ہے", "ہیں",
  "تھا", "تھی", "تھے", "گیا", "گئی", "گئے", "نہ", "نہیں", "بھی",
  "تو", "یہ", "وہ", "جو", "ان", "اس", "ہو", "ہوا", "ہوئی", "ہوئے",
  "رہا", "رہی", "رہے", "تک", "لیے",
])
/** Urdu legal role and heir nouns: "the plaintiff's daughter" names no one (ruling R2-3a, as R2-3b for English). */
const UR_ROLE_NOUNS = new Set([
  "قانونی", "شرعی", "وارث", "ورثاء", "نابالغ", "بالغ",
  "حقیقی", "سگی", "سگا", "مذکور", "مذکورہ", "متوفی", "متوفیہ",
  "مقتول", "مقتولہ", "ملزم", "ملزمہ", "مدعی", "مدعیہ", "مدعا",
  "گواہ", "درخواست", "سائل", "سائلہ",
])
/** After "ساکن" these nouns make it the adjective "still" or "immovable", not "resident" (ruling R2-3a). */
const UR_ADJECTIVAL = new Set(["پانی", "جائیداد", "جائداد", "حالت", "ہوا"])
/** Idioms: "بنت حوا" ("daughter of Eve") means "a woman" (ruling R2-3a). */
const UR_IDIOM: ReadonlyMap<string, string> = new Map([["بنت", "حوا"]])
/** "resident of Pakistan" names no place smaller than the country (ruling 5). */
const NOT_AN_ADDRESS = new Set(["pakistan", "پاکستان"])

/** Every cue word, for the bound test (tests/f15-r2-bounds.test.ts). */
export const RESIDUAL_CUES: readonly string[] = [
  ...Object.values(LABELS).flat(), ...RESIDENCE_CUES, ...RESIDENT_OF, ...ADDRESS_LABELS, ...ADDRESS_QUALIFIERS.map((q) => `${q} address`),
  ...BARE_PLACES, ...NUMBERED_PLACES, ...KIN_ANY, ...KIN_CAPITAL, ...KIN_URDU, ...CURRENCY_BEFORE, ...CURRENCY_AFTER, ...AMOUNT_WORDS,
  ...DOCUMENT_CUES.map((c) => `${c} no.`), ...LAND_RECORD_CUES, ...UNIT_WORDS.slice(0, 4), ...PLACE_NOUNS.map((p) => `resident of the ${p}`),
]

// ---------------------------------------------------------------------------
// Regex construction
// ---------------------------------------------------------------------------

const ARABIC = /\p{Script=Arabic}/u

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The regex source for one cue word: a space is any whitespace run (or none, in Arabic script); "/" may have a space
 * either side; a dot inside a word is optional and may be followed by a space ("c.n.i.c", "cnic", "c. n. i. c"), a
 * final dot is required; a hyphen is optional ("e-mail", "email").
 */
function cueSource(word: string): string {
  const arabic = ARABIC.test(word)
  const chars = [...word]
  let out = ""
  chars.forEach((ch, i) => {
    if (ch === " ") out += arabic ? "\\s*" : "\\s+"
    else if (ch === "/") out += "\\s?\\/\\s?"
    else if (ch === ".") out += i === chars.length - 1 ? "\\." : "\\.?\\s?"
    else if (ch === "-") out += "-?"
    else out += escapeRegExp(ch)
  })
  return out
}

/** An alternation of cue words, longest first, as a non-capturing group. */
const alternation = (words: readonly string[]) =>
  `(?:${[...words].sort((a, b) => b.length - a.length).map(cueSource).join("|")})`

const BEFORE = "(?<![\\p{L}\\p{N}])"
const AFTER = "(?![\\p{L}\\p{N}])"
const cueRegex = (words: readonly string[]) => new RegExp(`${BEFORE}${alternation(words)}${AFTER}`, "giu")

const startsWithToken = (text: string): boolean => MASK_TOKENS.some((token) => text.startsWith(token))
const isToken = (word: string): boolean => MASK_TOKENS.includes(word)
const lower = (word: string) => word.toLowerCase()

const WORD = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}'\u2019-]*/u
/** Between words: spaces, combining marks and light punctuation. */
const BETWEEN_WORDS = /^[\s\p{M}.,:;()-]*/u

/** Up to `max` words after `from` (within the window), each mask token kept whole as one word. */
function wordsAfter(text: string, from: number, max: number): string[] {
  let rest = text.slice(from, from + WINDOW)
  const words: string[] = []
  while (words.length < max) {
    rest = rest.slice(BETWEEN_WORDS.exec(rest)![0].length)
    const word = MASK_TOKENS.find((t) => rest.startsWith(t)) ?? WORD.exec(rest)?.[0]
    if (word === undefined) break
    words.push(word)
    rest = rest.slice(word.length)
  }
  return words
}

// ---------------------------------------------------------------------------
// id_digits
// ---------------------------------------------------------------------------

/** Digit groups joined only by single separators (space, "-", ".", "/", "_"); commas and everything else end a run. */
const DIGIT_RUN = /\d+(?:[ \-./_]\d+)*/g
const GROUP_SEPARATOR = /[ \-./_]/
const YEAR = /^(?:19|20)\d\d$/
const CURRENCY_BEFORE_RE = new RegExp(`(?:${BEFORE}${alternation(CURRENCY_BEFORE.filter((c) => c !== "$"))}|\\$)\\s?$`, "iu")
/** A currency marker after the run, also after a parenthetical ("2500000000 (two billion ...) rupees"). */
const CURRENCY_AFTER_RE = new RegExp(`^\\s?(?:\\([^()\\n]{0,${WINDOW}}\\)\\s?)?${alternation(CURRENCY_AFTER)}`, "iu")
const AMOUNT_BEFORE_RE = new RegExp(`${BEFORE}${alternation(AMOUNT_WORDS)}(?:\\s+(?:of|at))?\\s+$`, "iu")
const NUMBER_WORD = "\\s*(?:nos?\\.?|number|#|\\u0646\\u0645\\u0628\\u0631)"
/** A document number needs its "No." ("Diary No. 123456-2021"); a land-record number does not ("Khasra 1234/1"). */
const DOCUMENT_BEFORE_RE = new RegExp(`${BEFORE}${alternation(DOCUMENT_CUES)}${NUMBER_WORD}\\s*$`, "iu")
const LAND_BEFORE_RE = new RegExp(`${BEFORE}${alternation(LAND_RECORD_CUES)}(?:${NUMBER_WORD})?\\s*$`, "iu")
/** A date at the start of a run ("01.02.2021 10.30"): such a run is not mobile-shaped, whatever its first digit. */
const DATE_PREFIX = /^\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d\d(?!\d)/

function idDigits(text: string): number {
  let count = 0
  for (const m of text.matchAll(DIGIT_RUN)) {
    const run = m[0]
    const groups = run.split(GROUP_SEPARATOR)
    const digits = groups.reduce((n, g) => n + g.length, 0)
    if (digits < 10) continue
    const at = m.index
    const before = text.slice(Math.max(0, at - WINDOW), at)
    // A mobile-shaped run (a 0, 92 or +92 prefix, 10 to 13 digits, not a date) keeps no exemption (ruling R2-4).
    if ((run.startsWith("0") || run.startsWith("92")) && digits <= 13 && !DATE_PREFIX.test(run)) {
      count += 1
      continue
    }
    // Section lists ("302/324/148/149") and year lists: every group short or a year.
    if (groups.every((g) => g.length <= 3 || YEAR.test(g))) continue
    // A case number with its year ("123456/2021").
    if (groups.length === 2 && run.includes("/") && YEAR.test(groups[1]!)) continue
    // Amounts, document numbers and land-record numbers (ruling R2-3h).
    if (CURRENCY_BEFORE_RE.test(before) || AMOUNT_BEFORE_RE.test(before)) continue
    if (CURRENCY_AFTER_RE.test(text.slice(at + run.length, at + run.length + WINDOW + 8))) continue
    if (DOCUMENT_BEFORE_RE.test(before) || LAND_BEFORE_RE.test(before)) continue
    count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// labelled_identifier
// ---------------------------------------------------------------------------

const LABEL = new RegExp(
  `${BEFORE}(?:${Object.entries(LABELS)
    .map(([kind, words]) => `(?<${kind}>${alternation(words)})`)
    .join("|")})${AFTER}`,
  "giu"
)
/** At least one separator: ":", "#", "-", "No.", "Nos.", "Number" or the Urdu word for number. */
const LABEL_SEPARATORS = /^\s*(?:(?:[:#-]|nos?\.?(?!\p{L})|number(?!\p{L})|نمبر(?!\p{L}))\s*)+/iu
/** The value: its first token, and the digit groups that follow it ("0300 123 4567"). */
const VALUE = /^\S+(?: \d[\d\-./]*)*/u
const HANDLE = /[\p{L}\p{N}][._][\p{L}\p{N}]/u
const SPELLED_AT = /^\S+\s+(?:at|\[at\]|\(at\))\s/iu

function labelledIdentifiers(text: string): number {
  let count = 0
  for (const m of text.matchAll(LABEL)) {
    const kind = (Object.keys(LABELS) as Array<keyof typeof LABELS>).find((k) => m.groups?.[k] !== undefined)!
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + WINDOW)
    const sep = LABEL_SEPARATORS.exec(after)
    if (sep === null) continue
    const rest = after.slice(sep[0].length)
    if (startsWithToken(rest)) continue
    const value = VALUE.exec(rest)?.[0]
    if (value === undefined) continue
    const digits = value.replace(/\D/g, "").length
    let identifying: boolean
    if (kind === "email") identifying = value.includes("@") || HANDLE.test(value) || SPELLED_AT.test(rest)
    else if (kind === "passport") identifying = /^[\p{L}\p{N}]{7,}/u.test(value) && /\d/.test(value)
    else identifying = digits >= LABEL_MIN_DIGITS[kind]
    if (identifying) count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// address
// ---------------------------------------------------------------------------

const RESIDENCE = cueRegex(RESIDENCE_CUES)
const RESIDENT_OF_RE = cueRegex(RESIDENT_OF)
const ADDRESS_LABEL = new RegExp(`${BEFORE}${alternation(ADDRESS_LABELS)}\\s*[:-]`, "giu")
const QUALIFIER_BEFORE = new RegExp(`${BEFORE}${alternation(ADDRESS_QUALIFIERS)}\\s*$`, "iu")
/**
 * A numbered place: a place cue, an optional "No."-like word (the optional part carries its own leading whitespace, so
 * two whitespace quantifiers never meet: ruling R2-2), then a number such as 12, 12-B or 12/A.
 */
const NUMBERED_PLACE = new RegExp(
  `${BEFORE}(${alternation([...BARE_PLACES, ...NUMBERED_PLACES])})(?:\\s*(nos?\\.?|number|#|\\u0646\\u0645\\u0628\\u0631))?\\s*\\d+(?:[-/][\\p{L}\\p{N}]+)?`,
  "giu"
)
const NUMBERED_ONLY = new RegExp(`^${alternation(NUMBERED_PLACES)}$`, "iu")
const UNIT_AFTER = new RegExp(`^\\s*${alternation(UNIT_WORDS)}${AFTER}`, "iu")
/**
 * What may follow a bare number for it to be an address: punctuation, a place cue (case-insensitive), or a proper noun
 * (case-sensitive: under the `i` flag `\p{Lu}` would match lower case too, so it has its own regex).
 */
const BARE_FOLLOWER_PUNCT = /^\s*[,.;:)\]\n]/u
const BARE_FOLLOWER_CUE = new RegExp(`^\\s+(?:(?:and|&|or)\\s+)?${alternation([...BARE_PLACES, ...NUMBERED_PLACES])}${AFTER}`, "iu")
const BARE_FOLLOWER_PROPER = /^\s+[\p{Lu}\p{Script=Arabic}]/u
const bareFollower = (follower: string) =>
  BARE_FOLLOWER_PUNCT.test(follower) || BARE_FOLLOWER_CUE.test(follower) || BARE_FOLLOWER_PROPER.test(follower)

/** A residence target: the next word, or "the (said) village Kot ..." (ruling R2-3c). */
function residenceTarget(words: string[]): boolean {
  const [w] = words
  if (w === undefined || isToken(w)) return false
  const lw = lower(w)
  if (NOT_AN_ADDRESS.has(lw)) return false
  if (ARABIC.test(w)) return !UR_STOP.has(w) && !UR_ADJECTIVAL.has(w) && !UR_ROLE_NOUNS.has(w)
  if (!EN_FUNCTION.has(lw)) return true
  if (lw !== "the" && lw !== "said") return false
  let j = 1
  if (lower(words[j] ?? "") === "said") j += 1
  const place = words[j]
  const target = words[j + 1]
  return place !== undefined && PLACE_NOUNS.includes(lower(place)) && target !== undefined && !isToken(target) && /^[\p{Lu}\p{N}]/u.test(target)
}

/** True at a field start: the start of the text or line, after "|", ";", ",", "(" or "[", or after a qualifier. */
function atFieldStart(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - WINDOW), index).replace(/[ \t]+$/, "")
  if (before === "") return true
  if ("\n|;,([".includes(before.at(-1)!)) return true
  return QUALIFIER_BEFORE.test(before)
}

function addresses(text: string): number {
  let count = 0
  for (const m of text.matchAll(RESIDENCE)) if (residenceTarget(wordsAfter(text, m.index + m[0].length, 4))) count += 1
  for (const m of text.matchAll(RESIDENT_OF_RE)) if (residenceTarget(wordsAfter(text, m.index + m[0].length, 4))) count += 1
  for (const m of text.matchAll(ADDRESS_LABEL)) {
    if (!atFieldStart(text, m.index)) continue
    const [next] = wordsAfter(text, m.index + m[0].length, 1)
    if (next !== undefined && !isToken(next)) count += 1
  }
  for (const m of text.matchAll(NUMBERED_PLACE)) {
    const explicit = m[2] !== undefined
    if (!explicit && NUMBERED_ONLY.test(m[1]!)) continue
    const endAt = m.index + m[0].length
    const follower = text.slice(endAt, endAt + WINDOW)
    if (UNIT_AFTER.test(follower)) continue
    if (!explicit && endAt < text.length && !bareFollower(follower)) continue
    count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// kinship_name
// ---------------------------------------------------------------------------

const KINSHIP = new RegExp(`${BEFORE}(?:(${alternation(KIN_ANY)})|(${alternation(KIN_URDU)})|${alternation(KIN_CAPITAL)})${AFTER}`, "giu")

/** The number of words a party-role reference takes at `words[i]` ("Opposite Party" is two), or 0. */
function roleLength(words: string[], i: number): number {
  const w = lower(words[i]!).replace(/['\u2019]s$/, "").split(/[-.]/)[0]!
  if (!ROLE_WORDS.has(w)) return 0
  return w === "opposite" && lower(words[i + 1] ?? "") === "party" ? 2 : 1
}

const nameLike = (w: string | undefined): boolean =>
  w !== undefined && !isToken(w) && /^\p{L}/u.test(w) && !EN_FUNCTION.has(lower(w)) && !UR_STOP.has(w)

/** Whether a kinship cue is followed by a name (ruling R2-3b). `cue` is "any" (s/o, d/o), "urdu" or "capital". */
function kinshipName(cue: "any" | "urdu" | "capital", cueWord: string, words: string[]): boolean {
  let anyCase = cue === "any"
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const lw = lower(w)
    if (isToken(w)) return false
    if (cue !== "urdu" && (lw === "the" || lw === "a" || lw === "an")) continue
    if (TITLE_WORDS.has(lw)) {
      anyCase = true
      continue
    }
    if (NAME_TITLES.has(lw)) return nameLike(words[i + 1]) || /^\p{Lu}/u.test(w)
    const role = roleLength(words, i)
    if (role > 0) {
      const next = words[i + role]
      if (next === undefined || isToken(next) || /^(?:no|nos|number)$/i.test(next) || /^\p{N}/u.test(next)) return false
      return /^\p{Lu}/u.test(next) || ARABIC.test(next)
    }
    if (ARABIC.test(w)) {
      if (UR_STOP.has(w) || UR_ROLE_NOUNS.has(w)) return false
      return UR_IDIOM.get(cueWord) !== w
    }
    if (!/^\p{L}/u.test(w) || EN_FUNCTION.has(lw)) return false
    return anyCase || cue === "urdu" || /^\p{Lu}/u.test(w)
  }
  return false
}

function kinshipNames(text: string): number {
  let count = 0
  for (const m of text.matchAll(KINSHIP)) {
    const cue = m[1] !== undefined ? "any" : m[2] !== undefined ? "urdu" : "capital"
    if (kinshipName(cue, m[2] ?? "", wordsAfter(text, m.index + m[0].length, 5))) count += 1
  }
  return count
}

/** Residual findings in already-masked text, by kind. Counts only: no text from the input is returned. */
export function residualPII(maskedText: string): ResidualCounts {
  const text = detectionView(maskedText).text
  return {
    id_digits: idDigits(text),
    labelled_identifier: labelledIdentifiers(text),
    address: addresses(text),
    kinship_name: kinshipNames(text),
  }
}

/** The number of residual findings of every kind. */
export function residualTotal(counts: ResidualCounts): number {
  return RESIDUAL_KINDS.reduce((n, kind) => n + counts[kind], 0)
}
