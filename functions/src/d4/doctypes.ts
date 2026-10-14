/**
 * The verified document-type seed (data/documentTypes.json, L18 Annex C) as a read-only catalogue (spec P4-5, E-15):
 * only rows with status VERIFIED are selectable. Rows are copied and frozen at load, so no caller can change the seed.
 */
import seed from "@/data/documentTypes.json"

/** One seed row. `courtIds` may hold a family pattern such as `DSJ_KHI_*` (see courtAllowed). */
export type DocumentType = {
  id: string
  name: string
  category: string
  posture: string
  courtIds: readonly string[]
  temporalBindingRule: string
  firstGroundRule: string
  requiredFields: readonly string[]
  checklist: readonly string[]
  templateId: string
  annexureRule: string
  source: string
  status: string
  note: string
}

function freezeRow(row: DocumentType): DocumentType {
  return Object.freeze({
    ...row,
    courtIds: Object.freeze([...row.courtIds]),
    requiredFields: Object.freeze([...row.requiredFields]),
    checklist: Object.freeze([...row.checklist]),
  })
}

const byId = (a: DocumentType, b: DocumentType) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Verified rows only, sorted by id (code-unit order, so it never depends on a locale). */
const VERIFIED: readonly DocumentType[] = Object.freeze(
  (seed.types as DocumentType[]).filter((t) => t.status === "VERIFIED").map(freezeRow).sort(byId)
)
const BY_ID: ReadonlyMap<string, DocumentType> = new Map(VERIFIED.map((t) => [t.id, t]))

/** The verified type with this id, or null (unknown, or not VERIFIED). */
export function getDocumentType(id: string): DocumentType | null {
  return BY_ID.get(id) ?? null
}

/**
 * A checklist line that asks for legal verification (F06 ruling A): the citation gate ("Gate 33"), statutory text as
 * at a date ("L17.1", "statute", "statutory"), citations, limitation, the provision invoked, jurisdiction, or sources
 * cited. Case-insensitive, whole words, no `g` flag (so `test` keeps no state). Over the seed it selects every NON_FORUM
 * type whose own checklist requires legal verification, exactly these 19: property_suit_possession,
 * property_injunction_suit, secp_complaint, compromise_application, land_regularization_application,
 * mutation_application, demarcation_application, record_of_rights_application, cantonment_application,
 * kda_application, dha_application, legal_opinion, arguments_brief, counter_arguments_brief, case_strategy_memo,
 * case_compendium, due_diligence_report, contract_review_memo and company_incorporation_checklist
 * (functions/test/d4.doctypes.test.ts pins the set). `L17.1` does not match `L17.11`, `L17.2` or `L17.4`.
 */
export const LEGAL_VERIFICATION_ITEM =
  /\bgate\s*33\b|\bL17\.1\b|\bcitations?\b|\bstatut(?:e|es|ory)\b|\blimitation\b|\bprovisions?\b|\bjurisdiction\b|\bsources?\s+cited\b/i

/**
 * NON_FORUM types that are law-dependent by ruling (F06 follow-up audit, 2026-10-14), each with the one-line reason: the
 * checklist item or the rule on which the document's validity turns. Every VERIFIED NON_FORUM seed type was read
 * (its checklist, firstGroundRule and required fields); these are the 17 whose validity turns on a substantive rule of
 * law a partner must verify although no line of their checklist matches `LEGAL_VERIFICATION_ITEM`. Clerical items
 * (parties, recitals, consideration, the execution block, stamp duty and court fee marked MANUAL, formatting) never put
 * a type here. "Registration where compulsory" does so only for the instruments of immovable property, whose own
 * transaction a statute requires to be registered; in a contract on the general law of contract the same template line
 * names no rule that applies to the type. The seed (data/documentTypes.json, L18 Annex C) is partner-approved and is
 * not edited for this: the ruling lives here. Each reason also becomes the type's last review item
 * (`reviewChecklistOf`: `Legal verification (ruling): <reason>`), so the approval records evidence for the legal
 * verification the ruling names. functions/test/d4.doctypes.test.ts pins the set and checks that every id is a VERIFIED
 * NON_FORUM seed id the checklist rule leaves out.
 */
