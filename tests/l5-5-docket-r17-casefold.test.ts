import { afterEach, describe, expect, it } from "vitest"
import { DOCKET_GENERATOR_FLAG_ENV } from "@/layers/L5_5_DocketGenerator/flag"
import { generateDocket } from "@/layers/L5_5_DocketGenerator/service"
import { citationExclusionMatches, PROVED_INDEX_HEADINGS, unfiledLabelFindings } from "@/layers/L5_5_DocketGenerator/unfiled"
import type { DocketFilingSet } from "@/layers/L5_5_DocketGenerator/types"
import petitionFixture from "@/layers/L5_5_DocketGenerator/fixtures/petition-odd.json"
import exhibitFixture from "@/layers/L5_5_DocketGenerator/fixtures/exhibits-forum.json"

const petition = petitionFixture as DocketFilingSet
const exhibits = exhibitFixture as DocketFilingSet
const cited = "The petitioner relies on Annexures A, B and C."
const proved = "The witness proved P-1, P-2 and then P-3."

function enableFlag(): void {
  process.env[DOCKET_GENERATOR_FLAG_ENV] = "true"
}

afterEach(() => {
  delete process.env[DOCKET_GENERATOR_FLAG_ENV]
})

function withThirdExhibit(): DocketFilingSet {
  const third = exhibits.annexures[1]!
  return {
    ...exhibits,
    annexures: [
      ...exhibits.annexures,
      { ...third, assignedLabel: "P-3", metadata: { ...third.metadata, artifactId: "ex-3", label: "Map", sourceRef: "doc-map" } },
    ],
  }
}

async function resultFor(filing: DocketFilingSet, body: string) {
  enableFlag()
  return generateDocket({ ...filing, draft: { body } })
}

async function expectUnfiled(filing: DocketFilingSet, body: string, detail: string) {
  const result = await resultFor(filing, body)
  expect(result.ok, body).toBe(false)
  expect(result.pdf, body).toBeNull()
  expect(result.docx, body).toBeNull()
  expect(
    result.queue.some((entry) => entry.code === "unfiled_label" && entry.detail === detail),
    JSON.stringify(result.queue),
  ).toBe(true)
}

describe("L5.5 R17 case-folded labels", () => {
  const lower: Array<{ body: string; detail: string; filing?: "marks" }> = [
    { body: `${cited} relies on d.`, detail: 'unfiled label "D"' },
    { body: `${cited} See d.`, detail: 'unfiled label "D"' },
    { body: `${cited} list of annexures: a, b, c, d.`, detail: 'unfiled label "D"' },
    {
      body: `${cited}\nlist of annexures\n1. a - plaint\n2. b - notice\n3. c - vakalatnama\n4. d - receipt`,
      detail: 'unfiled label "D"',
    },
    { body: `${proved} exh. p9`, detail: 'unfiled label "p9"', filing: "marks" },
    { body: `${proved} deed/p/9`, detail: 'unfiled label "deed/p/9"', filing: "marks" },
    { body: `${proved} relies on Exh. 9.`, detail: 'unfiled label "9"', filing: "marks" },
    { body: `${proved} Exh. No. 9.`, detail: 'unfiled label "9"', filing: "marks" },
    { body: `${cited} Annexure C.P. No. D-9 of 2024.`, detail: 'unfiled label "D-9"' },
  ]

  it.each(lower)("refuses $detail in: $body", async ({ body, detail, filing }) => {
    await expectUnfiled(filing === "marks" ? withThirdExhibit() : petition, body, detail)
  })

  it("refuses a lower-case letter under every proved index heading", async () => {
    for (const heading of PROVED_INDEX_HEADINGS) {
      const body = `${cited}\n${heading}\nd - receipt`
      await expectUnfiled(petition, body, 'unfiled label "D"')
    }
  })

  const bareP = [`${proved} P.`, `${proved} Exh. P:9`, `${proved} P#9`, `${proved} P-IX`]

  it.each(bareP)("refuses a bare P that a mark's first letter must not authorise: %s", async (body) => {
    await expectUnfiled(withThirdExhibit(), body, 'unfiled label "P"')
  })

  it("folds a fullwidth letter before comparing it to the filing set", () => {
    const findings = unfiledLabelFindings("The annexures are \uFF24.", ["A", "B", "C"])
    expect(findings.some((entry) => entry.code === "unfiled_label" && entry.detail === 'unfiled label "D"')).toBe(true)
  })

  it("folds a unicode dash so a filed mark still matches", () => {
    expect(unfiledLabelFindings("The plan is P\u20139.", ["P-9"])).toEqual([])
  })

  it("keeps Cr.P.C. and F.I.R. outside the exclusion list", async () => {
    await expectUnfiled(petition, `${cited} See Cr.P.C. and the F.I.R.`, 'unfiled label "P"')
  })

  it("pins each citation exclusion and keeps a label word in front of C.P.", () => {
    expect(citationExclusionMatches("C.P. No. D-1234 of 2023").cp).toBe(true)
    expect(citationExclusionMatches("CP No. D-1234 of 2023").cp).toBe(true)
    expect(citationExclusionMatches("Annexure C.P. No. D-9 of 2024").cp).toBe(false)
    expect(citationExclusionMatches("Suit No. 12 of 2020").suit).toBe(true)
    expect(citationExclusionMatches("Suit No. D-12 of 2020").suit).toBe(false)
    expect(citationExclusionMatches("u/s 80 CPC").section).toBe(true)
    expect(citationExclusionMatches("u/s 302 PPC").section).toBe(true)
    expect(citationExclusionMatches("u/s 80 CrPC").section).toBe(false)
    expect(citationExclusionMatches("Ex parte").exParte).toBe(true)
    expect(citationExclusionMatches("ex parte").exParte).toBe(true)
    expect(citationExclusionMatches("Exh. 9").exParte).toBe(false)
  })
})
