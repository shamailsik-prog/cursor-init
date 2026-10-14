import { afterEach, describe, expect, it, vi } from "vitest"
import seed from "@/data/documentTypes.json"
import {
  LAW_DEPENDENT_BY_RULING,
  LEGAL_VERIFICATION_ITEM,
  courtAllowed,
  getDocumentType,
  isLawDependent,
  listDocumentTypes,
  reviewChecklistOf,
  type DocumentType,
} from "../src/d4/doctypes"

const rows = seed.types as DocumentType[]
const byId = (id: string) => rows.find((t) => t.id === id)!

const isSorted = (ids: string[]) => ids.every((id, i) => i === 0 || ids[i - 1]! < id)

afterEach(() => {
  vi.doUnmock("@/data/documentTypes.json")
  vi.resetModules()
})

describe("getDocumentType (P4-5: only VERIFIED types are selectable, E-15)", () => {
  it("returns the seed row for a known id", () => {
    expect(getDocumentType("constitutional_petition_199")).toEqual(byId("constitutional_petition_199"))
    expect(getDocumentType("constitutional_petition_199")).toMatchObject({
      name: "Constitutional Petition (Art. 199)",
      category: "constitutional",
      courtIds: ["BHC", "IHC", "LHC", "PHC", "SHC"],
      temporalBindingRule: "impugned_order_date",
      templateId: "template_cp_199_v1",
      status: "VERIFIED",
    })
  })

  it("returns null for an unknown id", () => {
    expect(getDocumentType("no_such_type")).toBeNull()
    expect(getDocumentType("")).toBeNull()
  })

  it("an object-prototype name is not a type", () => {
    expect(getDocumentType("constructor")).toBeNull()
    expect(getDocumentType("__proto__")).toBeNull()
    expect(getDocumentType("toString")).toBeNull()
  })

  it("every seed row is reachable by its id", () => {
    expect(rows).toHaveLength(seed.total)
    for (const row of rows) expect(getDocumentType(row.id)).toEqual(row)
  })

  it("a row is frozen, so a caller cannot change the seed it reads", () => {
    const row = getDocumentType("constitutional_petition_199")!
    expect(Object.isFrozen(row)).toBe(true)
    expect(Object.isFrozen(row.courtIds)).toBe(true)
    expect(Object.isFrozen(row.checklist)).toBe(true)
    expect(Object.isFrozen(row.requiredFields)).toBe(true)
  })

  it("does not return, or list, a row whose status is not VERIFIED", async () => {
    const row = (id: string, status: string): DocumentType => ({ ...byId("constitutional_petition_199"), id, name: `Type ${id}`, status })
    vi.resetModules()
    vi.doMock("@/data/documentTypes.json", () => ({
      default: { types: [row("b_pending", "PENDING"), row("a_verified", "VERIFIED"), row("c_withdrawn", "WITHDRAWN")] },
    }))
    const mod = await import("../src/d4/doctypes")
    expect(mod.getDocumentType("a_verified")?.id).toBe("a_verified")
    expect(mod.getDocumentType("b_pending")).toBeNull()
    expect(mod.getDocumentType("c_withdrawn")).toBeNull()
    expect(mod.listDocumentTypes({}).map((t) => t.id)).toEqual(["a_verified"])
  })
})