export const LAW_DEPENDENT_BY_RULING: ReadonlyMap<string, string> = new Map([
  // The limit on bequests.
  ["will_wasiyat", "\"Dispositions within the permitted third or heirs' consent\": a bequest beyond the third, or to an heir, fails without the heirs' consent"],
  // Gifts (hiba).
  ["gift_deed", "\"Registration where compulsory\" and the acceptanceAndDelivery field: a hiba needs declaration, acceptance and delivery of possession, and a written gift of immovable property must be registered"],
  // Instruments of immovable property: registration compulsory by statute (and, for a sale, pre-emption).
  ["sale_deed", "\"Registration where compulsory\": a sale of immovable property passes only by a registered instrument, and a right of pre-emption attaches to the sale"],
  ["sale_agreement", "\"Registration where compulsory\": whether an agreement to sell immovable property must be registered, and what an unregistered one can prove, is a statutory question"],
  ["mortgage_deed", "\"Registration where compulsory\": a mortgage of immovable property, other than by deposit of title deeds, is effected only by a registered instrument"],
  ["lease_agreement_commercial", "\"Registration where compulsory\": a lease from year to year, for more than a year or reserving a yearly rent is made only by a registered instrument"],
  ["lease_agreement_residential", "\"Registration where compulsory\": a lease from year to year, for more than a year or reserving a yearly rent is made only by a registered instrument"],
  ["tenancy_agreement", "\"Registration where compulsory\": a tenancy from year to year or for more than a year is made only by a registered instrument, and the rent law governs the tenancy"],
  ["development_agreement", "\"Registration where compulsory\": an agreement that passes an interest in the land to the developer must be registered"],
  ["release_deed", "\"Registration where compulsory\": an instrument that relinquishes an interest in immovable property must be registered"],
  ["partition_deed", "\"Registration where compulsory\": an instrument of partition that declares shares in immovable property must be registered"],
  // Notices whose period or precondition is fixed by statute.
  ["eviction_notice", "\"Demand and time to comply stated\": the time to quit and the grounds of eviction are fixed by the tenancy and rent laws, a statutory notice period"],
  ["termination_notice", "\"Demand and time to comply stated\": the notice period and procedure for ending a worker's employment are fixed by the standing-orders law"],
  ["defamation_notice", "\"Demand and time to comply stated\": the defamation law requires notice of the intended action within a fixed time of knowledge of the publication"],
  // A responsive pleading before the regulator (its complaint, secp_complaint, is law-dependent by its checklist).
  ["secp_response", "firstGroundRule: the reply opens with preliminary objections on maintainability and limitation, which turn on the statute"],
  // A sworn declaration of who the legal heirs are.
  ["heirship_affidavit", "\"Family tree / list of heirs\": who is a legal heir (a predeceased child's children included) is fixed by the law of succession, not by the deponent"],
  // A covenant in restraint of trade.
  ["non_compete_agreement", "the covenant itself: an agreement in restraint of a lawful profession, trade or business is void except as the law saves it"],
])

/**
 * Whether a document of this type is law-dependent (F06): it is filed in a forum (its `courtIds` do not list
 * NON_FORUM); or its own seed checklist names a legal-verification item (`LEGAL_VERIFICATION_ITEM`, ruling A), as a suit
 * for possession, a statutory application or a legal opinion does even when the seed marks it NON_FORUM; or its id is
 * in `LAW_DEPENDENT_BY_RULING` (the follow-up audit: a will, a gift, an instrument of immovable property, a notice with
 * a statutory period, a declaration of heirs). Approving one needs the type's review checklist with evidence. Every
 * other NON_FORUM type (a contract on the general law, a corporate record, a generic notice, an affidavit of fact) is
 * not law-dependent.
 */
export function isLawDependent(type: DocumentType): boolean {
  return (
    !type.courtIds.includes("NON_FORUM") ||
    type.checklist.some((line) => LEGAL_VERIFICATION_ITEM.test(line)) ||
    LAW_DEPENDENT_BY_RULING.has(type.id)
  )
}

/** The fixed start of the one review item a ruled type adds after its seed items (`reviewChecklistOf`). */
export const RULING_REVIEW_ITEM_PREFIX = "Legal verification (ruling): "

/**
 * The type's review checklist (F06): every distinct item of its seed `checklist`, in the seed's order, and, for a type
 * in `LAW_DEPENDENT_BY_RULING`, then one more item, `Legal verification (ruling): <the ruling's reason>`. Some seed rows
 * repeat an item (`sale_deed` lists "Stamp duty: MANUAL — do not compute" twice); a reviewer answers each item once.
 * The ruling item carries the legal verification that made the type law-dependent into the review the approval
 * requires: a ruled type's seed checklist need not name it (a non-compete's names no rule at all), and evidence on the
 * clerical items alone must not approve one. It is deterministic and on one line, always last, so a stored review
 * keeps the type's order; it is answered and checked exactly as the seed items are (`requireReviewChecklist`). Every
 * other type, forum-filed or law-dependent by its checklist or not law-dependent, has its seed items only.
 */
export function reviewChecklistOf(type: DocumentType): string[] {
  const reason = LAW_DEPENDENT_BY_RULING.get(type.id)
  return [...new Set([...type.checklist, ...(reason === undefined ? [] : [`${RULING_REVIEW_ITEM_PREFIX}${reason}`])])]
}

/**
 * Whether a matter in `courtId` may use the type. True when:
 * - the matter has no court (`courtId` undefined);
 * - the type lists NON_FORUM, as the seed's notices, contracts and affidavits do (R2): it is not filed in a court, so it
 *   suits a matter in any court (including a made-up one), and no court check applies;
 * - the type lists the court exactly;
 * - the type lists a family `<court>_*` (for example `DSJ_KHI_*`) that admits the court itself (`DSJ_KHI`) and any
 *   court under it (`DSJ_KHI_EAST`).
 * Every other entry, including a `*` anywhere else and a `_*` with no court before it, is an exact court id.
 */
export function courtAllowed(type: DocumentType, courtId: string | undefined): boolean {
  if (courtId === undefined) return true
  if (type.courtIds.includes("NON_FORUM")) return true
  return type.courtIds.some((entry) => {
    if (entry === courtId) return true
    if (!entry.endsWith("_*")) return false
    const family = entry.slice(0, -2)
    return family !== "" && (courtId === family || courtId.startsWith(`${family}_`))
  })
}

/** Verified types matching every filter given, sorted by id. `q` is a case-insensitive part of the name. */
export function listDocumentTypes(filter: { category?: string; courtId?: string; q?: string }): DocumentType[] {
  const q = filter.q?.trim().toLowerCase() ?? ""
  return VERIFIED.filter(
    (t) =>
      (filter.category === undefined || t.category === filter.category) &&
      courtAllowed(t, filter.courtId) &&
      (q === "" || t.name.toLowerCase().includes(q))
  )
}
