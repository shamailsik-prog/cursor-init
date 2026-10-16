/**
 * Residual PII detector (audit F15; spec docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md,
 * ruling 5). It runs on text the mask has already processed and returns counts by kind, never text.
 *
 * It is independent of the mask by method: the mask recognises specific identifier formats and the names it is given;
 * this detector scans every digit run by its length and grouping, and looks for the contextual cues Pakistani legal
 * prose puts before identifying content (identity and contact labels, residence cues, parentage and marriage cues). It
 * runs on the same detection view (`detectionView`), so it sees every digit script and no invisible character.
 *
 * At rank 3 and above any finding blocks the call (`assertMinimised`, block reason `not_minimised`); below it, the
 * counts are recorded with the call. A finding is a cue, not proof, and no finding is not proof of anonymity.
 */

import { MASK_TOKENS } from "@/platform/p1/maskOutboundPII"
import { detectionView } from "@/platform/p1/piiText"

export const RESIDUAL_KINDS = ["id_digits", "labelled_identifier", "address", "kinship_name"] as const
export type ResidualKind = (typeof RESIDUAL_KINDS)[number]
export type ResidualCounts = Record<ResidualKind, number>

/** How far past a cue the detector reads for its value. */
const WINDOW = 64

const startsWithToken = (text: string): boolean => MASK_TOKENS.some((token) => text.startsWith(token))

// ---------------------------------------------------------------------------
// id_digits
// ---------------------------------------------------------------------------

/** Digit groups joined only by single separators (space, "-", ".", "/"); commas and everything else end a run. */
const DIGIT_RUN = /\d+(?:[ \-./]\d+)*/g
const GROUP_SEPARATOR = /[ \-./]/
const YEAR = /^(?:19|20)\d\d$/
/** A currency marker before the run (₨ is "Rs" in the detection view). */
const CURRENCY_BEFORE = /(?:(?<![\p{L}\p{N}])(?:rs\.?|pkr|usd|us\$)|\$|روپے)\s?$/iu
/** A currency marker after the run: Urdu writes the unit after the amount; "/-" is the Pakistani amount suffix. */
const CURRENCY_AFTER = /^\s?(?:\/-|روپے|rupees?(?![\p{L}\p{N}]))/iu