describe("courtAllowed (P4-5)", () => {
  const petition = () => byId("constitutional_petition_199")

  it("is true for a court the type lists", () => {
    for (const court of ["BHC", "IHC", "LHC", "PHC", "SHC"]) expect(courtAllowed(petition(), court)).toBe(true)
  })

  it("is false for a court the type does not list", () => {
    expect(courtAllowed(petition(), "SC_PK")).toBe(false)
    expect(courtAllowed(petition(), "DSJ_KHI")).toBe(false)
    expect(courtAllowed(petition(), "shc")).toBe(false)
    expect(courtAllowed(petition(), "")).toBe(false)
  })

  it("is true when there is no court (the matter has none)", () => {
    expect(courtAllowed(petition(), undefined)).toBe(true)
  })

  it("reads a trailing * in the seed as a family of courts, and no other pattern", () => {
    const bail = byId("bail_application_497") // lists "DSJ_KHI_*" beside the high courts
    expect(bail.courtIds).toContain("DSJ_KHI_*")
    expect(courtAllowed(bail, "DSJ_KHI")).toBe(true)
    expect(courtAllowed(bail, "DSJ_KHI_EAST")).toBe(true)
    expect(courtAllowed(bail, "DSJ_KHI_*")).toBe(true)
    expect(courtAllowed(bail, "DSJ_KHIX")).toBe(false)
    expect(courtAllowed(bail, "DSJ_LHR")).toBe(false)
    expect(courtAllowed(bail, "FAMILY_KHI")).toBe(false)
    expect(courtAllowed(bail, "SC_PK")).toBe(false)
  })

  it("a * that is not the last character is literal", () => {
    const odd = { ...petition(), courtIds: ["A*B", "*"] }
    expect(courtAllowed(odd, "A*B")).toBe(true)
    expect(courtAllowed(odd, "AxB")).toBe(false)
    expect(courtAllowed(odd, "SHC")).toBe(false)
  })

  it("a _* entry with an empty family admits nothing", () => {
    const empty = { ...petition(), courtIds: ["_*"] }
    expect(courtAllowed(empty, "_x")).toBe(false)
    expect(courtAllowed(empty, "_")).toBe(false)
    expect(courtAllowed(empty, "")).toBe(false)
    expect(courtAllowed(empty, "SHC")).toBe(false)
    expect(courtAllowed(empty, "_*")).toBe(true) // the entry as an exact court id, like any other
  })

  it("a NON_FORUM type (notice, contract, affidavit) is allowed whatever the matter's court (R2)", () => {
    const nda = byId("nda_mutual") // lists only NON_FORUM
    expect(nda.courtIds).toEqual(["NON_FORUM"])
    for (const court of ["SHC", "SC_PK", "DSJ_KHI", "FAMILY_KHI", "MADE_UP_COURT_9", ""]) expect(courtAllowed(nda, court)).toBe(true)
    expect(courtAllowed(nda, undefined)).toBe(true)
  })

  it("a mixed type that lists NON_FORUM beside a court family is allowed for any court", () => {
    const heirship = byId("heirship_affidavit") // CIVIL_KHI_* and NON_FORUM
    expect(heirship.courtIds).toEqual(["CIVIL_KHI_*", "NON_FORUM"])
    expect(courtAllowed(heirship, "SHC")).toBe(true)
    expect(courtAllowed(heirship, "CIVIL_KHI")).toBe(true)
    expect(courtAllowed(heirship, "MADE_UP_COURT_9")).toBe(true)
  })

  it("NON_FORUM is an entry, not a court: a type without it stays restricted", () => {
    const restricted = { ...petition(), courtIds: ["SHC"] }
    expect(courtAllowed(restricted, "NON_FORUM")).toBe(false)
    expect(courtAllowed({ ...restricted, courtIds: ["SHC", "NON_FORUM"] }, "MADE_UP_COURT_9")).toBe(true)
    expect(courtAllowed({ ...restricted, courtIds: ["non_forum"] }, "MADE_UP_COURT_9")).toBe(false)
  })

  it("a type that lists no court allows none, but still allows a matter with no court", () => {
    const none = { ...petition(), courtIds: [] }
    expect(courtAllowed(none, "SHC")).toBe(false)
    expect(courtAllowed(none, undefined)).toBe(true)
  })
})

