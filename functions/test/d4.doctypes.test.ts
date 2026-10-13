import { afterEach, describe, expect, it, vi } from "vitest"
import seed from "@/data/documentTypes.json"
import { courtAllowed, getDocumentType, isLawDependent, listDocumentTypes, reviewChecklistOf, type DocumentType } from "../src/d4/doctypes"

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

describe("the review checklist of a law-dependent type (F06)", () => {
  it("a type filed in a forum is law-dependent; a NON_FORUM type is not, even one that also lists a court", () => {
    expect(isLawDependent(byId("constitutional_petition_199"))).toBe(true)
    expect(isLawDependent(byId("bail_application_497"))).toBe(true)
    expect(isLawDependent(byId("sale_deed"))).toBe(false)
    expect(isLawDependent(byId("heirship_affidavit"))).toBe(false)
    expect(byId("heirship_affidavit").courtIds.length).toBeGreaterThan(1)
    // Over the whole seed: law-dependent exactly when NON_FORUM is absent (74 NON_FORUM types, README).
    expect(rows.filter((t) => !isLawDependent(t))).toHaveLength(74)
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
