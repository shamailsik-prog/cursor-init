import { describe, expect, it } from "vitest"
import { newStore } from "@/platform/spine/store"
import { seedUser } from "@/platform/p5/checkPermission"
import {
  extractCitations,
  normaliseCitation,
} from "@/services/d4-2/citations"
import {
  seedJudgment,
  seedTreatment,
  verifyCitations,
} from "@/services/d4-2/draftingIntelligence"

describe("Module 33 extractCitations (Pakistani reporters)", () => {
  it("extracts and normalises every reporter format used by the corpus extractor", () => {
    const body = [
      "As held in pld 2023  sc 123 and PLD 2020 Lahore 1,",
      "see also 2019 SCMR 1234, 2021 CLC (Lahore) 45, 2018 YLR 77,",
      "2017 MLD 890, 2016 P Cr. L J 12, 2015 PCrLJ (Karachi) 3,",
      "2014 PTD 5, 2013 PTCL 6, 2012 CLD 7, 2011 PLC 8, 2010 KLR 9 and 2009 GBLR 10.",
    ].join(" ")
    expect(extractCitations(body)).toEqual([
      "PLD 2023 SC 123",
      "PLD 2020 Lahore 1",
      "2019 SCMR 1234",
      "2021 CLC 45",
      "2018 YLR 77",
      "2017 MLD 890",
      "2016 PCrLJ 12",
      "2015 PCrLJ 3",
      "2014 PTD 5",
      "2013 PTCL 6",
      "2012 CLD 7",
      "2011 PLC 8",
      "2010 KLR 9",
      "2009 GBLR 10",
    ])
  })

  it("deduplicates; an unreported case reference is a suspect, not silently ignored (review round 1)", () => {
    expect(
      extractCitations("2019 SCMR 1234 ... 2019  scmr 1234. Suit No. 812 of 2025; section 302 PPC")
    ).toEqual(["2019 SCMR 1234", "UNRECOGNISED: Suit No. 812 of 2025"])
    expect(extractCitations("The petitioner filed 3 applications in 2019.")).toEqual([])
    expect(extractCitations("")).toEqual([])
  })

  it("normalises court aliases for PLD", () => {
    expect(normaliseCitation("PLD 2020 Supreme Court 10")).toBe("PLD 2020 SC 10")
    expect(normaliseCitation("PLD 2020 Lah. 10")).toBe("PLD 2020 Lahore 10")
    expect(normaliseCitation("not a citation")).toBeNull()
  })
})

describe("Module 33 gate states (E-22: approval blocked on any non-VERIFIED result)", () => {
  function storeWithAuthorities() {
    const store = newStore()
    seedUser(store, { id: "partner1", firmId: "firmA", role: "partner", clearanceLevel: "privileged-restricted" })
    seedUser(store, { id: "associate1", firmId: "firmA", role: "associate", clearanceLevel: "privileged" })
    seedJudgment(store, "j-good", "Good law", "division", "2019 SCMR 1234")
    seedJudgment(store, "j-old", "Old authority", "single", "PLD 2010 Lahore 5")
    seedJudgment(store, "j-new", "Larger bench", "larger", "PLD 2020 SC 1")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")
    return store
  }

  it("VERIFIED for a known, current authority (by id or by citation)", () => {
    const store = storeWithAuthorities()
    const result = verifyCitations(store, ["j-good", "2019 scmr 1234"])
    expect(result.status).toBe("OK")
    expect(result.findings).toEqual([
      { ref: "j-good", judgmentId: "j-good", status: "VERIFIED" },
    ])
  })

  it("OVERRULED for an authority overruled by a larger bench, found in the draft body", () => {
    const store = storeWithAuthorities()
    const result = verifyCitations(store, extractCitations("relying on PLD 2010 Lah. 5"))
    expect(result.status).toBe("OVERRULED")
    expect(result.findings[0]).toMatchObject({ judgmentId: "j-old", status: "OVERRULED" })
  })

  it("UNVERIFIED (blocked) for an authority not in the authority store", () => {
    const store = storeWithAuthorities()
    const result = verifyCitations(store, ["2001 YLR 999"])
    expect(result.status).toBe("UNVERIFIED")
    expect(result).toMatchObject({ blocked: true })
    expect(result.findings[0]).toMatchObject({ ref: "2001 YLR 999", judgmentId: null, status: "UNVERIFIED" })
  })

  it("UNVERIFIED when an overruling treatment is recorded but bench precedence cannot be established", () => {
    const store = storeWithAuthorities()
    seedJudgment(store, "j-peer", "Coordinate bench", "division")
    seedJudgment(store, "j-peer2", "Coordinate bench 2", "division")
    seedTreatment(store, "j-peer2", "j-peer", "overruled", "division")
    expect(verifyCitations(store, ["j-peer"]).status).toBe("UNVERIFIED")
  })

  it("OVERRULED outranks UNVERIFIED; only the calling partner with a reason clears either", () => {
    const store = storeWithAuthorities()
    const refs = ["j-old", "2001 YLR 999"]
    expect(verifyCitations(store, refs).status).toBe("OVERRULED")
    expect(
      verifyCitations(store, refs, { partnerId: "partner1", reason: "x" }, { actorId: "associate1", firmId: "firmA" })
        .status
    ).toBe("OVERRULED")
    const unverifiedOnly = verifyCitations(
      store,
      ["2001 YLR 999"],
      { partnerId: "associate1", reason: "x" },
      { actorId: "associate1", firmId: "firmA" }
    )
    expect(unverifiedOnly.status).toBe("UNVERIFIED")
    const cleared = verifyCitations(
      store,
      refs,
      { partnerId: "partner1", reason: "Distinguished; reported copy checked" },
      { actorId: "partner1", firmId: "firmA" }
    )
    expect(cleared.status).toBe("OK")
    expect(cleared.overridden).toBe(true)
    expect(cleared.findings.map((f) => f.status)).toEqual(["OVERRULED", "UNVERIFIED"])
  })
})
