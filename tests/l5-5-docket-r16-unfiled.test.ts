import { afterEach, describe, expect, it } from "vitest"
import { DOCKET_GENERATOR_FLAG_ENV } from "@/layers/L5_5_DocketGenerator/flag"
import { generateDocket } from "@/layers/L5_5_DocketGenerator/service"
import { isProvedIndexHeading, PROVED_INDEX_HEADINGS } from "@/layers/L5_5_DocketGenerator/unfiled"
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

describe("L5.5 R16 fail-closed labels", () => {
  const unfiled = [
    `${cited} The annexures are D and E.`,
    `${cited} Annexures A-d are filed.`,
    `${cited} Annexures A to D are filed.`,
    `${cited} A.D. 2020.`,
    `${cited} Annexures A, B, C\n\nand D are filed.`,
    `LIST OF ANNEXURES\n1. A - Plaint\n4. D - Receipt\n\n${cited}`,
    `LIST OF ANNEXURES\n- D - Receipt\n\n${cited}`,
    `LIST OF ANNEXURES\nD - Notice dated 02.02.2024\n\n${cited}`,
    `LIST OF ANNEXURES\nD, see below\n\n${cited}`,
    `LIST OF ANNEXURES\nD, as placed on record\n\n${cited}`,
    `LIST OF ANNEXURES\nD refer para 2\n\n${cited}`,
    `LIST OF ANNEXURE\nD: Receipt\n\n${cited}`,
    `LIST OF ENCLOSURES\nD - Receipt\n\n${cited}`,
    `INDEX\nD - Receipt\n\n${cited}`,
    `list of annexures\nD: Receipt\n\n${cited}`,
    `| D | Receipt |\n\n${cited}`,
    `${cited} SCHEDULE OF ANNEXURES: A, B, C, D.`,
    `${cited} The annexure is D.`,
    `${cited} The relevant annexure is D.`,
    `${cited} Annexures A, B, etc. and D are filed.`,
  ]

  it.each(unfiled)("refuses an unfiled letter and names it: %s", async (body) => {
    const result = await resultFor(petition, body)
    expect(result.ok, body).toBe(false)
    expect(result.pdf, body).toBeNull()
    expect(result.docx, body).toBeNull()
    const named = result.queue.filter((entry) => entry.code === "unfiled_label" && entry.detail.includes('"D"'))
    expect(named.length, JSON.stringify(result.queue)).toBeGreaterThan(0)
  })

  it("names E as well as D", async () => {
    const result = await resultFor(petition, `${cited} The annexures are D and E.`)
    expect(result.queue.some((entry) => entry.code === "unfiled_label" && entry.detail.includes('"E"'))).toBe(true)
  })

  const marks: Array<{ body: string; detail: string }> = [
    { body: `${proved} Document No. P-9.`, detail: 'unfiled label "P-9"' },
    { body: `${proved} deed/P/9.`, detail: 'unfiled label "deed/P/9"' },
    { body: `${proved} sale-deed/P-9.`, detail: 'unfiled label "sale-deed/P-9"' },
    { body: `${proved} document P-9.`, detail: 'unfiled label "P-9"' },
    { body: `${proved} P.2024 is the plan.`, detail: 'unfiled label "P.2024"' },
  ]

  it.each(marks)("refuses an unfiled mark and names the token: $body", async ({ body, detail }) => {
    const result = await resultFor(withThirdExhibit(), body)
    expect(result.ok, body).toBe(false)
    expect(result.pdf, body).toBeNull()
    expect(result.docx, body).toBeNull()
    expect(result.queue.some((entry) => entry.code === "unfiled_label" && entry.detail === detail), JSON.stringify(result.queue)).toBe(true)
  })

  const compounds: Array<{ body: string; detail: string }> = [
    { body: `${proved} Exh. P-1/A.`, detail: 'ambiguous label "P-1/A"' },
    { body: `${proved} P-1A.`, detail: 'ambiguous label "P-1A"' },
    { body: `${proved} P-1(a).`, detail: 'ambiguous label "P-1(a)"' },
  ]

  it.each(compounds)("names a compound mark as ambiguous: $body", async ({ body, detail }) => {
    const result = await resultFor(withThirdExhibit(), body)
    expect(result.ok, body).toBe(false)
    expect(result.pdf, body).toBeNull()
    expect(result.docx, body).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ambiguous_label" && entry.detail === detail), JSON.stringify(result.queue)).toBe(true)
  })

  const allowed = [
    `${cited} The order in C.P. No. D-1234 of 2023 is impugned.`,
    `${cited} Suit No. 12 of 2020 is pending.`,
    `${cited} See Annexure A - u/s 80 CPC.`,
    `${cited} The charge is u/s 302 PPC.`,
    `${cited} The order was made Ex parte.`,
  ]

  it.each(allowed)("keeps an allowlisted citation: %s", async (body) => {
    const result = await resultFor(petition, body)
    expect(result.ok, body).toBe(true)
    expect(result.pdf, body).not.toBeNull()
    expect(result.docx, body).not.toBeNull()
    expect(result.queue, body).toEqual([])
  })

  it("refuses Suit No. D-12 because that shape is not on the allowlist", async () => {
    const body = `${proved} Exh. P-1 is the plaint in Suit No. D-12 of 2020.`
    const result = await resultFor(withThirdExhibit(), body)
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(result.queue.some((entry) => entry.code === "unfiled_label" && entry.detail.includes("D-12"))).toBe(true)
  })

  it("pins the index headings and still refuses an unfiled label under each of them", async () => {
    expect([...PROVED_INDEX_HEADINGS]).toEqual([
      "LIST OF ANNEXURES",
      "LIST OF EXHIBITS",
      "LIST OF DOCUMENTS",
      "LIST OF ANNEXURE",
      "LIST OF ENCLOSURES",
      "INDEX",
      "INDEX OF ANNEXURES",
      "INDEX OF DOCUMENTS",
    ])
    expect(isProvedIndexHeading("SCHEDULE OF ANNEXURES")).toBe(false)
    expect(isProvedIndexHeading("LIST OF ANNEXURES")).toBe(true)
    for (const heading of PROVED_INDEX_HEADINGS) {
      const body = `${heading}\nD - Receipt\n\n${cited}`
      const result = await resultFor(petition, body)
      expect(result.pdf, heading).toBeNull()
      expect(result.docx, heading).toBeNull()
      expect(result.queue.some((entry) => entry.code === "unfiled_label" && entry.detail.includes('"D"')), heading).toBe(true)
    }
  })
})
