import type { DocumentType } from "./doctypes"
import type { VerbatimField } from "./generations"
import type { OutlineContent } from "./guardrails"

/**
 * The prompt contract of draft generation (spec "Prompt contract", P4B-4; plan D25). Each P1 call of a generation step
 * sends one user message (P3-68): fixed instructions, then the document type's structure, the verbatim fields, the
 * facts and, for a section, the approved outline and the section before it.
 *
 * The prompt never carries the generation's label, the matter id or a party list: those reach P1 only as the call's
 * `classification` and `partyNames`, and P1 tokenises every party name, pattern value and verbatim value in this text
 * before anything leaves (P4B-6). The builders are pure: the same input gives the same text.
 *
 * The fixed text below is version `PROMPT_VERSION`. Any change to it is a new version.
 */

export const PROMPT_VERSION = "4b.1"
/** The P1 purpose of an outline call (P4B-4): fixed, never free text. */
export const OUTLINE_PURPOSE = "draft-outline"
/** The P1 purpose of a section call (P4B-4). */
export const SECTION_PURPOSE = "draft-section"

/**
 * The most a section body is asked to run to, in words (D25): an answer of about this length ends well inside P1's 60 s
 * transport timeout at an assumed 40 to 70 output tokens a second [estimated, unmeasured: O-57], where a 4,096-token
 * answer might not. The outline is asked to split any part that would need more.
 */
export const SECTION_WORD_BUDGET = 1_000

/** `1000` as `1,000`, without a locale. */
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
const WORDS = `${grouped(SECTION_WORD_BUDGET)} words`

/** The fact, authority, placeholder and token rules, which every call carries. */
const SHARED_RULES: readonly string[] = [
  "Use no fact that is not in the facts below. Introduce no authority (no case, statute, rule or other source of law) that is not in the facts below, and copy any authority you use exactly as it is written there.",
  "Write no placeholder, no bracketed note and no ellipsis.",
  "A token written as ⟦KIND_n⟧ stands for a value withheld from you: a party, an identity or contact detail, or a text the advocate fixed word for word. Copy each token exactly, character for character, wherever its value belongs. Never alter, split, translate or invent a token.",
]

const OUTLINE_RULES: readonly string[] = [
  'Answer with one JSON object of exactly this shape and nothing before or after it (you may put it in one ```json fence): {"sections": [{"heading": string, "purpose": string}], "missingFacts": [{"field": string, "note": string}]}.',
  '"sections" lists the parts of the document in order, following the architecture of this document type: for a pleading, the facts as numbered paragraphs, then the grounds, then the prayer. Each heading is one line of at most 200 characters. Each purpose says, in at most 2,000 characters, what the part must establish.',
  '"missingFacts" lists each required field below that the facts do not supply, with a short note of what is missing. It is an empty list when nothing is missing.',
  `Plan each part so that its body can be written in about ${WORDS} or fewer. Split any part that would need more into further sections, with at most 25 sections in all.`,
  ...SHARED_RULES,
]

const sectionRules = (section: number, count: number): readonly string[] => [
  `Write the body of section ${section} of ${count} as plain text, without its heading, following its purpose in the approved outline, in at most about ${WORDS}.`,
  "Leave a point out where the facts do not support it, rather than mark a gap.",
  "Apply the first-ground rule below to the first ground.",
  ...SHARED_RULES,
]

const numbered = (lines: readonly string[]): string => lines.map((line, i) => `${i + 1}. ${line}`).join("\n")

/** One `<field>: <text>` line per verbatim field, in the brief's order (P1 tokenises each text). */
const verbatimBlock = (verbatim: readonly VerbatimField[]): string =>
  verbatim.length === 0 ? "Verbatim fields: none" : `Verbatim fields:\n${verbatim.map((v) => `${v.field}: ${v.text}`).join("\n")}`

/**
 * The outline call's message (spec "Outline call"): the fixed instructions, then the type's `name`, `firstGroundRule`
 * and `requiredFields`, the verbatim fields as `<field>: <text>` and the facts.
 */
export function outlinePrompt(i: { type: DocumentType; verbatim: readonly VerbatimField[]; facts: string }): string {
  return [
    "You are preparing the strategy outline of a legal document. The advocate approves the outline before any part of the document is drafted.",
    `Rules:\n${numbered(OUTLINE_RULES)}`,
    `Document type: ${i.type.name}`,
    `First-ground rule: ${i.type.firstGroundRule}`,
    `Required fields: ${i.type.requiredFields.join(", ")}`,
    verbatimBlock(i.verbatim),
    `Facts:\n${i.facts}`,
  ].join("\n\n")
}

/**
 * The section call's message (spec "Section call"): the fixed instructions for section `section` of k, then the type's
 * `name` and `firstGroundRule`, the verbatim fields, the facts, the approved outline numbered `<n>. <heading>: <purpose>`,
 * and section `section − 1`'s stored text when there is one.
 */
export function sectionPrompt(i: {
  type: DocumentType
  verbatim: readonly VerbatimField[]
  facts: string
  outline: OutlineContent
  section: number
  previousText: string | null
}): string {
  const count = i.outline.sections.length
  const target = i.outline.sections[i.section - 1]
  return [
    "You are drafting one section of a legal document, following the strategy outline the advocate approved.",
    `Rules:\n${numbered(sectionRules(i.section, count))}`,
    `Document type: ${i.type.name}`,
    `First-ground rule: ${i.type.firstGroundRule}`,
    verbatimBlock(i.verbatim),
    `Facts:\n${i.facts}`,
    `Approved outline:\n${i.outline.sections.map((s, n) => `${n + 1}. ${s.heading}: ${s.purpose}`).join("\n")}`,
    `Write section ${i.section} of ${count}${target === undefined ? "" : `: ${target.heading}`}.`,
    ...(i.previousText === null ? [] : [`Section ${i.section - 1}, already written:\n${i.previousText}`]),
  ].join("\n\n")
}
