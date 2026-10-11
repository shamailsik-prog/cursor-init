import { describe, expect, it } from "vitest"
import {
  benchRank,
  verdictFromTreatments,
  type Bench,
  type TreatmentFact,
} from "@/services/d4-2/citationVerdict"
import { newStore } from "@/platform/spine/store"
import {
  seedJudgment,
  seedTreatment,
  verifyCitations,
} from "@/services/d4-2/draftingIntelligence"

const fact = (
  kind: string,
  treatingJudgmentBench: Bench | null,
  recordedTreatingBench: Bench
): TreatmentFact => ({ kind, treatingJudgmentBench, recordedTreatingBench })

describe("benchRank", () => {
  it("orders single < division < full < larger as 1 to 4", () => {
    expect(benchRank("single")).toBe(1)
    expect(benchRank("division")).toBe(2)
    expect(benchRank("full")).toBe(3)
    expect(benchRank("larger")).toBe(4)
  })
})

describe("verdictFromTreatments (P4-2: one rule in one place)", () => {
  it("no treatments gives VERIFIED", () => {
    expect(verdictFromTreatments("division", [])).toBe("VERIFIED")
  })

  it("a followed treatment gives VERIFIED", () => {
    expect(verdictFromTreatments("division", [fact("followed", "full", "full")])).toBe("VERIFIED")
  })

  it("only an overruled kind counts: applied and followed beside each other stay VERIFIED", () => {
    expect(
      verdictFromTreatments("single", [fact("applied", "larger", "larger"), fact("followed", "full", "larger")])
    ).toBe("VERIFIED")
  })

  it("overruled by a bench that outranks the treated one gives OVERRULED", () => {
    expect(verdictFromTreatments("division", [fact("overruled", "full", "full")])).toBe("OVERRULED")
    expect(verdictFromTreatments("single", [fact("overruled", "division", "division")])).toBe("OVERRULED")
  })

  it("overruled with a recorded larger bench gives OVERRULED, whatever the treating judgment is", () => {
    expect(verdictFromTreatments("division", [fact("overruled", null, "larger")])).toBe("OVERRULED")
    expect(verdictFromTreatments("full", [fact("overruled", "single", "larger")])).toBe("OVERRULED")
  })

  it("overruled by an equal bench with no larger record gives UNVERIFIED", () => {
    expect(verdictFromTreatments("division", [fact("overruled", "division", "division")])).toBe("UNVERIFIED")
  })

  it("overruled by a lower bench gives UNVERIFIED", () => {
    expect(verdictFromTreatments("full", [fact("overruled", "single", "single")])).toBe("UNVERIFIED")
  })

  it("an unknown treating judgment recorded as division against a full bench gives UNVERIFIED", () => {
    expect(verdictFromTreatments("full", [fact("overruled", null, "division")])).toBe("UNVERIFIED")
  })

  it("the judgment's own bench wins over a lower recorded bench", () => {
    expect(verdictFromTreatments("division", [fact("overruled", "full", "single")])).toBe("OVERRULED")
  })

  it("one qualifying overruling among several that do not qualify gives OVERRULED", () => {
    expect(
      verdictFromTreatments("division", [
        fact("overruled", "division", "division"),
        fact("followed", "full", "full"),
        fact("overruled", "full", "full"),
      ])
    ).toBe("OVERRULED")
  })
})

describe("draftingIntelligence delegates to the same rule", () => {
  it("verifyCitations returns what verdictFromTreatments returns for the same facts (2099 fixtures)", () => {
    const store = newStore()
    seedJudgment(store, "j_div", "Test v Test", "division", "PLD 2099 SC 101")
    seedJudgment(store, "j_full", "Test v Test", "full", "PLD 2099 SC 102")
    seedJudgment(store, "j_eq", "Test v Test", "division", "PLD 2099 SC 103")
    seedJudgment(store, "j_unk", "Test v Test", "full", "PLD 2099 SC 104")
    seedJudgment(store, "t_full", "Test v Test", "full", "PLD 2099 SC 201")
    seedJudgment(store, "t_div", "Test v Test", "division", "PLD 2099 SC 202")
    seedTreatment(store, "t_full", "j_div", "overruled", "full")
    seedTreatment(store, "t_div", "j_eq", "overruled", "division")
    // The treating judgment "ghost" is not in the store: only the recorded bench is known.
    seedTreatment(store, "ghost", "j_unk", "overruled", "division")
    seedTreatment(store, "t_full", "j_full", "followed", "full")

    const verdict = (ref: string) => verifyCitations(store, [ref]).findings[0]?.status
    expect(verdict("PLD 2099 SC 101")).toBe(verdictFromTreatments("division", [fact("overruled", "full", "full")]))
    expect(verdict("PLD 2099 SC 101")).toBe("OVERRULED")
    expect(verdict("PLD 2099 SC 102")).toBe("VERIFIED")
    expect(verdict("PLD 2099 SC 103")).toBe("UNVERIFIED")
    expect(verdict("PLD 2099 SC 104")).toBe("UNVERIFIED")
  })
})
