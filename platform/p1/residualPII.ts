/**
 * Residual PII detector (audit F15; spec docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md,
 * rulings 5, R2-2 to R2-4, R3-2 to R3-7, R4-0 to R4-5, R5-2 and R5-3). It runs on text the mask has already processed and returns
 * counts by kind, never text. Where a rule trades a missed identifier for a false positive, it counts (ruling R4-0: at
 * rank 3 and above a blocked privileged call fails closed, a leak does not).
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
/** How far into a value the detector looks for a digit or an address word (ruling R3-5). */
const VALUE_WINDOW = 60

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

/** Cues after which any content (not a function word) is a residence (rulings R2-3c, R3-5). */
const RESIDENCE_CUES = ["r/o", "ساکن", "ساکنہ", "سکنہ", "رہائشی"]
/** The singular cue; the plural is RESIDENTS_OF (rulings R2-3c, R3-5). */
const RESIDENT_OF = ["resident of"]
/** Plural cues: a residence only before a locality word and a named or numbered place (ruling R3-5). */
const RESIDENTS_OF = ["residents of", "سکنائے", "ساکنان"]
/**
 * Words of residence: an address when, within ten words, "at", "in", "near" or "opposite" comes before a number (not a
 * year), a proper noun or "the (said) village Kot ..." ("lives with his widowed mother and two sisters at 12-B ...",
 * "having his abode in Kot ...", "permanently settled at Qalvo Town", "his residence at Kot Qalvo"; rulings R3-5, R4-3,
 * R5-3).
 */
const LIVES_AT = ["lives", "living", "resides", "residing", "stays", "staying", "abode", "settled", "residence"]
const LIVES_PREPOSITIONS = new Set(["at", "in", "near", "opposite"])
/** How many words after a word of residence the preposition may be (ruling R5-3: ten, up from six). */
const LIVES_WINDOW = 10
/** Origin cues: an address before a named or numbered place ("hails from Kot Qalvo", "belongs to village ..."; R5-3). */
const FROM_CUES = ["hails from", "hail from", "hailing from", "originally from", "belongs to", "belong to", "belonging to"]
/** "C/o" (care of) before a name or an address (ruling R5-3). */
const CARE_OF = ["c/o"]
/**
 * Urdu residence words: "قلوو ٹاؤن میں رہائش پذیر", "بمقام قلوو پورہ سکونت پذیر", "مقیم قلوو پورہ" (ruling R5-3). The place is
 * the word next to them on either side, read past "میں", "پر" or "بمقام".
 */
const UR_DWELL = ["رہائش پذیر", "رہائش پزیر", "سکونت پذیر", "سکونت پزیر", "مقیم"]
const UR_DWELL_PAST = new Set(["میں", "پر", "بمقام"])
/** Urdu adverbs of place: "یہاں مقیم" (resides here) names no place. */
const UR_PLACE_ADVERBS = new Set(["یہاں", "وہاں", "جہاں", "کہاں", "ادھر", "یہیں", "وہیں"])
/**
 * Urdu words for a dwelling, which name no place without a number or a name: "والد کے گھر میں رہائش پذیر" (in her father's
 * house; the re-auditor's round-2 line 102). "مکان نمبر ۱۲" is counted by the numbered-place check.
 */
const UR_DWELLING = new Set(["گھر", "مکان", "کوٹھی", "حویلی", "رہائش", "رہائشگاہ"])
/** Urdu phrases of residence that follow the place: "قلوو پورہ کا رہنے والا" (ruling R4-3). */
const UR_RESIDENT_PHRASES = ["کا رہنے والا", "کی رہنے والی", "کے رہنے والے", "کا باشندہ", "کی باشندہ", "کے باشندے"]
/** Before an Urdu residence phrase, these make the place indefinite: "اسی شہر کا رہنے والا" (of the same city). */
const UR_INDEFINITE = new Set(["اسی", "اس", "ایک", "کسی", "ہی", "اپنے", "اپنی"])
/** The words a plural residence cue needs before the place (ruling R3-5). */
const LOCALITY_WORDS = [
  "village", "mauza", "moza", "mouza", "chak", "mohallah", "mohalla", "muhallah", "muhalla", "basti", "dhok", "goth", "house", "street",
  "sector", "block", "colony", "town", "kot", "pind", "tehsil", "dera", "موضع", "گاؤں", "محلہ", "چک", "بستی", "ڈھوک", "گوٹھ", "مکان", "گلی",
  "کالونی", "کوٹ", "پنڈ", "تحصیل", "ڈیرہ",
]
/**
 * After a province, the country or a general-area word, these make it part of a place's name: "Punjab Colony",
 * "Pakistan Town", "Sindh Colony" (ruling R4-3).
 */
const PLACE_NAME_NOUNS = new Set([
  "colony", "town", "society", "road", "street", "block", "sector", "bazar", "bazaar", "mohallah", "mohalla", "abad", "pura", "nagar",
  "garden", "gardens", "park", "housing", "scheme", "chowk", "market", "plaza", "lane", "avenue",
  "کالونی", "ٹاؤن", "سوسائٹی", "روڈ", "بازار", "محلہ", "آباد", "پورہ", "نگر", "گارڈن", "پارک", "اسکیم", "چوک",
])
/** Locality words that name a place by themselves when a name follows: "Mohallah Qalvo Pura", "محلہ قلوو پورہ" (R3-5). */
const LOCALITY_CUES = ["mohallah", "mohalla", "muhallah", "muhalla", "mauza", "moza", "mouza", "basti", "dhok", "goth", "محلہ", "موضع", "بستی", "ڈھوک", "گوٹھ"]
/** After a locality cue these are not a place name: "محلہ داروں" are the neighbours (ruling R3-5). */
const UR_LOCALITY_NOT_A_NAME = new Set(["داروں", "دار", "والوں", "والے", "والی"])
/** A head noun naming a general area, not an address: "residents of Islamabad Capital Territory", "ساکنان علاقہ" (R3-5). */
const GENERAL_AREA = new Set(["area", "city", "country", "province", "territory", "district", "علاقہ", "شہر", "ملک", "صوبہ", "ضلع"])
/** Address labels count at a field start or after a qualifier, and anywhere with an address-like value (R2-3f, R3-5). */
const ADDRESS_LABELS = ["address", "residence", "abode", "پتہ", "پتا"]
const ADDRESS_QUALIFIERS = ["permanent", "present", "postal", "residential", "home", "office", "mailing", "current", "business", "correspondence", "registered"]
/** Words that make a label's value an address (ruling R3-5). */
const ADDRESS_WORDS = [
  "road", "street", "house", "mohallah", "mohalla", "sector", "block", "town", "colony", "village", "lane", "gali", "chak", "plot", "flat",
  "mauza", "phase", "society", "روڈ", "سڑک", "گلی", "محلہ", "مکان", "موضع", "گاؤں", "کالونی", "سیکٹر", "بلاک", "ٹاؤن",
]
/** Values that give no address: "Present address: not known", "Address: same as above" (ruling R3-5). */
const NO_ADDRESS_VALUES = [
  "not", "unknown", "n/a", "na", "nil", "none", "same as above", "as above", "above", "below", "as stated", "stated", "as given", "given",
  "as per", "per", "as mentioned", "mentioned", "as recorded", "recorded", "نامعلوم", "معلوم نہیں",
  // R4-4: "as per the title" in Urdu
  "درخواست کے عنوان کے مطابق", "عنوان کے مطابق", "حسب عنوان", "درج شدہ",
]
/** Places counted with a bare number ("House 12,") or with No. ("House No. 12") (rulings R2-3g, R3-5). */
const BARE_PLACES = ["house", "street", "gali", "galli", "mohallah", "mohalla", "muhallah", "muhalla", "apartment", "plot", "گلی", "محلہ"]
/** Places counted only with No., #, Number or the Urdu word for number (rulings R2-3g, R3-5). */
const NUMBERED_PLACES = ["h.", "flat", "shop", "apt.", "chak", "مکان", "پلاٹ", "فلیٹ", "دکان", "چک"]
/** A house with an explicit number always counts, whatever follows ("House No. 12 wherein ...": ruling R4-3). */
const HOUSE_CUES = new Set(["house", "h.", "مکان"])
/** Kinship cues: after s/o and d/o any word is a name; after the others a capitalised one; Urdu cues take any word. */
const KIN_ANY = ["s/o", "d/o"]
const KIN_CAPITAL = ["w/o", "son of", "daughter of", "wife of", "widow of"]
/** Not "بن" ("son of" in Arabic): in Urdu it is the everyday verb "become" (ruling R2-3a). */
const KIN_URDU = ["ولد", "بنت", "زوجہ", "دختر", "پسر", "بیوہ"]
/** Parentage labels: the word after them is a name unless it is a function word ("Father's name is ...") (R3-5). */
const KIN_LABELS = ["father's name", "father name", "husband's name", "husband name", "parentage", "ولدیت"]
/** id_digits exemptions (rulings R2-3h, R3-7). */
const CURRENCY_BEFORE = ["rs", "rs.", "pkr", "usd", "us$", "$", "روپے"]
const CURRENCY_AFTER = ["/-", "/=", "روپے", "rupees", "rupee"]
const AMOUNT_WORDS = ["amount", "sum", "price", "value", "valued at", "consideration", "compensation", "fine", "penalty", "damages", "cost", "costs", "fee", "fees"]
const DOCUMENT_CUES = ["diary", "fir", "f.i.r", "case", "suit", "appeal", "petition", "reference", "challan", "complaint", "w.p", "crl", "c.p"]
const LAND_RECORD_CUES = [
  "khasra", "khewat", "khatooni", "khatauni", "mutation", "intiqal", "murabba", "killa",
  "خسرہ", "کھیوٹ", "کھتونی", "انتقال", "مربع", "کلہ",
]
/**
 * A number followed by one of these is a measure, not a house or street number (ruling R2-3g). No single letter: "House
 * No. 12 M Block" names a block (ruling R3-5).
 */