describe("listDocumentTypes (P4-5)", () => {
  it("with no filter lists every verified type, sorted by id", () => {
    const list = listDocumentTypes({})
    expect(list).toHaveLength(seed.total)
    expect(isSorted(list.map((t) => t.id))).toBe(true)
  })

  it("filters by category", () => {
    const list = listDocumentTypes({ category: "constitutional" })
    expect(list.length).toBe(rows.filter((t) => t.category === "constitutional").length)
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((t) => t.category === "constitutional")).toBe(true)
    expect(isSorted(list.map((t) => t.id))).toBe(true)
    expect(listDocumentTypes({ category: "no_such_category" })).toEqual([])
  })

  it("filters by courtId with the same rule as courtAllowed (the court listed, or NON_FORUM), sorted", () => {
    const list = listDocumentTypes({ courtId: "SC_PK" })
    const expected = rows.filter((t) => t.courtIds.includes("SC_PK") || t.courtIds.includes("NON_FORUM")).map((t) => t.id)
    expect(list.map((t) => t.id)).toEqual([...expected].sort())
    expect(list.map((t) => t.id)).toContain("condonation_of_delay")
    expect(list.map((t) => t.id)).toContain("nda_mutual") // NON_FORUM
    expect(list.map((t) => t.id)).toContain("heirship_affidavit") // mixed
    expect(list.map((t) => t.id)).not.toContain("constitutional_petition_199")
    expect(listDocumentTypes({ courtId: "SHC" }).map((t) => t.id)).toContain("constitutional_petition_199")
  })

  it("a courtId of a family court matches the family's * entries", () => {
    const ids = listDocumentTypes({ courtId: "FAMILY_KHI" }).map((t) => t.id)
    expect(ids).toContain("divorce_petition")
    expect(ids).not.toContain("constitutional_petition_199")
  })

  it("filters by q on the name, case-insensitively, sorted", () => {
    const lower = listDocumentTypes({ q: "bail" })
    const upper = listDocumentTypes({ q: "BAIL" })
    const mixed = listDocumentTypes({ q: "  BaIl " })
    const expected = rows.filter((t) => t.name.toLowerCase().includes("bail")).map((t) => t.id)
    expect(lower.map((t) => t.id)).toEqual([...expected].sort())
    expect(upper).toEqual(lower)
    expect(mixed).toEqual(lower)
    expect(lower.length).toBeGreaterThan(1)
    expect(lower.map((t) => t.id)).toContain("bail_application_497")
  })

  it("q matches the name only, not the id", () => {
    // The id constitutional_petition_199 holds an underscore the name "Constitutional Petition (Art. 199)" lacks.
    expect(listDocumentTypes({ q: "constitutional_petition" })).toEqual([])
    expect(listDocumentTypes({ q: "constitutional petition" }).map((t) => t.id)).toContain("constitutional_petition_199")
  })

  it("a blank q is no filter", () => {
    expect(listDocumentTypes({ q: "   " })).toHaveLength(seed.total)
    expect(listDocumentTypes({ q: "" })).toHaveLength(seed.total)
  })

  it("combines courtId and q", () => {
    const list = listDocumentTypes({ courtId: "SHC", q: "BAIL" })
    const expected = rows
      .filter((t) => (t.courtIds.includes("SHC") || t.courtIds.includes("NON_FORUM")) && t.name.toLowerCase().includes("bail"))
      .map((t) => t.id)
    expect(list.map((t) => t.id)).toEqual([...expected].sort())
    expect(list.map((t) => t.id)).toContain("bail_application_497")
    // No NON_FORUM type is a bail type, so NAB Bail Application is the only one for the Accountability Court, and the family entry DSJ_KHI_* excludes it.
    expect(listDocumentTypes({ courtId: "NAB_ACC_KHI", q: "bail" }).map((t) => t.id)).toEqual(["nab_bail_application"])
    expect(listDocumentTypes({ courtId: "DSJ_KHI", q: "bail" }).map((t) => t.id)).toEqual(["bail_application_497", "bail_cancellation", "pre_arrest_bail_498"])
  })

  it("combines category with the other filters", () => {
    const list = listDocumentTypes({ courtId: "SHC", q: "bail", category: "criminal" })
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((t) => t.category === "criminal" && (t.courtIds.includes("SHC") || t.courtIds.includes("NON_FORUM")) && /bail/i.test(t.name))).toBe(true)
    expect(listDocumentTypes({ courtId: "SHC", q: "bail", category: "constitutional" })).toEqual([])
  })

  it("matches nothing for a query no name contains", () => {
    expect(listDocumentTypes({ q: "zzzz-no-such-name" })).toEqual([])
  })

  it("returns a new array each time, so a caller cannot reorder the module's own list", () => {
    const first = listDocumentTypes({})
    first.reverse()
    expect(listDocumentTypes({})[0]?.id).toBe([...rows.map((t) => t.id)].sort()[0])
  })

  it("an unsorted seed order is not the output order", () => {
    // The seed is in registry order, not id order, so sorting is the function's work.
    expect(isSorted(rows.map((t) => t.id))).toBe(false)
    expect(isSorted(listDocumentTypes({}).map((t) => t.id))).toBe(true)
  })
})