function idDigits(text: string): number {
  let count = 0
  for (const m of text.matchAll(DIGIT_RUN)) {
    const run = m[0]
    const groups = run.split(GROUP_SEPARATOR)
    if (groups.reduce((n, g) => n + g.length, 0) < 10) continue
    // Section lists ("302/324/148/149") and year lists: every group short or a year.
    if (groups.every((g) => g.length <= 3 || YEAR.test(g))) continue
    // A case number with its year ("123456/2021").
    if (groups.length === 2 && run.includes("/") && YEAR.test(groups[1]!)) continue
    const at = m.index
    if (CURRENCY_BEFORE.test(text.slice(Math.max(0, at - 12), at))) continue
    if (CURRENCY_AFTER.test(text.slice(at + run.length, at + run.length + 12))) continue
    count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// labelled_identifier
// ---------------------------------------------------------------------------

const EMAIL_LABEL = /^(?:e-?mail|ای\s*میل)$/iu
const LABEL =
  /(?<![\p{L}\p{N}])(?:c\.?\s?n\.?\s?i\.?\s?c\.?|n\.?\s?i\.?\s?c\.?|(?:id|identity)\s+card|passport|mobile|cell|telephone|phone|tel|e-?mail|شناختی\s*کارڈ|پاسپورٹ|موبائل|فون|ای\s*میل)(?![\p{L}\p{N}])/giu
/** At least one separator: ":", "#", "-", "No.", "No", "Number", "نمبر". */
const LABEL_SEPARATORS = /^(?:\s*(?:[:#-]|no\.?(?!\p{L})|number(?!\p{L})|نمبر(?!\p{L})))+\s*/iu
/** The value: its first token, and the digit groups that follow it ("0300 123 4567"). */
const VALUE = /^\S+(?: \d[\d\-./]*)*/u

function labelledIdentifiers(text: string): number {
  let count = 0
  for (const m of text.matchAll(LABEL)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + WINDOW)
    const sep = LABEL_SEPARATORS.exec(after)
    if (sep === null) continue
    const rest = after.slice(sep[0].length)
    if (startsWithToken(rest)) continue
    const value = VALUE.exec(rest)?.[0]
    if (value === undefined) continue
    const digits = value.replace(/\D/g, "").length
    const identifying = EMAIL_LABEL.test(m[0]) ? /[\p{L}\p{N}]/u.test(value) : digits >= 3 || value.includes("@")
    if (identifying) count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// address
// ---------------------------------------------------------------------------

/** Cues that only ever precede an address: any content after them counts. */
const RESIDENCE_ABBREVIATION = /(?<![\p{L}\p{N}])(?:r\s?\/\s?o|ساکن|سکنہ)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:address|پتہ|پتا)\s*[:-]/giu
/** "resident(s) of": counts before a proper noun or a number, after any locative words. */
const RESIDENT_OF = /(?<![\p{L}\p{N}])residents?\s+of(?![\p{L}\p{N}])/giu
const LOCATIVE = new Set([
  "the",
  "said",
  "same",
  "village",
  "town",
  "city",
  "district",
  "tehsil",
  "mohallah",
  "mohalla",
  "muhallah",
  "muhalla",
  "house",
  "street",
  "chak",
  "colony",
  "sector",
  "block",
])
const NOT_AN_ADDRESS = new Set(["pakistan", "پاکستان"])
/** A house or street with its number. */
const NUMBERED_PLACE =
  /(?<![\p{L}\p{N}])(?:house\s*(?:no\.?|number|#)?|h\.\s*(?:no\.?|number|#)|مکان\s*(?:نمبر|#)|(?:street|gali|galli|mohallah|mohalla|muhallah|muhalla|گلی|محلہ)\s*(?:no\.?|number|#|نمبر)?)\s*\d/giu

const WORD = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}'\u2019-]*/u
/** Between words: spaces, combining marks (an izafat kasra after a cue) and light punctuation. */
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

function addresses(text: string): number {
  let count = 0
  for (const m of text.matchAll(RESIDENCE_ABBREVIATION)) {
    const [next] = wordsAfter(text, m.index + m[0].length, 1)
    if (next === undefined || MASK_TOKENS.includes(next) || NOT_AN_ADDRESS.has(next.toLowerCase())) continue
    count += 1
  }
  for (const m of text.matchAll(RESIDENT_OF)) {
    const words = wordsAfter(text, m.index + m[0].length, 5)
    const next = words.find((w) => !LOCATIVE.has(w.toLowerCase()))
    if (next === undefined || MASK_TOKENS.includes(next) || NOT_AN_ADDRESS.has(next.toLowerCase())) continue
    if (/^[\p{Lu}\p{N}\p{Script=Arabic}]/u.test(next)) count += 1
  }
  return count + [...text.matchAll(NUMBERED_PLACE)].length
}

// ---------------------------------------------------------------------------
// kinship_name
// ---------------------------------------------------------------------------

/** Group 1: s/o or d/o (any word); group 2: an Urdu cue (any word); otherwise w/o or an English cue (a capital). */
const KINSHIP =
  /(?<![\p{L}\p{N}])(?:([sd]\s?\/\s?o)|w\s?\/\s?o|(?:son|daughter|wife|widow)\s+of|(ولد|بنت|زوجہ|دختر))(?![\p{L}\p{N}])/giu
/**
 * Skipped before the name: "the", "late" (also "(late)") and titles, so "son of the late Mr. Kamran" reaches "Kamran" and
 * "son of the deceased" reaches "deceased". Titles that are also names (Malik, Rana, Syed) are not skipped.
 */
const SKIPPED = new Set(["the", "late", "مرحوم", "mr", "mrs", "ms", "mst", "dr", "ch", "sh"])

function kinshipNames(text: string): number {
  let count = 0
  for (const m of text.matchAll(KINSHIP)) {
    const words = wordsAfter(text, m.index + m[0].length, 4)
    const name = words.find((w) => !SKIPPED.has(w.toLowerCase()))
    if (name === undefined || MASK_TOKENS.includes(name) || !/^\p{L}/u.test(name)) continue
    const anyWord = m[1] !== undefined || m[2] !== undefined || /^\p{Script=Arabic}/u.test(name)
    if (anyWord || /^\p{Lu}/u.test(name)) count += 1
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