const UNIT_WORDS = [
  "year", "years", "yr", "yrs", "month", "months", "day", "days", "week", "weeks", "hour", "hours", "minute", "minutes", "marla", "marlas",
  "kanal", "kanals", "acre", "acres", "feet", "foot", "ft", "sq", "square", "metre", "metres", "meter", "meters", "km", "yard", "yards",
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
  "upon", "per", "via", "will", "would", "shall", "should", "can", "could", "may", "might", "must", "do", "does", "did", "done", "own",
])
/**
 * Words that end the walk after a kinship cue, in lower case (rulings R3-4, R4-2, R5-2: "the son of the deceased
 * appeared", "the son of the then SHO was transferred"): the finite verbs, auxiliaries and the few adverbs that follow a
 * role in legal prose. Every other lower-case word is skipped (R5-2); an -ing or -ly word no longer ends the walk.
 */
const EN_ENDERS = new Set([
  "appeared", "appears", "deposed", "deposes", "stated", "states", "testified", "testifies", "filed", "files", "died", "dies", "admitted",
  "admits", "denied", "denies", "alleged", "alleges", "claimed", "claims", "contended", "contends", "submitted", "submits", "argued", "argues",
  "pleaded", "pleads", "produced", "produces", "recorded", "examined", "absconded", "absconds", "fled", "left", "went", "came", "comes",
  "gave", "gives", "made", "makes", "took", "takes", "told", "tells", "owned", "owns", "sold", "sells", "lived", "lives", "resided",
  "resides", "appealed", "appeals", "applied", "applies", "moved", "moves", "prayed", "prays", "sought", "seeks", "received", "receives",
  "signed", "signs", "executed", "executes", "remained", "remains", "became", "becomes", "got", "gets", "saw", "sees", "heard", "hears",
  "reached", "reaches", "lodged", "lodges", "reported", "reports", "identified", "identifies", "joined", "joins", "killed", "kills",
  "injured", "attacked", "fired", "murdered", "arrested", "challenged", "challenges", "sued", "sues", "married", "marries", "divorced",
  "inherited", "inherits", "succeeded", "succeeds", "survived", "survives", "aged", "born", "stands", "stood", "entered", "enters", "raised",
  "raises", "objected", "objects", "refused", "refuses", "failed", "fails", "wanted", "wants", "asked", "asks", "requested", "requests",
  "demanded", "demands", "paid", "pays", "purchased", "bought", "transferred", "mortgaged", "gifted", "waived", "forgave", "forgiven",
  "pardoned", "compromised", "settled", "posted", "appointed", "employed", "shifted", "returned", "escaped", "surrendered", "confessed",
  "himself", "herself", "themselves", "itself", "however", "therefore", "thus", "hence", "moreover", "further", "furthermore",
  "accordingly", "admittedly", "apparently", "allegedly", "alone", "too", "again", "already", "still", "yet", "now", "later", "earlier",
  "first", "last", "never", "ever", "together", "jointly", "respectively", "alongwith", "cannot", "can't", "won't", "isn't", "wasn't",
  // finite auxiliaries and modals (R5-2: every other lower-case word is skipped, so these must end the walk)
  "is", "was", "are", "were", "has", "had", "have", "will", "would", "shall", "should", "can", "could", "may", "might", "must", "do",
  "does", "did", "aren't", "weren't", "hasn't", "hadn't", "haven't", "doesn't", "didn't", "shouldn't", "wouldn't", "couldn't",
])
/** Determiners: walked past (ruling R4-2). After "one" or "said" any word is a name; after the others a capitalised one. */
const EN_DETERMINERS = new Set(["a", "an", "the", "one", "said", "our", "his", "her", "their", "both", "its", "my", "your", "this", "that", "these", "those"])
/**
 * Words walked past after a kinship cue (ruling R4-2): occupations and other nouns for a person or a property
 * ("the deceased driver", "our client"), organisation and office words that are capitalised in prose ("a Government
 * servant", "a Member", "a Sessions Judge", "a Federal Minister"), nationality and faith words, and the adjectives and
 * participles that come before a name ("an absconding accused", "a former tenant"). After an occupation or a role, the
 * next word is a name in any case.
 */
const EN_OCCUPATIONS = new Set([
  "driver", "landlord", "owner", "owners", "client", "clients", "tenant", "tenants", "servant", "servants", "labourer", "laborer",
  "shopkeeper", "farmer", "clerk", "guard", "cook", "employee", "employees", "worker", "workers", "official", "officials", "teacher",
  "doctor", "trader", "businessman", "contractor", "agent", "manager", "engineer", "lawyer", "advocate", "counsel", "partner", "member",
  "members", "employer", "peon", "watchman", "chowkidar", "tailor", "mechanic", "carpenter", "mason", "vendor", "vendee", "purchaser",
  "seller", "buyer", "lessee", "lessor", "mortgagor", "mortgagee", "borrower", "lender", "debtor", "creditor", "guarantor", "surety",
  "nominee", "executor", "administrator", "trustee", "beneficiary", "pensioner", "retiree", "student", "man", "men", "woman", "women", "boy",
  "boys", "girl", "girls", "child", "children", "minor", "minors", "lady", "gentleman", "couple", "person", "persons", "party", "parties",
  "side", "family", "families", "national", "citizen", "property", "estate", "parents", "relative", "relatives",
])
const EN_SKIP = new Set([
  ...EN_OCCUPATIONS,
  "government", "army", "navy", "air", "force", "sessions", "session", "judge", "court", "bank", "police", "company", "federal", "provincial",
  "assembly", "senate", "minister", "high", "supreme", "district", "civil", "additional", "senior", "junior", "deputy", "assistant",
  "superintendent", "commissioner", "secretary", "chief", "president", "chairman", "director", "professor", "general", "brigadier",
  "lieutenant", "pakistani", "muslim", "christian", "hindu", "sikh", "afghan", "indian", "british", "department", "ministry", "authority",
  "corporation", "university", "college", "school", "hospital", "railway", "railways", "municipal", "committee", "council", "board",
  "union", "cantonment", "revenue", "excise", "customs", "tax", "health", "education", "irrigation", "forest", "public", "private",
  "limited", "bench", "tribunal", "magistrate", "justice", "honourable", "learned", "state", "federation", "province", "executive",
  "absconding", "alleged", "present", "former", "retired", "elder", "eldest", "younger", "youngest", "real", "step", "proclaimed",
  "convicted", "injured", "missing", "aforesaid", "poor", "rich", "old", "young", "only",
  // organisation words, capitalised in names of institutions ("the President of the Bar Association": R5-2)
  "bar", "association", "league", "chamber", "commerce", "institute", "agency", "office", "division", "directorate", "wing", "branch",
  "station", "unit", "society", "trust", "foundation", "academy", "centre", "center", "group", "organisation", "organization",
  "commission", "bureau", "service", "services", "inland", "accountability", "investigation", "intelligence", "secretariat",
  "parliament", "cabinet", "capital", "territory", "development", "water", "power", "electric", "electricity", "supply", "gas",
  "telecommunication", "transport", "police", "jail", "prison", "headquarters", "regiment", "battalion", "rangers", "frontier",
  "constabulary", "levies", "airline", "airlines", "mills", "industries", "enterprises", "traders", "sons", "brothers",
  // the country, its provinces and territories (NOT_AN_ADDRESS): a qualifier, not a personal name ("a Pakistan Army officer")
  "pakistan", "punjab", "sindh", "balochistan", "baluchistan", "khyber", "pakhtunkhwa", "kpk", "gilgit", "gilgit-baltistan", "azad",
  "kashmir", "ajk", "fata", "ict",
])
/**
 * Titles, ranks and offices, skipped after a kinship cue like a role: the next unlisted word in any case is a name ("the
 * then SHO Kamran", "a sitting MNA Kamran", "the outgoing Chairman Kamran": ruling R5-2).
 */