/**
 * The 19 NON_FORUM types whose own seed checklist names a legal-verification item (F06 re-audit A10, ruling A):
 * originating pleadings, applications in proceedings or under statute, and legal memos.
 */
const LEGALLY_VERIFIED_NON_FORUM = [
  "arguments_brief",
  "cantonment_application",
  "case_compendium",
  "case_strategy_memo",
  "company_incorporation_checklist",
  "compromise_application",
  "contract_review_memo",
  "counter_arguments_brief",
  "demarcation_application",
  "dha_application",
  "due_diligence_report",
  "kda_application",
  "land_regularization_application",
  "legal_opinion",
  "mutation_application",
  "property_injunction_suit",
  "property_suit_possession",
  "record_of_rights_application",
  "secp_complaint",
]

/**
 * The 17 NON_FORUM types law-dependent by ruling (F06 follow-up audit, LAW_DEPENDENT_BY_RULING): their validity turns
 * on a substantive rule that no line of their checklist matches LEGAL_VERIFICATION_ITEM for. The will (the limit on
 * bequests), the gift (hiba), the nine other instruments of immovable property (registration compulsory by statute;
 * with the gift deed, the ten the property-instrument test below derives), the three notices whose period or
 * precondition is statutory, the regulatory reply that opens on limitation, the declaration of legal heirs and the
 * covenant in restraint of trade: 2 + 9 + 3 + 1 + 1 + 1 = 17.
 */
const LAW_DEPENDENT_BY_RULING_IDS = [
  "defamation_notice",
  "development_agreement",
  "eviction_notice",
  "gift_deed",
  "heirship_affidavit",
  "lease_agreement_commercial",
  "lease_agreement_residential",
  "mortgage_deed",
  "non_compete_agreement",
  "partition_deed",
  "release_deed",
  "sale_agreement",
  "sale_deed",
  "secp_response",
  "tenancy_agreement",
  "termination_notice",
  "will_wasiyat",
]

/**
 * The 38 NON_FORUM types the audit left not law-dependent: agreements on the general law of contract, corporate
 * records, generic notices and replies, affidavits of fact, a translation, a retainer letter and a vakalatnama. Their
 * items are clerical or drafting items, or the rule that governs them is the parties' own terms.
 */
