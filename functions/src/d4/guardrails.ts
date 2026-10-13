import { rehydrate, type PseudonymMap } from "@/platform/p1/pseudonymiseOutboundPII"
import { extractCitations, isUnrecognisedRef, normaliseCitation } from "@/services/d4-2/citations"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"
import { CONTROL_CHARACTER, sha256Hex } from "./drafts"
import { RESERVED_TOKEN, type VerbatimField } from "./generations"

/**
 * The guardrails of the D4 caller (spec P4B-12; P4-15 put them "in the D4 caller after `callP1` returns"). A model
 * answer is stored only when it passes every check, in this order; the first failure wins, and a failure stores
 * nothing (the caller records the outcome and the cost on the brief and answers 200 `outcome: "refused"`):
 *
 *  1. `output_truncated`: P1 says the answer may be cut short (P4B-5);
 *  2. `output_unparseable`: an outline answer is not one of D11's two shapes or breaks the outline limits; a section is
 *     empty once a first line that repeats its heading is dropped (D10);
 *  3. `rehydration_failed`: no token map came back, or a `⟦`, a `⟧`, a lossy mask token or a bare token is left once the
 *     tokens are re-hydrated, string by string (a damaged or invented token never reaches storage half-restored); the
 *     same check runs again on each string's normalised form in step 5, which can spell a token the answer hid;
 *  4. `output_too_large`: the re-hydrated strings total over MAX_OUTPUT_CHARS;
 *  5. `output_unsupported_characters`: a string the draft charset rule refuses; a string that passes is kept in the
 *     rule's normalised form (requireSupportedDraftBody's), and an outline is then judged against its limits again on
 *     those stored strings (`output_unparseable`), so no stored outline is outside them;
 *  6. `unsupported_authority`: an authority not in the advocate's own text (`newAuthorities`), at most
 *     MAX_UNSUPPORTED_REFS of them recorded.
 *
 * The functions here are pure. The token map is used in process only: nothing here stores, logs or returns it.
 */

export type OutlineContent = { sections: { heading: string; purpose: string }[]; missingFacts: { field: string; note: string }[] }

export type RefusalReason =
  | "output_truncated"
  | "output_unparseable"
  | "rehydration_failed"
  | "output_too_large"
  | "output_unsupported_characters"
  | "unsupported_authority"

export type Guarded<T> = { ok: true; value: T } | { ok: false; reason: RefusalReason; unsupportedRefs: string[] }

/** The most an answer may hold once re-hydrated, in UTF-16 code units (D1). */
export const MAX_OUTPUT_CHARS = 200_000
/** The most new authorities recorded for one refusal. */
export const MAX_UNSUPPORTED_REFS = 50

// The outline limits (spec "Data model"): every length in UTF-16 code units, on the trimmed string.
const MAX_SECTIONS = 25
const MAX_HEADING = 200
const MAX_PURPOSE = 2_000
const MAX_MISSING_FACTS = 50
const MAX_FIELD = 100
const MAX_NOTE = 500

const refuse = (reason: RefusalReason, unsupportedRefs: string[] = []): Guarded<never> => ({ ok: false, reason, unsupportedRefs })

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

/** True when `value` has exactly these own keys, no more and no fewer. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k))
}

/** The trimmed string, when `value` is a string of 1 to `max` characters once trimmed (one line when `oneLine`); else null. */
function boundedString(value: unknown, max: number, oneLine: boolean): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > max) return null
  if (oneLine && CONTROL_CHARACTER.test(trimmed)) return null
  return trimmed
}

/**
 * An outline of D11's shape within the outline limits, its strings trimmed; null otherwise. The keys are exactly
 * `sections` and `missingFacts`, and the entries exactly `{ heading, purpose }` and `{ field, note }`, every value a
 * string: 1 to 25 sections, each heading one line of 1 to 200 characters and each purpose 1 to 2,000; 0 to 50 missing
 * facts, each field one line of 1 to 100 and each note 1 to 500. "One line" means no control character at all, so no
 * line break and no tab, as for a title.
 */
export function validOutline(value: unknown): OutlineContent | null {
  if (!isRecord(value) || !hasExactKeys(value, ["sections", "missingFacts"])) return null
  const { sections, missingFacts } = value
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > MAX_SECTIONS) return null
  if (!Array.isArray(missingFacts) || missingFacts.length > MAX_MISSING_FACTS) return null
  const outSections: OutlineContent["sections"] = []
  for (const entry of sections as unknown[]) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["heading", "purpose"])) return null
    const heading = boundedString(entry.heading, MAX_HEADING, true)
    const purpose = boundedString(entry.purpose, MAX_PURPOSE, false)
    if (heading === null || purpose === null) return null
    outSections.push({ heading, purpose })
  }
  const outMissing: OutlineContent["missingFacts"] = []
  for (const entry of missingFacts as unknown[]) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["field", "note"])) return null
    const field = boundedString(entry.field, MAX_FIELD, true)
    const note = boundedString(entry.note, MAX_NOTE, false)
    if (field === null || note === null) return null
    outMissing.push({ field, note })
  }
  return { sections: outSections, missingFacts: outMissing }
}