const EN_OFFICES = new Set([
  "mna", "mpa", "mnas", "mpas", "senator", "councillor", "councilor", "nazim", "naib", "numberdar", "nambardar", "lambardar", "zaildar",
  "tehsildar", "patwari", "girdawar", "qanungo", "dsp", "sp", "ssp", "asp", "dig", "ig", "igp", "dpo", "cpo", "ccpo", "dc", "ac", "dco",
  "collector", "mayor", "speaker", "governor", "minister", "chairman", "chairperson", "judge", "deputy", "commissioner", "secretary",
  "director", "superintendent", "registrar", "principal", "headmaster", "headmistress", "professor", "imam", "khateeb", "khatib",
  "maulana", "maulvi", "mufti", "qari", "president", "chief", "justice", "magistrate", "ambassador", "consul", "general", "brigadier",
  "lieutenant", "admiral", "commodore", "commander", "havildar", "risaldar", "lance", "ombudsman", "mohtasib", "auditor",
  "controller", "accountant", "chancellor", "vice-chancellor", "dean", "warden", "mukhtiarkar",
])
/** Words that announce a name: skipped, and the next word judged in any case ("son of the deceased namely Kamran"). */
const EN_NAMING = new Set(["namely", "named", "called", "alias"])
/** Party-role and family references: "son of Respondent No. 2", "son of his father Kamran" (rulings R2-3b, R3-4). */
const ROLE_WORDS = new Set([
  "respondent", "respondents", "petitioner", "petitioners", "appellant", "appellants", "accused", "complainant", "complainants", "plaintiff",
  "plaintiffs", "defendant", "defendants", "applicant", "applicants", "deceased", "witness", "witnesses", "pw", "dw", "cw", "opposite",
  "shaheed", "martyr", "convict", "victim", "deponent", "claimant", "objector",
  "father", "mother", "husband", "brother", "sister", "uncle", "aunt", "guardian", "grandfather", "grandmother", "nephew", "niece", "cousin",
  "son", "daughter", "wife", "widow", "heir", "heirs",
  "constable", "head", "inspector", "sub-inspector", "asi", "si", "sho", "sepoy", "naik", "havaldar", "subedar", "sergeant", "captain",
  "major", "colonel", "officer", "soldier",
])
/** Titles skipped before a name; after one, any word is the name, lower case too (rulings R2-3b, R3-4). */
const TITLE_WORDS = new Set([
  "late", "mr", "mrs", "ms", "mst", "miss", "dr", "ch", "sh", "marhoom", "مرحوم", "مرحومہ", "مسماۃ", "مسمی", "مسمات", "جناب", "محترمہ", "محترم",
])
/** Titles that are also names: skipped before a name, counted as the name when none follows. */
const NAME_TITLES = new Set(["malik", "syed", "sayed", "mian", "haji", "chaudhry", "chaudhary", "chaudhri", "rana", "raja", "mirza", "sheikh", "sardar", "khawaja", "hafiz", "qazi", "pir", "makhdoom", "nawab"])
/** English idioms: "son of Adam" means a human being, "daughter of Eve" a woman (ruling R3-4, fresh corpus line 66). */
const EN_IDIOM: ReadonlyMap<string, string> = new Map([
  ["son of", "adam"],
  ["daughter of", "eve"],
])
/** Urdu function words, postpositions, auxiliaries and demonstratives (rulings R2-3a, R3-4, R4-2). */
const UR_STOP = new Set([
  "نے", "کا", "کی", "کے", "کو", "سے", "میں", "پر", "اور", "ہے", "ہیں",
  "تھا", "تھی", "تھے", "گیا", "گئی", "گئے", "نہ", "نہیں", "بھی",
  "تو", "یہ", "وہ", "جو", "ان", "اس", "ہو", "ہوا", "ہوئی", "ہوئے",
  "رہا", "رہی", "رہے", "تک", "لیے", "ہونا", "ہونے", "ہوں", "ہوتا", "ہوتی", "ہوتے", "دونوں", "ہذا",
  // prepositions end the walk (R4-2): "دختر زیر تعلیم ہے", "ولد بطور گواہ" (held-out lines 77 and 99, after the measurement)
  "زیر", "بطور", "بابت", "برائے", "بغیر", "بذریعہ", "بمطابق", "مطابق", "خلاف", "بجائے", "بمع", "بشمول",
])
/** Urdu legal role and heir nouns: skipped after a kinship cue; the word after them is judged (rulings R2-3a, R3-4). */
const UR_ROLE_NOUNS = new Set([
  "قانونی", "شرعی", "وارث", "ورثاء", "نابالغ", "بالغ",
  "حقیقی", "سگی", "سگا", "مذکور", "مذکورہ", "متوفی", "متوفیہ",
  "مقتول", "مقتولہ", "ملزم", "ملزمہ", "مدعی", "مدعیہ", "مدعا",
  "گواہ", "درخواست", "سائل", "سائلہ", "علیہ", "علیہا", "ملزمان", "مدعیان",
  "مستغیث", "مستغیثہ", "گزار", "فریق",
])
/** Urdu ordinals: not names ("زوجہ اول اور زوجہ دوم": ruling R4-2). */
const UR_ORDINALS = new Set(["اول", "دوم", "سوم", "چہارم", "پنجم"])
/** Urdu occupations and descriptors, walked past like roles ("ولد ڈرائیور کامران", "بیوہ عورت", "دختر خاتون ..."). */
const UR_OCCUPATIONS = new Set([
  "ڈرائیور", "مالک", "کرایہ", "دار", "ملازم", "مزدور", "دکاندار", "کسان", "کاشتکار", "کلرک", "چوکیدار", "باورچی", "استاد", "ڈاکٹر", "تاجر",
  "ٹھیکیدار", "افسر", "سپاہی", "کانسٹیبل", "حوالدار", "انسپکٹر", "وکیل", "منشی", "نمبردار", "پٹواری", "زمیندار", "مستری", "درزی", "موکل",
  "عورت", "خاتون",
  // nouns that are never given names, walked past like descriptors: "پسر وقوعہ کے وقت" (held-out line 96)
  "وقوعہ", "مقدمہ", "جائیداد", "جائداد", "وراثت",
])
/**
 * Urdu phrases after a kinship cue that are not names (ruling R4-2: نیک, شادی and عدالت are given names, so only the
 * phrase is exempt): "دختر نیک اختر" (a virtuous daughter, after دختر only), "شادی شدہ" (married), "عدالت میں" and
 * "عدالت سے" (in or from court). "ولد نامعلوم" (father unknown) ends the walk too. Each entry is [first word, the words
 * that may follow it].
 */
