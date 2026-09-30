// Review round 1, finding 1 (Critical): the citation gate failed open on formats the extractor
// did not recognise, and some inputs resolved to a different authority. Every string from the
// review (scratchpad/review-secgaps.md; probes secrev/extract|gate.probe.test.ts) is pinned here.
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { newStore } from "@/platform/spine/store"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"
import { extractCitations, normaliseCitation } from "@/services/d4-2/citations"
import { seedJudgment, seedTreatment, verifyCitations } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

const U = (raw: string) => `UNRECOGNISED: ${raw}`

// input => exactly what the gate receives
const MATRIX: Array<[string, string[]]> = [
  ["PLD 2019 SC 123", ["PLD 2019 SC 123"]],
  ["PLD 2019 Supreme Court 123", ["PLD 2019 SC 123"]],
  ["P.L.D. 2019 S.C. 123", ["PLD 2019 SC 123"]],
  ["PLD 2019 S.C. 123", ["PLD 2019 SC 123"]],
  ["P L D 2019 SC 123", ["PLD 2019 SC 123"]],
  ["pld 2019 sc 123", ["PLD 2019 SC 123"]],
  ["PLD  2019   SC   123", ["PLD 2019 SC 123"]],
  ["PLD\n2019\nSC\n123", ["PLD 2019 SC 123"]],
  ["PLD 2019 SC\n123", ["PLD 2019 SC 123"]],
  ["2020 SCMR 456", ["2020 SCMR 456"]],
  ["2020 S.C.M.R. 456", ["2020 SCMR 456"]],
  ["2020 S C M R 456", ["2020 SCMR 456"]],
  ["2020 scmr 456", ["2020 SCMR 456"]],
  ["(2020) SCMR 456", ["2020 SCMR 456"]],
  ["2020SCMR456", [U("2020SCMR456")]],
  ["2018 CLC 789 (Lahore)", ["2018 CLC 789"]],
  ["2018 CLC (Lahore) 789", ["2018 CLC 789"]],
  ["2018 C.L.C. 789", ["2018 CLC 789"]],
  ["PLJ 2015 SC 100", ["PLJ 2015 SC 100"]],
  ["2015 PLJ 100", ["2015 PLJ 100"]],
  ["2015 PLJ SC 100", ["PLJ 2015 SC 100"]],
  ["2016 YLR 222", ["2016 YLR 222"]],
  ["2016 Y.L.R. 222", ["2016 YLR 222"]],
  ["2017 MLD 333", ["2017 MLD 333"]],
  ["2017 M.L.D. 333", ["2017 MLD 333"]],
  ["2019 PCrLJ 44", ["2019 PCrLJ 44"]],
  ["2019 P.Cr.L.J. 44", ["2019 PCrLJ 44"]],
  ["2019 P Cr. L J 44", ["2019 PCrLJ 44"]],
  ["2019 CLD 55", ["2019 CLD 55"]],
  ["2019 PTD 66", ["2019 PTD 66"]],
  ["2019 PLC 77", ["2019 PLC 77"]],
  ["2019 PLC (C.S.) 77", ["2019 PLC(CS) 77"]],
  ["2019 PLC 77 (C.S.)", ["2019 PLC(CS) 77"]],
  ["NLR 2001 Civil 12", ["NLR 2001 Civil 12"]],
  ["2001 NLR 12", ["2001 NLR 12"]],
  ["KLR 2001 SC 1", ["KLR 2001 SC 1"]],
  ["2001 KLR 1", ["2001 KLR 1"]],
  ["2020 SCR 100", ["2020 SCR 100"]],
  ["PLD 2019 Lah. 123", ["PLD 2019 Lahore 123"]],
  ["PLD 2019 Lahore 123", ["PLD 2019 Lahore 123"]],
  ["PLD 2019 Kar 1", ["PLD 2019 Sindh 1"]],
  ["PLD 2019 Sindh 1", ["PLD 2019 Sindh 1"]],
  ["PLD 2019 Pesh. 1", ["PLD 2019 Peshawar 1"]],
  ["PLD 2019 Quetta 2", ["PLD 2019 Quetta 2"]],
  ["PLD 2019 Bal. 1", ["PLD 2019 Quetta 1"]],
  ["PLD 2019 Isl. 3", ["PLD 2019 Islamabad 3"]],
  ["PLD 2019 Islamabad 3", ["PLD 2019 Islamabad 3"]],
  ["PLD 2019 FSC 1", ["PLD 2019 FSC 1"]],
  ["PLD 2019 SC (AJ&K) 1", ["PLD 2019 SC(AJ&K) 1"]],
  ["C.P. No. 1234 of 2019", [U("C.P. No. 1234 of 2019")]],
  ["Civil Petition No. 1234 of 2019", [U("Civil Petition No. 1234 of 2019")]],
  ["Crl. A. No. 12 of 2020", [U("Crl. A. No. 12 of 2020")]],
  ["W.P. No. 1/2021", [U("W.P. No. 1/2021")]],
  ["2019 SCMR 1​234", ["2019 SCMR 1234"]],
  ["2019 SCM​R 1234", ["2019 SCMR 1234"]],
  ["2019 SСMR 1234", [U("2019 SСMR 1234")]],
  ["PLD 2019 ЅC 123", [U("2019 ЅC 123")]],
  ["２０１９ SCMR 1234", ["2019 SCMR 1234"]],
  ["2019 SCMR 1234-A", [U("2019 SCMR 1234")]],
  ["2019 SCMR-1234", ["2019 SCMR 1234"]],
  ["2019 SCMR p.1234", [U("2019 SCMR p.1234")]],
  ["2019 SCMR at 1234", [U("2019 SCMR at 1234")]],
  ["PLD 2019 SC 12 3", [U("2019 SC 12")]],
  ["PLD 2019 SC [123]", [U("2019 SC [123")]],
  ["PLD 2019 SC-123", ["PLD 2019 SC 123"]],
  ["[2019] SCMR 1234", ["2019 SCMR 1234"]],
  ["2019 SCMR (1234)", [U("2019 SCMR (1234")]],
  ["2019 SCMR 1234 (supra)", ["2019 SCMR 1234"]],
]