/** A fence tagged `json` in any case, on its own line, and its closing fence: the only wrapping D11 admits. */
const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*)\r?\n[ \t]*```$/i

/**
 * An outline answer (D11; Review Focus 3): the bare JSON object, or exactly one fenced block tagged `json` (any case),
 * with only whitespace around either; then `validOutline`. Prose before or after, a second fence, an untagged fence
 * or anything that is not an object is null, never a guessed outline.
 */
export function parseOutlineAnswer(text: string): OutlineContent | null {
  const trimmed = text.trim()
  let json: string
  if (trimmed.startsWith("{")) {
    json = trimmed
  } else {
    const fenced = JSON_FENCE.exec(trimmed)
    if (fenced === null || fenced[1]!.includes("```")) return null
    json = fenced[1]!.trim()
    if (!json.startsWith("{")) return null
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  return validOutline(value)
}

/**
 * The outline's hash (P4B-10): the lowercase hex SHA-256 of UTF-8 `JSON.stringify({ sections: [{ heading, purpose }],
 * missingFacts: [{ field, note }] })`, keys in that order whatever order the object has, over the stored strings.
 */
export function outlineSha256(o: OutlineContent): string {
  return sha256Hex(
    JSON.stringify({
      sections: o.sections.map((s) => ({ heading: s.heading, purpose: s.purpose })),
      missingFacts: o.missingFacts.map((m) => ({ field: m.field, note: m.note })),
    })
  )
}

/**
 * The advocate's own text for guardrail 6 (P4B-12): the title, the facts and each verbatim text, then, for a section,
 * every string of the approved outline (an edit is the advocate's; a generated outline has passed guardrail 6 itself),
 * joined with "\n".
 */
export function advocateText(brief: { title: string; facts: string; verbatim: readonly VerbatimField[] }, outline?: OutlineContent): string {
  const parts = [brief.title, brief.facts, ...brief.verbatim.map((v) => v.text)]
  if (outline !== undefined) {
    for (const s of outline.sections) parts.push(s.heading, s.purpose)
    for (const m of outline.missingFacts) parts.push(m.field, m.note)
  }
  return parts.join("\n")
}

/**
 * The authorities `text` cites that the advocate's own text (`own`) does not, each once, in the order found
 * (P4B-12 step 6; Review Focus 5). The comparison is by `normaliseCitation`'s canonical form, so the advocate's
 * `P.L.D. 2099 Supreme Court 101` is the model's `PLD 2099 SC 101`. A ref the extractor flags as an UNRECOGNISED
 * suspect, or one that does not normalise, is always new: it cannot be shown to be the advocate's. Statutes are not
 * extracted (O-83).
 */
export function newAuthorities(text: string, own: string): string[] {
  const owned = new Set<string>()
  for (const ref of extractCitations(own)) {
    if (isUnrecognisedRef(ref)) continue
    const canonical = normaliseCitation(ref)
    if (canonical !== null) owned.add(canonical)
  }
  const found: string[] = []
  const seen = new Set<string>()
  for (const ref of extractCitations(text)) {
    if (seen.has(ref)) continue
    seen.add(ref)
    const canonical = isUnrecognisedRef(ref) ? null : normaliseCitation(ref)
    if (canonical === null || !owned.has(canonical)) found.push(ref)
  }
  return found
}

type Answer = { text: string; truncated: boolean; pseudonyms?: PseudonymMap }

/**
 * Steps 3 to 5 on the strings of an answer: re-hydrate each (step 3, with the leftover check: RESERVED_TOKEN is the same
 * set of `⟦`, `⟧`, lossy tokens and bare tokens, and is not global), the total (step 4), then the charset rule on each,
 * which gives the stored form (step 5), and the leftover check again on that form (`rehydration_failed`). Returns the
 * stored strings, or the refusal.
 */