const UR_PHRASES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["نیک", new Set(["اختر"])],
  ["شادی", new Set(["شدہ"])],
  ["عدالت", new Set(["میں", "سے"])],
])
const UR_NOT_A_NAME = new Set(["نامعلوم"])
/** After a residence cue these nouns make it an adjective: "ساکن پانی" (still water), "رہائشی علاقہ" (residential area). */
const UR_ADJECTIVAL: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["ساکن", new Set(["پانی", "جائیداد", "جائداد", "حالت", "ہوا"])],
  ["رہائشی", new Set(["علاقہ", "مکان", "اسکیم", "سکیم", "کالونی", "پلاٹ", "منصوبہ", "سوسائٹی"])],
])
/** Idioms: "بنت حوا" ("daughter of Eve") means "a woman"; a name after it is still a name (rulings R2-3a, R3-4). */
const UR_IDIOM: ReadonlyMap<string, string> = new Map([["بنت", "حوا"]])
/** Pakistan and its provinces and territories name no place smaller than a province (rulings 5, R3-5). */
const NOT_AN_ADDRESS = new Set([
  "pakistan", "punjab", "sindh", "balochistan", "baluchistan", "khyber", "kpk", "kp", "gilgit", "gilgit-baltistan", "azad", "ajk", "fata", "ict",
  "پاکستان", "پنجاب", "سندھ", "بلوچستان", "خیبر",
])

/** Every cue word, for the bound test (tests/f15-r2-bounds.test.ts). */
export const RESIDUAL_CUES: readonly string[] = [
  ...Object.values(LABELS).flat(), ...RESIDENCE_CUES, ...RESIDENT_OF, ...RESIDENTS_OF, ...LIVES_AT, ...LIVES_AT.map((l) => `${l} with his parents at`),
  ...UR_RESIDENT_PHRASES, ...LOCALITY_CUES, ...ADDRESS_LABELS,
  ...ADDRESS_QUALIFIERS.map((q) => `${q} address`), ...ADDRESS_LABELS.map((l) => `${l}:`), ...BARE_PLACES, ...NUMBERED_PLACES, ...KIN_ANY,
  ...KIN_CAPITAL, ...KIN_URDU, ...KIN_LABELS, ...CURRENCY_BEFORE, ...CURRENCY_AFTER, ...AMOUNT_WORDS, ...DOCUMENT_CUES.map((c) => `${c} no.`),
  ...LAND_RECORD_CUES, ...UNIT_WORDS.slice(0, 4), ...PLACE_NOUNS.map((p) => `resident of the ${p}`),
  ...LOCALITY_WORDS.map((l) => `residents of ${l}`), "son of the said", "son of respondent no. 2", "son of the deceased driver",
  "wife of an absconding accused", "r/o punjab", "r/o district", "resident of the area of", "house no. 12",
  // round 5 (R5-2, R5-3)
  ...FROM_CUES, ...CARE_OF, ...UR_DWELL, ...UR_DWELL.map((d) => `بمقام ${d}`), "son of the then sho", "son of none other than",
  "| s/o |", "address of accused:", "address of the respondent no. 2:",
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
 * final dot is required; a hyphen is optional ("e-mail", "email"); an apostrophe is optional and may be typographic
 * ("father's", "fathers", and the typographic apostrophe U+2019).
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
    else if (ch === "'") out += "['\\u2019]?"
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
const capitalised = (word: string) => /^\p{Lu}/u.test(word)

const WORD = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}'\u2019-]*/u
/**
 * Between words: spaces, combining marks, light punctuation and table separators ("| Tariq | s/o | Kamran Qalvo |":
 * ruling R5-3; the broken bar and the box-drawing verticals too).
 */
const BETWEEN_WORDS = /^[\s\p{M}.,:;()|\u00A6\u2502\u2503\u2551-]*/u

/** A sentence end between two words: a full stop, semicolon, question or exclamation mark, then a space. */
const SENTENCE_END = /[.;!?]\s/u
/** Words a full stop abbreviates, not ends a sentence after ("Mr. Kamran", "No. 2 Kamran"). */
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "mst", "dr", "ch", "sh", "no", "nos", "st", "jr", "sr", "exh", "ex", "s", "d", "w", "r", "h"])

/**
 * Up to `max` words after `from` (within the window: 80 characters, or 16 a word for longer reads), each mask token
 * kept whole as one word. The words stop at a sentence end, unless the full stop follows an abbreviation or an initial
 * (the round-2 guard "the son of Respondent No. 2. Draft the grounds." must not read "Draft" as a name).
 */