describe("extractor format matrix (every string in the review)", () => {
  it.each(MATRIX)("%j", (input, expected) => {
    expect(extractCitations(input)).toEqual(expected)
  })
})

describe("no string resolves to a different authority", () => {
  it("zero-width space inside the page reads as the visible page (1234), never page 1", () => {
    const store = newStore()
    seedJudgment(store, "j-one", "Page one", "full", "2019 SCMR 1")
    seedJudgment(store, "j-old", "Overruled", "single", "2019 SCMR 1234")
    seedJudgment(store, "j-new", "Larger", "larger", "2021 SCMR 1")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")
    const res = verifyCitations(store, extractCitations("see 2019 SCMR 1​234"))
    expect(res.status).toBe("OVERRULED")
    expect(res.findings.map((f) => f.judgmentId)).toEqual(["j-old"])
  })

  it("PLC (C.S.) is its own series: never collapses onto PLC (Labour) of the same page", () => {
    const store = newStore()
    seedJudgment(store, "j-lab", "Labour", "full", "2019 PLC 77")
    const res = verifyCitations(store, extractCitations("see 2019 PLC (C.S.) 77"))
    expect(res.status).toBe("UNVERIFIED")
    expect(res.findings[0]?.judgmentId).toBeNull()
    seedJudgment(store, "j-cs", "Civil service", "full", "2019 PLC (C.S.) 77")
    expect(verifyCitations(store, extractCitations("see 2019 PLC 77 (C.S.)")).findings[0]?.judgmentId).toBe("j-cs")
  })

  it("every suspect is UNVERIFIED even when a lookalike authority is known and verified", () => {
    const store = newStore()
    for (const [id, cite] of [
      ["a", "2019 SCMR 1234"],
      ["b", "2019 SCMR 12"],
      ["c", "PLD 2019 SC 12"],
      ["d", "PLD 2019 SC 123"],
      ["e", "2020 SCMR 456"],
    ] as const) {
      seedJudgment(store, id, id, "full", cite)
    }
    for (const [input, expected] of MATRIX) {
      if (!expected.every((ref) => ref.startsWith("UNRECOGNISED: "))) continue
      const res = verifyCitations(store, extractCitations(input))
      expect(res.status, input).toBe("UNVERIFIED")
      expect(res.findings.every((f) => f.judgmentId === null), input).toBe(true)
    }
  })

  it("normaliseCitation accepts exactly one citation and nothing else", () => {
    expect(normaliseCitation("2019 SCMR 1234")).toBe("2019 SCMR 1234")
    expect(normaliseCitation("  2019 S.C.M.R. 1234. ")).toBe("2019 SCMR 1234")
    expect(normaliseCitation("2019 SCMR 1234 and 2020 SCMR 1")).toBeNull()
    expect(normaliseCitation("2019 SCMR 1234 extra")).toBeNull()
    expect(normaliseCitation("2019 SСMR 1234")).toBeNull()
    expect(normaliseCitation("PLD 2019 SC 12 3")).toBeNull()
  })

  it("PLD Karachi and PLD Sindh are one court (data/courts.json SHC)", () => {
    expect(normaliseCitation("PLD 2019 Karachi 7")).toBe(normaliseCitation("PLD 2019 Sindh 7"))
    expect(normaliseCitation("PLD 2019 Kar. 7")).toBe("PLD 2019 Sindh 7")
  })
})