const NOT_LAW_DEPENDENT_NON_FORUM = [
  "affidavit",
  "agency_agreement",
  "anti_dumping_notice",
  "arbitration_clause",
  "articles_of_association",
  "board_minutes",
  "cease_desist_notice",
  "client_retainer_letter",
  "consultancy_agreement",
  "demand_notice",
  "directors_resolution",
  "distributor_agreement",
  "employment_agreement",
  "fir_translation",
  "franchise_agreement",
  "indemnity_bond",
  "ip_assignment_agreement",
  "ip_infringement_notice",
  "joint_venture_agreement",
  "legal_notice",
  "mediation_agreement",
  "memorandum_of_association",
  "nda_mutual",
  "nda_unilateral",
  "power_of_attorney_general",
  "power_of_attorney_special",
  "response_to_notice",
  "revenue_sharing_agreement",
  "service_agreement",
  "settlement_deed",
  "share_purchase_agreement",
  "share_subscription_agreement",
  "shareholders_agreement",
  "shareholders_resolution",
  "show_cause_reply",
  "statutory_declaration",
  "undertaking",
  "vakalatnama",
]

const isNonForum = (t: DocumentType) => t.courtIds.includes("NON_FORUM")
const namesLegalVerification = (t: DocumentType) => t.checklist.some((line) => LEGAL_VERIFICATION_ITEM.test(line))