function restoreStrings(strings: readonly string[], pseudonyms: PseudonymMap | undefined): { ok: true; value: string[] } | { ok: false; reason: RefusalReason } {
  if (pseudonyms === undefined) return { ok: false, reason: "rehydration_failed" }
  const restored = strings.map((s) => rehydrate(s, pseudonyms))
  if (restored.some((s) => RESERVED_TOKEN.test(s))) return { ok: false, reason: "rehydration_failed" }
  if (restored.reduce((n, s) => n + s.length, 0) > MAX_OUTPUT_CHARS) return { ok: false, reason: "output_too_large" }
  const stored: string[] = []
  for (const s of restored) {
    const check = checkDraftCharset(s)
    if (!check.ok) return { ok: false, reason: "output_unsupported_characters" }
    // The normalised form can spell a token the text as written did not: the charset rule drops a soft hyphen or a
    // zero-width space between two letters of one script (`PAR`, U+00AD, `TY_1` becomes `PARTY_1`). The leftover check
    // is run again on what would be stored, so no reserved token is ever stored.
    if (RESERVED_TOKEN.test(check.normalised)) return { ok: false, reason: "rehydration_failed" }
    stored.push(check.normalised)
  }
  return { ok: true, value: stored }
}

/** Step 6 on the stored strings: their new authorities, at most MAX_UNSUPPORTED_REFS of them, or none. */
function authorityRefusal(strings: readonly string[], own: string): Guarded<never> | null {
  const refs = newAuthorities(strings.join("\n"), own)
  return refs.length === 0 ? null : refuse("unsupported_authority", refs.slice(0, MAX_UNSUPPORTED_REFS))
}

/**
 * An outline answer through the six guardrails (P4B-12), string by string: re-hydrated, normalised and stored as
 * `OutlineContent`. `own` is `advocateText(brief)`.
 */
export function checkOutlineAnswer(answer: Answer, own: string): Guarded<OutlineContent> {
  if (answer.truncated) return refuse("output_truncated")
  const parsed = parseOutlineAnswer(answer.text)
  if (parsed === null) return refuse("output_unparseable")
  const strings = [...parsed.sections.flatMap((s) => [s.heading, s.purpose]), ...parsed.missingFacts.flatMap((m) => [m.field, m.note])]
  const restored = restoreStrings(strings, answer.pseudonyms)
  if (!restored.ok) return refuse(restored.reason)
  const at = (i: number) => restored.value[i]!
  const k = parsed.sections.length
  // The outline as it would be stored, judged against its limits again: a value re-hydrated into a heading can make it
  // too long or two lines (step 2's rule, on the stored strings).
  const outline = validOutline({
    sections: parsed.sections.map((_, i) => ({ heading: at(2 * i), purpose: at(2 * i + 1) })),
    missingFacts: parsed.missingFacts.map((_, i) => ({ field: at(2 * k + 2 * i), note: at(2 * k + 2 * i + 1) })),
  })
  if (outline === null) return refuse("output_unparseable")
  const stored = [...outline.sections.flatMap((s) => [s.heading, s.purpose]), ...outline.missingFacts.flatMap((m) => [m.field, m.note])]
  return authorityRefusal(stored, own) ?? { ok: true, value: outline }
}

/** The first line of `text` (to the first line break), and what follows that break. */
function splitFirstLine(text: string): { first: string; rest: string } {
  const at = text.indexOf("\n")
  return at === -1 ? { first: text, rest: "" } : { first: text.slice(0, at), rest: text.slice(at + 1) }
}

/** A heading line as compared (D10): trimmed, without a trailing colon, NFC, lower case. */
const headingKey = (line: string): string => line.trim().replace(/\s*:$/, "").trim().normalize("NFC").toLowerCase()

/** Leading blank lines dropped and trailing white space trimmed: the section body as stored. */
const tidy = (text: string): string => text.replace(/^(?:[ \t\r]*\n)+/, "").trimEnd()

/**
 * A section answer through the six guardrails (P4B-12). D10 (Review Focus 4): when the answer's first line, trimmed and
 * without a trailing colon, is the section's heading (case-insensitive; a heading that names a party is compared with
 * the line re-hydrated), that line and the blank lines after it are dropped; an answer with nothing else is
 * `output_unparseable`, and so is one that is nothing once the charset rule has normalised it. `own` is
 * `advocateText(brief, approvedOutline)`.
 */
export function checkSectionAnswer(answer: Answer, own: string, heading: string): Guarded<string> {
  if (answer.truncated) return refuse("output_truncated")
  let body = answer.text.replace(/^(?:[ \t\r]*\n)+/, "")
  const { first, rest } = splitFirstLine(body)
  const firstAsWritten = answer.pseudonyms === undefined ? first : rehydrate(first, answer.pseudonyms)
  if (headingKey(firstAsWritten) === headingKey(heading)) body = rest
  body = tidy(body)
  if (body.trim() === "") return refuse("output_unparseable")
  const restored = restoreStrings([body], answer.pseudonyms)
  if (!restored.ok) return refuse(restored.reason)
  const stored = tidy(restored.value[0]!)
  if (stored.trim() === "") return refuse("output_unparseable")
  return authorityRefusal([stored], own) ?? { ok: true, value: stored }
}