describe("gate evasion through /api/d4/drafts is closed", () => {
  afterEach(() => resetRuntimeStoreForTests())
  let n = 0
  const key = () => `c1c1c1c1-0000-4000-8000-${String(++n).padStart(12, "0")}`
  function setup() {
    const store = getRuntimeStore()
    const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
    for (const u of ["partner_a", "associate_a"]) addMember(store, m.id, u, "firmA")
    seedJudgment(store, "j-old", "Old", "single", "2019 SCMR 1234")
    seedJudgment(store, "j-new", "New", "larger", "2021 SCMR 1")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")
    return { store, matterId: m.id }
  }
  const compose = (matterId: string, body: string) =>
    DRAFTS(
      new Request("http://127.0.0.1/api/d4/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
        body: JSON.stringify({
          action: "compose", actorId: "associate_a", matterId, templateId: getDocumentTypes()[0]!.id,
          title: "x", body, classification: "internal", citedJudgmentIds: [], temporalCitations: [],
        }),
      })
    )

  it.each([
    "Relying on 2019 SCMR 1234.",
    "Relying on 2019 S.C.M.R. 1234.",
    "Relying on 2019 SCM​R 1234.",
    "Relying on 2019 SСMR 1234.",
    "Relying on (2019) SCMR 1234.",
    "Relying on 2019 SCMR-1234.",
    "Relying on PLJ 2019 SC 1234 and C.P. No. 12 of 2019 (unreported).",
    "Relying on PLD 2019 S.C. 123 and PLD 2019 Isl. 3.",
    "Relying on PLD 2019 Bal. 1 and PLD 2019 SC (AJ&K) 1.",
    "Relying on NLR 2001 Civil 12 and 2020 SCR 100.",
  ])("%j is blocked (422)", async (body) => {
    const { matterId } = setup()
    const res = await compose(matterId, body)
    expect(res.status).toBe(422)
  })

  it("the matter's own case number in the body is not an authority", async () => {
    const { store, matterId } = setup()
    const recorded = recordCaseNumber(store, matterId, "C.P. No. D-1234 of 2025", "SHC")
    expect(recorded.status).not.toBe("REJECT")
    const own = await compose(matterId, "In C.P. No. D-1234 of 2025 the petitioner submits as follows.")
    expect(own.status).toBe(200)
    const other = await compose(matterId, "As held in C.P. No. D-99 of 2020 (unreported).")
    expect(other.status).toBe(422)
  })
})