function wordsAfter(text: string, from: number, max: number): string[] {
  let rest = text.slice(from, from + Math.max(WINDOW, max * 16))
  const words: string[] = []
  while (words.length < max) {
    const gap = BETWEEN_WORDS.exec(rest)![0]
    const previous = words.at(-1)
    if (previous !== undefined && SENTENCE_END.test(gap + " ") && !ABBREVIATIONS.has(lower(previous)) && !/^\p{L}$/u.test(previous)) break
    rest = rest.slice(gap.length)
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

/**
 * Digit groups joined by single separators (space, "-", ".", "/", "_") or by a dash with a space either side (" - ",
 * so a CNIC in form boxes is one run: ruling R3-7); commas and everything else end a run.
 */
const DIGIT_RUN = /\d+(?:(?: ?- ?|[ ./_])\d+)*/g
const GROUP_SEPARATOR = / ?- ?|[ ./_]/
const RUN_SEPARATOR = /^(?: ?- ?|[ ./_])/
const YEAR = /^(?:19|20)\d\d$/
const CURRENCY_BEFORE_RE = new RegExp(`(?:${BEFORE}${alternation(CURRENCY_BEFORE.filter((c) => c !== "$"))}|\\$)\\s?$`, "iu")
/** A currency marker after the run, also after a parenthetical ("2500000000 (two billion ...) rupees"). */
const CURRENCY_AFTER_RE = new RegExp(`^\\s?(?:\\([^()\\n]{0,${WINDOW}}\\)\\s?)?${alternation(CURRENCY_AFTER)}`, "iu")
const AMOUNT_BEFORE_RE = new RegExp(`${BEFORE}${alternation(AMOUNT_WORDS)}(?:\\s+(?:of|at))?\\s+$`, "iu")
const NUMBER_WORD = "\\s*(?:nos?\\.?|number|#|\\u0646\\u0645\\u0628\\u0631)"
/** A document number needs its "No." ("Diary No. 123456-2021"); a land-record number does not ("Khasra 1234/1"). */
const DOCUMENT_BEFORE_RE = new RegExp(`${BEFORE}${alternation(DOCUMENT_CUES)}${NUMBER_WORD}\\s*$`, "iu")
const LAND_BEFORE_RE = new RegExp(`${BEFORE}${alternation(LAND_RECORD_CUES)}(?:${NUMBER_WORD})?\\s*$`, "iu")
/** A date at the start of a run ("01.02.2021 10.30"): it is read off, and the rest of the run is judged alone (R3-2). */
const DATE_PREFIX = /^\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d\d(?!\d)/

/** Whether one digit run (no date at its start) is an identifier (rulings R2-3h, R2-4, R3-7). */
function identifyingRun(text: string, run: string, at: number): boolean {
  const groups = run.split(GROUP_SEPARATOR)
  const digits = groups.reduce((n, g) => n + g.length, 0)
  if (digits < 10) return false
  // A mobile with its prefix (0, 92 or +92; 10 to 13 digits) keeps no exemption (ruling R2-4).
  if ((run.startsWith("0") || run.startsWith("92")) && digits <= 13) return true
  // Thirteen digits (a CNIC's length), and ten or more single-digit groups (form boxes), keep no exemption (R3-7).
  if (digits === 13 || groups.filter((g) => g.length === 1).length >= 10) return true
  // A card or account number (14 to 19 digits, one group or groups of four, not a list of years) keeps none (R4-0).
  if (digits >= 14 && digits <= 19 && (groups.length === 1 || groups.every((g) => g.length === 4)) && !groups.every((g) => YEAR.test(g))) return true
  // Section lists ("302/324/148/149") and year lists: every group short or a year.
  if (groups.every((g) => g.length <= 3 || YEAR.test(g))) return false
  // A case number with its year ("123456/2021").
  if (groups.length === 2 && run.includes("/") && YEAR.test(groups[1]!)) return false
  // A mobile without its prefix (3 and nine or ten digits) keeps no exemption either (ruling R3-7).
  if (run.startsWith("3") && digits <= 11) return true
  const before = text.slice(Math.max(0, at - WINDOW), at)
  // An amount is one group of at most eleven digits, with paisa at most ("12500000000/=", "2500000000.50") (R3-7; R4-0
  // lowered the bound from twelve, so "Rs. 123456789012 were credited to account" counts).
  const oneAmount = groups[0]!.length <= 11 && (groups.length === 1 || (groups.length === 2 && run[groups[0]!.length] === "." && groups[1]!.length === 2))
  if (oneAmount && (CURRENCY_BEFORE_RE.test(before) || AMOUNT_BEFORE_RE.test(before))) return false
  if (oneAmount && CURRENCY_AFTER_RE.test(text.slice(at + run.length, at + run.length + WINDOW + 8))) return false
  // Document and land-record numbers (ruling R2-3h).
  if (DOCUMENT_BEFORE_RE.test(before) || LAND_BEFORE_RE.test(before)) return false
  return true
}

function idDigits(text: string): number {
  let count = 0
  for (const m of text.matchAll(DIGIT_RUN)) {
    let run = m[0]
    let at = m.index
    // Dates at the start are read off one by one; what follows is judged alone (R3-2: "dated 01.02.2021 1234/2021").
    for (let date = DATE_PREFIX.exec(run); date !== null && run !== ""; date = DATE_PREFIX.exec(run)) {
      const separator = RUN_SEPARATOR.exec(run.slice(date[0].length))
      const cut = date[0].length + (separator?.[0].length ?? run.length)
      at += cut
      run = run.slice(cut)
    }
    if (run !== "" && identifyingRun(text, run, at)) count += 1
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
/** A passport or email value: its first token, and the digit groups that follow it. */
const VALUE = /^\S+(?: \d[\d\-./]*)*/u
/** A number's value: everything up to the next letter or line end, so every digit group counts (ruling R3-3). */
const DIGITS_VALUE = /^[^\p{L}\n]*/u
const HANDLE = /[\p{L}\p{N}][._][\p{L}\p{N}]/u
const SPELLED_AT = /^\S+\s+(?:at|\[at\]|\(at\))\s/iu
/** "email nura at qalvo dot pk": a spelled address needs no separator after its label. */
const SPELLED_EMAIL = /^\s+\S+\s+(?:at|\[at\]|\(at\))\s+\S+\s+(?:dot|\[dot\]|\(dot\))\s+\S/iu

function labelledIdentifiers(text: string): number {
  let count = 0
  for (const m of text.matchAll(LABEL)) {
    const kind = (Object.keys(LABELS) as Array<keyof typeof LABELS>).find((k) => m.groups?.[k] !== undefined)!
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + WINDOW)
    const sep = LABEL_SEPARATORS.exec(after)
    if (sep === null) {
      if (kind === "email" && SPELLED_EMAIL.test(after)) count += 1
      continue
    }
    const rest = after.slice(sep[0].length)
    if (startsWithToken(rest)) continue
    let identifying: boolean
    if (kind === "email" || kind === "passport") {
      const value = VALUE.exec(rest)?.[0]
      if (value === undefined) continue
      identifying =
        kind === "email"
          ? value.includes("@") || HANDLE.test(value) || SPELLED_AT.test(rest)
          : /^[\p{L}\p{N}]{7,}/u.test(value) && /\d/.test(value)
    } else {
      identifying = DIGITS_VALUE.exec(rest)![0].replace(/\D/g, "").length >= LABEL_MIN_DIGITS[kind]
    }
    if (identifying) count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// address
// ---------------------------------------------------------------------------

const RESIDENCE = new RegExp(`${BEFORE}(${alternation(RESIDENCE_CUES)})${AFTER}`, "giu")
const RESIDENT_OF_RE = cueRegex(RESIDENT_OF)
const RESIDENTS_OF_RE = cueRegex(RESIDENTS_OF)
const LIVES_AT_RE = cueRegex(LIVES_AT)
const UR_RESIDENT_RE = cueRegex(UR_RESIDENT_PHRASES)
const FROM_RE = cueRegex(FROM_CUES)
const CARE_OF_RE = cueRegex(CARE_OF)
const UR_DWELL_RE = cueRegex(UR_DWELL)
/** The two words before an index, the nearer last (within the window). */
const TWO_WORDS_BEFORE = /(?:([\p{L}\p{N}][\p{L}\p{M}\p{N}]*)[\s\p{M}]+)?([\p{L}\p{N}][\p{L}\p{M}\p{N}]*)[\s\p{M}]*$/u
const LOCALITY = cueRegex(LOCALITY_CUES)
const LOCALITY_SET = new Set(LOCALITY_WORDS)
const PLACE_CUE_SET = new Set([...BARE_PLACES, ...NUMBERED_PLACES].map((p) => p.replace(/\.$/, "")))
/** A residence cue (and its determiners) just before a locality cue: the residence cue has counted that place. */
const RESIDENCE_JUST_BEFORE = new RegExp(
  `${BEFORE}${alternation([...RESIDENCE_CUES, ...RESIDENT_OF, ...RESIDENTS_OF, ...LIVES_AT])}(?:\\s+(?:the|said|in|at))*\\s*$`,
  "iu"
)
const ADDRESS_LABEL = cueRegex(ADDRESS_LABELS)
/**
 * After an address label, "of", an optional "the" or "said", a party role or occupation and its number, then ":" or "-"
 * ("Address of accused: ...", "Address of the respondent No. 2: ..."; ruling R5-3).
 */
const ADDRESS_OF_ROLE = new RegExp(
  `^\\s+of\\s+(?:the\\s+)?(?:said\\s+)?${alternation([...ROLE_WORDS, ...EN_OCCUPATIONS])}${AFTER}(?:(?:\\s+(?:nos?\\.?|number))?\\s*\\d+)?(?=\\s*[:-])`,
  "iu"
)
/** After an address label: ":" or "-" (group 1), or "as" or "is" (group 2). */
const ADDRESS_SEPARATOR = /^\s*(?:([:-])|(as|is)(?![\p{L}\p{N}]))/iu
const NO_ADDRESS = new RegExp(`^\\s*${alternation(NO_ADDRESS_VALUES)}${AFTER}`, "iu")
const ADDRESS_WORD = cueRegex(ADDRESS_WORDS)
const ADDRESS_WORD_SET = new Set(ADDRESS_WORDS)
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
/** A range of numbers is not an address: "Flat No. 4 to Flat No. 9", "Flats No. 4 to 9" (fresh corpus line 68). */
const RANGE_AFTER = /^\s+(?:to|till|through|upto)(?![\p{L}\p{N}])/iu
/** "Street No. 3 of the housing scheme": a numbered place of a common noun is a part of it, not an address. */
const OF_THE_COMMON = /^\s+of\s+the\s+\p{Ll}/u
/**
 * What may follow a bare number for it to be an address: punctuation, a place cue (case-insensitive), a proper noun
 * (case-sensitive: under the `i` flag `\p{Lu}` would match lower case too, so it has its own regex), a word of position
 * ("House 12 near the mosque"), or "of" and a proper noun ("Street 5 of Qalvo Town", not "House 2 of the Senate").
 */
const BARE_FOLLOWER_PUNCT = /^\s*[,.;:)\]\n]/u
const BARE_FOLLOWER_CUE = new RegExp(`^\\s+(?:(?:and|&|or)\\s+)?${alternation([...BARE_PLACES, ...NUMBERED_PLACES])}${AFTER}`, "iu")
const BARE_FOLLOWER_PROPER = /^\s+[\p{Lu}\p{Script=Arabic}]/u
const BARE_FOLLOWER_POSITION = /^\s+(?:near|opposite|behind|adjacent|beside|next\s+to)(?![\p{L}\p{N}])/iu
const BARE_FOLLOWER_OF = /^\s+of\s+(?![Tt]he(?![\p{L}\p{N}]))\p{Lu}/u
/** An address word within the next two words: "Street 5 qalvo town" (ruling R4-3). */
const BARE_FOLLOWER_PLACE_WORD = new RegExp(`^\\s+(?:[\\p{L}\\p{N}]+\\s+)?${alternation(ADDRESS_WORDS)}${AFTER}`, "iu")
/** "House No. 5 in Qalvo Town": a numbered place in a named one. */
const IN_A_PLACE = /^\s+(?:in|at)\s+\p{Lu}/u
const bareFollower = (follower: string) =>
  BARE_FOLLOWER_PUNCT.test(follower) ||
  BARE_FOLLOWER_CUE.test(follower) ||
  BARE_FOLLOWER_PROPER.test(follower) ||
  BARE_FOLLOWER_POSITION.test(follower) ||
  BARE_FOLLOWER_OF.test(follower) ||
  BARE_FOLLOWER_PLACE_WORD.test(follower)

const isGeneralArea = (w: string) => NOT_AN_ADDRESS.has(lower(w)) || GENERAL_AREA.has(lower(w))

/**
 * A named place at `words[i]` after a general area or a province: a capitalised word, a number, or an Urdu word that is
 * not a stop word or a role noun, and not itself a general area ("District Kasur", "شہر قلوو"; not "Province of
 * Punjab").
 */
function namedPlaceAt(words: string[], i: number): boolean {
  const w = words[i]
  if (w === undefined || isToken(w) || isGeneralArea(w)) return false
  if (ARABIC.test(w)) return !UR_STOP.has(w) && !UR_ROLE_NOUNS.has(w)
  return /^[\p{Lu}\p{N}]/u.test(w) && !EN_FUNCTION.has(lower(w))
}

/**
 * A province, the country or a general-area word at `words[i]` (ruling R4-3): it names no place only when it is the
 * whole place ("a resident of Punjab.", "ساکن علاقہ ہذا"). Followed by a place-name noun ("Punjab Colony", "Pakistan
 * Town"), a further proper noun ("District Kasur", "city Lahore", "شہر قلوو") or "of" and one ("the area of Qalvo
 * Pura"), it counts; "Pakistan and of Lahore" goes on to Lahore.
 */
function generalAreaAt(words: string[], i: number, cue: string): boolean {
  const next = words[i + 1]
  if (next === undefined || isToken(next)) return false
  const ln = lower(next)
  if (ln === "and") return placeAt(words, lower(words[i + 2] ?? "") === "of" ? i + 3 : i + 2, cue)
  if (ln === "of") return namedPlaceAt(words, i + 2)
  if (PLACE_NAME_NOUNS.has(ln)) return true
  return namedPlaceAt(words, i + 1)
}

/**
 * A place at `words[i]` (rulings R2-3c, R3-5, R4-3): any content word, except a function word, an Urdu stop word, role
 * noun or adjectival collocation, and a general area or province that is the whole place; "the (said) village Kot ...",
 * "the area of Qalvo Pura" and "the house of Kamran ..." name a place too.
 */
function placeAt(words: string[], i: number, cue: string): boolean {
  const w = words[i]
  if (w === undefined || isToken(w)) return false
  const lw = lower(w)
  if (isGeneralArea(w)) return generalAreaAt(words, i, cue)
  if (ARABIC.test(w)) return !UR_STOP.has(w) && !UR_ROLE_NOUNS.has(w) && !(UR_ADJECTIVAL.get(cue)?.has(w) ?? false)
  if (!EN_FUNCTION.has(lw)) return true
  if (lw !== "the" && lw !== "said") return false
  let j = i + 1
  if (lower(words[j] ?? "") === "said") j += 1
  const place = words[j]
  if (place === undefined) return false
  if (GENERAL_AREA.has(lower(place))) return lower(words[j + 1] ?? "") === "of" && namedPlaceAt(words, j + 2)
  if (!PLACE_NOUNS.includes(lower(place))) return false
  let target = words[j + 1]
  if (lower(target ?? "") === "of") target = words[j + 2]
  return target !== undefined && !isToken(target) && lower(target) !== "the" && /^[\p{Lu}\p{N}]/u.test(target)
}

/** After a residence cue: "r/o in Lahore" reads past the preposition, "ساکن مدعی گاؤں قلوو" past the role noun (R3-5). */
function residenceTarget(words: string[], cue: string): boolean {
  let i = 0
  if (!ARABIC.test(cue) && (lower(words[0] ?? "") === "in" || lower(words[0] ?? "") === "at")) i = 1
  while (words[i] !== undefined && UR_ROLE_NOUNS.has(words[i]!)) i += 1
  return placeAt(words, i, cue)
}

/** After a plural residence cue: a locality word, then a named or numbered place (ruling R3-5). */
function pluralTarget(words: string[]): boolean {
  let i = 0
  while (lower(words[i] ?? "") === "the" || lower(words[i] ?? "") === "said") i += 1
  if (words[i] === undefined || !LOCALITY_SET.has(lower(words[i]!))) return false
  let next = words[i + 1]
  if (next !== undefined && /^(?:nos?|number|نمبر)$/iu.test(next)) next = words[i + 2]
  if (next === undefined || isToken(next)) return false
  if (ARABIC.test(next)) return !UR_STOP.has(next) && !UR_ROLE_NOUNS.has(next) && !GENERAL_AREA.has(next)
  return /^[\p{Lu}\p{N}]/u.test(next) && !EN_FUNCTION.has(lower(next))
}

/**
 * After "lives", "residing", "abode", "settled", "residence" ...: within ten words, "at", "in", "near" or "opposite",
 * then a number (not a year: "settled in 2019"), a proper noun or "the (said) village Kot ..." (rulings R3-5, R4-3,
 * R5-3). A place cue there is left to the numbered-place check, so "resides at Plot No. 123" counts once; "lives in
 * fear", "resides at a distance" do not count.
 */
function livesAtTarget(words: string[]): boolean {
  for (let i = 0; i < words.length - 1; i++) {
    if (!LIVES_PREPOSITIONS.has(lower(words[i]!))) continue
    const w = words[i + 1]!
    const lw = lower(w)
    if (isToken(w) || PLACE_CUE_SET.has(lw)) continue
    if (/\d/.test(w)) {
      if (YEAR.test(w)) continue
      return true
    }
    if (lw === "the" || lw === "said") {
      if (placeAt(words, i + 1, "")) return true
      continue
    }
    if (!capitalised(w) || EN_FUNCTION.has(lw)) continue
    if (isGeneralArea(w) ? generalAreaAt(words, i + 1, "") : true) return true
  }
  return false
}

/**
 * Before an Urdu residence phrase ("کا رہنے والا"): the place, unless it is a stop word, a role noun, a general area or a
 * province, or comes after "اسی", "ایک" and the like ("اسی شہر کا رہنے والا"; ruling R4-3).
 */
function urduResidentBefore(text: string, index: number): boolean {
  const m = TWO_WORDS_BEFORE.exec(text.slice(Math.max(0, index - WINDOW), index))
  if (m === null) return false
  const [, before, place] = m
  if (place === undefined || isToken(place) || UR_STOP.has(place) || UR_ROLE_NOUNS.has(place) || isGeneralArea(place)) return false
  return before === undefined || !UR_INDEFINITE.has(before)
}

/**
 * After an origin cue ("hails from", "originally from", "belongs to": ruling R5-3): a number, a proper noun that is not
 * a role or an organisation word, a locality word and a name ("village Qalvo Pura"), or "the (said) village Kot ...". A
 * province or the country counts only as part of a longer place, as after a residence cue. "hails from a family",
 * "belongs to the same caste", "belongs to Respondent No. 1" do not count.
 */
function fromTarget(words: string[]): boolean {
  const w = words[0]
  if (w === undefined || isToken(w)) return false
  const lw = lower(w)
  if (/^\p{N}/u.test(w)) return !YEAR.test(w)
  if (lw === "the" || lw === "said") return placeAt(words, 0, "") || pluralTarget(words)
  if (LOCALITY_SET.has(lw)) return pluralTarget(words)
  if (!capitalised(w) || EN_FUNCTION.has(lw) || ROLE_WORDS.has(lw) || EN_OFFICES.has(lw) || EN_OCCUPATIONS.has(lw)) return false
  if (isGeneralArea(w)) return generalAreaAt(words, 0, "")
  return !EN_SKIP.has(lw)
}

/** After "C/o": past mask tokens and "the", a number, a proper noun or an Urdu word that is not a stop word (R5-3). */
function careOfTarget(words: string[]): boolean {
  for (const w of words) {
    const lw = lower(w)
    if (isToken(w) || lw === "the" || lw === "said") continue
    if (/\p{N}/u.test(w)) return true
    if (ARABIC.test(w)) return !UR_STOP.has(w)
    return capitalised(w) && !EN_FUNCTION.has(lw)
  }
  return false
}

/** Up to three words before `index`, the nearest last, within the window and after the last sentence end or line break. */
function wordsBefore(text: string, index: number): string[] {
  const slice = text.slice(Math.max(0, index - WINDOW), index)
  const sentence = slice.slice(Math.max(...[...".!?;\n۔؟|"].map((c) => slice.lastIndexOf(c))) + 1)
  return (sentence.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? []).slice(-3)
}

/**
 * An Urdu word that may be the place next to a residence word: not a stop word, a role, an occupation, a general area or
 * province, an adverb of place, or a word after "اسی", "اپنے" and the like ("اپنے گاؤں میں مقیم", in his own village).
 */
function urduPlaceWord(w: string | undefined, before: string | undefined): boolean {
  if (w === undefined || isToken(w) || !ARABIC.test(w)) return false
  if (UR_STOP.has(w) || UR_ROLE_NOUNS.has(w) || UR_OCCUPATIONS.has(w) || isGeneralArea(w) || UR_PLACE_ADVERBS.has(w) || UR_INDEFINITE.has(w) || UR_DWELLING.has(w)) {
    return false
  }
  return before === undefined || !UR_INDEFINITE.has(before)
}

/**
 * An Urdu residence word ("رہائش پذیر", "سکونت پذیر", "مقیم": ruling R5-3) counts when the word next to it on either
 * side, read past "میں", "پر" or "بمقام", is a place: "قلوو ٹاؤن میں رہائش پذیر", "بمقام قلوو پورہ سکونت پذیر", "مقیم بمقام
 * قلوو پورہ". "یہاں مقیم ہے", "بیرون ملک مقیم ہے" and "اپنے گاؤں میں مقیم ہے" do not count.
 */
function urduDwell(text: string, index: number, end: number): boolean {
  const before = wordsBefore(text, index)
  let k = before.length - 1
  if (k >= 0 && UR_DWELL_PAST.has(before[k]!)) k -= 1
  if (k >= 0 && urduPlaceWord(before[k], before[k - 1])) return true
  const after = wordsAfter(text, end, 3)
  const next = UR_DWELL_PAST.has(after[0] ?? "") ? after[1] : after[0]
  return urduPlaceWord(next, undefined)
}

/** "اہل محلہ" (the people of the neighbourhood) is no address (ruling R4-4). */
const AHL_BEFORE = /(?<![\p{L}\p{N}])اہل[\s\p{M}]*$/u

/** After a locality cue on its own: a name ("Mohallah Qalvo Pura", "محلہ قلوو پورہ"), not "محلہ داروں" (R3-5). */
function localityTarget(words: string[]): boolean {
  const [w] = words
  if (w === undefined || isToken(w) || !/^\p{L}/u.test(w)) return false
  if (ARABIC.test(w)) return !UR_STOP.has(w) && !UR_ROLE_NOUNS.has(w) && !UR_LOCALITY_NOT_A_NAME.has(w) && !GENERAL_AREA.has(w)
  return capitalised(w) && !EN_FUNCTION.has(lower(w)) && !ROLE_WORDS.has(lower(w))
}

/** True at a field start: the start of the text or line, after "|", ";", ",", "(" or "[", or after a qualifier. */
function atFieldStart(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - WINDOW), index).replace(/[ \t]+$/, "")
  if (before === "") return true
  if ("\n|;,([".includes(before.at(-1)!)) return true
  return QUALIFIER_BEFORE.test(before)
}

/**
 * An address label (rulings R2-3f, R3-5): at a field start, with ":" or "-", any value; anywhere else, a value with a
 * digit or an address word in its first 60 characters ("gave his address: 12-B Qalvo Road", "his address as ..."), or,
 * with no separator, a value that starts with a number or names an address word in its first three words. A value
 * that says there is none ("not known", "same as above", "as stated") never counts.
 */
function addressLabel(text: string, index: number, end: number): boolean {
  // "Address of accused:", "Address of the respondent No. 2 -": a label for a party's address (ruling R5-3).
  const ofRole = ADDRESS_OF_ROLE.exec(text.slice(end, end + WINDOW))
  const labelEnd = end + (ofRole?.[0].length ?? 0)
  const after = text.slice(labelEnd, labelEnd + WINDOW)
  const sep = ADDRESS_SEPARATOR.exec(after)
  const value = sep === null ? after : after.slice(sep[0].length)
  const trimmed = value.trimStart()
  if (trimmed === "" || startsWithToken(trimmed) || NO_ADDRESS.test(value)) return false
  if (sep?.[1] !== undefined && (ofRole !== null || atFieldStart(text, index))) {
    const [next] = wordsAfter(text, labelEnd + sep[0].length, 1)
    return next !== undefined && !isToken(next)
  }
  if (sep === null) {
    const words = wordsAfter(text, labelEnd, 3)
    return words.length > 0 && (/\d/.test(words[0]!) || words.some((w) => ADDRESS_WORD_SET.has(lower(w))))
  }
  const head = value.slice(0, VALUE_WINDOW)
  return /\d/.test(head) || ADDRESS_WORD.test(head)
}

function addresses(text: string): number {
  let count = 0
  for (const m of text.matchAll(RESIDENCE)) if (residenceTarget(wordsAfter(text, m.index + m[0].length, 6), m[1]!)) count += 1
  for (const m of text.matchAll(RESIDENT_OF_RE)) if (residenceTarget(wordsAfter(text, m.index + m[0].length, 6), "")) count += 1
  for (const m of text.matchAll(RESIDENTS_OF_RE)) if (pluralTarget(wordsAfter(text, m.index + m[0].length, 5))) count += 1
  for (const m of text.matchAll(LIVES_AT_RE)) if (livesAtTarget(wordsAfter(text, m.index + m[0].length, LIVES_WINDOW + 1))) count += 1
  for (const m of text.matchAll(UR_RESIDENT_RE)) if (urduResidentBefore(text, m.index)) count += 1
  for (const m of text.matchAll(FROM_RE)) if (fromTarget(wordsAfter(text, m.index + m[0].length, 5))) count += 1
  for (const m of text.matchAll(CARE_OF_RE)) if (careOfTarget(wordsAfter(text, m.index + m[0].length, 4))) count += 1
  for (const m of text.matchAll(UR_DWELL_RE)) if (urduDwell(text, m.index, m.index + m[0].length)) count += 1
  for (const m of text.matchAll(LOCALITY)) {
    const before = text.slice(Math.max(0, m.index - WINDOW), m.index)
    if (RESIDENCE_JUST_BEFORE.test(before) || AHL_BEFORE.test(before)) continue
    if (localityTarget(wordsAfter(text, m.index + m[0].length, 1))) count += 1
  }
  for (const m of text.matchAll(ADDRESS_LABEL)) if (addressLabel(text, m.index, m.index + m[0].length)) count += 1
  for (const m of text.matchAll(NUMBERED_PLACE)) {
    const explicit = m[2] !== undefined
    if (!explicit && NUMBERED_ONLY.test(m[1]!)) continue
    const endAt = m.index + m[0].length
    // A house with an explicit number always counts (ruling R4-3).
    if (explicit && HOUSE_CUES.has(lower(m[1]!))) {
      count += 1
      continue
    }
    const follower = text.slice(endAt, endAt + WINDOW)
    if (RANGE_AFTER.test(follower)) continue
    // An explicit "No." makes a flat, shop or plot a numbered place whatever unit follows ("Flat No. 4 floor 3": R3-5),
    // but, like a bare number, it needs an address-like follower: "Street No. 3 of the housing scheme" names no place.
    if (explicit) {
      if (OF_THE_COMMON.test(follower)) continue
      if (endAt === text.length || UNIT_AFTER.test(follower) || IN_A_PLACE.test(follower) || bareFollower(follower)) count += 1
      continue
    }
    if (UNIT_AFTER.test(follower)) continue
    if (endAt < text.length && !bareFollower(follower)) continue
    count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// kinship_name
// ---------------------------------------------------------------------------

const KINSHIP = new RegExp(
  `${BEFORE}(?:(?<any>${alternation(KIN_ANY)})|(?<urdu>${alternation(KIN_URDU)})|(?<label>${alternation(KIN_LABELS)})|(?<capital>${alternation(KIN_CAPITAL)}))${AFTER}`,
  "giu"
)

/** The number of words a party-role, title or office reference takes at `words[i]` ("Opposite Party" is two), or 0. */
function roleLength(words: string[], i: number): number {
  const whole = lower(words[i]!).replace(/['\u2019]s$/, "")
  const w = whole.split(/[-.]/)[0]!
  if (!ROLE_WORDS.has(w) && !ROLE_WORDS.has(lower(words[i]!)) && !EN_OFFICES.has(w) && !EN_OFFICES.has(whole)) return 0
  return w === "opposite" && lower(words[i + 1] ?? "") === "party" ? 2 : 1
}

const nameLike = (w: string | undefined): boolean =>
  w !== undefined && !isToken(w) && /^\p{L}/u.test(w) && !EN_FUNCTION.has(lower(w)) && !UR_STOP.has(w)

/** How many words after an English kinship cue the walk reads (ruling R5-2); after an Urdu one, ten. */
const KIN_WINDOW_EN = 8
const KIN_WINDOW_UR = 10

type KinCue = "any" | "urdu" | "label" | "capital"

/**
 * Whether a kinship cue is followed by a name (rulings R2-3b, R3-4, R4-2, R5-2).
 *   - English, within eight words: a lower-case finite verb or auxiliary (EN_ENDERS), a mask token or a sentence end
 *     ends the walk ("son of the deceased appeared", "son of the then SHO was transferred"). Every other lower-case word
 *     is skipped: determiners, "then", participles and adverbs ("a sitting MNA", "a recently retired Judge"),
 *     prepositions and conjunctions ("none other than Kamran"). Titles, ranks, offices and roles are skipped too ("the
 *     then SHO", "the outgoing Chairman"), and so are organisation words, nationality words and the country and its
 *     provinces ("a Government servant", "a Pakistani national"). The first capitalised word that is none of these is
 *     a name ("son of a Lahore High Court judge" counts: R4-0 accepts it). After "one", "said", a title, a role or an
 *     occupation (any-case mode) the first unlisted lower-case word that is not a participle or an adverb is a name too
 *     ("son of our client kamran"); a preposition or a conjunction starts a new phrase and ends that mode.
 *   - "Respondent No. 2 Kamran": a role's number is read past.
 *   - Urdu: the first word that is not a stop word, a role noun, an ordinal, an occupation or a title is a name.
 *     "دختر نیک اختر", "شادی شدہ" and "عدالت میں" are phrases, not names; a comma straight after the cue begins a list
 *     ("بیوہ، دو بیٹے").
 */
function kinshipName(cue: KinCue, cueWord: string, words: string[], commaAfterCue: boolean): boolean {
  const anyCue = cue === "any" || cue === "label"
  let anyCase = anyCue
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const lw = lower(w)
    if (isToken(w)) return false
    if (ARABIC.test(w)) {
      if (i === 0 && commaAfterCue) return false
      if (UR_STOP.has(w) || UR_NOT_A_NAME.has(w)) return false
      const phrase = UR_PHRASES.get(w)
      if (phrase !== undefined && phrase.has(words[i + 1] ?? "") && (w !== "نیک" || cueWord === "دختر")) return false
      if (UR_ROLE_NOUNS.has(w) || UR_ORDINALS.has(w) || UR_OCCUPATIONS.has(w) || TITLE_WORDS.has(w)) continue
      if (i === 0 && UR_IDIOM.get(cueWord) === w) continue
      return true
    }
    if (/^\p{Ll}/u.test(w) && EN_ENDERS.has(lw)) return false
    if (EN_DETERMINERS.has(lw)) {
      anyCase = lw === "one" || lw === "said" || anyCue
      continue
    }
    if (TITLE_WORDS.has(lw) || EN_NAMING.has(lw)) {
      anyCase = true
      continue
    }
    if (NAME_TITLES.has(lw)) return nameLike(words[i + 1]) || capitalised(w)
    const role = roleLength(words, i)
    if (role > 0) {
      // A possessive role ("the deceased's friend") is followed by a common noun; a role by itself by a name.
      anyCase = !/['\u2019]s$/u.test(words[i + role - 1]!)
      i += role - 1
      // "Respondent No. 2 Kamran": read past the role's number.
      if (/^(?:no|nos|number)$/i.test(words[i + 1] ?? "") && /^\p{N}/u.test(words[i + 2] ?? "")) i += 2
      else if (/^\p{N}/u.test(words[i + 1] ?? "")) i += 1
      continue
    }
    const bare = lw.replace(/['\u2019]s$/, "")
    if (EN_OCCUPATIONS.has(bare)) {
      anyCase = bare === lw
      continue
    }
    if (EN_SKIP.has(lw) || !/^\p{L}/u.test(w)) continue
    // A preposition or a conjunction starts a new phrase: skipped, and the walk is back in capital mode. After a
    // parentage label the first word is the value, so a function word there means none ("Father's name: not mentioned").
    if (EN_FUNCTION.has(lw)) {
      if (cue === "label") return false
      anyCase = anyCue
      continue
    }
    if (i === 0 && cue === "capital" && EN_IDIOM.get(lower(cueWord).replace(/\s+/g, " ")) === lw) return false
    if (capitalised(w)) return true
    // A participle or an adverb is never the name ("a sitting MNA", "a highly placed officer").
    if (/^\p{Ll}\p{L}*(?:ing|ly)$/u.test(w)) continue
    if (anyCase || cue === "urdu") return true
  }
  return false
}

/** A comma (Urdu or Latin) straight after a cue. */
const COMMA_AFTER = /^[\s\p{M}]*[،,]/u

function kinshipNames(text: string): number {
  let count = 0
  for (const m of text.matchAll(KINSHIP)) {
    const g = m.groups!
    const cue: KinCue = g.any !== undefined ? "any" : g.urdu !== undefined ? "urdu" : g.label !== undefined ? "label" : "capital"
    const end = m.index + m[0].length
    const comma = cue === "urdu" && COMMA_AFTER.test(text.slice(end, end + 8))
    if (kinshipName(cue, m[0], wordsAfter(text, end, cue === "urdu" ? KIN_WINDOW_UR : KIN_WINDOW_EN), comma)) count += 1
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