describe("the review checklist of a law-dependent type (F06)", () => {
  it("every type filed in a forum (no NON_FORUM in its courts) is law-dependent", () => {
    const forum = rows.filter((t) => !t.courtIds.includes("NON_FORUM"))
    expect(forum).toHaveLength(85)
    for (const t of forum) expect([t.id, isLawDependent(t)]).toEqual([t.id, true])
    expect(isLawDependent(byId("constitutional_petition_199"))).toBe(true)
    expect(isLawDependent(byId("bail_application_497"))).toBe(true)
  })

  it("among NON_FORUM types, the 19 whose own checklist names a legal-verification item and the 17 of the ruling map are law-dependent, and no other", () => {
    expect(rows.filter(isNonForum)).toHaveLength(74)
    expect(rows.filter((t) => isNonForum(t) && namesLegalVerification(t)).map((t) => t.id).sort()).toEqual(LEGALLY_VERIFIED_NON_FORUM)
    const derived = rows.filter((t) => isNonForum(t) && isLawDependent(t)).map((t) => t.id)
    expect(derived.sort()).toEqual([...LEGALLY_VERIFIED_NON_FORUM, ...LAW_DEPENDENT_BY_RULING_IDS].sort())
    expect(rows.filter((t) => isNonForum(t) && !isLawDependent(t)).map((t) => t.id).sort()).toEqual(NOT_LAW_DEPENDENT_NON_FORUM)
    // heirship_affidavit lists NON_FORUM beside a court family. No item of its checklist is a legal-verification item,
    // but its list of heirs is fixed by the law of succession: law-dependent by ruling.
    expect(byId("heirship_affidavit").courtIds).toEqual(["CIVIL_KHI_*", "NON_FORUM"])
    expect(byId("heirship_affidavit").checklist.filter((c) => LEGAL_VERIFICATION_ITEM.test(c))).toEqual([])
    expect(isLawDependent(byId("heirship_affidavit"))).toBe(true)
    expect(isLawDependent(byId("service_agreement"))).toBe(false)
    // Over the whole seed: 85 forum types, 19 legally verified NON_FORUM types and 17 by ruling.
    expect(rows.filter((t) => isLawDependent(t))).toHaveLength(121)
  })

  it("the ruling map names exactly the audited ids, each a VERIFIED NON_FORUM seed id the forum and checklist rules leave out, with its reason", () => {
    expect([...LAW_DEPENDENT_BY_RULING.keys()].sort()).toEqual(LAW_DEPENDENT_BY_RULING_IDS)
    for (const [id, reason] of LAW_DEPENDENT_BY_RULING) {
      // A VERIFIED seed id (getDocumentType returns only those), so a renamed or withdrawn seed row fails here.
      const type = getDocumentType(id)
      expect([id, type?.id]).toEqual([id, id])
      // NON_FORUM, and not already law-dependent by the checklist rule: the map adds only what the other rules miss.
      expect([id, isNonForum(type!), namesLegalVerification(type!)]).toEqual([id, true, false])
      // A one-line reason naming the item or the rule.
      expect([id, typeof reason, reason.trim().length > 20, reason.includes("\n")]).toEqual([id, "string", true, false])
    }
  })

  it("a will is law-dependent by ruling: its permitted-third item is a condition of validity that no legal-verification line matches", () => {
    const will = byId("will_wasiyat")
    expect(will.courtIds).toEqual(["NON_FORUM"])
    expect(will.checklist).toContain("Dispositions within the permitted third or heirs' consent")
    expect(will.checklist.filter((c) => LEGAL_VERIFICATION_ITEM.test(c))).toEqual([])
    expect(isLawDependent(will)).toBe(true)
    expect(LAW_DEPENDENT_BY_RULING.get("will_wasiyat")).toContain("Dispositions within the permitted third or heirs' consent")
  })

  it("every NON_FORUM instrument of immovable property (an exact land description in its checklist) is law-dependent by ruling", () => {
    const property = rows.filter((t) => isNonForum(t) && t.posture === "instrument" && t.checklist.includes("Exact land description from source documents"))
    expect(property.map((t) => t.id).sort()).toEqual([
      "development_agreement",
      "gift_deed",
      "lease_agreement_commercial",
      "lease_agreement_residential",
      "mortgage_deed",
      "partition_deed",
      "release_deed",
      "sale_agreement",
      "sale_deed",
      "tenancy_agreement",
    ])
    for (const t of property) expect([t.id, LAW_DEPENDENT_BY_RULING.has(t.id), isLawDependent(t)]).toEqual([t.id, true, true])
  })

  it("the ruling is read by the type's id: a copy of a ruled row is law-dependent, the same row under another id is not", () => {
    expect(isLawDependent({ ...byId("will_wasiyat") })).toBe(true)
    expect(isLawDependent({ ...byId("will_wasiyat"), id: "will_not_ruled" })).toBe(false)
    expect(isLawDependent({ ...byId("sale_deed"), id: "constructor" })).toBe(false)
  })

  it("the legal-verification item test matches the seed's verification lines and nothing that only names a party, a fee or a form", () => {
    for (const line of [
      "Citations passed Gate 33",
      "Statutory text pleaded as at relevant date (L17.1)",
      "Limitation checked (Module 44)",
      "Provision invoked",
      "Provision invoked and correct forum",
      "Jurisdiction and valuation pleaded (civil)",
      "Sources cited and verified (Gate 33 where authorities are relied on)",
      "limitation / laches addressed",
    ]) {
      expect([line, LEGAL_VERIFICATION_ITEM.test(line)]).toEqual([line, true])
    }
    for (const line of [
      "Parties and identifiers verified (L17.2)",
      "Fact / analysis / hypothesis kept apart (L17.4)",
      "Certification required or not",
      "Recitals and operative clauses",
      "Court fee: MANUAL — do not compute",
      "Stamp duty: MANUAL — do not compute",
      "Cause of action / offence date pleaded",
      "See L17.11",
    ]) {
      expect([line, LEGAL_VERIFICATION_ITEM.test(line)]).toEqual([line, false])
    }
  })

  it("lists every distinct seed item once, in the seed's order", () => {
    const petition = byId("constitutional_petition_199")
    expect(reviewChecklistOf(petition)).toEqual([...petition.checklist])
    const deed = byId("sale_deed")
    expect(deed.checklist.filter((c) => c === "Stamp duty: MANUAL — do not compute")).toHaveLength(2)
    expect(reviewChecklistOf(deed)).toEqual([...new Set(deed.checklist)])
    expect(reviewChecklistOf(deed)).toHaveLength(deed.checklist.length - 1)
  })

  it("every verified type has at least one review item, so a law-dependent approval always has something to answer", () => {
    for (const t of rows.filter((r) => r.status === "VERIFIED")) expect(reviewChecklistOf(t).length).toBeGreaterThan(0)
  })
})
